// ============================================================================
// LunaCore - to-do item validation (pure, shared by main and the phone app)
// ----------------------------------------------------------------------------
// The shape rules of one to-do item and one list, with no fs / paths, so the
// phone app (mobile/, docs/CLOUD_SYNC_PLAN.md phase 4) bundles the exact code
// a PC uses: todosync.js drops a pulled item unless normalizeTodo() accepts
// it, so the phone must write items this code already produced.
// src/todo.js re-exports everything here; persistence stays there.
// ============================================================================

'use strict';

// A pin-board, not an issue tracker. Beyond this the widget stops being a
// glanceable list, and the honest answer is that the work belongs somewhere
// with a real tracker.
const MAX_ITEMS = 100;
const MAX_TEXT_CHARS = 1000;

// Task-card fields (ORCHESTRATOR_PLAN.md "Task cards instead of one-line
// to-dos"). All optional: an item without them is a plain pin-board line and
// round-trips byte-identical to how it did before cards existed. Written
// mostly by Claude through the intake MCP server (src/intake.js), so the caps
// are what stops one runaway tool call from bloating the store.
const MAX_DETAILS_CHARS = 4000;
const MAX_LIST_ENTRIES = 20;
const MAX_ENTRY_CHARS = 300;
const MAX_FILES = 50;
const MAX_DEPENDS = 50;
const SIZES = ['S', 'M', 'L'];
const MODELS = ['sonnet', 'opus'];

/** Trimmed, capped string, or null when there is nothing usable. */
function cleanString(raw, max) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, max);
  return s || null;
}

/** Array of trimmed, capped, non-empty strings, or null when none survive. */
function cleanStringList(raw, maxEntries, maxChars) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const s = cleanString(entry, maxChars);
    if (s) out.push(s);
    if (out.length >= maxEntries) break;
  }
  return out.length ? out : null;
}

/** Array of unique finite numbers (other cards' `at`), or null when none. */
function cleanDepends(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const n = Number(entry);
    if (typeof entry === 'number' && Number.isFinite(n) && !out.includes(n)) out.push(n);
    if (out.length >= MAX_DEPENDS) break;
  }
  return out.length ? out : null;
}

/**
 * The optional card fields of one raw item - only the ones that are present
 * and valid, so a plain item gains no keys.
 * @param {object} raw
 * @returns {object}
 */
function normalizeCardFields(raw) {
  const fields = {
    details: cleanString(raw.details, MAX_DETAILS_CHARS),
    acceptance: cleanStringList(raw.acceptance, MAX_LIST_ENTRIES, MAX_ENTRY_CHARS),
    files: cleanStringList(raw.files, MAX_FILES, MAX_ENTRY_CHARS),
    verify: cleanString(raw.verify, MAX_ENTRY_CHARS),
    size: SIZES.includes(raw.size) ? raw.size : null,
    model: MODELS.includes(raw.model) ? raw.model : null,
    dependsOn: cleanDepends(raw.dependsOn),
    // The loose note a card was rewritten from (the to-do widget's "rewrite
    // with Claude"), kept so the user can check the card did not drift from
    // what they meant. Same cap as a title: it WAS a title.
    original: cleanString(raw.original, MAX_TEXT_CHARS),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
}

/**
 * Validates one item.
 * @param {unknown} raw
 * @returns {{text:string, done:boolean, at:number}|null} plus any valid card fields
 */
function normalizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return null;
  const at = Number(raw.at);
  const done = raw.done === true;
  // When it was ticked (the Life score counts to-dos closed today). Only on a
  // done item, so reopening drops it and a plain item gains no key.
  const doneAt = done && typeof raw.doneAt === 'number' && Number.isFinite(raw.doneAt) && raw.doneAt > 0 ? { doneAt: raw.doneAt } : {};
  return {
    text,
    done,
    at: Number.isFinite(at) ? at : 0,
    ...doneAt,
    ...normalizeCardFields(raw),
  };
}

/**
 * Sanitizes a whole list: drops malformed rows, applies the cap.
 * Unlike the clipboard history this does NOT dedupe - two identical reminders
 * are a legitimate thing to write down twice.
 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const todo = normalizeTodo(item);
    if (todo) out.push(todo);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Validates the whole on-disk store: { [projectId]: TodoItem[] }. Unlike a
 * single list, a malformed store is not "start over" - one bad entry must
 * not cost every OTHER project its list, so bad keys/values are dropped
 * individually rather than failing the whole object.
 */
function normalizeStore(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    out[key] = normalizeTodos(value);
  }
  return out;
}

module.exports = {
  normalizeTodo,
  normalizeCardFields,
  normalizeTodos,
  normalizeStore,
  SIZES,
  MODELS,
  MAX_DETAILS_CHARS,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
};
