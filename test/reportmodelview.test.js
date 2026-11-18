// ============================================================================
// LunaCore - report models in the renderer (renderer/modules/reportmodelview.js)
// ----------------------------------------------------------------------------
// Pins what the Week tab, the brief card and Settings show of a stored
// {provider, model}: the model name, '$0' as the cost on agy, the failed
// provider's name, and picker options from main's choices.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reportModelText, isAgyReport, reportCost, reportFailure, choiceOptions } = require('../src/renderer/modules/reportmodelview.js');

const HYDRO = { provider: 'agy', model: 'gemini-4-hydrogen-low' };
const fmt = (usd) => (typeof usd === 'number' ? `$${usd.toFixed(2)}` : '');

test('reportModelText names the model, old plain strings included', () => {
  assert.equal(reportModelText({ provider: 'claude', model: 'haiku' }), 'Haiku');
  assert.equal(reportModelText(HYDRO), 'Antigravity (agy) - gemini-4-hydrogen-low');
  assert.equal(reportModelText({ provider: 'agy', model: null }), 'Antigravity (agy)');
  assert.equal(reportModelText('sonnet'), 'Sonnet');
  assert.equal(reportModelText('agy'), 'Antigravity (agy)');
  assert.equal(reportModelText(null), 'Claude');
});

test('reportCost: $0 on agy, the formatted cost on Claude', () => {
  assert.equal(reportCost({ model: HYDRO, costUsd: null }, fmt), '$0');
  assert.equal(reportCost({ model: { provider: 'claude', model: 'opus' }, costUsd: 0.5 }, fmt), '$0.50');
  assert.equal(reportCost({ model: { provider: 'claude', model: 'opus' }, costUsd: null }, fmt), '');
  assert.equal(isAgyReport({ model: HYDRO }), true);
  assert.equal(isAgyReport(null), false);
});

test('reportFailure names the provider of a failed call; an unusable answer is not one', () => {
  assert.deepEqual(reportFailure({ model: HYDRO, failure: 'no-agy' }), { provider: 'Antigravity (agy)', reason: 'no-agy' });
  assert.deepEqual(reportFailure({ model: { provider: 'claude', model: 'haiku' }, failure: 'timeout' }), { provider: 'Claude', reason: 'timeout' });
  assert.equal(reportFailure({ model: HYDRO, failure: 'bad-json' }), null);
  assert.equal(reportFailure({ model: HYDRO, failure: null }), null);
});

test('choiceOptions keeps well-formed choices only', () => {
  assert.deepEqual(choiceOptions([{ id: 'haiku', name: 'Haiku' }, { id: 'agy:x1', name: '' }, { name: 'no id' }, null, 'opus']), [
    ['haiku', 'Haiku'],
    ['agy:x1', 'agy:x1'],
  ]);
  assert.deepEqual(choiceOptions(undefined), []);
});
