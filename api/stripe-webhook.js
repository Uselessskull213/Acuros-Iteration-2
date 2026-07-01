// api/stripe-webhook.js — flip profiles.tier to 'plus' when Stripe reports a
// completed checkout for the Acuros Plus payment link.
//
// Setup (one-time, Stripe dashboard):
//   Developers → Webhooks → Add endpoint
//     URL:    https://acuros.ca/api/stripe-webhook
//     Events: checkout.session.completed
//   Then copy the endpoint's signing secret into Vercel env as
//   STRIPE_WEBHOOK_SECRET (starts with whsec_).
//
// The payment link is opened from onboarding/developer/settings with
// ?client_reference_id=<supabase user id>&prefilled_email=<email>, so the
// completed session carries the user id back to us here. No Stripe SDK —
// signature verification is a plain HMAC-SHA256 over the RAW request body
// (t + '.' + payload, from the stripe-signature header), which is why this
// handler reads the stream itself instead of touching req.body.

import crypto from 'node:crypto';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const TOLERANCE_S = 5 * 60; // reject events older than 5 minutes (replay guard)

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const parts = Object.create(null);
  for (const kv of sigHeader.split(',')) {
    const [k, v] = kv.split('=');
    if (k === 't') parts.t = v;
    else if (k === 'v1') (parts.v1 || (parts.v1 = [])).push(v);
  }
  if (!parts.t || !parts.v1?.length) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > TOLERANCE_S) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return parts.v1.some((candidate) => {
    const candBuf = Buffer.from(String(candidate || ''), 'utf8');
    return candBuf.length === expectedBuf.length && crypto.timingSafeEqual(candBuf, expectedBuf);
  });
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'Webhook not configured.' });
  }
  if (!isSupabaseConfigured()) return res.status(503).json({ error: 'Supabase not configured.' });

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read body.' });
  }
  if (!raw?.length) return res.status(400).json({ error: 'Empty body.' });

  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }

  // Only paid, completed checkouts flip the tier. Everything else is a no-op
  // 200 so Stripe doesn't retry events we deliberately ignore.
  if (event?.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event?.type || 'unknown' });
  }
  const session = event.data?.object || {};
  if (session.payment_status && session.payment_status !== 'paid') {
    return res.status(200).json({ received: true, ignored: 'not-paid' });
  }

  const userId = String(session.client_reference_id || '').trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(userId)) {
    // Paid without a usable reference (e.g. link opened without the id) —
    // log loudly so it can be reconciled manually via the email on file.
    console.error('[stripe-webhook] completed checkout without client_reference_id:', {
      session: session.id, email: session.customer_details?.email || session.customer_email || null,
    });
    return res.status(200).json({ received: true, ignored: 'no-client-reference-id' });
  }

  try {
    const admin = getSupabaseAdmin();
    const { data: updated, error } = await admin
      .from('profiles')
      .update({ tier: 'plus' })
      .eq('id', userId)
      .select('id, tier')
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      console.error('[stripe-webhook] paid user has no profile row:', userId);
      return res.status(200).json({ received: true, ignored: 'no-profile' });
    }
    console.log('[stripe-webhook] upgraded to plus:', userId, 'session:', session.id);
    return res.status(200).json({ received: true, upgraded: true });
  } catch (err) {
    console.error('[stripe-webhook] tier update failed:', err?.message || err);
    // 500 → Stripe retries, so a transient DB error can't lose an upgrade.
    return res.status(500).json({ error: 'Upgrade failed, will retry.' });
  }
}
