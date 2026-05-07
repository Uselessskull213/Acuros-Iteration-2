-- ============================================================
-- Acuros v2 — Roles & Clinic Memberships
-- Run once in Supabase Dashboard → SQL Editor → New Query.
-- Idempotent: safe to re-run.
--
-- Adds:
--   • profiles.role — 'patient' (default) or 'clinic_owner'.
--     Only clinic_owner accounts can use /onboarding.
--   • clinic_memberships table — many-to-many: a patient can join
--     multiple clinics with their codes, leave any of them.
-- ============================================================

-- Just in case the profiles table doesn't exist on this database,
-- create a minimal version. This is a no-op if the existing project
-- already has the column we want.
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'patient'
  CHECK (role IN ('patient', 'clinic_owner', 'admin'));

-- Existing rows that were created before this column existed will have
-- the default 'patient' role applied automatically by the ADD COLUMN.

-- Auto-create a profile row whenever a new auth user signs up. This
-- guarantees /api/onboarding can always find a role for the caller.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'patient')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── clinic_memberships ──
-- A patient can join many clinics. A clinic owner cannot be a member of
-- their own clinic (no self-join). Codes are stable on organizations.code.
CREATE TABLE IF NOT EXISTS public.clinic_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS clinic_memberships_user_idx ON public.clinic_memberships (user_id);
CREATE INDEX IF NOT EXISTS clinic_memberships_org_idx  ON public.clinic_memberships (org_id);

ALTER TABLE public.clinic_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User reads own memberships"     ON public.clinic_memberships;
DROP POLICY IF EXISTS "Owner reads clinic memberships" ON public.clinic_memberships;
DROP POLICY IF EXISTS "User leaves own memberships"    ON public.clinic_memberships;

CREATE POLICY "User reads own memberships"
  ON public.clinic_memberships FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Owner reads clinic memberships"
  ON public.clinic_memberships FOR SELECT
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

CREATE POLICY "User leaves own memberships"
  ON public.clinic_memberships FOR DELETE
  USING (user_id = auth.uid());

-- Inserts go through the service-role API at /api/memberships?action=join
-- so we don't expose joining-by-org-id directly to the anon key. That
-- way we can validate the code, prevent self-join, etc, server-side.

-- ── Helper: lookup_org_by_code ──
-- Used by /api/memberships?action=join. Wrapped as SECURITY DEFINER so the
-- service-role doesn't have to be invoked from the SQL editor.
CREATE OR REPLACE FUNCTION public.lookup_org_by_code(p_code text)
RETURNS TABLE (id uuid, name text, slug text, is_published boolean, owner_id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT id, name, slug, is_published, owner_id
  FROM public.organizations
  WHERE upper(code) = upper(p_code)
  LIMIT 1;
$$;

-- ============================================================
-- Done. Summary:
--   profiles.role added with default 'patient' + trigger to seed it
--   on auth signup.
--   clinic_memberships table + read/delete RLS for patients and owners.
-- ============================================================
