-- ============================================================
-- Acuros v2 — Portal Editor + Web Auth Alignment with Mobile
-- Run once in Supabase Dashboard → SQL Editor → New Query.
-- Idempotent: safe to re-run.
--
-- ⚠ SUPERSEDED: the handle_new_user() definition below INSERTs a
--   profiles.email column that does NOT exist on this project and would
--   break every signup if re-run. The account-creation system now lives in
--   supabase-account-system.sql — use that file. The section below is kept
--   only for the portal_html / account_code column additions.
-- ============================================================

-- ── 1. Free-form portal HTML on each organization ───────────
-- Set when a clinic owner saves AI-generated HTML from the editor.
-- When NULL, api/clinic-page.js falls back to the generated shell.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS portal_html       text,
  ADD COLUMN IF NOT EXISTS portal_updated_at timestamptz;

-- ── 2. Profile columns mirroring AcurosMobile ────────────────
-- account_code: human-readable identifier like ACU-A3F9K2 (mobile parity).
-- two_fa_enabled: per-user 2FA flag, gated by email OTP.
-- tier / usage_count: parity with mobile profile shape so the same
-- AcurosMobile authService logic works against this database unchanged.
-- account_tag: 'patient' | 'organization' (the mobile ORG_TAG_KEY value).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_code     text UNIQUE,
  ADD COLUMN IF NOT EXISTS two_fa_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tier             text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free','plus')),
  ADD COLUMN IF NOT EXISTS usage_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_tag      text
    CHECK (account_tag IN ('patient','organization') OR account_tag IS NULL);

CREATE INDEX IF NOT EXISTS profiles_account_code_idx ON public.profiles (account_code);

-- ── 3. Account-code generator ───────────────────────────────
-- Same alphabet as mobile (no O/0, I/1). Retries on collision up to 5x.
CREATE OR REPLACE FUNCTION public.generate_account_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
  attempt int := 0;
BEGIN
  LOOP
    candidate := 'ACU-';
    FOR i IN 1..6 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE account_code = candidate) THEN
      RETURN candidate;
    END IF;
    attempt := attempt + 1;
    IF attempt >= 5 THEN
      -- Vanishingly unlikely, but fall back to uuid-derived to guarantee progress.
      RETURN 'ACU-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    END IF;
  END LOOP;
END;
$$;

-- ── 4. Refreshed handle_new_user trigger ────────────────────
-- Sets role + account_code + email + name on insert into auth.users.
-- The trigger from supabase-roles.sql is replaced (idempotent).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role, account_code, tier, usage_count)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'patient'),
    public.generate_account_code(),
    'free',
    0
  )
  ON CONFLICT (id) DO UPDATE
    SET account_code = COALESCE(public.profiles.account_code, EXCLUDED.account_code);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 5. Backfill account_code for any pre-existing profiles ──
UPDATE public.profiles
   SET account_code = public.generate_account_code()
 WHERE account_code IS NULL;

-- ============================================================
-- Done.
-- New columns:
--   organizations.portal_html, organizations.portal_updated_at
--   profiles.account_code (unique), profiles.two_fa_enabled,
--   profiles.tier, profiles.usage_count, profiles.account_tag
-- ============================================================
