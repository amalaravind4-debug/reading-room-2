-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).

create table if not exists public.app_state (
  id text primary key,
  rooms jsonb not null default '[]'::jsonb,
  selected_room_id text,
  reminder_template text,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- This app has no login — the anon key is the only key it ever uses, from
-- everyone's browser. These policies make the "app_state" table fully
-- readable and writable by anyone who has that key (which is visible in the
-- deployed site's JavaScript — anon keys are meant to be public, but this
-- table has no per-user separation, so treat it as "anyone with the link can
-- edit your data"). That's fine for a personal single-owner tool that only
-- you will actually use, but don't reuse this exact policy for anything with
-- real multi-user data.

create policy "anon can read app_state"
  on public.app_state for select
  to anon
  using (true);

create policy "anon can insert app_state"
  on public.app_state for insert
  to anon
  with check (true);

create policy "anon can update app_state"
  on public.app_state for update
  to anon
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Vacated-seats log — a permanent record of every occupant who's vacated a
-- seat, kept even after the seat itself gets reassigned to someone new.
-- Aadhaar number and address are NOT stored here (same rule as everywhere
-- else in this app) — only non-sensitive occupancy/payment/deposit history.
-- ---------------------------------------------------------------------------

create table if not exists public.vacate_log (
  id text primary key,
  room_id text,
  room_name text,
  seat_number text,
  occupant text,
  phone text,
  fee numeric,
  payment_status text,
  due_date date,
  deposit_amount numeric,
  deposit_refunded boolean not null default false,
  vacated_at timestamptz not null default now()
);

alter table public.vacate_log enable row level security;

-- Same anon-key, no-login tradeoff as app_state above.
create policy "anon can read vacate_log"
  on public.vacate_log for select
  to anon
  using (true);

create policy "anon can insert vacate_log"
  on public.vacate_log for insert
  to anon
  with check (true);

create policy "anon can update vacate_log"
  on public.vacate_log for update
  to anon
  using (true)
  with check (true);

create policy "anon can delete vacate_log"
  on public.vacate_log for delete
  to anon
  using (true);

-- ---------------------------------------------------------------------------
-- Seat attendance / presence check-ins — collected from a Google Form (see
-- supabase/google-form-attendance.gs for the script that posts form
-- responses here). Each row is one check-in submission.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table if not exists public.seat_attendance (
  id uuid primary key default gen_random_uuid(),
  room_name text not null,
  seat_number text not null,
  occupant text,
  present boolean not null default true,
  note text,
  submitted_at timestamptz not null default now(),
  source text not null default 'google_form'
);

alter table public.seat_attendance enable row level security;

-- Same anon-key, no-login tradeoff as the other tables in this app. The
-- Google Form script below writes here using only the anon key, same as the
-- app itself.
create policy "anon can read seat_attendance"
  on public.seat_attendance for select
  to anon
  using (true);

create policy "anon can insert seat_attendance"
  on public.seat_attendance for insert
  to anon
  with check (true);

create policy "anon can delete seat_attendance"
  on public.seat_attendance for delete
  to anon
  using (true);

-- ---------------------------------------------------------------------------
-- Payment log — a permanent receipt trail. One row is added every time a seat
-- is newly marked "Paid" in the app (not on every edit — only on the actual
-- transition into paid). This is separate from the live seat status (which
-- can be overwritten) so a date-range "payments received" report stays
-- accurate even after seats are reassigned or paid again next month.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_log (
  id text primary key,
  room_name text not null,
  seat_number text not null,
  occupant text,
  amount numeric not null default 0,
  mode text not null default 'cash',
  paid_at timestamptz not null default now()
);

alter table public.payment_log enable row level security;

-- Same anon-key, no-login tradeoff as the other tables in this app.
create policy "anon can read payment_log"
  on public.payment_log for select
  to anon
  using (true);

create policy "anon can insert payment_log"
  on public.payment_log for insert
  to anon
  with check (true);

create policy "anon can delete payment_log"
  on public.payment_log for delete
  to anon
  using (true);
