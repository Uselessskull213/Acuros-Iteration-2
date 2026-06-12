// api/portal-save.js — persist AI-generated portal HTML to organizations.portal_html.
//
// POST body: { html: string, publish?: boolean, slug?: string }
//        or: { action: 'set_live', live: boolean }   (status-only toggle)
//
// Behaviour:
//   • Writes html → organizations.portal_html (must already own a row).
//   • If publish === true: also sets is_published = true, published_at = now(),
//     and (optionally) updates slug if provided + available.
//   • If publish === false (default): saves as draft only.
//   • action 'set_live' flips is_published/active without touching the HTML,
//     so the developer page can take a portal up or down instantly.
//
// Auth: Bearer Supabase access token; caller must be the org's owner_id
// and have role clinic_owner or admin.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const MAX_HTML_CHARS         = 200000;
const RATE_LIMIT_WINDOW_S    = 60;
const RATE_LIMIT_MAX_REQUESTS = 20;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set([
  'api','c','admin','dashboard','onboarding','bookings','shop','patient',
  'patient-portal','settings','editor','privacy','terms','login','signup',
  'about','help','contact','assets','static','public','health','acuros',
]);

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function authedUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  if (!isSupabaseConfigured()) return null;
  try {
    const admin = getSupabaseAdmin();
    const { data: { user } = {}, error } = await admin.auth.getUser(auth.slice(7));
    if (error || !user) return null;
    return user;
  } catch { return null; }
}

// Minimal HTML well-formed-ness check — we trust the source (Claude via
// our own /api/portal-edit) but still reject obvious garbage so a bad
// payload can't poison the public page.
function looksLikeHtmlDoc(html) {
  if (typeof html !== 'string') return false;
  if (html.length < 200 || html.length > MAX_HTML_CHARS) return false;
  return /<!doctype\s+html/i.test(html) && /<\/html>/i.test(html);
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'Supabase is not configured.' });
  }

  const user = await authedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    route: 'portal-save',
    identifier: `${user.id}:${ip}`,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_S,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many saves — try again in a minute.' });

  const { html, publish = false, slug: rawSlug = null, action = null, live = null } = req.body || {};
  const isStatusToggle = action === 'set_live';
  if (!isStatusToggle && !looksLikeHtmlDoc(html)) {
    return res.status(400).json({ error: 'HTML is not a complete document.' });
  }

  const admin = getSupabaseAdmin();
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!profile || (profile.role !== 'clinic_owner' && profile.role !== 'admin')) {
    return res.status(403).json({ error: 'Only clinic owners can publish a portal.' });
  }

  const { data: org } = await admin.from('organizations')
    .select('id, slug, name, is_published, published_at')
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!org) return res.status(404).json({ error: 'Finish onboarding before saving a portal.' });

  // ── Status-only toggle (developer page "up / down" switch) ──────────
  if (isStatusToggle) {
    const goLive = live === true;
    if (goLive && !org.slug) {
      return res.status(400).json({ error: 'Set a portal slug (publish once from the editor or wizard) before going live.' });
    }
    if (goLive && !org.name) {
      return res.status(400).json({ error: 'Set a clinic name in onboarding before going live.' });
    }
    const now = new Date().toISOString();
    const patch = goLive
      ? { is_published: true, active: true, published_at: org.published_at || now }
      : { is_published: false, active: false };
    const { error: toggleErr } = await admin.from('organizations')
      .update(patch)
      .eq('owner_id', user.id);
    if (toggleErr) {
      console.error('[portal-save] status toggle failed:', toggleErr);
      return res.status(500).json({ error: 'Failed to update portal status.' });
    }
    return res.status(200).json({
      ok: true,
      is_published: goLive,
      slug: org.slug || null,
      public_url: org.slug ? `/c/${org.slug}` : null,
    });
  }

  // Optional slug update during publish.
  let finalSlug = org.slug || null;
  if (publish && rawSlug && typeof rawSlug === 'string') {
    const candidate = rawSlug.toLowerCase().trim();
    if (candidate !== org.slug) {
      if (!SLUG_RE.test(candidate) || RESERVED_SLUGS.has(candidate)) {
        return res.status(400).json({ error: 'Slug is invalid or reserved.' });
      }
      const { data: clash } = await admin.from('organizations')
        .select('id').eq('slug', candidate).neq('owner_id', user.id).maybeSingle();
      if (clash) return res.status(409).json({ error: 'That slug is already taken.' });
      finalSlug = candidate;
    }
  }
  if (publish && !finalSlug) {
    return res.status(400).json({ error: 'A slug is required before publishing.' });
  }
  if (publish && !org.name) {
    return res.status(400).json({ error: 'Set a clinic name in onboarding before publishing.' });
  }

  const now = new Date().toISOString();
  const update = {
    portal_html: html,
    portal_updated_at: now,
  };
  if (publish) {
    update.is_published = true;
    update.published_at = now;
    update.active = true;
    if (finalSlug !== org.slug) update.slug = finalSlug;
  }

  const { error: updateErr } = await admin.from('organizations')
    .update(update)
    .eq('owner_id', user.id);
  if (updateErr) {
    console.error('[portal-save] update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to save portal.' });
  }

  return res.status(200).json({
    ok: true,
    saved_at: now,
    is_published: publish ? true : !!org.is_published,
    slug: finalSlug,
    public_url: finalSlug ? `/c/${finalSlug}` : null,
  });
}
