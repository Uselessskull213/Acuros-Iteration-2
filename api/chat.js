// api/chat.js — Vercel Serverless Function
// Proxies requests to Google Gemini API, keeping the API key server-side.

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini API key not configured' });

  const { messages = [], type = 'general' } = req.body || {};

  // System prompt varies by query type
  const systemPrompts = {
    general:    'You are Acuros AI, a precise and empathetic health intelligence assistant for Acuros Health. Provide clear, evidence-based health education. Always recommend consulting qualified healthcare professionals for personal medical advice. Be concise, accurate, and compassionate. End responses about symptoms or medications with: ⚠ Educational information only — consult your healthcare provider.',
    research:   'You are Acuros Research AI. Summarise recent medical research clearly and accurately for a health-literate audience. Cite study types (RCT, meta-analysis, etc.) and note limitations. Always end with: ⚠ Research summaries are educational — discuss with your physician before making health decisions.',
    symptom:    'You are Acuros Symptom AI. Help users understand potential causes of symptoms in a balanced, non-alarmist way. Always clarify you cannot diagnose, and recommend seeing a doctor for any concerning or persistent symptoms. End with: ⚠ Not a diagnosis — please consult a qualified healthcare provider.',
    medication: 'You are Acuros Medication AI. Explain medications, their mechanisms, common side effects, and interactions clearly. Always recommend verifying with a pharmacist or physician. End with: ⚠ Educational information only — consult your pharmacist or doctor before changing medications.',
  };

  const systemInstruction = {
    parts: [{ text: systemPrompts[type] || systemPrompts.general }]
  };

  // Convert chatHistory to Gemini contents format
  const contents = (messages || []).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text || '' }]
  })).filter(c => c.parts[0].text);

  if (!contents.length) return res.status(400).json({ error: 'No messages provided' });

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction,
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      console.error('[Acuros/chat] Gemini error:', errData);
      return res.status(502).json({ error: errData.error?.message || `Gemini ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract grounding sources if present
    const sources = data.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map(c => c.web)
      .filter(Boolean) || [];

    return res.status(200).json({ text, sources, modelUsed: model });
  } catch (err) {
    console.error('[Acuros/chat] Fetch error:', err);
    return res.status(500).json({ error: 'Failed to reach Gemini API' });
  }
}
