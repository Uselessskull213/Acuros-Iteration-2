// api/portal-edit.js — Claude-backed portal editor (Vercel Serverless).
//
// POST body:
//   { instruction: string,
//     currentHtml: string | null,
//     history: [{role:'user'|'assistant', content:string}],
//     org: { name, slug, specialty?, location?, brand?, theme?,
//            services?: [{name, description, price_cents, duration_min, category}],
//            products?: [{name, price, description, image_url, category}] } }
//
// Response:
//   200 { html: string, message: string, modelUsed: string }
//
// Auth: Bearer Supabase access token, caller must be clinic_owner or admin.
//
// The model is told to return a single complete HTML document on every
// turn so the live preview iframe can just replace its srcdoc with the
// response. Partial diffs are tempting but they explode in complexity for
// little win in a small-team product.

import { checkRateLimit } from './_lib/rate-limit.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

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

// Pull the org row + role check in one DB round trip.
async function loadOwnerOrg(admin, user) {
  const [{ data: profile }, { data: org }] = await Promise.all([
    admin.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    admin.from('organizations')
      .select('id, name, slug, specialty, location, theme, brand, portal_html, contact_email, logo_url')
      .eq('owner_id', user.id)
      .maybeSingle(),
  ]);
  return { profile, org };
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

// Pull the first complete <!doctype html …>…</html> block out of model
// output. Claude almost always wraps in ```html fences when asked for
// full documents; tolerate that too.
function extractHtml(text) {
  if (!text) return '';
  const fence = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : text;
  const doc = /<!doctype[\s\S]*?<\/html>/i.exec(candidate);
  if (doc) return doc[0].trim();
  // No doctype but looks like HTML body? Wrap minimally.
  if (/<html[\s\S]*?<\/html>/i.test(candidate)) return candidate.trim();
  return '';
}

// The non-HTML portion of the model output (assistant commentary).
function extractMessage(text) {
  if (!text) return '';
  const withoutFence = text.replace(/```(?:html)?[\s\S]*?```/gi, '').trim();
  const withoutDoc   = withoutFence.replace(/<!doctype[\s\S]*?<\/html>/gi, '').trim();
  return (withoutDoc || 'Updated the portal.').slice(0, 1200);
}

function buildSystemPrompt(org) {
  const services = Array.isArray(org?.services) ? org.services.slice(0, 30) : [];
  const products = Array.isArray(org?.products) ? org.products.slice(0, 30) : [];
  const accent = (org?.theme?.accent && /^#[0-9a-fA-F]{6}$/.test(org.theme.accent)) ? org.theme.accent : '#c9a96e';
  return [
`You are the in-app portal designer for Acuros Health. You are editing a clinic's public patient portal page. The clinic owner gives you instructions in a chat sidebar; you respond by REWRITING the entire portal as one complete, self-contained HTML document on EVERY turn.`,
``,
`CRITICAL OUTPUT FORMAT`,
`• Respond with ONE complete <!doctype html>…</html> document inside a single \`\`\`html fenced code block.`,
`• Before or after the code block, write at most one short sentence describing what changed (no headers, no bullet lists).`,
`• Never return partial HTML or diffs. Always emit the full document.`,
`• Never include external scripts other than Google Fonts and Supabase JS CDN. No analytics, no trackers, no third-party iframes.`,
`• Inline all CSS inside <style> in <head>. No external stylesheets.`,
`• Use only static HTML + CSS. Vanilla JS is allowed for tiny interactions (mobile nav, scroll reveal) but no frameworks.`,
``,
`VISUAL DESIGN — premium, distinctive, anti-generic`,
`This is not a Bootstrap landing page. Aim for the polish of a high-end agency build:`,
`• Editorial typography: pair a refined display serif (Cormorant Garamond, Fraunces, or Playfair Display) with a quiet humanist sans (DM Sans, Inter, or Söhne). Display headings 4-7rem, light weight (200-300), generous tracking on labels.`,
`• Asymmetric layouts: 12-col grids, off-center hero copy, hairline rules, oversized section labels rotated or vertically set.`,
`• Color: respect the clinic accent (${accent}) and use restrained warm-neutral or deep dark palettes. Avoid stock blue + white. Pull from cream, bone, charcoal, espresso.`,
`• Texture & depth: layered radial-gradient orbs, subtle film grain (SVG noise), thin 1px borders, never drop shadows. Glassmorphism only when it serves the content (cards over a hero image).`,
`• Motion: tasteful — fade-up on scroll via IntersectionObserver, hover micro-interactions, marquee strips for credentials or services. No bouncing, no auto-rotating carousels.`,
`• Imagery: when no image is supplied, use carefully chosen Unsplash photos (unsplash.com/photos/<id>) of clinics, hands, plants, architecture — never stock smiling people. Apply filter:saturate(.5) brightness(.55) for cohesion.`,
`• Section variety: a portal should mix grid layouts, full-bleed image breaks, editorial pull-quotes, services list, and a contact panel. Do NOT repeat the same card grid four times.`,
``,
`ACCESSIBILITY & RESPONSIVENESS`,
`• Mobile-first: every layout collapses cleanly under 720px.`,
`• Color contrast ≥ 4.5:1 for body text.`,
`• All <img> have alt text. <nav> + landmark roles in place.`,
``,
`CONTENT — STRICT ANTI-HALLUCINATION`,
`Use ONLY the clinic facts I'm about to give you. Do NOT invent doctor names, prices, hours, addresses, awards, or "since 1987". If the owner hasn't supplied a fact, omit it gracefully or leave a clear placeholder like "Hours coming soon." For service prices and durations, use the exact data provided.`,
``,
`Clinic facts:`,
`  name: ${org?.name || '(not set)'}`,
`  slug: /c/${org?.slug || '(not set)'}`,
`  specialty: ${org?.specialty || '(not set)'}`,
`  location: ${org?.location || '(not set)'}`,
`  contact email: ${org?.contact_email || '(not set)'}`,
`  tagline: ${org?.brand?.tagline || '(not set)'}`,
`  brand voice: ${org?.brand?.voice || '(not set)'}`,
`  phone: ${org?.brand?.phone || '(not set)'}`,
`  website: ${org?.brand?.website || '(not set)'}`,
`  logo url: ${org?.logo_url || '(not set)'}`,
`  hero image url: ${org?.theme?.heroImage || '(not set)'}`,
`  accent color: ${accent}`,
``,
services.length ? `Services (${services.length}):\n${services.map(s => `  • ${s.name}${s.category?` [${s.category}]`:''}${Number.isFinite(+s.duration_min)?` — ${s.duration_min} min`:''}${Number.isFinite(+s.price_cents)&&+s.price_cents>0?` — $${Math.round(+s.price_cents/100)}`:''}${s.description?` — ${String(s.description).slice(0,140)}`:''}`).join('\n')}` : `Services: none listed yet.`,
``,
products.length ? `Products (${products.length}):\n${products.map(p => `  • ${p.name}${p.category?` [${p.category}]`:''}${Number.isFinite(+p.price)&&+p.price>0?` — $${Math.round(+p.price/100)}`:''}${p.description?` — ${String(p.description).slice(0,140)}`:''}`).join('\n')}` : ``,
``,
`REQUIRED PORTAL ELEMENTS (must be present in every output)`,
`• A sticky top nav with the clinic name and a "Powered by Acuros Health" mark linking to "/".`,
`• A "Book a visit" CTA in the nav linking to /bookings?clinic=${org?.slug || ''}.`,
`• A footer with the year, the clinic name, "Powered by Acuros", and links to /privacy and /terms.`,
`• If the clinic has services, include a services section. If it has products, include a shop teaser linking to /shop?clinic=${org?.slug || ''}.`,
``,
`When the owner asks for changes that contradict these rules (e.g. "remove the Acuros footer"), comply with the spirit but keep the legally-required attribution. If they ask for content you don't have facts for, say so in your one-sentence comment and leave a placeholder.`,
  ].filter(Boolean).join('\n');
}

function buildInitialUserMessage(instruction, currentHtml) {
  if (currentHtml) {
    return `Current portal HTML:\n\`\`\`html\n${currentHtml.slice(0, MAX_HTML_CHARS)}\n\`\`\`\n\nOwner instruction: ${instruction}\n\nReturn the complete updated HTML document.`;
  }
  return `There is no portal HTML yet — generate it from scratch.\n\nOwner instruction: ${instruction}\n\nReturn the complete HTML document.`;
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
  const { profile, org } = await loadOwnerOrg(admin, user);
  if (!profile || (profile.role !== 'clinic_owner' && profile.role !== 'admin')) {
    return res.status(403).json({ error: 'Only clinic owners can edit a portal.' });
  }
  if (!org) {
    return res.status(404).json({ error: 'No organization found — finish onboarding first.' });
  }

  // The "live" org context can include services/products from the client
  // for prompt grounding; fall back to nothing if absent.
  const orgContext = {
    ...org,
    services: Array.isArray(body.org?.services) ? body.org.services : [],
    products: Array.isArray(body.org?.products) ? body.org.products : [],
  };

  const systemPrompt = buildSystemPrompt(orgContext);
  const messages = [
    ...clientHistory,
    { role: 'user', content: buildInitialUserMessage(instruction, currentHtml || org.portal_html) },
  ];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const model = process.env.ANTHROPIC_PORTAL_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: systemPrompt,
        messages,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[portal-edit] anthropic error:', err);
      return res.status(502).json({ error: err?.error?.message || `Anthropic ${resp.status}` });
    }
    const data = await resp.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    const html = extractHtml(text);
    if (!html) {
      return res.status(502).json({
        error: 'AI did not return a complete HTML document. Try rephrasing your instruction.',
        rawSnippet: text.slice(0, 500),
      });
    }
    const message = extractMessage(text);
    return res.status(200).json({ html, message, modelUsed: model });
  } catch (err) {
    console.error('[portal-edit] error:', err);
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI took too long. Try a smaller change.' });
    }
    return res.status(500).json({ error: 'Failed to reach Anthropic.' });
  } finally {
    clearTimeout(timeout);
  }
}
