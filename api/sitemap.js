// api/sitemap.js — dynamic sitemap.xml
//
// Enumerates the static pages plus every published clinic at /c/<slug>.
// Cached at the edge for 5 minutes so a freshly published clinic is
// discoverable to crawlers within that window without making this
// endpoint hot for every Googlebot hit.

import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';

const ORIGIN = 'https://acuros.ca';

// Static surface area we always advertise. Order matches priority.
// Pages with `<meta name="robots" content="noindex">` (patient-portal,
// onboarding, dashboard, settings, editor) are intentionally omitted so
// we don't tell Google about URLs we're also telling it to skip.
const STATIC_URLS = [
  { loc: '/',             priority: '1.0', changefreq: 'weekly',  image: '/hero-bg.jpg', imageTitle: 'Acuros Health - patient engagement platform for Canadian clinics' },
  { loc: '/ai-assistant', priority: '0.9', changefreq: 'weekly',  image: '/hero-bg.jpg', imageTitle: 'Acuros AI - evidence-based health education assistant' },
  { loc: '/bookings',     priority: '0.7', changefreq: 'monthly' },
  { loc: '/shop',         priority: '0.6', changefreq: 'monthly' },
  { loc: '/privacy',      priority: '0.3', changefreq: 'yearly'  },
  { loc: '/terms',        priority: '0.3', changefreq: 'yearly'  },
];

function escapeXml(s){
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  let clinics = [];
  if (isSupabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin
        .from('organizations')
        .select('slug, published_at, name, hero_image_url')
        .eq('is_published', true)
        .not('slug', 'is', null)
        .order('published_at', { ascending: false })
        .limit(5000);
      if (!error && Array.isArray(data)) clinics = data;
    } catch (err) {
      console.error('[sitemap] org enumeration failed:', err);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'
  ];

  for (const u of STATIC_URLS) {
    lines.push('  <url>');
    lines.push(`    <loc>${ORIGIN}${u.loc}</loc>`);
    lines.push(`    <lastmod>${today}</lastmod>`);
    lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
    lines.push(`    <priority>${u.priority}</priority>`);
    if (u.image) {
      lines.push('    <image:image>');
      lines.push(`      <image:loc>${ORIGIN}${u.image}</image:loc>`);
      if (u.imageTitle) lines.push(`      <image:title>${escapeXml(u.imageTitle)}</image:title>`);
      lines.push('    </image:image>');
    }
    lines.push('  </url>');
  }

  for (const c of clinics) {
    const lastmod = (c.published_at ? c.published_at.slice(0, 10) : today);
    lines.push('  <url>');
    lines.push(`    <loc>${ORIGIN}/c/${escapeXml(c.slug)}</loc>`);
    lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push('    <changefreq>weekly</changefreq>');
    lines.push('    <priority>0.8</priority>');
    if (c.hero_image_url) {
      lines.push('    <image:image>');
      lines.push(`      <image:loc>${escapeXml(c.hero_image_url)}</image:loc>`);
      if (c.name) lines.push(`      <image:title>${escapeXml(c.name)}</image:title>`);
      lines.push('    </image:image>');
    }
    lines.push('  </url>');
  }

  lines.push('</urlset>');

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=900');
  res.end(lines.join('\n'));
}
