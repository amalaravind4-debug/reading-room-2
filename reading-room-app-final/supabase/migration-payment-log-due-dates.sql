-- Migration: payment_log gets two new columns.
-- Safe to run even if you've already run the full schema.sql before —
-- these use IF NOT EXISTS, so this is a no-op if you already have them.
--
-- Run in Supabase SQL Editor → New query → paste → Run.

alter table public.payment_log add column if not exists due_date_at_payment date;
alter table public.payment_log add column if not exists next_due_date date;
