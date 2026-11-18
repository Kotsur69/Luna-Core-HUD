// ============================================================================
// LunaCore - report models in the renderer (pure, no DOM)
// ----------------------------------------------------------------------------
// The weekly review and the brief store their model as {provider, model}
// (src/reportmodel.js in main). This is what their views show of it:
//
//   reportModelText(model)   'Haiku' / 'Antigravity (agy) - <id>'
//   reportCost(entry, fmt)   the cost text: '$0' on agy (it reports none)
//   reportFailure(entry)     {provider, reason} of a call that failed, or null
//   choiceOptions(models)    picker [value, label] pairs from main's choices
//
// Main sends every value; this module only formats it, so a malformed one
// shows as text and is never trusted for anything else.
// ============================================================================

'use strict';

const CLAUDE_NAME = 'Claude';
const AGY_NAME = 'Antigravity (agy)';
const MAX_LABEL_CHARS = 120;

/** The provider of a stored model (an old plain string reads like main reads it). */
function providerOf(model) {
  if (model && typeof model === 'object') return model.provider === 'agy' ? 'agy' : 'claude';
  return typeof model === 'string' && (model === 'agy' || model.startsWith('agy:')) ? 'agy' : 'claude';
}

/** The name of the model behind a stored {provider, model} (or an old plain string). */
export function reportModelText(model) {
  const provider = providerOf(model);
  const raw = model && typeof model === 'object' ? model.model : typeof model === 'string' ? model.replace(/^agy:?/, '') : '';
  const id = typeof raw === 'string' ? raw.slice(0, MAX_LABEL_CHARS) : '';
  if (provider === 'agy') return id ? `${AGY_NAME} - ${id}` : AGY_NAME;
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : CLAUDE_NAME;
}

/** True for an entry made on agy. */
export function isAgyReport(entry) {
  return Boolean(entry) && providerOf(entry.model) === 'agy';
}

/**
 * The cost text of an entry: agy reports no cost, so '$0'; otherwise `fmt`
 * of the cost ('' when unknown).
 * @param {{model?:unknown, costUsd?:unknown}|null} entry
 * @param {(usd:unknown) => string} fmt
 */
export function reportCost(entry, fmt) {
  if (!entry) return '';
  return isAgyReport(entry) ? '$0' : fmt(entry.costUsd);
}

/**
 * The provider and reason of an entry whose model call failed, or null when
 * it worked or only its answer was unusable ('bad-json': the raw-data line
 * already says so).
 * @param {{model?:unknown, failure?:unknown}|null} entry
 * @returns {{provider:string, reason:string}|null}
 */
export function reportFailure(entry) {
  if (!entry || typeof entry.failure !== 'string' || !entry.failure || entry.failure === 'bad-json') return null;
  return { provider: isAgyReport(entry) ? AGY_NAME : CLAUDE_NAME, reason: entry.failure };
}

/**
 * [value, label] pairs for a picker from main's choices ([{id, name}]).
 * Entries that are not {id: string} are skipped.
 * @param {unknown} models
 * @returns {[string, string][]}
 */
export function choiceOptions(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
    .map((m) => [m.id, typeof m.name === 'string' && m.name ? m.name : m.id]);
}
