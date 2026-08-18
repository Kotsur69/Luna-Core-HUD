// ============================================================================
// LunaCore - pin-board todo widget
// ----------------------------------------------------------------------------
// Per-project checklist: main.js keys the stored list off whichever tab's
// session is active (session.projectId), so the four things typed while
// pointed at one repo are still there next time that project is active, and
// switching to a different tab shows THAT project's list instead.
//
// `boundSessionId` names which session `items` currently reflects. It is set
// on load (mount, or syncTodoProject() below) and read back by scheduleSave/
// cleanup, so a save started before a tab switch still lands on the project
// it was typed under, not whichever tab happens to be active 400ms later.
//
// The list operations are PURE and exported, so the interesting behaviour -
// ordering, the cap, what "clear done" actually removes - is unit-testable
// without a DOM, the same split media.js uses for truncateLabel.
//
// State lives at module scope, not in the DOM, per the ports.js rule: a
// remount must not lose unsaved edits. The save itself is debounced like the
// scratchpad's; cleanup() and syncTodoProject() both flush a pending one
// rather than dropping it or letting it land on the wrong project.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { term, getActiveSessionId } from './terminals.js';
import { defineWidget } from './registry.js';

const SAVE_MS = 400;
const MAX_TEXT_CHARS = 200;

let els = null;
let items = [];
let saveTimer = null;
// Which session's project `items` currently reflects - see header.
let boundSessionId = null;

/**
 * Appends an item. Returns a NEW array (immutability rule) and rejects
 * empty/whitespace text by returning the list unchanged, so the caller does
 * not need its own guard.
 */
export function addTodo(list, text, now = Date.now()) {
  const current = Array.isArray(list) ? list : [];
  const trimmed = typeof text === 'string' ? text.trim().slice(0, MAX_TEXT_CHARS) : '';
  if (!trimmed) return current;
  return [...current, { text: trimmed, done: false, at: now }];
}

/** Flips one item's done flag by index. Out-of-range is a no-op. */
export function toggleTodo(list, index) {
  const current = Array.isArray(list) ? list : [];
  if (index < 0 || index >= current.length) return current;
  return current.map((item, i) => (i === index ? { ...item, done: !item.done } : item));
}

/** Drops one item by index. Out-of-range is a no-op. */
export function removeTodo(list, index) {
  const current = Array.isArray(list) ? list : [];
  if (index < 0 || index >= current.length) return current;
  return current.filter((_item, i) => i !== index);
}

/** Drops every completed item. */
export function clearDone(list) {
  const current = Array.isArray(list) ? list : [];
  return current.filter((item) => !item.done);
}

/** How many items are still open. */
export function openCount(list) {
  const current = Array.isArray(list) ? list : [];
  return current.filter((item) => !item.done).length;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.lunacore.saveTodos(items, boundSessionId).catch(() => {});
    saveTimer = null;
  }, SAVE_MS);
}

/** Writes a pending edit NOW, under the project it was typed for. Called
 *  before switching projects (or unmounting) so a debounce in flight is
 *  never silently dropped, nor left to land on the WRONG project's list. */
function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  window.lunacore.saveTodos(items, boundSessionId).catch(() => {});
}

function commit(next) {
  items = next;
  render();
  scheduleSave();
}

/**
 * Reloads the checklist for whichever tab is active now - the active
 * project may have changed (tab switch, or the project switcher on the
 * current tab). Called by sessions.js; a no-op while the widget is unmounted.
 */
export function syncTodoProject() {
  if (!els) return;
  flushPendingSave();
  boundSessionId = getActiveSessionId();
  window.lunacore
    .getTodos(boundSessionId)
    .then((list) => {
      if (!els) return;
      items = Array.isArray(list) ? list : [];
      render();
    })
    .catch(() => {});
}

function renderRows() {
  if (!els) return;
  els.list.innerHTML = '';
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = item.done ? 'todo-item todo-item--done' : 'todo-item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.addEventListener('change', () => commit(toggleTodo(items, index)));

    const text = document.createElement('span');
    text.className = 'todo-item__text';
    text.textContent = item.text;
    text.title = item.text;

    const actions = document.createElement('span');
    actions.className = 'todo-item__actions';

    const inject = document.createElement('button');
    inject.className = 'port-btn';
    inject.textContent = '⚡';
    inject.title = t('todo.inject');
    inject.addEventListener('click', () => {
      window.lunacore.pastePrompt(item.text, false);
      pulse(inject);
      term.focus();
    });

    const drop = document.createElement('button');
    drop.className = 'port-btn';
    drop.textContent = '✕';
    drop.title = t('todo.remove');
    drop.addEventListener('click', () => commit(removeTodo(items, index)));

    actions.append(inject, drop);
    li.append(box, text, actions);
    els.list.append(li);
  });
}

function render() {
  if (!els) return;
  const open = openCount(items);
  // Open count, not total: a board of twelve where eleven are ticked is a
  // board with one thing left on it.
  els.count.textContent = items.length ? `${open}/${items.length}` : '';
  els.empty.style.display = items.length ? 'none' : '';
  els.empty.textContent = t('todo.empty');
  els.clear.disabled = items.length === open;
  renderRows();
}

defineWidget({
  id: 'todo',
  titleKey: 'todo.title',
  template: 'w-todo',
  mount(root) {
    els = {
      form: root.querySelector('#todo-form'),
      input: root.querySelector('#todo-input'),
      list: root.querySelector('#todo-list'),
      count: root.querySelector('#todo-count'),
      empty: root.querySelector('#todo-empty'),
      clear: root.querySelector('#todo-clear'),
    };

    const offLang = onLangChange(render);

    els.form.addEventListener('submit', (event) => {
      // Without this the form would navigate the renderer away from index.html
      // and take the whole HUD (and every open PTY view) with it.
      event.preventDefault();
      const next = addTodo(items, els.input.value);
      if (next !== items) {
        els.input.value = '';
        commit(next);
      }
    });

    els.clear.addEventListener('click', () => commit(clearDone(items)));

    boundSessionId = getActiveSessionId();
    window.lunacore
      .getTodos(boundSessionId)
      .then((list) => {
        if (!els) return;
        // Only adopt the stored list if nothing was typed while it loaded -
        // otherwise a slow disk read would silently wipe a just-added item.
        if (items.length === 0) items = Array.isArray(list) ? list : [];
        render();
      })
      .catch(() => {});

    render();

    return () => {
      flushPendingSave();
      offLang();
      els = null;
    };
  },
});
