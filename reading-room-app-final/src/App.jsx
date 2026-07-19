import React, { useState, useMemo, useEffect } from "react";
import JSZip from "jszip";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  Plus,
  Minus,
  X,
  MapPin,
  Settings2,
  LogIn,
  Wind,
  Armchair,
  Bath,
  CreditCard,
  Minimize2,
  Check,
  Clock,
  AlertTriangle,
  AlertOctagon,
  PiggyBank,
  Bell,
  Copy,
  Pencil,
  MessageCircle,
  Phone,
  BarChart3,
  Grid3x3,
  Trash2,
  Camera,
  Fingerprint,
  Download,
  FileText,
  UserX,
  ClipboardCheck,
  RefreshCw,
} from "lucide-react";

// ---------- Date helpers ----------

function daysUntilDue(isoDate) {
  if (!isoDate) return null;
  const due = new Date(isoDate + "T00:00:00");
  if (isNaN(due.getTime())) return null;
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - todayMid) / 86400000);
}

function formatDueDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// "YYYY-MM" → "July 2026", for displaying which month the renewal batch last ran for.
function formatMonthKey(monthKey) {
  if (!monthKey) return "not yet";
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// Adds N days to an ISO date string (yyyy-mm-dd) and returns the result as an
// ISO date string. With no base date given, adds to today. Used to prefill
// "next due date" the moment a payment is recorded (still editable afterward)
// — normally 30 days out from the *previous* due date, not from today.
function addDaysISO(days, baseIsoDate) {
  const d = baseIsoDate ? new Date(baseIsoDate + "T00:00:00") : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Today, as an ISO date string — used to prefill an editable "payment date".
function todayISO() {
  return addDaysISO(0);
}

// Combines a date-only string with a fixed midday time before converting to a
// full timestamp, so the chosen calendar date survives the UTC round-trip
// regardless of the browser's timezone.
function isoDateTimeAtNoon(dateOnly) {
  return new Date(`${dateOnly}T12:00:00`).toISOString();
}

// "YYYY-MM" for today — used to detect "a new month has begun since we last
// checked" for the automatic due-date renewal.
function currentMonthKey() {
  return todayISO().slice(0, 7);
}

// Given a "YYYY-MM" month key, returns the "YYYY-MM" key for the month right
// before it — used to check "did this member pay during the previous month".
function previousMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1 - 1, 1); // m is 1-indexed; -1 more steps back a month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function applyReminderTemplate(tpl, o) {
  return tpl
    .split("{name}").join(o.occupant || "")
    .split("{seat}").join(o.number || o.seatId || "")
    .split("{room}").join(o.roomName || "")
    .split("{amount}").join(String(o.fee || ""))
    .split("{dueDate}").join(formatDueDate(o.dueDate));
}

// ---------- File/image helpers ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Shrinks + re-encodes an uploaded photo as JPEG so ID documents don't blow up
// localStorage's ~5MB quota. Falls back to the original data if anything goes wrong.
function compressImage(dataUrl, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch {
      resolve(dataUrl);
    }
  });
}

// ---------- Supabase (rooms, occupants, payments, deposits, reminder wording) ----------
// Talked to directly over Supabase's REST API (no SDK needed). No credentials
// are hardcoded here — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY as
// environment variables (see .env.example). The anon key is meant to be
// public once set — Supabase's Row Level Security policy on the table is
// what actually controls access, not secrecy of this key — but keeping it
// out of the source means it's not baked into your git history and can be
// changed per-deployment without touching code.

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || "";
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const SB_REST = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// Fetches the single saved app-state row. Returns null if it doesn't exist yet
// (first run, or the setup SQL hasn't been applied) instead of throwing.
async function fetchAppState() {
  const res = await fetch(`${SB_REST}/app_state?id=eq.main&select=*`, { headers: SB_HEADERS });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Upserts the single app-state row. Throws on failure so callers can surface a warning.
async function saveAppState({ rooms, selectedRoomId, reminderTemplate, renewalCycleDays, lastRenewalMonth }) {
  const res = await fetch(`${SB_REST}/app_state`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        id: "main",
        rooms,
        selected_room_id: selectedRoomId,
        reminder_template: reminderTemplate,
        renewal_cycle_days: renewalCycleDays,
        last_renewal_month: lastRenewalMonth,
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  if (!res.ok) throw new Error(`Supabase save failed (${res.status})`);
}

// ---------- Vacated-seats log (Supabase table: vacate_log) ----------
// Aadhaar number and address are stripped out before every save here too — same
// local-only rule as everywhere else in this app.

function vacateRecordToRow(r) {
  return {
    id: r.id,
    room_id: r.roomId,
    room_name: r.roomName,
    seat_number: r.seatNumber,
    occupant: r.occupant,
    phone: r.phone,
    fee: r.fee,
    payment_status: r.paymentStatus,
    due_date: r.dueDate || null,
    last_payment_date: r.lastPaymentDate || null,
    deposit_amount: r.depositAmount,
    deposit_refunded: r.depositRefunded,
    vacated_at: r.vacatedAt,
  };
}

function rowToVacateRecord(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name,
    seatNumber: row.seat_number,
    occupant: row.occupant,
    phone: row.phone,
    fee: row.fee,
    paymentStatus: row.payment_status,
    dueDate: row.due_date,
    lastPaymentDate: row.last_payment_date,
    depositAmount: row.deposit_amount,
    depositRefunded: row.deposit_refunded,
    vacatedAt: row.vacated_at,
  };
}

async function fetchVacateLog() {
  const res = await fetch(`${SB_REST}/vacate_log?select=*&order=vacated_at.desc`, { headers: SB_HEADERS });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(rowToVacateRecord) : [];
}

// ---------- Seat attendance (filled in externally by a Google Form — see
// supabase/google-form-attendance.gs). The app only ever reads/deletes here,
// it never writes attendance rows itself. ----------

function rowToAttendanceRecord(row) {
  return {
    id: row.id,
    roomName: row.room_name,
    seatNumber: row.seat_number,
    occupant: row.occupant,
    present: row.present,
    note: row.note,
    submittedAt: row.submitted_at,
  };
}

async function fetchAttendance() {
  const res = await fetch(`${SB_REST}/seat_attendance?select=*&order=submitted_at.desc&limit=200`, {
    headers: SB_HEADERS,
  });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(rowToAttendanceRecord) : [];
}

async function deleteAttendanceRemote(id) {
  const res = await fetch(`${SB_REST}/seat_attendance?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete failed (${res.status})`);
}

async function saveVacateRecord(record) {
  const { aadhaarNumber, address, ...clean } = record;
  const res = await fetch(`${SB_REST}/vacate_log`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([vacateRecordToRow(clean)]),
  });
  if (!res.ok) throw new Error(`Supabase save failed (${res.status})`);
}

async function deleteVacateRecordRemote(id) {
  const res = await fetch(`${SB_REST}/vacate_log?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete failed (${res.status})`);
}

// ---------- Payment log (Supabase table: payment_log) ----------
// One row per moment a seat gets marked "Paid" — a permanent receipt trail,
// separate from the seat's current (and overwritable) live status.

function paymentRecordToRow(r) {
  return {
    id: r.id,
    room_name: r.roomName,
    seat_number: r.seatNumber,
    occupant: r.occupant,
    amount: r.amount,
    mode: r.mode,
    paid_at: r.paidAt,
    due_date_at_payment: r.dueDateAtPayment || null,
    next_due_date: r.nextDueDate || null,
  };
}

function rowToPaymentRecord(row) {
  return {
    id: row.id,
    roomName: row.room_name,
    seatNumber: row.seat_number,
    occupant: row.occupant,
    amount: row.amount,
    mode: row.mode,
    paidAt: row.paid_at,
    dueDateAtPayment: row.due_date_at_payment,
    nextDueDate: row.next_due_date,
  };
}

async function fetchPaymentLog() {
  const res = await fetch(`${SB_REST}/payment_log?select=*&order=paid_at.desc&limit=500`, { headers: SB_HEADERS });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(rowToPaymentRecord) : [];
}

async function savePaymentRecord(record) {
  const res = await fetch(`${SB_REST}/payment_log`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([paymentRecordToRow(record)]),
  });
  if (!res.ok) throw new Error(`Supabase save failed (${res.status})`);
}

async function deletePaymentRecordRemote(id) {
  const res = await fetch(`${SB_REST}/payment_log?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete failed (${res.status})`);
}

// ---------- Payment log retention (3 months max, same window as the vacate log) ----------

const PAYMENT_RETENTION_MONTHS = 3;

function paymentRetentionCutoff() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PAYMENT_RETENTION_MONTHS);
  return cutoff;
}

function isPastPaymentRetention(isoDateTime) {
  const d = new Date(isoDateTime);
  return isNaN(d.getTime()) ? false : d < paymentRetentionCutoff();
}

// ---------- Monthly revenue archive ----------
// payment_log only holds ~3 months of detailed rows (see retention above), so
// a revenue chart sourced from it alone would go blank for anything older.
// Right before a batch of payment records ages out, this rolls their amounts
// into a permanent per-month total in Supabase — so the chart keeps full
// history even though the line-item detail behind it is gone. Requires a
// `monthly_revenue_archive` table: month_key text primary key, total_amount
// numeric, payment_count integer.

function monthKeyOf(isoDateTime) {
  const d = new Date(isoDateTime);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}

async function fetchMonthlyRevenueArchive() {
  const res = await fetch(`${SB_REST}/monthly_revenue_archive?select=*&order=month_key.asc`, {
    headers: SB_HEADERS,
  });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows)
    ? rows.map((r) => ({ monthKey: r.month_key, totalAmount: r.total_amount || 0, paymentCount: r.payment_count || 0 }))
    : [];
}

// Adds `records`' amounts on top of whatever's already archived for their
// month (never overwrites) — best-effort, since a partial failure here just
// means that month's archived total under-counts until the next purge run.
async function archiveMonthlyRevenue(records) {
  const byMonth = new Map();
  records.forEach((r) => {
    const key = monthKeyOf(r.paidAt);
    if (!key) return;
    const cur = byMonth.get(key) || { totalAmount: 0, paymentCount: 0 };
    cur.totalAmount += r.amount || 0;
    cur.paymentCount += 1;
    byMonth.set(key, cur);
  });
  if (byMonth.size === 0) return;

  await Promise.allSettled(
    Array.from(byMonth.entries()).map(async ([monthKey, delta]) => {
      const res = await fetch(`${SB_REST}/monthly_revenue_archive?month_key=eq.${monthKey}&select=*`, {
        headers: SB_HEADERS,
      });
      const rows = res.ok ? await res.json().catch(() => []) : [];
      const existing = Array.isArray(rows) && rows[0] ? rows[0] : null;
      const totalAmount = (existing?.total_amount || 0) + delta.totalAmount;
      const paymentCount = (existing?.payment_count || 0) + delta.paymentCount;
      await fetch(`${SB_REST}/monthly_revenue_archive`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ month_key: monthKey, total_amount: totalAmount, payment_count: paymentCount }]),
      });
    })
  );
}

// Drops any payment record older than the retention window. Its total is
// archived into monthly_revenue_archive first (see above), then the detailed
// row is deleted from Supabase (best-effort). Only ever touches payment_log
// rows by paid_at — never rewrites a seat's live data.
async function purgeOldPaymentRecords(records) {
  const stale = records.filter((r) => isPastPaymentRetention(r.paidAt));
  if (stale.length === 0) return records;

  await archiveMonthlyRevenue(stale);
  await Promise.allSettled(stale.map((r) => deletePaymentRecordRemote(r.id)));

  const staleIds = new Set(stale.map((r) => r.id));
  return records.filter((r) => !staleIds.has(r.id));
}

// Local-only store for the Aadhaar number / address attached to vacated records —
// same rule as everywhere else: never sent to Supabase, kept in this browser only.
const VACATE_DOCS_STORAGE_KEY = "reading-room-manager:vacate-docs:v1";

function loadVacateLocalDocs() {
  try {
    const raw = localStorage.getItem(VACATE_DOCS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveVacateLocalDocs(docsMap) {
  try {
    localStorage.setItem(VACATE_DOCS_STORAGE_KEY, JSON.stringify(docsMap));
    return true;
  } catch {
    return false;
  }
}

function mergeVacateDocs(records, docsMap) {
  return records.map((r) => (docsMap[r.id] ? { ...r, ...docsMap[r.id] } : r));
}

// ---------- Vacated-seats retention (3 months max) ----------

const VACATE_RETENTION_MONTHS = 3;

function vacateRetentionCutoff() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - VACATE_RETENTION_MONTHS);
  return cutoff;
}

function isPastVacateRetention(isoDateTime) {
  const d = new Date(isoDateTime);
  return isNaN(d.getTime()) ? false : d < vacateRetentionCutoff();
}

// Drops any vacated-seat record older than the retention window, deleting it from
// Supabase (best-effort) and from local ID-doc storage, and returns what's left.
async function purgeOldVacateRecords(records) {
  const stale = records.filter((r) => isPastVacateRetention(r.vacatedAt));
  if (stale.length === 0) return records;

  await Promise.allSettled(stale.map((r) => deleteVacateRecordRemote(r.id)));

  const docs = loadVacateLocalDocs();
  let docsChanged = false;
  stale.forEach((r) => {
    if (docs[r.id]) {
      delete docs[r.id];
      docsChanged = true;
    }
  });
  if (docsChanged) saveVacateLocalDocs(docs);

  const staleIds = new Set(stale.map((r) => r.id));
  return records.filter((r) => !staleIds.has(r.id));
}

// ---------- Local-only ID document storage ----------
// Aadhaar/address photos NEVER get sent to Supabase — they're stripped out before
// every save and instead kept only in this browser's localStorage, keyed per seat.

const DOCS_STORAGE_KEY = "reading-room-manager:docs:v1";
const docKey = (roomId, seatId) => `${roomId}:${seatId}`;

function loadLocalDocs() {
  try {
    const raw = localStorage.getItem(DOCS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalDocs(docsMap) {
  try {
    localStorage.setItem(DOCS_STORAGE_KEY, JSON.stringify(docsMap));
    return true;
  } catch {
    return false;
  }
}

// Splits ID-document data (photos, Aadhaar number, address) off of every room's
// seats. Returns a Supabase-safe copy of `rooms` (none of this) plus a flat map
// of what was removed.
function stripDocsForSync(rooms) {
  const docsMap = {};
  const cleanRooms = rooms.map((room) => {
    const seats = {};
    for (const [seatId, seat] of Object.entries(room.seats)) {
      const hasDocs =
        seat.type === "seat" &&
        (seat.aadhaarFront || seat.aadhaarBack || seat.addressProof || seat.aadhaarNumber || seat.address);
      if (hasDocs) {
        docsMap[docKey(room.id, seatId)] = {
          aadhaarFront: seat.aadhaarFront || "",
          aadhaarBack: seat.aadhaarBack || "",
          addressProof: seat.addressProof || "",
          aadhaarNumber: seat.aadhaarNumber || "",
          address: seat.address || "",
        };
        const { aadhaarFront, aadhaarBack, addressProof, aadhaarNumber, address, ...rest } = seat;
        seats[seatId] = rest;
      } else {
        seats[seatId] = seat;
      }
    }
    return { ...room, seats };
  });
  return { cleanRooms, docsMap };
}

// Puts locally-remembered ID document data (photos, Aadhaar number, address) back
// onto matching seats after rooms are loaded from Supabase — none of this ever
// leaves localStorage on this device.
function mergeDocsIntoRooms(rooms, docsMap) {
  return rooms.map((room) => {
    const seats = { ...room.seats };
    for (const seatId of Object.keys(seats)) {
      const stored = docsMap[docKey(room.id, seatId)];
      if (stored) seats[seatId] = { ...seats[seatId], ...stored };
    }
    return { ...room, seats };
  });
}

// ---------- ID document export ----------

function sanitizeFilename(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

function extFromDataUrl(dataUrl) {
  const m = /^data:image\/(\w+);/.exec(dataUrl || "");
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

// Bundles every uploaded Aadhaar/address photo across all rooms into one zip,
// naming files "<Occupant> 1.jpg" / "<Occupant> 2.jpg" / "<Occupant> address.jpg"
// so they're ready to drag straight into Google Drive (or anywhere else).
// Returns null if there are no documents to export.
async function buildIdDocsZip(rooms) {
  const zip = new JSZip();
  const nameCounts = {};
  let fileCount = 0;

  for (const rm of rooms) {
    for (const s of Object.values(rm.seats)) {
      if (s.type !== "seat" || s.status !== "occupied") continue;
      if (!s.aadhaarFront && !s.aadhaarBack && !s.addressProof) continue;

      const baseName = sanitizeFilename(s.occupant) || "Occupant";
      nameCounts[baseName] = (nameCounts[baseName] || 0) + 1;
      const label = nameCounts[baseName] > 1 ? `${baseName} (${sanitizeFilename(rm.name)})` : baseName;

      const entries = [
        [s.aadhaarFront, "1"],
        [s.aadhaarBack, "2"],
        [s.addressProof, "address"],
      ];
      for (const [dataUrl, suffix] of entries) {
        if (!dataUrl) continue;
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx === -1) continue;
        zip.file(`${label} ${suffix}.${extFromDataUrl(dataUrl)}`, dataUrl.slice(commaIdx + 1), { base64: true });
        fileCount++;
      }
    }
  }

  if (fileCount === 0) return null;
  return zip.generateAsync({ type: "blob" });
}

// ---------- Seat/cell data helpers ----------

const makeSeatId = (r, c) => `r${r}c${c}`;

function buildInitialCells(rows, cols, occupiedList = [], entryPositions = [], acPositions = [], bathroomPositions = []) {
  const cells = {};
  let seatNumber = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seatNumber += 1;
      cells[makeSeatId(r, c)] = { type: "seat", status: "vacant", number: String(seatNumber) };
    }
  }
  occupiedList.forEach(({ r, c, occupant, phone, fee, paymentStatus, dueDate, depositAmount, depositStatus }) => {
    const id = makeSeatId(r, c);
    cells[id] = {
      ...cells[id],
      type: "seat",
      status: "occupied",
      occupant,
      phone,
      fee,
      paymentStatus,
      dueDate,
      depositAmount: depositAmount ?? 1000,
      depositStatus: depositStatus || "held",
    };
  });
  entryPositions.forEach(({ r, c }) => {
    cells[makeSeatId(r, c)] = { type: "entry" };
  });
  acPositions.forEach(({ r, c }) => {
    cells[makeSeatId(r, c)] = { type: "ac" };
  });
  bathroomPositions.forEach(({ r, c }) => {
    cells[makeSeatId(r, c)] = { type: "bathroom" };
  });
  return cells;
}

function nextSeatNumber(seats) {
  let max = 0;
  Object.values(seats).forEach((s) => {
    if (s.type === "seat" && s.number && /^\d+$/.test(s.number)) {
      max = Math.max(max, parseInt(s.number, 10));
    }
  });
  return String(max + 1);
}

const PAYMENT_META = {
  paid: { label: "Paid", color: "#4F7A63", icon: Check },
  due: { label: "Due soon", color: "#E8A33D", icon: Clock },
  overdue: { label: "Overdue", color: "#C1554A", icon: AlertTriangle },
};

// Payment status is never set by hand — it's always derived from the due date
// against today's date. "Paid" means comfortably ahead of the due date; inside
// 3 days it reads "Due soon"; past the due date (or no due date at all) it's
// "Overdue". The only manual action is recording an actual payment, which
// pushes the due date forward and lets this recompute naturally.
const DUE_SOON_WINDOW_DAYS = 3;

function getPaymentStatusKey(dueDate) {
  const daysLeft = daysUntilDue(dueDate);
  if (daysLeft === null || daysLeft < 0) return "overdue";
  if (daysLeft <= DUE_SOON_WINDOW_DAYS) return "due";
  return "paid";
}

// True when a payment has already been recorded for the upcoming cycle —
// i.e. paidAt is set and nextDueDate is still in the future — even though
// dueDate itself won't move until the monthly rollover. Every place that
// derives a seat's payment status (badge, analytics totals, reminders)
// should route through this so they never disagree with each other again.
function hasLockedInPayment(seat) {
  return Boolean(seat?.paidAt && seat?.nextDueDate && daysUntilDue(seat.nextDueDate) >= 0);
}

function getEffectivePaymentStatusKey(seat) {
  if (hasLockedInPayment(seat)) return "paid";
  return getPaymentStatusKey(seat?.dueDate);
}

function getPaymentDisplay(seatOrDueDate) {
  const seat =
    typeof seatOrDueDate === "string"
      ? { dueDate: seatOrDueDate }
      : seatOrDueDate;

  const key = getEffectivePaymentStatusKey(seat);
  return { key, ...PAYMENT_META[key] };
}

const DEFAULT_REMINDER_TEMPLATE =
  "Hi {name}, friendly reminder that your reading room fee of ₹{amount} for seat {seat} at {room} is due on {dueDate}. Please pay soon to keep your seat. Thank you!";

// Today is a stand-in "current" date for the demo data below — replace with your own occupants/dates.
const initialRooms = [
  {
    id: "room-1",
    name: "Ilanjipra Reading Room",
    location: "Shoranur, Palakkad",
    lat: null,
    lng: null,
    rows: 4,
    cols: 6,
    seats: buildInitialCells(
      4,
      6,
      [
        { r: 0, c: 0, occupant: "Anjali Menon", phone: "9847000001", fee: 800, paymentStatus: "paid", dueDate: "2026-08-12" },
        { r: 0, c: 1, occupant: "Rahul Nair", phone: "9847000002", fee: 800, paymentStatus: "overdue", dueDate: "2026-07-14" },
        { r: 0, c: 3, occupant: "Devika S.", phone: "9847000003", fee: 800, paymentStatus: "overdue", dueDate: "2026-07-02" },
        { r: 1, c: 0, occupant: "Manu Krishna", phone: "9847000004", fee: 800, paymentStatus: "paid", dueDate: "2026-08-20" },
        { r: 1, c: 2, occupant: "Fathima K.", phone: "9847000005", fee: 800, paymentStatus: "paid", dueDate: "2026-08-18" },
        { r: 2, c: 4, occupant: "Arjun P.", phone: "9847000006", fee: 800, paymentStatus: "overdue", dueDate: "2026-07-15" },
        { r: 3, c: 1, occupant: "Sreelakshmi V.", phone: "9847000007", fee: 800, paymentStatus: "paid", dueDate: "2026-08-25" },
      ],
      [{ r: 0, c: 5 }],
      [{ r: 2, c: 0 }, { r: 3, c: 4 }],
      [{ r: 3, c: 5 }]
    ),
  },
  {
    id: "room-2",
    name: "Kalpaka Study Centre",
    location: "Palakkad",
    lat: null,
    lng: null,
    rows: 3,
    cols: 5,
    seats: buildInitialCells(
      3,
      5,
      [
        { r: 0, c: 0, occupant: "Vishnu M.", phone: "9847000008", fee: 750, paymentStatus: "paid", dueDate: "2026-08-16" },
        { r: 1, c: 3, occupant: "Aiswarya R.", phone: "9847000009", fee: 750, paymentStatus: "overdue", dueDate: "2026-07-05" },
      ],
      [{ r: 2, c: 4 }],
      [{ r: 0, c: 3 }]
    ),
  },
];

// ---------- Small UI atoms ----------

function LampDot({ status, size = 10 }) {
  const color =
    status === "vacant" ? "#C1554A" : status === "occupied" ? "#4F9D5B" : "#5B6472";
  const glow = status === "occupied" ? "0 0 8px 2px rgba(79,157,91,0.55)" : "none";
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: glow,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

function PillButton({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const base =
    "px-4 py-2 rounded-full text-sm font-medium tracking-wide transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-[#E8A33D] text-[#14171C] hover:bg-[#f0b158] active:scale-[0.97]",
    ghost: "bg-transparent text-[#EDE6D6] border border-[#3A3F4B] hover:border-[#E8A33D] hover:text-[#E8A33D]",
    danger: "bg-transparent text-[#C1554A] border border-[#5A2E2A] hover:bg-[#2A1815]",
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Field({ label, ...props }) {
  return (
    <label className="block mb-4">
      <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">{label}</span>
      <input
        {...props}
        className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3.5 py-2.5 text-[#EDE6D6] placeholder-[#5B6472] text-[15px] focus:outline-none focus:border-[#E8A33D] focus:ring-1 focus:ring-[#E8A33D] transition-colors"
      />
    </label>
  );
}

function DocUploadField({ label, hint, value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const compressed = await compressImage(dataUrl);
      onChange(compressed);
    } catch {
      setError("Couldn't read that file — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4">
      <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">{label}</span>
      {value ? (
        <div className="relative inline-block">
          <img
            src={value}
            alt={label}
            className="rounded-lg border border-[#333947] object-cover"
            style={{ maxHeight: 130, maxWidth: "100%" }}
          />
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-[#C1554A] text-white flex items-center justify-center"
            title="Remove"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <label className="flex items-center justify-center gap-2 border border-dashed border-[#3A3F4B] rounded-lg px-3.5 py-4 text-[#8A93A6] text-[13px] cursor-pointer hover:border-[#E8A33D] hover:text-[#E8A33D] transition-colors">
          <Camera className="w-4 h-4" />
          {busy ? "Uploading…" : "Upload / take photo"}
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
        </label>
      )}
      {hint && !value && <p className="text-[#7C8698] text-[11px] mt-1.5">{hint}</p>}
      {error && <p className="text-[#C1554A] text-[11px] mt-1.5">{error}</p>}
    </div>
  );
}

function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center px-4 py-8 z-50" onClick={onClose}>
      <div
        className="bg-[#1B1F27] border border-[#2A2F3A] rounded-2xl w-full max-w-sm relative flex flex-col"
        style={{ maxHeight: "88vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[#7C8698] hover:text-[#EDE6D6] bg-[#22262F] hover:bg-[#2A2F3A] rounded-full p-1.5 z-10 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="overflow-y-auto p-6" style={{ WebkitOverflowScrolling: "touch" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function EraseBadge() {
  return (
    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#C1554A] text-[9px] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
      <Minus className="w-2.5 h-2.5" />
    </span>
  );
}

// ---------- Interactive zoom/pan wrapper ----------

function ZoomPane({ children, rows, cols, baseCellPx = 64, baseGapPx = 10 }) {
  const [scale, setScale] = useState(1);
  const scrollRef = React.useRef(null);
  const pinchState = React.useRef(null);

  const clampScale = (s) => Math.min(2.5, Math.max(0.25, Math.round(s * 20) / 20));

  const zoomBy = (delta) => setScale((s) => clampScale(s + delta));

  const reset = () => {
    setScale(1);
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
  };

  const fitToScreen = () => {
    const el = scrollRef.current;
    if (!el || !rows || !cols) return;
    const padding = 40;
    const availW = el.clientWidth - padding;
    const availH = el.clientHeight - padding;
    const neededW = cols * baseCellPx + (cols - 1) * baseGapPx;
    const neededH = rows * baseCellPx + (rows - 1) * baseGapPx;
    const fit = Math.min(availW / neededW, availH / neededH);
    setScale(clampScale(fit));
    el.scrollLeft = 0;
    el.scrollTop = 0;
  };

  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomBy(-e.deltaY * 0.01);
  };

  const dist = (touches) => {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };

  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      pinchState.current = { startDist: dist(e.touches), startScale: scale };
    }
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 2 && pinchState.current) {
      e.preventDefault();
      const ratio = dist(e.touches) / pinchState.current.startDist;
      setScale(clampScale(pinchState.current.startScale * ratio));
    }
  };
  const onTouchEnd = (e) => {
    if (e.touches.length < 2) pinchState.current = null;
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="overflow-auto rounded-xl border border-[#22262F] bg-[#12151B] h-[65vh] sm:h-[60vh]"
        style={{ WebkitOverflowScrolling: "touch" }}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="p-4 sm:p-6 inline-block min-w-full min-h-full">{children(scale)}</div>
      </div>

      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5 bg-[#1B1F27] border border-[#333947] rounded-xl p-1.5">
        <button
          onClick={() => zoomBy(0.2)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#EDE6D6] bg-[#22262F] hover:bg-[#2A2F3A] transition-colors text-[16px] leading-none"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(-0.2)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#EDE6D6] bg-[#22262F] hover:bg-[#2A2F3A] transition-colors text-[16px] leading-none"
        >
          −
        </button>
        <button
          onClick={fitToScreen}
          title="Fit whole room on screen"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#6FB8CE] bg-[#22262F] hover:bg-[#2A2F3A] transition-colors"
        >
          <Minimize2 className="w-3.5 h-3.5" />
        </button>
        {scale !== 1 && (
          <button
            onClick={reset}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#E8A33D] bg-[#22262F] hover:bg-[#2A2F3A] transition-colors text-[10px] font-medium"
          >
            {Math.round(scale * 100)}%
          </button>
        )}
      </div>

      <div className="absolute bottom-3 left-3 text-[10px] text-[#5B6472] bg-[#1B1F27] border border-[#333947] rounded-full px-2.5 py-1">
        Swipe to pan · pinch or +/− to zoom
      </div>
    </div>
  );
}

// ---------- Seat cell ----------

function SeatCell({ seat: cell, seatId, onClick, editMode, dimmed }) {
  const type = cell.type;

  if (!type || type === "empty") {
    if (editMode) {
      return (
        <button
          onClick={() => onClick(seatId)}
          className="aspect-square rounded-lg border border-dashed border-[#2A2F3A] hover:border-[#E8A33D] flex items-center justify-center text-[#3A3F4B] hover:text-[#E8A33D] transition-colors"
          title="Place here"
        >
          <Plus className="w-4 h-4" />
        </button>
      );
    }
    return <div className="aspect-square" />;
  }

  if (type === "entry") {
    return (
      <button
        onClick={() => (editMode ? onClick(seatId) : undefined)}
        className={`aspect-square rounded-lg border flex flex-col items-center justify-center gap-1 relative group ${
          editMode ? "cursor-pointer" : "cursor-default"
        } border-[#3A6B7A] bg-[#132228]`}
        title="Entry"
      >
        {editMode && <EraseBadge />}
        <LogIn className="w-4 h-4 text-[#6FB8CE]" strokeWidth={1.5} />
        <span className="text-[8px] uppercase tracking-wide text-[#6FB8CE]">Entry</span>
      </button>
    );
  }

  if (type === "ac") {
    return (
      <button
        onClick={() => (editMode ? onClick(seatId) : undefined)}
        className={`aspect-square rounded-lg border flex flex-col items-center justify-center gap-1 relative group ${
          editMode ? "cursor-pointer" : "cursor-default"
        } border-[#3A5A7A] bg-[#101B26]`}
        title="AC"
      >
        {editMode && <EraseBadge />}
        <Wind className="w-4 h-4 text-[#7FAEDB]" strokeWidth={1.5} />
        <span className="text-[8px] uppercase tracking-wide text-[#7FAEDB]">AC</span>
      </button>
    );
  }

  if (type === "bathroom") {
    return (
      <button
        onClick={() => (editMode ? onClick(seatId) : undefined)}
        className={`aspect-square rounded-lg border flex flex-col items-center justify-center gap-1 relative group ${
          editMode ? "cursor-pointer" : "cursor-default"
        } border-[#4A6B4F] bg-[#131F14]`}
        title="Washroom"
      >
        {editMode && <EraseBadge />}
        <Bath className="w-4 h-4 text-[#8FC694]" strokeWidth={1.5} />
        <span className="text-[8px] uppercase tracking-wide text-[#8FC694]">WC</span>
      </button>
    );
  }

  const meta = cell.status === "occupied" ? getPaymentDisplay(cell) : null;

  if (dimmed) {
    return (
      <button
        onClick={() => onClick(seatId)}
        className="aspect-square rounded-lg border border-[#22262F] bg-[#15181E] flex flex-col items-center justify-center gap-1.5"
        title={seatId}
      >
        <span className="text-[13px] font-medium text-[#4A5162]" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
          {cell.number || "—"}
        </span>
        <span className="w-[10px] h-[10px] rounded-full border border-[#3A3F4B]" />
      </button>
    );
  }

  return (
    <button
      onClick={() => onClick(seatId)}
      className={`aspect-square rounded-lg border flex flex-col items-center justify-center gap-1.5 relative transition-all group ${
        cell.status === "vacant"
          ? "border-[#5A2E2A] bg-[#1F1515] hover:border-[#C1554A]"
          : "border-[#2A4A30] bg-[#141F16] hover:border-[#4F9D5B]"
      }`}
      title={seatId}
    >
      {editMode && <EraseBadge />}
      <span className="text-[13px] font-medium text-[#EDE6D6]" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        {cell.number || "—"}
      </span>
      <LampDot status={cell.status} />
      {meta && !editMode && (
        <span className="absolute bottom-1 right-1">
          <meta.icon className="w-2.5 h-2.5" style={{ color: meta.color }} />
        </span>
      )}
    </button>
  );
}

// ---------- Seat assign/edit modal ----------

function SeatModal({ seatId, seat, roomName, reminderTemplate, renewalCycleDays, onClose, onSave, onClear, onPaymentReceived }) {
  const [number, setNumber] = useState(seat.number || "");
  const [occupant, setOccupant] = useState(seat.occupant || "");
  const [phone, setPhone] = useState(seat.phone || "");
  const [fee, setFee] = useState(seat.fee || 800);
  // The due date on file. Recording a payment below never changes this
  // directly — it only locks in a nextDueDate that gets promoted to this
  // field at the start of next month. Still editable here for manual
  // correction (e.g. fixing a typo, or setting the very first due date at
  // registration).
  const [dueDate, setDueDate] = useState(seat.dueDate || "");
  const [markingPaidNow, setMarkingPaidNow] = useState(false);
  const [paymentDate, setPaymentDate] = useState(seat.paidAt ? seat.paidAt.slice(0, 10) : todayISO());
  const [paymentMode, setPaymentMode] = useState(seat.paymentMode || "cash");
  const [nextDueDate, setNextDueDate] = useState(seat.nextDueDate || addDaysISO(renewalCycleDays, dueDate));
  const [depositAmount, setDepositAmount] = useState(seat.depositAmount || 1000);
  const [depositStatus, setDepositStatus] = useState(seat.depositStatus || "held");
  const [aadhaarFront, setAadhaarFront] = useState(seat.aadhaarFront || "");
  const [aadhaarBack, setAadhaarBack] = useState(seat.aadhaarBack || "");
  const [addressProof, setAddressProof] = useState(seat.addressProof || "");
  const [aadhaarNumber, setAadhaarNumber] = useState(seat.aadhaarNumber || "");
  const [address, setAddress] = useState(seat.address || "");
  const [confirmingVacate, setConfirmingVacate] = useState(false);
  const [depositRefunded, setDepositRefunded] = useState(seat.depositStatus === "refunded");
  useEffect(() => {
  if (!seat.nextDueDate) {setNextDueDate(addDaysISO(renewalCycleDays, dueDate));}}, [dueDate, renewalCycleDays]);

  // Always computed live from the due date — never set by hand.
  const statusMeta = getPaymentDisplay(dueDate);

  const message = applyReminderTemplate(reminderTemplate, {
    occupant,
    number,
    seatId,
    roomName,
    fee,
    dueDate,
  });
  const digits = (phone || "").replace(/\D/g, "");
  const phoneWithCountry = digits.startsWith("91")
    ? digits
    : `91${digits}`;
  
  const waLink = `https://wa.me/${phoneWithCountry}?text=${encodeURIComponent(message)}`;
  const smsLink = `sms:+${phoneWithCountry}?body=${encodeURIComponent(message)}`;

  return (
    <Modal onClose={onClose}>
      <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1">Cabin · {seat.number || seatId}</div>
      <h3 className="font-serif text-[22px] text-[#EDE6D6] mb-5" style={{ fontFamily: "'Fraunces', serif" }}>
        {seat.status === "occupied" ? "Edit occupant" : "Assign seat"}
      </h3>

      <Field label="Seat number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 12 or A1" />
      <Field label="Occupant name" value={occupant} onChange={(e) => setOccupant(e.target.value)} placeholder="Full name" />
      <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="98470XXXXX"/>
      <Field label="Monthly fee (₹)" type="number" value={fee} onChange={(e) => setFee(Number(e.target.value))} />
      <Field label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

      <div className="mb-6">
        <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
          Payment status · automatic
        </span>
        <div
          className="flex items-center gap-2 py-2.5 px-3.5 rounded-lg border"
          style={{ borderColor: statusMeta.color, color: statusMeta.color, background: "#181B22" }}
        >
          <statusMeta.icon className="w-4 h-4" />
          <span className="text-[14px] font-medium">{statusMeta.label}</span>
          <span className="text-[#5B6472] text-[12px] ml-auto">based on the due date above</span>
        </div>
        {seat.nextDueDate && (
          <p className="text-[#7C8698] text-[11px] mt-1.5">
            Next due date locked in at {formatDueDate(seat.nextDueDate)} — takes effect at the start of next month.
          </p>
        )}
      </div>

      <div className="mb-6 border-t border-[#2A2F3A] pt-5">
        <label className="flex items-center gap-2.5 cursor-pointer mb-3">
          <input
            type="checkbox"
            checked={markingPaidNow}
            onChange={(e) => {
              setMarkingPaidNow(e.target.checked);
              if (e.target.checked && !paymentDate) setPaymentDate(todayISO());
            }}
            className="accent-[#E8A33D] w-4 h-4"
          />
          <span className="text-[14px] text-[#EDE6D6]">
            {seat.status === "occupied" ? "Record a payment" : "Record first payment"}
          </span>
        </label>

        {markingPaidNow && (
          <>
            <Field label="Payment date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Mode of payment</span>
            <div className="flex gap-2">
              {[
                { key: "cash", label: "Cash" },
                { key: "upi", label: "UPI" },
              ].map((m) => (
                <button
                  key={m.key}
                  onClick={() => setPaymentMode(m.key)}
                  className="flex-1 py-2 rounded-lg text-[13px] border transition-colors"
                  style={{
                    borderColor: paymentMode === m.key ? "#4F7A63" : "#333947",
                    color: paymentMode === m.key ? "#4F7A63" : "#7C8698",
                    background: paymentMode === m.key ? "#20242C" : "#181B22",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Field
              label="Next due date"
              type="date"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
            />

            <p className="text-[#7C8698] text-[11px] mt-2">
              This date will become the active due date automatically at the start of the next month.
              You can edit it if this payment covers a different duration.
            </p>
          </>
        )}
      </div>

      <div className="mb-6 border-t border-[#2A2F3A] pt-5">
        <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Caution deposit</span>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)" type="number" value={depositAmount} onChange={(e) => setDepositAmount(Number(e.target.value))} />
          <label className="block mb-4">
            <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Status</span>
            <select
              value={depositStatus}
              onChange={(e) => setDepositStatus(e.target.value)}
              className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2.5 text-[#EDE6D6] text-[14px] focus:outline-none focus:border-[#E8A33D]"
            >
              <option value="held">Held</option>
              <option value="refunded">Refunded</option>
            </select>
          </label>
        </div>
      </div>

      <div className="mb-2 border-t border-[#2A2F3A] pt-5">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-3">
          <Fingerprint className="w-3.5 h-3.5" /> ID verification
        </span>
        <Field
          label="Aadhaar number"
          value={aadhaarNumber}
          onChange={(e) => setAadhaarNumber(e.target.value)}
          placeholder="XXXX XXXX XXXX"
        />
        <label className="block mb-4">
          <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Address</span>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            placeholder="Full residential address"
            className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3.5 py-2.5 text-[#EDE6D6] placeholder-[#5B6472] text-[15px] focus:outline-none focus:border-[#E8A33D] focus:ring-1 focus:ring-[#E8A33D] transition-colors resize-none"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <DocUploadField label="Aadhaar — front" value={aadhaarFront} onChange={setAadhaarFront} />
          <DocUploadField label="Aadhaar — back" value={aadhaarBack} onChange={setAadhaarBack} />
        </div>
        <DocUploadField
          label="Address proof"
          hint="A recent utility bill, rental agreement, or similar document showing the occupant's address."
          value={addressProof}
          onChange={setAddressProof}
        />
        <p className="text-[#7C8698] text-[11px] mt-3">
          Aadhaar number, address, and these photos stay only on this device — never sent to the database.
        </p>
      </div>

      {occupant.trim() && (
        <div className="mb-6 border-t border-[#2A2F3A] pt-5">
          <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
            Message {occupant.trim().split(" ")[0]}
          </span>
          <div className="flex gap-2">
            {digits ? (
              <>
                <a href={waLink} target="_blank" rel="noopener noreferrer" className="flex-1">
                  <PillButton variant="ghost" className="w-full">
                    <MessageCircle className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> WhatsApp
                  </PillButton>
                </a>
                <a href={smsLink} className="flex-1">
                  <PillButton variant="ghost" className="w-full">
                    <Phone className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> SMS
                  </PillButton>
                </a>
              </>
            ) : (
              <p className="text-[#5B6472] text-[12px]">Add a phone number to message this occupant.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <PillButton
          className="flex-1"
          onClick={() => {
            if (!occupant.trim()) return;
            // Recording a payment never changes the present due date. It only
            // locks in what the due date should become — stored on the seat
            // as nextDueDate — and that only gets promoted to the real due
            // date at the start of the following calendar month (see the
            // monthly rollover effect in the main App component).
            const lockedNextDueDate = markingPaidNow ? nextDueDate: seat.nextDueDate || "";
            onSave(seatId, {
              type: "seat",
              status: "occupied",
              number: number.trim() || seatId,
              occupant,
              phone,
              fee,
              paymentStatus: getPaymentStatusKey(dueDate),
              paymentMode: markingPaidNow ? paymentMode : seat.paymentMode || "",
              dueDate,
              nextDueDate: lockedNextDueDate,
              paidAt: markingPaidNow ? isoDateTimeAtNoon(paymentDate || todayISO()) : seat.paidAt || "",
              depositAmount,
              depositStatus,
              aadhaarFront,
              aadhaarBack,
              addressProof,
              aadhaarNumber,
              address,
            });
            if (markingPaidNow) {
              onPaymentReceived({
                id: `payment-${Date.now()}`,
                roomName,
                seatNumber: number.trim() || seatId,
                occupant,
                amount: fee,
                mode: paymentMode,
                paidAt: isoDateTimeAtNoon(paymentDate || todayISO()),
                dueDateAtPayment: dueDate,
                nextDueDate: lockedNextDueDate,
              });
            }
          }}
        >
          Save
        </PillButton>
        {seat.status === "occupied" && !confirmingVacate && (
          <PillButton variant="danger" onClick={() => setConfirmingVacate(true)}>
            Vacate
          </PillButton>
        )}
      </div>

      {seat.status === "occupied" && confirmingVacate && (
        <div className="mt-4 border-t border-[#2A2F3A] pt-4">
          <p className="text-[#EDE6D6] text-[14px] mb-3">
            Vacate seat {seat.number || seatId} — <span className="font-medium">{seat.occupant}</span>? Their
            details move to the vacated-seats list.
          </p>

          <div className="mb-4">
            <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
              Caution deposit — ₹{seat.depositAmount || depositAmount || 0}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setDepositRefunded(true)}
                className="flex-1 py-2 rounded-lg text-[13px] border transition-colors"
                style={{
                  borderColor: depositRefunded ? "#4F7A63" : "#333947",
                  color: depositRefunded ? "#4F7A63" : "#7C8698",
                  background: depositRefunded ? "#20242C" : "#181B22",
                }}
              >
                Refunded
              </button>
              <button
                onClick={() => setDepositRefunded(false)}
                className="flex-1 py-2 rounded-lg text-[13px] border transition-colors"
                style={{
                  borderColor: !depositRefunded ? "#C1554A" : "#333947",
                  color: !depositRefunded ? "#C1554A" : "#7C8698",
                  background: !depositRefunded ? "#20242C" : "#181B22",
                }}
              >
                Not refunded
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <PillButton variant="ghost" className="flex-1" onClick={() => setConfirmingVacate(false)}>
              Cancel
            </PillButton>
            <PillButton
              variant="danger"
              className="flex-1"
              onClick={() => onClear(seatId, { depositRefunded, aadhaarNumber, address })}
            >
              Confirm vacate
            </PillButton>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- Room create/edit modal with Google Maps location ----------

function RoomLocationModal({ mode, initial, onClose, onSave, onDelete }) {
  const [name, setName] = useState(initial?.name || "");
  const [location, setLocation] = useState(initial?.location || "");
  const [lat, setLat] = useState(initial?.lat ?? null);
  const [lng, setLng] = useState(initial?.lng ?? null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mapsSearchUrl = location.trim()
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.trim())}`
    : null;
  const mapsPinUrl = lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocateError("Location isn't available in this browser.");
      return;
    }
    setLocating(true);
    setLocateError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude);
        setLng(pos.coords.longitude);
        setLocating(false);
      },
      () => {
        setLocateError("Couldn't get your location — check permissions.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <Modal onClose={onClose}>
      <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1">
        {mode === "add" ? "New reading room" : "Room location"}
      </div>
      <h3 className="font-serif text-[22px] text-[#EDE6D6] mb-5" style={{ fontFamily: "'Fraunces', serif" }}>
        {mode === "add" ? "Add a room" : "Update location"}
      </h3>

      <Field label="Room name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ilanjipra Reading Room" />
      <Field
        label="Location / area"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        placeholder="e.g. Shoranur, Palakkad"
      />

      <div className="flex gap-2 mb-4">
        <a
          href={mapsSearchUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1"
          onClick={(e) => !mapsSearchUrl && e.preventDefault()}
        >
          <PillButton variant="ghost" className="w-full" disabled={!mapsSearchUrl}>
            <MapPin className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> Find on Google Maps
          </PillButton>
        </a>
        <PillButton variant="ghost" onClick={useCurrentLocation} disabled={locating} className="flex-1">
          {locating ? "Locating…" : "Pin current GPS"}
        </PillButton>
      </div>

      {mapsPinUrl && (
        <p className="text-[#4F7A63] text-[12px] mb-1">
          Pinned at {lat.toFixed(5)}, {lng.toFixed(5)} —{" "}
          <a href={mapsPinUrl} target="_blank" rel="noopener noreferrer" className="underline">
            view on map
          </a>
        </p>
      )}
      {locateError && <p className="text-[#C1554A] text-[12px] mb-1">{locateError}</p>}
      <p className="text-[#7C8698] text-[11px] mb-5">
        Type the area name and tap "Find on Google Maps" to confirm the exact place, or pin your current GPS
        position if you're standing at the room right now.
      </p>

      <PillButton
        className="w-full"
        onClick={() => {
          if (!name.trim()) return;
          onSave({ name: name.trim(), location: location.trim(), lat, lng });
        }}
      >
        {mode === "add" ? "Create room" : "Save"}
      </PillButton>

      {mode === "edit" && onDelete && (
        <div className="mt-5 pt-5 border-t border-[#2A2F3A]">
          {!confirmDelete ? (
            <PillButton variant="danger" className="w-full" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> Delete this room
            </PillButton>
          ) : (
            <div>
              <p className="text-[#C1554A] text-[12.5px] mb-3 leading-relaxed">
                This deletes "{initial?.name || name}" and every seat, occupant, and document on file for it. This
                can't be undone.
              </p>
              <div className="flex gap-2">
                <PillButton variant="danger" className="flex-1" onClick={onDelete}>
                  Yes, delete it
                </PillButton>
                <PillButton variant="ghost" className="flex-1" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </PillButton>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------- Room board ----------

function RoomBoard({ room, onSeatUpdate, editMode, onToggleEdit, onAddRow, onAddCol, onVacateSeat, reminderTemplate, onPaymentReceived, renewalCycleDays }) {
  const [activeSeatId, setActiveSeatId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [placementTool, setPlacementTool] = useState("seat"); // 'seat' | 'entry' | 'ac' | 'bathroom'

  const counts = useMemo(() => {
    let vacant = 0,
      occupied = 0,
      overdue = 0,
      entries = 0,
      acs = 0,
      bathrooms = 0;
    Object.values(room.seats).forEach((s) => {
      if (s.type === "entry") {
        entries++;
        return;
      }
      if (s.type === "ac") {
        acs++;
        return;
      }
      if (s.type === "bathroom") {
        bathrooms++;
        return;
      }
      if (s.type !== "seat") return;
      if (s.status === "vacant") vacant++;
      else {
        occupied++;
        if (getEffectivePaymentStatusKey(s) === "overdue") overdue++;
      }
    });
    return { vacant, occupied, overdue, entries, acs, bathrooms };
  }, [room.seats]);

  const activeSeat = activeSeatId ? room.seats[activeSeatId] : null;

  const seatMatchesFilter = (seat) => {
    if (filter === "all") return true;
    if (filter === "vacant") return seat.status === "vacant";
    return seat.status === "occupied" && getEffectivePaymentStatusKey(seat) === filter;
  };

  const handleSeatClick = (seatId) => {
    const cell = room.seats[seatId] || { type: "empty" };
    if (editMode) {
      if (!cell.type || cell.type === "empty") {
        if (placementTool === "seat") onSeatUpdate(seatId, { type: "seat", status: "vacant", number: nextSeatNumber(room.seats) });
        else onSeatUpdate(seatId, { type: placementTool });
      } else {
        onSeatUpdate(seatId, { type: "empty" });
      }
      return;
    }
    if (cell.type === "seat") {
      setActiveSeatId(seatId);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-4 text-[13px] flex-wrap">
          <span className="flex items-center gap-1.5 text-[#C1554A]">
            <LampDot status="vacant" size={8} /> {counts.vacant} vacant
          </span>
          <span className="flex items-center gap-1.5 text-[#4F9D5B]">
            <LampDot status="occupied" size={8} /> {counts.occupied} occupied
          </span>
          {counts.overdue > 0 && (
            <span className="flex items-center gap-1.5 text-[#C1554A]">
              <AlertTriangle className="w-3 h-3" /> {counts.overdue} overdue
            </span>
          )}
          {counts.entries > 0 && (
            <span className="flex items-center gap-1.5 text-[#6FB8CE]">
              <LogIn className="w-3 h-3" /> {counts.entries} entry
            </span>
          )}
          {counts.acs > 0 && (
            <span className="flex items-center gap-1.5 text-[#7FAEDB]">
              <Wind className="w-3 h-3" /> {counts.acs} AC
            </span>
          )}
          {counts.bathrooms > 0 && (
            <span className="flex items-center gap-1.5 text-[#8FC694]">
              <Bath className="w-3 h-3" /> {counts.bathrooms} washroom
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!editMode && (
            <div className="flex bg-[#1B1F27] border border-[#2A2F3A] rounded-full p-0.5 text-[12px]">
              {["all", "vacant", "due", "overdue"].map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-full capitalize transition-colors ${
                    filter === f ? "bg-[#E8A33D] text-[#14171C]" : "text-[#8A93A6] hover:text-[#EDE6D6]"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={onToggleEdit}
            className={`p-2 rounded-full border transition-colors ${
              editMode ? "border-[#E8A33D] text-[#E8A33D]" : "border-[#2A2F3A] text-[#7C8698] hover:text-[#EDE6D6]"
            }`}
            title="Edit layout"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {editMode && (
        <div className="mb-4 bg-[#1B1F27] border border-[#2A2F3A] rounded-2xl p-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-2.5">
            Tap an empty cell to place · tap a filled one to remove
          </div>
          <div className="flex gap-2">
            {[
              { key: "seat", label: "Seat", icon: Armchair },
              { key: "entry", label: "Entry", icon: LogIn },
              { key: "ac", label: "AC", icon: Wind },
              { key: "bathroom", label: "Washroom", icon: Bath },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setPlacementTool(key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] border transition-colors ${
                  placementTool === key
                    ? "border-[#E8A33D] text-[#E8A33D] bg-[#2A2115]"
                    : "border-[#333947] text-[#8A93A6] hover:text-[#EDE6D6]"
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <ZoomPane rows={room.rows} cols={room.cols}>
        {(zoomScale) => {
          const cellPx = Math.round(64 * zoomScale);
          const gapPx = Math.round(10 * zoomScale);
          return (
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${room.cols}, ${cellPx}px)`,
                gridAutoRows: `${cellPx}px`,
                gap: `${gapPx}px`,
              }}
            >
              {Array.from({ length: room.rows }).flatMap((_, r) =>
                Array.from({ length: room.cols }).map((_, c) => {
                  const seatId = makeSeatId(r, c);
                  const seat = room.seats[seatId] || { type: "empty" };
                  const dimmed = seat.type === "seat" && !seatMatchesFilter(seat) && !editMode;
                  return (
                    <SeatCell
                      key={seatId}
                      seat={seat}
                      seatId={seatId}
                      editMode={editMode}
                      dimmed={dimmed}
                      onClick={handleSeatClick}
                    />
                  );
                })
              )}
            </div>
          );
        }}
      </ZoomPane>

      {editMode && (
        <div className="flex gap-2 mt-4">
          <PillButton variant="ghost" onClick={onAddRow}>
            <Plus className="w-3.5 h-3.5 inline -mt-0.5 mr-1" /> Row
          </PillButton>
          <PillButton variant="ghost" onClick={onAddCol}>
            <Plus className="w-3.5 h-3.5 inline -mt-0.5 mr-1" /> Column
          </PillButton>
        </div>
      )}

      {activeSeat && !editMode && (
        <SeatModal
          seatId={activeSeatId}
          seat={activeSeat}
          roomName={room.name}
          reminderTemplate={reminderTemplate}
          renewalCycleDays={renewalCycleDays}
          onPaymentReceived={onPaymentReceived}
          onClose={() => setActiveSeatId(null)}
          onSave={(id, data) => {
            onSeatUpdate(id, data);
            setActiveSeatId(null);
          }}
          onClear={(id, extra) => {
            onVacateSeat({
              id: `vacate-${Date.now()}`,
              roomId: room.id,
              roomName: room.name,
              seatNumber: activeSeat.number || id,
              occupant: activeSeat.occupant || "",
              phone: activeSeat.phone || "",
              fee: activeSeat.fee || 0,
              paymentStatus: getPaymentStatusKey(activeSeat.dueDate),
              dueDate: activeSeat.dueDate || "",
              lastPaymentDate: activeSeat.paidAt ? activeSeat.paidAt.slice(0, 10) : "",
              depositAmount: activeSeat.depositAmount || 0,
              depositRefunded: !!extra.depositRefunded,
              vacatedAt: new Date().toISOString(),
              aadhaarNumber: extra.aadhaarNumber || "",
              address: extra.address || "",
            });
            onSeatUpdate(id, { type: "seat", status: "vacant", number: activeSeat.number });
            setActiveSeatId(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- Tabs ----------

const TABS = [
  { key: "rooms", label: "Rooms", icon: Grid3x3 },
  { key: "payments", label: "Payments", icon: CreditCard },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "vacancy", label: "Vacancy", icon: Armchair },
  { key: "deposits", label: "Deposits", icon: PiggyBank },
  { key: "reminders", label: "Reminders", icon: Bell },
  { key: "vacated", label: "Vacated", icon: UserX },
  { key: "attendance", label: "Attendance", icon: ClipboardCheck },
];

// ---------- Main app (single-owner, offline, no login) ----------

export default function App() {
  const [rooms, setRooms] = useState(initialRooms);
  const [selectedRoomId, setSelectedRoomId] = useState(initialRooms[0].id);
  const [editMode, setEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState("rooms");
  const [reminderTemplate, setReminderTemplate] = useState(DEFAULT_REMINDER_TEMPLATE);
  const [reminderDraft, setReminderDraft] = useState(DEFAULT_REMINDER_TEMPLATE);
  const [reminderSaved, setReminderSaved] = useState(false);
  // How many days the due date rolls forward at each monthly auto-renewal —
  // one global setting, editable from the Reminders tab (not per-seat).
  const [renewalCycleDays, setRenewalCycleDays] = useState(30);
  const [renewalCycleDraft, setRenewalCycleDraft] = useState(30);
  const [renewalCycleSaved, setRenewalCycleSaved] = useState(false);
  // "YYYY-MM" of the last month the auto-renewal batch ran for. Empty until
  // the first load ever, at which point it's baselined without renewing
  // anything (we don't know what happened before the app started tracking).
  const [lastRenewalMonth, setLastRenewalMonth] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [roomModal, setRoomModal] = useState(null); // null | 'add' | 'edit'
  const [storageWarning, setStorageWarning] = useState("");
  const [exportingDocs, setExportingDocs] = useState(false);
  const [exportNote, setExportNote] = useState("");
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [vacateLog, setVacateLog] = useState([]);
  const [vacateHydrated, setVacateHydrated] = useState(false);
  const [vacateFrom, setVacateFrom] = useState("");
  const [vacateTo, setVacateTo] = useState("");
  const [attendance, setAttendance] = useState([]);
  const [attendanceLoading, setAttendanceLoading] = useState(true);
  const [paymentLog, setPaymentLog] = useState([]);
  const [paymentLogFrom, setPaymentLogFrom] = useState("");
  const [paymentLogTo, setPaymentLogTo] = useState("");
  const [paymentLogSort, setPaymentLogSort] = useState("date_desc");
  const [monthlyStatusCollapsed, setMonthlyStatusCollapsed] = useState(false);
  const [monthlyRevenueArchive, setMonthlyRevenueArchive] = useState([]);

  const room = rooms.find((r) => r.id === selectedRoomId) || rooms[0];

  const handleDownloadDocs = async () => {
    setExportingDocs(true);
    setExportNote("");
    try {
      const blob = await buildIdDocsZip(rooms);
      if (!blob) {
        setExportNote("No ID photos have been uploaded yet.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `id-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportNote("Something went wrong creating the zip — try again.");
    } finally {
      setExportingDocs(false);
    }
  };

  // Builds a single PDF with every seat across every room — occupied and vacant —
  // including Aadhaar number and address. This data is local-only (see above), so
  // the PDF is generated straight from in-memory state, no network call involved.
  const handleDownloadPdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const rows = [];
    rooms.forEach((rm) => {
      Object.entries(rm.seats)
        .filter(([, s]) => s.type === "seat")
        .sort((a, b) => (parseInt(a[1].number, 10) || 0) - (parseInt(b[1].number, 10) || 0))
        .forEach(([seatId, s]) => {
          rows.push([
            rm.name,
            s.number || seatId,
            s.status === "occupied" ? "Occupied" : "Vacant",
            s.occupant || "—",
            s.phone || "—",
            s.status === "occupied" ? `₹${s.fee || 0}` : "—",
            s.status === "occupied" ? getPaymentDisplay(s).label : "—",
            s.status === "occupied" && s.paymentMode ? (s.paymentMode === "upi" ? "UPI" : "Cash") : "—",
            s.status === "occupied" && s.paidAt ? formatDueDate(s.paidAt.slice(0, 10)) : "—",
            s.status === "occupied" ? formatDueDate(s.dueDate) : "—",
            s.status === "occupied" ? formatDueDate(addDaysISO(renewalCycleDays, s.dueDate)) : "—",
            s.status === "occupied" ? `₹${s.depositAmount || 0} (${s.depositStatus === "refunded" ? "Refunded" : "Held"})` : "—",
            s.aadhaarNumber || "—",
            s.address || "—",
          ]);
        });
    });

    doc.setFontSize(14);
    doc.text("Reading Room — Seat & Occupant Details", 40, 36);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Generated ${new Date().toLocaleString("en-IN")}`, 40, 50);

    autoTable(doc, {
      startY: 62,
      head: [
        [
          "Room",
          "Seat",
          "Status",
          "Occupant",
          "Phone",
          "Fee",
          "Payment",
          "Mode",
          "Payment date",
          "Present due date",
          "Next due date*",
          "Deposit",
          "Aadhaar no.",
          "Address",
        ],
      ],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [20, 23, 28], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        3: { cellWidth: 75 },
        13: { cellWidth: 130 },
      },
      foot: [
        [
          {
            content: `* Next due date is a projection — ${renewalCycleDays} days from the present due date, applied automatically the next time this seat's payment is recorded.`,
            colSpan: 14,
          },
        ],
      ],
      footStyles: { fillColor: [255, 255, 255], textColor: [120, 120, 120], fontSize: 6.5, fontStyle: "normal" },
    });

    doc.save(`seat-details-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  // Payments within the chosen From/To range (inclusive), sorted per paymentLogSort.
  // Empty range = no bound.
  const PAYMENT_LOG_SORTERS = {
    date_desc: (a, b) => (b.paidAt || "").localeCompare(a.paidAt || ""),
    date_asc: (a, b) => (a.paidAt || "").localeCompare(b.paidAt || ""),
    amount_desc: (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0),
    amount_asc: (a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0),
    name_asc: (a, b) => (a.occupant || "").localeCompare(b.occupant || "", undefined, { sensitivity: "base" }),
    seat_asc: (a, b) =>
      String(a.seatNumber || "").localeCompare(String(b.seatNumber || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  };

  const filteredPaymentLog = useMemo(() => {
    const filtered = paymentLog.filter((r) => {
      const paidDate = r.paidAt ? r.paidAt.slice(0, 10) : "";
      if (paymentLogFrom && paidDate < paymentLogFrom) return false;
      if (paymentLogTo && paidDate > paymentLogTo) return false;
      return true;
    });
    const sorter = PAYMENT_LOG_SORTERS[paymentLogSort] || PAYMENT_LOG_SORTERS.date_desc;
    return [...filtered].sort(sorter);
  }, [paymentLog, paymentLogFrom, paymentLogTo, paymentLogSort]);

  const paymentLogTotal = useMemo(
    () => filteredPaymentLog.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [filteredPaymentLog]
  );

  const handleDownloadPaymentReportPdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const rows = filteredPaymentLog.map((r) => [
      r.roomName,
      r.seatNumber,
      r.occupant || "—",
      `₹${r.amount || 0}`,
      r.mode === "upi" ? "UPI" : "Cash",
      new Date(r.paidAt).toLocaleString("en-IN"),
      formatDueDate(r.dueDateAtPayment),
      formatDueDate(r.nextDueDate),
    ]);

    const rangeLabel =
      paymentLogFrom || paymentLogTo
        ? `${paymentLogFrom ? formatDueDate(paymentLogFrom) : "the start"} to ${paymentLogTo ? formatDueDate(paymentLogTo) : "today"}`
        : "all time";

    doc.setFontSize(14);
    doc.text("Reading Room — Payments Received", 40, 36);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`${rangeLabel} · generated ${new Date().toLocaleString("en-IN")}`, 40, 50);

    autoTable(doc, {
      startY: 62,
      head: [["Room", "Seat", "Occupant", "Amount", "Mode", "Payment date", "Due date paid", "Next due date (from next month)"]],
      body: rows,
      styles: { fontSize: 8.5, cellPadding: 5 },
      headStyles: { fillColor: [20, 23, 28], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      foot: [["", "", "", `₹${paymentLogTotal}`, "", "Total received", "", ""]],
      footStyles: { fillColor: [32, 36, 44], textColor: [232, 163, 61], fontStyle: "bold" },
    });

    doc.save(`payments-received-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  // Builds a PDF of everyone who's ever vacated a seat — kept as a permanent
  // record even though the seat itself has long since been reassigned.
  // Vacated records within the chosen From/To range (inclusive). Empty = no bound.
  const filteredVacateLog = useMemo(() => {
    return vacateLog.filter((r) => {
      const vacatedDate = r.vacatedAt ? r.vacatedAt.slice(0, 10) : "";
      if (vacateFrom && vacatedDate < vacateFrom) return false;
      if (vacateTo && vacatedDate > vacateTo) return false;
      return true;
    });
  }, [vacateLog, vacateFrom, vacateTo]);

  const handleDownloadVacatePdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const rows = filteredVacateLog.map((r) => [
      r.roomName,
      r.seatNumber,
      r.occupant || "—",
      r.phone || "—",
      `₹${r.fee || 0}`,
      PAYMENT_META[r.paymentStatus]?.label ?? "—",
      formatDueDate(r.lastPaymentDate),
      formatDueDate(r.dueDate),
      `₹${r.depositAmount || 0}`,
      r.depositRefunded ? "Refunded" : "Not refunded",
      new Date(r.vacatedAt).toLocaleDateString("en-IN"),
      r.aadhaarNumber || "—",
      r.address || "—",
    ]);

    const rangeLabel =
      vacateFrom || vacateTo
        ? `${vacateFrom ? formatDueDate(vacateFrom) : "the start"} to ${vacateTo ? formatDueDate(vacateTo) : "today"}`
        : "all time";

    doc.setFontSize(14);
    doc.text("Reading Room — Vacated Seats", 40, 36);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`${rangeLabel} · generated ${new Date().toLocaleString("en-IN")}`, 40, 50);

    autoTable(doc, {
      startY: 62,
      head: [
        [
          "Room",
          "Seat",
          "Occupant",
          "Phone",
          "Fee",
          "Payment",
          "Last payment",
          "Due date",
          "Deposit",
          "Deposit status",
          "Vacated on",
          "Aadhaar no.",
          "Address",
        ],
      ],
      body: rows,
      styles: { fontSize: 7, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [20, 23, 28], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        2: { cellWidth: 75 },
        12: { cellWidth: 120 },
      },
    });

    doc.save(`vacated-seats-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  // Removes a vacated-seat record entirely (Supabase row + any locally-remembered
  // Aadhaar number/address for it).
  const deleteVacateRecord = (id) => {
    setVacateLog((prev) => prev.filter((r) => r.id !== id));
    const docs = loadVacateLocalDocs();
    if (docs[id]) {
      delete docs[id];
      saveVacateLocalDocs(docs);
    }
    deleteVacateRecordRemote(id).catch(() => {
      setStorageWarning("Couldn't delete that record from Supabase — check your connection.");
    });
  };

  // On first load: pull rooms/settings from Supabase, then merge back in any ID
  // document photos this browser remembers locally (those never live in Supabase).
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) {
      setRooms(initialRooms);
      setLoadingRooms(false);
      setHydrated(false); // never sync writes when unconfigured
      return;
    }
    let cancelled = false;
    (async () => {
      const localDocs = loadLocalDocs();
      const remote = await fetchAppState();
      if (cancelled) return;

      if (remote && Array.isArray(remote.rooms) && remote.rooms.length) {
        setRooms(mergeDocsIntoRooms(remote.rooms, localDocs));
        if (remote.selected_room_id) setSelectedRoomId(remote.selected_room_id);
        if (remote.reminder_template) {
          setReminderTemplate(remote.reminder_template);
          setReminderDraft(remote.reminder_template);
        }
        if (remote.renewal_cycle_days) {
          setRenewalCycleDays(remote.renewal_cycle_days);
          setRenewalCycleDraft(remote.renewal_cycle_days);
        }
        setLastRenewalMonth(remote.last_renewal_month || "");
      } else {
        // Nothing saved in Supabase yet (first run, or the setup SQL hasn't been
        // applied) — start from the sample rooms, with any locally-remembered
        // ID photos merged back in.
        setRooms(mergeDocsIntoRooms(initialRooms, localDocs));
        if (!remote) {
          setStorageWarning(
            "Couldn't reach Supabase (or the app_state table doesn't exist yet) — working from local sample data for now."
          );
        }
      }
      setLoadingRooms(false);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // On first load: pull the vacated-seats history from Supabase, merge back in any
  // Aadhaar number / address this browser remembers locally, then drop anything
  // older than the 3-month retention window (from both Supabase and local storage).
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let cancelled = false;
    (async () => {
      const localVacateDocs = loadVacateLocalDocs();
      const remote = await fetchVacateLog();
      if (cancelled) return;
      const merged = mergeVacateDocs(remote, localVacateDocs);
      const trimmed = await purgeOldVacateRecords(merged);
      if (cancelled) return;
      setVacateLog(trimmed);
      setVacateHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Attendance is written externally by a Google Form (see
  // supabase/google-form-attendance.gs) — the app just reads it.
  const refreshAttendance = () => {
    if (!SUPABASE_CONFIGURED) {
      setAttendanceLoading(false);
      return;
    }
    setAttendanceLoading(true);
    fetchAttendance()
      .then(setAttendance)
      .finally(() => setAttendanceLoading(false));
  };

  useEffect(() => {
    refreshAttendance();
  }, []);

  const deleteAttendance = (id) => {
    setAttendance((prev) => prev.filter((r) => r.id !== id));
    deleteAttendanceRemote(id).catch(() => {
      setStorageWarning("Couldn't delete that attendance record from Supabase — check your connection.");
    });
  };

  // Payment log: loaded once on mount (then trimmed to the 3-month retention
  // window, same as the vacate log), added to every time a seat is newly
  // marked paid (see SeatModal's onPaymentReceived).
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let cancelled = false;
    fetchPaymentLog()
      .then((rows) => purgeOldPaymentRecords(rows))
      .then((trimmed) => {
        if (!cancelled) setPaymentLog(trimmed);
        // Purging may have just archived a new month's total, so re-fetch
        // the archive after it settles rather than racing it.
        return fetchMonthlyRevenueArchive();
      })
      .then((archive) => {
        if (!cancelled) setMonthlyRevenueArchive(archive);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addPaymentRecord = (record) => {
    setPaymentLog((prev) => [record, ...prev.filter((r) => !isPastPaymentRetention(r.paidAt))]);
    savePaymentRecord(record).catch(() => {
      setStorageWarning("Couldn't save that payment to Supabase — check your connection.");
    });
  };

  const deletePaymentRecord = (id) => {
    setPaymentLog((prev) => prev.filter((r) => r.id !== id));
    deletePaymentRecordRemote(id).catch(() => {
      setStorageWarning("Couldn't delete that payment record from Supabase — check your connection.");
    });
  };

  // Lets you correct a payment's recorded date after the fact (e.g. it was
  // logged a day late) without deleting and redoing the whole entry.
  const updatePaymentDate = (id, newDateOnly) => {
    setPaymentLog((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const oldTime = r.paidAt ? r.paidAt.slice(11) : "00:00:00.000Z";
        const updated = { ...r, paidAt: `${newDateOnly}T${oldTime}` };
        savePaymentRecord(updated).catch(() => {
          setStorageWarning("Couldn't save that date change to Supabase — check your connection.");
        });
        return updated;
      })
    );
  };

  // Adds a newly-vacated seat to the log: saves it to Supabase (Aadhaar number and
  // address stripped out first) and keeps those two fields in localStorage only.
  const addVacateRecord = (record) => {
    setVacateLog((prev) => [record, ...prev.filter((r) => !isPastVacateRetention(r.vacatedAt))]);
    if (record.aadhaarNumber || record.address) {
      const docs = loadVacateLocalDocs();
      docs[record.id] = { aadhaarNumber: record.aadhaarNumber || "", address: record.address || "" };
      saveVacateLocalDocs(docs);
    }
    saveVacateRecord(record).catch(() => {
      setStorageWarning("Couldn't save the vacated-seat record to Supabase — check your connection.");
    });
  };

  // Runs once per calendar month, the first time the app loads after the
  // month has changed. Recording a payment (see SeatModal) never touches the
  // present due date by itself — it only locks in a nextDueDate on the seat.
  // This is the one place due dates actually move: any occupied seat with a
  // pending nextDueDate gets it promoted to dueDate, and nextDueDate is
  // cleared. Seats with no pending nextDueDate (i.e. that haven't paid since
  // their last renewal) are left untouched, so they simply stay showing
  // overdue until they do pay.
  useEffect(() => {
    if (!hydrated) return;
    const thisMonth = currentMonthKey();
    if (lastRenewalMonth === thisMonth) return; // already handled this month

    if (!lastRenewalMonth) {
      // First time this feature has ever run for this app — we don't know
      // what happened in months before now, so just baseline and don't
      // touch anything, to avoid a surprise mass-renewal on upgrade.
      setLastRenewalMonth(thisMonth);
      return;
    }

    setRooms((prev) =>
      prev.map((room) => {
        let changed = false;
        const nextSeats = {};
        Object.entries(room.seats || {}).forEach(([sid, s]) => {
          if (s.status === "occupied" && s.nextDueDate) {
            changed = true;
            nextSeats[sid] = { ...s, dueDate: s.nextDueDate, nextDueDate: "" };
          } else {
            nextSeats[sid] = s;
          }
        });
        return changed ? { ...room, seats: nextSeats } : room;
      })
    );
    setLastRenewalMonth(thisMonth);
  }, [hydrated, lastRenewalMonth]);

  // kept in localStorage only — they're never sent to the database).
  useEffect(() => {
    if (!hydrated) return;
    const { cleanRooms, docsMap } = stripDocsForSync(rooms);
    const docsOk = saveLocalDocs(docsMap);
    saveAppState({ rooms: cleanRooms, selectedRoomId, reminderTemplate, renewalCycleDays, lastRenewalMonth })
      .then(() => {
        setStorageWarning(docsOk ? "" : "Couldn't save an ID photo locally — storage may be full.");
      })
      .catch(() => {
        setStorageWarning("Couldn't save your last change to Supabase — check your connection.");
      });
  }, [rooms, selectedRoomId, reminderTemplate, renewalCycleDays, lastRenewalMonth, hydrated]);

  const updateSeat = (seatId, data) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === selectedRoomId ? { ...r, seats: { ...r.seats, [seatId]: data } } : r))
    );
  };

  const addRow = () => {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== selectedRoomId) return r;
        const newRows = r.rows + 1;
        const seats = { ...r.seats };
        for (let c = 0; c < r.cols; c++) {
          seats[makeSeatId(r.rows, c)] = { type: "empty" };
        }
        return { ...r, rows: newRows, seats };
      })
    );
  };

  const addCol = () => {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== selectedRoomId) return r;
        const newCols = r.cols + 1;
        const seats = { ...r.seats };
        for (let row = 0; row < r.rows; row++) {
          seats[makeSeatId(row, r.cols)] = { type: "empty" };
        }
        return { ...r, cols: newCols, seats };
      })
    );
  };

  const addRoom = (data) => {
    const id = `room-${Date.now()}`;
    setRooms((prev) => [
      ...prev,
      { id, name: data.name, location: data.location, lat: data.lat, lng: data.lng, rows: 4, cols: 6, seats: buildInitialCells(4, 6) },
    ]);
    setSelectedRoomId(id);
    setRoomModal(null);
  };

  const editRoom = (data) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === selectedRoomId ? { ...r, name: data.name, location: data.location, lat: data.lat, lng: data.lng } : r))
    );
    setRoomModal(null);
  };

  const deleteRoom = (id) => {
    setRooms((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (selectedRoomId === id) {
        setSelectedRoomId(next[0]?.id ?? null);
      }
      return next;
    });
    setRoomModal(null);
  };

  const allOccupants = useMemo(() => {
    const list = [];
    rooms.forEach((rm) => {
      const occupiedInRoom = [];
      Object.entries(rm.seats).forEach(([seatId, s]) => {
        if (s.type === "seat" && s.status === "occupied") {
          occupiedInRoom.push({ ...s, seatId, roomName: rm.name });
        }
      });
      // Sort by seat number (numeric-aware, so "2" sorts before "10"),
      // falling back to the seat id when no number was set.
      occupiedInRoom.sort((a, b) =>
        String(a.number || a.seatId).localeCompare(String(b.number || b.seatId), undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
      list.push(...occupiedInRoom);
    });
    return list;
  }, [rooms]);

  const vacancyList = useMemo(() => {
    const list = [];
    rooms.forEach((rm) => {
      Object.entries(rm.seats).forEach(([seatId, s]) => {
        if (s.type === "seat" && s.status === "vacant") {
          list.push({ seatId, number: s.number, roomName: rm.name });
        }
      });
    });
    return list;
  }, [rooms]);

  const analytics = useMemo(() => {
    let totalSeats = 0,
      occupied = 0,
      vacant = 0,
      paidAmt = 0,
      dueAmt = 0,
      overdueAmt = 0,
      depositHeld = 0,
      depositRefunded = 0;
    rooms.forEach((rm) => {
      Object.values(rm.seats).forEach((s) => {
        if (s.type !== "seat") return;
        totalSeats++;
        if (s.status === "vacant") {
          vacant++;
          return;
        }
        occupied++;
        const fee = s.fee || 0;
        const statusKey = getEffectivePaymentStatusKey(s);
        if (statusKey === "paid") paidAmt += fee;
        else if (statusKey === "due") dueAmt += fee;
        else if (statusKey === "overdue") overdueAmt += fee;
        if (s.depositStatus === "refunded") depositRefunded += s.depositAmount || 0;
        else depositHeld += s.depositAmount || 0;
      });
    });
    const potential = paidAmt + dueAmt + overdueAmt;
    const occupancyPct = totalSeats ? Math.round((occupied / totalSeats) * 100) : 0;
    return { totalSeats, occupied, vacant, paidAmt, dueAmt, overdueAmt, potential, occupancyPct, depositHeld, depositRefunded };
  }, [rooms]);

  const reminderList = useMemo(
    () =>
      allOccupants
        // A seat with a locked-in payment for the upcoming cycle shouldn't also
        // generate a reminder — dueDate just hasn't rolled over yet (that only
        // happens at the start of next month). Same rule as the Paid badge and
        // analytics use, via hasLockedInPayment.
        .filter((o) => !hasLockedInPayment(o))
        .map((o) => ({ ...o, daysLeft: daysUntilDue(o.dueDate) }))
        .filter((o) => o.daysLeft !== null && (o.daysLeft === 3 || o.daysLeft === 1 || o.daysLeft <= 0))
        .sort((a, b) => a.daysLeft - b.daysLeft),
    [allOccupants]
  );

  // Combines the permanent monthly archive (older months, totals only) with
  // the live payment log (recent months, still in the 3-month retention
  // window) into one chronological series for the revenue chart.
  const monthlyRevenueSeries = useMemo(() => {
    const byMonth = new Map();
    monthlyRevenueArchive.forEach((m) => {
      byMonth.set(m.monthKey, (byMonth.get(m.monthKey) || 0) + m.totalAmount);
    });
    paymentLog.forEach((r) => {
      const key = monthKeyOf(r.paidAt);
      if (!key) return;
      byMonth.set(key, (byMonth.get(key) || 0) + (r.amount || 0));
    });
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, total]) => ({ monthKey, label: formatMonthKey(monthKey), total }));
  }, [monthlyRevenueArchive, paymentLog]);

  const barSegment = (value, total, color) =>
    total > 0 ? <div style={{ width: `${(value / total) * 100}%`, backgroundColor: color }} /> : null;

  if (loadingRooms) {
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        style={{ backgroundColor: "#14171C", color: "#8A93A6", fontFamily: "'Inter', sans-serif" }}
      >
        <div className="flex items-center gap-2.5 text-[14px]">
          <LampDot status="vacant" size={10} />
          Loading your rooms…
        </div>
      </div>
    );
  }

  return (
    <div className="font-sans" style={{ fontFamily: "'Inter', sans-serif", backgroundColor: "#14171C", color: "#EDE6D6", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

        /* This environment doesn't compile Tailwind's arbitrary-value ([...]) syntax on the fly,
           so every custom color/size class used above is defined here by hand as real CSS. */
        .accent-\[\#E8A33D\] { accent-color: #E8A33D; }
        .active\:scale-\[0\.97\]:active { transform: scale(0.97); }
        .bg-\[\#101B26\] { background-color: #101B26; }
        .bg-\[\#12151B\] { background-color: #12151B; }
        .bg-\[\#131F14\] { background-color: #131F14; }
        .bg-\[\#141F16\] { background-color: #141F16; }
        .bg-\[\#132228\] { background-color: #132228; }
        .bg-\[\#14171C\] { background-color: #14171C; }
        .bg-\[\#15181E\] { background-color: #15181E; }
        .bg-\[\#181B22\] { background-color: #181B22; }
        .bg-\[\#1B1F27\] { background-color: #1B1F27; }
        .bg-\[\#1F1515\] { background-color: #1F1515; }
        .bg-\[\#22262F\] { background-color: #22262F; }
        .bg-\[\#2A1815\] { background-color: #2A1815; }
        .bg-\[\#2A2115\] { background-color: #2A2115; }
        .bg-\[\#C1554A\] { background-color: #C1554A; }
        .bg-\[\#E8A33D\] { background-color: #E8A33D; }
        .border-\[\#22262F\] { border-color: #22262F; }
        .border-\[\#2A4A30\] { border-color: #2A4A30; }
        .border-\[\#2A2F3A\] { border-color: #2A2F3A; }
        .border-\[\#333947\] { border-color: #333947; }
        .border-\[\#3A3F4B\] { border-color: #3A3F4B; }
        .border-\[\#3A5A7A\] { border-color: #3A5A7A; }
        .border-\[\#3A6B7A\] { border-color: #3A6B7A; }
        .border-\[\#4A6B4F\] { border-color: #4A6B4F; }
        .border-\[\#5A2E2A\] { border-color: #5A2E2A; }
        .border-\[\#C1554A\] { border-color: #C1554A; }
        .border-\[\#E8A33D\] { border-color: #E8A33D; }
        .focus\:border-\[\#E8A33D\]:focus { border-color: #E8A33D; }
        .focus\:ring-\[\#E8A33D\]:focus { box-shadow: 0 0 0 2px #E8A33D; }
        .h-\[10px\] { height: 10px; }
        .h-\[65vh\] { height: 65vh; }
        .hover\:bg-\[\#2A1815\]:hover { background-color: #2A1815; }
        .hover\:bg-\[\#2A2F3A\]:hover { background-color: #2A2F3A; }
        .hover\:bg-\[\#f0b158\]:hover { background-color: #f0b158; }
        .hover\:border-\[\#333947\]:hover { border-color: #333947; }
        .hover\:border-\[\#4F9D5B\]:hover { border-color: #4F9D5B; }
        .hover\:border-\[\#5B6472\]:hover { border-color: #5B6472; }
        .hover\:border-\[\#C1554A\]:hover { border-color: #C1554A; }
        .hover\:border-\[\#E8A33D\]:hover { border-color: #E8A33D; }
        .hover\:text-\[\#C1554A\]:hover { color: #C1554A; }
        .hover\:text-\[\#E8A33D\]:hover { color: #E8A33D; }
        .hover\:text-\[\#EDE6D6\]:hover { color: #EDE6D6; }
        .placeholder-\[\#5B6472\]::placeholder { color: #5B6472; opacity: 1; }
        @media (min-width: 640px) { .sm\:h-\[60vh\] { height: 60vh; } }
        .text-\[\#14171C\] { color: #14171C; }
        .text-\[\#3A3F4B\] { color: #3A3F4B; }
        .text-\[\#4A5162\] { color: #4A5162; }
        .text-\[\#4F7A63\] { color: #4F7A63; }
        .text-\[\#4F9D5B\] { color: #4F9D5B; }
        .text-\[\#5B6472\] { color: #5B6472; }
        .text-\[\#6FB8CE\] { color: #6FB8CE; }
        .text-\[\#7C8698\] { color: #7C8698; }
        .text-\[\#7FAEDB\] { color: #7FAEDB; }
        .text-\[\#8A93A6\] { color: #8A93A6; }
        .text-\[\#8FC694\] { color: #8FC694; }
        .text-\[\#B9C0CC\] { color: #B9C0CC; }
        .text-\[\#C1554A\] { color: #C1554A; }
        .text-\[\#E8A33D\] { color: #E8A33D; }
        .text-\[\#EDE6D6\] { color: #EDE6D6; }
        .text-\[10px\] { font-size: 10px; }
        .text-\[11px\] { font-size: 11px; }
        .text-\[12px\] { font-size: 12px; }
        .text-\[13\.5px\] { font-size: 13.5px; }
        .text-\[13px\] { font-size: 13px; }
        .text-\[14px\] { font-size: 14px; }
        .text-\[15px\] { font-size: 15px; }
        .text-\[16px\] { font-size: 16px; }
        .text-\[18px\] { font-size: 18px; }
        .text-\[20px\] { font-size: 20px; }
        .text-\[22px\] { font-size: 22px; }
        .text-\[24px\] { font-size: 24px; }
        .text-\[8px\] { font-size: 8px; }
        .text-\[9px\] { font-size: 9px; }
        .text-\[12\.5px\] { font-size: 12.5px; }
        .tracking-\[0\.14em\] { letter-spacing: 0.14em; }
        .w-\[10px\] { width: 10px; }
      `}</style>

      <div className="min-h-screen bg-[#14171C]">
        {!SUPABASE_CONFIGURED && (
          <div className="bg-[#2A1815] border-b border-[#5A2E2A] text-[#E8A33D] text-[12.5px] text-center px-4 py-2.5">
            Supabase isn't configured — set <span className="font-mono">VITE_SUPABASE_URL</span> and{" "}
            <span className="font-mono">VITE_SUPABASE_ANON_KEY</span> (Vercel/Netlify → Environment Variables, or
            .env.local), then redeploy. Showing sample data only — nothing you change here is being saved.
          </div>
        )}
        {storageWarning && (
          <div className="bg-[#2A1815] border-b border-[#5A2E2A] text-[#E8A33D] text-[12.5px] text-center px-4 py-2">
            {storageWarning}
          </div>
        )}
        {exportNote && (
          <div className="bg-[#181B22] border-b border-[#2A2F3A] text-[#8A93A6] text-[12.5px] text-center px-4 py-2">
            {exportNote}
          </div>
        )}
        <header className="border-b border-[#2A2F3A] sticky top-0 bg-[#14171C] z-30">
          <div className="max-w-5xl mx-auto px-5 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <LampDot status="vacant" size={10} />
              <span className="font-serif text-[18px] text-[#EDE6D6] truncate" style={{ fontFamily: "'Fraunces', serif" }}>
                Reading Room Manager
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleDownloadPdf}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors"
                title="Download every seat's full details — occupant, payment, deposit, Aadhaar number, address — as one PDF table"
              >
                <FileText className="w-3.5 h-3.5" />
                Seat PDF
              </button>
              <button
                onClick={handleDownloadDocs}
                disabled={exportingDocs}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors disabled:opacity-50"
                title="Download every uploaded ID photo as a zip, renamed by occupant — ready to drag into Google Drive"
              >
                <Download className="w-3.5 h-3.5" />
                {exportingDocs ? "Zipping…" : "ID docs"}
              </button>
            </div>
          </div>
          <div className="max-w-5xl mx-auto px-5 pb-3 flex items-center gap-2 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] whitespace-nowrap border transition-colors ${
                  activeTab === t.key
                    ? "border-[#E8A33D] text-[#E8A33D] bg-[#2A2115]"
                    : "border-[#2A2F3A] text-[#8A93A6] hover:text-[#EDE6D6]"
                }`}
              >
                <t.icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            ))}
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-5 py-8">
          {activeTab === "rooms" && (
            <>
              <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
                {rooms.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRoomId(r.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-[13px] whitespace-nowrap border transition-colors ${
                      selectedRoomId === r.id
                        ? "border-[#E8A33D] text-[#E8A33D] bg-[#2A2115]"
                        : "border-[#2A2F3A] text-[#8A93A6] hover:text-[#EDE6D6]"
                    }`}
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    {r.name}
                  </button>
                ))}
                <button
                  onClick={() => setRoomModal("add")}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] whitespace-nowrap border border-dashed border-[#3A3F4B] text-[#8A93A6] hover:border-[#E8A33D] hover:text-[#E8A33D] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add room
                </button>
              </div>

              {room ? (
                <>
                  <div className="mb-6 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                        {room.name}
                      </h2>
                      <p className="text-[#7C8698] text-[13px] mt-0.5">
                        {room.location || "No location set"}
                        {room.lat != null && room.lng != null && (
                          <>
                            {" · "}
                            <a
                              href={`https://www.google.com/maps?q=${room.lat},${room.lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#6FB8CE] underline"
                            >
                              view on map
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => setRoomModal("edit")}
                      className="shrink-0 p-2 rounded-full border border-[#2A2F3A] text-[#7C8698] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors"
                      title="Edit room name / location / delete"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <RoomBoard
                    room={room}
                    onSeatUpdate={updateSeat}
                    editMode={editMode}
                    onToggleEdit={() => setEditMode((v) => !v)}
                    onAddRow={addRow}
                    onAddCol={addCol}
                    onVacateSeat={addVacateRecord}
                    reminderTemplate={reminderTemplate}
                    onPaymentReceived={addPaymentRecord}
                    renewalCycleDays={renewalCycleDays}
                  />
                </>
              ) : (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-12 text-center text-[#7C8698] text-[13px]">
                  No reading rooms yet — add one to get started.
                </div>
              )}
            </>
          )}

          {activeTab === "payments" && (
            <div>
              <div className="flex items-center justify-between gap-3 mb-5">
                <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                  Monthly payment status
                </h2>
                <button
                  onClick={() => setMonthlyStatusCollapsed((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors shrink-0"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  {monthlyStatusCollapsed ? "Expand" : "Minimize"}
                </button>
              </div>
              {!monthlyStatusCollapsed && (
              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-medium">Occupant</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Room</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Seat</th>
                      <th className="text-left px-4 py-3 font-medium">Due</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOccupants.map((o) => {
                      const meta = getPaymentDisplay(o);
                      return (
                        <tr key={o.roomName + o.seatId} className="border-b border-[#22262F] last:border-0">
                          <td className="px-4 py-3 text-[#EDE6D6]">{o.occupant}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">{o.roomName}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell font-mono text-[12px]">{o.number || o.seatId}</td>
                          <td className="px-4 py-3 text-[#8A93A6]">{formatDueDate(o.dueDate)}</td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5" style={{ color: meta.color }}>
                              <meta.icon className="w-3.5 h-3.5" /> {meta.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {allOccupants.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-[#7C8698] text-[13px]">
                          No occupied seats yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}

              <div className="flex items-start justify-between gap-3 mb-1 mt-10">
                <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                  Payments received
                </h2>
                <button
                  onClick={handleDownloadPaymentReportPdf}
                  disabled={filteredPaymentLog.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors disabled:opacity-40 shrink-0"
                  title="Download the payments shown below (respecting the date range) as a PDF, with a total"
                >
                  <FileText className="w-3.5 h-3.5" />
                  PDF
                </button>
              </div>
              <p className="text-[#7C8698] text-[13px] mb-1">
                A receipt trail — one entry every time a seat is marked paid, with the date and mode of payment.
              </p>
              <p className="text-[#5B6472] text-[11px] mb-5">
                Records are kept for {PAYMENT_RETENTION_MONTHS} months, then removed automatically.
              </p>

              <div className="flex flex-wrap items-end gap-3 mb-5 bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4">
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">From</span>
                  <input
                    type="date"
                    value={paymentLogFrom}
                    onChange={(e) => setPaymentLogFrom(e.target.value)}
                    className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  />
                </label>
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">To</span>
                  <input
                    type="date"
                    value={paymentLogTo}
                    onChange={(e) => setPaymentLogTo(e.target.value)}
                    className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  />
                </label>
                {(paymentLogFrom || paymentLogTo) && (
                  <PillButton
                    variant="ghost"
                    onClick={() => {
                      setPaymentLogFrom("");
                      setPaymentLogTo("");
                    }}
                  >
                    Clear range
                  </PillButton>
                )}
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Sort by</span>
                  <select
                    value={paymentLogSort}
                    onChange={(e) => setPaymentLogSort(e.target.value)}
                    className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  >
                    <option value="date_desc">Payment date (newest)</option>
                    <option value="date_asc">Payment date (oldest)</option>
                    <option value="amount_desc">Amount (high–low)</option>
                    <option value="amount_asc">Amount (low–high)</option>
                    <option value="name_asc">Occupant (A–Z)</option>
                    <option value="seat_asc">Seat number</option>
                  </select>
                </label>
                <span className="text-[#4F7A63] text-[14px] font-medium ml-auto" style={{ fontFamily: "'Fraunces', serif" }}>
                  ₹{paymentLogTotal} total
                </span>
              </div>

              {filteredPaymentLog.length === 0 ? (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-8 text-center text-[#7C8698] text-[13px]">
                  {paymentLog.length === 0 ? "No payments recorded yet." : "No payments in that date range."}
                </div>
              ) : (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                  <table className="w-full text-[14px]">
                    <thead>
                      <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                        <th className="text-left px-4 py-3 font-medium">Occupant</th>
                        <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Room · Seat</th>
                        <th className="text-left px-4 py-3 font-medium">Amount</th>
                        <th className="text-left px-4 py-3 font-medium">Mode</th>
                        <th className="text-left px-4 py-3 font-medium">Payment date</th>
                        <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Due date paid</th>
                        <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Next due date*</th>
                        <th className="text-left px-4 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPaymentLog.map((r) => (
                        <tr key={r.id} className="border-b border-[#22262F] last:border-0">
                          <td className="px-4 py-3 text-[#EDE6D6]">{r.occupant || "—"}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell font-mono text-[12px]">
                            {r.roomName} · {r.seatNumber}
                          </td>
                          <td className="px-4 py-3 text-[#4F7A63]">₹{r.amount || 0}</td>
                          <td className="px-4 py-3 text-[#8A93A6]">{r.mode === "upi" ? "UPI" : "Cash"}</td>
                          <td className="px-4 py-3 text-[#8A93A6]">
                            <input
                              type="date"
                              value={r.paidAt ? r.paidAt.slice(0, 10) : ""}
                              onChange={(e) => e.target.value && updatePaymentDate(r.id, e.target.value)}
                              className="bg-transparent border border-transparent hover:border-[#333947] focus:border-[#E8A33D] rounded px-1.5 py-1 text-[#8A93A6] text-[13px] focus:outline-none"
                              title="Click to correct the recorded payment date"
                            />
                          </td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">{formatDueDate(r.dueDateAtPayment)}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">{formatDueDate(r.nextDueDate)}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deletePaymentRecord(r.id)}
                              className="text-[#7C8698] hover:text-[#C1554A] transition-colors"
                              title="Remove this record"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {filteredPaymentLog.length > 0 && (
                <p className="text-[#5B6472] text-[11px] mt-2">
                  * Takes effect as the present due date at the start of next month.
                </p>
              )}
            </div>
          )}

          {activeTab === "analytics" && (
            <div>
              <h2 className="font-serif text-[24px] text-[#EDE6D6] mb-5" style={{ fontFamily: "'Fraunces', serif" }}>
                Payment analytics
              </h2>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                {[
                  { label: "Occupancy", value: `${analytics.occupancyPct}%`, sub: `${analytics.occupied}/${analytics.totalSeats} seats` },
                  { label: "Collected", value: `₹${analytics.paidAmt}`, sub: "this month, paid" },
                  { label: "Due", value: `₹${analytics.dueAmt}`, sub: "not yet paid" },
                  { label: "Overdue", value: `₹${analytics.overdueAmt}`, sub: "past due date" },
                ].map((card) => (
                  <div key={card.label} className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4">
                    <div className="text-[#7C8698] text-[11px] uppercase tracking-wider mb-1">{card.label}</div>
                    <div className="text-[#EDE6D6] text-[22px] font-medium" style={{ fontFamily: "'Fraunces', serif" }}>
                      {card.value}
                    </div>
                    <div className="text-[#5B6472] text-[11px] mt-0.5">{card.sub}</div>
                  </div>
                ))}
              </div>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4 mb-6">
                <div className="text-[#7C8698] text-[11px] uppercase tracking-wider mb-3">
                  This month's revenue — ₹{analytics.potential} total possible
                </div>
                <div className="w-full h-3 rounded-full overflow-hidden flex bg-[#12151B]">
                  {barSegment(analytics.paidAmt, analytics.potential, "#4F7A63")}
                  {barSegment(analytics.dueAmt, analytics.potential, "#E8A33D")}
                  {barSegment(analytics.overdueAmt, analytics.potential, "#C1554A")}
                </div>
                <div className="flex flex-wrap gap-4 mt-3 text-[12px]">
                  <span className="flex items-center gap-1.5 text-[#4F7A63]"><LampDot status="vacant" size={7} />Paid ₹{analytics.paidAmt}</span>
                  <span className="flex items-center gap-1.5 text-[#E8A33D]"><LampDot status="vacant" size={7} />Due ₹{analytics.dueAmt}</span>
                  <span className="flex items-center gap-1.5 text-[#C1554A]"><LampDot status="vacant" size={7} />Overdue ₹{analytics.overdueAmt}</span>
                </div>
              </div>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4 mb-6">
                <div className="text-[#7C8698] text-[11px] uppercase tracking-wider mb-3">Monthly revenue</div>
                {monthlyRevenueSeries.length === 0 ? (
                  <div className="text-[#5B6472] text-[13px] py-6 text-center">
                    {SUPABASE_CONFIGURED ? "No recorded payments yet." : "Connect Supabase to track revenue over time."}
                  </div>
                ) : (
                  <div style={{ width: "100%", height: 220 }}>
                    <ResponsiveContainer>
                      <BarChart data={monthlyRevenueSeries} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" vertical={false} />
                        <XAxis dataKey="label" stroke="#7C8698" fontSize={11} tickLine={false} axisLine={{ stroke: "#2A2F3A" }} />
                        <YAxis stroke="#7C8698" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v}`} />
                        <Tooltip
                          formatter={(value) => [`₹${value}`, "Collected"]}
                          contentStyle={{ backgroundColor: "#1B1F27", border: "1px solid #2A2F3A", borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: "#EDE6D6" }}
                          cursor={{ fill: "#22262F" }}
                        />
                        <Bar dataKey="total" fill="#E8A33D" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <p className="text-[#5B6472] text-[11px] mt-3">
                  Recent months come from the payment log; months older than {PAYMENT_RETENTION_MONTHS} are totals
                  archived before their detailed records were purged.
                </p>
              </div>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4">
                <div className="text-[#7C8698] text-[11px] uppercase tracking-wider mb-3">Caution deposits</div>
                <div className="flex gap-6 text-[14px]">
                  <div>
                    <div className="text-[#E8A33D] text-[20px] font-medium" style={{ fontFamily: "'Fraunces', serif" }}>₹{analytics.depositHeld}</div>
                    <div className="text-[#7C8698] text-[12px]">Held</div>
                  </div>
                  <div>
                    <div className="text-[#4F7A63] text-[20px] font-medium" style={{ fontFamily: "'Fraunces', serif" }}>₹{analytics.depositRefunded}</div>
                    <div className="text-[#7C8698] text-[12px]">Refunded</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "vacancy" && (
            <div>
              <h2 className="font-serif text-[24px] text-[#EDE6D6] mb-1" style={{ fontFamily: "'Fraunces', serif" }}>
                Vacant seats
              </h2>
              <p className="text-[#7C8698] text-[13px] mb-5">Auto-generated from your layout — updates instantly as seats fill up.</p>
              {vacancyList.length === 0 ? (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-8 text-center text-[#7C8698] text-[13px]">
                  Every seat is occupied.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {vacancyList.map((v) => (
                    <div key={v.roomName + v.seatId} className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-3.5 flex items-center gap-2.5">
                      <LampDot status="vacant" size={9} />
                      <div>
                        <div className="text-[#EDE6D6] text-[14px] font-mono">Seat {v.number || v.seatId}</div>
                        <div className="text-[#7C8698] text-[11px]">{v.roomName}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "deposits" && (
            <div>
              <h2 className="font-serif text-[24px] text-[#EDE6D6] mb-1" style={{ fontFamily: "'Fraunces', serif" }}>
                Caution deposit register
              </h2>
              <p className="text-[#7C8698] text-[13px] mb-5">Security deposits held per occupant.</p>
              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-medium">Occupant</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Room · Seat</th>
                      <th className="text-left px-4 py-3 font-medium">Deposit</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOccupants.map((o) => (
                      <tr key={o.roomName + o.seatId} className="border-b border-[#22262F] last:border-0">
                        <td className="px-4 py-3 text-[#EDE6D6]">{o.occupant}</td>
                        <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell font-mono text-[12px]">
                          {o.roomName} · {o.number || o.seatId}
                        </td>
                        <td className="px-4 py-3 text-[#8A93A6]">₹{o.depositAmount || 0}</td>
                        <td className="px-4 py-3">
                          <span className={o.depositStatus === "refunded" ? "text-[#4F7A63]" : "text-[#E8A33D]"}>
                            {o.depositStatus === "refunded" ? "Refunded" : "Held"}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {allOccupants.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-[#7C8698] text-[13px]">
                          No occupied seats yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "reminders" && (
            <div>
              <h2 className="font-serif text-[24px] text-[#EDE6D6] mb-1" style={{ fontFamily: "'Fraunces', serif" }}>
                Due-date reminders
              </h2>
              <p className="text-[#7C8698] text-[13px] mb-5">3 days before, 1 day before, on the due day, and anything overdue.</p>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4 mb-5">
                <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
                  Monthly renewal
                </span>
                <p className="text-[#7C8698] text-[12px] mb-3 leading-relaxed">
                  Recording a payment never changes a seat's present due date right away — it locks in a next due
                  date ({renewalCycleDays} days from the present one, below). The first time you open the app after
                  a new calendar month begins, every seat with a locked-in next due date has it promoted to the
                  present due date. Anyone who hasn't paid since their last renewal is left as-is.
                </p>
                <div className="flex items-end gap-3 mb-2">
                  <div className="flex-1">
                    <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
                      Days to add at renewal
                    </span>
                    <input
                      type="number"
                      value={renewalCycleDraft}
                      onChange={(e) => {
                        setRenewalCycleDraft(Number(e.target.value) || 0);
                        setRenewalCycleSaved(false);
                      }}
                      className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3.5 py-2.5 text-[#EDE6D6] text-[13.5px] focus:outline-none focus:border-[#E8A33D]"
                    />
                  </div>
                  <PillButton
                    onClick={() => {
                      setRenewalCycleDays(renewalCycleDraft);
                      setRenewalCycleSaved(true);
                    }}
                  >
                    <Pencil className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> Save
                  </PillButton>
                  {renewalCycleSaved && <span className="text-[#4F7A63] text-[13px]">Saved.</span>}
                </div>
                <p className="text-[#5B6472] text-[11px]">Last ran for: {formatMonthKey(lastRenewalMonth)}</p>
              </div>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4 mb-5">
                <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">
                  Reminder message · word it however you like
                </span>
                <textarea
                  value={reminderDraft}
                  onChange={(e) => {
                    setReminderDraft(e.target.value);
                    setReminderSaved(false);
                  }}
                  rows={3}
                  className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3.5 py-2.5 text-[#EDE6D6] text-[13.5px] leading-relaxed focus:outline-none focus:border-[#E8A33D] resize-none mb-2"
                />
                <p className="text-[#7C8698] text-[11px] mb-3">
                  Use {"{name}"}, {"{seat}"}, {"{room}"}, {"{amount}"}, {"{dueDate}"} — they'll be filled in per person.
                </p>
                <div className="flex items-center gap-3">
                  <PillButton
                    onClick={() => {
                      setReminderTemplate(reminderDraft);
                      setReminderSaved(true);
                    }}
                  >
                    <Pencil className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> Save wording
                  </PillButton>
                  {reminderSaved && <span className="text-[#4F7A63] text-[13px]">Saved.</span>}
                </div>
              </div>

              {reminderList.length === 0 ? (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-8 text-center text-[#7C8698] text-[13px]">
                  Nobody's due in 3 days, 1 day, today, or overdue right now.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {reminderList.map((o) => {
                    const message = applyReminderTemplate(reminderTemplate, o);
                    const digits = (o.phone || "").replace(/\D/g, "");
                    const waLink = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
                    const smsLink = `sms:${digits}?body=${encodeURIComponent(message)}`;
                    const rowKey = o.roomName + o.seatId;
                    const tierLabel =
                      o.daysLeft < 0
                        ? `${Math.abs(o.daysLeft)}d overdue`
                        : o.daysLeft === 0
                        ? "Due today"
                        : o.daysLeft === 1
                        ? "1 day left"
                        : "3 days left";
                    return (
                      <div key={rowKey} className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div>
                            <div className="text-[#EDE6D6] font-medium text-[14px]">{o.occupant}</div>
                            <div className="text-[#7C8698] text-[12px] font-mono">
                              {o.roomName} · Seat {o.number || o.seatId}
                            </div>
                          </div>
                          <span
                            className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${
                              o.daysLeft < 0 ? "border-[#C1554A] text-[#C1554A]" : "border-[#E8A33D] text-[#E8A33D]"
                            }`}
                          >
                            {tierLabel}
                          </span>
                        </div>
                        <p className="text-[#B9C0CC] text-[13px] mb-3 leading-relaxed">{message}</p>
                        <div className="flex flex-wrap gap-2">
                          <PillButton
                            variant="ghost"
                            onClick={() => {
                              navigator.clipboard?.writeText(message);
                              setCopiedId(rowKey);
                              setTimeout(() => setCopiedId((id) => (id === rowKey ? null : id)), 1500);
                            }}
                          >
                            <Copy className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" />
                            {copiedId === rowKey ? "Copied" : "Copy"}
                          </PillButton>
                          {digits && (
                            <>
                              <a href={waLink} target="_blank" rel="noopener noreferrer">
                                <PillButton variant="ghost">
                                  <MessageCircle className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> WhatsApp
                                </PillButton>
                              </a>
                              <a href={smsLink}>
                                <PillButton>
                                  <Phone className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> SMS
                                </PillButton>
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "vacated" && (
            <div>
              <div className="flex items-start justify-between gap-3 mb-1">
                <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                  Vacated seats
                </h2>
                <button
                  onClick={handleDownloadVacatePdf}
                  disabled={filteredVacateLog.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors disabled:opacity-40 shrink-0"
                  title="Download the seats shown below (respecting the date range) as a PDF table"
                >
                  <FileText className="w-3.5 h-3.5" />
                  PDF
                </button>
              </div>
              <p className="text-[#7C8698] text-[13px] mb-1">
                Everyone who's vacated a seat, kept as a record — including whether their deposit was refunded.
              </p>
              <p className="text-[#5B6472] text-[11px] mb-5">
                Records are kept for {VACATE_RETENTION_MONTHS} months, then removed automatically.
              </p>

              <div className="flex flex-wrap items-end gap-3 mb-5 bg-[#181B22] border border-[#2A2F3A] rounded-2xl p-4">
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">From</span>
                  <input
                    type="date"
                    value={vacateFrom}
                    onChange={(e) => setVacateFrom(e.target.value)}
                    className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  />
                </label>
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">To</span>
                  <input
                    type="date"
                    value={vacateTo}
                    onChange={(e) => setVacateTo(e.target.value)}
                    className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  />
                </label>
                {(vacateFrom || vacateTo) && (
                  <PillButton
                    variant="ghost"
                    onClick={() => {
                      setVacateFrom("");
                      setVacateTo("");
                    }}
                  >
                    Clear range
                  </PillButton>
                )}
                <span className="text-[#5B6472] text-[12px] ml-auto">
                  {filteredVacateLog.length} of {vacateLog.length} record{vacateLog.length === 1 ? "" : "s"}
                </span>
              </div>

              {filteredVacateLog.length === 0 ? (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-8 text-center text-[#7C8698] text-[13px]">
                  {vacateLog.length === 0 ? "Nobody's vacated a seat yet." : "No vacated seats in that date range."}
                </div>
              ) : (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                  <table className="w-full text-[14px]">
                    <thead>
                      <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                        <th className="text-left px-4 py-3 font-medium">Occupant</th>
                        <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Room · Seat</th>
                        <th className="text-left px-4 py-3 font-medium">Deposit</th>
                        <th className="text-left px-4 py-3 font-medium">Vacated</th>
                        <th className="text-left px-4 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVacateLog.map((r) => (
                        <tr key={r.id} className="border-b border-[#22262F] last:border-0">
                          <td className="px-4 py-3 text-[#EDE6D6]">{r.occupant || "—"}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell font-mono text-[12px]">
                            {r.roomName} · {r.seatNumber}
                          </td>
                          <td className="px-4 py-3">
                            <span className={r.depositRefunded ? "text-[#4F7A63]" : "text-[#C1554A]"}>
                              ₹{r.depositAmount || 0} · {r.depositRefunded ? "Refunded" : "Not refunded"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[#8A93A6]">
                            {new Date(r.vacatedAt).toLocaleDateString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteVacateRecord(r.id)}
                              className="text-[#7C8698] hover:text-[#C1554A] transition-colors"
                              title="Remove this record"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "attendance" && (
            <div>
              <div className="flex items-start justify-between gap-3 mb-1">
                <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                  Attendance
                </h2>
                <button
                  onClick={refreshAttendance}
                  disabled={attendanceLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors disabled:opacity-40 shrink-0"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${attendanceLoading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>
              <p className="text-[#7C8698] text-[13px] mb-5">
                Check-ins collected from your Google Form — see{" "}
                <span className="font-mono text-[12px]">supabase/google-form-attendance.gs</span> to set it up. This
                tab only reads and deletes; the form is what writes here.
              </p>

              {attendance.length === 0 ? (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl px-4 py-8 text-center text-[#7C8698] text-[13px]">
                  {attendanceLoading ? "Loading…" : "No check-ins yet — submit the Google Form to see one here."}
                </div>
              ) : (
                <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                  <table className="w-full text-[14px]">
                    <thead>
                      <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                        <th className="text-left px-4 py-3 font-medium">Room · Seat</th>
                        <th className="text-left px-4 py-3 font-medium">Occupant</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Note</th>
                        <th className="text-left px-4 py-3 font-medium">Submitted</th>
                        <th className="text-left px-4 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendance.map((r) => (
                        <tr key={r.id} className="border-b border-[#22262F] last:border-0">
                          <td className="px-4 py-3 text-[#8A93A6] font-mono text-[12px]">
                            {r.roomName} · {r.seatNumber}
                          </td>
                          <td className="px-4 py-3 text-[#EDE6D6]">{r.occupant || "—"}</td>
                          <td className="px-4 py-3">
                            <span className={r.present ? "text-[#4F7A63]" : "text-[#C1554A]"}>
                              {r.present ? "Present" : "Absent"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">{r.note || "—"}</td>
                          <td className="px-4 py-3 text-[#8A93A6]">
                            {new Date(r.submittedAt).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteAttendance(r.id)}
                              className="text-[#7C8698] hover:text-[#C1554A] transition-colors"
                              title="Remove this record"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {roomModal && (
        <RoomLocationModal
          mode={roomModal}
          initial={roomModal === "edit" ? room : null}
          onClose={() => setRoomModal(null)}
          onSave={roomModal === "add" ? addRoom : editRoom}
          onDelete={roomModal === "edit" && room ? () => deleteRoom(room.id) : undefined}
        />
      )}
    </div>
  );
}
