// Server-side Supabase client using the service-role key.
// Mirrors AcurosMobile/lib/supabase.ts (anon, client) but with admin privileges
// so serverless functions can write to RLS-protected tables.

import { createClient } from '@supabase/supabase-js';

let cached = null;

export function getSupabaseAdmin() {
  if (cached) return cached;
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase env vars missing: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

export function isSupabaseConfigured() {
  return Boolean(
    (process.env.SUPABASE_URL ||
      process.env.VITE_PUBLIC_SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      process.env.EXPO_PUBLIC_SUPABASE_URL) &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
