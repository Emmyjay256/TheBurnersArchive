const express = require('express');
const router = express.Router();

const KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const GUIDE = `You are Spark, the AI assistant in "The Burner's Archive", a web app that shows NASA satellite fire data.
The user is looking at a specific screen and place. They have asked a question. You may receive FACTS from the app data.
If FACTS are present, use them exactly. If not, explain from the app description and general knowledge, and say you don't have the numbers for this specific question.
Never invent numbers.
Keep answers under 120 words. Use short sentences. Bold key numbers.
The app has four screens: Explore (3D globe of live fires), Burning Calendar (day-by-day fires for a place), Insights (harmonized record 2000-2025), Advanced Insights (raw detection record).
MODIS (2000+) and VIIRS (2012+) measure fires differently. We correct MODIS onto the VIIRS scale so the record is continuous.`;

router.post('/ask-ai', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'AI not configured on the server.' });

    const body = req.body || {};
    const msgs = Array.isArray(body.messages) ? body.messages : (body.prompt ? [{ role: 'user', text: body.prompt }] : []);
    if (!msgs.length) return res.status(400).json({ error: 'No question.' });

    const lastUser = msgs.filter(m => m.role === 'user').at(-1)?.text || '';
    const context = typeof body.context === 'object' ? body.context : {};
    const note = String(context.note || '').slice(0, 800);
    const place = context.place ? `${context.place.name} (${context.place.lat}, ${context.place.lon})` : 'none';

    // Build a small but complete prompt
    const lead = [
      context.screen ? `User is on the "${context.screen}" screen.` : '',
      `User's place: ${place}.`,
      note ? `App data: ${note}` : '',
    ].filter(Boolean).join('\n');

    const contents = msgs.slice(-4).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));

    contents.push({
      role: 'user',
      parts: [{ text: `${lead}\n\nQuestion: ${lastUser}` }]
    });

    console.log(`[ai] calling Gemini | prompt: ${lastUser.slice(0, 50)}...`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: GUIDE }] },
          contents,
          generationConfig: { temperature: 0.5, maxOutputTokens: 500 },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('[ai] Gemini error:', data);
      return res.status(500).json({ error: data.error?.message || 'Gemini failed.' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    console.log(`[ai] reply sent (${text.length} chars)`);
    res.json({ text });
  } catch (err) {
    console.error('[ai] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;