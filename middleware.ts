import { rewrite } from '@vercel/functions';

// Serve the developer console at the BARE dev.acuros.ca/ (no /developer suffix).
//
// vercel.json `rewrites` are "afterFiles" — they don't fire when a static file
// already matches the path, and `/` maps to index.html, so a host rewrite there
// is shadowed. Routing middleware runs BEFORE the filesystem, so it can rewrite
// dev.acuros.ca/ -> /developer internally while keeping the URL bare.
//
// Scoped to "/" only (matcher) and wrapped so any failure falls through to the
// normal homepage — this must never be able to take down acuros.ca/.
export const config = { matcher: '/' };

export default function middleware(request: Request) {
  try {
    const host = (request.headers.get('host') || '').toLowerCase();
    if (host === 'dev.acuros.ca') {
      return rewrite(new URL('/developer', request.url));
    }
  } catch (_e) {
    // fall through to normal serving
  }
  // no return -> continue to the static page (homepage on acuros.ca/www)
}
