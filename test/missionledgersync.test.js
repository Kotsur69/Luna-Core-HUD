// ============================================================================
// LunaCore - Mission Control ledger sync tests (src/missionledgersync.js)
// ----------------------------------------------------------------------------
// Peer bodies (other PCs' cloud snapshots) are untrusted: every malformed
// shape must be dropped, not crash.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../src/missionledgersync.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = Date.parse('2026-10-09T10:00:00Z');
const row = (over = {}) => [H, 'git:github.com/me/app', 'app', 'claude-opus-5-5', 10, 20, 30, 40].map((v, i) => (i in over ? over[i] : v));
const block = (over = {}) => [H, H + HOUR, 'git:github.com/me/app', 'app'].map((v, i) => (i in over ? over[i] : v));
const body = (extra = {}) => ({ v: 1, machine: 'LAPTOP', updatedAt: NOW, rows: [], ...extra });

test('machineName keeps letters, digits and hyphens only', () => {
  assert.equal(sync.machineName('KT-PC-LLM'), 'KT-PC-LLM');
  // An unsafe hostname is normalised and tagged with a hash of the raw name.
  assert.match(sync.machineName('my pc/../evil'), /^my-pc----evil-h[0-9a-f]{6}$/);
  assert.equal(sync.machineName(''), 'pc');
  assert.equal(sync.machineName('x'.repeat(100)).length, 63);
});

test('parsePeer validates a snapshot body', () => {
  const good = { v: 1, machine: 'WORK', updatedAt: NOW, rows: [row()], blocks: [block()] };
  assert.deepEqual(sync.parsePeer(good, 'WORK', NOW), { machine: 'WORK', updatedAt: NOW, rows: [row()], blocks: [block()] });
  assert.equal(sync.parsePeer({ ...good, machine: 'OTHER' }, 'WORK', NOW), null);
  assert.equal(sync.parsePeer({ ...good, v: 2 }, 'WORK', NOW), null);
  assert.equal(sync.parsePeer({ ...good, rows: 'nope' }, 'WORK', NOW), null);
  assert.equal(sync.parsePeer(null, 'WORK', NOW), null);
  assert.equal(sync.parsePeer({ ...good, updatedAt: 'x' }, 'WORK', NOW).updatedAt, 0);
});

test('parsePeer drops malformed rows and keeps the good ones', () => {
  const rows = [
    row(),
    row({ 0: H + 5 }), // not on an hour boundary
    row({ 0: NOW - 40 * 24 * HOUR }), // older than history
    row({ 1: 'C:\\Users\\x' }), // not a project key
    row({ 2: 'a\u0000b' }), // control character in name
    row({ 3: 'claude opus' }), // bad model id
    row({ 4: -1 }),
    row({ 5: 1.5 }),
    row({ 6: 'many' }),
    [H, 'other', 'other', 'claude-opus-5-5', 1, 2, 3], // too short
    'not a row',
  ];
  assert.deepEqual(sync.parsePeer(body({ rows }), 'LAPTOP', NOW).rows, [row()]);
});

test('parsePeer caps distinct project keys per peer', () => {
  const rows = Array.from({ length: sync.MAX_PEER_KEYS + 50 }, (_, i) => row({ 1: `local:p${i}`, 2: `p${i}` }));
  const keys = new Set(sync.parsePeer(body({ rows }), 'LAPTOP', NOW).rows.map((r) => r[1]));
  assert.equal(keys.size, sync.MAX_PEER_KEYS);
});

// ---- Focus blocks [startMs, endMs, key, name] (W2) ----

test('a body from before focus blocks reads as no blocks', () => {
  assert.deepEqual(sync.parsePeer(body({ rows: [row()] }), 'LAPTOP', NOW).blocks, []);
});

test('parsePeer drops malformed focus blocks and keeps the good ones', () => {
  const blocks = [
    block(),
    block({ 1: H }), // empty
    block({ 1: H - HOUR }), // ends before it starts
    block({ 0: H + 0.5 }), // not an integer
    block({ 1: H + 3 * 24 * HOUR }), // longer than a block can be
    block({ 0: NOW - 30 * 24 * HOUR, 1: NOW - 30 * 24 * HOUR + HOUR }), // older than history
    block({ 0: NOW + 2 * 24 * HOUR, 1: NOW + 2 * 24 * HOUR + HOUR }), // future
    block({ 2: '../evil' }),
    block({ 3: 'bad\u0000name' }),
    [H, H + HOUR, 'git:github.com/me/app'],
    'junk',
  ];
  assert.deepEqual(sync.parsePeer(body({ blocks }), 'LAPTOP', NOW).blocks, [block()]);
});

test('focus blocks share the per-peer project-key cap with the rows', () => {
  const rows = Array.from({ length: sync.MAX_PEER_KEYS }, (_, i) => row({ 1: `local:p${i}`, 2: `p${i}` }));
  const blocks = [block({ 2: 'local:extra' }), block({ 2: 'local:p1' })];
  assert.deepEqual(sync.parsePeer(body({ rows, blocks }), 'LAPTOP', NOW).blocks.map((b) => b[2]), ['local:p1']);
});

test('validKey accepts the project-key shapes only', () => {
  assert.equal(sync.validKey('other'), true);
  assert.equal(sync.validKey('git:github.com/me/app'), true);
  assert.equal(sync.validKey('local:home'), true);
  assert.equal(sync.validKey('../evil'), false);
  assert.equal(sync.validKey(42), false);
});
