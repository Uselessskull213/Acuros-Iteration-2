-- ============================================================
-- Acuros v2 — Bookings & Checkout Migration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Marketplace columns on organizations (mirrors AcurosMobile/supabase-migration.sql)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS specialty     text,
  ADD COLUMN IF NOT EXISTS description   text,
  ADD COLUMN IF NOT EXISTS location      text,
  ADD COLUMN IF NOT EXISTS logo_url      text,
  ADD COLUMN IF NOT EXISTS tags          text[],
  ADD COLUMN IF NOT EXISTS contact_email text;

-- 2. Products table (catalog for the shop)
CREATE TABLE IF NOT EXISTS public.products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  price       integer NOT NULL,        -- CAD cents (15000 = $150)
  image_url   text,
  category    text,
  in_stock    boolean DEFAULT true,
  is_service  boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Products are publicly readable" ON public.products;
CREATE POLICY "Products are publicly readable" ON public.products FOR SELECT USING (true);

-- 3. Bookings table (mirrors AcurosMobile booking model adapted for v2 procedure form)
CREATE TABLE IF NOT EXISTS public.bookings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  patient_id               uuid,                       -- auth.users.id, nullable for guests
  procedure_name           text NOT NULL,
  procedure_category       text,
  price_label              text,
  patient_first_name       text NOT NULL,
  patient_last_name        text NOT NULL,
  patient_email            text NOT NULL,
  patient_phone            text NOT NULL,
  appointment_date         date NOT NULL,
  appointment_time_label   text,
  notes                    text,
  status                   text NOT NULL DEFAULT 'requested'
                              CHECK (status IN ('requested','confirmed','cancelled','completed','no_show')),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_org_idx        ON public.bookings (org_id, appointment_date DESC);
CREATE INDEX IF NOT EXISTS bookings_patient_idx    ON public.bookings (patient_id, appointment_date DESC);

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Patient sees own bookings"     ON public.bookings;
DROP POLICY IF EXISTS "Org owner sees clinic bookings" ON public.bookings;
CREATE POLICY "Patient sees own bookings"
  ON public.bookings FOR SELECT
  USING (patient_id = auth.uid());
-- Org-owner reads go through the service-role API (api/bookings.js); the
-- existing organizations table does not expose an owner_id column to bind on.

-- 4. Orders table (shop checkout requests)
CREATE TABLE IF NOT EXISTS public.orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,
  org_id          uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  customer_name   text,
  customer_email  text NOT NULL,
  customer_phone  text,
  items           jsonb NOT NULL,
  subtotal_cents  integer NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','cancelled','fulfilled')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON public.orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_org_idx  ON public.orders (org_id, created_at DESC);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User sees own orders"  ON public.orders;
DROP POLICY IF EXISTS "Org owner sees orders" ON public.orders;
CREATE POLICY "User sees own orders"
  ON public.orders FOR SELECT
  USING (user_id = auth.uid());

-- 5. user_points (loyalty balance, scoped per user × org). Mirrors mobile pointsService.
CREATE TABLE IF NOT EXISTS public.user_points (
  user_id           uuid NOT NULL,
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  points            integer NOT NULL DEFAULT 0,
  total_spent_cents integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
ALTER TABLE public.user_points ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User sees own points" ON public.user_points;
CREATE POLICY "User sees own points"
  ON public.user_points FOR SELECT
  USING (user_id = auth.uid());

-- 6. wallet_transactions (history for the wallet tab)
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  amount_cents   integer NOT NULL,
  description    text,
  points_earned  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_user_org_idx
  ON public.wallet_transactions (user_id, org_id, created_at DESC);

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User sees own transactions" ON public.wallet_transactions;
CREATE POLICY "User sees own transactions"
  ON public.wallet_transactions FOR SELECT
  USING (user_id = auth.uid());

-- 7. clinic_rewards (catalog of redeemable rewards per clinic)
CREATE TABLE IF NOT EXISTS public.clinic_rewards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  points_required integer NOT NULL CHECK (points_required > 0),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.clinic_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Active rewards are public" ON public.clinic_rewards;
CREATE POLICY "Active rewards are public"
  ON public.clinic_rewards FOR SELECT
  USING (active = true);

-- Done. Inserts on bookings/orders/user_points/wallet_transactions are performed
-- by the serverless API (api/bookings.js, api/checkout.js) using the
-- service-role key, which bypasses these read-only RLS policies.
