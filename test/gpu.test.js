// Tests for parseGpu() - the only pure function in src/gpu.js (the rest
// spawns a real process, see the comment at the bottom of the module and
// test/ports.test.js for the same convention).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGpu } = require('../src/gpu');

test('parseGpu reads a percent from valid JSON', () => {
  assert.deepEqual(parseGpu('{"percent":42}'), { percent: 42 });
});

test('parseGpu clamps the range to 0-100', () => {
  assert.deepEqual(parseGpu('{"percent":142}'), { percent: 100 });
  assert.deepEqual(parseGpu('{"percent":-5}'), { percent: 0 });
});

test('parseGpu rounds non-integer values', () => {
  assert.deepEqual(parseGpu('{"percent":41.6}'), { percent: 42 });
});

test('parseGpu returns null for empty/whitespace stdout (no GPU counter)', () => {
  assert.equal(parseGpu(''), null);
  assert.equal(parseGpu('   \n'), null);
  assert.equal(parseGpu(undefined), null);
});

test('parseGpu returns null for corrupt JSON', () => {
  assert.equal(parseGpu('not json'), null);
});

test('parseGpu returns null when the percent field has the wrong type or is missing', () => {
  assert.equal(parseGpu('{}'), null);
  assert.equal(parseGpu('{"percent":"42"}'), null);
  assert.equal(parseGpu('{"percent":null}'), null);
});
