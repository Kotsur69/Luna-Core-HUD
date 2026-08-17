// ============================================================================
// LunaCore - pin-board todo list (LUNACORE_HUD_WIDGET_PLAN.md §4)
// ----------------------------------------------------------------------------
// Project-independent task tracking, persisted to config/todo.local.json
// (gitignored by the config/*.local.* pattern).
//
// Deliberately GLOBAL, not per-project - the same call scratchpad.js made and
// for the same reason: these are "things I must not forget", which rarely map
// onto whichever repo the terminal happens to point at right now. If it ever
// needs to be per-cwd it can key off activeProjectId later, exactly as the
// scratchpad's header notes.
//
// This module owns only VALIDATION and PERSISTENCE (read/write the whole list,
// the scratchpad's IPC shape). The list operations themselves - add, toggle,
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

/** Reads the stored list; an empty list when the file is missing or corrupt. */
function readTodos() {
  try {
    return normalizeTodos(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return [];
  }
}

/**
 * Writes the list (validated at the boundary, like writeScratchpad).
 * @returns {boolean} whether the write succeeded
 */
function writeTodos(list) {
  if (!Array.isArray(list)) return false;
  try {
    paths.ensureUserDir();
    fs.writeFileSync(file(), JSON.stringify(normalizeTodos(list), null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { normalizeTodo, normalizeTodos, readTodos, writeTodos, MAX_ITEMS, MAX_TEXT_CHARS };
