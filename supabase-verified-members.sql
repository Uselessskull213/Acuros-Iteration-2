-- ============================================================
-- Acuros v2 — Verified Members (owner-gated clinic join)  [CANONICAL, idempotent]
-- Run in Supabase Dashboard → SQL Editor, or via MCP apply_migration. Safe to re-run.
--
-- Rule: a patient may only join a clinic once the clinic OWNER has added
-- that patient's profiles.account_code to the clinic's verified list.
--
-- The gate is enforced at the DATABASE layer on BOTH join mechanisms so it
-- cannot be bypassed by any client or API path:
--   • clinic_memberships INSERT   — the "My clinics" / /api/memberships flow
--   • profiles.org_id   UPDATE     — the legacy "Connect with a code" redirect
--
-- Both triggers read the patient's account_code from the profiles row by id
-- (the committed value), NOT from the mutating payload, so a caller cannot
-- spoof someone else's verified code. See [[acuros-supabase-architecture]].
-- ============================================================

-- ── 1. Allowlist table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.verified_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_code text NOT NULL CHECK (account_code <> ''),
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- resolved patient, if known
  patient_name text,                                                -- display snapshot
  added_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- owner who verified
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS verified_members_org_code_uniq
  ON public.verified_members (org_id, account_code);
CREATE INDEX IF NOT EXISTS verified_members_org_idx
  ON public.verified_members (org_id);

-- ── 2. RLS: owners READ their own clinic's list. ────────────
-- Writes route through the service-role API (patient lookup + validation),
-- so no client INSERT/UPDATE/DELETE policy is granted.
ALTER TABLE public.verified_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS verified_members_owner_read ON public.verified_members;
CREATE POLICY verified_members_owner_read
  ON public.verified_members FOR SELECT TO authenticated
  USING (org_id IN (SELECT id FROM public.organizations WHERE owner_id = auth.uid()));

-- ── 3. Verification predicate (SECURITY DEFINER) ────────────
-- Case-insensitive, whitespace-tolerant; an empty/NULL code is never verified.
CREATE OR REPLACE FUNCTION public.is_account_verified(p_org_id uuid, p_account_code text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.verified_members vm
    WHERE vm.org_id = p_org_id
      AND btrim(coalesce(p_account_code, '')) <> ''
      AND upper(vm.account_code) = upper(btrim(p_account_code))
  );
$$;
-- FROM PUBLIC too: a fresh function grants EXECUTE to PUBLIC, which anon /
-- authenticated inherit — revoking only those two roles leaves it exposed.
REVOKE EXECUTE ON FUNCTION public.is_account_verified(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── 4. Gate the clinic_memberships INSERT path ──────────────
-- Fires for ALL callers (including the service-role API), so it is the
-- authoritative backstop. The API does its own pre-check for a clean 403.
CREATE OR REPLACE FUNCTION public.enforce_verified_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_code text;
BEGIN
  SELECT account_code INTO v_code FROM public.profiles WHERE id = NEW.user_id;
  IF NOT public.is_account_verified(NEW.org_id, v_code) THEN
    RAISE EXCEPTION 'Your clinic has not verified your account yet. Ask them to add your Acuros account code to their verified members, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.enforce_verified_membership() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_verified_membership ON public.clinic_memberships;
CREATE TRIGGER trg_enforce_verified_membership
  BEFORE INSERT ON public.clinic_memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_verified_membership();

-- ── 5. Gate the legacy profiles.org_id link path ────────────
-- Only fires for an authenticated client linking its OWN profile to a NEW
-- clinic. Unlinking (org_id -> NULL), re-persisting the same org_id, and
-- service-role/admin writes all pass through untouched. Owners linking their
-- own clinic are exempt (they are not patients). The account_code is read
-- from the committed profiles row by id, so it cannot be spoofed.
CREATE OR REPLACE FUNCTION public.enforce_verified_org_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_code text;
BEGIN
  IF auth.role() = 'authenticated'
     AND NEW.org_id IS NOT NULL
     AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND NOT EXISTS (
       SELECT 1 FROM public.organizations o
       WHERE o.id = NEW.org_id AND o.owner_id = NEW.id
     )
  THEN
    SELECT account_code INTO v_code FROM public.profiles WHERE id = NEW.id;
    IF NOT public.is_account_verified(NEW.org_id, v_code) THEN
      RAISE EXCEPTION 'Your clinic has not verified your account yet. Ask them to add your Acuros account code to their verified members, then try again.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.enforce_verified_org_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_verified_org_link ON public.profiles;
CREATE TRIGGER trg_enforce_verified_org_link
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_verified_org_link();

-- ============================================================
-- Done. Verify with:
--   SELECT public.is_account_verified('<org-uuid>', 'ACU-XXXXXX');   -- expect false
-- ============================================================
