// api/memberships.js — patient ↔ clinic membership management.
//
// Routes (driven by ?action=…):
//   GET  /api/memberships?action=mine    — list clinics the caller has joined
//   POST /api/memberships?action=join    — body { code }, join by clinic code
//   POST /api/memberships?action=leave   — body { org_id }, leave a clinic
//
// Auth: every action requires a Bearer token from Supabase. Inserts
// route through the service-role key so we can validate the code, gate
// against self-join, and prevent dupes server-side.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX_REQUESTS = 30;

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
  } catch {
    return null;
  }
}

function normaliseCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 32);
}

export default async function handler(req, res) {
  // CORS: pin to ALLOWED_ORIGINS when configured (native mobile is unaffected).
  const _configured = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const _allow = _configured.length ? _configured : ['https://acuros.ca', 'https://www.acuros.ca', 'https://dev.acuros.ca'];
  const _o = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    (_o && _allow.includes(_o)) ? _o
    : (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(_o) ? _o : _allow[0]));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    route: 'memberships',
    identifier: ip,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_S,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });

  if (!isSupabaseConfigured()) {
    return res.status(500).json({ error: 'Supabase is not configured on this deployment.' });
  }

  const user = await authedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const action = String((req.query && req.query.action) || '').trim();
  const admin = getSupabaseAdmin();

  try {
    // ── GET ?action=mine ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'mine') {
      const { data: rows, error } = await admin
        .from('clinic_memberships')
        .select('id, joined_at, org:org_id(id, name, slug, code, is_published, theme, brand, location, specialty)')
        .eq('user_id', user.id)
        .order('joined_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ memberships: rows || [] });
    }

    // ── POST ?action=join ────────────────────────────────────────────
    // body: { code }
    if (req.method === 'POST' && action === 'join') {
      const code = normaliseCode((req.body && req.body.code) || '');
      if (code.length < 4) return res.status(400).json({ error: 'Code is too short.' });

      // Lookup org by code (case-insensitive). Pull only the fields the
      // patient needs to see plus owner_id so we can block self-join.
      const { data: orgs, error: lookupErr } = await admin
        .from('organizations')
        .select('id, name, slug, code, owner_id, is_published, active')
        .ilike('code', code)
        .limit(1);
      if (lookupErr) throw lookupErr;
      const org = (orgs || [])[0];
      if (!org) return res.status(404).json({ error: 'No clinic matches that code.' });

      // Block self-join — owners shouldn't appear as patients of their
      // own clinic. They already have full access via the dashboard.
      if (org.owner_id && org.owner_id === user.id) {
        return res.status(400).json({ error: 'You own this clinic — owners cannot also be patient members.' });
      }

      // Block joining unpublished/inactive clinics so patients don't get
      // a half-built portal experience.
      if (!org.is_published || org.active === false) {
        return res.status(403).json({ error: 'This clinic is not yet accepting patients.' });
      }

      // Verification gate: the clinic owner must have added this patient's
      // account code to their verified list. This is a clean pre-check for a
      // friendly message; the BEFORE INSERT trigger on clinic_memberships is
      // the authoritative backstop that no code path can bypass.
      const { data: prof } = await admin
        .from('profiles').select('account_code').eq('id', user.id).maybeSingle();
      const { data: verified } = await admin
        .from('verified_members')
        .select('id')
        .eq('org_id', org.id)
        .ilike('account_code', prof?.account_code || ' ')
        .maybeSingle();
      if (!verified) {
        return res.status(403).json({
          error: 'This clinic needs to verify you first. Share your Acuros account code with them, then try again.',
        });
      }

      // Insert the membership. The unique (user_id, org_id) constraint
      // makes re-joining a no-op from the user's perspective.
      const { data: membership, error: joinErr } = await admin
        .from('clinic_memberships')
        .upsert({ user_id: user.id, org_id: org.id }, { onConflict: 'user_id,org_id', ignoreDuplicates: false })
        .select('id, joined_at')
        .single();
      if (joinErr) throw joinErr;

      return res.status(200).json({
        joined: true,
        membership,
        clinic: { id: org.id, name: org.name, slug: org.slug, code: org.code },
      });
    }

    // ── POST ?action=leave ───────────────────────────────────────────
    // body: { org_id }
    if (req.method === 'POST' && action === 'leave') {
      const orgId = String((req.body && req.body.org_id) || '').trim();
      if (!orgId) return res.status(400).json({ error: 'Missing org_id.' });

      const { data: removed, error } = await admin
        .from('clinic_memberships')
        .delete()
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .select('id');
      if (error) throw error;

      return res.status(200).json({ left: (removed && removed.length > 0) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[memberships] error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
