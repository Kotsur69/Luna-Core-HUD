// ============================================================================
// LunaCore - session cost estimation (B4)
// ----------------------------------------------------------------------------
// Loads a price table from config/rates.json (plus a gitignored
// config/rates.local.json override) and computes cost from the TOKEN COUNTERS we
// already read out of the transcript. No network, no tokens - still a Passive
// Observer, just with multiplication.
//
// WHY THE PRICE TABLE LIVES IN CONFIG: prices go stale, and code should not lie.
// An unknown model yields NO estimate (null), never a guessed number. A wrong
// amount is worse than none, because it looks authoritative.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'rates.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'rates.local.json');

const TOKENS_PER_UNIT = 1000000; // prices are quoted "per million tokens"

// Fallback cache multipliers used when the config does not supply them.
const FALLBACK_CACHE_READ = 0.1;
const FALLBACK_CACHE_WRITE = 1.25;

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Validates a single price-table entry. Returns an object or null. */
function normalizeRate(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.input !== 'number' || !(r.input >= 0)) return null;
  if (typeof r.output !== 'number' || !(r.output >= 0)) return null;
  return { id: r.id, input: r.input, output: r.output };
}

/**
 * Loads the price table: base merged with local (local overrides by id).
 * @returns {{rates: Array, cacheReadMultiplier: number, cacheWriteMultiplier: number}}
 */
function loadRates() {
  const base = readJson(BASE_FILE) || {};
  const local = readJson(LOCAL_FILE);

  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.rates)) return;
    for (const raw of src.rates) {
      const r = normalizeRate(raw);
      if (r) byId.set(r.id, r);
    }
  };
  collect(base);
  collect(local);

  const pick = (key, fallback) => {
    for (const src of [local, base]) {
      if (src && typeof src[key] === 'number' && src[key] >= 0) return src[key];
    }
    return fallback;
  };

  return {
    rates: [...byId.values()],
    cacheReadMultiplier: pick('cacheReadMultiplier', FALLBACK_CACHE_READ),
    cacheWriteMultiplier: pick('cacheWriteMultiplier', FALLBACK_CACHE_WRITE),
  };
}

/**
 * Finds the rate for a model id. Exact match first, then the longest matching
 * prefix (transcripts sometimes carry a date suffix, e.g.
 * "claude-opus-4-8-20260115"). No match returns null - see the header: we prefer
 * no number over a wrong one.
 * @returns {{id:string,input:number,output:number}|null}
 */
function rateFor(model, rates) {
  const id = String(model || '').toLowerCase();
  if (!id || !Array.isArray(rates)) return null;

  let best = null;
  for (const r of rates) {
    const candidate = r.id.toLowerCase();
    if (id === candidate) return r;
    if (id.startsWith(candidate) && (!best || candidate.length > best.id.length)) {
      best = r;
    }
  }
  return best;
}

/**
 * Estimates cost from cumulative token counters.
 * @param {{input?:number,output?:number,cacheRead?:number,cacheWrite?:number}} totals
 * @param {{input:number,output:number}} rate
 * @param {{cacheReadMultiplier?:number,cacheWriteMultiplier?:number}} [mult]
 * @returns {{usd:number, input:number, output:number, cacheRead:number, cacheWrite:number}|null}
 */
function estimateCost(totals, rate, mult = {}) {
  if (!rate || !totals) return null;
  const readMult =
    typeof mult.cacheReadMultiplier === 'number' ? mult.cacheReadMultiplier : FALLBACK_CACHE_READ;
  const writeMult =
    typeof mult.cacheWriteMultiplier === 'number' ? mult.cacheWriteMultiplier : FALLBACK_CACHE_WRITE;

  const per = (tokens, price) => ((tokens || 0) / TOKENS_PER_UNIT) * price;
  const input = per(totals.input, rate.input);
  const output = per(totals.output, rate.output);
  // Cache is priced off the INPUT rate, scaled by its multiplier.
  const cacheRead = per(totals.cacheRead, rate.input * readMult);
  const cacheWrite = per(totals.cacheWrite, rate.input * writeMult);

  return { usd: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite };
}

/** Formats a USD amount, widening precision for small numbers. */
function formatUsd(usd) {
  if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

module.exports = { loadRates, rateFor, estimateCost, formatUsd, normalizeRate };
