// api/bookings.js — Vercel Serverless Function
// Booking-request backend, ported from AcurosMobile.
// Persists to the public.bookings table (Supabase) and emails patient + clinic.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function buildCorsOrigin(req) {
  const requestOrigin = req.headers.origin || '';
  const configured = (process.env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const allowed = configured.length ? configured
    : ['https://acuros.ca', 'https://www.acuros.ca', 'https://dev.acuros.ca'];
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  // Keep Vercel preview deployments functional without explicit config.
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(requestOrigin)) return requestOrigin;
  return allowed[0];
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function formatDateTime(dateStr, timeLabel) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  const dateOut = d.toLocaleDateString('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return timeLabel ? `${dateOut} — ${timeLabel}` : dateOut;
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
    console.error('[bookings] Resend error:', errData);
    return { ok: false, error: errData.message || `Resend ${resp.status}` };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  const corsOrigin = buildCorsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    route: 'bookings',
    identifier: ip,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many booking requests. Please try again shortly.' });

  // GET ?action=mine — list bookings for the logged-in patient
  if (req.method === 'GET') {
    const action = String((req.query && req.query.action) || '').trim();
    if (action !== 'mine') return res.status(400).json({ error: 'Unsupported action' });
    if (!isSupabaseConfigured()) return res.status(200).json({ bookings: [] });

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.slice(7);

    try {
      const admin = getSupabaseAdmin();
      const { data: { user } = {}, error: authError } = await admin.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

      const { data, error } = await admin
        .from('bookings')
        .select('*')
        .eq('patient_id', user.id)
        .order('appointment_date', { ascending: false })
        .limit(50);
      if (error) throw error;
      return res.status(200).json({ bookings: data || [] });
    } catch (err) {
      console.error('[bookings] list mine error:', err);
      return res.status(500).json({ error: 'Could not load your bookings. Please try again.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Honeypot + min-fill-time anti-spam (mirroring contact.js)
  const body = req.body || {};
  if (typeof body.honeypot === 'string' && body.honeypot.trim().length > 0) {
    return res.status(400).json({ error: 'Invalid submission.' });
  }
  const startedAt = Number(body.formTs || 0);
  if (startedAt) {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 1500 || elapsed > 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Please take a moment and try again.' });
    }
  }

  const procedure = String(body.procedure || '').trim().slice(0, 200);
  const category = String(body.category || '').trim().slice(0, 80);
  const price = String(body.price || '').trim().slice(0, 40);
  const firstName = String(body.firstName || '').trim().slice(0, 80);
  const lastName = String(body.lastName || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().slice(0, 160);
  const phone = String(body.phone || '').trim().slice(0, 30);
  const date = String(body.date || '').trim().slice(0, 20);
  const time = String(body.time || '').trim().slice(0, 80);
  const notes = String(body.notes || '').trim().slice(0, 2000);
  // Strip LIKE metacharacters: this value is used in an ilike() pattern, so a
  // raw '%' would turn the lookup into a wildcard that matches a stranger's org.
  const orgCode = String(body.orgCode || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 80);

  if (!procedure || !firstName || !lastName || !email || !phone || !date) {
    return res.status(400).json({ error: 'Missing required booking fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  // Optional auth — if user is signed in, store their patient_id
  let patientId = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && isSupabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      const { data: { user } = {} } = await admin.auth.getUser(authHeader.slice(7));
      if (user?.id) patientId = user.id;
    } catch { /* ignore */ }
  }

  // Resolve org by code (optional)
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
      console.error('[bookings] org lookup failed:', err?.message || err);
    }
  }

  // Persist
  let bookingRow = null;
  if (isSupabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin
        .from('bookings')
        .insert({
          org_id: orgId,
          patient_id: patientId,
          procedure_name: procedure,
          procedure_category: category || null,
          price_label: price || null,
          patient_first_name: firstName,
          patient_last_name: lastName,
          patient_email: email,
          patient_phone: phone,
          appointment_date: date,
          appointment_time_label: time || null,
          notes: notes || null,
          status: 'requested',
        })
        .select()
        .single();
      if (error) throw error;
      bookingRow = data;
    } catch (err) {
      console.error('[bookings] insert error:', err);
      return res.status(500).json({ error: 'Could not save booking. Please try again.' });
    }
  }

  // Notify patient + clinic (best-effort; failure does not block booking)
  const formattedTime = formatDateTime(date, time);
  const fullName = `${firstName} ${lastName}`;
  const patientHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;padding:32px">
  <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:-.01em;margin-bottom:16px;color:#181816">Your booking request is received</div>
  <p style="color:#5a5a54;font-size:14px;line-height:1.7">Hi ${escapeHtml(firstName)}, we've received your booking request. Our team will confirm within one business day.</p>
  <div style="background:#f7f5ef;border:1px solid #e2e2de;padding:20px;margin:20px 0">
    <div style="color:#a09480;font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px">Procedure</div>
    <div style="font-family:Georgia,serif;font-size:18px;color:#181816;margin-bottom:12px">${escapeHtml(procedure)}</div>
    <div style="color:#5a5a54;font-size:13px;line-height:1.7">${escapeHtml(formattedTime)}</div>
    ${price ? `<div style="color:#5a5a54;font-size:13px;margin-top:6px">Estimated price: ${escapeHtml(price)}</div>` : ''}
    ${notes ? `<div style="color:#5a5a54;font-size:13px;margin-top:12px"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
  </div>
  <p style="color:#5a5a54;font-size:13px;line-height:1.7">Payment is due at the clinic on the day of your visit. To reschedule or cancel, simply reply to this email.</p>
  <hr style="border:none;border-top:1px solid #e2e2de;margin:24px 0"/>
  <p style="color:#a09480;font-size:11px">Acuros Health Inc.</p>
</div>`;
  const clinicHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;padding:32px">
  <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:-.01em;margin-bottom:16px;color:#181816">New booking request</div>
  <div style="background:#f7f5ef;border:1px solid #e2e2de;padding:20px;margin:20px 0">
    <div style="color:#181816;font-size:15px;font-weight:500;margin-bottom:10px">${escapeHtml(fullName)}</div>
    <div style="color:#5a5a54;font-size:13px;line-height:1.85">
      <div>Procedure: <strong>${escapeHtml(procedure)}</strong></div>
      <div>When: ${escapeHtml(formattedTime)}</div>
      <div>Email: <a href="mailto:${escapeHtml(email)}" style="color:#c9922a">${escapeHtml(email)}</a></div>
      <div>Phone: ${escapeHtml(phone)}</div>
      ${price ? `<div>Est. price: ${escapeHtml(price)}</div>` : ''}
      ${notes ? `<div style="margin-top:10px"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
    </div>
  </div>
</div>`;

  const fallbackTo = process.env.BOOKING_NOTIFY_EMAIL || process.env.CONTACT_TO_EMAIL || 'info@acuros.ca';
  const clinicTo = ownerEmail || fallbackTo;

  await Promise.all([
    sendResendEmail({
      to: email,
      subject: `Booking received — ${procedure}`,
      html: patientHtml,
    }),
    sendResendEmail({
      to: clinicTo,
      replyTo: email,
      subject: `[Acuros] New booking — ${procedure} — ${fullName}`,
      html: clinicHtml,
    }),
  ]).catch((err) => console.error('[bookings] email error:', err));

  return res.status(201).json({
    success: true,
    booking: bookingRow ?? null,
    org: orgName ? { id: orgId, name: orgName } : null,
  });
}
