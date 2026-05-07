-- ============================================================
-- Acuros v2 — role_confirmed flag
-- Run once in Supabase Dashboard → SQL Editor → New Query.
-- Idempotent: safe to re-run.
--
-- Adds profiles.role_confirmed so we can prompt users who have a
-- default 'patient' role applied by the auth trigger but who never
-- explicitly chose. Google OAuth signups, social SSO, and pre-existing
-- accounts all start with role_confirmed = false and get prompted on
-- their next sign-in. Email signups via the role-toggle on
-- /patient-portal flip it to true at signup time.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role_confirmed boolean NOT NULL DEFAULT false;

-- Anyone whose role is already set to 'clinic_owner' or 'admin' has
-- effectively confirmed their role (you can't accidentally end up there
-- without explicit action). Mark them as confirmed so we don't bounce
-- them through the modal again.
UPDATE public.profiles
   SET role_confirmed = true
 WHERE role IN ('clinic_owner', 'admin')
   AND role_confirmed = false;
