// ============================================================================
// LunaCore - Mission Control hourly weather view tests
// (src/renderer/modules/missionweatherview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { surfaceOf } = require('../src/renderer/modules/missionweatherview.js');

test('surfaceOf: the rain amount decides first', () => {
  assert.equal(surfaceOf({ mm: 1.2, rain: 20 }), 'wet');
  assert.equal(surfaceOf({ mm: 0.5, rain: 0 }), 'wet');
  assert.equal(surfaceOf({ mm: 0.2, rain: 80 }), 'wet');
  assert.equal(surfaceOf({ mm: 0.2, rain: 30 }), 'maybe');
});

test('surfaceOf: a high chance of almost nothing is "may rain", not wet', () => {
  assert.equal(surfaceOf({ mm: 0, rain: 90 }), 'maybe');
  assert.equal(surfaceOf({ mm: 0, rain: 10 }), 'dry');
});

test('surfaceOf: without an amount, the chance alone decides', () => {
  assert.equal(surfaceOf({ mm: null, rain: 75 }), 'wet');
  assert.equal(surfaceOf({ mm: null, rain: 45 }), 'maybe');
  assert.equal(surfaceOf({ mm: null, rain: null }), 'dry');
  assert.equal(surfaceOf(null), 'dry');
});
