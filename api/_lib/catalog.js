// api/_lib/catalog.js — authoritative shop price list (server-side).
//
// The shop page (src/pages/shop.astro) currently hardcodes its catalog in two
// arrays (GENERIC_PRODUCTS / AAA_PRODUCTS). api/checkout.js must NOT trust the
// prices a browser sends (a client could inflate a price to mint loyalty
// points or corrupt the clinic's order). This module mirrors the legitimate
// (product name -> valid prices) pairs so checkout can validate against them.
//
// TODO: when the shop moves to DB-backed `products`, replace this with a
// per-org lookup of products.price and delete this file.

// name (normalized) -> array of legitimate prices in dollars.
// A name can have >1 valid price when it appears in both catalogs.
const PRICE_LIST = {
  // GENERIC_PRODUCTS
  'vitamin d3 + k2': [28.99],
  'omega-3 fish oil': [34.99],
  'magnesium glycinate': [26.50],
  'spf 50+ mineral sunscreen': [22.00],
  'hyaluronic acid serum': [38.00],
  'retinol night cream': [44.00],
  'probiotic complex': [39.99],
  'sleep support formula': [29.99],
  'electrolyte powder': [32.00],
  'arnica gel 500mg': [18.50],
  'biofreeze roll-on': [15.00],
  'collagen peptides': [49.99, 74.00],
  // AAA_PRODUCTS
  'vitamin c brightening serum': [89.00],
  'spf 50 physical sunscreen': [48.00],
  'hyaluronic acid moisturizer': [65.00],
  'retinol recovery cream': [110.00],
  'peptide eye concentrate': [92.00],
  'barrier repair balm': [54.00],
  'oral vitamin c 1000mg': [32.00],
  'biotin complex 10,000 mcg': [28.00],
  'electrolyte recovery powder': [38.00],
  'glutathione skin supplement': [68.00],
  'omega-3 anti-inflammatory': [44.00],
};

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Returns the authoritative price in cents for (name, clientPriceDollars) when
// the pair matches the catalog, else null (caller should reject the item).
export function validatedPriceCents(name, clientPriceDollars) {
  const valid = PRICE_LIST[norm(name)];
  if (!valid) return null;
  const p = Number(clientPriceDollars);
  if (!Number.isFinite(p)) return null;
  const match = valid.find((v) => Math.abs(v - p) < 0.005);
  return match != null ? Math.round(match * 100) : null;
}
