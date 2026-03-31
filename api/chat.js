// api/chat.js — Vercel Serverless Function
// Proxies requests to Google Gemini API, keeping the API key server-side.

const rateBucket = new Map();
const ALLOWED_TYPES = new Set(['general', 'research', 'symptom', 'medication']);
const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_TOTAL_CHARS = 15000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 25;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateBucket.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  fresh.push(now);
  rateBucket.set(key, fresh);
  return fresh.length <= RATE_LIMIT_MAX_REQUESTS;
}

function buildCorsOrigin(req) {
  const allow = process.env.ALLOWED_ORIGINS;
  if (!allow) return '*';
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return '*';
  const allowed = allow.split(',').map((v) => v.trim()).filter(Boolean);
  return allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || '*';
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const trimmed = messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m?.role === 'model' ? 'model' : 'user',
    text: String(m?.text || '').trim().slice(0, MAX_CHARS_PER_MESSAGE),
  })).filter((m) => m.text.length > 0);

  const totalChars = trimmed.reduce((sum, m) => sum + m.text.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    const result = [];
    let remaining = MAX_TOTAL_CHARS;
    for (let i = trimmed.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const current = trimmed[i];
      const text = current.text.slice(0, remaining);
      if (text.length) result.unshift({ role: current.role, text });
      remaining -= text.length;
    }
    return result;
  }
  return trimmed;
}

export default async function handler(req, res) {
  const corsOrigin = buildCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini API key not configured' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });

  const { messages = [], type = 'general' } = req.body || {};
  const safeType = ALLOWED_TYPES.has(type) ? type : 'general';

  // System prompt varies by query type
  const systemPrompts = {
    general:    'You are Acuros AI, a precise and empathetic health intelligence assistant for Acuros Health. Provide clear, evidence-based health education. Always recommend consulting qualified healthcare professionals for personal medical advice. Be concise, accurate, and compassionate. End responses about symptoms or medications with: ⚠ Educational information only — consult your healthcare provider.',
    research:   'You are Acuros Research AI. Summarise recent medical research clearly and accurately for a health-literate audience. Cite study types (RCT, meta-analysis, etc.) and note limitations. Always end with: ⚠ Research summaries are educational — discuss with your physician before making health decisions.',
    symptom:    'You are Acuros Symptom AI. Help users understand potential causes of symptoms in a balanced, non-alarmist way. Always clarify you cannot diagnose, and recommend seeing a doctor for any concerning or persistent symptoms. End with: ⚠ Not a diagnosis — please consult a qualified healthcare provider.',
    medication: 'You are Acuros Medication AI. Explain medications, their mechanisms, common side effects, and interactions clearly. Always recommend verifying with a pharmacist or physician. End with: ⚠ Educational information only — consult your pharmacist or doctor before changing medications.',
  };

  const systemInstruction = {
    parts: [{ text: systemPrompts[safeType] || systemPrompts.general }]
  };

  const safeMessages = sanitizeMessages(messages);

  // Convert chatHistory to Gemini contents format
  const contents = safeMessages.map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text || '' }]
  })).filter(c => c.parts[0].text);

  if (!contents.length) return res.status(400).json({ error: 'No messages provided' });

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
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
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI provider timed out. Please retry.' });
    }
    return res.status(500).json({ error: 'Failed to reach Gemini API' });
  } finally {
    clearTimeout(timeout);
  }
}
