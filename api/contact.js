// api/contact.js — Vercel Serverless Function
// Sends contact form emails via Resend, keeping the API key server-side.

const rateBucket = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 8;

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

export default async function handler(req, res) {
  const corsOrigin = buildCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const resendKey   = process.env.RESEND_API_KEY;
  const contactTo   = process.env.CONTACT_TO_EMAIL || 'info@acuros.ca';

  if (!resendKey) return res.status(500).json({ error: 'Resend API key not configured' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many contact requests. Please try again shortly.' });

  const { name, email, type, message } = req.body || {};
  const safeName = String(name || '').trim().slice(0, 100);
  const safeEmail = String(email || '').trim().slice(0, 160);
  const safeType = String(type || '').trim().slice(0, 80);
  const safeMessage = String(message || '').trim().slice(0, 4000);

  // Basic validation
  if (!safeName || !safeEmail || !safeMessage) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const subject = safeType
    ? `[Acuros] ${safeType} — ${safeName}`
    : `[Acuros] Contact from ${safeName}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:'DM Sans',sans-serif;background:#f5f5f3;padding:32px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;padding:32px">
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:-.01em;margin-bottom:24px;color:#181816">
      Acuros Health — New Contact
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr>
        <td style="padding:8px 0;color:#5a5a54;font-size:13px;width:100px">Name</td>
        <td style="padding:8px 0;color:#181816;font-size:14px">${escapeHtml(safeName)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#5a5a54;font-size:13px">Email</td>
        <td style="padding:8px 0;color:#181816;font-size:14px">
          <a href="mailto:${escapeHtml(safeEmail)}" style="color:#0ea5e9">${escapeHtml(safeEmail)}</a>
        </td>
      </tr>
      ${safeType ? `<tr>
        <td style="padding:8px 0;color:#5a5a54;font-size:13px">Type</td>
        <td style="padding:8px 0;color:#181816;font-size:14px">${escapeHtml(safeType)}</td>
      </tr>` : ''}
    </table>
    <div style="border-top:1px solid #e2e2de;padding-top:20px">
      <div style="color:#5a5a54;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px">Message</div>
      <div style="color:#181816;font-size:14px;line-height:1.7;white-space:pre-line">${escapeHtml(safeMessage)}</div>
    </div>
  </div>
</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Acuros Contact <no-reply@acuros.ca>',
        to: [contactTo],
        reply_to: safeEmail,
        subject,
        html
      })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.error('[Acuros/contact] Resend error:', errData);
      return res.status(502).json({ error: errData.message || `Resend ${resp.status}` });
    }

    const data = await resp.json();
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('[Acuros/contact] Fetch error:', err);
    return res.status(500).json({ error: 'Failed to reach Resend API' });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
