-- ═══════════════════════════════════════════════════════════════════════════
-- Acuros Post-Op Care — E2E-encrypted patient ↔ clinic recovery channel
-- ═══════════════════════════════════════════════════════════════════════════
-- The server stores ONLY ciphertext. Message bodies and photos are encrypted
-- in the browser with AES-256-GCM using a key derived via ECDH (P-256) + HKDF
-- between the patient's and the clinic owner's device-held private keys
-- (see public/js/postop-crypto.js). postop_keys holds PUBLIC JWKs only.
-- Photos live as encrypted blobs in the PRIVATE `postop-media` bucket; access
-- is gated by storage RLS on the case folder, so no serverless endpoint or
-- signed-URL minting is required — authenticated clients download ciphertext
-- directly and decrypt locally.
--
-- Run via Supabase MCP apply_migration (or SQL editor). Idempotent.

-- ── 1. Public-key directory ────────────────────────────────────────────────
-- One row per user. Clinic owners also stamp org_id so patients can find the
-- clinic's key without needing read access to organizations.owner_id.
create table if not exists public.postop_keys (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid references public.organizations(id) on delete set null,
  public_jwk jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.postop_keys enable row level security;

drop policy if exists "authenticated read postop keys" on public.postop_keys;
create policy "authenticated read postop keys" on public.postop_keys
  for select to authenticated using (true);

-- org_id may only be claimed by the actual org owner (anti-impersonation:
-- without this check anyone could publish a key pretending to be the clinic).
drop policy if exists "user inserts own postop key" on public.postop_keys;
create policy "user inserts own postop key" on public.postop_keys
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (org_id is null
         or org_id in (select id from public.organizations where owner_id = auth.uid()))
  );

drop policy if exists "user updates own postop key" on public.postop_keys;
create policy "user updates own postop key" on public.postop_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (org_id is null
         or org_id in (select id from public.organizations where owner_id = auth.uid()))
  );

create index if not exists postop_keys_org_idx on public.postop_keys (org_id);

-- ── 1b. Bookings self-read by patient_id ───────────────────────────────────
-- Bookings are inserted by the service-role API with patient_id stamped and
-- user_id left null, but the original self-read policy only checked user_id.
-- Without this, signed-in patients can't see their own bookings under RLS and
-- the postop_cases insert gate's booking branch can never match.
drop policy if exists "patient reads own bookings by patient_id" on public.bookings;
create policy "patient reads own bookings by patient_id" on public.bookings
  for select to authenticated using (patient_id = auth.uid());

-- ── 2. Cases ────────────────────────────────────────────────────────────────
-- A case = one recovery episode (usually one procedure) between a patient and
-- a clinic. Public keys are snapshotted onto the case at creation so a later
-- key rotation can't silently break decryption of an existing thread.
create table if not exists public.postop_cases (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  patient_id           uuid not null references auth.users(id) on delete cascade,
  booking_id           uuid references public.bookings(id) on delete set null,
  procedure_name       text not null,
  procedure_category   text,
  surgery_date         date,
  status               text not null default 'active' check (status in ('active','resolved')),
  patient_pub_jwk      jsonb,
  clinic_pub_jwk       jsonb,
  patient_last_seen_at timestamptz default now(),
  clinic_last_seen_at  timestamptz,
  created_at           timestamptz not null default now()
);

alter table public.postop_cases enable row level security;

drop policy if exists "patient reads own postop cases" on public.postop_cases;
create policy "patient reads own postop cases" on public.postop_cases
  for select to authenticated using (patient_id = auth.uid());

drop policy if exists "owner reads org postop cases" on public.postop_cases;
create policy "owner reads org postop cases" on public.postop_cases
  for select to authenticated
  using (org_id in (select id from public.organizations where owner_id = auth.uid()));

-- A patient may only open a case with a clinic they have a real relationship
-- with: a booking, a clinic membership, or the legacy profile link.
drop policy if exists "patient opens postop case" on public.postop_cases;
create policy "patient opens postop case" on public.postop_cases
  for insert to authenticated
  with check (
    patient_id = auth.uid()
    and (
      exists (select 1 from public.bookings b
              where b.org_id = postop_cases.org_id
                and (b.user_id = auth.uid() or b.patient_id = auth.uid()))
      or exists (select 1 from public.clinic_memberships m
                 where m.org_id = postop_cases.org_id and m.user_id = auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.org_id = postop_cases.org_id)
    )
  );

drop policy if exists "patient updates own postop case" on public.postop_cases;
create policy "patient updates own postop case" on public.postop_cases
  for update to authenticated
  using (patient_id = auth.uid())
  with check (patient_id = auth.uid());

drop policy if exists "owner updates org postop case" on public.postop_cases;
create policy "owner updates org postop case" on public.postop_cases
  for update to authenticated
  using (org_id in (select id from public.organizations where owner_id = auth.uid()))
  with check (org_id in (select id from public.organizations where owner_id = auth.uid()));

create index if not exists postop_cases_org_idx     on public.postop_cases (org_id, created_at desc);
create index if not exists postop_cases_patient_idx on public.postop_cases (patient_id, created_at desc);

-- ── 3. Messages ─────────────────────────────────────────────────────────────
-- body_cipher = base64(12-byte IV || AES-GCM ciphertext) of the text.
-- Image messages carry media_path (encrypted blob in postop-media) instead.
create table if not exists public.postop_messages (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.postop_cases(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  sender_id   uuid not null references auth.users(id) on delete cascade,
  sender_role text not null check (sender_role in ('patient','clinic')),
  kind        text not null default 'text' check (kind in ('text','image')),
  body_cipher text,
  media_path  text,
  media_mime  text,
  created_at  timestamptz not null default now()
);

alter table public.postop_messages enable row level security;

drop policy if exists "case parties read postop messages" on public.postop_messages;
create policy "case parties read postop messages" on public.postop_messages
  for select to authenticated
  using (
    exists (select 1 from public.postop_cases c
            where c.id = postop_messages.case_id
              and (c.patient_id = auth.uid()
                   or c.org_id in (select id from public.organizations where owner_id = auth.uid())))
  );

drop policy if exists "patient sends postop message" on public.postop_messages;
create policy "patient sends postop message" on public.postop_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and sender_role = 'patient'
    and exists (select 1 from public.postop_cases c
                where c.id = postop_messages.case_id
                  and c.org_id = postop_messages.org_id
                  and c.patient_id = auth.uid()
                  and c.status = 'active')
  );

drop policy if exists "clinic sends postop message" on public.postop_messages;
create policy "clinic sends postop message" on public.postop_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and sender_role = 'clinic'
    and exists (select 1 from public.postop_cases c
                where c.id = postop_messages.case_id
                  and c.org_id = postop_messages.org_id
                  and c.status = 'active'
                  and c.org_id in (select id from public.organizations where owner_id = auth.uid()))
  );

drop policy if exists "sender deletes own postop message" on public.postop_messages;
create policy "sender deletes own postop message" on public.postop_messages
  for delete to authenticated using (sender_id = auth.uid());

create index if not exists postop_messages_case_idx on public.postop_messages (case_id, created_at);

-- Live thread updates in both the portal and the dashboard.
do $$
begin
  alter publication supabase_realtime add table public.postop_messages;
exception when duplicate_object then null;
end $$;

-- ── 4. Private media bucket ─────────────────────────────────────────────────
-- Blobs are ciphertext (application/octet-stream) under case_<caseId>/<uuid>.bin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('postop-media', 'postop-media', false, 15728640, array['application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Case parties read postop media" on storage.objects;
create policy "Case parties read postop media" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'postop-media'
    and (storage.foldername(name))[1] like 'case_%'
    and (substr((storage.foldername(name))[1], 6))::uuid in (
      select c.id from public.postop_cases c
      where c.patient_id = auth.uid()
         or c.org_id in (select id from public.organizations where owner_id = auth.uid())
    )
  );

drop policy if exists "Case parties upload postop media" on storage.objects;
create policy "Case parties upload postop media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'postop-media'
    and (storage.foldername(name))[1] like 'case_%'
    and (substr((storage.foldername(name))[1], 6))::uuid in (
      select c.id from public.postop_cases c
      where c.patient_id = auth.uid()
         or c.org_id in (select id from public.organizations where owner_id = auth.uid())
    )
  );

drop policy if exists "Uploader deletes own postop media" on storage.objects;
create policy "Uploader deletes own postop media" on storage.objects
  for delete to authenticated
  using (bucket_id = 'postop-media' and owner = auth.uid());
