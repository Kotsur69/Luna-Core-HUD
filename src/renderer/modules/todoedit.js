// ============================================================================
// LunaCore - to-do ✎ edit form
// ----------------------------------------------------------------------------
// The inline form that replaces a to-do row's text while it is being edited:
// the title, plus a card's details / done-when / verify. Ctrl+Enter saves,
// Esc cancels. Split out of todo.js, which stays the owner of the list -
// this module only reads it and hands edits back through the hooks given to
// initTodoEdit(), so there is no import cycle between the two.
//
// The draft lives here at module scope rather than only in the DOM because an
// outside change (Claude writing a card, a language switch) repaints every
// row: the form is rebuilt from `editing`, so a half-typed edit survives the
// repaint, and `editing.focus` puts the caret back where it was.
// ============================================================================

'use strict';

import { t } from './util.js';
import { isCard, editTodo } from './todocards.js';

let editing = null;
let hooks = { getItems: () => [], commit: () => {}, repaint: () => {} };

/**
 * Wires the form to the widget's list.
 * @param {{getItems:() => Array, commit:(next:Array) => void, repaint:() => void}} next
 */
export function initTodoEdit(next) {
  hooks = next;
}

/** Whether the row for this `at` is showing the form. */
export function isEditing(at) {
  return editing !== null && editing.at === at;
}

/** Drops the open form without a repaint (project switch, unmount, removal). */
export function forgetEdit() {
  editing = null;
}

/** Closes the form if its row is no longer in `items`. */
export function pruneEdit(items) {
  if (editing && !items.some((item) => item.at === editing.at)) editing = null;
}

/** The form's string values for an item. */
function formValues(item) {
  return {
    text: item.text,
    details: item.details || '',
    acceptance: (item.acceptance || []).join('\n'),
    verify: item.verify || '',
  };
}

/** ✎: opens the form on this item, or closes it if it is already open. */
export function toggleEdit(item) {
  if (isEditing(item.at)) {
    editing = null;
  } else {
    const values = formValues(item);
    // `base` is what the form opened with: save sends only what the user
    // changed against it, so a card Claude rewrote meanwhile keeps every
    // field the user did not touch instead of losing it to a stale draft.
    editing = { at: item.at, card: isCard(item), focus: 'text', base: values, draft: values };
  }
  hooks.repaint();
}

function closeEdit() {
  editing = null;
  hooks.repaint();
}

/** Saves the open form. An emptied title keeps the form open instead. */
function saveEdit() {
  if (!editing) return;
  const { draft, base, card } = editing;
  const items = hooks.getItems();
  const current = items.find((item) => item.at === editing.at);
  if (!current) return;
  const keys = card ? Object.keys(draft) : ['text'];
  const changed = Object.fromEntries(
    keys.filter((key) => draft[key] !== base[key]).map((key) => [key, draft[key]]),
  );
  const next = editTodo(items, editing.at, { text: current.text, ...changed });
  if (next === items) return;
  editing = null;
  hooks.commit(next);
}

/** One labelled block of an expanded card (or of the form). */
export function cardSection(label, value) {
  const el = document.createElement('div');
  el.className = 'todo-card__section';
  const head = document.createElement('span');
  head.className = 'todo-card__label';
  head.textContent = label;
  el.append(head, document.createTextNode(` ${value}`));
  return el;
}

function formButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'port-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/** One labelled field of the form, bound to editing.draft[key]. */
function editField(key, labelKey, multiline) {
  const wrap = document.createElement('label');
  wrap.className = 'todo-edit__field';
  if (labelKey) {
    const head = document.createElement('span');
    head.className = 'todo-card__label';
    head.textContent = t(labelKey);
    wrap.append(head);
  }
  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.className = 'todo-edit__input';
  input.dataset.field = key;
  if (multiline) input.rows = key === 'text' ? 2 : 3;
  input.value = editing.draft[key];
  // Guarded: a project switch drops `editing` while the old form is still
  // on screen until the new list loads.
  input.addEventListener('input', () => {
    if (!editing) return;
    editing = { ...editing, draft: { ...editing.draft, [key]: input.value } };
  });
  input.addEventListener('focus', () => {
    if (!editing) return;
    editing = { ...editing, focus: key };
  });
  wrap.append(input);
  return wrap;
}

/** The form for `item`; only call while isEditing(item.at). */
export function editForm(item) {
  const form = document.createElement('div');
  form.className = 'todo-edit';
  form.append(editField('text', null, true));
  if (editing.card) {
    form.append(
      editField('details', 'todo.details', true),
      editField('acceptance', 'todo.acceptanceLines', true),
      editField('verify', 'todo.verify', false),
    );
  }
  if (item.original) form.append(cardSection(t('todo.original'), item.original));

  const bar = document.createElement('div');
  bar.className = 'todo-edit__bar';
  const save = formButton(t('todo.save'), t('todo.saveHint'), saveEdit);
  save.classList.add('todo-edit__save');
  bar.append(formButton(t('todo.cancel'), t('todo.cancelHint'), closeEdit), save);
  form.append(bar);

  form.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEdit();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveEdit();
    }
  });
  return form;
}

/** Puts the caret back in the field it was in before the last repaint. */
export function focusEditField(listEl) {
  if (!editing || !listEl) return;
  // Never pull focus out of something else the user is typing in (the add
  // box, the terminal) just because an outside change repainted the list.
  const active = document.activeElement;
  if (active && active !== document.body && !listEl.contains(active)) return;
  const input = listEl.querySelector(`.todo-edit__input[data-field="${editing.focus}"]`);
  if (!input || active === input) return;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}
