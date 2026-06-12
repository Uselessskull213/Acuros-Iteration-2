// api/_lib/sanitize.js — strip active/script content from owner-authored
// portal HTML before it is stored or served.
//
// Why: a clinic's portal_html is rendered verbatim on acuros.ca/c/<slug>,
// which shares the acuros.ca origin (and therefore the Supabase auth token
// in localStorage) with the rest of the site. Without this, a clinic owner
// could embed <script> that exfiltrates the session of any signed-in
// visitor who opens their page. RLS already restricts who can SET a
// portal to its own owner; this closes the remaining "owner attacks their
// own visitors" vector.
//
// This is a deliberately conservative regex pass — not a full HTML parser.
// It removes the script-execution vectors (script tags, inline event
// handlers, javascript: URIs, and external embed elements) while leaving
// layout/styling (<style>, <img>, <svg>, etc.) untouched. Portals are
// CSS-driven; losing small interaction scripts is an acceptable trade for
// not running arbitrary third-party JS on our auth origin.

export function sanitizePortalHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    // <script>…</script> (including malformed/unclosed at EOF)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    // inline event handlers: onclick="…" | 'onload=…' | onx=bare
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // javascript: / vbscript: / data:text/html URIs in href/src/action
    .replace(/(href|src|action|formaction)\s*=\s*"\s*(?:javascript|vbscript|data):[^"]*"/gi, '$1="#"')
    .replace(/(href|src|action|formaction)\s*=\s*'\s*(?:javascript|vbscript|data):[^']*'/gi, "$1='#'")
    // external code-execution embed vectors
    .replace(/<\/?(?:iframe|object|embed|base)\b[^>]*>/gi, '');
}
