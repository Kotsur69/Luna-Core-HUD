// ============================================================================
// LunaCore - God Mode post-merge results, as stored with the run
// ----------------------------------------------------------------------------
// orchestraFinalize.js runs its post-merge steps (update the local base,
// clean up, release, ...) and keeps each step's result in
// plan.integration.postMerge[<step name>]. The run is saved to disk and read
// back after a restart, so what comes back is cleaned here: plain objects of
// short strings, finite numbers, booleans and string lists, two levels deep
// at most. Unknown step names are kept (a later step adds its own) as long as
// they look like a name.
//
// Pure: no IO.
// ============================================================================

'use strict';

const STEP_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAX_STEPS = 12;
const MAX_KEYS = 24;
const MAX_STRING = 400;
const MAX_LIST = 50;
const MAX_DEPTH = 2;
const SHA_RE = /^[0-9a-f]{7,64}$/;
// Keys that would reach a prototype instead of an own entry.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const cleanString = (v) => v.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').slice(0, MAX_STRING);

function cleanValue(v, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return cleanString(v);
  if (Array.isArray(v)) {
    return v
      .slice(0, MAX_LIST)
      .map((item) => (isPlainObject(item) && depth < MAX_DEPTH ? cleanObject(item, depth + 1) : typeof item === 'string' ? cleanString(item) : undefined))
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(v) && depth < MAX_DEPTH) return cleanObject(v, depth + 1);
  return undefined;
}

function cleanObject(raw, depth) {
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_KEYS)) {
    if (!KEY_RE.test(key) || RESERVED.has(key)) continue;
    const clean = cleanValue(value, depth);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * @param {unknown} raw plan.integration.postMerge as stored
 * @returns {Object<string, object>} step name -> cleaned result ({} when none)
 */
function normalizePostMerge(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [name, result] of Object.entries(raw).slice(0, MAX_STEPS)) {
    if (!STEP_NAME_RE.test(name) || RESERVED.has(name) || !isPlainObject(result)) continue;
    out[name] = cleanObject(result, 0);
  }
  return out;
}

/** The landed head sha of a merge, or null. */
const normalizeSha = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v : null);

module.exports = { normalizePostMerge, normalizeSha, STEP_NAME_RE };
