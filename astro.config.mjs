// @ts-check
import { defineConfig } from 'astro/config';

// Architecture: Astro builds the 12 pages as a STATIC site (dist/). The
// serverless backend stays in the root `api/` directory as plain Vercel
// functions — Vercel auto-detects `/api/*` alongside a static framework, so
// the existing endpoints (chat, bookings, onboarding, portal-edit, clinic-page,
// sitemap, …) keep their exact runtime contract with zero rewrite. Dynamic
// routes (/c/:slug, /sitemap.xml) are wired through vercel.json rewrites to
// those functions, exactly as before. No adapter → Vercel uses its classic
// "static build + /api functions" pipeline.
export default defineConfig({
  site: 'https://acuros.ca',
  output: 'static',
  // Keep emitted markup close to source so ported pages stay byte-faithful to
  // the original static HTML (whitespace collapse is cosmetic but makes visual
  // diffing against prod easier).
  compressHTML: false,
});
