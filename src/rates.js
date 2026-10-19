// ============================================================================
// LunaCore - session cost estimation (B4)
// ----------------------------------------------------------------------------
// Loads a price table from config/rates.json (plus a gitignored
// config/rates.local.json override) and computes cost from the TOKEN COUNTERS we
// already read out of the transcript. No network, no tokens - still a Passive
// Observer, just with multiplication. The maths lives in ratecalc.js (pure,
// shared with the phone); this file only reads the two JSON files.
//
// WHY THE PRICE TABLE LIVES IN CONFIG: prices go stale, and code should not lie.
// An unknown model yields NO estimate (null), never a guessed number. A wrong
// amount is worse than none, because it looks authoritative.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { mergeRates, rateFor, estimateCost, formatUsd, normalizeRate } = require('./ratecalc');

// The shipped price table is read from the bundled directory - that way an app
// update actually delivers corrected rates. The user's private override lives in
// the WRITABLE directory and is resolved lazily, since this module is required
// before app.whenReady(). Details in paths.js.
const BASE_FILE = paths.bundled('rates.json');
const localFile = () => paths.local('rates.local.json');

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Loads the price table: base merged with local (local overrides by id).
 * @returns {{rates: Array, cacheReadMultiplier: number, cacheWriteMultiplier: number}}
 */
function loadRates() {
  return mergeRates(readJson(BASE_FILE) || {}, readJson(localFile()));
}

module.exports = { loadRates, rateFor, estimateCost, formatUsd, normalizeRate };
