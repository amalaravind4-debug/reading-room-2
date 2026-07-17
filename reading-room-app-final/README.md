# Reading Room Manager

A single-owner tool for managing a reading room: seat/cabin layout, occupant and payment tracking, a caution deposit register, an auto-generated vacancy list, payment analytics, and SMS/WhatsApp due-date reminders. Built with React, Vite, and Tailwind CSS. No login, no accounts.

**Data storage:** rooms, seats, occupants, payments, deposits, and reminder wording are synced to **Supabase** (a Postgres database) so they survive refreshes and follow you across devices. **Aadhaar number, address, and ID document photos (Aadhaar front/back, address proof) are the exception — none of that is ever sent to Supabase.** It's kept only in this browser's `localStorage`, on the device where it was entered.

## One-time setup: create the Supabase tables

1. Open your Supabase project → **SQL Editor** → **New query**
2. Paste the contents of `supabase/schema.sql` (in this folder) → **Run**

This creates four tables: `app_state` (rooms, seats, occupants, payments), `vacate_log` (the permanent vacated-seats history), `payment_log` (a receipt trail — one row per payment actually received), and `seat_attendance` (check-ins from a Google Form — see below). All four use the same anon-key, no-login access model.

## Required: set your Supabase credentials

The app has **no built-in Supabase credentials** — you must set these or the app only shows sample data and saves nothing:

- **Locally:** copy `.env.example` to `.env.local` and fill in your values (Supabase project → Settings → API)
- **On Vercel:** Project → Settings → Environment Variables → add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (any environment — Production/Preview/Development), then redeploy. Vercel only picks up env vars at build time, so a fresh deploy is required after adding/changing them.
- **On Netlify:** Site configuration → Environment variables → same two keys, then trigger a new deploy

If these aren't set, the app shows a banner at the top saying so and runs on sample data only.

## Collecting attendance via Google Form

A Google Form can post seat check-ins straight into `seat_attendance` — no server of your own needed, just a small script Google runs for you.

1. Create a Google Form with these question titles exactly: **Room Name**, **Seat Number**, **Occupant Name**, **Present?** (multiple choice: Yes/No), **Note** (optional)
2. Open the form's Script editor (⋮ menu → Script editor) and paste in `supabase/google-form-attendance.gs`
3. Fill in your `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of that script
4. Add a trigger: Triggers → Add Trigger → function `onFormSubmit`, event "On form submit"

Every submission now lands in the app's **Attendance** tab. Full details are in the comments at the top of that script file.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## Build for production

```bash
npm run build
```

Outputs a static site to `dist/`. Preview it with `npm run preview`.

## What's in here

- **Rooms** — layout builder (add/remove seats, entry points, AC units, washrooms), pinch/scroll zoom with fit-to-screen, seat numbering, Google Maps location per room (search link or GPS pin — no API key needed), delete a room
- **Payments** — status (**Paid** / **Due soon** / **Overdue**) is computed automatically from the due date, not set by hand — comfortably ahead of the due date reads "Paid," within 3 days reads "Due soon," past it reads "Overdue." The only manual step is ticking "Record a payment today," which asks for the **mode of payment** (Cash/UPI) and auto-fills the next due date to 30 days out (still editable). Every recorded payment creates a permanent receipt entry, viewable with a date-range filter, a running total, and a PDF export
- **Analytics** — occupancy %, revenue collected/due/overdue, deposit totals
- **Vacancy** — auto-generated list of every open seat across all rooms
- **Deposits** — caution deposit register per occupant
- **Reminders** — editable message template, auto-lists anyone due in 3 days, 1 day, today, or overdue, with one-tap **WhatsApp** and **SMS** buttons (open your phone's own apps with the message pre-filled)
- **Vacated** — permanent history of every seat that's been vacated (with a confirmation step and a "was the deposit refunded?" choice at the moment you vacate); filter by date range and download that range as one PDF; records older than 3 months are removed automatically
- **Attendance** — read-only view of seat check-ins collected from a Google Form (see "Collecting attendance via Google Form" below) — this app never writes attendance itself, only displays and lets you delete records
- **ID documents** — Aadhaar number, address, and Aadhaar front/back + address-proof photos per occupant (all stored locally only, see above); a "Seat PDF" export downloads every seat's full details (occupant, payment status, payment mode, deposit, Aadhaar number, address) as one table; a separate "ID docs" export bundles all uploaded photos into a zip named by occupant
- **Message an occupant directly** — open any occupied seat and there are one-tap **WhatsApp**/**SMS** buttons right there, using the same editable template as the Reminders tab
- **Seat colors** — vacant seats are tinted red, occupied seats green, for an at-a-glance read of the room

## Deploy it (optional — for using it across your own devices, or to package as an APK)

Push this folder to a GitHub repo, then deploy for free on:

- **Vercel** — [vercel.com/new](https://vercel.com/new), import the repo, it auto-detects Vite. No config needed.
- **Netlify** — [app.netlify.com](https://app.netlify.com), "Add new site" → import from Git. Build command: `npm run build`, publish directory: `dist`.

Since your data now lives in Supabase (except ID photos), the rooms/seats/payments you enter will show up the same way on every device you open the deployed site from. ID photos stay local to whichever device/browser you uploaded them on.

## Turn it into an installable APK

This project is set up as a PWA (manifest + icons in `public/icons/`):

1. Deploy it (previous step) to get a live URL
2. Go to **[pwabuilder.com](https://www.pwabuilder.com)**, paste your URL
3. Generate an Android package (APK/AAB) — signed, ready to install or publish

## Security note

There's no login, so the Supabase anon key (safe to expose in client code by design) is the only thing standing between "anyone with your deployed URL" and your data — the SQL setup grants that key full read/write on the `app_state` table. That's an acceptable tradeoff for a personal tool only you use, but don't share the deployed link publicly, and don't reuse this exact setup for anything with real multiple users.
