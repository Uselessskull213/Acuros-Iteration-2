// api/verified-members.js — clinic owners manage the allowlist of patient
// account codes permitted to join their clinic.
//
// Routes (driven by ?action=…):
//   GET  /api/verified-members?action=list           — this owner's verified list
//   POST /api/verified-members?action=add   { account_code }  — verify a patient
//   POST /api/verified-members?action=remove{ id | account_code } — un-verify + revoke
//
// Auth: every action requires a Bearer token from Supabase AND the caller
// must own a clinic (organizations.owner_id = uid). Writes route through the
// service-role key so we can resolve the account code to a real patient and
// keep clients off the table directly.

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

// Account codes look like ACU-XXXXXX (uppercase, dash, no look-alikes).
function normaliseAccountCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 32);
}

function displayName(profile) {
  if (!profile) return null;
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  return full || profile.name || null;
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
    route: 'verified-members',
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
    // Resolve the caller's clinic. Ownership is the authorization boundary:
    // no owned org → not a clinic owner → 403.
    const { data: org, error: orgErr } = await admin
      .from('organizations')
      .select('id, name, owner_id')
      .eq('owner_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (orgErr && orgErr.code !== 'PGRST116') throw orgErr;
    if (!org) {
      return res.status(403).json({ error: 'Only clinic owners can manage verified members.' });
    }

    // ── GET ?action=list ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'list') {
      const { data: rows, error } = await admin
        .from('verified_members')
        .select('id, account_code, patient_name, user_id, created_at')
        .eq('org_id', org.id)
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Mark who has actually joined (via either join mechanism).
      const userIds = (rows || []).map((r) => r.user_id).filter(Boolean);
      const joined = new Set();
      if (userIds.length) {
        const [mem, prof] = await Promise.all([
          admin.from('clinic_memberships').select('user_id').eq('org_id', org.id).in('user_id', userIds),
          admin.from('profiles').select('id').eq('org_id', org.id).in('id', userIds),
        ]);
        (mem.data || []).forEach((m) => joined.add(m.user_id));
        (prof.data || []).forEach((p) => joined.add(p.id));
      }
      const members = (rows || []).map((r) => ({ ...r, joined: r.user_id ? joined.has(r.user_id) : false }));
      return res.status(200).json({ members });
    }

    // ── POST ?action=add ─────────────────────────────────────────────
    // body: { account_code }
    if (req.method === 'POST' && action === 'add') {
      const accountCode = normaliseAccountCode((req.body && req.body.account_code) || '');
      if (accountCode.length < 4) return res.status(400).json({ error: 'That account code looks too short.' });

      // Resolve the code to a real Acuros patient so owners can't verify a
      // typo, and so we capture a display name + user_id up front.
      const { data: profile, error: profErr } = await admin
        .from('profiles')
        .select('id, name, first_name, last_name, account_code, role')
        .ilike('account_code', accountCode)
        .maybeSingle();
      if (profErr && profErr.code !== 'PGRST116') throw profErr;
      if (!profile) return res.status(404).json({ error: 'No Acuros account has that code. Ask the patient to double-check it.' });

      if (profile.id === user.id) {
        return res.status(400).json({ error: "That's your own account code — owners aren't patients of their own clinic." });
      }

      // Store the code exactly as held on the profile (already normalised).
      const { data: inserted, error: insErr } = await admin
        .from('verified_members')
        .upsert(
          {
            org_id: org.id,
            account_code: profile.account_code,
            user_id: profile.id,
            patient_name: displayName(profile),
            added_by: user.id,
          },
          { onConflict: 'org_id,account_code', ignoreDuplicates: false }
        )
        .select('id, account_code, patient_name, user_id, created_at')
        .single();
      if (insErr) throw insErr;

      return res.status(200).json({ member: { ...inserted, joined: false } });
    }

    // ── POST ?action=remove ──────────────────────────────────────────
    // body: { id } or { account_code }. Un-verifying also REVOKES access:
    // any existing membership is deleted and the patient's org link cleared.
    if (req.method === 'POST' && action === 'remove') {
      const id = String((req.body && req.body.id) || '').trim();
      const accountCode = normaliseAccountCode((req.body && req.body.account_code) || '');
      if (!id && !accountCode) return res.status(400).json({ error: 'Missing id or account_code.' });

      let q = admin.from('verified_members').delete().eq('org_id', org.id);
      q = id ? q.eq('id', id) : q.ilike('account_code', accountCode);
      const { data: removed, error } = await q.select('id, user_id');
      if (error) throw error;
      const row = (removed || [])[0];

      // Revoke any access the un-verified patient already had.
      if (row?.user_id) {
        await admin.from('clinic_memberships').delete().eq('org_id', org.id).eq('user_id', row.user_id);
        await admin.from('profiles').update({ org_id: null }).eq('id', row.user_id).eq('org_id', org.id);
      }

      return res.status(200).json({ removed: Boolean(row) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[verified-members] error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
