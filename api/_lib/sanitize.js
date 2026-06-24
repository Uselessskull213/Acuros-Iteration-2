// api/_lib/sanitize.js — strip active/script content from owner-authored
// portal HTML before it is stored or served.
//
// Why: a clinic's portal_html is rendered verbatim on acuros.ca/c/<slug>,
// which shares the acuros.ca origin (and therefore the Supabase auth token
// in localStorage) with the rest of the site. Without this, a clinic owner
// could embed <script> that exfiltrates the session of any signed-in
// visitor who opens their page. RLS already restricts who can SET a portal
// to its own owner; this closes the "owner attacks their visitors" vector.
//
// This used to be a regex denylist, which is bypassable (mutation-XSS, SVG,
// odd quoting, entity tricks). It is now a real DOM-based allowlist sanitizer
// (DOMPurify on jsdom). Portals are CSS-driven marketing pages — we keep
// <style>/<svg>/fonts and all layout, and remove every JS-execution vector.
// A strict Content-Security-Policy on the /c/<slug> response (see
// api/clinic-page.js) backs this up as defense-in-depth.

import DOMPurify from 'isomorphic-dompurify';

// Keep the structural + styling head tags a portal needs (fonts, inlined CSS,
// SEO/meta), but never anything that can run JS or redirect the document.
const CONFIG = {
  WHOLE_DOCUMENT: true,                // portal_html is a full <!doctype html> document
  ADD_TAGS: ['link', 'meta', 'style', 'title', 'head', 'body', 'html'],
  ADD_ATTR: ['rel', 'href', 'media', 'sizes', 'as', 'crossorigin',
             'charset', 'name', 'content', 'property', 'type', 'target'],
  // Belt-and-suspenders: these are removed by default too, but be explicit.
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'noscript', 'template'],
  FORBID_ATTR: ['http-equiv'],         // blocks <meta http-equiv="refresh">
  ALLOW_DATA_ATTR: false,
  // Drop unknown protocols entirely (javascript:, vbscript:, data:text/html…).
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
};

export function sanitizePortalHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  let clean;
  try {
    clean = DOMPurify.sanitize(html, CONFIG);
  } catch (_e) {
    // Fail closed — never serve owner HTML we couldn't sanitize.
    return '';
  }
  if (typeof clean !== 'string') return '';

  // DOMPurify does not scrub CSS *inside* <style> blocks. These are inert in
  // modern browsers, but neutralize the historically-dangerous constructs
  // anyway (expression(), javascript:/vbscript: urls, @import, IE behaviors)
  // while leaving normal rules — including external background-image url() —
  // intact. The /c/<slug> CSP further constrains where styles can load from.
  clean = clean.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) =>
    open + css
      .replace(/expression\s*\(/gi, '(')
      .replace(/(?:javascript|vbscript)\s*:/gi, 'x:')
      .replace(/-moz-binding/gi, 'x-binding')
      .replace(/behavior\s*:/gi, 'x-behavior:')
      .replace(/@import\b[^;]*;?/gi, '') + close);

  // WHOLE_DOCUMENT output may omit the doctype; restore it so the portal
  // renders in standards mode rather than quirks mode.
  if (!/^\s*<!doctype/i.test(clean)) clean = '<!DOCTYPE html>\n' + clean;
  return clean;
}
