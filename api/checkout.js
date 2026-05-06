// api/checkout.js — Vercel Serverless Function
// Cart checkout, ported from AcurosMobile's points/wallet model.
// Records a wallet_transaction, awards points (1 pt / $10), emails order receipt.
// Payment is collected at the clinic — this is an order request, not a charge.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';
import { addSpend, addTransaction, pointsFromCents } from './_lib/points.js';

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function buildCorsOrigin(req) {
  const allow = process.env.ALLOWED_ORIGINS;
  if (!allow) return '*';
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return '*';
  const allowed = allow.split(',').map((v) => v.trim()).filter(Boolean);
  return allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || '*';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function fmt(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function sendResendEmail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: 'Acuros Health <no-reply@acuros.ca>',
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    console.error('[checkout] Resend error:', errData);
    return { ok: false, error: errData.message || `Resend ${resp.status}` };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  const corsOrigin = buildCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    route: 'checkout',
    identifier: ip,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many checkout attempts. Please try again shortly.' });

  const body = req.body || {};

  // Honeypot
  if (typeof body.honeypot === 'string' && body.honeypot.trim().length > 0) {
    return res.status(400).json({ error: 'Invalid submission.' });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty.' });
  if (items.length > 50) return res.status(400).json({ error: 'Too many items.' });

  // Normalise + validate items. Prices arrive as dollars (number) from shop.html.
  const normalized = [];
  let subtotalCents = 0;
  for (const raw of items) {
    const id = raw?.id ?? null;
    const name = String(raw?.name || '').trim().slice(0, 200);
    const qty = Math.max(1, Math.min(999, Math.floor(Number(raw?.qty || 1))));
    const priceNum = Number(raw?.price || 0);
    if (!name || !Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Invalid cart item.' });
    }
    const priceCents = Math.round(priceNum * 100);
    const lineCents = priceCents * qty;
    subtotalCents += lineCents;
    normalized.push({ id, name, qty, priceCents, lineCents });
  }
  if (subtotalCents <= 0) return res.status(400).json({ error: 'Cart total is zero.' });

  const customerName = String(body.customerName || '').trim().slice(0, 160);
  const customerEmail = String(body.customerEmail || '').trim().slice(0, 160);
  const customerPhone = String(body.customerPhone || '').trim().slice(0, 30);
  const orgCode = String(body.orgCode || '').trim().slice(0, 80);
  const note = String(body.note || '').trim().slice(0, 1000);

  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'A valid email is required to confirm your order.' });
  }

  // Optional auth
  let userId = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && isSupabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      const { data: { user } = {} } = await admin.auth.getUser(authHeader.slice(7));
      if (user?.id) userId = user.id;
    } catch { /* ignore */ }
  }

  // Resolve org
  let orgId = null;
  let orgName = null;
  let ownerEmail = null;
  if (isSupabaseConfigured() && orgCode) {
    try {
      const admin = getSupabaseAdmin();
      const { data: org } = await admin
        .from('organizations')
        .select('id, name, owner_id, contact_email')
        .ilike('code', orgCode)
        .maybeSingle();
      if (org) {
        orgId = org.id;
        orgName = org.name;
        ownerEmail = org.contact_email || null;
        if (!ownerEmail && org.owner_id) {
          try {
            const { data: ownerUser } = await admin.auth.admin.getUserById(org.owner_id);
            ownerEmail = ownerUser?.user?.email || null;
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error('[checkout] org lookup failed:', err?.message || err);
    }
  }

  // Persist order + award points
  let orderRow = null;
  let pointsEarned = 0;
  if (isSupabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin
        .from('orders')
        .insert({
          user_id: userId,
          org_id: orgId,
          customer_name: customerName || null,
          customer_email: customerEmail,
          customer_phone: customerPhone || null,
          items: normalized,
          subtotal_cents: subtotalCents,
          status: 'pending',
          note: note || null,
        })
        .select()
        .single();
      if (error) throw error;
      orderRow = data;

      if (userId && orgId) {
        pointsEarned = await addSpend(admin, { userId, orgId, amountCents: subtotalCents });
        await addTransaction(admin, {
          userId,
          orgId,
          amountCents: subtotalCents,
          description: `Order #${(data.id || '').toString().slice(0, 8)} — ${normalized.length} item${normalized.length !== 1 ? 's' : ''}`,
          pointsEarned,
        });
      } else {
        pointsEarned = pointsFromCents(subtotalCents);
      }
    } catch (err) {
      console.error('[checkout] insert error:', err);
      return res.status(500).json({ error: 'Could not save your order. Please try again.' });
    }
  } else {
    pointsEarned = pointsFromCents(subtotalCents);
  }

  // Emails (best-effort)
  const itemsHtml = normalized.map((it) => `
    <tr>
      <td style="padding:8px 0;color:#181816;font-size:13px">${escapeHtml(it.name)} × ${it.qty}</td>
      <td style="padding:8px 0;color:#181816;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">${fmt(it.lineCents)}</td>
    </tr>`).join('');

  const customerHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;padding:32px">
  <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:-.01em;margin-bottom:16px;color:#181816">Order received</div>
  <p style="color:#5a5a54;font-size:14px;line-height:1.7">Thanks${customerName ? ', ' + escapeHtml(customerName.split(' ')[0]) : ''} — your order request has been received. Your clinic will confirm and arrange pickup or delivery.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;border-top:1px solid #e2e2de;border-bottom:1px solid #e2e2de">
    ${itemsHtml}
    <tr><td colspan="2" style="border-top:1px solid #e2e2de"></td></tr>
    <tr>
      <td style="padding:10px 0;color:#181816;font-size:14px;font-weight:500">Subtotal</td>
      <td style="padding:10px 0;color:#181816;font-size:14px;font-weight:500;text-align:right;font-variant-numeric:tabular-nums">${fmt(subtotalCents)}</td>
    </tr>
  </table>
  ${pointsEarned > 0 ? `<p style="color:#c9922a;font-size:13px">You'll earn <strong>${pointsEarned} loyalty point${pointsEarned !== 1 ? 's' : ''}</strong> once this order is fulfilled.</p>` : ''}
  ${note ? `<p style="color:#5a5a54;font-size:13px;line-height:1.7"><strong>Your note:</strong> ${escapeHtml(note)}</p>` : ''}
  <hr style="border:none;border-top:1px solid #e2e2de;margin:24px 0"/>
  <p style="color:#a09480;font-size:11px">Acuros Health Inc. — Payment is collected by your clinic.</p>
</div>`;

  const clinicHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;padding:32px">
  <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:-.01em;margin-bottom:16px;color:#181816">New shop order</div>
  <div style="color:#5a5a54;font-size:13px;line-height:1.85;margin-bottom:14px">
    <div><strong>${escapeHtml(customerName || customerEmail)}</strong></div>
    <div>Email: <a href="mailto:${escapeHtml(customerEmail)}" style="color:#c9922a">${escapeHtml(customerEmail)}</a></div>
    ${customerPhone ? `<div>Phone: ${escapeHtml(customerPhone)}</div>` : ''}
  </div>
  <table style="width:100%;border-collapse:collapse;margin:8px 0;border-top:1px solid #e2e2de;border-bottom:1px solid #e2e2de">
    ${itemsHtml}
    <tr><td colspan="2" style="border-top:1px solid #e2e2de"></td></tr>
    <tr>
      <td style="padding:10px 0;color:#181816;font-size:14px;font-weight:500">Subtotal</td>
      <td style="padding:10px 0;color:#181816;font-size:14px;font-weight:500;text-align:right;font-variant-numeric:tabular-nums">${fmt(subtotalCents)}</td>
    </tr>
  </table>
  ${note ? `<div style="color:#5a5a54;font-size:13px;line-height:1.7;margin-top:14px"><strong>Note from customer:</strong> ${escapeHtml(note)}</div>` : ''}
</div>`;

  const fallbackTo = process.env.ORDER_NOTIFY_EMAIL || process.env.CONTACT_TO_EMAIL || 'info@acuros.ca';
  const clinicTo = ownerEmail || fallbackTo;

  await Promise.all([
    sendResendEmail({
      to: customerEmail,
      subject: `Order received — ${normalized.length} item${normalized.length !== 1 ? 's' : ''} · ${fmt(subtotalCents)}`,
      html: customerHtml,
    }),
    sendResendEmail({
      to: clinicTo,
      replyTo: customerEmail,
      subject: `[Acuros Shop] New order — ${customerName || customerEmail} — ${fmt(subtotalCents)}`,
      html: clinicHtml,
    }),
  ]).catch((err) => console.error('[checkout] email error:', err));

  return res.status(201).json({
    success: true,
    order: orderRow,
    pointsEarned,
    org: orgName ? { id: orgId, name: orgName } : null,
  });
}
