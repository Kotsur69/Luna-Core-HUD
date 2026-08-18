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
const MAX_TEXT_CHARS = 200;

// Bucket used when the caller has no projectId in hand (no session yet, or a
// project entry with no id reached this far) - "somewhere to put it" rather
// than losing the write.
const DEFAULT_KEY = '_default';

/** Turns a projectId into the key its list is stored under. */
function keyFor(projectId) {
  return typeof projectId === 'string' && projectId ? projectId : DEFAULT_KEY;
}

/**
 * Validates one item.
 * @param {unknown} raw
 * @returns {{text:string, done:boolean, at:number}|null}
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
  normalizeTodos,
  normalizeStore,
  readTodos,
  writeTodos,
  keyFor,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  DEFAULT_KEY,
};
