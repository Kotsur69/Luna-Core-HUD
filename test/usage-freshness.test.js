// fmtAgo() - the "updated Xs ago" freshness label behind the usage tile.
// Split from usage-thresholds.test.js/usage-poll-delay.test.js on purpose:
// those cover src/usage.js (main process), this covers the renderer-side
// formatter in src/renderer/modules/usage.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fmtAgo } = require('../src/renderer/modules/usage.js');

test('sekundy ponizej minuty', () => {
  assert.equal(fmtAgo(1000, 1000), '0s');
  assert.equal(fmtAgo(1000, 1000 + 3000), '3s');
  assert.equal(fmtAgo(1000, 1000 + 59000), '59s');
});

test('minuty od 60 sekund wzwyz', () => {
  assert.equal(fmtAgo(0, 60000), '1m');
  assert.equal(fmtAgo(0, 5 * 60000), '5m');
  assert.equal(fmtAgo(0, 59 * 60000), '59m');
});

test('godziny + minuty od pelnej godziny wzwyz', () => {
  assert.equal(fmtAgo(0, 60 * 60000), '1h 0m');
  assert.equal(fmtAgo(0, (2 * 60 + 5) * 60000), '2h 5m');
});

test('brak/zla wartosc fetchedAt -> null (nic do pokazania)', () => {
  assert.equal(fmtAgo(null), null);
  assert.equal(fmtAgo(undefined), null);
  assert.equal(fmtAgo(NaN), null);
  assert.equal(fmtAgo('123'), null);
});

test('fetchedAt z przyszlosci (zegar/skok) nie schodzi ponizej 0s', () => {
  assert.equal(fmtAgo(5000, 1000), '0s');
});
