// ============================================================================
// LunaCore - Mission Control ledger sync tests (src/missionledgersync.js)
// ----------------------------------------------------------------------------
// A temp folder stands in for the synced one (Syncthing, a USB stick...).
// Peer files are untrusted: every malformed shape must be dropped, not crash.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('../src/missionledgersync.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = Date.parse('2026-10-09T10:00:00Z');
const row = (over = {}) => [H, 'git:github.com/me/app', 'app', 'claude-opus-5-5', 10, 20, 30, 40].map((v, i) => (i in over ? over[i] : v));

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sync-'));
const writePeer = (d, machine, body) =>
  fs.writeFileSync(path.join(d, `ledger-${machine}.json`), typeof body === 'string' ? body : JSON.stringify(body));

test('machineName keeps letters, digits and hyphens only', () => {
  assert.equal(sync.machineName('KT-PC-LLM'), 'KT-PC-LLM');
  assert.equal(sync.machineName('my pc/../evil'), 'my-pc----evil');
  assert.equal(sync.machineName(''), 'pc');
  assert.equal(sync.machineName('x'.repeat(100)).length, 63);
});

test('writeOwn writes ledger-<machine>.json atomically with the rows', () => {
  const d = dir();
  sync.writeOwn(d, 'KT-PC-LLM', [row()], NOW);
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'ledger-KT-PC-LLM.json'), 'utf8'));
  assert.deepEqual(saved, { v: 1, machine: 'KT-PC-LLM', updatedAt: NOW, rows: [row()] });
  assert.deepEqual(fs.readdirSync(d), ['ledger-KT-PC-LLM.json'], 'no temp file left behind');
});

test('writeOwn refuses a machine name that is not already sanitised', () => {
  assert.throws(() => sync.writeOwn(dir(), '../x', [], NOW));
});

test('readPeers returns other machines, skipping our own file', () => {
  const d = dir();
  sync.writeOwn(d, 'HOME', [row()], NOW);
  writePeer(d, 'LAPTOP', { v: 1, machine: 'LAPTOP', updatedAt: NOW - HOUR, rows: [row({ 4: 1 })] });
  const peers = sync.readPeers(d, 'HOME', NOW);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].machine, 'LAPTOP');
  assert.equal(peers[0].updatedAt, NOW - HOUR);
  assert.deepEqual(peers[0].rows, [row({ 4: 1 })]);
});

test('readPeers drops malformed rows and keeps the good ones', () => {
  const d = dir();
  writePeer(d, 'LAPTOP', {
    v: 1,
    machine: 'LAPTOP',
    updatedAt: NOW,
    rows: [
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
    ],
  });
  const [peer] = sync.readPeers(d, 'HOME', NOW);
  assert.deepEqual(peer.rows, [row()]);
});

test('readPeers ignores junk, wrong versions, mismatched names, symlinks and oversize files', () => {
  const d = dir();
  writePeer(d, 'BROKEN', '{not json');
  writePeer(d, 'OLDV', { v: 2, machine: 'OLDV', updatedAt: NOW, rows: [] });
  writePeer(d, 'LIAR', { v: 1, machine: 'SOMEONE-ELSE', updatedAt: NOW, rows: [] });
  writePeer(d, 'HUGE', 'x'.repeat(sync.MAX_FILE_BYTES + 1));
  fs.writeFileSync(path.join(d, 'notes.json'), '{}');
  fs.mkdirSync(path.join(d, 'ledger-DIR.json'));
  assert.deepEqual(sync.readPeers(d, 'HOME', NOW), []);
});

test('readPeers of a missing or empty folder is an empty list', () => {
  assert.deepEqual(sync.readPeers(path.join(os.tmpdir(), 'lc-sync-missing-xyz'), 'HOME', NOW), []);
  assert.deepEqual(sync.readPeers(null, 'HOME', NOW), []);
});

test('readPeers caps the number of peer files', () => {
  const d = dir();
  for (let i = 0; i < sync.MAX_PEERS + 3; i++) {
    writePeer(d, `PC${i}`, { v: 1, machine: `PC${i}`, updatedAt: NOW, rows: [row()] });
  }
  assert.equal(sync.readPeers(d, 'HOME', NOW).length, sync.MAX_PEERS);
});

test('writeOwn never writes through a planted symlink at a guessable temp name', () => {
  const d = dir();
  const victim = path.join(dir(), 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  try {
    fs.symlinkSync(victim, path.join(d, `ledger-HOME.json.${process.pid}.tmp`));
  } catch {
    return; // no symlink privilege on this Windows account - nothing to plant
  }
  sync.writeOwn(d, 'HOME', [row()], NOW);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'ledger-HOME.json'), 'utf8')).machine, 'HOME');
});

test('readPeers caps distinct project keys per peer', () => {
  const d = dir();
  const rows = Array.from({ length: sync.MAX_PEER_KEYS + 50 }, (_, i) => row({ 1: `local:p${i}`, 2: `p${i}` }));
  writePeer(d, 'LAPTOP', { v: 1, machine: 'LAPTOP', updatedAt: NOW, rows });
  const keys = new Set(sync.readPeers(d, 'HOME', NOW)[0].rows.map((r) => r[1]));
  assert.equal(keys.size, sync.MAX_PEER_KEYS);
});

test('readPeers skips our own file even when the case differs', () => {
  const d = dir();
  writePeer(d, 'home', { v: 1, machine: 'home', updatedAt: NOW, rows: [row()] });
  assert.deepEqual(sync.readPeers(d, 'HOME', NOW), []);
});
