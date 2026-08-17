// Tests for pricing and cost estimation (B4). Pure functions, no I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRates, rateFor, estimateCost, formatUsd, normalizeRate } = require('../src/rates');
const { MODEL_WINDOWS } = require('../src/models');

const RATES = [
  { id: 'claude-opus-4-8', input: 5, output: 25 },
  { id: 'claude-sonnet-5', input: 3, output: 15 },
  { id: 'claude-haiku-4-5', input: 1, output: 5 },
];

// ---- coverage of the SHIPPED config -------------------------------------------
// The tests above use a RATES stub, so the logic can be green while the real
// config/rates.json is missing the current model. That is exactly what happened:
// Opus 5 had no entry either in the price list (no amount shown in the HUD), or
// in MODEL_WINDOWS (the bar fell back to 200k). These are DATA tests, not logic
// tests - they guard against the tables falling behind the model family.

const CURRENT_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
];

test('config/rates.json knows all current models', () => {
  const { rates } = loadRates();
  for (const id of CURRENT_MODELS) {
    assert.ok(rateFor(id, rates), `no price for ${id} - the HUD will not show a cost`);
  }
});

test('MODEL_WINDOWS knows all current models', () => {
  for (const id of CURRENT_MODELS) {
    assert.ok(
      MODEL_WINDOWS.some((row) => id.startsWith(row.prefix)),
      `no window for ${id} - the context bar will fall back to the default 200k`,
    );
  }
});

// ---- normalizeRate ----------------------------------------------------------

test('normalizeRate passes a valid entry through', () => {
  assert.deepEqual(normalizeRate({ id: 'x', input: 1, output: 2 }), {
    id: 'x',
    input: 1,
    output: 2,
  });
});

test('normalizeRate rejects entries without id or with a non-numeric price', () => {
  assert.equal(normalizeRate({ input: 1, output: 2 }), null);
  assert.equal(normalizeRate({ id: 'x', input: '5', output: 2 }), null);
  assert.equal(normalizeRate({ id: 'x', input: 1 }), null);
  assert.equal(normalizeRate(null), null);
});

test('normalizeRate rejects negative prices', () => {
  assert.equal(normalizeRate({ id: 'x', input: -1, output: 2 }), null);
});

// ---- rateFor ----------------------------------------------------------------

test('rateFor matches exactly', () => {
  assert.equal(rateFor('claude-opus-4-8', RATES).input, 5);
  assert.equal(rateFor('claude-haiku-4-5', RATES).output, 5);
});

test('rateFor matches by prefix (id with a date suffix)', () => {
  // A transcript can contain "claude-sonnet-5-20260115".
  assert.equal(rateFor('claude-sonnet-5-20260115', RATES).id, 'claude-sonnet-5');
});

test('rateFor is case-insensitive', () => {
  assert.equal(rateFor('CLAUDE-OPUS-4-8', RATES).id, 'claude-opus-4-8');
});

test('rateFor returns null for an unknown model', () => {
  // Key: no estimate is better than a made-up amount.
  assert.equal(rateFor('qwen2.5-coder-32b', RATES), null);
  assert.equal(rateFor('', RATES), null);
  assert.equal(rateFor(null, RATES), null);
  assert.equal(rateFor('claude-opus-4-8', null), null);
});

// ---- estimateCost -----------------------------------------------------------

const MULT = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

test('estimateCost prices input and output at the per-million rate', () => {
  const c = estimateCost({ input: 1000000, output: 1000000 }, RATES[0], MULT);
  assert.equal(c.input, 5);
  assert.equal(c.output, 25);
  assert.equal(c.usd, 30);
});

test('estimateCost prices cache with a multiplier off the INPUT rate', () => {
  // 1M of cache reads at a $5 rate and a 0.1 multiplier => $0.50.
  const c = estimateCost({ cacheRead: 1000000 }, RATES[0], MULT);
  assert.equal(c.cacheRead, 0.5);
  assert.equal(c.usd, 0.5);
});

test('estimateCost prices a cache write more expensively than a plain input', () => {
  // 1M of cache writes at a $5 rate and a 1.25 multiplier => $6.25.
  const c = estimateCost({ cacheWrite: 1000000 }, RATES[0], MULT);
  assert.equal(c.cacheWrite, 6.25);
});

test('estimateCost sums all four components', () => {
  const c = estimateCost(
    { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 },
    RATES[0],
    MULT
  );
  assert.equal(c.usd, 5 + 25 + 0.5 + 6.25);
});

test('estimateCost treats missing counters as zero', () => {
  assert.equal(estimateCost({}, RATES[0], MULT).usd, 0);
});

test('estimateCost returns null without a rate (unknown model)', () => {
  assert.equal(estimateCost({ input: 100 }, null, MULT), null);
  assert.equal(estimateCost(null, RATES[0], MULT), null);
});

test('estimateCost has sensible default cache multipliers', () => {
  const c = estimateCost({ cacheRead: 1000000 }, RATES[0]);
  assert.equal(c.cacheRead, 0.5);
});

// ---- formatUsd --------------------------------------------------------------

test('formatUsd picks precision based on order of magnitude', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0004), '$0.0004');
  assert.equal(formatUsd(0.25), '$0.250');
  assert.equal(formatUsd(12.5), '$12.50');
});

test('formatUsd returns an empty string for an invalid amount', () => {
  assert.equal(formatUsd(null), '');
  assert.equal(formatUsd(NaN), '');
  assert.equal(formatUsd(-1), '');
});
