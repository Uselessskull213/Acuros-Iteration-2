// One-time Astro -> static HTML port for the application pages.
// The .astro sources are plain HTML documents (no frontmatter, no templating);
// the only Astro-ism is the `is:inline` script/style attribute, which this
// strips. Output goes to public/<name>.html, served at /<name> by Vercel
// cleanUrls in production and by next.config dev rewrites locally.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGES = [
  'ai-assistant',
  'bookings',
  'dashboard',
  'developer',
  'editor',
  'onboarding',
  'patient-portal',
  'settings',
  'shop',
];

for (const name of PAGES) {
  const src = path.join(ROOT, 'src', 'pages', `${name}.astro`);
  const html = fs.readFileSync(src, 'utf8').replace(/\s+is:inline(?=[\s>])/g, '');
  if (/(^---\r?\n)|set:html|Astro\./.test(html)) {
    throw new Error(`${name}.astro contains Astro templating — manual port needed`);
  }
  fs.writeFileSync(path.join(ROOT, 'public', `${name}.html`), html);
  console.log(`ported ${name}.astro -> public/${name}.html`);
}
