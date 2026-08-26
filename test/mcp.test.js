// Tests for the pure functions behind the MCP debugger's safe half
// (CONCEPT_MCP_DEBUGGER.md: live flow + JSON-RPC Inspector, no interception,
// no config writes). Zero DOM - formatPayload/createMcpState/applyMcpEvent/
// liveServers are pure; the widget's rendering and modal live behind the
// manual verification pass, same split sessiontimeline.test.js already uses.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatPayload,
  createMcpState,
  applyMcpEvent,
  liveServers,
} = require('../src/renderer/modules/mcp.js');

// ---- formatPayload -----------------------------------------------------------

test('formatPayload pretty-prints a plain object', () => {
  const { text, truncated } = formatPayload({ a: 1 });
  assert.equal(text, '{\n  "a": 1\n}');
  assert.equal(truncated, false);
});

test('formatPayload reparses a JSON-stringified string before pretty-printing it', () => {
  // This is the CLI's own transport shape for a tool_result's content -
  // verified against a real transcript line, 2026-08-26.
  const { text } = formatPayload('{"a":1}');
  assert.equal(text, '{\n  "a": 1\n}');
});

test('formatPayload leaves a non-JSON string as plain text', () => {
  const { text, truncated } = formatPayload('just some text');
  assert.equal(text, 'just some text');
  assert.equal(truncated, false);
});

test('formatPayload treats undefined as empty text, not "undefined"', () => {
  assert.deepEqual(formatPayload(undefined), { text: '', truncated: false });
});

test('formatPayload caps a long payload and flags it', () => {
  const { text, truncated } = formatPayload('abcdefghij', 4);
  assert.equal(text, 'abcd');
  assert.equal(truncated, true);
});

// ---- createMcpState / applyMcpEvent -------------------------------------------

test('createMcpState starts with no live calls and no history', () => {
  const state = createMcpState();
  assert.equal(state.live.size, 0);
  assert.deepEqual(state.calls, []);
});

test('applyMcpEvent on a start marks the call live and adds nothing to history yet', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'start', id: 't0', server: 'shadcn', tool: 'search_items', at: 1000 });
  assert.equal(state.live.get('t0'), 'shadcn');
  assert.deepEqual(state.calls, []);
});

test('applyMcpEvent on the matching end clears live and pushes a call record', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'start', id: 't0', server: 'shadcn', tool: 'search_items', at: 1000 });
  applyMcpEvent(state, {
    phase: 'end',
    id: 't0',
    server: 'shadcn',
    tool: 'search_items',
    input: { q: 'button' },
    at: 1200,
    ms: 200,
    ok: true,
    content: '{"n":3}',
  });
  assert.equal(state.live.size, 0);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], {
    id: 't0',
    server: 'shadcn',
    tool: 'search_items',
    at: 1200,
    ms: 200,
    ok: true,
    input: '{\n  "q": "button"\n}',
    inputTruncated: false,
    output: '{\n  "n": 3\n}',
    outputTruncated: false,
  });
});

test('applyMcpEvent on an end treats ok !== false as success (matches foldMcpEvents\' own default)', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'x', at: 1, ms: null, content: '' });
  assert.equal(state.calls[0].ok, true);
});

test('applyMcpEvent on a failed end records ok:false', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'x', at: 1, ok: false, content: 'boom' });
  assert.equal(state.calls[0].ok, false);
});

test('applyMcpEvent adds new calls to the FRONT of history (newest first)', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'a', at: 1 });
  applyMcpEvent(state, { phase: 'end', id: 't1', server: 's', tool: 'b', at: 2 });
  assert.deepEqual(
    state.calls.map((c) => c.tool),
    ['b', 'a']
  );
});

test('applyMcpEvent caps history at the given max, dropping the oldest call', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'a', at: 1 }, 2000, 2);
  applyMcpEvent(state, { phase: 'end', id: 't1', server: 's', tool: 'b', at: 2 }, 2000, 2);
  applyMcpEvent(state, { phase: 'end', id: 't2', server: 's', tool: 'c', at: 3 }, 2000, 2);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(
    state.calls.map((c) => c.tool),
    ['c', 'b']
  );
});

test('applyMcpEvent truncates a long payload using the given maxChars', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'a', at: 1, content: 'abcdefghij' }, 4);
  assert.equal(state.calls[0].output, 'abcd');
  assert.equal(state.calls[0].outputTruncated, true);
});

test('applyMcpEvent on a null/undefined event is a no-op', () => {
  const state = createMcpState();
  applyMcpEvent(state, null);
  applyMcpEvent(state, undefined);
  assert.equal(state.calls.length, 0);
  assert.equal(state.live.size, 0);
});

test('applyMcpEvent returns the same state it was given (mutated in place)', () => {
  const state = createMcpState();
  const out = applyMcpEvent(state, { phase: 'end', id: 't0', server: 's', tool: 'a', at: 1 });
  assert.equal(out, state);
});

// ---- liveServers ---------------------------------------------------------------

test('liveServers is empty on a fresh state', () => {
  assert.deepEqual(liveServers(createMcpState()), new Set());
});

test('liveServers reflects every server with an in-flight call', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'start', id: 't0', server: 'a', tool: 'x', at: 1 });
  applyMcpEvent(state, { phase: 'start', id: 't1', server: 'b', tool: 'y', at: 1 });
  assert.deepEqual(liveServers(state), new Set(['a', 'b']));
});

test('liveServers no longer lists a server once its only in-flight call ends', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'start', id: 't0', server: 'a', tool: 'x', at: 1 });
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 'a', tool: 'x', at: 2 });
  assert.deepEqual(liveServers(state), new Set());
});

test('liveServers keeps a server live while a SECOND concurrent call to it is still open', () => {
  const state = createMcpState();
  applyMcpEvent(state, { phase: 'start', id: 't0', server: 'a', tool: 'x', at: 1 });
  applyMcpEvent(state, { phase: 'start', id: 't1', server: 'a', tool: 'y', at: 1 });
  applyMcpEvent(state, { phase: 'end', id: 't0', server: 'a', tool: 'x', at: 2 });
  assert.deepEqual(liveServers(state), new Set(['a']));
});
