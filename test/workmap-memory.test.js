// ============================================================================
// Live map, Memory station: per-session memory tool counts in the model
// (src/renderer/modules/workmapmodel.js) and the view helpers that turn them,
// and the tab list's `memoryCard` flag, into the station's text
// (src/renderer/modules/workmap.js). Zero DOM.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MEMORY_CALLS, memoryCallOf, createState, createTabState, applyEvent } = require('../src/renderer/modules/workmapmodel.js');
const W = require('../src/renderer/modules/workmap.js');

const S = 'tab-1';
const mcp = (events, sessionId = S) => ({ channel: 'metrics:mcp', payload: { sessionId, events } });
const call = (id, tool, server = 'lunacore', phase = 'start') => ({ phase, id, server, tool, at: 1000 });
const fold = (events, state = createState()) => events.reduce((s, ev) => applyEvent(s, ev), state);

// ---- the model -------------------------------------------------------------------

test('memoryCallOf knows the four Luna Core Memory tools of the lunacore server only', () => {
  assert.deepEqual(MEMORY_CALLS, ['search', 'get', 'verify', 'propose']);
  assert.equal(memoryCallOf('lunacore', 'memory_search'), 'search');
  assert.equal(memoryCallOf('lunacore', 'memory_get'), 'get');
  assert.equal(memoryCallOf('lunacore', 'memory_verify'), 'verify');
  assert.equal(memoryCallOf('lunacore', 'memory_propose'), 'propose');
  assert.equal(memoryCallOf('lunacore', 'memory_other'), null);
  assert.equal(memoryCallOf('lunacore', 'luna_todo_add'), null);
  assert.equal(memoryCallOf('other', 'memory_search'), null);
  assert.equal(memoryCallOf('lunacore', 42), null);
});

test('a fresh tab has zero memory calls', () => {
  assert.deepEqual(createTabState().memoryCalls, { search: 0, get: 0, verify: 0, propose: 0 });
});

test('memory tool calls are counted per tool and per tab, once per start', () => {
  const state = fold([
    mcp([call('a', 'memory_search'), call('b', 'memory_search'), call('c', 'memory_get')]),
    mcp([call('a', 'memory_search')]), // re-delivered start: not counted again
    mcp([call('a', 'memory_search', 'lunacore', 'end'), call('d', 'memory_verify'), call('e', 'memory_propose')]),
    mcp([call('f', 'luna_todo_add'), call('g', 'memory_search', 'fetch')]),
    mcp([call('h', 'memory_get')], 'tab-2'),
  ]);

  const tab = state.tabs.get(S);
  assert.deepEqual(tab.memoryCalls, { search: 2, get: 1, verify: 1, propose: 1 });
  assert.equal(tab.stations.memory.total, 5);
  assert.deepEqual(state.tabs.get('tab-2').memoryCalls, { search: 0, get: 1, verify: 0, propose: 0 });
});

test('a finished call started after its end was seen is not counted again (ended ids)', () => {
  const once = fold([mcp([call('a', 'memory_get')]), mcp([call('a', 'memory_get', 'lunacore', 'end')])]);
  const again = applyEvent(once, mcp([call('a', 'memory_get')]));
  assert.equal(again, once);
  assert.equal(again.tabs.get(S).memoryCalls.get, 1);
});

test('memory counts survive a turn end and a tab reset, like totals', () => {
  let state = fold([mcp([call('a', 'memory_search')])]);
  state = applyEvent(state, { channel: 'metrics:turnend', payload: { sessionId: S, turn: { endedAt: 2000 } } });
  state = applyEvent(state, { channel: 'tab:reset', payload: { sessionId: S } });
  assert.equal(state.tabs.get(S).memoryCalls.search, 1);
});

test('counting a memory call never mutates the previous state', () => {
  const before = fold([mcp([call('a', 'memory_search')])]);
  const snapshot = JSON.stringify(before.tabs.get(S));
  applyEvent(before, mcp([call('b', 'memory_search')]));
  assert.equal(JSON.stringify(before.tabs.get(S)), snapshot);
});

// ---- the view helpers --------------------------------------------------------------

test('memoryCallParts lists the tools called at least once, in order', () => {
  assert.deepEqual(W.memoryCallParts({ search: 3, get: 0, verify: 1, propose: 0 }), [
    { kind: 'search', n: 3 },
    { kind: 'verify', n: 1 },
  ]);
  assert.deepEqual(W.memoryCallParts(createTabState().memoryCalls), []);
  assert.deepEqual(W.memoryCallParts(null), []);
  assert.deepEqual(W.memoryCallParts({ search: -1, get: 1.5, verify: 'x' }), []);
});

test('cardFlagsOf reads memoryCard as true / false / unknown from the tab list', () => {
  const flags = W.cardFlagsOf([
    { id: 's1', memoryCard: true },
    { id: 's2', memoryCard: false },
    { id: 's3', memoryCard: null },
    { id: 's4' },
    { id: 's5', memoryCard: 'yes' },
    { memoryCard: true },
    null,
  ]);
  assert.deepEqual([...flags], [['s1', true], ['s2', false], ['s3', null], ['s4', null], ['s5', null]]);
  assert.equal(W.cardFlagsOf('junk').size, 0);
});

test('applyCardFlags stores the card mark, keeps a memory count, and forgets closed tabs', () => {
  W.setMemoryStationInfo('c1', { memories: 4 });
  W.applyCardFlags([{ id: 'c1', memoryCard: true }, { id: 'c2', memoryCard: false }, { id: 'c3', memoryCard: null }]);

  assert.deepEqual(W.memoryStationInfo('c1'), { memories: 4, cardLoaded: true });
  assert.deepEqual(W.memoryStationInfo('c2'), { memories: null, cardLoaded: false });
  assert.equal(W.memoryStationInfo('c3'), null);

  W.applyCardFlags([{ id: 'c2', memoryCard: null }]);
  assert.equal(W.memoryStationInfo('c1'), null, 'a closed tab is forgotten');
  assert.equal(W.memoryStationInfo('c2'), null, 'an unknown flag clears the mark');
  W.applyCardFlags([]);
});
