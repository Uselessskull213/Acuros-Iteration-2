-- ============================================================
-- Acuros v2 — Account-Creation System (CANONICAL, idempotent)
-- Run in Supabase Dashboard → SQL Editor. Safe to re-run.
--
-- This file is the single source of truth for how profiles +
-- account codes are created. It SUPERSEDES the handle_new_user()
-- definitions in:
--   • supabase-roles.sql
--   • supabase-trigger-fix.sql
--   • supabase-portal-editor.sql
-- Those older files drifted from the live database (e.g. they
-- INSERT a profiles.email column that does not exist, which would
-- break every signup if re-run). Prefer THIS file.
--
-- ── The bug this file fixes ─────────────────────────────────
-- profiles.account_code carried a column DEFAULT generate_account_code().
-- A column DEFAULT is evaluated as the *inserting* role (anon/authenticated),
-- which does NOT hold EXECUTE on the SECURITY DEFINER generate_account_code().
-- Result: every profile upsert from the browser failed with
--   "permission denied for function generate_account_code"
-- (seen on the "How will you be using Acuros?" role picker).
-- Fix: drop the default and let the SECURITY DEFINER BEFORE-INSERT trigger
-- set_account_code() generate the code — it runs as the function owner, so
-- no caller grant is required.
-- ============================================================

-- ── 1. Account-code generator (SECURITY DEFINER) ────────────
-- Alphabet excludes look-alikes (O/0, I/1). Loops until unique.
CREATE OR REPLACE FUNCTION public.generate_account_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text;
  i int;
BEGIN
  LOOP
    result := 'ACU-';
    FOR i IN 1..6 LOOP
      result := result || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE account_code = result);
  END LOOP;
  RETURN result;
END;
$$;

-- ── 2. account_code column: NOT NULL, UNIQUE, NO column default ──
-- The trigger below populates it; a column DEFAULT here is what caused the
-- permission error, so it must stay dropped.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_code text;
ALTER TABLE public.profiles
  ALTER COLUMN account_code DROP DEFAULT;          -- <- THE FIX
UPDATE public.profiles                              -- backfill any gaps as owner
   SET account_code = public.generate_account_code()
 WHERE account_code IS NULL OR account_code = '';
CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_code_key
  ON public.profiles (account_code);

-- ── 3. BEFORE INSERT trigger fills account_code (runs as definer) ──
CREATE OR REPLACE FUNCTION public.set_account_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.account_code IS NULL OR NEW.account_code = '' THEN
    NEW.account_code := public.generate_account_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_account_code ON public.profiles;
CREATE TRIGGER trg_profiles_account_code
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_account_code();

-- ── 4. Privilege guard: clients can't self-grant tier/role/account_code ──
CREATE OR REPLACE FUNCTION public.guard_profile_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF auth.role() IN ('anon','authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.tier := 'free';
      IF NEW.role = 'admin' THEN NEW.role := 'patient'; END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.tier := OLD.tier;
      NEW.account_code := OLD.account_code;
      IF NEW.role = 'admin' AND OLD.role <> 'admin' THEN
        NEW.role := OLD.role;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_privileges ON public.profiles;
CREATE TRIGGER guard_profile_privileges
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileges();

-- ── 5. Seed a profile row on auth signup ────────────────────
-- Runs as the auth admin via the auth.users trigger. Only touches columns
-- that exist (NO email column on this project). Honors the role chosen at
-- signup (user_metadata.role) — dropping it stranded every new clinic owner
-- as 'patient', which the onboarding API then 403s (owner-funnel deadlock).
-- Unknown/absent role falls back to 'patient' with role_confirmed=false so
-- the role picker shows.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  meta_role text := NEW.raw_user_meta_data->>'role';
BEGIN
  INSERT INTO public.profiles (id, name, tier, usage_count, role, role_confirmed)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1), 'Patient'),
    'free',
    0,
    CASE WHEN meta_role IN ('patient','clinic_owner') THEN meta_role ELSE 'patient' END,
    -- COALESCE is load-bearing: meta_role IN (...) is NULL (not false) when
    -- meta_role is NULL, and role_confirmed is NOT NULL — without it every
    -- OAuth signup (no role metadata) fails the insert.
    COALESCE(meta_role IN ('patient','clinic_owner'), false)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 5b. Owning an organization implies clinic_owner ─────────
-- OAuth signups (Google/Apple) carry no role metadata; the moment
-- onboarding assigns them an org, promote the profile. Never demotes,
-- never touches admins.
CREATE OR REPLACE FUNCTION public.sync_owner_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.owner_id IS NOT NULL THEN
    UPDATE public.profiles
       SET role = 'clinic_owner', role_confirmed = true
     WHERE id = NEW.owner_id AND role NOT IN ('clinic_owner','admin');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_org_owner_role ON public.organizations;
CREATE TRIGGER trg_org_owner_role
  AFTER INSERT OR UPDATE OF owner_id ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.sync_owner_role();

-- ── 5c. One-time backfill for accounts stranded as 'patient' ──
UPDATE public.profiles p
   SET role = 'clinic_owner', role_confirmed = true
  FROM auth.users u
 WHERE p.id = u.id
   AND p.role = 'patient'
   AND (
     u.raw_user_meta_data->>'role' = 'clinic_owner'
     OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.owner_id = p.id)
   );

-- ── 6. Least-privilege grants ───────────────────────────────
-- Trigger functions fire regardless of caller EXECUTE, so they must NOT be
-- exposed as RPCs. generate_account_code() stays definer-only on purpose.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_owner_role()          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_profile_privileges() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_account_code()         FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_account_code()    FROM anon, authenticated;

-- ── 7. profiles RLS: read/insert/update own row, no escalation ──
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile"           ON public.profiles;
DROP POLICY IF EXISTS "users read own profile"               ON public.profiles;
CREATE POLICY "users read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_self_insert_no_priv"         ON public.profiles;
CREATE POLICY "profiles_self_insert_no_priv"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND role IN ('patient','clinic_owner')
    AND tier = 'free'
  );

DROP POLICY IF EXISTS "profiles_self_update_no_escalation"   ON public.profiles;
CREATE POLICY "profiles_self_update_no_escalation"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND tier = (SELECT p.tier FROM public.profiles p WHERE p.id = auth.uid())
    AND (
      role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
      OR role IN ('patient','clinic_owner')
    )
  );

-- ── 8. Organization-identity integrity ──────────────────────
-- One org per owner (prevents the onboarding duplicate-row race that breaks
-- .maybeSingle()). NULL owners are legacy seed rows, hence partial.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_owner_id_uniq
  ON public.organizations (owner_id)
  WHERE owner_id IS NOT NULL;

-- Reserved-slug guard. The organizations UPDATE policy checks
-- `slug NOT IN (SELECT slug FROM reserved_slugs)`; without a SELECT policy
-- that subquery saw zero rows (RLS) and the guard silently passed.
ALTER TABLE public.reserved_slugs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reserved_slugs_public_read ON public.reserved_slugs;
CREATE POLICY reserved_slugs_public_read
  ON public.reserved_slugs FOR SELECT
  USING (true);

-- ============================================================
-- Done. Verify with:
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name='profiles' AND column_name='account_code';  -- expect NULL
-- ============================================================
