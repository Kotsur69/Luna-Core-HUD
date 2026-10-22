// God Mode runs snapshot (src/godmodesnapshot.js): the run entry a PC builds
// at the end of a run, the capped history, and what a reader accepts.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEntry, addRun, addSeen, parseGodmodePeer, runsFrom, prUrlOf } = require('../src/godmodesnapshot');

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
    merged: 0,
    skipped: 0,
    blocked: 0,
    manualActions: 0,
    selfCheck: 'none',
    needs: [],
    manual: [],
  });
  assert.ok(!/Users|mati|wt/.test(JSON.stringify(run)));
  assert.equal(runEntry(null), null);
});

test('runEntry counts merged, skipped, blocked, manual actions and the self-check state', () => {
  const v = view({
    integrationMode: 'merge',
    integration: {
      state: 'done',
      skipped: [{ id: 'b', stage: 'conflict' }, { id: 'c', stage: 'depSkipped' }],
      manualActions: [{ kind: 'migration', what: 'x.sql' }, { kind: 'env', what: 'KEY' }, { kind: 'note', what: 'n' }],
      selfCheck: { tests: 'ok', syntax: 'failed', smoke: 'skipped', fixups: 1 },
    },
    packages: [
      { id: 'a', title: 'A', state: 'pushed', merged: true },
      { id: 'b', title: 'B', state: 'pushed', merged: false },
      { id: 'd', title: 'D', state: 'pending', blockedBy: 'x' },
      { id: 'e', title: 'E', state: 'pending', blockedBy: null },
    ],
  });
  const run = runEntry(v, { now: NOW });
  assert.deepEqual(
    [run.merged, run.skipped, run.blocked, run.manualActions, run.selfCheck],
    [1, 2, 1, 3, 'failed'],
  );
  const green = runEntry(view({ integration: { state: 'done', selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped' } } }), { now: NOW });
  assert.equal(green.selfCheck, 'ok');
});

test('a reader caps the new counts and still reads rows written before them', () => {
  const old = { id: 'old', finishedAt: NOW - HOUR, total: 2, pushed: 1, packages: [] };
  const hostile = { id: 'new', finishedAt: NOW, total: 2, packages: [], merged: 1e9, skipped: -3, blocked: 'x', manualActions: 1e9, selfCheck: '<b>' };
  const p = parseGodmodePeer({ machine: 'PC1', data: data([old, hostile]) }, NOW);
  const byId = Object.fromEntries(p.runs.map((r) => [r.id, r]));
  assert.deepEqual(
    [byId.old.merged, byId.old.skipped, byId.old.blocked, byId.old.manualActions, byId.old.selfCheck, byId.old.pushed],
    [0, 0, 0, 0, 'none', 1],
  );
  assert.equal(byId.new.merged, 2, 'merged never above total');
  assert.equal(byId.new.skipped, 0);
  assert.equal(byId.new.blocked, 0);
  assert.equal(byId.new.manualActions, 1000);
  assert.equal(byId.new.selfCheck, 'none');
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

const REPORT = [
  '# God Mode run',
  '',
  '## Needs you',
  '',
  '- `b` Do B: stalled - verifyFailed',
  'Self-check red: tests.',
  '    1 failing',
  '',
  '## Manual actions',
  '',
  '- x.sql',
].join('\n');

test('runEntry takes needs from the report and manual actions from the integration', () => {
  const v = view({ integration: { state: 'done', manualActions: [{ kind: 'migration', what: 'x.sql' }, { kind: 'env', what: 'KEY' }, null, { kind: 'note' }] } });
  const run = runEntry(v, { now: NOW, report: REPORT });
  assert.deepEqual(run.needs, ['- b Do B: stalled - verifyFailed', 'Self-check red: tests.', '1 failing']);
  assert.deepEqual(run.manual, ['migration: x.sql', 'env: KEY']);
  const none = runEntry(view(), { now: NOW, report: '## Needs you\n\nNothing - all done\n' });
  assert.deepEqual(none.needs, []);
  assert.deepEqual(runEntry(view(), { now: NOW }).needs, [], 'no report, no needs');
});

test('needs and manual are capped at 20 lines of 300 chars, control chars stripped', () => {
  const long = ['## Needs you', ...Array.from({ length: 40 }, (_, i) => `- need ${i} ${'x'.repeat(500)}`)].join('\n');
  const run = runEntry(view(), { now: NOW, report: long });
  assert.equal(run.needs.length, 20);
  assert.ok(run.needs.every((l) => l.length <= 300));
  const p = parseGodmodePeer(
    { machine: 'PC1', data: data([{ id: 'r', finishedAt: NOW, packages: [], needs: [...Array(30).fill('a\u001b[31mb'), 5, null], manual: 'x' }]) },
    NOW,
  );
  assert.equal(p.runs[0].needs.length, 20);
  assert.equal(p.runs[0].needs[0], 'a [31mb');
  assert.deepEqual(p.runs[0].manual, []);
});

test('old rows without needs, manual or seen still read', () => {
  const p = parseGodmodePeer({ machine: 'PC1', data: data([{ id: 'old', finishedAt: NOW, packages: [] }]) }, NOW);
  assert.deepEqual([p.runs[0].needs, p.runs[0].manual, p.seen], [[], [], []]);
});

test('addSeen keeps runs, puts the id in front once, caps at 50, drops malformed ids', () => {
  let snap = addRun(null, runEntry(view({ id: 'run1' }), { now: NOW }), { machine: 'PC1', now: NOW });
  for (let i = 0; i < 60; i += 1) snap = addSeen(snap, `s${i}`, { machine: 'PC1', now: NOW });
  assert.equal(snap.seen.length, 50);
  assert.equal(snap.seen[0], 's59');
  assert.equal(snap.runs[0].id, 'run1');
  snap = addSeen(snap, 's10', { machine: 'PC1', now: NOW });
  assert.equal(snap.seen[0], 's10');
  assert.equal(snap.seen.filter((s) => s === 's10').length, 1);
  const same = addSeen(snap, 'BAD ID<', { machine: 'PC1', now: NOW });
  assert.deepEqual(same.seen, snap.seen);
  const fresh = addSeen(null, 'abc', { machine: 'PC1', now: NOW });
  assert.deepEqual([fresh.runs, fresh.seen], [[], ['abc']]);
});

test('addRun keeps the seen list; a reader validates and caps it', () => {
  const snap = addRun(addSeen(null, 'abc', { machine: 'PC1', now: NOW }), runEntry(view({ id: 'x1' }), { now: NOW }), { machine: 'PC1', now: NOW });
  assert.deepEqual(snap.seen, ['abc']);
  const p = parseGodmodePeer({ machine: 'PC1', data: data([], { seen: ['ok1', 'ok1', 'NO', 7, '../x', ...Array.from({ length: 80 }, (_, i) => `z${i}`)] }) }, NOW);
  assert.equal(p.seen.length, 50);
  assert.deepEqual(p.seen.slice(0, 2), ['ok1', 'z0']);
  assert.deepEqual(parseGodmodePeer({ machine: 'PC1', data: data([], { seen: 'abc' }) }, NOW).seen, []);
});
