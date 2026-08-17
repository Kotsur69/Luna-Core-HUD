// Tests for the pin-board todo list: boundary validation in src/todo.js and
// the pure list operations in the renderer widget. No disk, no DOM - readTodos/
// writeTodos are left to the manual verification checklist, same boundary
// test/clipboard.test.js draws.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTodo, normalizeTodos, MAX_ITEMS, MAX_TEXT_CHARS } = require('../src/todo.js');
const {
  addTodo,
  toggleTodo,
  removeTodo,
  clearDone,
  openCount,
} = require('../src/renderer/modules/todo.js');

// ---- normalizeTodo ----------------------------------------------------------

test('normalizeTodo fills in the defaults for a bare item', () => {
  assert.deepEqual(normalizeTodo({ text: 'ship it' }), { text: 'ship it', done: false, at: 0 });
});

test('normalizeTodo trims text and caps its length', () => {
  assert.equal(normalizeTodo({ text: '  padded  ' }).text, 'padded');
  assert.equal(normalizeTodo({ text: 'x'.repeat(MAX_TEXT_CHARS + 50) }).text.length, MAX_TEXT_CHARS);
});

test('normalizeTodo rejects empty text and non-objects', () => {
  assert.equal(normalizeTodo({ text: '   ' }), null);
  assert.equal(normalizeTodo({}), null);
  assert.equal(normalizeTodo(null), null);
  assert.equal(normalizeTodo('todo'), null);
});

test('normalizeTodo treats only a literal true as done', () => {
  assert.equal(normalizeTodo({ text: 'a', done: 'yes' }).done, false);
  assert.equal(normalizeTodo({ text: 'a', done: 1 }).done, false);
  assert.equal(normalizeTodo({ text: 'a', done: true }).done, true);
});

// ---- normalizeTodos ---------------------------------------------------------

test('normalizeTodos drops malformed rows but keeps duplicates', () => {
  const out = normalizeTodos([{ text: 'a' }, null, { text: '' }, { text: 'a' }]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((i) => i.text),
    ['a', 'a']
  );
});

test('normalizeTodos applies the item cap', () => {
  const raw = Array.from({ length: MAX_ITEMS + 10 }, (_v, i) => ({ text: `t${i}` }));
  assert.equal(normalizeTodos(raw).length, MAX_ITEMS);
});

test('normalizeTodos on a non-array returns an empty list', () => {
  assert.deepEqual(normalizeTodos(undefined), []);
});

// ---- addTodo ----------------------------------------------------------------

test('addTodo appends to the end (a board reads top-down)', () => {
  const list = addTodo(addTodo([], 'first', 1), 'second', 2);
  assert.deepEqual(
    list.map((i) => i.text),
    ['first', 'second']
  );
});

test('addTodo returns the SAME list for empty input, so the caller can detect a no-op', () => {
  const list = addTodo([], 'real', 1);
  assert.equal(addTodo(list, '   '), list);
  assert.equal(addTodo(list, ''), list);
});

test('addTodo does not mutate the list it was given', () => {
  const before = addTodo([], 'one', 1);
  const copy = [...before];
  addTodo(before, 'two', 2);
  assert.deepEqual(before, copy);
});

// ---- toggleTodo / removeTodo ------------------------------------------------

test('toggleTodo flips only the addressed item', () => {
  const list = addTodo(addTodo([], 'a', 1), 'b', 2);
  const out = toggleTodo(list, 1);
  assert.equal(out[0].done, false);
  assert.equal(out[1].done, true);
  // and back again
  assert.equal(toggleTodo(out, 1)[1].done, false);
});

test('toggleTodo with an out-of-range index is a no-op', () => {
  const list = addTodo([], 'a', 1);
  assert.equal(toggleTodo(list, 5), list);
  assert.equal(toggleTodo(list, -1), list);
});

test('removeTodo drops the addressed item and keeps order', () => {
  let list = addTodo([], 'a', 1);
  list = addTodo(list, 'b', 2);
  list = addTodo(list, 'c', 3);
  assert.deepEqual(
    removeTodo(list, 1).map((i) => i.text),
    ['a', 'c']
  );
});

test('removeTodo with an out-of-range index is a no-op', () => {
  const list = addTodo([], 'a', 1);
  assert.equal(removeTodo(list, 9), list);
});

// ---- clearDone / openCount --------------------------------------------------

test('clearDone removes only the ticked items', () => {
  let list = addTodo(addTodo([], 'keep', 1), 'drop', 2);
  list = toggleTodo(list, 1);
  assert.deepEqual(
    clearDone(list).map((i) => i.text),
    ['keep']
  );
});

test('openCount counts what is left to do, not the total', () => {
  let list = addTodo(addTodo([], 'a', 1), 'b', 2);
  assert.equal(openCount(list), 2);
  list = toggleTodo(list, 0);
  assert.equal(openCount(list), 1);
});

test('the list operations tolerate a non-array (nothing loaded yet)', () => {
  assert.deepEqual(addTodo(null, 'a', 1), [{ text: 'a', done: false, at: 1 }]);
  assert.deepEqual(clearDone(undefined), []);
  assert.equal(openCount(null), 0);
});
