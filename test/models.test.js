// Tests for model knowledge: context window + label. Pure functions, no I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { contextLimitFor, modelLabel, DEFAULT_CONTEXT_LIMIT } = require('../src/models');

// ---- contextLimitFor --------------------------------------------------------

test('contextLimitFor knows the real windows of current models (1M)', () => {
  // Fix 2026-07-24: these models have a 1M window, not 200k. The previous
  // version returned 200k here, so the bar would show 100% at around 20%.
  // Opus 5 was added later the same day - a missing entry meant falling back to
  // the default 200k, i.e. the exact same lying bar as above.
  assert.equal(contextLimitFor('claude-opus-5'), 1000000);
  assert.equal(contextLimitFor('claude-opus-4-8'), 1000000);
  assert.equal(contextLimitFor('claude-opus-4-7'), 1000000);
  assert.equal(contextLimitFor('claude-sonnet-5'), 1000000);
  assert.equal(contextLimitFor('claude-fable-5'), 1000000);
});

test('contextLimitFor knows the exception: Haiku 4.5 has 200k', () => {
  assert.equal(contextLimitFor('claude-haiku-4-5'), 200000);
  assert.equal(contextLimitFor('claude-haiku-4-5-20251001'), 200000);
});

test('contextLimitFor matches models with a date suffix', () => {
  assert.equal(contextLimitFor('claude-opus-4-8-20260115'), 1000000);
});

test('contextLimitFor falls back to 200k for an unknown model', () => {
  // Unknown backend (LM Studio, Kimi): assume cautiously, observation will correct it.
  assert.equal(contextLimitFor('qwen2.5-coder-32b-instruct'), DEFAULT_CONTEXT_LIMIT);
  assert.equal(contextLimitFor('claude-sonnet-4-5-20250929'), 200000);
});

test('contextLimitFor is resilient to a missing/empty model', () => {
  assert.equal(contextLimitFor(''), 200000);
  assert.equal(contextLimitFor(null), 200000);
  assert.equal(contextLimitFor(undefined), 200000);
});

test('contextLimitFor recognizes the 1M marker in a model id', () => {
  assert.equal(contextLimitFor('claude-sonnet-4-5-1m'), 1000000);
  assert.equal(contextLimitFor('claude-sonnet-4-5[1m]'), 1000000);
});

test('contextLimitFor is not fooled by a plain digit 1 in the id', () => {
  assert.equal(contextLimitFor('claude-opus-4-1'), 200000);
  assert.equal(contextLimitFor('claude-sonnet-4-5-20260115'), 200000);
});

test('contextLimitFor promotes the window when observation contradicts the assumption', () => {
  // Second line of defense for models not in the table: context cannot exceed
  // its own window, so 600k tokens proves the window is not 200k.
  assert.equal(contextLimitFor('claude-sonnet-4-5', 600000), 1000000);
  assert.equal(contextLimitFor('unknown-local-model', 600000), 1000000);
});

test('contextLimitFor does not promote while we stay within the window', () => {
  assert.equal(contextLimitFor('claude-haiku-4-5', 199999), 200000);
  assert.equal(contextLimitFor('claude-haiku-4-5', 200000), 200000);
});

test('contextLimitFor stops at the largest known tier', () => {
  // We don't know of a window bigger than 1M - better to show 100% than to make up a threshold.
  assert.equal(contextLimitFor('anything', 5000000), 1000000);
});

// ---- modelLabel -------------------------------------------------------------

test('modelLabel shortens a model id to family and version', () => {
  assert.equal(modelLabel('claude-opus-5'), 'Opus 5');
  assert.equal(modelLabel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5'), 'Fable 5');
});

test('modelLabel handles the old ordering (version before family)', () => {
  assert.equal(modelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
});

test('modelLabel appends the 1M marker', () => {
  assert.equal(modelLabel('claude-sonnet-4-5-1m'), 'Sonnet 4.5 1M');
});

test('modelLabel returns an unknown id UNCHANGED (local LM Studio models)', () => {
  // Better to show the raw name than to guess at a family we don't know.
  assert.equal(modelLabel('qwen2.5-coder-32b-instruct'), 'qwen2.5-coder-32b-instruct');
  assert.equal(modelLabel('gpt-4o'), 'gpt-4o');
});

test('modelLabel returns an empty string for a missing model', () => {
  assert.equal(modelLabel(''), '');
  assert.equal(modelLabel(null), '');
  assert.equal(modelLabel(undefined), '');
});
