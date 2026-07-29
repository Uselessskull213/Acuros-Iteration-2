// api/_lib/meta-capi.js — Meta Conversions API (server-side pixel events).
//
// Sends events straight from our serverless functions to Meta, so they arrive
// even when the browser pixel is blocked (ad blockers, ITP) or the tab closes.
// Browser + server both fire the same event with the same event_id — Meta
// deduplicates the pair, so nothing is double-counted.
//
// Setup (one-time): Events Manager → pixel 4162905814000026 → Settings →
// Conversions API → Generate access token, then set it in Vercel as
// META_CAPI_ACCESS_TOKEN. Without the token every call is a silent no-op —
// user-facing flows must never fail because Meta is down or unconfigured.

import crypto from 'node:crypto';

const PIXEL_ID = '4162905814000026';
const API_VERSION = 'v21.0';

function sha256(v) {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

export function isCapiConfigured() {
  return Boolean(process.env.META_CAPI_ACCESS_TOKEN);
}

// Fire one event. Returns Meta's response, {skipped} without a token, or
// {error} on failure — never throws.
export async function sendMetaEvent({ eventName, eventId, email, req, eventSourceUrl, value, currency }) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) return { skipped: 'no-token' };

  const user_data = {};
  if (email) user_data.em = [sha256(email)];
  if (req) {
    const fwd = req.headers['x-forwarded-for'];
    const ip = typeof fwd === 'string' && fwd ? fwd.split(',')[0].trim() : req.socket?.remoteAddress;
    if (ip) user_data.client_ip_address = ip;
    if (req.headers['user-agent']) user_data.client_user_agent = req.headers['user-agent'];
    const cookies = String(req.headers.cookie || '');
    const fbp = /(?:^|;\s*)_fbp=([^;]+)/.exec(cookies)?.[1];
    const fbc = /(?:^|;\s*)_fbc=([^;]+)/.exec(cookies)?.[1];
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;
  }

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: eventSourceUrl || 'https://www.acuros.ca/',
    user_data,
  };
  if (value != null) event.custom_data = { value, currency: currency || 'CAD' };

  const body = { data: [event] };
  if (process.env.META_CAPI_TEST_EVENT_CODE) body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE;

  try {
    const resp = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[meta-capi]', eventName, 'rejected:', JSON.stringify(out).slice(0, 500));
      return { error: out };
    }
    return out;
  } catch (err) {
    console.error('[meta-capi]', eventName, 'failed:', err?.message || err);
    return { error: String(err?.message || err) };
  }
}
