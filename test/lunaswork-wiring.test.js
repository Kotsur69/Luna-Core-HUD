// ============================================================================
// Luna's Work wiring (src/lunasworkWiring.js): syncCheckout fast-forwards the
// project checkout to what God Mode merged on origin (the merge is pushed from
// a separate integration worktree, so the checkout would stay stale). Real git
// in temp folders: an origin, the project checkout, and a second clone that
// stands in for God Mode's push.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { syncCheckout, createAwake } = require('../src/lunasworkWiring');

// The machine's own autocrlf must not rewrite the test files' line endings.
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function setupRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wiring-'));
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'checkout');
  const other = path.join(dir, 'other');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'core.autocrlf', 'false');
  git(checkout, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(checkout, 'app.js'), 'v1\n');
  fs.mkdirSync(path.join(checkout, 'design'));
  fs.writeFileSync(path.join(checkout, 'design', 'PLAYTEST_LOG.md'), '# log\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'first');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'clone', '-q', '-b', 'main', origin, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'core.autocrlf', 'false');
  /** God Mode's merge: a commit pushed to origin/main from elsewhere. */
  const pushFromElsewhere = (text) => {
    fs.writeFileSync(path.join(other, 'app.js'), text);
    git(other, 'commit', '-q', '-am', `merge ${text.trim()}`);
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { dir, checkout, pushFromElsewhere, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('syncCheckout fast-forwards the checkout to the merged origin branch', async () => {
  const r = setupRepos();
  try {
    const merged = r.pushFromElsewhere('v2\n');
    assert.notEqual(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.deepEqual(await syncCheckout(r.checkout), { ok: true });
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.equal(read(path.join(r.checkout, 'app.js')), 'v2\n');
  } finally {
    r.done();
  }
});

test("syncCheckout keeps the Critic's uncommitted design/ edits that the merge does not touch", async () => {
  const r = setupRepos();
  try {
    fs.writeFileSync(path.join(r.checkout, 'design', 'PLAYTEST_LOG.md'), '# log\n\n## Iteration 1\n');
    const merged = r.pushFromElsewhere('v2\n');
    assert.deepEqual(await syncCheckout(r.checkout), { ok: true });
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), merged);
    assert.match(read(path.join(r.checkout, 'design', 'PLAYTEST_LOG.md')), /Iteration 1/);
  } finally {
    r.done();
  }
});

test('syncCheckout never merges over local work: a diverged checkout is reported, left as it was', async () => {
  const r = setupRepos();
  try {
    fs.writeFileSync(path.join(r.checkout, 'local.txt'), 'mine\n');
    git(r.checkout, 'add', 'local.txt');
    git(r.checkout, 'commit', '-q', '-m', 'local work');
    const before = git(r.checkout, 'rev-parse', 'HEAD');
    r.pushFromElsewhere('v2\n');
    const res = await syncCheckout(r.checkout);
    assert.equal(res.ok, false);
    assert.match(res.detail, /no fast-forward/);
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), before);
  } finally {
    r.done();
  }
});

test('syncCheckout refuses a detached HEAD and a folder that is not a repo', async () => {
  const r = setupRepos();
  try {
    git(r.checkout, 'checkout', '-q', '--detach');
    assert.deepEqual(await syncCheckout(r.checkout), { ok: false, detail: 'not on a branch' });
    const plain = path.join(r.dir, 'plain');
    fs.mkdirSync(plain);
    assert.equal((await syncCheckout(plain)).ok, false);
  } finally {
    r.done();
  }
});

test('createAwake holds one power-save blocker for the run and releases it once', () => {
  const calls = [];
  let started = false;
  const blocker = {
    start: (kind) => (calls.push(['start', kind]), (started = true), 7),
    isStarted: () => started,
    stop: (id) => (calls.push(['stop', id]), (started = false)),
  };
  const awake = createAwake(blocker);
  awake.hold();
  awake.hold();
  awake.release();
  awake.release();
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
});

// ---- loop-hook deps (src/lunasworkHookDeps.js) ----------------------------------------

const { routesFromTestPlan, iterationDiff, createHookDeps } = require('../src/lunasworkHookDeps');

test('routesFromTestPlan: the root first, same-origin URLs and /paths, no other origin, no duplicates', () => {
  const md = [
    '### Quote',
    '1. Open /quote and fill the form (see `/quote/new`).',
    '2. Download http://localhost:3000/pdf?id=1, compare with https://example.com/other.',
    '3. Back to /quote.',
  ].join('\n');
  assert.deepEqual(routesFromTestPlan(md, 'http://localhost:3000/app'), [
    'http://localhost:3000/',
    'http://localhost:3000/pdf?id=1',
    'http://localhost:3000/quote',
    'http://localhost:3000/quote/new',
  ]);
  assert.deepEqual(routesFromTestPlan('', 'http://localhost:5173'), ['http://localhost:5173/']);
  assert.deepEqual(routesFromTestPlan('/a', 'not a url'), []);
  const many = Array.from({ length: 20 }, (_, i) => `/r${i}`).join(' ');
  assert.equal(routesFromTestPlan(many, 'http://localhost:3000').length, 8, 'capped');
});

test('iterationDiff: from the previous checkpoint tag when there is one, else the last commit', async () => {
  const r = setupRepos();
  try {
    git(r.checkout, 'tag', 'luna-work/lwtest1/iter-1');
    fs.writeFileSync(path.join(r.checkout, 'app.js'), 'v2\n');
    git(r.checkout, 'commit', '-q', '-am', 'second');
    fs.writeFileSync(path.join(r.checkout, 'app.js'), 'v3\n');
    git(r.checkout, 'commit', '-q', '-am', 'third');
    const fromTag = await iterationDiff(r.checkout, 'lwtest1', 2);
    assert.match(fromTag, /-v1\n\+v3/, 'iteration 2 = everything since the iter-1 tag');
    const lastCommit = await iterationDiff(r.checkout, 'lwtest1', 1);
    assert.match(lastCommit, /-v2\n\+v3/);
    // LW 2.23 commits the maps on top: the iteration diff looks past them.
    fs.mkdirSync(path.join(r.checkout, 'docs', 'CODEMAPS'), { recursive: true });
    fs.writeFileSync(path.join(r.checkout, 'docs', 'CODEMAPS', 'overview.md'), '# maps\n');
    git(r.checkout, 'add', '-A');
    git(r.checkout, 'commit', '-q', '-m', "docs(codemaps): refresh after Luna's Work iteration 1");
    const pastMaps = await iterationDiff(r.checkout, 'lwtest1', 1);
    assert.match(pastMaps, /-v2\n\+v3/);
    assert.ok(!pastMaps.includes('CODEMAPS'), 'the maps are left out');
    assert.ok(!(await iterationDiff(r.checkout, 'lwtest1', 2)).includes('CODEMAPS'));
    assert.equal(await iterationDiff(path.join(r.dir, 'nowhere'), 'lwtest1', 2), '');
  } finally {
    r.done();
  }
});

test('createHookDeps: the second opinion is off without a CLI order; no review due means no call', async () => {
  const off = createHookDeps({ env: () => process.env, settings: () => ({ secondOpinionOrder: [] }) });
  assert.equal(await off.secondOpinion({ isGate: true, repoPath: os.tmpdir(), runId: 'lwtest1', iteration: 1 }), null);
  const on = createHookDeps({ env: () => process.env, settings: () => ({ secondOpinionOrder: ['codex'] }) });
  const notGate = await on.secondOpinion({ isGate: false, repoPath: os.tmpdir(), runId: 'lwtest1', iteration: 1 });
  assert.deepEqual(notGate, { skipped: true, note: 'second opinion skipped: not a milestone gate' });
  const reviews = await on.reviews({ iteration: 1, isGate: false, runId: 'lwtest1', repoPath: os.tmpdir() });
  assert.deepEqual(reviews.due, []);
  assert.equal(await on.lighthouse({ projectId: 'p', repoPath: os.tmpdir(), url: 'not a url' }), null);
  for (const key of ['refreshGraph', 'i18n', 'lighthouse', 'reviews', 'secondOpinion']) assert.equal(typeof on[key], 'function', key);
});
