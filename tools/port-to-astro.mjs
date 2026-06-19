// tools/port-to-astro.mjs
//
// One-shot, byte-faithful porter: converts the legacy root *.html pages into
// src/pages/*.astro. We deliberately do NOT restructure markup here — the goal
// is pixel-identical output. We only apply the three transforms Astro requires
// to treat a full hand-written HTML document correctly:
//
//   1. <script ...>  ->  <script is:inline ...>   (keep inline JS in global
//      scope and in document order; otherwise Astro bundles it as a module and
//      every onclick= / window.fn handler breaks)
//   2. <style ...>   ->  <style is:inline ...>     (emit CSS verbatim; is:global
//      still runs the block through PostCSS, which rejects browser-tolerated
//      CSS and can rewrite output — is:inline leaves it byte-identical)
//   3. Literal { and } OUTSIDE <script>/<style>  ->  &#123; / &#125;
//      (Astro parses { } as JS expressions in template HTML; the numeric
//      entities decode to the same characters in the browser, so rendering and
//      event-handler attributes are unchanged.)
//
// Script/style block *contents* are left completely untouched.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// legacy file -> Astro page path (mirrors the old vercel.json rewrites)
const MAP = {
  'index.html':       'src/pages/index.astro',
  'ai.html':          'src/pages/ai-assistant.astro',
  'patient.html':     'src/pages/patient-portal.astro',
  'shop.html':        'src/pages/shop.astro',
  'bookings.html':    'src/pages/bookings.astro',
  'privacy.html':     'src/pages/privacy.astro',
  'terms.html':       'src/pages/terms.astro',
  'settings.html':    'src/pages/settings.astro',
  'onboarding.html':  'src/pages/onboarding.astro',
  'dashboard.html':   'src/pages/dashboard.astro',
  'editor.html':      'src/pages/editor.astro',
  'developer.html':   'src/pages/developer.astro',
};

// Add an attribute to the opening tag of every <script>/<style> unless it is
// already present. Handles `<script>`, `<script src=...>`, `<script async ...>`.
function addAttr(html, tag, attr) {
  // <tag> with no attributes
  const bare = new RegExp(`<${tag}>`, 'gi');
  html = html.replace(bare, `<${tag} ${attr}>`);
  // <tag ...> with attributes (but not already containing the attr)
  const withAttrs = new RegExp(`<${tag}(\\s+)(?!${attr}\\b)`, 'gi');
  html = html.replace(withAttrs, `<${tag} ${attr}$1`);
  return html;
}

// Encode braces only in the segments that are NOT inside a <script>/<style>.
function encodeBracesOutsideRaw(html) {
  const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let out = '';
  let last = 0;
  let m;
  let encoded = 0;
  while ((m = blockRe.exec(html)) !== null) {
    const gap = html.slice(last, m.index);
    const before = gap.length;
    const enc = gap.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    encoded += (enc.length - before) / 4; // each replacement adds 4 chars
    out += enc;
    out += m[0]; // raw block, untouched
    last = blockRe.lastIndex;
  }
  const tailGap = html.slice(last);
  out += tailGap.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  return { out, encoded: Math.round(encoded) };
}

let total = 0;
for (const [src, dest] of Object.entries(MAP)) {
  let html;
  try {
    html = readFileSync(join(root, src), 'utf8');
  } catch {
    console.log(`SKIP (missing): ${src}`);
    continue;
  }
  html = addAttr(html, 'script', 'is:inline');
  html = addAttr(html, 'style', 'is:inline');
  const { out, encoded } = encodeBracesOutsideRaw(html);
  const destAbs = join(root, dest);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, out, 'utf8');
  console.log(`${src.padEnd(18)} -> ${dest.padEnd(34)} (${out.length} bytes, ${encoded} braces encoded)`);
  total++;
}
console.log(`\nPorted ${total} pages.`);
