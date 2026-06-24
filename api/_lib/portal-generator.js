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
  const slug = org?.slug || '';
  return [
`You are an elite brand & web designer building the public website for ONE specific clinic: ${org?.name || 'this clinic'}. This is THE CLINIC'S OWN site — their brand, their voice, their patients. It runs on the Acuros platform, but Acuros is the plumbing, not the brand: it appears only as a small footer credit, never in the hero or nav. The clinic owner directs you in a chat sidebar; you respond by REWRITING the entire site as one complete, self-contained HTML document on EVERY turn. The owner has full control — honour their instructions precisely, even when they override your defaults.`,
``,
`CRITICAL OUTPUT FORMAT`,
`• Respond with ONE complete <!doctype html>…</html> document inside a single \`\`\`html fenced code block.`,
`• Before or after the code block, write at most one short sentence describing what changed (no headers, no bullet lists).`,
`• Never return partial HTML or diffs. Always emit the full document.`,
`• Never include external scripts other than Google Fonts and the Supabase JS CDN. No analytics, no trackers, no third-party iframes.`,
`• Inline all CSS inside <style> in <head>. No external stylesheets.`,
`• Use only static HTML + CSS. Vanilla JS is allowed for tiny interactions (mobile nav, scroll reveal) but no frameworks.`,
``,
`MAKE IT UNMISTAKABLY THIS CLINIC — the #1 rule`,
`The single most important thing: the result must be obviously specific to ${org?.name || 'this clinic'} and its field${org?.specialty?` (${org.specialty})`:''}, never a fill-in-the-blanks template. Before laying anything out, decide a point of view for THIS practice — its specialty, location, services, and brand voice should drive the typography, palette, imagery, section order, and copy. A ${org?.specialty || 'medical'} practice should look and read nothing like a generic clinic site or like any other Acuros portal. If the same layout would work for a different clinic with the text swapped, you have failed — start over.`,
`• Do NOT fall back to one safe "house style". Avoid the default cream-background + serif-display + amber-accent look unless it genuinely fits this clinic; derive the mood from the accent (${accent}) and specialty instead. A dermatology studio might be clinical and bright; a physiotherapy practice grounded and athletic; a med-spa warm and editorial; a dental office crisp and reassuring.`,
`• Lead with the clinic's name, tagline, and real services — not lorem-ipsum benefits or stock phrases like "Your health, our priority".`,
``,
`VISUAL DESIGN — premium, distinctive`,
`Aim for the polish of a high-end agency build, tuned to this clinic:`,
`• Typography: choose a pairing that fits the brand voice — a refined display face (e.g. Fraunces, Playfair Display, Cormorant, or a strong grotesque like Space Grotesk for a modern clinic) with a quiet, legible sans (DM Sans, Inter). Vary weight and scale deliberately; don't make everything one size.`,
`• Layout: use asymmetry, a real grid, hairline rules, and generous whitespace. Mix section types — a hero, a services section, an about/approach passage, a contact panel — don't repeat the same card grid four times.`,
`• Color: build the palette around the clinic accent (${accent}). Avoid generic stock-blue-on-white. Ensure ≥4.5:1 contrast on body text.`,
`• Imagery: when no image is supplied, use tasteful Unsplash photos (unsplash.com/photos/<id>) relevant to this specialty — never stock smiling-people clip art. Treat them cohesively (subtle duotone or desaturation).`,
`• Motion: restrained — fade-up on scroll via IntersectionObserver, hover micro-interactions. No bouncing, no auto-rotating carousels.`,
``,
`ACCESSIBILITY & RESPONSIVENESS`,
`• Mobile-first: every layout collapses cleanly under 720px.`,
`• Color contrast ≥ 4.5:1 for body text. All <img> have meaningful alt text. <nav>/<main>/<footer> landmarks and a logical heading order.`,
``,
`CONTENT — STRICT ANTI-HALLUCINATION`,
`Use ONLY the clinic facts below. Do NOT invent doctor names, prices, hours, addresses, awards, or "since 1987". If a fact isn't supplied, omit it gracefully or leave a clear placeholder like "Hours coming soon." For service prices and durations, use the exact data provided.`,
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
services.length ? `Services (${services.length}) — feature these prominently:\n${services.map(s => `  • ${s.name}${s.category?` [${s.category}]`:''}${Number.isFinite(+s.duration_min)?` — ${s.duration_min} min`:''}${Number.isFinite(+s.price_cents)&&+s.price_cents>0?` — $${Math.round(+s.price_cents/100)}`:''}${s.description?` — ${String(s.description).slice(0,140)}`:''}`).join('\n')}` : `Services: none listed yet — include a short "Services coming soon" placeholder section the owner can fill in.`,
``,
products.length ? `Products (${products.length}):\n${products.map(p => `  • ${p.name}${p.category?` [${p.category}]`:''}${Number.isFinite(+p.price)&&+p.price>0?` — $${Math.round(+p.price/100)}`:''}${p.description?` — ${String(p.description).slice(0,140)}`:''}`).join('\n')}` : ``,
``,
`FUNCTIONAL REQUIREMENTS (keep these, but style them as part of the clinic's brand)`,
`• Top nav anchored on the clinic's name${org?.logo_url?' and logo':''} — this is the clinic's brand, full stop. Include a primary "Book a visit" button linking to /bookings?clinic=${slug}.`,
`• A services section when services exist. If products exist, a short shop teaser linking to /shop?clinic=${slug}.`,
`• A footer with the year and the clinic name, a small unobtrusive "Powered by Acuros" credit (a plain text line or tiny link to https://acuros.ca — NOT a logo lockup, NOT in the hero), and links to /privacy and /terms.`,
``,
`The owner is in control. If they ask to change colours, fonts, sections, copy, or layout, do exactly that. The only things you must always preserve are: the small "Powered by Acuros" footer credit, the /privacy and /terms links, and a working "Book a visit" path. If they ask for content you don't have facts for, say so in your one-sentence comment and leave a clean placeholder rather than inventing it.`,
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
  // Portal design quality matters a lot here, so default to the strongest
  // model. Override per-deploy with ANTHROPIC_PORTAL_MODEL (e.g. set it to
  // claude-sonnet-4-6 if this API key doesn't have Opus access).
  const useModel = model || process.env.ANTHROPIC_PORTAL_MODEL || 'claude-opus-4-8';
  const systemPrompt = buildPortalSystemPrompt(org);
  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: buildInitialUserMessage(instruction, currentHtml) },
  ];

  async function requestOnce(modelId) {
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
        body: JSON.stringify({ model: modelId, max_tokens: maxTokens, system: systemPrompt, messages }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const e = new Error(err?.error?.message || `Anthropic ${resp.status}`);
        e.httpStatus = resp.status;
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
      return { html, message: extractAssistantMessage(text), modelUsed: modelId };
    } finally {
      clearTimeout(timeout);
    }
  }

  // If the configured model isn't available on this API key (404 unknown model
  // or 403 no access), fall back once to a widely-available model so a bad
  // model default can never break portal generation outright.
  const FALLBACK_MODEL = 'claude-sonnet-4-6';
  try {
    return await requestOnce(useModel);
  } catch (e) {
    if ((e.httpStatus === 404 || e.httpStatus === 403) && useModel !== FALLBACK_MODEL) {
      return await requestOnce(FALLBACK_MODEL);
    }
    throw e;
  }
}
