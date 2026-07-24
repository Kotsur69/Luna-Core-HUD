// ============================================================================
// LunaCore - model knowledge (context window + pretty label)
// ----------------------------------------------------------------------------
// Pure module: string -> number / string. No I/O, no network, no tokens.
// Replaces the old CONTEXT_LIMIT=200000 constant, which made the context bar
// LIE on 1M-window sessions (it showed 100% at 200k when only ~20% was used).
//
// AN HONEST NOTE ON 1M DETECTION:
//   The plan assumed the window could be read straight off the model id. In
//   practice 1M is often a SESSION property (a beta header) rather than part of
//   the id in the transcript - so the id alone is not enough. Hence three
//   signals, in order:
//     1. an explicit "1m" marker in the model id (trust it when present),
//     2. a table of known models and their documented windows,
//     3. OBSERVATION: if the token count exceeds the assumed window, the
//        assumption was wrong. Context cannot exceed its own window, so we
//        promote to the next known tier.
//   Signal (3) is what heals the bar by itself; without it the bar sticks at
//   100% and armed auto-compact could fire for no reason.
// ============================================================================

'use strict';

/** Default context window when we know nothing better. */
const DEFAULT_CONTEXT_LIMIT = 200000;

/** Known context-window tiers, ascending. */
const KNOWN_TIERS = [200000, 1000000];

/**
 * Real context windows of known models (id prefix -> limit).
 *
 * FIX 2026-07-24: the first version of this file assumed 200k for everything and
 * only corrected itself from observation. That was wrong: the current Claude
 * family has a 1M window (exception: Haiku 4.5 = 200k), so the bar would have
 * shown 100% at roughly 20% and armed auto-compact would have fired far too
 * early. Observation stays as a second line of defence, but it cannot be the
 * first - by the time it fires the bar has already lied.
 */
const MODEL_WINDOWS = [
  { prefix: 'claude-haiku-4-5', limit: 200000 },
  { prefix: 'claude-opus-4-8', limit: 1000000 },
  { prefix: 'claude-opus-4-7', limit: 1000000 },
  { prefix: 'claude-opus-4-6', limit: 1000000 },
  { prefix: 'claude-sonnet-5', limit: 1000000 },
  { prefix: 'claude-sonnet-4-6', limit: 1000000 },
  { prefix: 'claude-fable-5', limit: 1000000 },
  { prefix: 'claude-mythos-5', limit: 1000000 },
];

/** Model families recognized when building a label. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/** True when the model id carries a 1M-window marker ("sonnet-4-5-1m", "...[1m]"). */
function hasOneMillionMarker(id) {
  return /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(id);
}

/** Looks up a window by longest matching id prefix. Returns null when unknown. */
function windowFromTable(id) {
  let best = null;
  for (const row of MODEL_WINDOWS) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) {
      best = row;
    }
  }
  return best ? best.limit : null;
}

/**
 * Returns the context window for a model.
 * @param {string} model model id from the transcript (may be empty or unknown)
 * @param {number} [observedTokens] actually observed usage - the corrective
 *   signal for when the model id does not tell the truth about the window
 * @returns {number}
 */
function contextLimitFor(model, observedTokens = 0) {
  const id = String(model || '').toLowerCase();
  // Signal order: explicit 1m marker > table of known models > default 200k.
  let limit = hasOneMillionMarker(id) ? 1000000 : windowFromTable(id) || DEFAULT_CONTEXT_LIMIT;

  // Correction from observation: context cannot be larger than its own window.
  if (observedTokens > limit) {
    limit =
      KNOWN_TIERS.find((tier) => tier >= observedTokens) ||
      KNOWN_TIERS[KNOWN_TIERS.length - 1];
  }
  return limit;
}

/**
 * Turns a model id into a short badge label ("claude-opus-4-8" -> "Opus 4.8").
 * An unrecognized id (e.g. a local LM Studio model) is returned UNCHANGED -
 * better to show the raw name than to guess and be wrong.
 * @param {string} model
 * @returns {string}
 */
function modelLabel(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';

  const s = raw
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // release date suffix: -20250929
    .replace(/-latest$/, '');

  const oneM = hasOneMillionMarker(s);
  const family = FAMILIES.find((f) => s.includes(f));
  if (!family) return raw; // unknown family - hand back the original

  // The version is the last group of digits (works for both "opus-4-8" and
  // the older "3-5-sonnet" ordering).
  const withoutMarker = s.replace(/(^|[^a-z0-9])1m([^a-z0-9]|$)/, '$1');
  const groups = withoutMarker.match(/\d+(?:-\d+)*/g) || [];
  const version = groups.length > 0 ? groups[groups.length - 1].replace(/-/g, '.') : '';

  const name = family[0].toUpperCase() + family.slice(1);
  const label = version ? `${name} ${version}` : name;
  return oneM ? `${label} 1M` : label;
}

module.exports = {
  contextLimitFor,
  modelLabel,
  DEFAULT_CONTEXT_LIMIT,
  KNOWN_TIERS,
  MODEL_WINDOWS,
};
