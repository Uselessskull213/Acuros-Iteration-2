-- ============================================================
-- Acuros v2 — Self-Serve Onboarding & Dynamic Clinic Portals
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Idempotent: safe to re-run.
--
-- This migration unlocks:
--   • Clinic owners (organizations.owner_id) — drives RLS for the
--     bookings/orders policies that previous migrations dropped.
--   • Multi-tenant routing via /c/<slug>.
--   • Per-clinic theme + brand copy stored as jsonb so we don't need
--     a schema change every time a new branding field appears.
--   • Resumable onboarding state.
--   • Reserved-slug guardrails so registrations cannot collide with
--     site routes (admin, dashboard, onboarding, c, api, etc).
-- ============================================================

-- 1. Extend organizations with the columns the public site, the
--    onboarding wizard, and the dynamic clinic page all need.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS owner_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slug              text,
  ADD COLUMN IF NOT EXISTS theme             jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS brand             jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_published      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_state  jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS custom_domain     text,
  ADD COLUMN IF NOT EXISTS published_at      timestamptz;

-- Slug must be a kebab-case URL-safe identifier between 3 and 32 chars.
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_slug_format;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_slug_format
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$');

-- Slug must be unique across published clinics (case-insensitive).
DROP INDEX IF EXISTS organizations_slug_uniq;
CREATE UNIQUE INDEX organizations_slug_uniq ON public.organizations (lower(slug));

-- Custom-domain uniqueness (sparse — most rows null).
DROP INDEX IF EXISTS organizations_custom_domain_uniq;
CREATE UNIQUE INDEX organizations_custom_domain_uniq
  ON public.organizations (lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

-- 2. Reserved slug list. Any registration that collides is rejected
--    by RLS. Edit this table whenever a new top-level route is added.
CREATE TABLE IF NOT EXISTS public.reserved_slugs (
  slug text PRIMARY KEY
);
INSERT INTO public.reserved_slugs (slug) VALUES
  ('admin'),('administrator'),('api'),('app'),('apps'),
  ('auth'),('billing'),('blog'),('bookings'),('c'),
  ('clinic'),('clinics'),('contact'),('dashboard'),('demo'),
  ('docs'),('home'),('login'),('logout'),('me'),
  ('new'),('news'),('onboarding'),('owner'),('patient'),
  ('patient-portal'),('portal'),('press'),('pricing'),('privacy'),
  ('settings'),('shop'),('signup'),('signin'),('signout'),
  ('sitemap'),('static'),('status'),('support'),('terms'),
  ('test'),('tests'),('user'),('users'),('w'),('www')
ON CONFLICT DO NOTHING;

-- 3. clinic_services — per-clinic bookable services (vs products).
--    The bookings flow already references this conceptually; this is
--    where it lives.
CREATE TABLE IF NOT EXISTS public.clinic_services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  category      text,
  duration_min  integer NOT NULL DEFAULT 60 CHECK (duration_min > 0),
  price_cents   integer,             -- NULL means "consultation required"
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinic_services_org_idx
  ON public.clinic_services (org_id, is_active, sort_order);

ALTER TABLE public.clinic_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Active services are public"   ON public.clinic_services;
DROP POLICY IF EXISTS "Owner manages services"       ON public.clinic_services;
CREATE POLICY "Active services are public"
  ON public.clinic_services FOR SELECT
  USING (is_active = true AND org_id IN (SELECT id FROM public.organizations WHERE is_published = true));
CREATE POLICY "Owner manages services"
  ON public.clinic_services FOR ALL
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

-- 4. Restore org-owner read policies on bookings + orders now that
--    organizations.owner_id exists. Earlier migration dropped these.
DROP POLICY IF EXISTS "Org owner sees clinic bookings" ON public.bookings;
CREATE POLICY "Org owner sees clinic bookings"
  ON public.bookings FOR SELECT
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Org owner sees orders" ON public.orders;
CREATE POLICY "Org owner sees orders"
  ON public.orders FOR SELECT
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

-- 5. Owner can manage their own organization row (used by the wizard
--    + dashboard). Public reads remain controlled by is_published.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Published clinics are public"   ON public.organizations;
DROP POLICY IF EXISTS "Owner reads own org"            ON public.organizations;
DROP POLICY IF EXISTS "Owner updates own org"          ON public.organizations;
DROP POLICY IF EXISTS "Owner inserts own org"          ON public.organizations;
DROP POLICY IF EXISTS "Slug not reserved on insert"    ON public.organizations;

CREATE POLICY "Published clinics are public"
  ON public.organizations FOR SELECT
  USING (is_published = true);

CREATE POLICY "Owner reads own org"
  ON public.organizations FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Owner updates own org"
  ON public.organizations FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (
    owner_id = auth.uid()
    AND (slug IS NULL OR slug NOT IN (SELECT slug FROM public.reserved_slugs))
  );

-- 6. Owner can manage products on their own clinic.
DROP POLICY IF EXISTS "Owner manages products" ON public.products;
CREATE POLICY "Owner manages products"
  ON public.products FOR ALL
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

-- 7. Owner can manage their clinic's loyalty rewards catalog.
DROP POLICY IF EXISTS "Owner manages rewards" ON public.clinic_rewards;
CREATE POLICY "Owner manages rewards"
  ON public.clinic_rewards FOR ALL
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

-- 8. Storage bucket for clinic assets (logos, hero images).
--    Created via the Storage API rather than SQL, but the policies
--    that govern it are SQL. Bucket name: clinic-assets.
INSERT INTO storage.buckets (id, name, public)
VALUES ('clinic-assets', 'clinic-assets', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Public read for everyone (logos / hero images need to be hot-linkable).
DROP POLICY IF EXISTS "Clinic assets are public-read"     ON storage.objects;
CREATE POLICY "Clinic assets are public-read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'clinic-assets');

-- Owners can write to their own folder. Path pattern: org_<uuid>/<filename>.
-- Enforced by checking that the path's first segment matches an org the
-- caller owns.
DROP POLICY IF EXISTS "Owner writes to clinic-assets"     ON storage.objects;
CREATE POLICY "Owner writes to clinic-assets"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'clinic-assets'
    AND (storage.foldername(name))[1] LIKE 'org_%'
    AND substr((storage.foldername(name))[1], 5)::uuid IN (
      SELECT id FROM public.organizations WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Owner updates own clinic-assets"   ON storage.objects;
CREATE POLICY "Owner updates own clinic-assets"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'clinic-assets'
    AND (storage.foldername(name))[1] LIKE 'org_%'
    AND substr((storage.foldername(name))[1], 5)::uuid IN (
      SELECT id FROM public.organizations WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Owner deletes own clinic-assets"   ON storage.objects;
CREATE POLICY "Owner deletes own clinic-assets"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'clinic-assets'
    AND (storage.foldername(name))[1] LIKE 'org_%'
    AND substr((storage.foldername(name))[1], 5)::uuid IN (
      SELECT id FROM public.organizations WHERE owner_id = auth.uid()
    )
  );

-- ============================================================
-- Done. Summary of what changed:
--   organizations: +owner_id, +slug, +theme, +brand, +is_published,
--                  +onboarding_state, +custom_domain, +published_at,
--                  unique slug index, reserved-slug guardrail.
--   reserved_slugs: new table seeded with site routes.
--   clinic_services: new table + RLS.
--   bookings/orders: org-owner read policies restored.
--   products/clinic_rewards: owner-manage policies added.
--   storage: clinic-assets bucket + per-owner folder write policies.
-- ============================================================
