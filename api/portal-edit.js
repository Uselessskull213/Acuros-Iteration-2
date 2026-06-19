// api/portal-edit.js — Claude-backed portal editor (Vercel Serverless).
//
// POST body:
//   { instruction: string,
//     currentHtml: string | null,
//     history: [{role:'user'|'assistant', content:string}],
//     org: { services?: [...], products?: [...] } }   // optional live overrides
//
// Response:
//   200 { html: string, message: string, modelUsed: string }
//
// Auth: Bearer Supabase access token, caller must be clinic_owner or admin.
//
// The model is told to return a single complete HTML document on every turn so
// the live preview iframe can just replace its srcdoc with the response. The
// actual prompt + Anthropic call live in _lib/portal-generator.js, shared with
// the onboarding publish step.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';
import { generatePortal } from './_lib/portal-generator.js';

const MAX_INSTRUCTION_CHARS  = 4000;
const MAX_HTML_CHARS         = 60000;
const MAX_HISTORY_MESSAGES   = 12;
const MAX_HISTORY_CHARS      = 40000;
const RATE_LIMIT_WINDOW_S    = 60;
const RATE_LIMIT_MAX_REQUESTS = 15;
const REQUEST_TIMEOUT_MS     = 55000;

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

// Pull the org row + role check, plus the clinic's saved services & products so
// the design is always grounded in real data — even if the client didn't send
// them. (Previously the prompt only saw client-supplied services/products, so a
// reload or a direct /editor visit made Claude believe the clinic had none and
// produce generic placeholder copy.)
async function loadOwnerOrg(admin, user) {
  const [{ data: profile }, { data: org }] = await Promise.all([
    admin.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    admin.from('organizations')
      .select('id, name, slug, specialty, location, theme, brand, portal_html, contact_email, logo_url')
      .eq('owner_id', user.id)
      .maybeSingle(),
  ]);
  let services = [];
  let products = [];
  if (org?.id) {
    const [svc, prd] = await Promise.all([
      admin.from('clinic_services')
        .select('name, description, category, duration_min, price_cents')
        .eq('org_id', org.id).eq('is_active', true)
        .order('sort_order', { ascending: true }).limit(50),
      admin.from('products')
        .select('name, description, category, price')
        .eq('org_id', org.id).limit(50),
    ]);
    services = svc.data || [];
    products = prd.data || [];
  }
  return { profile, org, services, products };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const tail = history.slice(-MAX_HISTORY_MESSAGES);
  const trimmed = tail.map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String(m?.content || '').trim().slice(0, MAX_HTML_CHARS),
  })).filter(m => m.content.length);

  let total = 0;
  const out = [];
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const c = trimmed[i];
    if (total + c.content.length > MAX_HISTORY_CHARS) break;
    out.unshift(c);
    total += c.content.length;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on the server.' });
  }
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'Supabase is not configured.' });
  }

  const user = await authedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    route: 'portal-edit',
    identifier: `${user.id}:${ip}`,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_S,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many edits — slow down a moment.' });

  const body = req.body || {};
  const instruction = String(body.instruction || '').trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) return res.status(400).json({ error: 'Instruction is required.' });

  const currentHtml = body.currentHtml ? String(body.currentHtml).slice(0, MAX_HTML_CHARS) : null;
  const clientHistory = sanitizeHistory(body.history);

  const admin = getSupabaseAdmin();
  const { profile, org, services, products } = await loadOwnerOrg(admin, user);
  if (!profile || (profile.role !== 'clinic_owner' && profile.role !== 'admin')) {
    return res.status(403).json({ error: 'Only clinic owners can edit a portal.' });
  }
  if (!org) {
    return res.status(404).json({ error: 'No organization found — finish onboarding first.' });
  }

  // Prefer client-supplied services/products (they reflect unsaved in-editor
  // edits); fall back to the DB rows we just loaded so the AI is always
  // grounded in the clinic's real catalogue.
  const orgContext = {
    ...org,
    services: Array.isArray(body.org?.services) && body.org.services.length ? body.org.services : services,
    products: Array.isArray(body.org?.products) && body.org.products.length ? body.org.products : products,
  };

  try {
    const { html, message, modelUsed } = await generatePortal({
      org: orgContext,
      instruction,
      currentHtml: currentHtml || org.portal_html,
      history: clientHistory,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return res.status(200).json({ html, message, modelUsed });
  } catch (err) {
    console.error('[portal-edit] error:', err);
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI took too long. Try a smaller change.' });
    }
    const status = err?.status || 500;
    const payload = { error: err?.message || 'Failed to reach Anthropic.' };
    if (err?.rawSnippet) payload.rawSnippet = err.rawSnippet;
    return res.status(status).json(payload);
  }
}
