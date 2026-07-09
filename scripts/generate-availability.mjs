import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_API_BASE = "https://tenmanlemura.com/api/public";
const DEFAULT_WEEK_COUNT = 8;
const MAX_WEEK_COUNT = 12;
const DEFAULT_TIMEOUT_MS = 15_000;
const JST_TIMEZONE = "Asia/Tokyo";
const OUTPUT_DIR = path.join("schedule", "data", "weeks");

async function main() {
  const apiBase = normalizeApiBase(process.env.VPS_API_BASE || DEFAULT_API_BASE);
  const startDate = parseDateKey(weekMondayStr(resolveStartDate()));
  const weekCount = parseWeekCount(process.env.WEEK_COUNT);
  const generatedAt = nowIsoJst();
  const sourceVersion = process.env.GITHUB_SHA || "vps-api-import-v1";
  const written = [];

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (let i = 0; i < weekCount; i++) {
    const weekStart = fmtDateKey(addDays(startDate, i * 7));
    const apiPayload = await fetchAvailabilityWeek(apiBase, weekStart);
    const weekPayload = toStaticWeek(apiPayload, weekStart, generatedAt, sourceVersion);
    const outputPath = path.join(OUTPUT_DIR, `${weekPayload.week_start}.json`);
    await writeFile(outputPath, JSON.stringify(weekPayload, null, 2) + "\n", "utf8");
    written.push(outputPath);
  }

  process.stdout.write(`Generated ${written.length} availability week file(s)\n`);
  for (const outputPath of written) {
    process.stdout.write(`  wrote ${outputPath}\n`);
  }
}

function normalizeApiBase(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("VPS_API_BASE is empty");
  return trimmed.replace(/\/+$/, "");
}

function resolveStartDate() {
  if (process.env.START_MONDAY) {
    const parsed = parseDateKey(process.env.START_MONDAY);
    if (!parsed) throw new Error(`Invalid START_MONDAY: ${process.env.START_MONDAY}`);
    return parsed;
  }
  return parseDateKey(todayJstKey());
}

function parseWeekCount(raw) {
  const requested = Number.parseInt(String(raw || ""), 10);
  const count = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WEEK_COUNT;
  return Math.max(1, Math.min(MAX_WEEK_COUNT, count));
}

async function fetchAvailabilityWeek(apiBase, weekStart) {
  const url = new URL(`${apiBase}/availability`);
  url.searchParams.set("start", weekStart);
  url.searchParams.set("weeks", "1");

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(getTimeoutMs()),
    });
  } catch (err) {
    throw new Error(`Failed to fetch ${url}: ${err?.message || err}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 500)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${err?.message || err}`);
  }

  validateAvailabilityPayload(payload, weekStart, url);
  return payload;
}

function getTimeoutMs() {
  const value = Number.parseInt(String(process.env.VPS_API_TIMEOUT_MS || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function validateAvailabilityPayload(payload, expectedStart, url) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid availability payload from ${url}: root must be an object`);
  }
  if (payload.start !== expectedStart) {
    throw new Error(`Invalid availability payload from ${url}: start=${payload.start}, expected=${expectedStart}`);
  }
  if (payload.weeks !== 1) {
    throw new Error(`Invalid availability payload from ${url}: weeks must be 1`);
  }
  if (!Number.isFinite(payload.slot_duration_min)) {
    throw new Error(`Invalid availability payload from ${url}: slot_duration_min missing`);
  }
  if (!Array.isArray(payload.courses)) {
    throw new Error(`Invalid availability payload from ${url}: courses must be an array`);
  }
  if (!Array.isArray(payload.days) || payload.days.length !== 7) {
    throw new Error(`Invalid availability payload from ${url}: days must contain 7 entries`);
  }

  payload.days.forEach((day, index) => {
    const expectedDate = fmtDateKey(addDays(parseDateKey(expectedStart), index));
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      throw new Error(`Invalid day payload from ${url}: day[${index}] must be an object`);
    }
    if (day.date !== expectedDate) {
      throw new Error(`Invalid day payload from ${url}: day[${index}].date=${day.date}, expected=${expectedDate}`);
    }
    if (typeof day.day_status !== "string" || day.day_status === "") {
      throw new Error(`Invalid day payload from ${url}: day[${index}].day_status missing`);
    }
    if (!Object.prototype.hasOwnProperty.call(day, "location_code")) {
      throw new Error(`Invalid day payload from ${url}: day[${index}].location_code missing`);
    }
    if (!Array.isArray(day.slots)) {
      throw new Error(`Invalid day payload from ${url}: day[${index}].slots must be an array`);
    }
  });
}

function toStaticWeek(payload, weekStart, generatedAt, sourceVersion) {
  return {
    week_start: weekStart,
    courses: payload.courses,
    days: payload.days,
    generated_at: generatedAt,
    source_version: sourceVersion,
  };
}

function todayJstKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return partsToDateKey(parts);
}

function nowIsoJst() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIMEZONE,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date());
  const values = partsToObject(parts);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+09:00`;
}

function partsToDateKey(parts) {
  const values = partsToObject(parts);
  return `${values.year}-${values.month}-${values.day}`;
}

function partsToObject(parts) {
  return parts.reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
}

function weekMondayStr(date) {
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return fmtDateKey(addDays(date, diff));
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function fmtDateKey(date) {
  return date.toISOString().slice(0, 10);
}

main().catch((err) => {
  process.stderr.write(`[generate-availability] ERROR: ${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 1;
});
