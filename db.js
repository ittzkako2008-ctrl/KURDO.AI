const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// ---------- پاشکۆی داتابەیس: ناوخۆیی (SQLite) یان ئۆنلاین (Turso) ----------
function makeBackend() {
  if (process.env.TURSO_URL) {
    const { createClient } = require('@libsql/client');
    const c = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
    const rows = r => r.rows.map(row => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
    return {
      name: 'turso',
      exec: sql => c.executeMultiple(sql),
      run: async (sql, args = []) => {
        const r = await c.execute({ sql, args });
        return { changes: r.rowsAffected, lastId: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
      },
      get: async (sql, args = []) => rows(await c.execute({ sql, args }))[0],
      all: async (sql, args = []) => rows(await c.execute({ sql, args })),
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'kurdo.db'));
  db.exec('PRAGMA journal_mode = WAL');
  return {
    name: 'sqlite',
    exec: async sql => db.exec(sql),
    run: async (sql, args = []) => {
      const r = db.prepare(sql).run(...args);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    get: async (sql, args = []) => db.prepare(sql).get(...args),
    all: async (sql, args = []) => db.prepare(sql).all(...args),
  };
}

const B = makeBackend();

const ready = (async () => {
  await B.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created INTEGER NOT NULL,
      profile TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      sec TEXT NOT NULL,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      updated INTEGER NOT NULL,
      pin INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS usage (
      user_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      created INTEGER NOT NULL
    );
  `);
  // داتابەیسی کۆن: ستوونە نوێیەکان زیاد بکە ئەگەر نەبن
  for (const sql of [
    "ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE chats ADD COLUMN pin INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { await B.exec(sql); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
})();

const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);

async function hashPw(password, saltHex) {
  const buf = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return buf.toString('hex');
}

async function createUser(email, name, password) {
  await ready;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(password, salt);
  try {
    const r = await B.run('INSERT INTO users (email, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)',
      [email, name, salt, hash, Date.now()]);
    return { id: r.lastId, email, name };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return null;
    throw e;
  }
}

async function verifyUser(email, password) {
  await ready;
  const u = await B.get('SELECT * FROM users WHERE email = ?', [email]);
  const hash = await hashPw(password, u ? u.salt : DUMMY_SALT);
  if (!u) return null;
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: u.id, email: u.email, name: u.name };
}

async function createSession(userId) {
  await ready;
  await B.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]);
  const token = crypto.randomBytes(32).toString('hex');
  await B.run('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)',
    [sha(token), userId, Date.now() + SESSION_MS]);
  return token;
}

async function sessionUser(token) {
  if (!token || typeof token !== 'string') return null;
  await ready;
  const row = await B.get(
    'SELECT u.id, u.email, u.name, u.profile, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    [sha(token)]
  );
  if (!row) return null;
  if (row.expires < Date.now()) { await deleteSession(token); return null; }
  return { id: row.id, email: row.email, name: row.name, profile: row.profile || '' };
}

async function deleteSession(token) {
  if (!token) return;
  await ready;
  await B.run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
}

async function setProfile(userId, text) {
  await ready;
  await B.run('UPDATE users SET profile = ? WHERE id = ?', [text, userId]);
}

const MAX_CHATS = 200;

async function saveChat(userId, id, sec, title, messages, pin) {
  await ready;
  const exists = await B.get('SELECT 1 AS x FROM chats WHERE user_id = ? AND id = ?', [userId, id]);
  if (!exists) {
    const n = (await B.get('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?', [userId])).n;
    if (Number(n) >= MAX_CHATS) return false;
  }
  await B.run(
    `INSERT INTO chats (id, user_id, sec, title, data, updated, pin) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET sec = excluded.sec, title = excluded.title, data = excluded.data, updated = excluded.updated, pin = excluded.pin`,
    [id, userId, sec, title, JSON.stringify(messages), Date.now(), pin ? 1 : 0]
  );
  return true;
}

async function listChats(userId) {
  await ready;
  const rows = await B.all('SELECT id, sec, title, data, pin FROM chats WHERE user_id = ? ORDER BY updated ASC', [userId]);
  return rows.map(r => ({ id: r.id, sec: r.sec, title: r.title, pin: !!Number(r.pin), m: JSON.parse(r.data) }));
}

async function deleteChat(userId, id) {
  await ready;
  await B.run('DELETE FROM chats WHERE user_id = ? AND id = ?', [userId, id]);
}

async function deleteAllChats(userId) {
  await ready;
  await B.run('DELETE FROM chats WHERE user_id = ?', [userId]);
  await B.run('DELETE FROM images WHERE user_id = ?', [userId]);
}

async function changePassword(userId, newPassword) {
  await ready;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(newPassword, salt);
  await B.run('UPDATE users SET salt = ?, hash = ? WHERE id = ?', [salt, hash, userId]);
  await B.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

async function deleteUser(userId) {
  await ready;
  await B.run('DELETE FROM chats WHERE user_id = ?', [userId]);
  await B.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  await B.run('DELETE FROM usage WHERE user_id = ?', [userId]);
  await B.run('DELETE FROM images WHERE user_id = ?', [userId]);
  await B.run('DELETE FROM users WHERE id = ?', [userId]);
}

// وێنەکان (هەر بەکارهێنەرێک دوایین ٤٠ وێنە)
async function saveImage(userId, mime, b64) {
  await ready;
  const id = crypto.randomBytes(12).toString('hex');
  await B.run('INSERT INTO images (id, user_id, mime, data, created) VALUES (?, ?, ?, ?, ?)', [id, userId, mime, b64, Date.now()]);
  await B.run('DELETE FROM images WHERE user_id = ? AND id NOT IN (SELECT id FROM images WHERE user_id = ? ORDER BY created DESC LIMIT 40)', [userId, userId]);
  return id;
}

async function getImage(userId, id) {
  await ready;
  return B.get('SELECT mime, data FROM images WHERE user_id = ? AND id = ?', [userId, id]);
}

// سنووری ڕۆژانە
async function usageGet(userId) {
  await ready;
  const day = today();
  const u = await B.get('SELECT n FROM usage WHERE user_id = ? AND day = ?', [userId, day]);
  const g = await B.get('SELECT COALESCE(SUM(n), 0) AS n FROM usage WHERE day = ?', [day]);
  return { user: u ? Number(u.n) : 0, global: Number(g.n) };
}

async function usageAdd(userId) {
  await ready;
  const day = today();
  await B.run('INSERT INTO usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1', [userId, day]);
  const old = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  await B.run('DELETE FROM usage WHERE day < ?', [old]);
}

async function stats() {
  await ready;
  const day = Date.now() - 86400000;
  const users = Number((await B.get('SELECT COUNT(*) AS n FROM users')).n);
  const newToday = Number((await B.get('SELECT COUNT(*) AS n FROM users WHERE created > ?', [day])).n);
  const rows = await B.all('SELECT data, updated FROM chats');
  let messages = 0, up = 0, down = 0, activeToday = 0;
  for (const r of rows) {
    if (Number(r.updated) > day) activeToday++;
    let m = [];
    try { m = JSON.parse(r.data); } catch {}
    messages += m.length;
    for (const x of m) { if (x.fb === 'up') up++; else if (x.fb === 'down') down++; }
  }
  const recent = (await B.all('SELECT name, created FROM users ORDER BY created DESC LIMIT 10'))
    .map(r => ({ name: r.name, created: Number(r.created) }));
  const usageToday = (await usageGet(0)).global;
  return { users, newToday, chats: rows.length, activeToday, messages, up, down, recent, usageToday, backend: B.name };
}

module.exports = {
  ready, get backend() { return B.name; },
  createUser, verifyUser, createSession, sessionUser, deleteSession, saveChat, listChats,
  deleteChat, deleteAllChats, changePassword, deleteUser, setProfile, stats, usageGet, usageAdd, saveImage, getImage,
};
