/**
 * tenmanlemura repo の `scripts/generate-availability.mjs` として複製・実行される。
 * workflow `update-availability.yml` から
 * `node scripts/generate-availability.mjs > /tmp/export.json` の形で呼ばれる。
 *
 * Firestore を Firebase Admin SDK + service account で直接 read し、旧 GAS
 * `api/availability-export` と互換の公開ページ用 availability JSON を stdout に出力する。
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const SK = {
  TANUSHIMARU_HOURS_START: "store.tanushimaru.hours_start",
  TANUSHIMARU_HOURS_END: "store.tanushimaru.hours_end",
  DAZAIFU_HOURS_START: "store.dazaifu.hours_start",
  DAZAIFU_HOURS_END: "store.dazaifu.hours_end",
  SLOT_DURATION_MIN: "schedule.slot_duration_min",
  COURSE_40_DURATION: "course.40.duration_min",
  COURSE_40_PRICE: "course.40.price",
  COURSE_40_PUBLIC: "course.40.public",
  COURSE_60_DURATION: "course.60.duration_min",
  COURSE_60_PRICE: "course.60.price",
  COURSE_60_PUBLIC: "course.60.public",
  COURSE_80_DURATION: "course.80.duration_min",
  COURSE_80_PRICE: "course.80.price",
  COURSE_80_PUBLIC: "course.80.public",
};

const SETTINGS_DEFAULTS = {
  "store.tanushimaru.hours_start": "10",
  "store.tanushimaru.hours_end": "19",
  "store.tanushimaru.guide_text": "",
  "store.tanushimaru.color_id": "2",
  "store.tanushimaru.aliases": "田主丸,たぬしまる,tanushimaru",
  "store.dazaifu.hours_start": "10",
  "store.dazaifu.hours_end": "19",
  "store.dazaifu.guide_text": "",
  "store.dazaifu.color_id": "5",
  "store.dazaifu.aliases": "太宰府,だざいふ,dazaifu",
  "store.event.color_id": "4",
  "store.event.aliases": "イベント,event",
  "schedule.slot_duration_min": "60",
  "schedule.afternoon_start": "13:00",
  "course.40.duration_min": "40",
  "course.40.price": "6000",
  "course.40.public": "true",
  "course.60.duration_min": "60",
  "course.60.price": "9000",
  "course.60.public": "true",
  "course.80.duration_min": "80",
  "course.80.price": "12000",
  "course.80.public": "true",
};

const STORE_LABEL = {
  tanushimaru: "田主丸店",
  dazaifu: "太宰府店",
  event: "イベント出店",
};

const SOURCE_VERSION = "node-v1";
const DEFAULT_WEEK_COUNT = 8;
const MAX_WEEK_COUNT = 12;
const JST_TIMEZONE = "Asia/Tokyo";

// Firestore reads 計測用（推定値・実 reads とのキャリブレーションに使用）
const readCounter = {
  settings: 0,
  schedules: 0,
  blocks: 0,
  reservations: 0,
  get total() {
    return this.settings + this.schedules + this.blocks + this.reservations;
  },
};

async function main() {
  const startMonday = requireEnv("START_MONDAY");
  const baseDate = parseDateKey(startMonday);
  if (!baseDate) {
    throw new Error("Invalid START_MONDAY: " + startMonday);
  }

  const startDate = parseDateKey(weekMondayStr(baseDate));
  const weekCount = parseWeekCount(process.env.WEEK_COUNT);
  const db = initializeFirestore();
  const weeks = [];

  for (let i = 0; i < weekCount; i++) {
    const mon = addDays(startDate, i * 7);
    const monStr = fmtDateKey(mon);
    weeks.push(await getWeek(db, monStr));
  }

  const payload = {
    ok: true,
    generated_at: nowIsoJST(),
    source_version: SOURCE_VERSION,
    weeks,
  };

  process.stdout.write(JSON.stringify(payload) + "\n");

  // Firestore reads 推定値を stderr に出力（workflow ログで確認可能）
  // Firebase Console の当日 reads と照合してキャリブレーション用途
  process.stderr.write(
    `[read-counter] settings=${readCounter.settings} ` +
    `schedules=${readCounter.schedules} ` +
    `blocks=${readCounter.blocks} ` +
    `reservations=${readCounter.reservations} ` +
    `total=${readCounter.total} ` +
    `week_count=${weekCount}\n`
  );
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(name + " is not set");
  }
  return value;
}

function initializeFirestore() {
  const raw = requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON parse failed: " + (err?.message || err));
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must include client_email, private_key, and project_id");
  }

  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  return getFirestore();
}

function parseWeekCount(raw) {
  const requested = parseInt(raw || "", 10);
  const count = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WEEK_COUNT;
  return Math.max(1, Math.min(MAX_WEEK_COUNT, count));
}

async function getWeek(db, mondayStr) {
  const mon = parseDateKey(mondayStr);
  if (!mon) throw new Error("Invalid monday date: " + mondayStr);

  const endStr = fmtDateKey(addDays(mon, 6));
  const [settings, schedules, blocks, reservationRows] = await Promise.all([
    fetchSettings(db),
    fetchSchedules(db, mondayStr, endStr),
    fetchBlocks(db, mondayStr, endStr),
    fetchReservations(db, mondayStr, endStr),
  ]);

  const slotMin = getSlotDurationMin(settings);
  const reservations = groupReservationsByDate(reservationRows);
  const days = [];

  for (let i = 0; i < 7; i++) {
    const key = fmtDateKey(addDays(mon, i));
    days.push(buildDay(
      key,
      slotMin,
      schedules[key] || null,
      blocks[key] || [],
      reservations[key] || [],
      settings,
    ));
  }

  return {
    week_start: mondayStr,
    courses: getCourses(settings)
      .filter((c) => c.public)
      .map((c) => ({ code: c.code, duration_min: c.duration_min, price: c.price })),
    days,
  };
}

function buildDay(dateStr, slotMin, schedule, blocks, reservations, settings) {
  const plannedStore = schedule ? schedule.planned_store : "both";
  if (plannedStore === "closed") {
    return {
      date: dateStr,
      day_status: "closed",
      location_code: null,
      location_label: null,
      slots: [],
    };
  }
  if (plannedStore === "event") {
    return {
      date: dateStr,
      day_status: "event",
      location_code: null,
      event_name: schedule.event_name || "",
      event_venue: schedule.event_venue || "",
      slots: [],
    };
  }

  const locationCode = resolveLocationCode(plannedStore, reservations);
  if (!locationCode) {
    const defaultHours = getStoreHours(settings, "tanushimaru");
    const defaultSlots = generateSlots(defaultHours, slotMin);
    const appliedDefault = applyBlocks(defaultSlots, blocks);
    return {
      date: dateStr,
      day_status: deriveDayStatus(appliedDefault),
      location_code: null,
      location_label: null,
      slots: appliedDefault,
    };
  }

  const hours = getStoreHours(settings, locationCode);
  const slots = generateSlots(hours, slotMin);
  const reservationBlocks = reservations
    .filter((r) => r.store_code === locationCode)
    .map((r) => ({ start_time: r.start_time, end_time: r.end_time, _source: "reservation" }));
  const applied = applyBlocks(slots, blocks.concat(reservationBlocks));

  return {
    date: dateStr,
    day_status: deriveDayStatus(applied),
    location_code: locationCode,
    location_label: STORE_LABEL[locationCode],
    slots: applied,
  };
}

function resolveLocationCode(plannedStore, reservations) {
  if (plannedStore === "tanushimaru" || plannedStore === "dazaifu") return plannedStore;
  const active = reservations.filter((r) => r.store_code === "tanushimaru" || r.store_code === "dazaifu");
  if (active.some((r) => r.store_code === "tanushimaru")) return "tanushimaru";
  if (active.some((r) => r.store_code === "dazaifu")) return "dazaifu";
  return null;
}

function generateSlots(hours, slotMin) {
  const sm = parseInt(slotMin, 10);
  if (!Number.isFinite(sm) || sm <= 0) return [];
  if (!hours || !Number.isFinite(hours.start) || !Number.isFinite(hours.end) || hours.end <= hours.start) return [];

  const result = [];
  const startMin = hours.start * 60;
  const endMin = hours.end * 60;
  for (let m = startMin; m + sm <= endMin; m += sm) {
    result.push({
      start: minToTime(m),
      end: minToTime(m + sm),
      status: "open",
    });
    if (result.length > 1000) break;
  }
  return result;
}

function applyBlocks(slots, blocks) {
  if (!blocks || blocks.length === 0) return slots;
  return slots.map((slot) => {
    const sM = timeToMin(slot.start);
    const eM = timeToMin(slot.end);
    const blocked = blocks.some((block) => {
      const bs = timeToMin(block.start_time);
      const be = timeToMin(block.end_time);
      return sM < be && bs < eM;
    });
    return blocked ? { ...slot, status: "blocked" } : slot;
  });
}

function deriveDayStatus(slots) {
  if (slots.length === 0) return "full";
  const blockedCount = slots.filter((slot) => slot.status === "blocked").length;
  if (blockedCount === 0) return "open";
  if (blockedCount === slots.length) return "full";
  return "limited";
}

function groupReservationsByDate(reservations) {
  const result = {};
  reservations.forEach((reservation) => {
    if (!result[reservation.visit_date]) result[reservation.visit_date] = [];
    result[reservation.visit_date].push(reservation);
  });
  return result;
}

async function fetchSettings(db) {
  const result = { ...SETTINGS_DEFAULTS };
  const snap = await db.collection("settings").get();
  readCounter.settings += snap.size;
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const key = data.key || doc.id;
    if (!key || key === "degraded_mode") return;
    if (!Object.prototype.hasOwnProperty.call(data, "value")) return;
    result[String(key)] = (data.value === "" || data.value === null || data.value === undefined)
      ? ""
      : String(data.value);
  });
  return result;
}

async function fetchSchedules(db, startStr, endStr) {
  const result = {};
  const snap = await db.collection("schedules")
    .where("date", ">=", startStr)
    .where("date", "<=", endStr)
    .orderBy("date")
    .get();
  readCounter.schedules += snap.size;

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const date = normalizeDateStr(data.date || doc.id);
    if (!date || data.active === false || data.deleted_at) return;
    result[date] = {
      date,
      planned_store: data.planned_store || "",
      event_name: data.event_name || "",
      event_venue: data.event_venue || "",
    };
  });
  return result;
}

async function fetchBlocks(db, startStr, endStr) {
  const result = {};
  const snap = await db.collection("blocks")
    .where("date", ">=", startStr)
    .where("date", "<=", endStr)
    .where("active", "==", true)
    .orderBy("date")
    .get();
  readCounter.blocks += snap.size;

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const date = normalizeDateStr(data.date);
    if (!date || data.active !== true || data.deleted_at) return;
    if (!result[date]) result[date] = [];
    result[date].push({
      block_id: doc.id,
      date,
      start_time: normalizeTime(data.start_time),
      end_time: normalizeTime(data.end_time),
      note: data.note || "",
    });
  });
  return result;
}

async function fetchReservations(db, startStr, endStr) {
  const snap = await db.collection("reservations")
    .where("visit_date", ">=", startStr)
    .where("visit_date", "<=", endStr)
    .where("status", "==", "active")
    .orderBy("visit_date")
    .get();
  readCounter.reservations += snap.size;

  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        reservation_id: doc.id,
        visit_date: normalizeDateStr(data.visit_date),
        status: data.status || "",
        start_time: normalizeTime(data.start_time),
        end_time: normalizeTime(data.end_time),
        store_code: data.store_code || "",
        course_code: data.course_code || "",
        customer_name: data.customer_name || "",
        customer_phone: data.customer_phone || "",
        note: data.note || "",
      };
    })
    .filter((r) => r.status === "active" && r.visit_date >= startStr && r.visit_date <= endStr)
    .sort((a, b) => {
      if (a.visit_date !== b.visit_date) return a.visit_date < b.visit_date ? -1 : 1;
      if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
      return a.reservation_id < b.reservation_id ? -1 : 1;
    });
}

function getSetting(settings, key, fallback) {
  const value = settings[key];
  return (value === undefined || value === null || value === "") ? fallback : value;
}

function getSettingInt(settings, key, fallback) {
  const n = parseInt(getSetting(settings, key, fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getStoreHours(settings, storeCode) {
  if (storeCode === "tanushimaru") {
    return {
      start: getSettingInt(settings, SK.TANUSHIMARU_HOURS_START, 10),
      end: getSettingInt(settings, SK.TANUSHIMARU_HOURS_END, 19),
    };
  }
  if (storeCode === "dazaifu") {
    return {
      start: getSettingInt(settings, SK.DAZAIFU_HOURS_START, 10),
      end: getSettingInt(settings, SK.DAZAIFU_HOURS_END, 19),
    };
  }
  return null;
}

// public: false のコースは公開 JSON に出さない（管理画面では引き続き有効）
function getCourses(settings) {
  return [
    {
      code: "40",
      duration_min: getSettingInt(settings, SK.COURSE_40_DURATION, 40),
      price: getSettingInt(settings, SK.COURSE_40_PRICE, 6000),
      public: getSetting(settings, SK.COURSE_40_PUBLIC, "true") !== "false",
    },
    {
      code: "60",
      duration_min: getSettingInt(settings, SK.COURSE_60_DURATION, 60),
      price: getSettingInt(settings, SK.COURSE_60_PRICE, 9000),
      public: getSetting(settings, SK.COURSE_60_PUBLIC, "true") !== "false",
    },
    {
      code: "80",
      duration_min: getSettingInt(settings, SK.COURSE_80_DURATION, 80),
      price: getSettingInt(settings, SK.COURSE_80_PRICE, 12000),
      public: getSetting(settings, SK.COURSE_80_PUBLIC, "true") !== "false",
    },
  ];
}

function getSlotDurationMin(settings) {
  return getSettingInt(settings, SK.SLOT_DURATION_MIN, 60);
}

function normalizeDateStr(value) {
  if (!value) return "";
  if (value instanceof Date) return fmtDateKey(value);
  if (typeof value.toDate === "function") return fmtDateKey(value.toDate());
  return String(value).slice(0, 10);
}

function normalizeTime(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (value instanceof Date) {
    return String(value.getUTCHours()).padStart(2, "0") + ":" + String(value.getUTCMinutes()).padStart(2, "0");
  }
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
  }

  const s = String(value).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const h = parseInt(match[1], 10);
  const mi = parseInt(match[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return "";
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}

function timeToMin(value) {
  const [h, m] = String(value).split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

function minToTime(value) {
  const h = Math.floor(value / 60);
  const mi = value % 60;
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const mo = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const date = new Date(Date.UTC(y, mo, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo || date.getUTCDate() !== d) return null;
  return date;
}

function fmtDateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function weekMondayStr(date) {
  const day = date.getUTCDay();
  return fmtDateKey(addDays(date, -(day === 0 ? 6 : day - 1)));
}

function nowIsoJST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

try {
  await main();
} catch (err) {
  process.stderr.write((err?.stack || err?.message || String(err)) + "\n");
  process.exit(1);
}
