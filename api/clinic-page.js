// api/clinic-page.js — server-rendered shell for /c/<slug>
//
// Why a serverless function instead of a static HTML file:
//   • Each clinic gets its own <title>, meta description, og:image,
//     canonical, and JSON-LD LocalBusiness schema — pre-injected before
//     the JS hydrates. That's what makes thousands of clinics indexable
//     by Google from a single template.
//   • Slug → org row lookup at the edge so 404s for unknown clinics
//     return immediately with proper status (good for SEO too).
//
// The page hydrates services/products/booking using the public anon
// key — we explicitly do *not* expose a service-role key here.

import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const PUBLISHABLE_KEY = 'sb_publishable_ywcyXTqGzRTik8YJfTTHiw_B-pmj2w-';
const SUPABASE_URL    = 'https://pyexkdoupqzbnrybiubo.supabase.co';

const FALLBACK_HERO = 'https://acuros.ca/hero-bg.jpg';

function escapeHtml(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
function escapeAttr(s){ return escapeHtml(s); }

// Drop characters that would let injected jsonld escape its <script> block.
function safeJsonLd(obj){
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// Hex sanity-check so a corrupt theme.accent can't drop arbitrary CSS
// into the response. Falls back to brand gold if invalid.
function safeHex(c, fb){
  if (typeof c !== 'string') return fb;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : fb;
}

function notFound(res, slug){
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.end(`<!doctype html><html><head>
<meta charset="utf-8"/><title>Clinic not found - Acuros Health</title>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="robots" content="noindex"/>
<style>
  body{font-family:'DM Sans',system-ui,sans-serif;background:#0c0c0a;color:#f0ede8;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center}
  h1{font-family:Georgia,serif;font-size:2.4rem;font-weight:300;letter-spacing:-.02em;margin-bottom:.75rem}
  p{color:#8c8880;line-height:1.7;max-width:42ch;margin:0 auto 1.75rem}
  a{display:inline-block;padding:.7rem 1.4rem;background:#c9a96e;color:#0c0c0a;text-decoration:none;letter-spacing:.18em;text-transform:uppercase;font-size:.7rem;font-weight:500}
</style></head><body>
<div><h1>Clinic not found.</h1><p>"${escapeHtml(slug)}" isn't a clinic on Acuros yet. It may have been renamed or unpublished.</p>
<a href="/">Return home</a></div>
</body></html>`);
}

export default async function handler(req, res){
  // Allow GET + HEAD only (HEAD lets crawlers probe status without
  // pulling the body). Anything else is unexpected on a marketing page.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  const slug = String((req.query?.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  if (!slug || slug.length < 3) return notFound(res, slug || 'unknown');

  if (!isSupabaseConfigured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Database is not configured for this deployment.');
  }

  const admin = getSupabaseAdmin();
  let org;
  try {
    const { data, error } = await admin
      .from('organizations')
      .select('id, name, slug, specialty, description, location, logo_url, contact_email, theme, brand, tags, is_published, published_at')
      .eq('slug', slug)
      .eq('is_published', true)
      .maybeSingle();
    if (error) throw error;
    org = data;
  } catch (err) {
    console.error('[clinic-page] org lookup failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Internal error');
  }

  if (!org) return notFound(res, slug);

  const accent  = safeHex(org.theme?.accent, '#c9a96e');
  const tagline = (org.brand?.tagline || '').toString().slice(0, 200);
  const desc    = (org.description || tagline || `${org.name} — patient portal on Acuros Health.`).toString().slice(0, 280);
  const hero    = (org.theme?.heroImage || org.logo_url || FALLBACK_HERO).toString();
  const ogImg   = (org.theme?.heroImage || org.logo_url || FALLBACK_HERO).toString();
  const phone   = (org.brand?.phone || '').toString();
  const url     = `https://acuros.ca/c/${escapeAttr(org.slug)}`;
  const titleText = `${org.name} - Acuros Health`;

  // JSON-LD LocalBusiness schema. This is what unlocks Google Maps
  // panels and rich result snippets without per-clinic code.
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    name: org.name,
    description: desc,
    url,
    telephone: phone || undefined,
    image: ogImg,
    address: org.location ? { '@type': 'PostalAddress', addressLocality: org.location } : undefined,
    sameAs: org.brand?.website ? [org.brand.website] : undefined,
  };

  // Cache aggressively at the edge but allow a stale-while-revalidate
  // window so changes from /onboarding go live within 60s.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');

  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-80K00SEBQK"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-80K00SEBQK');</script>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(titleText)}</title>
<meta name="description" content="${escapeAttr(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${url}"/>
<meta property="og:title" content="${escapeAttr(titleText)}"/>
<meta property="og:description" content="${escapeAttr(desc)}"/>
<meta property="og:image" content="${escapeAttr(ogImg)}"/>
<meta property="og:site_name" content="Acuros Health"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${escapeAttr(ogImg)}"/>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="180x180" href="/favicon-180.png"/>
<link rel="manifest" href="/site.webmanifest"/>
<meta name="theme-color" content="${accent}"/>
<script type="application/ld+json">${safeJsonLd(jsonld)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,200;0,300;0,400;0,500;1,200;1,300&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<style>
  :root{
    --bg:#f0ebe1;--bg2:#f8f4ec;--bg3:#e6e0d4;
    --border:#d4cdb8;--text:#1c1a14;--sub:#5c5346;--mute:#a09480;
    --ac:${accent};--nav:rgba(240,235,225,.97)
  }
  html.dark{
    --bg:#0c0c0a;--bg2:#111110;--bg3:#161614;
    --border:#1e1e1b;--text:#f0ede8;--sub:#8c8880;--mute:#4e4c48;
    --nav:rgba(12,12,10,.97)
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden;min-height:100dvh}
  h1,h2,h3{font-family:'Cormorant Garamond',serif;line-height:1.04;letter-spacing:-.025em}
  a{color:inherit;text-decoration:none}

  /* Top nav */
  nav{position:fixed;top:0;left:0;right:0;z-index:100;background:var(--nav);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
  .nav-inner{height:62px;max-width:1280px;margin:0 auto;padding:0 2rem;display:flex;align-items:center;justify-content:space-between}
  .nav-logo{display:flex;align-items:center;gap:.6rem;font-family:'Cormorant Garamond',serif;font-size:.92rem;letter-spacing:.2em;color:var(--text)}
  .nav-logo img{height:24px;width:auto}
  .nav-pow{font-size:.5rem;letter-spacing:.28em;text-transform:uppercase;color:var(--mute);font-family:'DM Sans',sans-serif}
  .nav-pow a{color:var(--ac)}
  .nav-cta{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;padding:.55rem 1.1rem;border:1px solid var(--text);background:var(--text);color:var(--bg);font-weight:500}
  .nav-cta:hover{background:var(--ac);border-color:var(--ac);color:#fff}

  /* Hero */
  .hero{position:relative;padding:8rem 2rem 5rem;border-bottom:1px solid var(--border);overflow:hidden;min-height:520px;display:flex;align-items:flex-end;background:#0a0908}
  .hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.4) brightness(.32)}
  .hero-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,7,6,.4) 0%,rgba(8,7,6,.6) 60%,rgba(8,7,6,.92) 100%)}
  .hero-orb{position:absolute;top:-15%;right:-10%;width:55vw;height:55vw;background:radial-gradient(circle,rgba(201,169,110,.14) 0%,transparent 65%);border-radius:50%;pointer-events:none}
  .hero-inner{position:relative;max-width:1280px;margin:0 auto;width:100%}
  .hero-badge{font-family:'DM Sans',sans-serif;font-size:.55rem;letter-spacing:.28em;text-transform:uppercase;color:var(--ac);margin-bottom:1.5rem;display:inline-flex;align-items:center;gap:.625rem}
  .hero-badge::before{content:'';display:inline-block;width:18px;height:1px;background:var(--ac)}
  h1.hero-h{font-size:clamp(3rem,7vw,5.75rem);font-weight:200;color:#f4efe7;margin-bottom:1.25rem;letter-spacing:-.035em;line-height:.96}
  h1.hero-h em{color:var(--ac);font-style:italic}
  .hero-tag{font-size:1rem;color:rgba(244,239,231,.72);max-width:50ch;line-height:1.85;margin-bottom:2.25rem;font-weight:300}
  .hero-meta{display:flex;flex-wrap:wrap;gap:1.75rem;align-items:center;font-family:'DM Sans',sans-serif}
  .hero-meta span{font-size:.65rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(244,239,231,.42)}
  .hero-meta .sep{width:3px;height:3px;border-radius:50%;background:rgba(244,239,231,.22)}
  .hero-cta{display:inline-flex;gap:.625rem;margin-top:2.5rem;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.78rem 1.6rem;font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;font-weight:500;font-family:'DM Sans',sans-serif;border:1px solid transparent;cursor:pointer;transition:background .25s,color .25s,border-color .25s,transform .15s}
  .btn-solid{background:var(--ac);color:#fff;border-color:var(--ac)}
  .btn-solid:hover{filter:brightness(1.08)}
  .btn-outline{background:transparent;color:#f4efe7;border-color:rgba(244,239,231,.4)}
  .btn-outline:hover{border-color:#f4efe7;color:#fff}
  .btn:active{transform:scale(.97)}

  /* Sections */
  section{padding:5rem 2rem;border-bottom:1px solid var(--border)}
  .container{max-width:1280px;margin:0 auto}
  .lbl{font-size:.55rem;letter-spacing:.22em;text-transform:uppercase;color:var(--mute);font-family:'DM Sans',sans-serif;margin-bottom:1rem}
  .h2{font-size:clamp(2rem,4vw,3rem);font-weight:200;letter-spacing:-.03em;margin-bottom:.5rem}
  .h2-sub{font-size:.95rem;color:var(--sub);line-height:1.7;max-width:55ch;margin-bottom:3rem}

  /* About */
  .about-grid{display:grid;grid-template-columns:5fr 4fr;gap:4rem;align-items:start}
  @media(max-width:880px){.about-grid{grid-template-columns:1fr;gap:2rem}}
  .about-body p{font-size:.95rem;color:var(--sub);line-height:1.85;font-weight:300}
  .about-meta{padding:2rem;background:var(--bg2);border:1px solid var(--border)}
  .about-meta dt{font-size:.55rem;letter-spacing:.22em;text-transform:uppercase;color:var(--mute);margin-top:1rem}
  .about-meta dt:first-child{margin-top:0}
  .about-meta dd{font-size:.92rem;color:var(--text);line-height:1.55;margin-top:.4rem}

  /* Services */
  .svc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border)}
  @media(max-width:880px){.svc-grid{grid-template-columns:1fr 1fr}}
  @media(max-width:580px){.svc-grid{grid-template-columns:1fr}}
  .svc-card{background:var(--bg2);padding:1.75rem 1.5rem;display:flex;flex-direction:column;gap:.75rem;transition:background .25s}
  .svc-card:hover{background:var(--bg3)}
  .svc-card-cat{font-size:.55rem;letter-spacing:.22em;text-transform:uppercase;color:var(--ac);font-weight:500}
  .svc-card-name{font-family:'Cormorant Garamond',serif;font-size:1.3rem;font-weight:300;color:var(--text);letter-spacing:-.015em;line-height:1.18}
  .svc-card-desc{font-size:.78rem;color:var(--sub);line-height:1.65;flex:1}
  .svc-card-foot{display:flex;justify-content:space-between;align-items:flex-end;padding-top:.875rem;border-top:1px solid var(--border);font-family:'DM Sans',sans-serif}
  .svc-card-dur{font-size:.65rem;color:var(--mute);letter-spacing:.04em}
  .svc-card-price{font-family:'Cormorant Garamond',serif;font-size:1.2rem;color:var(--text);font-weight:300}

  /* Footer */
  footer{padding:3rem 2rem;background:var(--bg2);border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;font-size:.7rem;color:var(--mute)}
  footer .pow{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--ac)}

  /* Empty service hint */
  .empty-svc{padding:3rem;text-align:center;color:var(--mute);font-style:italic;background:var(--bg2);border:1px dashed var(--border)}
</style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <a href="/c/${escapeAttr(org.slug)}" class="nav-logo">
      ${org.logo_url ? `<img src="${escapeAttr(org.logo_url)}" alt="${escapeAttr(org.name)}"/>` : ''}
      <span>${escapeHtml(org.name).toUpperCase()}</span>
    </a>
    <span class="nav-pow">Powered by <a href="/">Acuros Health</a></span>
    <a href="/bookings?clinic=${escapeAttr(org.slug)}" class="nav-cta">Book a visit</a>
  </div>
</nav>

<section class="hero">
  <img src="${escapeAttr(hero)}" alt="" class="hero-bg" loading="eager"/>
  <div class="hero-overlay"></div>
  <div class="hero-orb"></div>
  <div class="hero-inner">
    <div class="hero-badge">${escapeHtml(org.specialty || 'Patient portal')}</div>
    <h1 class="hero-h">${escapeHtml(org.name)}<br/><em>${escapeHtml(tagline || 'on Acuros Health.')}</em></h1>
    <p class="hero-tag">${escapeHtml(desc)}</p>
    <div class="hero-cta">
      <a class="btn btn-solid" href="/bookings?clinic=${escapeAttr(org.slug)}">Book a visit →</a>
      <a class="btn btn-outline" href="#services">Browse services</a>
    </div>
  </div>
</section>

<section id="about">
  <div class="container">
    <div class="about-grid">
      <div class="about-body">
        <div class="lbl">About</div>
        <h2 class="h2">A practice rooted in <em style="color:var(--ac);font-style:italic">${escapeHtml(org.location || 'your community')}.</em></h2>
        <p>${escapeHtml(desc)}</p>
      </div>
      <dl class="about-meta">
        ${org.location ? `<dt>Location</dt><dd>${escapeHtml(org.location)}</dd>` : ''}
        ${phone ? `<dt>Phone</dt><dd>${escapeHtml(phone)}</dd>` : ''}
        ${org.contact_email ? `<dt>Email</dt><dd><a href="mailto:${escapeAttr(org.contact_email)}" style="color:var(--ac)">${escapeHtml(org.contact_email)}</a></dd>` : ''}
        ${org.specialty ? `<dt>Speciality</dt><dd>${escapeHtml(org.specialty)}</dd>` : ''}
        <dt>Patient portal</dt><dd><a href="/patient-portal" style="color:var(--ac)">acuros.ca/patient-portal</a></dd>
      </dl>
    </div>
  </div>
</section>

<section id="services">
  <div class="container">
    <div class="lbl">Services</div>
    <h2 class="h2">What we <em style="color:var(--ac);font-style:italic">offer.</em></h2>
    <p class="h2-sub">Every appointment confirmed by our team within one business day. Payment is handled at the clinic.</p>
    <div id="svc-grid" class="svc-grid"><div class="empty-svc">Loading services…</div></div>
  </div>
</section>

<footer>
  <span>© ${new Date().getFullYear()} ${escapeHtml(org.name)}.</span>
  <span class="pow">Powered by Acuros</span>
  <span><a href="/privacy" style="color:var(--mute)">Privacy</a> · <a href="/terms" style="color:var(--mute)">Terms</a></span>
</footer>

<script>
// Hydrate services list client-side so the SEO shell stays small.
(function(){
  const SB_URL='${SUPABASE_URL}',SB_KEY='${PUBLISHABLE_KEY}';
  const ORG_ID='${escapeAttr(org.id)}';
  let sb=null; try{ sb=window.supabase.createClient(SB_URL,SB_KEY);}catch(_e){}
  function fmtPrice(c){ return (c==null||!Number.isFinite(+c)||+c<=0)?'On request':'$'+(Math.round(+c)/100).toFixed(0); }
  function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  async function loadServices(){
    const grid = document.getElementById('svc-grid');
    if (!sb) { grid.innerHTML = '<div class="empty-svc">Service catalog not available right now.</div>'; return; }
    try {
      const { data, error } = await sb.from('clinic_services').select('id,name,description,category,duration_min,price_cents').eq('org_id', ORG_ID).eq('is_active', true).order('sort_order', { ascending: true }).limit(60);
      if (error) throw error;
      if (!data || !data.length) { grid.innerHTML = '<div class="empty-svc">This clinic hasn\\'t listed any services yet.</div>'; return; }
      grid.innerHTML = data.map(s => '<div class="svc-card">'+
        '<div class="svc-card-cat">'+escapeHtml(s.category||'Service')+'</div>'+
        '<div class="svc-card-name">'+escapeHtml(s.name||'')+'</div>'+
        (s.description?'<div class="svc-card-desc">'+escapeHtml(s.description)+'</div>':'<div class="svc-card-desc">&nbsp;</div>')+
        '<div class="svc-card-foot">'+
          '<span class="svc-card-dur">'+(s.duration_min?(s.duration_min+' min'):'')+'</span>'+
          '<span class="svc-card-price">'+fmtPrice(s.price_cents)+'</span>'+
        '</div></div>').join('');
    } catch (err) {
      grid.innerHTML = '<div class="empty-svc">Could not load services. Please refresh.</div>';
    }
  }
  loadServices();

  // Theme bootstrap.
  if (localStorage.getItem('ah-theme') === 'dark') document.documentElement.classList.add('dark');

  // Stash the slug so /bookings can pre-fill clinic context.
  try { localStorage.setItem('ah-org-code', ${JSON.stringify((org.slug || '').toUpperCase())}); } catch(_e){}
})();
</script>
</body>
</html>`);
}
