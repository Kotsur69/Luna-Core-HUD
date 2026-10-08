// ============================================================================
// LunaCore - pin-board todo list (LUNACORE_HUD_WIDGET_PLAN.md §4)
// ----------------------------------------------------------------------------
// Per-project task tracking, persisted to config/todo.local.json (gitignored
// by the config/*.local.* pattern). One file, keyed by projectId, so a list
// jotted down while pointed at one repo shows up again next time that same
// project is active - and stays out of the way of every other project's list.
//
// main.js resolves WHICH project a call belongs to (via resolveSession() ->
// session.projectId, same session lookup every other per-tab IPC handler
// already uses) - this module only ever sees a plain projectId string.
//
// This module owns only VALIDATION and PERSISTENCE (read/write one project's
// list within the shared store). The list operations themselves - add, toggle,
// remove, clear-done - live in the renderer widget and are pure and exported
// there, which is the same split media.js/media.js (main/renderer) already
// uses and what lets both halves be unit-tested without Electron.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

const file = () => paths.local('todo.local.json');

// A pin-board, not an issue tracker. Beyond this the widget stops being a
// glanceable list, and the honest answer is that the work belongs somewhere
// with a real tracker.
const MAX_ITEMS = 100;
const MAX_TEXT_CHARS = 1000;

// Bucket used when the caller has no projectId in hand (no session yet, or a
// project entry with no id reached this far) - "somewhere to put it" rather
// than losing the write.
const DEFAULT_KEY = '_default';

/** Turns a projectId into the key its list is stored under. */
function keyFor(projectId) {
  return typeof projectId === 'string' && projectId ? projectId : DEFAULT_KEY;
}

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
  return {
    text,
    done: raw.done === true,
    at: Number.isFinite(at) ? at : 0,
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

/** Reads the whole store; an empty store when the file is missing or corrupt. */
function readStore() {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return {};
  }
}

/** Writes the whole store (validated at the boundary, like writeScratchpad). */
function writeStore(store) {
  try {
    paths.ensureUserDir();
    fs.writeFileSync(file(), JSON.stringify(normalizeStore(store), null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads one project's list; an empty list when nothing is stored for it yet.
 * @param {string|null|undefined} projectId
 */
function readTodos(projectId) {
  return readStore()[keyFor(projectId)] || [];
}

/**
 * Writes one project's list, leaving every other project's list in the store
 * untouched (read-modify-write - fine at pin-board scale, single process).
 * @param {string|null|undefined} projectId
 * @param {unknown} list
 * @returns {boolean} whether the write succeeded
 */
function writeTodos(projectId, list) {
  if (!Array.isArray(list)) return false;
  const store = readStore();
  store[keyFor(projectId)] = normalizeTodos(list);
  return writeStore(store);
}

module.exports = {
  normalizeTodo,
  normalizeCardFields,
  SIZES,
  MODELS,
  MAX_DETAILS_CHARS,
  normalizeTodos,
  normalizeStore,
  readTodos,
  writeTodos,
  keyFor,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  DEFAULT_KEY,
};
