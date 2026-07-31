// api/_lib/site-import.js — fetch a clinic's existing website and distil it
// into grounding material for the onboarding AI: page text, structured
// metadata (JSON-LD, OpenGraph), contact details, and a logo.
//
// Accuracy first: this module only COLLECTS what is on the site. The AI
// prompt that consumes it forbids inventing anything not present here.

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_CHARS = 400_000;   // per page, before stripping
const MAX_TEXT_PER_PAGE = 9_000;  // per page, after stripping
const MAX_TOTAL_TEXT = 26_000;    // across all pages
const MAX_EXTRA_PAGES = 6;
const MAX_LOGO_BYTES = 600_000;

// Links worth following on a clinic site, by href or anchor text.
const PAGE_HINTS = /service|treatment|procedure|product|shop|store|price|pricing|fee|about|contact|team|menu|offer/i;

class ImportError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'import_failed'; }
}

// ── URL safety ──────────────────────────────────────────────────────────
function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new ImportError('No URL provided.', 'bad_url');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch { throw new ImportError('That does not look like a valid URL.', 'bad_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImportError('Only http(s) sites are supported.', 'bad_url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new ImportError('Non-standard ports are not supported.', 'bad_url');
  assertPublicHost(u.hostname);
  u.hash = '';
  return u;
}

// SSRF guard: refuse loopback/private/link-local hosts and IP literals in
// private ranges. (We only ever fetch what the signed-in owner typed, but
// this endpoint must never become an internal-network proxy.)
function assertPublicHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.lan') || h === 'metadata.google.internal') {
    throw new ImportError('That host cannot be imported.', 'bad_url');
  }
  // IPv6 literal
  if (h.includes(':')) throw new ImportError('IP addresses cannot be imported - use your domain name.', 'bad_url');
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const priv = a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (priv) throw new ImportError('That host cannot be imported.', 'bad_url');
    throw new ImportError('IP addresses cannot be imported - use your domain name.', 'bad_url');
  }
  if (!h.includes('.')) throw new ImportError('That does not look like a public website.', 'bad_url');
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; AcurosImport/1.0; +https://acuros.ca)',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-CA,en;q=0.8,fr-CA;q=0.5',
      },
    });
    if (resp.status === 403 || resp.status === 406 || resp.status === 429) {
      throw new ImportError('That site blocks automated readers. Paste your services into the description box instead.', 'blocked');
    }
    if (!resp.ok) throw new ImportError(`The site responded with ${resp.status}.`, 'fetch_failed');
    const ct = String(resp.headers.get('content-type') || '');
    if (!/text\/html|application\/xhtml/i.test(ct)) throw new ImportError('That URL is not an HTML page.', 'fetch_failed');
    // Re-validate the post-redirect host so a redirect can't tunnel internal.
    assertPublicHost(new URL(resp.url || url).hostname);
    const html = (await resp.text()).slice(0, MAX_HTML_CHARS);
    return { html, finalUrl: resp.url || url };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e.name === 'AbortError') throw new ImportError('The site took too long to respond.', 'timeout');
    throw new ImportError('Could not reach that site. Check the address.', 'fetch_failed');
  } finally {
    clearTimeout(t);
  }
}

// ── HTML distillation (no dependencies, regex-based) ────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/gi, '’').replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”').replace(/&ldquo;/gi, '“')
    .replace(/&mdash;/gi, ' - ').replace(/&ndash;/gi, ' - ')
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 31 && c < 65536 ? String.fromCharCode(c) : ' '; });
}

function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim().slice(0, MAX_TEXT_PER_PAGE);
}

function getTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function getMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const c = tag.match(/content=["']([\s\S]*?)["']/i);
  return c ? decodeEntities(c[1]).trim() : '';
}

function getJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const flat = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of flat) {
        const type = String(node['@type'] || '');
        if (/organization|localbusiness|medical|clinic|dentist|physician|store|service|product|offer/i.test(type)) {
          out.push(node);
        }
      }
    } catch { /* malformed JSON-LD is common; skip */ }
  }
  return out.slice(0, 8);
}

function absolutize(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function pickExtraPages(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const seen = new Set();
  const picked = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && picked.length < MAX_EXTRA_PAGES) {
    const abs = absolutize(m[1], baseUrl);
    if (!abs || !abs.startsWith(origin)) continue;
    const path = abs.slice(origin.length).split('?')[0];
    if (!path || path === '/' || seen.has(path)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|mp4|zip|css|js)$/i.test(path)) continue;
    const anchorText = decodeEntities(m[2].replace(/<[^>]+>/g, ' '));
    if (PAGE_HINTS.test(path) || PAGE_HINTS.test(anchorText)) {
      seen.add(path);
      picked.push(abs);
    }
  }
  return picked;
}

// ── Logo discovery ──────────────────────────────────────────────────────
function findLogoCandidates(html, baseUrl) {
  const cands = [];
  // <img> whose attributes say "logo" — the strongest signal.
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) && cands.length < 12) {
    const tag = m[0];
    if (!/logo/i.test(tag)) continue;
    const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1];
    if (src && !/^data:/i.test(src)) {
      const abs = absolutize(src, baseUrl);
      if (abs) cands.push(abs);
    }
  }
  // apple-touch-icon (usually a clean square mark), then og:image, then icons.
  const linkRe = /<link\b[^>]*>/gi;
  const icons = [];
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/icon/i.test(rel)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || /^data:/i.test(href)) continue;
    const abs = absolutize(href, baseUrl);
    if (!abs) continue;
    if (/apple-touch/i.test(rel)) icons.unshift(abs); else icons.push(abs);
  }
  cands.push(...icons);
  const og = getMeta(html, 'og:image');
  if (og) { const abs = absolutize(og, baseUrl); if (abs) cands.push(abs); }
  return [...new Set(cands)];
}

async function fetchLogo(candidates) {
  for (const url of candidates.slice(0, 5)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; AcurosImport/1.0)' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const ct = String(resp.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\//.test(ct) || ct === 'image/gif') continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length || buf.length > MAX_LOGO_BYTES) continue;
      return { url, contentType: ct, dataUrl: `data:${ct};base64,${buf.toString('base64')}` };
    } catch { /* try next candidate */ }
  }
  return null;
}

// ── Contact scraping ────────────────────────────────────────────────────
function findContacts(html) {
  const email = (html.match(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i) || [])[1] || '';
  const phone = (html.match(/tel:([+0-9()\-. ]{7,20})/i) || [])[1] || '';
  return { email: email.trim(), phone: phone.trim() };
}

// ── Main entry ──────────────────────────────────────────────────────────
export async function crawlSite(inputUrl) {
  const u = normalizeUrl(inputUrl);
  const { html: homeHtml, finalUrl } = await fetchHtml(u.toString());

  const pages = [{ url: finalUrl, title: getTitle(homeHtml), text: htmlToText(homeHtml) }];
  const extraUrls = pickExtraPages(homeHtml, finalUrl);
  const extras = await Promise.allSettled(extraUrls.map((x) => fetchHtml(x)));
  for (let i = 0; i < extras.length; i++) {
    if (extras[i].status !== 'fulfilled') continue;
    const { html } = extras[i].value;
    pages.push({ url: extraUrls[i], title: getTitle(html), text: htmlToText(html) });
  }

  // Assemble a bounded grounding document, homepage first.
  let budget = MAX_TOTAL_TEXT;
  const sections = [];
  for (const p of pages) {
    if (budget <= 400) break;
    const chunk = p.text.slice(0, Math.min(p.text.length, budget));
    budget -= chunk.length;
    sections.push(`=== PAGE: ${p.url}${p.title ? ` ("${p.title}")` : ''} ===\n${chunk}`);
  }

  const jsonld = getJsonLd(homeHtml);
  const contacts = findContacts(homeHtml);
  const meta = {
    siteName: getMeta(homeHtml, 'og:site_name') || '',
    title: pages[0].title,
    description: getMeta(homeHtml, 'description') || getMeta(homeHtml, 'og:description') || '',
    email: contacts.email,
    phone: contacts.phone,
  };
  if (jsonld.length) {
    sections.unshift('=== STRUCTURED DATA (schema.org, from the site itself) ===\n' +
      JSON.stringify(jsonld).slice(0, 3000));
  }

  const logo = await fetchLogo(findLogoCandidates(homeHtml, finalUrl));

  return {
    finalUrl,
    meta,
    text: sections.join('\n\n'),
    pagesCrawled: pages.map((p) => p.url),
    logo,
  };
}

export { ImportError };
