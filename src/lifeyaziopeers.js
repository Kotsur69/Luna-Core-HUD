// ============================================================================
// LunaCore - YAZIO Body data over the cloud (main)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 2c. A PC logged in to YAZIO puts what the Body
// tab shows (lifeyazio.js body()) as its `yazio` snapshot; a PC that is not
// logged in shows the newest other PC's copy instead of only a login form.
//
// Only numbers and dates travel - never the YAZIO login. A row is written by
// another machine: untrusted. Only the known fields survive, each checked
// for type and range; anything off drops the row (a wrong number on a health
// card is worse than none).
// ============================================================================

'use strict';

const VERSION = 1;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY = 31;
/** Counts (kcal, grams, steps, ml) - far above any real day. */
const MAX_COUNT = 1e6;
const MAX_KG = 1000;

const COUNT_KEYS = [
  'kcal',
  'kcalGoal',
  'activityKcal',
  'protein',
  'proteinGoal',
  'fat',
  'fatGoal',
  'carb',
  'carbGoal',
  'steps',
  'stepsGoal',
  'water',
  'waterGoal',
];
const KG_KEYS = ['weight', 'startWeight', 'weightGoal'];
const HISTORY_KEYS = ['kcal', 'kcalGoal', 'protein', 'steps'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT;
const isKg = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_KG;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);

/** Picks `keys` from `src` when every one passes `ok`; null otherwise. */
function pickAll(src, keys, ok) {
  if (!isObject(src)) return null;
  const out = {};
  for (const k of keys) {
    if (!ok(src[k])) return null;
    out[k] = src[k];
  }
  return out;
}

/** body() -> the same shape with only known, in-range fields; null when any core field is off. */
function cleanBody(b, now) {
  if (!isObject(b) || !isDate(b.date) || !Array.isArray(b.history)) return null;
  const counts = pickAll(b.today, COUNT_KEYS, isCount);
  if (!counts) return null;
  const today = { ...counts };
  for (const k of KG_KEYS) today[k] = isKg(b.today[k]) ? b.today[k] : null;
  const history = [];
  for (const h of b.history.slice(-MAX_HISTORY)) {
    const nums = pickAll(h, HISTORY_KEYS, isCount);
    if (!nums || !isDate(h.date)) return null;
    history.push({ date: h.date, ...nums });
  }
  const w = b.lastWeighIn;
  const lastWeighIn = isObject(w) && isKg(w.value) && isDate(w.date) ? { value: w.value, date: w.date } : null;
  if (!Number.isFinite(b.fetchedAt) || b.fetchedAt <= 0) return null;
  // A far-future clock must not make a copy look fresh forever.
  return { date: b.date, today, history, lastWeighIn, fetchedAt: Math.min(b.fetchedAt, now) };
}

/** This PC's `yazio` snapshot body. */
function yazioSnapshot(body, now = Date.now()) {
  return { v: VERSION, body: cleanBody(body, now) };
}

/** A `yazio` row from cloudsnapshots.list() -> {machine, body} or null. */
function parseYazioPeer(row, now) {
  if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
  if (!isObject(row.data) || row.data.v !== VERSION) return null;
  const body = cleanBody(row.data.body, now);
  return body ? { machine: row.machine, body } : null;
}

/** The most recently fetched valid copy from the other PCs, or null; never throws. */
async function newestYazioPeer(cloud, now) {
  let rows = [];
  try {
    const live = cloud();
    rows = live ? await live.list('yazio') : [];
  } catch (err) {
    console.error('[life] yazio from other PCs unreadable:', err && err.message);
    return null;
  }
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = parseYazioPeer(r, now);
    if (p && (!best || p.body.fetchedAt > best.body.fetchedAt)) best = p;
  }
  return best;
}

module.exports = { yazioSnapshot, parseYazioPeer, newestYazioPeer };
