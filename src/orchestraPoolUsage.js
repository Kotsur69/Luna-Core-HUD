// ============================================================================
// LunaCore - current usage of a God Mode "Workers" pool, for the planner
// ----------------------------------------------------------------------------
// In a pool run (2+ ticked models) the planner prompt gets one optional line
// with each ticked model's current usage, so it can prefer the less-used
// model of the same tier:
//
//   - Current usage: opus 72% of its 5 h window, sonnet 72%, agy-argon 35%
//     of its weekly window - prefer the less-used model of the same tier
//
// main reads the numbers at makePlan time from the usage meter's latest
// reading (src/usage.js: Claude's windows, plus `others`, where the agy entry
// comes from src/agyusage.js and a free profile from src/providerusage.js):
//
//   poolUsageReadings(pool, usage)   [{key, percent, window}] per ticked model
//                                    with a reading; a model without one
//                                    (a free profile that reports none) is
//                                    left out
//   poolUsageLine(readings, keys)    the prompt line, or null for no data
//
// Pure, no I/O. No reading at all = no line = the prompt as before.
// ============================================================================

'use strict';

const { agyFamilyByPoolKey } = require('./agyFamilies');
const { normalizePool, poolKeyOf, runsOnOf, freeProfileIdOf, isPoolKey } = require('./workerPool');

/** The windows a reading may name, and how the prompt says them. */
const WINDOW_TEXT = Object.freeze({ '5h': '5 h window', daily: 'daily window', weekly: 'weekly window', monthly: 'monthly window' });
/** The agy entry of the usage meter's `others` (src/providerusage.js usageSourceForProfile). */
const AGY_PROVIDER_ID = 'antigravity';
const MAX_PERCENT = 100;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A usable limit: a known window and a finite percentage. */
const usableLimit = (l) => isObj(l) && Object.prototype.hasOwnProperty.call(WINDOW_TEXT, l.window) && Number.isFinite(l.percentUsed);

/** The tightest window of some limits ({percent, window}), else null. */
function tightest(limits) {
  const usable = (Array.isArray(limits) ? limits : []).filter(usableLimit);
  if (!usable.length) return null;
  const top = usable.reduce((best, l) => (l.percentUsed > best.percentUsed ? l : best));
  return { percent: Math.round(Math.min(MAX_PERCENT, Math.max(0, top.percentUsed))), window: top.window };
}

/** A provider entry that holds a reading (status 'ok'). */
const okEntry = (entry) => isObj(entry) && entry.status === 'ok' && Array.isArray(entry.limits);

/** The reading of one ticked model, else null. */
function readingOf(model, usage) {
  const key = poolKeyOf(model);
  const on = runsOnOf(key);
  const others = Array.isArray(usage.others) ? usage.others : [];
  // Claude: the meter's own reading (one login, so Opus and Sonnet share its windows).
  if (on === 'claude') return okEntry(usage) && (usage.providerId === undefined || usage.providerId === 'claude') ? tightest(usage.limits) : null;
  if (on === 'agy') {
    const family = agyFamilyByPoolKey(key);
    const agy = others.find((o) => okEntry(o) && o.providerId === AGY_PROVIDER_ID);
    return family && agy ? tightest(agy.limits.filter((l) => isObj(l) && l.model === family.usageRow)) : null;
  }
  // A free profile: only when its provider reports usage at all.
  const profileId = freeProfileIdOf(model);
  const entry = others.find((o) => okEntry(o) && o.profileId === profileId);
  return entry ? tightest(entry.limits) : null;
}

/**
 * Each ticked model's current usage, in pool order; models without a
 * reading are left out.
 * @param {unknown} pool the run's pool ([{model, effort}])
 * @param {unknown} usage the usage meter's latest reading (main's latestUsage)
 * @returns {{key:string, percent:number, window:string}[]}
 */
function poolUsageReadings(pool, usage) {
  if (!isObj(usage)) return [];
  return (normalizePool(pool) || [])
    .map((e) => {
      const reading = readingOf(e.model, usage);
      return reading ? { key: poolKeyOf(e.model), ...reading } : null;
    })
    .filter(Boolean);
}

/**
 * The planner prompt's usage line, or null when no ticked model has a
 * reading. A window is named once and again only where it changes.
 * @param {unknown} readings poolUsageReadings() output (checked again here)
 * @param {string[]} [keys] the run's planner keys: readings of other keys are dropped
 * @returns {string|null}
 */
function poolUsageLine(readings, keys = null) {
  const allowed = Array.isArray(keys) ? keys : null;
  const list = (Array.isArray(readings) ? readings : []).filter(
    (r) => isObj(r) && isPoolKey(r.key) && (!allowed || allowed.includes(r.key))
      && Number.isFinite(r.percent) && Object.prototype.hasOwnProperty.call(WINDOW_TEXT, r.window),
  );
  if (!list.length) return null;
  const parts = list.map((r, i) => {
    const percent = Math.round(Math.min(MAX_PERCENT, Math.max(0, r.percent)));
    const sameWindow = i > 0 && list[i - 1].window === r.window;
    return `${r.key} ${percent}%${sameWindow ? '' : ` of its ${WINDOW_TEXT[r.window]}`}`;
  });
  return `- Current usage: ${parts.join(', ')} - prefer the less-used model of the same tier.`;
}

module.exports = { poolUsageReadings, poolUsageLine };
