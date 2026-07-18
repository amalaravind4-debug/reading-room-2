-- Reading Room Manager — full Supabase schema
-- Safe to run against a fresh project OR one that already has some of these
-- tables: every CREATE TABLE uses IF NOT EXISTS, so existing tables and their
-- data are left untouched. Policies use DROP POLICY IF EXISTS before CREATE
-- POLICY, so this whole file is safe to re-run any number of times.
--
-- Run this in your Supabase project's SQL Editor (Dashboard → SQL Editor →
-- New query → paste this whole file → Run).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. app_state — rooms, seats, occupants, live payment/deposit data.
--    One row (id = 'main') holding everything as JSONB.
-- ---------------------------------------------------------------------------

create table if not exists public.app_state (
  id text primary key,
  rooms jsonb not null default '[]'::jsonb,
  selected_room_id text,
  reminder_template text,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "anon can read app_state" on public.app_state;
create policy "anon can read app_state"
  on public.app_state for select
  to anon
  using (true);

drop policy if exists "anon can insert app_state" on public.app_state;
create policy "anon can insert app_state"
  on public.app_state for insert
  to anon
  with check (true);

drop policy if exists "anon can update app_state" on public.app_state;
create policy "anon can update app_state"
  on public.app_state for update
  to anon
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 2. vacate_log — permanent record of every seat that's been vacated, kept
--    even after the seat itself gets reassigned. Aadhaar number and address
--    are NOT stored here — those stay local-only in the browser.
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
  last_payment_date date,
  deposit_amount numeric,
  deposit_refunded boolean not null default false,
  vacated_at timestamptz not null default now()
);

-- If you already have an older vacate_log without this column, this adds it
-- without touching existing rows (they'll just be null there).
alter table public.vacate_log add column if not exists last_payment_date date;

alter table public.vacate_log enable row level security;

drop policy if exists "anon can read vacate_log" on public.vacate_log;
create policy "anon can read vacate_log"
  on public.vacate_log for select
  to anon
  using (true);

drop policy if exists "anon can insert vacate_log" on public.vacate_log;
create policy "anon can insert vacate_log"
  on public.vacate_log for insert
  to anon
  with check (true);

drop policy if exists "anon can update vacate_log" on public.vacate_log;
create policy "anon can update vacate_log"
  on public.vacate_log for update
  to anon
  using (true)
  with check (true);

drop policy if exists "anon can delete vacate_log" on public.vacate_log;
create policy "anon can delete vacate_log"
  on public.vacate_log for delete
  to anon
  using (true);

-- ---------------------------------------------------------------------------
-- 3. seat_attendance — check-ins collected from a Google Form (see
--    supabase/google-form-attendance.gs). The app only ever reads/deletes
--    here; the form is what writes.
-- ---------------------------------------------------------------------------

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

drop policy if exists "anon can read seat_attendance" on public.seat_attendance;
create policy "anon can read seat_attendance"
  on public.seat_attendance for select
  to anon
  using (true);

drop policy if exists "anon can insert seat_attendance" on public.seat_attendance;
create policy "anon can insert seat_attendance"
  on public.seat_attendance for insert
  to anon
  with check (true);

drop policy if exists "anon can delete seat_attendance" on public.seat_attendance;
create policy "anon can delete seat_attendance"
  on public.seat_attendance for delete
  to anon
  using (true);

-- ---------------------------------------------------------------------------
-- 4. payment_log — a permanent receipt trail. One row per moment a seat is
--    newly marked "Paid" (not on every edit — only the actual transition
--    into paid). Separate from the live seat status so a date-range
--    "payments received" report stays accurate even after seats are
--    reassigned or paid again next month.
--
--    due_date_at_payment: the due date that was outstanding and just got
--      paid off (i.e. what this payment was FOR).
--    next_due_date: what the due date rolled forward to as a result of this
--      payment — normally due_date_at_payment + 30 days, but can differ if
--      it was manually adjusted at the time.
--    paid_at: the date the payment was actually received — editable right on
--      the seat's "record a payment" form (registration or renewal, defaults
--      to today), and correctable afterward too from the app's Payments tab.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_log (
  id text primary key,
  room_name text not null,
  seat_number text not null,
  occupant text,
  amount numeric not null default 0,
  mode text not null default 'cash',
  paid_at timestamptz not null default now(),
  due_date_at_payment date,
  next_due_date date
);

-- If you already have an older payment_log without these two columns, this
-- adds them without touching existing rows (they'll just be null there).
alter table public.payment_log add column if not exists due_date_at_payment date;
alter table public.payment_log add column if not exists next_due_date date;

alter table public.payment_log enable row level security;

drop policy if exists "anon can read payment_log" on public.payment_log;
create policy "anon can read payment_log"
  on public.payment_log for select
  to anon
  using (true);

drop policy if exists "anon can insert payment_log" on public.payment_log;
create policy "anon can insert payment_log"
  on public.payment_log for insert
  to anon
  with check (true);

drop policy if exists "anon can update payment_log" on public.payment_log;
create policy "anon can update payment_log"
  on public.payment_log for update
  to anon
  using (true)
  with check (true);

drop policy if exists "anon can delete payment_log" on public.payment_log;
create policy "anon can delete payment_log"
  on public.payment_log for delete
  to anon
  using (true);
