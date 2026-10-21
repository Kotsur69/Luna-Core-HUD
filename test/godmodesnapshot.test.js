// God Mode runs snapshot (src/godmodesnapshot.js): the run entry a PC builds
// at the end of a run, the capped history, and what a reader accepts.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEntry, addRun, parseGodmodePeer, runsFrom, prUrlOf } = require('../src/godmodesnapshot');

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;

const view = (over = {}) => ({
  id: 'abc123',
  repoPath: 'C:\\Users\\mati\\source\\repos\\Luna-Core-HUD',
  baseBranch: 'main',
  workerModel: 'opus',
  integrationMode: 'pr',
  integration: { state: 'done' },
  packages: [
    { id: 'a', title: 'Do A', state: 'pushed', branch: 'luna/a', headSha: 'abcdef0123', prUrl: 'https://github.com/o/r/pull/1', escalated: false, root: 'C:\\wt\\a' },
    { id: 'b', title: 'Do B', state: 'stalled', branch: 'luna/b', headSha: null, prUrl: null, error: 'verifyFailed', detail: '2 tests', escalated: true },
  ],
  ...over,
});

test('runEntry keeps the repo name only, packages and approval rules', () => {
  const run = runEntry(view(), { now: NOW, suggestions: [{ rule: 'Bash(npm test)', count: 2, ids: ['a'] }] });
  assert.deepEqual(run, {
    id: 'abc123',
    finishedAt: NOW,
    repoName: 'Luna-Core-HUD',
    baseBranch: 'main',
    workerModel: 'opus',
    integrationMode: 'pr',
    integrationState: 'done',
    pushed: 1,
    total: 2,
    packages: [
      { id: 'a', title: 'Do A', state: 'pushed', branch: 'luna/a', sha7: 'abcdef0', prUrl: 'https://github.com/o/r/pull/1', reason: '', escalated: false },
      { id: 'b', title: 'Do B', state: 'stalled', branch: 'luna/b', sha7: null, prUrl: null, reason: 'verifyFailed - 2 tests', escalated: true },
    ],
    approvalSuggestions: ['Bash(npm test)'],
  });
  assert.ok(!/Users|mati|wt/.test(JSON.stringify(run)));
  assert.equal(runEntry(null), null);
});

test('addRun puts the newest first, replaces a rerun, keeps 10', () => {
  let snap = null;
  for (let i = 0; i < 12; i += 1) snap = addRun(snap, runEntry(view({ id: `r${i}` }), { now: NOW + i }), { machine: 'PC1', now: NOW + i });
  assert.equal(snap.runs.length, 10);
  assert.equal(snap.runs[0].id, 'r11');
  assert.equal(snap.machine, 'PC1');
  const again = addRun(snap, runEntry(view({ id: 'r5' }), { now: NOW + 20 }), { machine: 'PC1', now: NOW + 20 });
  assert.equal(again.runs[0].id, 'r5');
  assert.equal(again.runs.filter((r) => r.id === 'r5').length, 1);
});

test('prUrlOf keeps github.com https links only', () => {
  assert.equal(prUrlOf('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(prUrlOf('http://github.com/o/r/pull/1'), null);
  assert.equal(prUrlOf('https://github.com.evil.io/x'), null);
  assert.equal(prUrlOf('javascript:alert(1)'), null);
  assert.equal(prUrlOf('https://github.com/o/r/pull/1 "x"'), null);
});

const data = (runs, over = {}) => ({ v: 1, at: NOW, machine: 'PC1', runs, ...over });

test('parseGodmodePeer rejects bad rows and never throws', () => {
  assert.equal(parseGodmodePeer(null, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'x y', data: data([]) }, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'PC1', data: data([], { v: 2 }) }, NOW), null);
  assert.equal(parseGodmodePeer({ machine: 'PC1', data: { v: 1, at: NOW } }, NOW), null);
  const hostile = { machine: 'PC1', data: data([]) };
  Object.defineProperty(hostile.data, 'runs', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(parseGodmodePeer(hostile, NOW), null);
});

test('parseGodmodePeer strips control chars, caps lists, drops non-github PR links', () => {
  const pkgs = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, title: 't\u001b[31m', state: 'pushed', prUrl: 'https://evil.example/pr', sha7: 'ZZZ', reason: 'r'.repeat(999), extra: 'x' }));
  const runs = Array.from({ length: 15 }, (_, i) => ({
    id: `r${i}`,
    finishedAt: NOW - i * HOUR,
    repoName: 'C:\\x\u0000',
    total: 99,
    pushed: 500,
    packages: pkgs,
    approvalSuggestions: Array(40).fill('Bash(x)'),
  }));
  const p = parseGodmodePeer({ machine: 'PC1', data: data([...runs, { id: '', finishedAt: NOW }, { id: 'nofinish' }]) }, NOW);
  assert.equal(p.runs.length, 10);
  const r = p.runs[0];
  assert.equal(r.packages.length, 50);
  assert.equal(r.approvalSuggestions.length, 20);
  assert.equal(r.pushed, 99, 'pushed never above total');
  assert.equal(r.repoName, 'C:\\x');
  const pkg = r.packages[0];
  assert.deepEqual(Object.keys(pkg).sort(), ['branch', 'escalated', 'id', 'prUrl', 'reason', 'sha7', 'state', 'title']);
  assert.equal(pkg.title, 't [31m');
  assert.equal(pkg.prUrl, null);
  assert.equal(pkg.sha7, null);
  assert.equal(pkg.reason.length, 300);
});

test('runsFrom merges machines newest first and tags each run', () => {
  const rows = [
    { machine: 'PC1', data: data([{ id: 'a', finishedAt: NOW - 2 * HOUR, packages: [] }]) },
    { machine: 'PC2', data: data([{ id: 'b', finishedAt: NOW - HOUR, packages: [] }]) },
    { machine: 'PC3', data: { v: 9 } },
  ];
  const out = runsFrom(rows, NOW);
  assert.deepEqual(out.map((r) => [r.id, r.machine]), [['b', 'PC2'], ['a', 'PC1']]);
});
