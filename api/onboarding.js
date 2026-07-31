// api/onboarding.js — Vercel Serverless Function
// One endpoint for the self-serve clinic onboarding wizard.
//
// Routes (driven by ?action=…):
//   GET  /api/onboarding?action=state    — fetch this owner's draft + role
//   POST /api/onboarding?action=save     — save partial wizard state
//   POST /api/onboarding?action=extract  — AI-parse a free-text answer
//                                          into structured rows
//   POST /api/onboarding?action=publish  — flip is_published = true,
//                                          sync services & products
//   POST /api/onboarding?action=check-slug — check slug availability
//
// Auth: every action requires a Bearer token from Supabase. The user's
// uid identifies which organizations row they own.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';
import { sanitizePortalHtml } from './_lib/sanitize.js';
import { generatePortal } from './_lib/portal-generator.js';
import { crawlSite } from './_lib/site-import.js';

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

// Lookup the owner's organization row, lazily creating one on first save.
async function getOrCreateOwnerOrg(admin, user, opts = {}) {
  // Deterministic single-row read. A partial unique index on owner_id keeps
  // this to one row; order+limit additionally defends against any legacy
  // duplicates so .maybeSingle() can never throw PGRST116 ("multiple rows").
  const readOwnerOrg = () => admin
    .from('organizations')
    .select('*')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: existing, error: readErr } = await readOwnerOrg();
  if (readErr && readErr.code !== 'PGRST116') throw readErr;
  if (existing) return existing;
  if (!opts.create) return null;

  // Default name = derived from user email until they set it in Step 1.
  const fallbackName = (user.email || 'Clinic').split('@')[0]
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Clinic';

  // The legacy organizations.code column is NOT NULL with no default.
  // Synthesise a stable, owner-unique code from the auth uuid so we never
  // collide with another owner's code on insert.
  const code = 'CLINIC-' + (user.id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

  const { data: created, error: createErr } = await admin
    .from('organizations')
    .insert({
      owner_id: user.id,
      name: fallbackName,
      code,
      active: false,
      is_published: false,
      onboarding_state: { step: 1, started_at: new Date().toISOString() },
    })
    .select()
    .single();
  if (createErr) {
    // A concurrent wizard request may have created the row first (unique
    // owner_id). Fall back to reading that row instead of failing the wizard.
    if (createErr.code === '23505') {
      const { data: raced } = await readOwnerOrg();
      if (raced) return raced;
    }
    console.error('[onboarding] org insert failed:', createErr);
    throw createErr;
  }
  return created;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

const ALLOWED_EXTRACT_KINDS = new Set(['services', 'products', 'brand', 'slug', 'design']);

// Normalise AI-extracted opening hours into availability rows:
// [{day_of_week 0-6, start_time 'HH:MM', end_time 'HH:MM'}], closed days dropped.
function normalizeHours(raw) {
  if (!Array.isArray(raw)) return [];
  const hhmm = (v) => {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return String(h).padStart(2, '0') + ':' + m[2];
  };
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    // Accepts the AI shape ({day, open, close, closed}) and the normalised
    // shape the wizard round-trips ({day_of_week, start_time, end_time}).
    const day = Number(row?.day ?? row?.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day)) continue;
    if (row?.closed) { seen.add(day); continue; }
    const start = hhmm(row?.open ?? row?.start_time), end = hhmm(row?.close ?? row?.end_time);
    if (!start || !end || start >= end) continue;
    seen.add(day);
    out.push({ day_of_week: day, start_time: start, end_time: end });
  }
  return out.sort((a, b) => a.day_of_week - b.day_of_week);
}

const EXTRACT_SCHEMAS = {
  services: {
    description: 'Extract a clean list of bookable services from the clinic owner\'s free-text description.',
    schema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:         { type: 'string' },
              category:     { type: 'string', description: 'One of: Injectables, Skin, Body, Wellness, Laser, Consultation' },
              description:  { type: 'string' },
              duration_min: { type: 'integer' },
              price_cents:  { type: 'integer', description: 'Estimated CAD price in cents. Use 0 if unknown.' },
            },
            required: ['name', 'category', 'duration_min'],
          },
        },
      },
      required: ['services'],
    },
  },
  products: {
    description: 'Extract a clean product catalog from the clinic owner\'s free-text description.',
    schema: {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:        { type: 'string' },
              category:    { type: 'string', description: 'One of: Skincare, Supplements, Wellness, Pain Relief' },
              description: { type: 'string' },
              price_cents: { type: 'integer' },
            },
            required: ['name', 'category', 'price_cents'],
          },
        },
      },
      required: ['products'],
    },
  },
  brand: {
    description: 'Polish a clinic\'s brand description into a tagline + a structured profile. Keep tone measured and medical, not breathless.',
    schema: {
      type: 'object',
      properties: {
        tagline:     { type: 'string', description: 'Six to eight words. No exclamation marks.' },
        description: { type: 'string', description: 'Eighty words, plain English, present tense.' },
        voice:       { type: 'string', description: 'One of: Clinical, Warm, Premium, Direct.' },
      },
      required: ['tagline', 'description', 'voice'],
    },
  },
  slug: {
    description: 'Suggest 3 short, URL-safe slug candidates for a clinic.',
    schema: {
      type: 'object',
      properties: {
        candidates: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      },
      required: ['candidates'],
    },
  },
  // ── design: one-shot full-portal generator ──
  // Take a single paragraph from the clinic owner and produce the entire
  // portal skeleton: brand voice, palette, services, products, slug.
  // This is what "AI designs the page for them" actually means.
  design: {
    description: 'Design a complete clinic portal from a single paragraph. The owner has typed one or two sentences about their practice — produce a polished tagline, an 80-word public description, a brand voice, an accent palette hex (one of: #c9a96e, #2f6b5e, #7a3b2a, #3a4f7a, #262626), an inferred speciality and location if hinted, a list of 4 to 8 plausible services with categories and durations, an optional list of products, and 3 slug candidates. Be specific; do not hedge with generic copy.',
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Suggested or extracted clinic name. Empty string if not stated.' },
        specialty:   { type: 'string' },
        location:    { type: 'string' },
        tagline:     { type: 'string', description: 'Six to eight words. No exclamation marks.' },
        description: { type: 'string', description: 'Eighty words, present tense, plain English. No marketing slop.' },
        voice:       { type: 'string', description: 'One of: Clinical, Warm, Premium, Direct.' },
        accent:      { type: 'string', description: 'Hex color from the allowed palette set.' },
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:         { type: 'string' },
              category:     { type: 'string' },
              description:  { type: 'string' },
              duration_min: { type: 'integer' },
              price_cents:  { type: 'integer' },
            },
            required: ['name', 'category', 'duration_min'],
          },
        },
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:        { type: 'string' },
              category:    { type: 'string' },
              description: { type: 'string' },
              price_cents: { type: 'integer' },
            },
            required: ['name', 'category'],
          },
        },
        slugs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      },
      required: ['tagline', 'description', 'voice', 'accent', 'services', 'slugs'],
    },
  },
};

// Same output shape as `design`, but grounded in the clinic's real website.
// Fidelity is the whole point: this prompt forbids inventing anything that
// is not in the crawled content.
EXTRACT_SCHEMAS.design_site = {
  description: [
    'You are given the ACTUAL text content crawled from the clinic\'s existing website, plus optional owner notes.',
    'Accuracy is paramount - extract, do not imagine:',
    '- Use the clinic\'s real name exactly as the site presents it.',
    '- List the services the site actually offers, names as printed (normalise casing only). Do NOT add plausible-but-absent services.',
    '- Include a price ONLY when one is printed on the site (integer cents; CAD unless the site clearly says otherwise). Use 0 when no price is shown.',
    '- duration_min: use the stated duration when printed; otherwise a conservative standard estimate for that treatment type.',
    '- Products: only items the site actually sells or lists for retail. If none, return an empty array.',
    '- Location, speciality: only from the site content.',
    '- Tagline and description: derive from the site\'s own wording, tightened to the limits - do not introduce new claims.',
    '- The owner\'s notes, when present, are corrections and override the site.',
    '- accent: pick the allowed hex closest to the site\'s brand feel; if unclear, choose by speciality.',
    '- slugs: 3 candidates from the clinic\'s real name.',
    '- hours: the clinic\'s real opening hours, one entry per day the site states. day = 0 (Sunday) through 6 (Saturday); open/close as 24-hour "HH:MM". Mark closed:true for days the site says they are closed. If the site shows no hours at all, return an empty array - never guess hours.',
  ].join('\n'),
  schema: (() => {
    const s = JSON.parse(JSON.stringify(EXTRACT_SCHEMAS.design.schema));
    s.properties.hours = {
      type: 'array',
      description: 'Opening hours exactly as published on the site. Empty when the site states none.',
      items: {
        type: 'object',
        properties: {
          day:    { type: 'integer', description: '0=Sunday … 6=Saturday' },
          open:   { type: 'string', description: '24-hour HH:MM, e.g. "09:00". Empty when closed.' },
          close:  { type: 'string', description: '24-hour HH:MM, e.g. "17:30". Empty when closed.' },
          closed: { type: 'boolean', description: 'True when the clinic is closed that day.' },
        },
        required: ['day'],
      },
    };
    return s;
  })(),
};

// Try Anthropic Claude Sonnet first (better for design tasks), fall back
// to Google Gemini if no Anthropic key is configured. Both go through a
// strict JSON-mode contract so the wizard can rely on the schema.
async function callAIJson({ kind, text, org, maxTokens }) {
  const conf = EXTRACT_SCHEMAS[kind];
  if (!conf) throw new Error('Unsupported extract kind');

  // Ground the model in whatever the clinic has already told us. For the
  // one-shot `design` kind these are usually still empty (it infers them from
  // the paragraph), but for services/products/brand extraction this context is
  // what makes the output specific to the clinic instead of generic boilerplate.
  const facts = [
    org?.name ? `Clinic name: "${org.name}".` : '',
    org?.specialty ? `Speciality: ${org.specialty}.` : '',
    org?.location ? `Location: ${org.location}.` : '',
    org?.brand?.voice ? `Preferred brand voice: ${org.brand.voice}.` : '',
  ].filter(Boolean).join(' ');

  const systemPrompt = [
    `You are the onboarding designer for Acuros Health, a Canadian clinic platform.`,
    `Tone: measured medical, premium-but-restrained. Never use breathless marketing copy or em-dashes. Never invent statistics.`,
    `${conf.description}`,
    facts ? `Clinic context: ${facts}` : '',
  ].filter(Boolean).join('\n\n');

  const userPrompt = `Owner-provided text:\n"""${text}"""\n\nReturn ONLY a JSON object that conforms to the agreed schema. No prose, no markdown.`;

  // Prefer Anthropic if available. Their JSON-mode behaviour is sturdier
  // for nested schemas and the Sonnet model writes better design copy.
  if (process.env.ANTHROPIC_API_KEY) {
    return await callAnthropicJson({ systemPrompt, userPrompt, schema: conf.schema, maxTokens });
  }
  if (process.env.GEMINI_API_KEY) {
    return await callGeminiJson({ systemPrompt, userPrompt, schema: conf.schema, maxTokens });
  }
  throw new Error('No AI provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).');
}

async function callAnthropicJson({ systemPrompt, userPrompt, schema, maxTokens }) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 28000);
  try {
    // Claude does structured output via the `tools` parameter. We define a
    // single tool whose input is the schema we want, then force-use it.
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: maxTokens || 2048,
        system: systemPrompt,
        tools: [{
          name: 'emit_result',
          description: 'Emit the structured result for the wizard.',
          input_schema: schema,
        }],
        tool_choice: { type: 'tool', name: 'emit_result' },
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Anthropic ${resp.status}`);
    }
    const data = await resp.json();
    const tool = (data.content || []).find((c) => c.type === 'tool_use');
    if (!tool || !tool.input) throw new Error('Claude returned no tool result');
    return tool.input;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiJson({ systemPrompt, userPrompt, schema, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini key not configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 22000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: maxTokens || 2048,
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Gemini ${resp.status}`);
    }
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(txt);
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  // CORS: pin to ALLOWED_ORIGINS when configured (falls back to * only if unset,
  // for backward-compat). Native mobile clients don't enforce CORS, so this only
  // tightens browser callers.
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
    route: 'onboarding',
    identifier: ip,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: RATE_LIMIT_WINDOW_S,
  });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });

  const action = String((req.query && req.query.action) || '').trim();

  if (!isSupabaseConfigured()) {
    return res.status(500).json({ error: 'Supabase is not configured on this deployment.' });
  }

  const user = await authedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const admin = getSupabaseAdmin();

  // Resolve the caller's role. Patients are not allowed to use the
  // onboarding wizard at all — they get a 403 with a clear message.
  // The trigger we installed in supabase-roles.sql defaults role to
  // 'patient' for any new auth user, so role here is always present.
  let profileRole = 'patient';
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role) profileRole = profile.role;
  } catch (_e) { /* non-fatal */ }

  // Read-only state introspection is OK regardless of role — it lets the
  // UI make role-aware decisions (e.g. show a "request clinic access"
  // page) without an extra round trip.
  const isReadOnlyState = req.method === 'GET' && action === 'state';
  if (!isReadOnlyState && profileRole !== 'clinic_owner' && profileRole !== 'admin') {
    return res.status(403).json({
      error: 'Onboarding is for clinic-owner accounts. Patients can join existing clinics with a code instead.',
      role: profileRole,
    });
  }

  try {
    // ── GET ?action=state ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'state') {
      // For owners, lazily create their draft org row. For patients,
      // never create — just return their role so the UI can route them
      // to the patient portal instead.
      const org = (profileRole === 'clinic_owner' || profileRole === 'admin')
        ? await getOrCreateOwnerOrg(admin, user, { create: true })
        : null;
      const reservedRes = await admin.from('reserved_slugs').select('slug');
      return res.status(200).json({
        role: profileRole,
        org,
        reservedSlugs: (reservedRes.data || []).map((r) => r.slug),
      });
    }

    // ── POST ?action=save ─────────────────────────────────────────────
    // body: { step, patch }   patch is a partial of organizations columns
    if (req.method === 'POST' && action === 'save') {
      const body = req.body || {};
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
      const allowed = ['name', 'specialty', 'description', 'location', 'logo_url',
                       'tags', 'contact_email', 'theme', 'brand', 'slug', 'custom_domain',
                       'onboarding_state'];
      const safe = {};
      for (const k of allowed) if (k in patch) safe[k] = patch[k];

      // Normalise + validate slug if provided.
      if (typeof safe.slug === 'string') {
        safe.slug = slugify(safe.slug);
        if (safe.slug.length < 3) return res.status(400).json({ error: 'Slug must be at least 3 characters.' });
        const { data: reserved } = await admin.from('reserved_slugs').select('slug').eq('slug', safe.slug).maybeSingle();
        if (reserved) return res.status(409).json({ error: 'That slug is reserved. Pick another.' });
        const { data: clash } = await admin.from('organizations').select('id').eq('slug', safe.slug).neq('owner_id', user.id).maybeSingle();
        if (clash) return res.status(409).json({ error: 'That slug is already taken.' });
      }

      // Ensure org exists.
      const org = await getOrCreateOwnerOrg(admin, user, { create: true });

      const { data: updated, error } = await admin
        .from('organizations')
        .update(safe)
        .eq('id', org.id)
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ org: updated });
    }

    // ── POST ?action=check-slug ──────────────────────────────────────
    if (req.method === 'POST' && action === 'check-slug') {
      const slug = slugify((req.body && req.body.slug) || '');
      if (slug.length < 3) return res.status(200).json({ available: false, reason: 'too-short', slug });
      const { data: reserved } = await admin.from('reserved_slugs').select('slug').eq('slug', slug).maybeSingle();
      if (reserved) return res.status(200).json({ available: false, reason: 'reserved', slug });
      const org = await getOrCreateOwnerOrg(admin, user);
      const { data: clash } = await admin
        .from('organizations')
        .select('id')
        .eq('slug', slug)
        .neq('id', org?.id || '00000000-0000-0000-0000-000000000000')
        .maybeSingle();
      if (clash) return res.status(200).json({ available: false, reason: 'taken', slug });
      return res.status(200).json({ available: true, slug });
    }

    // ── POST ?action=extract ─────────────────────────────────────────
    // body: { kind: 'services'|'products'|'brand'|'slug'|'design', text }
    if (req.method === 'POST' && action === 'extract') {
      const body = req.body || {};
      const kind = String(body.kind || '').trim();
      const text = String(body.text || '').trim().slice(0, 6000);
      if (!ALLOWED_EXTRACT_KINDS.has(kind)) return res.status(400).json({ error: 'Unknown kind' });
      if (!text) return res.status(400).json({ error: 'Empty input' });
      const org = await getOrCreateOwnerOrg(admin, user);
      const out = await callAIJson({ kind, text, org });

      // For slug suggestions (either standalone or inside `design`),
      // scrub against reserved + taken so the UI only surfaces usable
      // candidates.
      if (kind === 'slug' || kind === 'design') {
        const arrKey = kind === 'slug' ? 'candidates' : 'slugs';
        if (Array.isArray(out[arrKey])) {
          const cleaned = out[arrKey].map(slugify).filter((s) => s.length >= 3);
          const { data: reserved } = await admin.from('reserved_slugs').select('slug');
          const reservedSet = new Set((reserved || []).map((r) => r.slug));
          const { data: taken } = await admin
            .from('organizations')
            .select('slug')
            .neq('owner_id', user.id)
            .not('slug', 'is', null);
          const takenSet = new Set((taken || []).map((r) => r.slug));
          out[arrKey] = cleaned.filter((s) => !reservedSet.has(s) && !takenSet.has(s));
        }
      }

      return res.status(200).json(out);
    }

    // ── POST ?action=checkout ────────────────────────────────────────
    // Creates a Stripe Checkout Session (subscription mode) for Acuros
    // Plus and returns its URL. The webhook (api/stripe-webhook.js) flips
    // profiles.tier on completion; verify-checkout below gives an instant
    // unlock on return. Requires STRIPE_SECRET_KEY in the environment —
    // without it the client falls back to the static payment link.
    if (req.method === 'POST' && action === 'checkout') {
      const sk = process.env.STRIPE_SECRET_KEY;
      if (!sk) return res.status(501).json({ error: 'Stripe checkout is not configured.', code: 'STRIPE_NOT_CONFIGURED' });

      const retOrigin = (_o && (_allow.includes(_o) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(_o)))
        ? _o : 'https://www.acuros.ca';
      const stripeForm = async (path, params) => {
        const resp = await fetch('https://api.stripe.com/v1/' + path, {
          method: params ? 'POST' : 'GET',
          headers: {
            Authorization: 'Bearer ' + sk,
            ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: params ? params.toString() : undefined,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error?.message || ('Stripe ' + resp.status));
        return data;
      };

      // Reuse the existing CA$150/month price when one exists (it backs the
      // payment link) instead of minting a new product per session.
      let priceId = process.env.STRIPE_PLUS_PRICE_ID || null;
      if (!priceId) {
        try {
          const prices = await stripeForm('prices?active=true&type=recurring&limit=100', null);
          const match = (prices.data || []).find((p) =>
            p.currency === 'cad' && p.unit_amount === 15000 && p.recurring?.interval === 'month');
          if (match) priceId = match.id;
        } catch (_e) { /* fall through to inline price_data */ }
      }

      const p = new URLSearchParams();
      p.set('mode', 'subscription');
      p.set('client_reference_id', user.id);
      if (user.email) p.set('customer_email', user.email);
      p.set('success_url', retOrigin + '/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}');
      p.set('cancel_url', retOrigin + '/onboarding?checkout=cancelled');
      p.set('allow_promotion_codes', 'true');
      p.set('subscription_data[metadata][supabase_user_id]', user.id);
      p.set('line_items[0][quantity]', '1');
      if (priceId) {
        p.set('line_items[0][price]', priceId);
      } else {
        p.set('line_items[0][price_data][currency]', 'cad');
        p.set('line_items[0][price_data][unit_amount]', '15000');
        p.set('line_items[0][price_data][recurring][interval]', 'month');
        p.set('line_items[0][price_data][product_data][name]', 'Acuros Plus');
      }
      const session = await stripeForm('checkout/sessions', p);
      return res.status(200).json({ url: session.url, id: session.id });
    }

    // ── POST ?action=verify-checkout ─────────────────────────────────
    // body: { session_id } — instant unlock on return from Stripe. The
    // webhook remains authoritative; this just removes the lag. The
    // session must belong to the signed-in user and be paid.
    if (req.method === 'POST' && action === 'verify-checkout') {
      const sk = process.env.STRIPE_SECRET_KEY;
      if (!sk) return res.status(501).json({ error: 'Stripe checkout is not configured.', code: 'STRIPE_NOT_CONFIGURED' });
      const sid = String((req.body && req.body.session_id) || '').trim();
      if (!/^cs_[a-zA-Z0-9_]+$/.test(sid)) return res.status(400).json({ error: 'Invalid session id.' });

      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sid), {
        headers: { Authorization: 'Bearer ' + sk },
      });
      const session = await resp.json().catch(() => ({}));
      if (!resp.ok) return res.status(502).json({ error: session?.error?.message || 'Could not verify the session.' });
      if (String(session.client_reference_id || '') !== user.id) {
        return res.status(403).json({ error: 'That checkout session belongs to a different account.' });
      }
      const paid = session.payment_status === 'paid';
      if (paid) {
        const customerId = typeof session.customer === 'string' ? session.customer : null;
        const patch = { tier: 'plus' };
        if (customerId) patch.stripe_customer_id = customerId;
        const { error } = await admin.from('profiles').update(patch).eq('id', user.id);
        if (error) throw error;
      }
      return res.status(200).json({ paid, status: session.payment_status || session.status || 'unknown' });
    }

    // ── POST ?action=import-site ─────────────────────────────────────
    // body: { url, notes }
    // Crawls the clinic's existing website (homepage + a handful of
    // service/product/about pages), then runs the strict design_site
    // extraction over the real content. Returns the same shape as the
    // `design` extract, plus the discovered logo and crawl provenance.
    if (req.method === 'POST' && action === 'import-site') {
      const body = req.body || {};
      const url = String(body.url || '').trim().slice(0, 300);
      const notes = String(body.notes || '').trim().slice(0, 2000);
      if (!url) return res.status(400).json({ error: 'Enter your website address.' });

      let site;
      try {
        site = await crawlSite(url);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Could not read that site.' });
      }
      if (!site.text || site.text.length < 200) {
        return res.status(400).json({ error: 'That site has too little readable content to import. Describe your clinic instead.' });
      }

      const org = await getOrCreateOwnerOrg(admin, user);
      const grounding = [
        `WEBSITE CONTENT (crawled live from ${site.finalUrl}):`,
        site.text,
        `SITE METADATA: ${JSON.stringify(site.meta)}`,
        notes ? `OWNER'S NOTES (corrections and additions - these override the site):\n${notes}` : '',
      ].filter(Boolean).join('\n\n');
      const out = await callAIJson({ kind: 'design_site', text: grounding, org, maxTokens: 4096 });

      // Scrub slug candidates against reserved + taken, same as `design`.
      if (Array.isArray(out.slugs)) {
        const cleaned = out.slugs.map(slugify).filter((s) => s.length >= 3);
        const { data: reserved } = await admin.from('reserved_slugs').select('slug');
        const reservedSet = new Set((reserved || []).map((r) => r.slug));
        const { data: taken } = await admin
          .from('organizations')
          .select('slug')
          .neq('owner_id', user.id)
          .not('slug', 'is', null);
        const takenSet = new Set((taken || []).map((r) => r.slug));
        out.slugs = cleaned.filter((s) => !reservedSet.has(s) && !takenSet.has(s));
      }

      return res.status(200).json({
        ...out,
        hours: normalizeHours(out.hours),
        logo: site.logo || null,
        source: {
          url: site.finalUrl,
          pages: site.pagesCrawled,
          siteEmail: site.meta.email || '',
          sitePhone: site.meta.phone || '',
        },
      });
    }

    // ── POST ?action=publish ─────────────────────────────────────────
    // body: { services: [...], products: [...] }
    // Publishes the org and replaces its services + products with the
    // committed wizard output. This is destructive on those two tables
    // so we do it in a single owner-scoped transaction-equivalent.
    if (req.method === 'POST' && action === 'publish') {
      const body = req.body || {};
      // Be defensive — even if save somehow didn't run, create the row.
      const org = await getOrCreateOwnerOrg(admin, user, { create: true });
      if (!org) return res.status(500).json({ error: 'Could not load or create your clinic record.' });

      // Publishing is ONE-TIME. A published clinic is edited via the AI
      // editor (/editor + portal-save), never re-run through the wizard —
      // re-publishing would wipe services/products and regenerate the
      // portal from scratch. Checked BEFORE any destructive writes.
      if (org.is_published || org.published_at) {
        return res.status(409).json({
          error: 'Your clinic is already published. Use the AI editor to make changes — the wizard cannot re-publish over a live portal.',
          code: 'ALREADY_PUBLISHED',
          editorUrl: '/editor',
        });
      }

      // Publishing requires an active Acuros Plus membership. Enforced
      // server-side so the gate cannot be bypassed by skipping the UI.
      // profiles.tier is flipped to 'plus' by api/stripe-webhook.js when
      // Stripe reports checkout.session.completed for this user.
      const { data: payerProfile } = await admin
        .from('profiles').select('tier').eq('id', user.id).maybeSingle();
      const tier = String(payerProfile?.tier || '').toLowerCase();
      if (tier !== 'plus' && tier !== 'admin') {
        return res.status(402).json({
          error: 'Publishing your portal requires an Acuros Plus membership.',
          code: 'PAYMENT_REQUIRED',
          payUrl: 'https://buy.stripe.com/fZu9AM1f89Wz2DjbWA4ko05',
        });
      }

      if (!org.slug) return res.status(400).json({ error: 'Pick a slug before publishing.' });
      if (!org.name || org.name.length < 2) return res.status(400).json({ error: 'Clinic name is required.' });

      // Opening hours → bookable availability. Imported from the clinic's
      // own website (or edited in the wizard); only replaced when the
      // wizard actually sends hours, so an empty import never wipes
      // availability an owner set up by hand.
      const hourRows = normalizeHours(body.hours);
      if (hourRows.length) {
        await admin.from('availability').delete().eq('org_id', org.id);
        const { error: hoursErr } = await admin.from('availability').insert(
          hourRows.map((h) => ({ org_id: org.id, ...h, is_active: true }))
        );
        if (hoursErr) throw hoursErr;
      }

      // Replace services
      if (Array.isArray(body.services)) {
        await admin.from('clinic_services').delete().eq('org_id', org.id);
        const rows = body.services.slice(0, 60).map((s, i) => ({
          org_id: org.id,
          name: String(s.name || '').slice(0, 200),
          description: s.description ? String(s.description).slice(0, 1000) : null,
          category: s.category ? String(s.category).slice(0, 80) : null,
          duration_min: Number.isFinite(+s.duration_min) ? Math.max(5, Math.min(480, +s.duration_min)) : 60,
          price_cents: Number.isFinite(+s.price_cents) && +s.price_cents > 0 ? Math.round(+s.price_cents) : null,
          sort_order: i,
          is_active: true,
        })).filter((r) => r.name);
        if (rows.length) {
          const { error: svcErr } = await admin.from('clinic_services').insert(rows);
          if (svcErr) throw svcErr;
        }
      }

      // Replace products
      if (Array.isArray(body.products)) {
        await admin.from('products').delete().eq('org_id', org.id);
        const rows = body.products.slice(0, 80).map((p) => ({
          org_id: org.id,
          name: String(p.name || '').slice(0, 200),
          description: p.description ? String(p.description).slice(0, 1000) : null,
          category: p.category ? String(p.category).slice(0, 80) : null,
          price: Number.isFinite(+p.price_cents) ? Math.max(0, Math.round(+p.price_cents)) : 0,
          in_stock: true,
        })).filter((r) => r.name);
        if (rows.length) {
          const { error: prdErr } = await admin.from('products').insert(rows);
          if (prdErr) throw prdErr;
        }
      }

      // Auto-generate a bespoke portal so /c/<slug> launches with a real,
      // clinic-specific AI design instead of the shared fallback template.
      // Best-effort: if generation fails or times out we publish anyway and
      // clinic-page.js serves the template (same as before this feature).
      let generatedPortalHtml = null;
      try {
        const servicesForAI = (Array.isArray(body.services) ? body.services : []).map((s) => ({
          name: s.name, category: s.category, description: s.description,
          duration_min: Number.isFinite(+s.duration_min) ? +s.duration_min : null,
          price_cents: Number.isFinite(+s.price_cents) ? +s.price_cents : null,
        })).filter((s) => s.name);
        const productsForAI = (Array.isArray(body.products) ? body.products : []).map((p) => ({
          name: p.name, category: p.category, description: p.description,
          // generatePortal reads products[].price as cents (it divides by 100).
          price: Number.isFinite(+p.price_cents) ? +p.price_cents : null,
        })).filter((p) => p.name);
        const orgContext = {
          name: org.name, slug: org.slug, specialty: org.specialty,
          location: org.location, contact_email: org.contact_email,
          logo_url: org.logo_url, theme: org.theme, brand: org.brand,
          services: servicesForAI, products: productsForAI,
        };
        const { html } = await generatePortal({
          org: orgContext,
          instruction: 'Generate this clinic\'s initial public patient portal from scratch using only the facts provided. Make it distinctive to this specific clinic and speciality — not a generic template.',
          timeoutMs: 45000,
        });
        generatedPortalHtml = sanitizePortalHtml(html);
      } catch (genErr) {
        console.error('[onboarding] portal generation failed (publishing with fallback template):', genErr?.message || genErr);
      }

      // Flip publish flags (+ persist the generated portal if we got one).
      const nowIso = new Date().toISOString();
      const pubPatch = {
        is_published: true,
        active: true,
        published_at: nowIso,
        onboarding_state: { ...(org.onboarding_state || {}), complete: true, published_at: nowIso },
      };
      if (generatedPortalHtml) {
        pubPatch.portal_html = generatedPortalHtml;
        pubPatch.portal_updated_at = nowIso;
      }
      const { data: updated, error: pubErr } = await admin
        .from('organizations')
        .update(pubPatch)
        .eq('id', org.id)
        .select()
        .single();
      if (pubErr) throw pubErr;

      // Best-effort owner notification (no-op if Resend not configured).
      try {
        const resendKey = process.env.RESEND_API_KEY;
        const notifyTo = process.env.OWNER_NOTIFY_EMAIL || process.env.CONTACT_TO_EMAIL || 'info@acuros.ca';
        if (resendKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
            body: JSON.stringify({
              from: 'Acuros Health <no-reply@acuros.ca>',
              to: [notifyTo],
              subject: `New clinic published: ${updated.name}`,
              html: `<p>A new clinic just published a portal on Acuros.</p>
                     <p><strong>${updated.name}</strong> — <a href="https://acuros.ca/c/${updated.slug}">acuros.ca/c/${updated.slug}</a></p>
                     <p>Owner: ${user.email}</p>`,
            }),
          });
        }
      } catch (_e) { /* swallow */ }

      return res.status(200).json({ org: updated, url: `/c/${updated.slug}` });
    }

    // ── POST ?action=delete ──────────────────────────────────────────
    // Permanently delete the owner's clinic and everything under it.
    // Guarded by a name-match confirmation so a stray/replayed POST can't
    // wipe a clinic without explicit intent.
    if (req.method === 'POST' && action === 'delete') {
      const org = await getOrCreateOwnerOrg(admin, user); // { create:false } — never resurrect
      if (!org) return res.status(404).json({ error: 'You have no clinic to delete.' });

      const confirmName = String((req.body && req.body.confirm_name) || '').trim();
      if (confirmName.toLowerCase() !== String(org.name || '').trim().toLowerCase()) {
        return res.status(400).json({ error: 'Type your clinic name exactly to confirm deletion.' });
      }

      // Most children of organizations are ON DELETE CASCADE; two references
      // are not and must be cleared first or the delete fails a FK check:
      //   • profiles.org_id       → NO ACTION (nullable): unlink joined patients.
      //   • reward_redemptions     → NO ACTION on BOTH organizations(org_id) and
      //                              clinic_rewards(reward_id). It's NOT NULL, so
      //                              the rows must be removed, not nulled — before
      //                              the clinic_rewards cascade tries to delete
      //                              the rewards they point at.
      const { error: unlinkErr } = await admin
        .from('profiles').update({ org_id: null }).eq('org_id', org.id);
      if (unlinkErr) throw unlinkErr;

      // Delete redemptions by org_id (satisfies the organizations FK) and, for
      // safety against any org_id/reward drift, also by this org's reward ids
      // (satisfies the clinic_rewards FK the cascade would otherwise trip on).
      const { error: rr1 } = await admin
        .from('reward_redemptions').delete().eq('org_id', org.id);
      if (rr1) throw rr1;
      const { data: rewardRows } = await admin
        .from('clinic_rewards').select('id').eq('org_id', org.id);
      const rewardIds = (rewardRows || []).map((r) => r.id);
      if (rewardIds.length) {
        const { error: rr2 } = await admin
          .from('reward_redemptions').delete().in('reward_id', rewardIds);
        if (rr2) throw rr2;
      }

      // Everything else cascades (services, products, bookings, memberships,
      // points, wallet_transactions, invites, availability, client_codes,
      // clinic_visits, org_members, clinic_rewards); orders.org_id → SET NULL.
      // The owner_id filter is a belt-and-braces ownership re-check.
      const { error: delErr } = await admin
        .from('organizations').delete().eq('id', org.id).eq('owner_id', user.id);
      if (delErr) throw delErr;

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[onboarding] error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
