// ============================================================================
// LunaCore - Life dashboard: local calendar days and ISO weeks (pure)
// ----------------------------------------------------------------------------
// Check-in, habits, goals and the productivity score all key their data by
// the LOCAL calendar day ('YYYY-MM-DD') or the ISO week ('2026-W43'). Day
// arithmetic always goes through new Date(y, m, d + n) - never +24 h - so a
// DST change can never skip or repeat a day.
// ============================================================================

'use strict';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day of a Date or epoch ms: 'YYYY-MM-DD'. */
function ymd(at) {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> local midnight Date, or null for anything that is not a real day. */
function parseDay(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  const date = new Date(y, mo - 1, d);
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

const isDay = (s) => parseDay(s) !== null;

/** The day `n` calendar days after `day` (n may be negative). */
function addDays(day, n) {
  const d = parseDay(day);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole calendar days from `a` to `b` (b - a). Rounded, so a 23/25 h DST day still counts as one. */
function dayDiff(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / 86400000);
}

/** Monday of the local Mon-Sun week holding `day`. */
function mondayOf(day) {
  const d = parseDay(day);
  return addDays(day, -((d.getDay() + 6) % 7));
}

/**
 * ISO 8601 week key: the week belongs to the year of its Thursday, week 1
 * holds the year's first Thursday. 2027-01-01 (a Friday) -> '2026-W53'.
 */
function isoWeek(day) {
  const thursday = parseDay(addDays(mondayOf(day), 3));
  const year = thursday.getFullYear();
  const week = Math.floor(dayDiff(`${year}-01-01`, ymd(thursday)) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** Monday of an ISO week key, or null when the key is malformed or out of range. */
function weekMonday(key) {
  const m = typeof key === 'string' ? WEEK_RE.exec(key) : null;
  if (!m) return null;
  const [year, week] = [Number(m[1]), Number(m[2])];
  if (year < MIN_YEAR || year > MAX_YEAR || week < 1 || week > 53) return null;
  // Jan 4 is always in week 1.
  const monday = addDays(mondayOf(`${year}-01-04`), (week - 1) * 7);
  return isoWeek(monday) === key ? monday : null;
}

const isWeek = (key) => weekMonday(key) !== null;

module.exports = { ymd, parseDay, isDay, addDays, dayDiff, mondayOf, isoWeek, weekMonday, isWeek };
