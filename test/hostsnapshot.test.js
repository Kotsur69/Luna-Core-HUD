// ============================================================================
// LunaCore - the `host` snapshot (src/hostsnapshot.js)
// ----------------------------------------------------------------------------
// Writer output passes the reader; the reader keeps only known fields, caps
// lists, never takes a path and reads "online" from updated_at (< 90 s).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hostSnapshot, parseHostPeer, hostsFrom, isOnline, MAX_REPOS, MAX_NAMES } = require('../src/hostsnapshot.js');
const { KINDS } = require('../src/cloudsnapshots.js');

const NOW = 1_800_000_000_000;

const parts = {
  version: '0.16.2',
  os: 'darwin',
  isDefault: true,
  repos: [{ id: 'lunacore', key: 'git:github.com/kotsur69/luna-core-hud', name: 'Luna-Core-HUD', cloned: true, status: 'cloned', path: '/Users/m/x' }],
  skills: ['graphify', 'ecc:plan'],
  commands: ['review'],
  mcp: ['blender'],
  sessions: [],
};

test('host is a snapshot kind', () => {
  assert.ok(KINDS.has('host'));
});

test('hostSnapshot: the plan shape, no path', () => {
  const s = hostSnapshot(parts, NOW);
  assert.deepEqual(s, {
    v: 1,
    at: NOW,
    version: '0.16.2',
    os: 'darwin',
    default: true,
    repos: [{ id: 'lunacore', key: 'git:github.com/kotsur69/luna-core-hud', name: 'Luna-Core-HUD', cloned: true, status: 'cloned' }],
    skills: ['graphify', 'ecc:plan'],
    commands: ['review'],
    mcp: ['blender'],
    sessions: [],
  });
  assert.ok(!JSON.stringify(s).includes('/Users/m'));
});

test('hostSnapshot: every heartbeat differs (at bumps), so "skip unchanged" never holds one back', () => {
  assert.notEqual(JSON.stringify(hostSnapshot(parts, NOW)), JSON.stringify(hostSnapshot(parts, NOW + 30000)));
});

test('parseHostPeer: round trip, online from updated_at', () => {
  const data = hostSnapshot(parts, NOW - 10000);
  const p = parseHostPeer({ machine: 'MAC-1', data, updatedAt: NOW - 10000 }, NOW);
  assert.equal(p.machine, 'MAC-1');
  assert.equal(p.online, true);
  assert.equal(p.default, true);
  assert.deepEqual(p.repos, data.repos);
  const stale = parseHostPeer({ machine: 'MAC-1', data, updated_at: new Date(NOW - 91000).toISOString() }, NOW);
  assert.equal(stale.online, false);
  assert.equal(isOnline(NOW - 89999, NOW), true);
  assert.equal(isOnline(NOW - 90000, NOW), false);
});

test('parseHostPeer: a future clock never looks online forever', () => {
  const p = parseHostPeer({ machine: 'A', data: hostSnapshot(parts, NOW + 1e9), updatedAt: NOW + 1e9 }, NOW);
  assert.equal(p.at, NOW);
  assert.equal(p.updatedAt, NOW);
});

test('parseHostPeer: malformed rows read as null', () => {
  const data = hostSnapshot(parts, NOW);
  for (const row of [
    null,
    { machine: 'bad name', data, updatedAt: NOW },
    { machine: 'A', data: { ...data, v: 2 }, updatedAt: NOW },
    { machine: 'A', data: { ...data, at: 'x' }, updatedAt: NOW },
    { machine: 'A', data: [], updatedAt: NOW },
  ]) {
    assert.equal(parseHostPeer(row, NOW), null);
  }
});

test('parseHostPeer: hostile entries dropped, lists capped, strings cleaned', () => {
  const data = {
    v: 1,
    at: NOW,
    version: 'x\u0000y'.repeat(50),
    os: 'templeos',
    default: 'yes',
    repos: [
      { id: '../etc', key: 'git:github.com/a/b', name: 'x' },
      { id: 'ok', key: 'C:\\Users\\x', name: 'n\nm', cloned: 1, status: 'pwned' },
      { id: 'ok', key: null, name: 'dupe' },
      ...Array.from({ length: MAX_REPOS + 50 }, (_, i) => ({ id: `r${i}`, name: 'r' })),
    ],
    skills: ['good', '<img onerror=x>', 'good', ...Array.from({ length: MAX_NAMES + 10 }, (_, i) => `s${i}`)],
    commands: 'notalist',
    mcp: [{ name: 'obj' }],
    sessions: [{ id: 's1', repoId: '../x', status: 'evil' }, { nope: 1 }],
  };
  const p = parseHostPeer({ machine: 'A', data, updatedAt: NOW }, NOW);
  assert.ok(p.version.length <= 40 && !p.version.includes('\u0000'));
  assert.equal(p.os, 'linux');
  assert.equal(p.default, false);
  assert.deepEqual(p.repos[0], { id: 'ok', key: null, name: 'n m', cloned: false, status: null });
  assert.equal(p.repos.length, MAX_REPOS);
  assert.ok(!p.repos.some((r) => r.id === '../etc'));
  assert.equal(p.skills[0], 'good');
  assert.ok(!p.skills.includes('<img onerror=x>'));
  assert.equal(p.skills.length, MAX_NAMES);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.mcp, []);
  assert.deepEqual(p.sessions, [{ id: 's1', repoId: null, status: 'working' }]);
});

test('hostsFrom: one per machine (newest), online first', () => {
  const data = hostSnapshot(parts, NOW);
  const hosts = hostsFrom(
    [
      { machine: 'zeta', data, updatedAt: NOW - 1000 },
      { machine: 'alpha', data, updatedAt: NOW - 500000 },
      { machine: 'ZETA', data, updatedAt: NOW - 600000 },
      { machine: 'bad name', data, updatedAt: NOW },
    ],
    NOW,
  );
  assert.deepEqual(hosts.map((h) => [h.machine, h.online]), [['zeta', true], ['alpha', false]]);
});
