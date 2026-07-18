import React, { useState, useMemo, useEffect } from "react";
import JSZip from "jszip";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
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
  IdCard,
  Download,
  FileText,
  LogOut,
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

// Whole-day span between two ISO dates (or an ISO date and an ISO datetime).
// Returns null if either side is missing/invalid.
function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso.slice(0, 10) + "T00:00:00");
  const end = new Date(endIso.slice(0, 10) + "T00:00:00");
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  return Math.round((end - start) / 86400000);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Adds `days` to an ISO date (falls back to today if the date is missing/invalid).
function addDays(isoDate, days) {
  const base = isoDate ? new Date(isoDate.slice(0, 10) + "T00:00:00") : new Date();
  const start = isNaN(base.getTime()) ? new Date() : base;
  start.setDate(start.getDate() + days);
  return start.toISOString().slice(0, 10);
}

// Normalizes a typed phone number to +91XXXXXXXXXX. Leaves an explicit "+"
// country code alone (someone entering a non-Indian number on purpose).
function formatIndianPhone(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return `+${trimmed.replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("91") && digits.length > 10) return `+${digits}`;
  return `+91${digits}`;
}

// One-time backfill so numbers saved before the +91 auto-format existed get
// normalized too, the first time they're loaded.
function normalizePhonesInRooms(rooms) {
  return rooms.map((r) => {
    const seats = {};
    for (const [id, cell] of Object.entries(r.seats || {})) {
      seats[id] = cell && cell.phone ? { ...cell, phone: formatIndianPhone(cell.phone) } : cell;
    }
    return { ...r, seats };
  });
}

function normalizePhonesInVacated(vacated) {
  return vacated.map((v) => (v.phone ? { ...v, phone: formatIndianPhone(v.phone) } : v));
}

function formatDueDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
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
// Talked to directly over Supabase's REST API (no SDK needed) so this same code
// works both in a plain deployed build and in this preview. The anon key below is
// meant to be public — Supabase's Row Level Security policy on the table is what
// actually controls access, not secrecy of this key.

const SUPABASE_URL = "https://chhxglvujlsdlyrfyeel.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoaHhnbHZ1amxzZGx5cmZ5ZWVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MzAwNjksImV4cCI6MjA5OTUwNjA2OX0.xzyKDRh8paCTrPr9HaJYbmjP081wRQ2JjDd8yx-wnzA";

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
async function saveAppState({ rooms, selectedRoomId, reminderTemplate, vacated }) {
  const res = await fetch(`${SB_REST}/app_state`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        id: "main",
        rooms,
        selected_room_id: selectedRoomId,
        reminder_template: reminderTemplate,
        vacated: vacated || [],
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  if (!res.ok) throw new Error(`Supabase save failed (${res.status})`);
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

// Same idea as stripDocsForSync/mergeDocsIntoRooms above, but for the vacated-
// occupants list: Aadhaar number/address never get sent to Supabase, only kept
// in this browser's localStorage (merged into the same docs map, under a
// "vacated:<id>" key so it never collides with an active seat's key).
function stripVacatedDocsForSync(vacated) {
  const docsMap = {};
  const cleanVacated = vacated.map((v) => {
    const hasDocs = v.aadhaarNumber || v.address;
    if (!hasDocs) return v;
    docsMap[`vacated:${v.id}`] = {
      aadhaarNumber: v.aadhaarNumber || "",
      address: v.address || "",
    };
    const { aadhaarNumber, address, ...rest } = v;
    return rest;
  });
  return { cleanVacated, docsMap };
}

function mergeVacatedDocs(vacated, docsMap) {
  return vacated.map((v) => {
    const stored = docsMap[`vacated:${v.id}`];
    return stored ? { ...v, ...stored } : v;
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
        { r: 0, c: 1, occupant: "Rahul Nair", phone: "9847000002", fee: 800, paymentStatus: "due", dueDate: "2026-07-14" },
        { r: 0, c: 3, occupant: "Devika S.", phone: "9847000003", fee: 800, paymentStatus: "overdue", dueDate: "2026-07-02" },
        { r: 1, c: 0, occupant: "Manu Krishna", phone: "9847000004", fee: 800, paymentStatus: "paid", dueDate: "2026-08-20" },
        { r: 1, c: 2, occupant: "Fathima K.", phone: "9847000005", fee: 800, paymentStatus: "paid", dueDate: "2026-08-18" },
        { r: 2, c: 4, occupant: "Arjun P.", phone: "9847000006", fee: 800, paymentStatus: "due", dueDate: "2026-07-15" },
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
    status === "vacant" ? "#E8A33D" : status === "occupied" ? "#C1554A" : "#5B6472";
  const glow = status === "vacant" ? "0 0 8px 2px rgba(232,163,61,0.55)" : "none";
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

  const meta = cell.status === "occupied" ? PAYMENT_META[cell.paymentStatus] : null;

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
          ? "border-[#2A2F3A] bg-[#1B1F27] hover:border-[#E8A33D]"
          : "border-[#2A2F3A] bg-[#1B1F27] hover:border-[#5B6472]"
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

function SeatModal({ seatId, seat, roomId, roomName, rooms, reminderTemplate, onClose, onSave, onVacate, onTransfer }) {
  const [number, setNumber] = useState(seat.number || "");
  const [occupant, setOccupant] = useState(seat.occupant || "");
  const [phone, setPhone] = useState(seat.phone || "");
  const [fee, setFee] = useState(seat.fee || 800);
  const [paymentStatus, setPaymentStatus] = useState(seat.paymentStatus || "due");
  const [lastDueDate, setLastDueDate] = useState(seat.lastDueDate || "");
  const [dueDate, setDueDate] = useState(seat.dueDate || "");
  const [paymentDate, setPaymentDate] = useState(seat.paymentDate || todayISO());
  const [extendDays, setExtendDays] = useState(30);
  const [depositAmount, setDepositAmount] = useState(seat.depositAmount || 1000);
  const [depositStatus, setDepositStatus] = useState(seat.depositStatus || "held");
  const [aadhaarFront, setAadhaarFront] = useState(seat.aadhaarFront || "");
  const [aadhaarBack, setAadhaarBack] = useState(seat.aadhaarBack || "");
  const [addressProof, setAddressProof] = useState(seat.addressProof || "");
  const [aadhaarNumber, setAadhaarNumber] = useState(seat.aadhaarNumber || "");
  const [address, setAddress] = useState(seat.address || "");
  const [confirmingVacate, setConfirmingVacate] = useState(false);
  const [vacateDepositStatus, setVacateDepositStatus] = useState(seat.depositStatus || "held");
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferRoomId, setTransferRoomId] = useState(roomId);
  const [transferSeatId, setTransferSeatId] = useState("");

  if (confirmingVacate) {
    return (
      <Modal onClose={onClose}>
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1">Cabin · {seat.number || seatId}</div>
        <h3 className="font-serif text-[22px] text-[#EDE6D6] mb-3" style={{ fontFamily: "'Fraunces', serif" }}>
          Vacate this cabin?
        </h3>
        <p className="text-[#8A93A6] text-[13.5px] leading-relaxed mb-5">
          {occupant || "This occupant"}'s details will move to the vacate list and this cabin will become vacant. This can't be undone.
        </p>

        <div className="mb-6">
          <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Caution deposit (₹{depositAmount})</span>
          <div className="flex gap-2">
            {[
              { key: "held", label: "Still held" },
              { key: "refunded", label: "Refunded" },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => setVacateDepositStatus(opt.key)}
                className="flex-1 py-2 rounded-lg text-[13px] border transition-colors"
                style={{
                  borderColor: vacateDepositStatus === opt.key ? "#E8A33D" : "#333947",
                  color: vacateDepositStatus === opt.key ? "#E8A33D" : "#7C8698",
                  background: vacateDepositStatus === opt.key ? "#20242C" : "#181B22",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <PillButton variant="ghost" className="flex-1" onClick={() => setConfirmingVacate(false)}>
            Cancel
          </PillButton>
          <PillButton variant="danger" className="flex-1" onClick={() => onVacate(seatId, vacateDepositStatus)}>
            Confirm vacate
          </PillButton>
        </div>
      </Modal>
    );
  }

  if (showTransfer) {
    const targetRoom = rooms.find((r) => r.id === transferRoomId);
    const vacantSeats = targetRoom
      ? Object.entries(targetRoom.seats).filter(
          ([id, s]) => s.type === "seat" && s.status === "vacant" && !(targetRoom.id === roomId && id === seatId)
        )
      : [];
    return (
      <Modal onClose={onClose}>
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1">Cabin · {seat.number || seatId}</div>
        <h3 className="font-serif text-[22px] text-[#EDE6D6] mb-3" style={{ fontFamily: "'Fraunces', serif" }}>
          Transfer {occupant || "occupant"}
        </h3>
        <p className="text-[#8A93A6] text-[13.5px] leading-relaxed mb-5">
          Move them to a different vacant cabin. Their fee, deposit, and ID details move with them — this isn't a vacate.
        </p>

        <label className="block mb-4">
          <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Room</span>
          <select
            value={transferRoomId}
            onChange={(e) => {
              setTransferRoomId(e.target.value);
              setTransferSeatId("");
            }}
            className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2.5 text-[#EDE6D6] text-[14px] focus:outline-none focus:border-[#E8A33D]"
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block mb-6">
          <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Cabin</span>
          <select
            value={transferSeatId}
            onChange={(e) => setTransferSeatId(e.target.value)}
            className="w-full bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2.5 text-[#EDE6D6] text-[14px] focus:outline-none focus:border-[#E8A33D]"
          >
            <option value="">Select a vacant cabin</option>
            {vacantSeats.map(([id, s]) => (
              <option key={id} value={id}>
                {s.number || id}
              </option>
            ))}
          </select>
          {vacantSeats.length === 0 && <p className="text-[#C1554A] text-[12px] mt-1.5">No vacant cabins in this room.</p>}
        </label>

        <div className="flex gap-2 mt-4">
          <PillButton variant="ghost" className="flex-1" onClick={() => setShowTransfer(false)}>
            Cancel
          </PillButton>
          <PillButton
            className="flex-1"
            disabled={!transferSeatId}
            onClick={() => {
              const targetSeat = targetRoom?.seats[transferSeatId];
              onTransfer(transferRoomId, transferSeatId, targetSeat?.number || transferSeatId);
            }}
          >
            Confirm transfer
          </PillButton>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1">Cabin · {seat.number || seatId}</div>
      <h3 className="font-serif text-[22px] text-[#EDE6D6] mb-5" style={{ fontFamily: "'Fraunces', serif" }}>
        {seat.status === "occupied" ? "Edit occupant" : "Assign seat"}
      </h3>

      <Field label="Seat number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 12 or A1" />
      <Field label="Occupant name" value={occupant} onChange={(e) => setOccupant(e.target.value)} placeholder="Full name" />
      <Field
        label="Phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        onBlur={() => setPhone((v) => formatIndianPhone(v))}
        placeholder="98470 xxxxx"
      />
      <p className="text-[#7C8698] text-[11px] -mt-3 mb-4">+91 is added automatically if you don't type a country code.</p>
      <Field label="Monthly fee (₹)" type="number" value={fee} onChange={(e) => setFee(Number(e.target.value))} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Last due date" type="date" value={lastDueDate} onChange={(e) => setLastDueDate(e.target.value)} />
        <Field label="Next due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <Field label="Payment date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />

      <div className="mb-6">
        <span className="block text-[11px] uppercase tracking-[0.14em] text-[#8A93A6] mb-1.5">Payment status</span>
        <div className="flex gap-2">
          {Object.entries(PAYMENT_META).map(([key, meta]) => (
            <button
              key={key}
              onClick={() => {
                setPaymentStatus(key);
                if (key === "paid") {
                  const justPaidFor = dueDate || lastDueDate;
                  setLastDueDate(justPaidFor);
                  setDueDate(addDays(justPaidFor, extendDays));
                  setPaymentDate(todayISO());
                }
              }}
              className="flex-1 py-2 rounded-lg text-[13px] border transition-colors"
              style={{
                borderColor: paymentStatus === key ? meta.color : "#333947",
                color: paymentStatus === key ? meta.color : "#7C8698",
                background: paymentStatus === key ? "#20242C" : "#181B22",
              }}
            >
              {meta.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 mt-2.5">
          <span className="text-[#7C8698] text-[11.5px]">Marking Paid advances the next due date by</span>
          <input
            type="number"
            min={1}
            value={extendDays}
            onChange={(e) => setExtendDays(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 bg-[#1B1F27] border border-[#333947] rounded-md px-2 py-1 text-[#EDE6D6] text-[12.5px] focus:outline-none focus:border-[#E8A33D]"
          />
          <span className="text-[#7C8698] text-[11.5px]">days, from the last due date.</span>
        </label>

        {paymentStatus === "paid" && (
          <button
            onClick={() => {
              setPaymentStatus("due");
              setDueDate(lastDueDate || dueDate);
              setPaymentDate("");
            }}
            className="mt-3 w-full text-center py-2 rounded-lg text-[13px] border border-[#333947] text-[#7C8698] hover:text-[#C1554A] hover:border-[#C1554A] transition-colors"
          >
            Re-mark as unpaid
          </button>
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
          <IdCard className="w-3.5 h-3.5" /> ID verification
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

      <div className="flex gap-2 mt-4">
        <PillButton
          className="flex-1"
          onClick={() => {
            if (!occupant.trim()) return;
            onSave(seatId, {
              type: "seat",
              status: "occupied",
              number: number.trim() || seatId,
              occupant,
              phone: formatIndianPhone(phone),
              fee,
              paymentStatus,
              lastDueDate,
              dueDate,
              paymentDate,
              depositAmount,
              depositStatus,
              aadhaarFront,
              aadhaarBack,
              addressProof,
              aadhaarNumber,
              address,
              assignedAt: seat.status === "occupied" ? seat.assignedAt || todayISO() : todayISO(),
            });
          }}
        >
          Save
        </PillButton>
        {seat.status === "occupied" && (
          <PillButton variant="ghost" onClick={() => setShowTransfer(true)}>
            Transfer
          </PillButton>
        )}
        {seat.status === "occupied" && (
          <PillButton variant="danger" onClick={() => setConfirmingVacate(true)}>
            Vacate
          </PillButton>
        )}
      </div>

      {seat.status === "occupied" &&
        phone.replace(/\D/g, "") &&
        (() => {
          const message = applyReminderTemplate(reminderTemplate, {
            occupant,
            number: number.trim() || seatId,
            roomName,
            fee,
            dueDate,
          });
          const waLink = `https://wa.me/${formatIndianPhone(phone).replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
          return (
            <a href={waLink} target="_blank" rel="noopener noreferrer">
              <PillButton variant="ghost" className="w-full mt-2">
                <MessageCircle className="w-3.5 h-3.5 inline -mt-0.5 mr-1.5" /> Send reminder on WhatsApp
              </PillButton>
            </a>
          );
        })()}
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

function RoomBoard({ room, rooms, onSeatUpdate, onVacate, onTransfer, reminderTemplate, editMode, onToggleEdit, onAddRow, onAddCol }) {
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
        if (s.paymentStatus === "overdue") overdue++;
      }
    });
    return { vacant, occupied, overdue, entries, acs, bathrooms };
  }, [room.seats]);

  const activeSeat = activeSeatId ? room.seats[activeSeatId] : null;

  const seatMatchesFilter = (seat) => {
    if (filter === "all") return true;
    if (filter === "vacant") return seat.status === "vacant";
    return seat.status === "occupied" && seat.paymentStatus === filter;
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
          <span className="flex items-center gap-1.5 text-[#E8A33D]">
            <LampDot status="vacant" size={8} /> {counts.vacant} vacant
          </span>
          <span className="flex items-center gap-1.5 text-[#7C8698]">
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
          roomId={room.id}
          roomName={room.name}
          rooms={rooms}
          reminderTemplate={reminderTemplate}
          onClose={() => setActiveSeatId(null)}
          onSave={(id, data) => {
            onSeatUpdate(id, data);
            setActiveSeatId(null);
          }}
          onVacate={(id, depositStatus) => {
            onVacate(id, activeSeat, depositStatus);
            setActiveSeatId(null);
          }}
          onTransfer={(toRoomId, toSeatId, toSeatNumber) => {
            onTransfer(room.id, activeSeatId, activeSeat.number || activeSeatId, toRoomId, toSeatId, toSeatNumber, activeSeat);
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
  { key: "vacated", label: "Vacated", icon: LogOut },
  { key: "reminders", label: "Reminders", icon: Bell },
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
  const [copiedId, setCopiedId] = useState(null);
  const [roomModal, setRoomModal] = useState(null); // null | 'add' | 'edit'
  const [storageWarning, setStorageWarning] = useState("");
  const [exportingDocs, setExportingDocs] = useState(false);
  const [exportNote, setExportNote] = useState("");
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [vacatedOccupants, setVacatedOccupants] = useState([]);
  const [lastVacate, setLastVacate] = useState(null); // { recordId, roomId, seatId, seatSnapshot, timeoutId }
  const [vacatedSearch, setVacatedSearch] = useState("");
  const [vacatedFrom, setVacatedFrom] = useState("");
  const [vacatedTo, setVacatedTo] = useState("");

  const room = rooms.find((r) => r.id === selectedRoomId) || rooms[0];

  const updateSeatInRoom = (roomId, seatId, data) => {
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, seats: { ...r.seats, [seatId]: data } } : r)));
  };

  // Moves an occupant's details off the seat and into the vacate list, then
  // frees the seat. The deposit refund choice made in the confirmation step
  // is what gets recorded — not whatever the seat's own field said before.
  // Keeps a short-lived snapshot around so a misclick can be undone.
  const vacateOccupant = (seatId, seatSnapshot, depositStatus) => {
    if (lastVacate?.timeoutId) clearTimeout(lastVacate.timeoutId);
    const vacatedAt = new Date().toISOString();
    const recordId = `vac-${Date.now()}`;
    const record = {
      id: recordId,
      roomId: room.id,
      roomName: room.name,
      seatNumber: seatSnapshot.number || seatId,
      occupant: seatSnapshot.occupant || "",
      phone: seatSnapshot.phone || "",
      fee: seatSnapshot.fee || 0,
      dueDate: seatSnapshot.dueDate || "",
      depositAmount: seatSnapshot.depositAmount || 0,
      depositStatus,
      aadhaarNumber: seatSnapshot.aadhaarNumber || "",
      address: seatSnapshot.address || "",
      assignedAt: seatSnapshot.assignedAt || null,
      vacatedAt,
    };
    setVacatedOccupants((prev) => [record, ...prev]);
    updateSeatInRoom(room.id, seatId, { type: "seat", status: "vacant", number: seatSnapshot.number || seatId });

    const timeoutId = setTimeout(() => {
      setLastVacate((cur) => (cur?.recordId === recordId ? null : cur));
    }, 8000);
    setLastVacate({ recordId, roomId: room.id, seatId, seatSnapshot, timeoutId });
  };

  const undoLastVacate = () => {
    if (!lastVacate) return;
    clearTimeout(lastVacate.timeoutId);
    setVacatedOccupants((prev) => prev.filter((v) => v.id !== lastVacate.recordId));
    updateSeatInRoom(lastVacate.roomId, lastVacate.seatId, { ...lastVacate.seatSnapshot, type: "seat", status: "occupied" });
    setLastVacate(null);
  };

  // Moves an occupant to a different (vacant) seat, in this room or another,
  // without going through vacate — fee, deposit, ID details, and how long
  // they've been a tenant all carry over.
  const transferOccupant = (fromRoomId, fromSeatId, fromSeatNumber, toRoomId, toSeatId, toSeatNumber, seatSnapshot) => {
    updateSeatInRoom(fromRoomId, fromSeatId, { type: "seat", status: "vacant", number: fromSeatNumber });
    updateSeatInRoom(toRoomId, toSeatId, { ...seatSnapshot, type: "seat", status: "occupied", number: toSeatNumber });
  };

  const filteredVacated = vacatedOccupants.filter((v) => {
    if (vacatedSearch.trim() && !(v.occupant || "").toLowerCase().includes(vacatedSearch.trim().toLowerCase())) return false;
    const vacatedDate = (v.vacatedAt || "").slice(0, 10);
    if (vacatedFrom && vacatedDate < vacatedFrom) return false;
    if (vacatedTo && vacatedDate > vacatedTo) return false;
    return true;
  });

  const stayDurations = vacatedOccupants
    .map((v) => daysBetween(v.assignedAt, v.vacatedAt))
    .filter((d) => d != null && d >= 0);
  const avgStayDays = stayDurations.length ? Math.round(stayDurations.reduce((a, b) => a + b, 0) / stayDurations.length) : null;

  // Builds a PDF of everyone who has vacated — occupant, room/seat, fee,
  // deposit amount and whether it was refunded, and the date they left.
  // Respects whatever search/date filter is currently applied to the list.
  const handleDownloadVacatePdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const rows = filteredVacated.map((v) => [
      v.roomName,
      v.seatNumber,
      v.occupant || "—",
      v.phone || "—",
      `₹${v.fee || 0}`,
      `₹${v.depositAmount || 0} (${v.depositStatus === "refunded" ? "Refunded" : "Held"})`,
      v.aadhaarNumber || "—",
      v.address || "—",
      v.vacatedAt ? new Date(v.vacatedAt).toLocaleDateString("en-IN") : "—",
    ]);

    doc.setFontSize(14);
    doc.text("Reading Room — Vacated Occupants", 40, 36);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Generated ${new Date().toLocaleString("en-IN")}`, 40, 50);

    autoTable(doc, {
      startY: 62,
      head: [["Room", "Seat", "Occupant", "Phone", "Fee", "Deposit", "Aadhaar no.", "Address", "Vacated on"]],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [20, 23, 28], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        2: { cellWidth: 80 },
        7: { cellWidth: 130 },
      },
    });

    doc.save(`vacate-list-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

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
            s.status === "occupied" ? (PAYMENT_META[s.paymentStatus]?.label ?? "—") : "—",
            s.status === "occupied" ? formatDueDate(s.dueDate) : "—",
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
      head: [["Room", "Seat", "Status", "Occupant", "Phone", "Fee", "Payment", "Due date", "Deposit", "Aadhaar no.", "Address"]],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [20, 23, 28], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        3: { cellWidth: 80 },
        10: { cellWidth: 140 },
      },
    });

    doc.save(`seat-details-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  // On first load: pull rooms/settings from Supabase, then merge back in any ID
  // document photos this browser remembers locally (those never live in Supabase).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const localDocs = loadLocalDocs();
      const remote = await fetchAppState();
      if (cancelled) return;

      if (remote && Array.isArray(remote.rooms) && remote.rooms.length) {
        setRooms(normalizePhonesInRooms(mergeDocsIntoRooms(remote.rooms, localDocs)));
        if (remote.selected_room_id) setSelectedRoomId(remote.selected_room_id);
        if (remote.reminder_template) {
          setReminderTemplate(remote.reminder_template);
          setReminderDraft(remote.reminder_template);
        }
        if (Array.isArray(remote.vacated)) {
          setVacatedOccupants(normalizePhonesInVacated(mergeVacatedDocs(remote.vacated, localDocs)));
        }
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

  // Push every change to Supabase (ID document photos are stripped out first and
  // kept in localStorage only — they're never sent to the database).
  useEffect(() => {
    if (!hydrated) return;
    const { cleanRooms, docsMap: roomsDocsMap } = stripDocsForSync(rooms);
    const { cleanVacated, docsMap: vacatedDocsMap } = stripVacatedDocsForSync(vacatedOccupants);
    const docsOk = saveLocalDocs({ ...roomsDocsMap, ...vacatedDocsMap });
    saveAppState({ rooms: cleanRooms, selectedRoomId, reminderTemplate, vacated: cleanVacated })
      .then(() => {
        setStorageWarning(docsOk ? "" : "Couldn't save an ID photo locally — storage may be full.");
      })
      .catch(() => {
        setStorageWarning("Couldn't save your last change to Supabase — check your connection.");
      });
  }, [rooms, selectedRoomId, reminderTemplate, vacatedOccupants, hydrated]);

  const updateSeat = (seatId, data) => updateSeatInRoom(selectedRoomId, seatId, data);

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
      Object.entries(rm.seats).forEach(([seatId, s]) => {
        if (s.type === "seat" && s.status === "occupied") {
          list.push({ ...s, seatId, roomName: rm.name });
        }
      });
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
        if (s.paymentStatus === "paid") paidAmt += fee;
        else if (s.paymentStatus === "due") dueAmt += fee;
        else if (s.paymentStatus === "overdue") overdueAmt += fee;
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
        .map((o) => ({ ...o, daysLeft: daysUntilDue(o.dueDate) }))
        .filter((o) => o.daysLeft !== null && (o.daysLeft === 3 || o.daysLeft === 1 || o.daysLeft <= 0) && o.paymentStatus !== "paid")
        .sort((a, b) => a.daysLeft - b.daysLeft),
    [allOccupants]
  );

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
        .active\:scale-\[0\.97\]:active { transform: scale(0.97); }
        .bg-\[\#101B26\] { background-color: #101B26; }
        .bg-\[\#12151B\] { background-color: #12151B; }
        .bg-\[\#131F14\] { background-color: #131F14; }
        .bg-\[\#132228\] { background-color: #132228; }
        .bg-\[\#14171C\] { background-color: #14171C; }
        .bg-\[\#15181E\] { background-color: #15181E; }
        .bg-\[\#181B22\] { background-color: #181B22; }
        .bg-\[\#1B1F27\] { background-color: #1B1F27; }
        .bg-\[\#22262F\] { background-color: #22262F; }
        .bg-\[\#2A1815\] { background-color: #2A1815; }
        .bg-\[\#2A2115\] { background-color: #2A2115; }
        .bg-\[\#C1554A\] { background-color: #C1554A; }
        .bg-\[\#E8A33D\] { background-color: #E8A33D; }
        .border-\[\#22262F\] { border-color: #22262F; }
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
        .hover\:border-\[\#5B6472\]:hover { border-color: #5B6472; }
        .hover\:border-\[\#E8A33D\]:hover { border-color: #E8A33D; }
        .hover\:text-\[\#E8A33D\]:hover { color: #E8A33D; }
        .hover\:text-\[\#EDE6D6\]:hover { color: #EDE6D6; }
        .placeholder-\[\#5B6472\]::placeholder { color: #5B6472; opacity: 1; }
        @media (min-width: 640px) { .sm\:h-\[60vh\] { height: 60vh; } }
        .text-\[\#14171C\] { color: #14171C; }
        .text-\[\#3A3F4B\] { color: #3A3F4B; }
        .text-\[\#4A5162\] { color: #4A5162; }
        .text-\[\#4F7A63\] { color: #4F7A63; }
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
                    rooms={rooms}
                    onSeatUpdate={updateSeat}
                    onVacate={vacateOccupant}
                    onTransfer={transferOccupant}
                    reminderTemplate={reminderTemplate}
                    editMode={editMode}
                    onToggleEdit={() => setEditMode((v) => !v)}
                    onAddRow={addRow}
                    onAddCol={addCol}
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
              <h2 className="font-serif text-[24px] text-[#EDE6D6] mb-5" style={{ fontFamily: "'Fraunces', serif" }}>
                Monthly payment status
              </h2>
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
                      const meta = PAYMENT_META[o.paymentStatus];
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
                <div className="text-[#7C8698] text-[11px] uppercase tracking-wider mb-1">Average stay length</div>
                <div className="text-[#EDE6D6] text-[22px] font-medium" style={{ fontFamily: "'Fraunces', serif" }}>
                  {avgStayDays != null ? `${avgStayDays} days` : "—"}
                </div>
                <div className="text-[#5B6472] text-[11px] mt-0.5">
                  {avgStayDays != null ? `based on ${stayDurations.length} vacated occupant${stayDurations.length === 1 ? "" : "s"}` : "not enough vacate history yet"}
                </div>
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

          {activeTab === "vacated" && (
            <div>
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="font-serif text-[24px] text-[#EDE6D6]" style={{ fontFamily: "'Fraunces', serif" }}>
                  Vacated occupants
                </h2>
                <button
                  onClick={handleDownloadVacatePdf}
                  disabled={filteredVacated.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border border-[#2A2F3A] text-[#8A93A6] hover:text-[#E8A33D] hover:border-[#E8A33D] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  title="Download the filtered vacate list as a PDF"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Vacate list PDF
                </button>
              </div>
              <p className="text-[#7C8698] text-[13px] mb-4">Everyone who has vacated a cabin, and their caution deposit outcome.</p>

              <div className="flex flex-wrap gap-2 mb-4">
                <input
                  value={vacatedSearch}
                  onChange={(e) => setVacatedSearch(e.target.value)}
                  placeholder="Search by name…"
                  className="flex-1 min-w-[140px] bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] placeholder-[#5B6472] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                />
                <input
                  type="date"
                  value={vacatedFrom}
                  onChange={(e) => setVacatedFrom(e.target.value)}
                  className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  title="From date"
                />
                <input
                  type="date"
                  value={vacatedTo}
                  onChange={(e) => setVacatedTo(e.target.value)}
                  className="bg-[#1B1F27] border border-[#333947] rounded-lg px-3 py-2 text-[#EDE6D6] text-[13px] focus:outline-none focus:border-[#E8A33D]"
                  title="To date"
                />
                {(vacatedSearch || vacatedFrom || vacatedTo) && (
                  <button
                    onClick={() => {
                      setVacatedSearch("");
                      setVacatedFrom("");
                      setVacatedTo("");
                    }}
                    className="text-[12px] text-[#7C8698] hover:text-[#EDE6D6] px-2"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="bg-[#181B22] border border-[#2A2F3A] rounded-2xl overflow-hidden">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="border-b border-[#2A2F3A] text-[#7C8698] text-[11px] uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-medium">Occupant</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Room · Seat</th>
                      <th className="text-left px-4 py-3 font-medium">Deposit</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Stayed</th>
                      <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Vacated on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVacated.map((v) => {
                      const stay = daysBetween(v.assignedAt, v.vacatedAt);
                      return (
                        <tr key={v.id} className="border-b border-[#22262F] last:border-0">
                          <td className="px-4 py-3 text-[#EDE6D6]">{v.occupant}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell font-mono text-[12px]">
                            {v.roomName} · {v.seatNumber}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-[#8A93A6]">₹{v.depositAmount || 0} </span>
                            <span className={v.depositStatus === "refunded" ? "text-[#4F7A63]" : "text-[#E8A33D]"}>
                              ({v.depositStatus === "refunded" ? "Refunded" : "Held"})
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">{stay != null ? `${stay}d` : "—"}</td>
                          <td className="px-4 py-3 text-[#8A93A6] hidden sm:table-cell">
                            {v.vacatedAt ? new Date(v.vacatedAt).toLocaleDateString("en-IN") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredVacated.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-[#7C8698] text-[13px]">
                          {vacatedOccupants.length === 0 ? "No one has vacated yet." : "No matches for this search/filter."}
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

      {lastVacate && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-[#20242C] border border-[#333947] rounded-full pl-4 pr-2 py-2 flex items-center gap-3 shadow-lg">
          <span className="text-[13px] text-[#EDE6D6]">
            Vacated {lastVacate.seatSnapshot.occupant || "occupant"}.
          </span>
          <button
            onClick={undoLastVacate}
            className="text-[13px] text-[#E8A33D] font-medium px-2.5 py-1 rounded-full hover:bg-[#2A2F3A] transition-colors"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
