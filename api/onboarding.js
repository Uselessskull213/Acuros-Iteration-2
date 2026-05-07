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
  const { data: existing, error: readErr } = await admin
    .from('organizations')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle();
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

// Try Anthropic Claude Sonnet first (better for design tasks), fall back
// to Google Gemini if no Anthropic key is configured. Both go through a
// strict JSON-mode contract so the wizard can rely on the schema.
async function callAIJson({ kind, text, clinicName }) {
  const conf = EXTRACT_SCHEMAS[kind];
  if (!conf) throw new Error('Unsupported extract kind');

  const systemPrompt = [
    `You are the onboarding designer for Acuros Health, a Canadian clinic platform.`,
    `Tone: measured medical, premium-but-restrained. Never use breathless marketing copy or em-dashes. Never invent statistics.`,
    `${conf.description}`,
    clinicName ? `Clinic context: "${clinicName}".` : '',
  ].filter(Boolean).join('\n\n');

  const userPrompt = `Owner-provided text:\n"""${text}"""\n\nReturn ONLY a JSON object that conforms to the agreed schema. No prose, no markdown.`;

  // Prefer Anthropic if available. Their JSON-mode behaviour is sturdier
  // for nested schemas and the Sonnet model writes better design copy.
  if (process.env.ANTHROPIC_API_KEY) {
    return await callAnthropicJson({ systemPrompt, userPrompt, schema: conf.schema });
  }
  if (process.env.GEMINI_API_KEY) {
    return await callGeminiJson({ systemPrompt, userPrompt, schema: conf.schema });
  }
  throw new Error('No AI provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).');
}

async function callAnthropicJson({ systemPrompt, userPrompt, schema }) {
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
        max_tokens: 2048,
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

async function callGeminiJson({ systemPrompt, userPrompt, schema }) {
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
            maxOutputTokens: 2048,
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
  // Standard CORS + security headers.
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      const out = await callAIJson({ kind, text, clinicName: org?.name });

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
      if (!org.slug) return res.status(400).json({ error: 'Pick a slug before publishing.' });
      if (!org.name || org.name.length < 2) return res.status(400).json({ error: 'Clinic name is required.' });

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

      // Flip publish flags
      const { data: updated, error: pubErr } = await admin
        .from('organizations')
        .update({
          is_published: true,
          active: true,
          published_at: new Date().toISOString(),
          onboarding_state: { ...(org.onboarding_state || {}), complete: true, published_at: new Date().toISOString() },
        })
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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[onboarding] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
}
