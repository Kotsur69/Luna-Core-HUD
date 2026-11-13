// ============================================================================
// LunaCore - memory window keyboard review (renderer, pure)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, "Improvements proposed after phase 4",
// item 4. The memory window (memoryinbox.js) asks this module what a key press
// means; it holds no state and touches no DOM, so node --test covers it whole.
//
//   Up / Down, K / J   move the selected entry
//   A                  approve              ('To approve')
//   R                  reject               ('To approve')
//                      retire, asked twice  ('To check': R shows the question, R again deletes)
//   E                  edit                 ('To approve')
//   G                  make global          ('To approve', a project entry only)
//   V                  still true           ('To check')
//   Enter              save the open edit (Ctrl+Enter inside the text area)
//   Escape             cancel the edit / the retire question, else clear the selection
//
// Nothing fires while the user types in a field, except Enter (save) and
// Escape (cancel) in the edit form. A key with Ctrl, Alt or Meta is left to
// the browser, so copy, paste and select-all keep working. A held letter does
// not repeat its action.
// ============================================================================

'use strict';

/** Commands keyCommand() can return. */
export const COMMANDS = Object.freeze({
  NEXT: 'next',
  PREV: 'prev',
  APPROVE: 'approve',
  REJECT: 'reject',
  EDIT: 'edit',
  SAVE: 'save',
  CANCEL_EDIT: 'cancel-edit',
  GLOBAL: 'global',
  VERIFY: 'verify',
  RETIRE_ASK: 'retire-ask',
  RETIRE_CONFIRM: 'retire-confirm',
  CANCEL_CONFIRM: 'cancel-confirm',
  CLEAR: 'clear',
});

const MOVES = { ArrowDown: COMMANDS.NEXT, j: COMMANDS.NEXT, ArrowUp: COMMANDS.PREV, k: COMMANDS.PREV };
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** Inputs nobody types into: the keys keep working when one has the focus. */
const CLICK_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);

/**
 * Whether a key event's target is a field the user types into.
 * @param {{tagName?: string, type?: string, isContentEditable?: boolean}|null|undefined} target
 * @returns {'' | 'line' | 'text'} '' = not a field; 'text' = a multi-line text area
 */
export function typingIn(target) {
  if (!target) return '';
  if (target.tagName === 'TEXTAREA') return 'text';
  if (target.tagName === 'INPUT' && CLICK_INPUTS.has(String(target.type).toLowerCase())) return '';
  if (TYPING_TAGS.has(target.tagName) || target.isContentEditable === true) return 'line';
  return '';
}

/** The command of a key pressed while the edit form is open, or null. */
function editCommand(key, mod, typing) {
  if (key === 'Escape') return COMMANDS.CANCEL_EDIT;
  // A text area keeps Enter for a new line: Ctrl+Enter saves there.
  if (key === 'Enter' && typing === 'line' && !mod.alt) return COMMANDS.SAVE;
  if (key === 'Enter' && typing === 'text' && (mod.ctrl || mod.meta)) return COMMANDS.SAVE;
  return null;
}

/** The command of a letter on the 'To approve' list, or null. */
function inboxLetter(letter, ctx) {
  if (letter === 'a') return COMMANDS.APPROVE;
  if (letter === 'r') return COMMANDS.REJECT;
  if (letter === 'e') return COMMANDS.EDIT;
  if (letter === 'g' && ctx.canGlobal) return COMMANDS.GLOBAL;
  return null;
}

/** The command of a letter on the 'To check' list, or null. */
function reviewLetter(letter, ctx) {
  if (letter === 'v' && !ctx.confirming) return COMMANDS.VERIFY;
  // The second R answers the question the first one asked.
  if (letter === 'r') return ctx.confirming ? COMMANDS.RETIRE_CONFIRM : COMMANDS.RETIRE_ASK;
  return null;
}

/**
 * What a key press means in the memory window.
 * @param {{key: string, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, repeat?: boolean, isComposing?: boolean}} event
 * @param {{tab: 'inbox'|'review', typing?: '' | 'line' | 'text', editing?: boolean,
 *   confirming?: boolean, selected?: boolean, canGlobal?: boolean}} ctx
 *   typing = typingIn(event.target); editing = an edit form is open; confirming = the
 *   selected entry shows the retire question; selected = an entry is selected;
 *   canGlobal = the selected entry is a waiting project entry
 * @returns {string|null} one of COMMANDS, or null = not ours (the browser handles it)
 */
export function keyCommand(event, ctx) {
  if (!event || typeof event.key !== 'string' || !ctx) return null;
  // A key that ends an IME composition belongs to the text being typed.
  if (event.isComposing) return null;
  const { key } = event;
  const mod = { ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey) };
  const typing = ctx.typing || '';
  // An open draft takes only save and cancel: any other action would repaint it away.
  if (ctx.editing) return editCommand(key, mod, typing);
  if (typing) return null;
  if (key === 'Escape') {
    if (ctx.confirming) return COMMANDS.CANCEL_CONFIRM;
    return ctx.selected ? COMMANDS.CLEAR : null;
  }
  if (mod.ctrl || mod.alt || mod.meta) return null;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (MOVES[lower]) return MOVES[lower];
  // Every action below acts on the selected entry. A held key repeats: it must
  // not approve or reject one entry after another as the selection advances.
  if (!ctx.selected || lower.length !== 1 || event.repeat) return null;
  if (ctx.tab === 'inbox') return inboxLetter(lower, ctx);
  if (ctx.tab === 'review') return reviewLetter(lower, ctx);
  return null;
}

/**
 * The key selected after a move.
 * @param {string[]} keys the listed entries, in order
 * @param {string|null} current the selected key
 * @param {1|-1} step
 * @returns {string|null} no selection yet: the first entry (down) or the last (up)
 */
export function moveSelection(keys, current, step) {
  if (!Array.isArray(keys) || !keys.length) return null;
  const at = keys.indexOf(current);
  if (at < 0) return step < 0 ? keys[keys.length - 1] : keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, at + step))];
}

/**
 * The selection after a repaint. An entry that left the list (approved,
 * rejected, retired, decided on another PC) hands the selection to the entry
 * that took its place, or to the new last one.
 * @param {string[]} keys the listed entries after the repaint
 * @param {string|null} selected the key selected before
 * @param {number} index where the selected entry was listed before
 * @returns {string|null}
 */
export function keepSelection(keys, selected, index) {
  if (selected === null || selected === undefined || !Array.isArray(keys) || !keys.length) return null;
  if (keys.includes(selected)) return selected;
  const at = Number.isInteger(index) && index > 0 ? index : 0;
  return keys[Math.min(at, keys.length - 1)];
}
