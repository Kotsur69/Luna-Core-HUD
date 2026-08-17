// Tests for the pure functions behind the Session Timeline & Snapshot Scrubber
// (LUNA_HUD_SPECIFICATION.md §6.1). Zero DOM - truncateText/capTurns/applyTurnEvent
// are pure; the widget's rendering and modal live behind a manual check (plan
// "Verification" section).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  truncateText,
  capTurns,
  applyTurnEvent,
} = require('../src/renderer/modules/sessiontimeline.js');

// ---- truncateText -------------------------------------------------------------

test('truncateText leaves short text untouched and reports no truncation', () => {
  const { text, truncated } = truncateText('hello', 100);
  assert.equal(text, 'hello');
  assert.equal(truncated, false);
});

test('truncateText cuts text longer than maxChars and flags it', () => {
  const { text, truncated } = truncateText('abcdefghij', 4);
  assert.equal(text, 'abcd');
  assert.equal(truncated, true);
});

test('truncateText on exactly maxChars is not truncated', () => {
  const { text, truncated } = truncateText('abcd', 4);
  assert.equal(text, 'abcd');
  assert.equal(truncated, false);
});

test('truncateText on a non-string input treats it as empty', () => {
  assert.deepEqual(truncateText(undefined, 10), { text: '', truncated: false });
  assert.deepEqual(truncateText(null, 10), { text: '', truncated: false });
});

// ---- capTurns -------------------------------------------------------------------

test('capTurns leaves a list under the cap untouched', () => {
  const list = [1, 2, 3];
  capTurns(list, 5);
  assert.deepEqual(list, [1, 2, 3]);
});

test('capTurns drops the oldest entries past the cap, keeping the most recent', () => {
  const list = [1, 2, 3, 4, 5];
  capTurns(list, 3);
  assert.deepEqual(list, [3, 4, 5]);
});

test('capTurns returns the same list it was given (mutated in place)', () => {
  const list = [1, 2, 3];
  const out = capTurns(list, 2);
  assert.equal(out, list);
});

// ---- applyTurnEvent ---------------------------------------------------------------

test('applyTurnEvent appends a turn with startedAt/endedAt/text preserved', () => {
  const list = [];
  applyTurnEvent(list, { startedAt: 1000, endedAt: 1500, text: 'done' });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { startedAt: 1000, endedAt: 1500, text: 'done', truncated: false });
});

test('applyTurnEvent truncates a long fragment using the given maxChars', () => {
  const list = [];
  applyTurnEvent(list, { startedAt: 1000, endedAt: 1500, text: 'abcdefghij' }, 4);
  assert.equal(list[0].text, 'abcd');
  assert.equal(list[0].truncated, true);
});

test('applyTurnEvent caps the list at the given max, dropping the oldest turn', () => {
  const list = [];
  applyTurnEvent(list, { startedAt: 1, endedAt: 2, text: 'a' }, 4000, 2);
  applyTurnEvent(list, { startedAt: 3, endedAt: 4, text: 'b' }, 4000, 2);
  applyTurnEvent(list, { startedAt: 5, endedAt: 6, text: 'c' }, 4000, 2);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.text), ['b', 'c']);
});

test('applyTurnEvent defaults startedAt to 0 when missing (no user prompt observed)', () => {
  const list = [];
  applyTurnEvent(list, { endedAt: 1500, text: 'done' });
  assert.equal(list[0].startedAt, 0);
});

test('applyTurnEvent on a null/undefined turn is a no-op', () => {
  const list = [];
  applyTurnEvent(list, null);
  applyTurnEvent(list, undefined);
  assert.equal(list.length, 0);
});

test('applyTurnEvent returns the same list it was given (mutated in place)', () => {
  const list = [];
  const out = applyTurnEvent(list, { startedAt: 1, endedAt: 2, text: 'a' });
  assert.equal(out, list);
});
