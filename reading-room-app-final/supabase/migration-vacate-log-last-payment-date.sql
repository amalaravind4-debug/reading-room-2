-- Migration: vacate_log gets one new column, last_payment_date.
--
-- Context: seats now carry an editable "payment date" (separate from the
-- due date) that's set when a payment is recorded on the seat's assign/edit
-- form. This column carries that date over into the permanent vacated-seats
-- record when a seat is cleared, so the last-payment date isn't lost once
-- the seat is reassigned.
--
-- Safe to run even if you've already run the full schema.sql — this uses
-- IF NOT EXISTS, so it's a no-op if you already have the column.
--
-- Run in Supabase SQL Editor → New query → paste → Run.

alter table public.vacate_log add column if not exists last_payment_date date;
