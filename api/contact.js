// api/contact.js — Vercel Serverless Function
// Sends contact form emails via Resend, keeping the API key server-side.

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const resendKey   = process.env.RESEND_API_KEY;
  const contactTo   = process.env.CONTACT_TO_EMAIL || 'info@acuros.ca';

  if (!resendKey) return res.status(500).json({ error: 'Resend API key not configured' });

  const { name, email, type, message } = req.body || {};

  // Basic validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const subject = type
    ? `[Acuros] ${type} — ${name}`
    : `[Acuros] Contact from ${name}`;

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
        <td style="padding:8px 0;color:#181816;font-size:14px">${escapeHtml(name)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#5a5a54;font-size:13px">Email</td>
        <td style="padding:8px 0;color:#181816;font-size:14px">
          <a href="mailto:${escapeHtml(email)}" style="color:#0ea5e9">${escapeHtml(email)}</a>
        </td>
      </tr>
      ${type ? `<tr>
        <td style="padding:8px 0;color:#5a5a54;font-size:13px">Type</td>
        <td style="padding:8px 0;color:#181816;font-size:14px">${escapeHtml(type)}</td>
      </tr>` : ''}
    </table>
    <div style="border-top:1px solid #e2e2de;padding-top:20px">
      <div style="color:#5a5a54;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px">Message</div>
      <div style="color:#181816;font-size:14px;line-height:1.7;white-space:pre-line">${escapeHtml(message)}</div>
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
        reply_to: email,
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
