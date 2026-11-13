// ============================================================================
// LunaCore - memory window keyboard review (src/renderer/modules/memoryinboxkeys.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { COMMANDS, keyCommand, typingIn, moveSelection, keepSelection } = require('../src/renderer/modules/memoryinboxkeys.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const inbox = (extra = {}) => ({ tab: 'inbox', typing: '', editing: false, confirming: false, selected: true, canGlobal: true, ...extra });
const review = (extra = {}) => ({ ...inbox(extra), tab: 'review', canGlobal: false, ...extra });
const press = (key, mods = {}) => ({ key, ...mods });

test('arrows and J/K move the selection on both tabs, with or without one', () => {
  for (const ctx of [inbox(), review(), inbox({ selected: false }), review({ selected: false })]) {
    assert.equal(keyCommand(press('ArrowDown'), ctx), COMMANDS.NEXT);
    assert.equal(keyCommand(press('j'), ctx), COMMANDS.NEXT);
    assert.equal(keyCommand(press('J'), ctx), COMMANDS.NEXT);
    assert.equal(keyCommand(press('ArrowUp'), ctx), COMMANDS.PREV);
    assert.equal(keyCommand(press('k'), ctx), COMMANDS.PREV);
  }
});

test('the To approve letters: A approve, R reject, E edit, G make global', () => {
  assert.equal(keyCommand(press('a'), inbox()), COMMANDS.APPROVE);
  assert.equal(keyCommand(press('A'), inbox()), COMMANDS.APPROVE);
  assert.equal(keyCommand(press('r'), inbox()), COMMANDS.REJECT);
  assert.equal(keyCommand(press('e'), inbox()), COMMANDS.EDIT);
  assert.equal(keyCommand(press('g'), inbox()), COMMANDS.GLOBAL);
  // A global entry cannot be made global; V belongs to the other tab.
  assert.equal(keyCommand(press('g'), inbox({ canGlobal: false })), null);
  assert.equal(keyCommand(press('v'), inbox()), null);
});

test('the To check letters: V still true, R asks to retire and R again confirms', () => {
  assert.equal(keyCommand(press('v'), review()), COMMANDS.VERIFY);
  assert.equal(keyCommand(press('r'), review()), COMMANDS.RETIRE_ASK);
  assert.equal(keyCommand(press('r'), review({ confirming: true })), COMMANDS.RETIRE_CONFIRM);
  // While the question is open, V does not settle the entry behind it.
  assert.equal(keyCommand(press('v'), review({ confirming: true })), null);
  for (const letter of ['a', 'e', 'g']) assert.equal(keyCommand(press(letter), review()), null, letter);
});

test('no action without a selected entry', () => {
  for (const letter of ['a', 'r', 'e', 'g']) assert.equal(keyCommand(press(letter), inbox({ selected: false })), null);
  for (const letter of ['v', 'r']) assert.equal(keyCommand(press(letter), review({ selected: false })), null);
});

test('Escape cancels the retire question, else clears the selection, else is left to close the window', () => {
  assert.equal(keyCommand(press('Escape'), review({ confirming: true })), COMMANDS.CANCEL_CONFIRM);
  assert.equal(keyCommand(press('Escape'), inbox()), COMMANDS.CLEAR);
  assert.equal(keyCommand(press('Escape'), inbox({ selected: false })), null);
});

test('nothing fires while typing in a field outside the edit form', () => {
  for (const typing of ['line', 'text']) {
    for (const key of ['a', 'r', 'e', 'g', 'v', 'j', 'k', 'ArrowDown', 'Escape', 'Enter']) {
      assert.equal(keyCommand(press(key), inbox({ typing })), null, `${typing} ${key}`);
      assert.equal(keyCommand(press(key), review({ typing })), null, `${typing} ${key}`);
    }
  }
});

test('an open edit takes only Enter (save) and Escape (cancel)', () => {
  const editing = (typing) => inbox({ editing: true, typing });
  assert.equal(keyCommand(press('Enter'), editing('line')), COMMANDS.SAVE);
  assert.equal(keyCommand(press('Escape'), editing('line')), COMMANDS.CANCEL_EDIT);
  assert.equal(keyCommand(press('Escape'), editing('text')), COMMANDS.CANCEL_EDIT);
  assert.equal(keyCommand(press('Escape'), editing('')), COMMANDS.CANCEL_EDIT);
  // The text area keeps Enter for a new line; Ctrl+Enter saves there.
  assert.equal(keyCommand(press('Enter'), editing('text')), null);
  assert.equal(keyCommand(press('Enter', { ctrlKey: true }), editing('text')), COMMANDS.SAVE);
  // Enter that ends an IME composition is part of the typing, not a save.
  assert.equal(keyCommand(press('Enter', { isComposing: true }), editing('line')), null);
  // Typing letters into the draft, or pressing them on its buttons, does nothing else.
  for (const key of ['a', 'r', 'e', 'g', 'j', 'ArrowDown']) {
    assert.equal(keyCommand(press(key), editing('line')), null, key);
    assert.equal(keyCommand(press(key), editing('')), null, key);
  }
});

test('Ctrl, Alt or Meta leave the key to the browser, and a held letter does not repeat', () => {
  for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(keyCommand(press('a', mods), inbox()), null);
    assert.equal(keyCommand(press('j', mods), inbox()), null);
  }
  assert.equal(keyCommand(press('a', { repeat: true }), inbox()), null);
  assert.equal(keyCommand(press('r', { repeat: true }), review({ confirming: true })), null);
  // Moving may repeat: holding Down walks the list.
  assert.equal(keyCommand(press('ArrowDown', { repeat: true }), inbox()), COMMANDS.NEXT);
});

test('keyCommand refuses junk', () => {
  assert.equal(keyCommand(null, inbox()), null);
  assert.equal(keyCommand({}, inbox()), null);
  assert.equal(keyCommand(press('a'), null), null);
  assert.equal(keyCommand(press('a'), { ...inbox(), tab: 'other' }), null);
  assert.equal(keyCommand(press('F5'), inbox()), null);
});

test('typingIn tells a text area from a one-line field and from everything else', () => {
  assert.equal(typingIn({ tagName: 'TEXTAREA' }), 'text');
  assert.equal(typingIn({ tagName: 'INPUT' }), 'line');
  assert.equal(typingIn({ tagName: 'INPUT', type: 'text' }), 'line');
  // The auto-accept switches are checkboxes: nobody types into them.
  assert.equal(typingIn({ tagName: 'INPUT', type: 'checkbox' }), '');
  assert.equal(typingIn({ tagName: 'SELECT' }), 'line');
  assert.equal(typingIn({ tagName: 'DIV', isContentEditable: true }), 'line');
  assert.equal(typingIn({ tagName: 'BUTTON' }), '');
  assert.equal(typingIn({ tagName: 'LI', isContentEditable: false }), '');
  assert.equal(typingIn(null), '');
});

test('moveSelection walks the list and stops at its ends', () => {
  const keys = ['p/a', 'p/b', 'p/c'];
  assert.equal(moveSelection(keys, null, 1), 'p/a');
  assert.equal(moveSelection(keys, null, -1), 'p/c');
  assert.equal(moveSelection(keys, 'p/a', 1), 'p/b');
  assert.equal(moveSelection(keys, 'p/c', 1), 'p/c');
  assert.equal(moveSelection(keys, 'p/a', -1), 'p/a');
  assert.equal(moveSelection(keys, 'gone', 1), 'p/a');
  assert.equal(moveSelection([], 'p/a', 1), null);
  assert.equal(moveSelection(null, 'p/a', 1), null);
});

test('keepSelection moves on to the next entry after a decision', () => {
  // p/b was approved: the entry that took its place is selected.
  assert.equal(keepSelection(['p/a', 'p/c'], 'p/b', 1), 'p/c');
  // The last one was decided: the new last one.
  assert.equal(keepSelection(['p/a', 'p/b'], 'p/c', 2), 'p/b');
  // Still listed (a repaint after another PC's change): it stays.
  assert.equal(keepSelection(['p/c', 'p/a'], 'p/a', 0), 'p/a');
  // No selection stays none; an empty list has none.
  assert.equal(keepSelection(['p/a'], null, 0), null);
  assert.equal(keepSelection([], 'p/a', 0), null);
  assert.equal(keepSelection(['p/a', 'p/b'], 'gone', -3), 'p/a');
});

test('the window wires the keys through the overlay and only uses channels preload exposes', () => {
  const panel = read('src/renderer/modules/memoryinbox.js');
  const overlay = read('src/renderer/modules/talloverlay.js');
  assert.match(panel, /onKeydown: onKey/);
  // Only keyboard focus selects an entry: a mouse user's first Esc still closes the window.
  assert.match(panel, /matches\(':focus-visible'\)\) markSelected/);
  // The retire question is on screen before a second R can answer it.
  assert.match(panel, /\[COMMANDS\.RETIRE_ASK\]: async \(key\) => \{\s*settling\+\+;/);
  assert.match(panel, /from '\.\/memoryinboxkeys\.js'/);
  // The top overlay's handler runs before Esc closes it.
  assert.ok(overlay.indexOf('top.onKeydown(e)') < overlay.indexOf('top.close()'));
  const preload = read('src/preload.js');
  for (const fn of new Set([...panel.matchAll(/'(memory(?:Inbox|Review)\w*)'/g)].map((m) => m[1]))) {
    assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
  }
});

test('the key hint exists in Polish and English', () => {
  const i18n = read('src/renderer/i18n.js');
  for (const key of ['mem.inbox.keys.inbox', 'mem.inbox.keys.review']) {
    assert.equal(i18n.split('\n').filter((l) => l.includes(`'${key}':`)).length, 2, key);
  }
});
