// ============================================================================
// LunaCore - "Make a to-do" in the memory window (renderer)
// ----------------------------------------------------------------------------
// A memory that describes a fixable bug becomes a To-do card in one step
// (src/memorytodo.js through src/memoryipc.js). The button sits on inbox,
// review and "All memories" entries; it asks main for the prefilled card
// (memoryTodoDraft: the full memory, never the list's preview), and the form
// below replaces the entry's buttons. Saving writes the card, then main
// removes the memory: only after the card is written.
//
// A global memory belongs to no project, so it has no list: its button is
// disabled with the reason as its tooltip (main refuses it too).
//
// Memory text is free text from a model: it only ever goes into form values.
// ============================================================================

'use strict';

import { t } from './util.js';
import { MAX_TEXT_CHARS } from './todocards.js';

/** Mirrors src/todorows.js MAX_DETAILS_CHARS and SIZES (main checks both again). */
export const MAX_DETAILS_CHARS = 20000;
export const SIZES = ['S', 'M', 'L'];
/** main's reason when the card is written but the memory stayed: the form must not offer a second save. */
export const REMOVE_FAILED = 'remove-failed';

const REASON_KEYS = {
  global: 'mem.todo.err.global',
  'no-todo-list': 'mem.todo.err.noList',
  'list-full': 'mem.todo.err.full',
  'todo-failed': 'mem.todo.err.write',
  [REMOVE_FAILED]: 'mem.todo.err.remove',
  'bad-draft': 'mem.todo.err.text',
};

/** The i18n key of a refused "Make a to-do", or null when the reason is not one of its own. */
export function todoReasonKey(reason) {
  return Object.hasOwn(REASON_KEYS, reason) ? REASON_KEYS[reason] : null;
}

/** The card fields the form sends: trimmed text, details, and a size only when one is picked. */
export function todoPayload(text, details, size) {
  return { text: String(text || '').trim(), details: String(details || '').trim(), size: SIZES.includes(size) ? size : '' };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelKey, control) {
  const label = el('label', 'ui-field');
  label.append(el('span', 'ui-field__label', t(labelKey)), control);
  return label;
}

/**
 * The "Make a to-do" button of an entry.
 * @param {{global: boolean, off: boolean, onClick: () => void}} ctx global = the memory is filed under `global`
 */
export function todoButton({ global, off, onClick }) {
  const b = el('button', 'port-btn mem-inbox__btn', t('mem.todo.make'));
  b.type = 'button';
  b.addEventListener('click', onClick);
  b.disabled = off || global;
  if (global) b.title = t('mem.todo.globalHint');
  return b;
}

function sizeSelect() {
  const select = el('select', 'mem-inbox__input');
  for (const value of ['', ...SIZES]) {
    const option = el('option', '', value || t('mem.todo.size.none'));
    option.value = value;
    select.append(option);
  }
  return select;
}

/**
 * The prefilled card form. Same shape and class as the inbox edit form, so
 * the window's Enter / Esc keys work on it.
 * @param {{text: string, details: string}} draft main's draft (memoryTodoDraft)
 * @param {{onSave: (payload: {text: string, details: string, size: string}) => Promise<string|null>,
 *   onCancel: () => void}} ctx onSave resolves null when it worked, else the i18n key of the refusal
 */
export function todoForm(draft, { onSave, onCancel }) {
  const form = el('form', 'mem-inbox__form');
  const text = el('input', 'mem-inbox__input');
  text.type = 'text';
  text.value = draft.text;
  text.maxLength = MAX_TEXT_CHARS;
  const details = el('textarea', 'mem-inbox__input mem-inbox__text');
  details.value = draft.details;
  details.rows = 8;
  details.maxLength = MAX_DETAILS_CHARS;
  const size = sizeSelect();
  const save = el('button', 'port-btn mem-inbox__btn mem-inbox__btn--approve', t('mem.todo.save'));
  save.type = 'submit';
  const cancel = el('button', 'port-btn mem-inbox__btn', t('mem.inbox.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const row = el('div', 'mem-inbox__actions');
  row.append(save, cancel);
  const problem = el('p', 'hint is-fail');
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  form.append(
    el('p', 'hint', t('mem.todo.hint')),
    field('mem.todo.field.text', text),
    field('mem.todo.field.details', details),
    field('mem.todo.field.size', size),
    problem,
    row,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    onSave(todoPayload(text.value, details.value, size.value)).then((refusal) => {
      if (!refusal) return;
      // A refused save keeps the form and what was typed in it.
      problem.textContent = t(refusal);
      problem.hidden = false;
      save.disabled = false;
    });
  });
  queueMicrotask(() => text.focus());
  return form;
}

/**
 * The to-do flow of the memory window. The window owns `editing` (one draft
 * at a time, and every repaint / tab-switch lock reads it); an open to-do
 * form holds it like an edit does, and this keeps main's draft beside it.
 * @param {{actResult: (key: string, fn: string, ...args: unknown[]) => Promise<object|null>,
 *   failureOf: (key: string) => string|undefined, clearFailure: (key: string) => void,
 *   reasonKey: (reason: string) => string, load: (key?: string) => unknown,
 *   getEditing: () => string|null, setEditing: (key: string|null) => void}} w
 *   failureOf = the reason of the key's last failed call (the window's error map)
 * @returns {{open: (key: string) => Promise<void>, formOf: (key: string) => HTMLElement|null, reset: () => void}}
 */
export function createTodoFlow(w) {
  /** {key, text, details} of the open form, or null. */
  let draft = null;
  const close = (key) => {
    draft = null;
    w.setEditing(null);
    w.load(key);
  };
  return {
    /** Asks main for the card (the full memory); a refusal shows on the entry. */
    async open(key) {
      if (w.getEditing() !== null) return;
      const res = await w.actResult(key, 'memoryTodoDraft', key);
      if (res && w.getEditing() === null) {
        draft = { key, text: String(res.text || ''), details: String(res.details || '') };
        w.setEditing(key);
      }
      w.load(key);
    },
    /** The open form of this entry, or null when it has none. */
    formOf(key) {
      if (w.getEditing() !== key || !draft || draft.key !== key) return null;
      return todoForm(draft, {
        onCancel: () => close(key),
        onSave: async (payload) => {
          if (await w.actResult(key, 'memoryToTodo', key, payload)) {
            close(key);
            return null;
          }
          const reason = w.failureOf(key) || 'failed';
          if (reason === REMOVE_FAILED) {
            // The card exists: a second save would make a second one. The form
            // closes and the entry keeps the error.
            close(key);
            return null;
          }
          // The open form shows the refusal itself.
          w.clearFailure(key);
          return w.reasonKey(reason);
        },
      });
    },
    /** Forgets the draft (the window closed, or its entry left the list). */
    reset() {
      draft = null;
    },
  };
}
