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

const {
  normalizeTodo,
  normalizeCardFields,
  normalizeTodos,
  normalizeStore,
  runTag,
  SIZES,
  MODELS,
  MAX_DETAILS_CHARS,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  MAX_TAGS,
  STEER_TAG,
} = require('./todorows');


// Bucket used when the caller has no projectId in hand (no session yet, or a
// project entry with no id reached this far) - "somewhere to put it" rather
// than losing the write.
const DEFAULT_KEY = '_default';

/** Turns a projectId into the key its list is stored under. */
function keyFor(projectId) {
  return typeof projectId === 'string' && projectId ? projectId : DEFAULT_KEY;
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
  runTag,
  MAX_TAGS,
  STEER_TAG,
  readStore,
  readTodos,
  writeTodos,
  keyFor,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  DEFAULT_KEY,
};
