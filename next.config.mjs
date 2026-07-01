// Architecture: Next.js builds the marketing pages (/, /privacy, /terms) as a
// STATIC export (out/). The serverless backend stays in the root `api/`
// directory as plain Vercel functions — vercel.json pins framework:null so
// Vercel keeps its classic "static build + /api functions" pipeline: the
// existing endpoints, security headers, rewrites (/c/:slug, /sitemap.xml) and
// routing middleware keep their exact runtime contract with zero rewrite.
//
// The application pages (dashboard, patient-portal, editor, onboarding, …)
// are served byte-faithful as static HTML from public/ — Vercel `cleanUrls`
// maps /dashboard -> dashboard.html in production, and the dev-only rewrites
// below do the same for `next dev`. (With output:'export' Next ignores
// rewrites at build time, which is exactly what we want.)
const legacyPages = [
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  async rewrites() {
    // dev-only: static export ignores this in `next build`
    return legacyPages.map((p) => ({ source: `/${p}`, destination: `/${p}.html` }));
  },
};

export default nextConfig;
