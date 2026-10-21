// ============================================================================
// LunaCore - Life dashboard: daily series store for correlations (main)
// ----------------------------------------------------------------------------
// config/life-series.local.json:
//   {v: 1, days: {'YYYY-MM-DD': {focusH, score, commits, proteinHit, kcalHit,
//                                sleep, energy, habits}}}
// One row per finished local day, written from the live score's inputs
// (lifecorrelate.seriesFromInputs) so the correlations can look further back
// than the score's 14-day input window. Each field is a number / boolean or
// null ("no data"). The newest MAX_DAYS days are kept. A write is skipped
// when nothing changed, so the score's once-a-minute poll does not rewrite
// the file. Persistence and the read/write contract: src/lifestore.js.
// ============================================================================

'use strict';

const { createStore } = require('./lifestore');
const { isDay } = require('./lifedays');

const MAX_DAYS = 180;
const NUM_FIELDS = { focusH: 24, score: 100, commits: 1000, sleep: 16, energy: 5, habits: 1 };
const BOOL_FIELDS = ['proteinHit', 'kcalHit'];

const defaults = () => ({ v: 1, days: {} });

function rowOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = {};
  for (const [k, max] of Object.entries(NUM_FIELDS)) {
    const v = raw[k];
    row[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  }
  for (const k of BOOL_FIELDS) row[k] = typeof raw[k] === 'boolean' ? raw[k] : null;
  return row;
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
  const days = Object.keys(src)
    .filter((d) => isDay(d) && rowOf(src[d]))
    .sort()
    .slice(-MAX_DAYS);
  return { v: 1, days: Object.fromEntries(days.map((d) => [d, rowOf(src[d])])) };
}

const store = createStore({ fileName: 'life-series.local.json', defaults, normalize });

const loadSeries = (file) => store.load(file);

/**
 * Merges `rows` (day -> row) in; a newer row for a day replaces the older one.
 * @returns {boolean} whether the file was written
 */
function recordSeries(rows, file) {
  const cur = store.load(file);
  const clean = Object.entries(rows || {}).filter(([d, r]) => isDay(d) && rowOf(r));
  const changed = clean.some(([d, r]) => JSON.stringify(cur.days[d] || null) !== JSON.stringify(rowOf(r)));
  if (!changed) return false;
  store.update((s) => ({ ...s, days: { ...s.days, ...Object.fromEntries(clean.map(([d, r]) => [d, rowOf(r)])) } }), file);
  return true;
}

module.exports = { loadSeries, recordSeries, normalize, MAX_DAYS };
