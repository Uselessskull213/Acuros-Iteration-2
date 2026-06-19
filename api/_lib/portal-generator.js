// api/_lib/portal-generator.js — shared Claude portal-design engine.
//
// Single source of truth for "turn clinic facts into a complete, distinctive
// patient-portal HTML document." Used by:
//   • api/portal-edit.js   — interactive editor (owner chats, iterates)
//   • api/onboarding.js     — publish step generates the FIRST portal so every
//                             clinic launches with a bespoke design instead of
//                             the shared fallback template.
//
// Keeping this in one place is what fixes the "generic, uniform, just-inserting-
// text" problem: the same well-grounded prompt + real services/products/brand
// context drives both entry points.

// Canonical brand accent (light-mode gold). Onboarding's palette default and
// the page CSS tokens both use this; the server fallbacks now match it so a
// clinic that never picks a colour renders the same accent everywhere.
export const DEFAULT_ACCENT = '#c9922a';

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export function buildPortalSystemPrompt(org) {
  const services = Array.isArray(org?.services) ? org.services.slice(0, 30) : [];
  const products = Array.isArray(org?.products) ? org.products.slice(0, 30) : [];
  const accent = (org?.theme?.accent && ACCENT_RE.test(org.theme.accent)) ? org.theme.accent : DEFAULT_ACCENT;
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
`• Make the design specific to THIS clinic and its speciality — the layout, copy, and mood should read differently for a dermatology studio than for a physiotherapy practice. Never produce a layout that would work unchanged for any other clinic.`,
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

export function buildInitialUserMessage(instruction, currentHtml, maxHtmlChars = 60000) {
  if (currentHtml) {
    return `Current portal HTML:\n\`\`\`html\n${currentHtml.slice(0, maxHtmlChars)}\n\`\`\`\n\nOwner instruction: ${instruction}\n\nReturn the complete updated HTML document.`;
  }
  return `There is no portal HTML yet — generate it from scratch.\n\nOwner instruction: ${instruction}\n\nReturn the complete HTML document.`;
}

// Pull the first complete <!doctype html …>…</html> block out of model output.
// Claude almost always wraps in ```html fences when asked for full documents;
// tolerate that too.
export function extractHtmlDoc(text) {
  if (!text) return '';
  const fence = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : text;
  const doc = /<!doctype[\s\S]*?<\/html>/i.exec(candidate);
  if (doc) return doc[0].trim();
  if (/<html[\s\S]*?<\/html>/i.test(candidate)) return candidate.trim();
  return '';
}

// The non-HTML portion of the model output (assistant commentary).
export function extractAssistantMessage(text) {
  if (!text) return '';
  const withoutFence = text.replace(/```(?:html)?[\s\S]*?```/gi, '').trim();
  const withoutDoc   = withoutFence.replace(/<!doctype[\s\S]*?<\/html>/gi, '').trim();
  return (withoutDoc || 'Updated the portal.').slice(0, 1200);
}

// Call Claude once and return { html, message, modelUsed }. Throws on transport
// errors, non-2xx responses, or when no complete HTML document comes back.
// Errors carry .status (HTTP status to surface) and, for empty output, a
// .rawSnippet for debugging.
export async function generatePortal({
  org,
  instruction,
  currentHtml = null,
  history = [],
  model,
  timeoutMs = 55000,
  maxTokens = 16000,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const e = new Error('ANTHROPIC_API_KEY not configured on the server.');
    e.status = 500;
    throw e;
  }
  const useModel = model || process.env.ANTHROPIC_PORTAL_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const systemPrompt = buildPortalSystemPrompt(org);
  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: buildInitialUserMessage(instruction, currentHtml) },
  ];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: useModel, max_tokens: maxTokens, system: systemPrompt, messages }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(err?.error?.message || `Anthropic ${resp.status}`);
      e.status = 502;
      throw e;
    }
    const data = await resp.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    const html = extractHtmlDoc(text);
    if (!html) {
      const e = new Error('AI did not return a complete HTML document.');
      e.status = 502;
      e.rawSnippet = text.slice(0, 500);
      throw e;
    }
    return { html, message: extractAssistantMessage(text), modelUsed: useModel };
  } finally {
    clearTimeout(timeout);
  }
}
