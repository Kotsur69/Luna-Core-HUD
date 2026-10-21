// Repo status snapshot (src/repossnapshot.js, REMOTE_HOST_PLAN U2): what a PC
// puts (never a path), what a reader accepts from another machine's row, and
// how rows of several PCs merge by repo.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reposSnapshot, parseReposPeer, mergeRepos, reposFrom } = require('../src/repossnapshot');

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;

const statusRow = (dir, over = {}) => ({
  path: dir,
  name: dir.split(/[\\/]/).pop(),
  error: '',
  status: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0, conflicts: 0, detached: false, ...over.status },
  lastCommit: { hash: 'abc1234', at: NOW - HOUR, subject: 'feat: thing', ...over.lastCommit },
  state: 'clean',
});

const keys = {
  'C:\\Users\\mati\\source\\repos\\LunaCore': { key: 'git:github.com/kotsur69/luna-core-hud', name: 'LunaCore' },
  'C:\\Users\\mati\\source\\repos\\scratch': { key: 'local:scratch', name: 'scratch' },
  'C:\\Users\\mati\\Downloads\\loose': { key: 'other', name: 'other' },
};
const keyOf = (dir) => keys[dir] || null;

test('reposSnapshot keeps git facts and keys, never a local path', () => {
  const rows = [
    statusRow('C:\\Users\\mati\\source\\repos\\LunaCore', { status: { ahead: 2, changed: 1 } }),
    statusRow('C:\\Users\\mati\\source\\repos\\scratch'),
    statusRow('C:\\Users\\mati\\Downloads\\loose'),
    { path: 'C:\\gone', name: 'gone', error: 'notARepo', status: null, lastCommit: null, state: 'unknown' },
  ];
  const snap = reposSnapshot(rows, { machine: 'KT-PC-LLM', keyOf, fetchedAtOf: () => NOW - 2 * HOUR, now: NOW });
  assert.equal(snap.v, 1);
  assert.equal(snap.machine, 'KT-PC-LLM');
  assert.deepEqual(
    snap.repos.map((r) => r.key),
    ['git:github.com/kotsur69/luna-core-hud', 'local:scratch'],
  );
  assert.deepEqual(snap.repos[0], {
    key: 'git:github.com/kotsur69/luna-core-hud',
    name: 'LunaCore',
    branch: 'main',
    dirty: true,
    ahead: 2,
    behind: 0,
    lastCommit: { sha: 'abc1234', subject: 'feat: thing', at: NOW - HOUR },
    fetchedAt: NOW - 2 * HOUR,
  });
  const json = JSON.stringify(snap);
  assert.ok(!/Users|mati|Downloads|C:/.test(json), json);
});

test('reposSnapshot keeps one entry per key (the first, most urgent clone)', () => {
  const twin = { 'C:\\a': { key: 'git:github.com/o/r', name: 'a' }, 'C:\\b': { key: 'git:github.com/o/r', name: 'b' } };
  const snap = reposSnapshot([statusRow('C:\\a', { status: { behind: 3 } }), statusRow('C:\\b')], { machine: 'pc', keyOf: (d) => twin[d], now: NOW });
  assert.equal(snap.repos.length, 1);
  assert.equal(snap.repos[0].behind, 3);
});

const good = (over = {}) => ({
  v: 1,
  at: NOW - 1000,
  machine: 'PC1',
  repos: [{ key: 'git:github.com/o/r', name: 'r', branch: 'main', dirty: false, ahead: 0, behind: 0, lastCommit: { sha: 'abc1234', subject: 's', at: NOW - HOUR }, fetchedAt: NOW - HOUR }],
  ...over,
});

test('parseReposPeer rejects bad rows and never throws', () => {
  assert.equal(parseReposPeer(null, NOW), null);
  assert.equal(parseReposPeer({ machine: 'bad name!', data: good() }, NOW), null);
  assert.equal(parseReposPeer({ machine: 'PC1', data: good({ v: 2 }) }, NOW), null);
  assert.equal(parseReposPeer({ machine: 'PC1', data: good({ at: 'yesterday' }) }, NOW), null);
  assert.equal(parseReposPeer({ machine: 'PC1', data: good({ repos: 'x' }) }, NOW), null);
  const hostile = { machine: 'PC1', data: good() };
  Object.defineProperty(hostile.data, 'repos', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(parseReposPeer(hostile, NOW), null);
});

test('parseReposPeer cleans each repo: clamps, caps, drops unknown fields and bad keys', () => {
  const p = parseReposPeer(
    {
      machine: 'PC1',
      data: good({
        at: NOW + 99 * HOUR,
        repos: [
          {
            key: 'git:github.com/o/r',
            name: 'r\u0007x',
            branch: 'b'.repeat(500),
            dirty: 'yes',
            ahead: -4,
            behind: 2.6,
            lastCommit: { sha: 'NOT A SHA', subject: 'x'.repeat(999), at: NOW + HOUR },
            fetchedAt: 'never',
            path: 'C:\\secret',
            extra: 1,
          },
          { key: 'C:\\Users\\mati\\repo' },
          { key: 'git:../../etc' },
          'junk',
        ],
      }),
    },
    NOW,
  );
  assert.equal(p.at, NOW, 'future clock clamped');
  assert.equal(p.repos.length, 1);
  const r = p.repos[0];
  assert.deepEqual(Object.keys(r).sort(), ['ahead', 'behind', 'branch', 'dirty', 'fetchedAt', 'key', 'lastCommit', 'name']);
  assert.equal(r.name, 'r x');
  assert.equal(r.branch.length, 120);
  assert.equal(r.dirty, false);
  assert.equal(r.ahead, 0);
  assert.equal(r.behind, 3);
  assert.deepEqual(r.lastCommit, { sha: null, subject: 'x'.repeat(200), at: NOW });
  assert.equal(r.fetchedAt, null);
});

const peer = (machine, repo, at = NOW - 1000) => ({
  machine,
  at,
  repos: [{ key: 'git:github.com/o/r', name: 'r', branch: 'main', dirty: false, ahead: 0, behind: 0, lastCommit: { sha: 'aaaaaaa', subject: 's', at: NOW }, fetchedAt: null, ...repo }],
});

test('mergeRepos groups PCs by key and flags needsPush, behind, dirty', () => {
  const [m] = mergeRepos([peer('PC2', { ahead: 1 }), peer('PC1', { behind: 2, dirty: true })]);
  assert.equal(m.key, 'git:github.com/o/r');
  assert.deepEqual(m.machines.map((x) => x.machine), ['PC1', 'PC2']);
  assert.equal(m.needsPush, true);
  assert.equal(m.behind, true);
  assert.equal(m.dirty, true);
  assert.equal(m.diverged, false, 'same branch and HEAD');
});

test('mergeRepos flags diverged on a different HEAD or branch across PCs', () => {
  assert.equal(mergeRepos([peer('PC1', {}), peer('PC2', { lastCommit: { sha: 'bbbbbbb', subject: 's', at: NOW } })])[0].diverged, true);
  assert.equal(mergeRepos([peer('PC1', {}), peer('PC2', { branch: 'dev' })])[0].diverged, true);
  assert.equal(mergeRepos([peer('PC1', {})])[0].diverged, false, 'one PC never diverges');
  assert.equal(mergeRepos([peer('PC1', {}), peer('PC2', { lastCommit: null })])[0].diverged, false, 'unknown HEAD is not a difference');
});

test('mergeRepos keeps the newer copy of one machine and puts flagged repos first', () => {
  const clean = { machine: 'PC9', at: NOW, repos: [{ ...peer('x', {}).repos[0], key: 'git:github.com/o/aaa', name: 'aaa' }] };
  const merged = mergeRepos([peer('pc1', { ahead: 5 }, NOW - HOUR), peer('PC1', { ahead: 0 }, NOW), clean, peer('PC3', { dirty: true })]);
  const r = merged.find((e) => e.key === 'git:github.com/o/r');
  assert.equal(r.machines.filter((m) => m.machine.toLowerCase() === 'pc1').length, 1);
  assert.equal(r.machines.find((m) => m.machine.toLowerCase() === 'pc1').ahead, 0);
  assert.equal(merged[0].key, 'git:github.com/o/r', 'dirty repo before the clean one');
});

test('reposFrom parses raw rows and skips bad ones', () => {
  const out = reposFrom([{ machine: 'PC1', data: good() }, { machine: 'PC2', data: { v: 9 } }, null], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].machines[0].machine, 'PC1');
});
