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
import { mountGodModeControl } from './godmode.js';

const SAVE_MS = 400;
const MAX_TEXT_CHARS = 200;

let els = null;
let items = [];
let saveTimer = null;
// Which session's project `items` currently reflects - see header.
let boundSessionId = null;
// UI-only, never persisted: which items are click-expanded past their
// truncated width right now. Keyed by `at` (creation timestamp) rather than
// index so removing/toggling some OTHER item doesn't relabel a still-open
// item as a different item's expanded state.
const expanded = new Set();

// The in-flight pointer drag, or null when no row is being dragged. Module
// scope like `expanded` above, so it survives a repaint mid-gesture.
//
// This is a hand-rolled pointer drag rather than HTML5 drag-and-drop, because
// that API owns the drag image and offers no hook to animate the OTHER rows
// while a drag is in flight - the list can only snap into the new order on
// drop. Here the dragged row follows the pointer with the transition OFF (it
// has to feel glued to the cursor) while every sibling it crosses slides one
// slot out of the way with the transition ON. Nothing is reordered in `items`
// until release; reorderTodo() is still the single commit step.
let drag = null;

// Releasing after a real drag still fires a click on whatever the gesture
// started on. Without this the row's text would toggle its expanded state
// every time you finished dragging that row.
let dragEndedAt = 0;

// How far the pointer has to travel before a press becomes a drag. Below it a
// press is still a plain click, so click-to-expand and the checkbox keep
// working with an unsteady hand.
const DRAG_THRESHOLD_PX = 4;
const CLICK_SUPPRESS_MS = 60;

// A released row is still gliding into its slot for one --dur-fast, and the
// real reorder only lands when it arrives. Holding the pending finish here
// means anything that cannot wait it out - a second drag, an unmount - can
// end it early instead of racing it.
let settle = null;

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

/**
 * Moves one item from `fromIndex` to `toIndex`, shifting the rest to make
 * room - a drag-and-drop reorder. Out-of-range or a no-op move (same index)
 * returns the SAME list, matching every other op here (the caller can detect
 * "nothing changed" with a reference check, no deep-equal needed).
 */
export function reorderTodo(list, fromIndex, toIndex) {
  const current = Array.isArray(list) ? list : [];
  if (
    fromIndex < 0 || fromIndex >= current.length ||
    toIndex < 0 || toIndex >= current.length ||
    fromIndex === toIndex
  ) {
    return current;
  }
  const next = [...current];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * The geometry of a drag in flight, with no DOM in it: given how far the
 * dragged row's midpoint has travelled, how far each OTHER row has to slide to
 * open a slot for it, and which index it would land on if released right now.
 *
 * `siblings` is [{ index, mid }] - every row except the dragged one, carrying
 * its ORIGINAL list index and its untransformed vertical midpoint. `shifts`
 * comes back parallel to it, in px.
 *
 * A row that started ABOVE the dragged one but now sits below where the
 * dragged one has got to slides DOWN by one step to open the slot; a row that
 * started below and is now above slides UP. `step` is the DRAGGED row's own
 * height plus the list gap - not each sibling's - which is what keeps rows of
 * different heights (an expanded one wraps to two lines) landing square.
 *
 * `targetIndex` is just how many siblings the dragged row has passed, which is
 * exactly the index reorderTodo() wants: a position in the list with the
 * dragged item already taken out.
 */
export function resolveDrag(siblings, originalIndex, draggedMid, step) {
  const shifts = [];
  let targetIndex = 0;
  siblings.forEach((sibling) => {
    let shift = 0;
    if (sibling.index < originalIndex && sibling.mid > draggedMid) shift = step;
    else if (sibling.index > originalIndex && sibling.mid < draggedMid) shift = -step;
    shifts.push(shift);
    if (sibling.mid < draggedMid) targetIndex += 1;
  });
  return { shifts, targetIndex };
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

/** One row's worth of vertical travel: its own height plus the flex gap the
 *  list puts between rows. Read from the DOM rather than hardcoded so a theme
 *  retuning `.todo-list { gap }` does not silently desync the shift. */
function rowStep(rect) {
  const gap = parseFloat(getComputedStyle(els.list).rowGap);
  return rect.height + (Number.isFinite(gap) ? gap : 0);
}

/** How long the settle animation will actually take, straight from the row's
 *  computed style - which is 0 under prefers-reduced-motion, since the token
 *  layer already zeroes every duration. No second reduced-motion branch. */
function settleMs(li) {
  return (parseFloat(getComputedStyle(li).transitionDuration) || 0) * 1000;
}

/** Finishes a release already in flight, now rather than on its timer. */
function flushSettle() {
  if (!settle) return;
  const pending = settle;
  settle = null;
  clearTimeout(pending.timer);
  pending.finish();
}

/** Drops every inline transform the gesture painted and un-marks the row. */
function clearDragStyles(gesture) {
  gesture.li.classList.remove('todo-item--dragging');
  gesture.li.style.transform = '';
  gesture.siblings.forEach((s) => {
    s.el.style.transform = '';
  });
}

function startDrag(event, li, index) {
  // A second pointer (or a second finger) must not hijack a live gesture.
  if (drag || event.button !== 0) return;
  // The checkbox and the inject/remove buttons own their own presses.
  if (event.target.closest('input, button')) return;
  // Grabbing again mid-settle would measure rows that are still moving, and
  // getBoundingClientRect() reports the TRANSFORMED box - every midpoint
  // below would be read off a position no row is going to keep. Land the
  // previous release first, then measure a list that is standing still.
  flushSettle();

  // Snapshot every OTHER row's midpoint once. Their real rects never move
  // during the gesture - only their `transform` does - so this stays valid
  // for the whole drag and turns each frame into pure arithmetic.
  const siblings = [];
  Array.from(els.list.children).forEach((el, i) => {
    if (i === index) return;
    const rect = el.getBoundingClientRect();
    siblings.push({ index: i, el, mid: rect.top + rect.height / 2 });
  });

  const rect = li.getBoundingClientRect();
  drag = {
    pointerId: event.pointerId,
    li,
    list: items,
    originalIndex: index,
    targetIndex: index,
    startClientY: event.clientY,
    startMid: rect.top + rect.height / 2,
    step: rowStep(rect),
    lastY: event.clientY,
    frame: 0,
    moved: false,
    siblings,
  };
  // The rest of the gesture is watched on the window, not on the row: the
  // cursor outruns the row constantly, and the row itself can be torn out by
  // a re-render mid-drag. setPointerCapture() would also have worked - except
  // capture retargets the compatibility mouse events too, so `click` would
  // land on the <li> instead of the <span> and click-to-expand would quietly
  // stop firing on every row you had ever pressed.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

/** Repaints the gesture: the dragged row onto the pointer, each sibling into
 *  or out of the slot it has to give up. Runs at most once per frame. */
function paintDrag() {
  if (!drag) return;
  const dy = drag.lastY - drag.startClientY;
  if (!drag.moved) {
    if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    drag.li.classList.add('todo-item--dragging');
  }
  drag.li.style.transform = `translateY(${dy}px)`;

  const { shifts, targetIndex } = resolveDrag(
    drag.siblings,
    drag.originalIndex,
    drag.startMid + dy,
    drag.step,
  );
  drag.siblings.forEach((sibling, i) => {
    sibling.el.style.transform = shifts[i] ? `translateY(${shifts[i]}px)` : '';
  });
  drag.targetIndex = targetIndex;
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastY = event.clientY;
  // pointermove fires far more often than the compositor paints; every extra
  // pass recomputes transforms nobody ever sees.
  if (drag.frame) return;
  drag.frame = requestAnimationFrame(() => {
    if (drag) drag.frame = 0;
    paintDrag();
  });
}

function onPointerUp(event) {
  if (drag && event.pointerId !== drag.pointerId) return;
  endDrag(true);
}

function onPointerCancel(event) {
  if (drag && event.pointerId !== drag.pointerId) return;
  endDrag(false);
}

/** Ends the gesture. `keepMove` false lands the row back where it started,
 *  which is what a cancelled pointer means. */
function endDrag(keepMove) {
  if (!drag) return;
  const gesture = drag;
  drag = null;
  if (gesture.frame) cancelAnimationFrame(gesture.frame);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  if (!gesture.moved) {
    clearDragStyles(gesture);
    return;
  }
  dragEndedAt = Date.now();

  const to = keepMove ? gesture.targetIndex : gesture.originalIndex;
  // Ride the row into the slot its neighbours already opened, THEN swap the
  // real order in. Committing straight away would teleport it from under the
  // cursor to its resting place - the one "pop" this whole rewrite is about.
  // Dropping --dragging restores the transition, so setting the resting
  // offset in the same style pass animates instead of jumping.
  gesture.li.classList.remove('todo-item--dragging');
  gesture.li.style.transform =
    `translateY(${(to - gesture.originalIndex) * gesture.step}px)`;

  const finish = () => {
    clearDragStyles(gesture);
    // A project switch mid-settle swaps `items` wholesale; reordering by an
    // index taken from the old list would scramble the new one.
    if (to !== gesture.originalIndex && items === gesture.list) {
      commit(reorderTodo(items, gesture.originalIndex, to));
    }
  };
  settle = {
    finish,
    timer: setTimeout(() => {
      settle = null;
      finish();
    }, settleMs(gesture.li)),
  };
}

function renderRows() {
  if (!els) return;
  els.list.innerHTML = '';
  items.forEach((item, index) => {
    const li = document.createElement('li');
    const classes = ['todo-item'];
    if (item.done) classes.push('todo-item--done');
    // Lit up while its text is expanded, so the row you just clicked into
    // stays visually "the one you're on" instead of blending back into the
    // list the instant you look away from it.
    if (expanded.has(item.at)) classes.push('todo-item--expanded');
    li.className = classes.join(' ');

    // Drag-to-reorder: grab any row and carry it to its new slot. See the
    // `drag` declaration up top for why this is not HTML5 drag-and-drop.
    li.addEventListener('pointerdown', (e) => startDrag(e, li, index));

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.addEventListener('change', () => commit(toggleTodo(items, index)));

    const text = document.createElement('span');
    text.className = expanded.has(item.at)
      ? 'todo-item__text todo-item__text--expanded'
      : 'todo-item__text';
    text.textContent = item.text;
    text.title = item.text;
    text.addEventListener('click', () => {
      // The click that closes a drag is not a click on the text.
      if (Date.now() - dragEndedAt < CLICK_SUPPRESS_MS) return;
      if (expanded.has(item.at)) expanded.delete(item.at);
      else expanded.add(item.at);
      renderRows();
    });

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

    const offGodMode = mountGodModeControl(root);

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
      // A gesture still in flight holds a captured pointer, and a release
      // still gliding holds a timer. Both have to go before the DOM does -
      // but the reorder itself is the user's, so it lands rather than dies.
      endDrag(true);
      flushSettle();
      offLang();
      offGodMode();
      els = null;
    };
  },
});
