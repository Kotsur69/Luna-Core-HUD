// Tests for the pure diagnostics core: turning three live readings into check
// rows, and rolling those rows up into one header verdict.
//
// The rule most of these defend: A CHECK THAT COULD NOT RUN IS 'unknown', NEVER
// 'fail'. Missing input, a malformed object, a status still starting up - all of
// them land on 'unknown', because a tile that cries "broken" about a working
// tool is worse than one that admits it does not know.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeSound,
  summarizeClaude,
  summarizeMcp,
  rollup,
} = require('../src/diagnostics.js');

// ---- summarizeSound -------------------------------------------------------

test('summarizeSound: ok reason is an ok row with no action', () => {
  const row = summarizeSound({ available: true, reason: 'ok' });
  assert.equal(row.id, 'sound');
  assert.equal(row.status, 'ok');
  assert.equal(row.detailKey, 'diag.sound.ok');
  assert.equal(row.action, undefined);
});

test('summarizeSound: not-found fails and points at the mpv docs', () => {
  const row = summarizeSound({ available: false, reason: 'not-found' });
  assert.equal(row.status, 'fail');
  assert.equal(row.detailKey, 'diag.sound.notFound');
  assert.deepEqual(row.action, { kind: 'docs', value: 'mpv' });
});

test('summarizeSound: spawn-failed fails with no action', () => {
  const row = summarizeSound({ available: false, reason: 'spawn-failed' });
  assert.equal(row.status, 'fail');
  assert.equal(row.detailKey, 'diag.sound.spawnFailed');
  assert.equal(row.action, undefined);
});

test('summarizeSound: ipc-failed fails with no action', () => {
  const row = summarizeSound({ available: false, reason: 'ipc-failed' });
  assert.equal(row.status, 'fail');
  assert.equal(row.detailKey, 'diag.sound.ipcFailed');
  assert.equal(row.action, undefined);
});

test('summarizeSound: starting is unknown, not a failure', () => {
  const row = summarizeSound({ available: false, reason: 'starting' });
  assert.equal(row.status, 'unknown');
  assert.equal(row.detailKey, 'diag.unknown');
});

test('summarizeSound: missing or malformed input is unknown', () => {
  assert.equal(summarizeSound().status, 'unknown');
  assert.equal(summarizeSound(null).status, 'unknown');
  assert.equal(summarizeSound({}).status, 'unknown');
  assert.equal(summarizeSound({ reason: 42 }).status, 'unknown');
  assert.equal(summarizeSound({ reason: 'nonsense' }).status, 'unknown');
});

// ---- summarizeClaude -----------------------------------------------------

test('summarizeClaude: found is an ok row', () => {
  const row = summarizeClaude({ found: true, path: '/usr/bin/claude' });
  assert.equal(row.id, 'claude');
  assert.equal(row.status, 'ok');
  assert.equal(row.detailKey, 'diag.claude.ok');
  assert.equal(row.action, undefined);
});

test('summarizeClaude: found === false fails and points at the claude docs', () => {
  const row = summarizeClaude({ found: false, path: null });
  assert.equal(row.status, 'fail');
  assert.equal(row.detailKey, 'diag.claude.missing');
  assert.deepEqual(row.action, { kind: 'docs', value: 'claude' });
});

test('summarizeClaude: missing or malformed input is unknown', () => {
  assert.equal(summarizeClaude().status, 'unknown');
  assert.equal(summarizeClaude(null).status, 'unknown');
  assert.equal(summarizeClaude({}).status, 'unknown');
  assert.equal(summarizeClaude({ found: 'yes' }).status, 'unknown');
});

// ---- summarizeMcp ------------------------------------------------------------

const server = (over = {}) => ({ enabled: true, lastUsed: null, ...over });

test('summarizeMcp: nothing idle is ok and reports the enabled total', () => {
  const row = summarizeMcp({
    servers: [server({ lastUsed: 1 }), server({ lastUsed: 2 }), server({ enabled: false })],
  });
  assert.equal(row.id, 'mcp');
  assert.equal(row.status, 'ok');
  assert.equal(row.detailKey, 'diag.mcp.ok');
  assert.deepEqual(row.detailParams, { total: 2 });
});

test('summarizeMcp: five or more never-used enabled servers warns', () => {
  const servers = Array.from({ length: 6 }, () => server());
  servers.push(server({ lastUsed: 10 }));
  const row = summarizeMcp({ servers });
  assert.equal(row.status, 'warn');
  assert.equal(row.detailKey, 'diag.mcp.idle');
  assert.deepEqual(row.detailParams, { never: 6, total: 7 });
  assert.deepEqual(row.action, { kind: 'focus', value: 'mcp' });
});

test('summarizeMcp: more than half idle warns even below the absolute floor', () => {
  const row = summarizeMcp({
    servers: [server(), server(), server({ lastUsed: 1 })], // 2 of 3 idle
  });
  assert.equal(row.status, 'warn');
  assert.deepEqual(row.detailParams, { never: 2, total: 3 });
});

test('summarizeMcp: a few idle below both thresholds stays ok', () => {
  const row = summarizeMcp({
    servers: [server(), server({ lastUsed: 1 }), server({ lastUsed: 2 }), server({ lastUsed: 3 })],
  }); // 1 of 4 idle
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.detailParams, { total: 4 });
});

test('summarizeMcp: exactly half idle is not "more than half" - stays ok', () => {
  const row = summarizeMcp({
    servers: [server(), server(), server({ lastUsed: 1 }), server({ lastUsed: 2 })],
  }); // 2 of 4 idle, ratio 0.5, not > 0.5
  assert.equal(row.status, 'ok');
});

test('summarizeMcp: disabled servers count toward neither total nor idle', () => {
  const row = summarizeMcp({
    servers: [server({ enabled: false }), server({ enabled: false }), server({ lastUsed: 1 })],
  });
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.detailParams, { total: 1 });
});

test('summarizeMcp: missing or malformed input is unknown', () => {
  assert.equal(summarizeMcp().status, 'unknown');
  assert.equal(summarizeMcp(null).status, 'unknown');
  assert.equal(summarizeMcp({}).status, 'unknown');
  assert.equal(summarizeMcp({ servers: 'nope' }).status, 'unknown');
});

// ---- rollup ---------------------------------------------------------------

test('rollup: all ok rows -> ok, zero issues', () => {
  assert.deepEqual(rollup([{ status: 'ok' }, { status: 'ok' }]), { status: 'ok', issues: 0 });
});

test('rollup: worst status wins, in fail > warn > unknown > ok order', () => {
  assert.equal(rollup([{ status: 'ok' }, { status: 'unknown' }]).status, 'unknown');
  assert.equal(rollup([{ status: 'unknown' }, { status: 'warn' }]).status, 'warn');
  assert.equal(rollup([{ status: 'warn' }, { status: 'fail' }]).status, 'fail');
  assert.equal(rollup([{ status: 'ok' }, { status: 'fail' }, { status: 'warn' }]).status, 'fail');
});

test('rollup: issues counts warn and fail rows only', () => {
  const r = rollup([{ status: 'ok' }, { status: 'unknown' }, { status: 'warn' }, { status: 'fail' }]);
  assert.equal(r.status, 'fail');
  assert.equal(r.issues, 2);
});

test('rollup: an unknown row does not count as an issue', () => {
  assert.deepEqual(rollup([{ status: 'ok' }, { status: 'unknown' }]), {
    status: 'unknown',
    issues: 0,
  });
});

test('rollup: empty or junk input is a clean ok', () => {
  assert.deepEqual(rollup([]), { status: 'ok', issues: 0 });
  assert.deepEqual(rollup(null), { status: 'ok', issues: 0 });
  assert.deepEqual(rollup([{}, { status: 'bogus' }]), { status: 'ok', issues: 0 });
});

test('rollup: consumes what the summarizers actually produce', () => {
  const rows = [
    summarizeSound({ reason: 'not-found' }),
    summarizeClaude({ found: true }),
    summarizeMcp({ servers: [{ enabled: true, lastUsed: 1 }] }),
  ];
  assert.deepEqual(rollup(rows), { status: 'fail', issues: 1 });
});
