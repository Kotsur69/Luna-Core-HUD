// Burn-rate sparkline tests.
//
// These exist because of a bug that shipped in the sparkline's very first commit
// (55ac9e5) and survived A1 and A2 untouched: pushSample() stored
// { t, tokens, percent } while renderBurn() computed CTX_WARN_HIGH * last.limit.
// `limit` was never in the sample, so the product was NaN, `remaining > 0` was
// false, and the code fell into the else branch - announcing "w strefie compact"
// at 6% context. The ETA to 85% had therefore never worked.
//
// It hid for three refactors because NaN comparisons do not throw, they just
// quietly pick the wrong branch, and nothing in test/ touched either function.
// Found by hand on 2026-08-03 during the owed by-hand pass on `context` -
// the old version was announcing "in the compact zone" at 6% context.
//
// The lesson worth encoding: the two halves must be tested TOGETHER. Testing
// etaMinutes() with a hand-built object would still pass while pushSample()
// dropped the field - so the last test here feeds one into the other.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pushSample, etaMinutes, SPARK_MAX } = require('../src/renderer/modules/spark.js');

const M = (tokens, percent, limit) => ({ tokens, percent, limit });

// ---- pushSample -------------------------------------------------------------

test('pushSample stores the limit together with the sample', () => {
  const buf = pushSample([], M(61000, 0.061, 1000000));
  assert.equal(buf.length, 1);
  assert.equal(buf[0].tokens, 61000);
  assert.equal(buf[0].percent, 0.061);
  // The regression: without this field renderBurn multiplies by undefined.
  assert.equal(buf[0].limit, 1000000);
});

test('pushSample refreshes the limit when the token count did not change', () => {
  // B2 promotes the window mid-session, so a sample can outlive its own limit.
  const buf = pushSample([], M(61000, 0.061, 200000));
  pushSample(buf, M(61000, 0.305, 1000000));
  assert.equal(buf.length, 1, 'the same token count does not add a point');
  assert.equal(buf[0].limit, 1000000);
});

test('pushSample adds a point when tokens increased', () => {
  const buf = pushSample([], M(1000, 0.001, 1000000));
  pushSample(buf, M(2000, 0.002, 1000000));
  assert.equal(buf.length, 2);
  assert.equal(buf[1].tokens, 2000);
});

test('pushSample trims the buffer to SPARK_MAX', () => {
  let buf = [];
  for (let i = 1; i <= SPARK_MAX + 10; i++) buf = pushSample(buf, M(i * 100, i / 1000, 1000000));
  assert.equal(buf.length, SPARK_MAX);
  // The oldest samples fall off the front.
  assert.equal(buf[buf.length - 1].tokens, (SPARK_MAX + 10) * 100);
});

// ---- etaMinutes -------------------------------------------------------------

test('etaMinutes computes time to the 85% threshold', () => {
  // 850k - 61k = 789k to the threshold, at 2000 tok/min => ~394.5 min
  const min = etaMinutes({ tokens: 61000, limit: 1000000 }, 2000);
  assert.ok(Math.abs(min - 394.5) < 0.1, `expected ~394.5, got ${min}`);
});

test('etaMinutes returns 0 once the threshold is crossed', () => {
  assert.equal(etaMinutes({ tokens: 900000, limit: 1000000 }, 2000), 0);
});

test('etaMinutes returns null without a known limit', () => {
  // THIS was the bug: undefined * anything = NaN, and NaN > 0 is false, so the
  // old version claimed "in the compact zone" at 6% context.
  assert.equal(etaMinutes({ tokens: 61000 }, 2000), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: 0 }, 2000), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: null }, 2000), null);
  assert.equal(etaMinutes(null, 2000), null);
});

test('etaMinutes returns null when the context is not growing', () => {
  assert.equal(etaMinutes({ tokens: 61000, limit: 1000000 }, 0), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: 1000000 }, -500), null);
});

// ---- both halves together ------------------------------------------------------

test('a sample from pushSample yields a computable ETA (regression 55ac9e5)', () => {
  // This test is the whole point of the file. etaMinutes tested in isolation
  // passes even when pushSample drops `limit` - only combining both halves
  // reproduces the real data path and catches that bug.
  const buf = pushSample([], M(61000, 0.061, 1000000));
  const min = etaMinutes(buf[buf.length - 1], 2000);
  assert.notEqual(min, null, 'an ETA computed from a real sample must not be unknown');
  assert.ok(min > 0, 'at 6% context the 85% threshold is still ahead');
});
