// Tests for the pure half of the clipboard history: entry validation, MRU
// dedupe, the cap, and the watcher's change detection. ClipboardWatcher is
// driven with an injected reader and its tick() called by hand, so nothing
// here touches a real clipboard, a real timer or a real disk - the same
// testing boundary ports.js draws around its scanner.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEntry,
  pushEntry,
  removeEntry,
  normalizeHistory,
  ClipboardWatcher,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
} = require('../src/clipboard.js');
const { previewOf } = require('../src/renderer/modules/clipboard.js');

// ---- normalizeEntry ---------------------------------------------------------

test('normalizeEntry trims and keeps ordinary text', () => {
  assert.equal(normalizeEntry('  hello  '), 'hello');
});

test('normalizeEntry rejects empty, whitespace-only and non-string input', () => {
  assert.equal(normalizeEntry(''), null);
  assert.equal(normalizeEntry('   \n\t '), null);
  assert.equal(normalizeEntry(undefined), null);
  assert.equal(normalizeEntry(42), null);
});

test('normalizeEntry rejects an oversized clip rather than truncating it', () => {
  assert.equal(normalizeEntry('x'.repeat(MAX_ENTRY_CHARS + 1)), null);
  assert.equal(normalizeEntry('x'.repeat(MAX_ENTRY_CHARS)).length, MAX_ENTRY_CHARS);
});

// ---- pushEntry --------------------------------------------------------------

test('pushEntry puts the newest clip first', () => {
  const list = pushEntry(pushEntry([], 'one', 1), 'two', 2);
  assert.deepEqual(
    list.map((e) => e.text),
    ['two', 'one']
  );
});

test('pushEntry moves a re-copied clip back to the top instead of duplicating it', () => {
  let list = pushEntry([], 'one', 1);
  list = pushEntry(list, 'two', 2);
  list = pushEntry(list, 'one', 3);
  assert.deepEqual(
    list.map((e) => e.text),
    ['one', 'two']
  );
  assert.equal(list[0].at, 3);
});

test('pushEntry caps the history at MAX_ENTRIES, dropping the oldest', () => {
  let list = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) list = pushEntry(list, `clip-${i}`, i);
  assert.equal(list.length, MAX_ENTRIES);
  assert.equal(list[0].text, `clip-${MAX_ENTRIES + 4}`);
  assert.ok(!list.some((e) => e.text === 'clip-0'));
});

test('pushEntry does not mutate the list it was given', () => {
  const before = pushEntry([], 'one', 1);
  const copy = [...before];
  pushEntry(before, 'two', 2);
  assert.deepEqual(before, copy);
});

// ---- removeEntry / normalizeHistory -----------------------------------------

test('removeEntry drops the matching clip and leaves the rest', () => {
  const list = pushEntry(pushEntry([], 'one', 1), 'two', 2);
  assert.deepEqual(
    removeEntry(list, 'one').map((e) => e.text),
    ['two']
  );
});

test('normalizeHistory drops malformed rows, dedupes and applies the cap', () => {
  const raw = [
    { text: 'ok', at: 5 },
    { text: '   ', at: 6 },
    null,
    'not an object',
    { text: 'ok', at: 7 },
    { text: 'second' },
  ];
  assert.deepEqual(normalizeHistory(raw), [
    { text: 'ok', at: 5 },
    { text: 'second', at: 0 },
  ]);
});

test('normalizeHistory on a non-array returns an empty list', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory({ text: 'x' }), []);
});

// ---- ClipboardWatcher -------------------------------------------------------

function watcherOn(reads) {
  let i = 0;
  const seen = [];
  const watcher = new ClipboardWatcher(
    () => reads[Math.min(i, reads.length - 1)],
    (list) => seen.push(list)
  );
  // Bypass start(): it seeds `last` AND reads the real history file from disk.
  watcher.list = [];
  watcher.last = null;
  return {
    watcher,
    seen,
    step(next) {
      i = next;
      watcher.tick();
    },
  };
}

test('ClipboardWatcher emits once per new clip', () => {
  const { seen, step } = watcherOn(['first', 'second']);
  step(0);
  step(1);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen[1].map((e) => e.text),
    ['second', 'first']
  );
});

test('ClipboardWatcher stays silent while the clipboard is unchanged', () => {
  const { seen, step } = watcherOn(['same']);
  step(0);
  step(0);
  step(0);
  assert.equal(seen.length, 1);
});

test('ClipboardWatcher ignores an empty clipboard', () => {
  const { seen, step } = watcherOn(['   ']);
  step(0);
  assert.equal(seen.length, 0);
});

test('ClipboardWatcher survives a reader that throws (clipboard held elsewhere)', () => {
  const seen = [];
  const watcher = new ClipboardWatcher(
    () => {
      throw new Error('clipboard busy');
    },
    (list) => seen.push(list)
  );
  watcher.list = [];
  watcher.last = null;
  assert.doesNotThrow(() => watcher.tick());
  assert.equal(seen.length, 0);
});

// ---- previewOf (renderer widget) --------------------------------------------

test('previewOf collapses newlines and whitespace runs into single spaces', () => {
  assert.equal(previewOf('line one\n\n  line two', 90), 'line one line two');
});

test('previewOf truncates a long clip with an ellipsis', () => {
  assert.equal(previewOf('abcdefghij', 4), 'abc…');
});

test('previewOf on a non-string treats it as empty', () => {
  assert.equal(previewOf(undefined, 10), '');
  assert.equal(previewOf(null, 10), '');
});
