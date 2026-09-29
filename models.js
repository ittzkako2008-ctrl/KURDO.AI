require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

(async () => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const pager = await ai.models.list();
  for await (const m of pager) {
    if ((m.supportedActions || []).includes('generateContent') && /flash/i.test(m.name)) {
      console.log(m.name);
    }
  }
})().catch(e => console.error(e.message));