// ============================================================================
// LunaCore - Mission Control: Claude ledger maths (pure, shared with the phone)
// ----------------------------------------------------------------------------
// No fs: the phone bundles this (mobile/vite.config.js SHARED) to price the
// PCs' `ledger` snapshots itself. missionledger.js reads the transcripts,
// missionledgerservice.js builds the PC's report; both use these.
// ============================================================================

'use strict';

const { rateFor, estimateCost } = require('./ratecalc');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** {sinceMs, untilMs, source} for the current weekly window. */
function weekWindow(resetsAt, now) {
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > now && resetsAt <= now + WEEK_MS) {
    return { sinceMs: resetsAt - WEEK_MS, untilMs: now, source: 'reset' };
  }
  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return { sinceMs: monday.getTime(), untilMs: now, source: 'monday' };
}

/**
 * Prices rows inside [sinceMs, untilMs) and splits them by project. The
 * bucket holding sinceMs counts whole (hour granularity).
 * @param {Array} rows from ledger.rows() (any number of machines, concatenated)
 * @param {{sinceMs:number, untilMs:number, rates:{rates:Array,cacheReadMultiplier?:number,cacheWriteMultiplier?:number}}} opts
 */
function summarize(rows, { sinceMs, untilMs, rates }) {
  const from = sinceMs - (sinceMs % HOUR_MS);
  const byKey = new Map();
  let totalUsd = 0;
  let unpricedTokens = 0;
  for (const [hour, key, name, model, input, cacheWrite, cacheRead, output] of rows) {
    if (hour < from || hour >= untilMs) continue;
    let p = byKey.get(key);
    if (!p) {
      p = { key, name, usd: 0, tokens: 0, unpricedTokens: 0, share: 0 };
      byKey.set(key, p);
    }
    const tokens = input + cacheWrite + cacheRead + output;
    p.tokens += tokens;
    const cost = estimateCost({ input, output, cacheRead, cacheWrite }, rateFor(model, rates.rates), rates);
    if (cost) {
      p.usd += cost.usd;
      totalUsd += cost.usd;
    } else {
      p.unpricedTokens += tokens;
      unpricedTokens += tokens;
    }
  }
  const projects = [...byKey.values()]
    .map((p) => ({ ...p, share: totalUsd > 0 ? p.usd / totalUsd : 0 }))
    .sort((a, b) => b.usd - a.usd || b.unpricedTokens - a.unpricedTokens);
  return { totalUsd, unpricedTokens, projects };
}

module.exports = { summarize, weekWindow };
