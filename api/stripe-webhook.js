// api/stripe-webhook.js — keep profiles.tier in sync with Stripe billing.
//
// Handles:
//   • checkout.session.completed      — first payment: tier → 'plus', and we
//                                        record the Stripe customer id so later
//                                        subscription events can find the user.
//   • customer.subscription.created   — subscribed:  tier → 'plus'
//   • customer.subscription.updated   — status change: active/trialing → 'plus',
//                                        canceled/unpaid/expired → 'free'
//   • customer.subscription.deleted   — canceled:    tier → 'free'
//
// Setup (one-time, Stripe dashboard):
//   Developers → Webhooks → Add endpoint
//     URL:    https://acuros.ca/api/stripe-webhook
//     Events: checkout.session.completed,
//             customer.subscription.created,
//             customer.subscription.updated,
//             customer.subscription.deleted
//   Then copy the endpoint's signing secret into Vercel env as
//   STRIPE_WEBHOOK_SECRET (starts with whsec_).
//
// The payment link is opened with ?client_reference_id=<supabase user id>, so
// the first completed session carries the user id back here. Subscription
// events don't carry that id — only the Stripe customer id — so we map them via
// profiles.stripe_customer_id, which the checkout event stores. No Stripe SDK —
// signature verification is a plain HMAC-SHA256 over the RAW request body
// (t + '.' + payload, from the stripe-signature header), which is why this
// handler reads the stream itself instead of touching req.body.

import crypto from 'node:crypto';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';
import { sendMetaEvent } from './_lib/meta-capi.js';

const TOLERANCE_S = 5 * 60; // reject events older than 5 minutes (replay guard)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stripe subscription statuses that mean the customer currently has access.
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
// …and the ones that mean access is gone.
const INACTIVE_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired', 'past_due']);

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

// ── Handlers (return {status, body}) ─────────────────────────────────────
// First payment: upgrade + remember the Stripe customer for later events.
async function handleCheckoutCompleted(admin, session) {
  if (session.payment_status && session.payment_status !== 'paid') {
    return { status: 200, body: { received: true, ignored: 'not-paid' } };
  }
  const userId = String(session.client_reference_id || '').trim();
  const customerId = typeof session.customer === 'string' ? session.customer : null;
  if (!UUID_RE.test(userId)) {
    console.error('[stripe-webhook] completed checkout without client_reference_id:', {
      session: session.id, email: session.customer_details?.email || session.customer_email || null,
    });
    return { status: 200, body: { received: true, ignored: 'no-client-reference-id' } };
  }
  const patch = { tier: 'plus' };
  if (customerId) patch.stripe_customer_id = customerId;
  const { data: updated, error } = await admin
    .from('profiles').update(patch).eq('id', userId).select('id').maybeSingle();
  if (error) throw error;
  if (!updated) {
    console.error('[stripe-webhook] paid user has no profile row:', userId);
    return { status: 200, body: { received: true, ignored: 'no-profile' } };
  }
  console.log('[stripe-webhook] upgraded to plus:', userId, 'session:', session.id);

  // Server-side Subscribe via Conversions API — fires on payment truth even if
  // the buyer never returns to the site. event_id 'sub_<userId>' matches the
  // browser-side fire on onboarding, and is stable across Stripe retries, so
  // Meta dedupes both. Never let a Meta failure break the billing flow.
  await sendMetaEvent({
    eventName: 'Subscribe',
    eventId: 'sub_' + userId,
    email: session.customer_details?.email || session.customer_email || null,
    value: session.amount_total != null ? session.amount_total / 100 : 150,
    currency: (session.currency || 'cad').toUpperCase(),
    eventSourceUrl: 'https://www.acuros.ca/onboarding',
  });

  return { status: 200, body: { received: true, upgraded: true } };
}

// Subscribe / update / cancel: map the Stripe customer to a profile and set tier.
async function handleSubscriptionEvent(admin, eventType, sub) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : null;
  if (!customerId) {
    return { status: 200, body: { received: true, ignored: 'no-customer' } };
  }

  // Deleted → gone. Otherwise decide by status.
  let tier;
  if (eventType === 'customer.subscription.deleted') {
    tier = 'free';
  } else if (ACTIVE_STATUSES.has(sub.status)) {
    tier = 'plus';
  } else if (INACTIVE_STATUSES.has(sub.status)) {
    tier = 'free';
  } else {
    // incomplete / paused / anything else — don't touch the tier.
    return { status: 200, body: { received: true, ignored: 'status:' + (sub.status || 'unknown') } };
  }

  const { data: updated, error } = await admin
    .from('profiles')
    .update({ tier })
    .eq('stripe_customer_id', customerId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    // No profile carries this customer id (e.g. subscription predates the
    // stripe_customer_id backfill). Log so it can be reconciled by email.
    console.error('[stripe-webhook] subscription event for unknown customer:', customerId, eventType);
    return { status: 200, body: { received: true, ignored: 'unknown-customer' } };
  }
  console.log('[stripe-webhook]', eventType, '→ tier', tier, 'for', updated.id, 'customer:', customerId);
  return { status: 200, body: { received: true, tier } };
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

  const obj = event?.data?.object || {};
  try {
    const admin = getSupabaseAdmin();
    let result;
    switch (event?.type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(admin, obj);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        result = await handleSubscriptionEvent(admin, event.type, obj);
        break;
      default:
        // Ignore everything else with a 200 so Stripe doesn't retry.
        return res.status(200).json({ received: true, ignored: event?.type || 'unknown' });
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', err?.message || err);
    // 500 → Stripe retries, so a transient DB error can't lose a billing change.
    return res.status(500).json({ error: 'Handler failed, will retry.' });
  }
}
