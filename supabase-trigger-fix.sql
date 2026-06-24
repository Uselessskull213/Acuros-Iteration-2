-- ============================================================
-- Acuros v2 — handle_new_user trigger fix
-- Run once in Supabase Dashboard → SQL Editor → New Query.
-- Idempotent: safe to re-run.
--
-- ⚠ SUPERSEDED by supabase-account-system.sql, which is the current
--   authoritative definition of handle_new_user() + the account-code system.
--
-- The previous version of this trigger inserted INTO public.profiles
-- (id, email, name, role) but the live profiles table doesn't have an
-- email column. The trigger therefore raised on every auth signup,
-- meaning new users had no profile row and the role-prompt modal
-- couldn't save their choice. Rewriting it to only touch columns
-- that exist.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, role, role_confirmed)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'patient'),
    -- If the user explicitly chose at signup (toggle on /patient-portal
    -- passes role through user_metadata), mark them confirmed so they
    -- don't see the modal again. Otherwise leave at false.
    CASE WHEN NEW.raw_user_meta_data ? 'role' THEN true ELSE false END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger itself stays the same (already created in supabase-roles.sql).
-- Re-creating for safety.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Tell PostgREST to reload its schema cache so the column list it
-- knows about reflects current truth.
NOTIFY pgrst, 'reload schema';
