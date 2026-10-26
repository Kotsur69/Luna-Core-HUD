// ============================================================================
// Luna's Work checkpoints + rollback (src/lunasworkCheckpoint.js), against a
// real temp git repo with a bare origin. Covers: the iteration tag is created
// and pushed, the revert range is exactly main's first-parent commits since
// the last good tag (merges and fix-up commits), origin's history only grows,
// the rolled-back work becomes a bug card with the evidence and the reverted
// commits, DECISIONS.md gets the rollback, a rejected push leaves origin as
// it was - and, over every git args list the module issued, that no force
// push or reset was ever run.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  tagName,
  rolledBackTagName,
  forbiddenGit,
  guardedGit,
  execGit,
  parseLog,
  revertArgs,
  regressedJourneys,
  journeysPassedBefore,
  rollbackEvidence,
  rollbackCard,
  createCheckpoints,
} = require('../src/lunasworkCheckpoint');
const { REPRO_ACCEPTANCE } = require('../src/lunasworkCritic');

const RUN = 'lwrun1';
// Every args list the module sent to git, across all tests in this file.
const issued = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A bare origin and a clone on `main`, with one pushed commit. */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cp-'));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the OS temp cleanup gets it later.
    }
  });
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, repo);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Luna Test');
  git(repo, 'config', 'user.email', 'luna@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  return { root, origin, repo };
}

/** God Mode's way onto main: a package branch merged with --no-ff, pushed. */
function mergePackage(repo, name) {
  git(repo, 'checkout', '-b', `pkg-${name}`);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', `feat: ${name}`);
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', '-m', `Merge package ${name}`, `pkg-${name}`);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
}

/** A fix-up worker's plain commit straight on main, pushed. */
function fixupCommit(repo, text) {
  fs.appendFileSync(path.join(repo, 'app.txt'), `${text}\n`);
  git(repo, 'commit', '-am', `fix: ${text}`);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
}

const originMain = (origin) => git(origin, 'rev-parse', 'refs/heads/main');

/** The real runner, recording every args list. `override` may answer a call instead. */
function recorder(override) {
  return async (cwd, args) => {
    issued.push([...args]);
    const answer = override ? override(args) : null;
    return answer || execGit(cwd, args);
  };
}

function memoryStore() {
  const store = {
    list: [],
    read: () => store.list,
    write: (list) => {
      store.list = list;
      return true;
    },
  };
  return store;
}

// ---- names, guard, pure helpers -------------------------------------------------------

test('tag names: luna-work/<run>/iter-N; ids git cannot take give null', () => {
  assert.equal(tagName(RUN, 3), 'luna-work/lwrun1/iter-3');
  assert.equal(rolledBackTagName(RUN, 3), 'luna-work/lwrun1/iter-3-rolled-back');
  for (const bad of ['', 'a..b', 'x.lock', '.hidden', 'has space', 'a/b', null]) assert.equal(tagName(bad, 1), null, String(bad));
  assert.equal(tagName(RUN, 0), null);
  assert.equal(tagName(RUN, 1.5), null);
});

test('forbiddenGit refuses every force push, reset and ref rewrite; normal calls pass', () => {
  const refused = [
    ['reset', '--hard', 'HEAD~1'],
    ['reset', '--soft', 'abc'],
    ['update-ref', 'refs/heads/main', 'abc'],
    ['push', '--force', 'origin', 'main'],
    ['push', '-f', 'origin', 'main'],
    ['push', '-uf', 'origin', 'main'],
    ['push', '--force-with-lease', 'origin', 'main'],
    ['push', 'origin', '+HEAD:refs/heads/main'],
    ['push', 'origin', ':refs/heads/main'],
    ['push', '--delete', 'origin', 'main'],
    ['push', '--mirror', 'origin'],
    ['tag', '-f', 'luna-work/x/iter-1', 'abc'],
    ['tag', '-d', 'luna-work/x/iter-1'],
    ['checkout', '-B', 'main'],
    ['branch', '-f', 'main', 'abc'],
  ];
  for (const args of refused) assert.ok(forbiddenGit(args), args.join(' '));
  const allowed = [
    ['push', 'origin', 'HEAD:refs/heads/main'],
    ['push', 'origin', 'refs/tags/luna-work/x/iter-1'],
    ['revert', '--no-edit', '-m', '1', 'abc'],
    ['revert', '--abort'],
    ['tag', 'luna-work/x/iter-1', 'abc'],
    ['fetch', 'origin', 'refs/tags/a:refs/tags/a'],
  ];
  for (const args of allowed) assert.equal(forbiddenGit(args), null, args.join(' '));
});

test('guardedGit never hands a forbidden args list to the runner', async () => {
  const seen = [];
  const run = guardedGit(async (cwd, args) => {
    seen.push(args);
    return { ok: true, out: '', err: '' };
  });
  const res = await run('.', ['push', '--force', 'origin', 'main']);
  assert.equal(res.ok, false);
  assert.match(res.err, /refused/);
  assert.equal(seen.length, 0);
  assert.equal((await run('.', ['status'])).ok, true);
});

test('parseLog + revertArgs: one revert sequence, -m 1 only when merges are in it', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const commits = parseLog(`${a}\tp1 p2\tMerge package x\n${b}\tp1\tfix: thing\nnot a line`);
  assert.deepEqual(commits, [
    { sha: a, merge: true, subject: 'Merge package x' },
    { sha: b, merge: false, subject: 'fix: thing' },
  ]);
  assert.deepEqual(revertArgs(commits), ['revert', '--no-edit', '-m', '1', a, b]);
  assert.deepEqual(revertArgs([commits[1]]), ['revert', '--no-edit', b]);
});

test('a core journey counts as broken only when it passed in the last good iteration', () => {
  const now = [
    { name: 'login', passed: false },
    { name: 'export', passed: false },
  ];
  assert.deepEqual(regressedJourneys(now, ['login']), ['login']);
  assert.deepEqual(regressedJourneys(now, []), []);
  assert.equal(regressedJourneys(now, null), null);
  const laps = [
    { n: 1, selfCheck: 'green', journeysPassed: ['login'] },
    { n: 2, selfCheck: 'green', rolledBack: true, journeysPassed: [] },
    { n: 3, selfCheck: 'red', journeysPassed: [] },
  ];
  assert.deepEqual(journeysPassedBefore(laps, 3), ['login'], 'rolled-back and red laps are skipped');
  assert.deepEqual(journeysPassedBefore([], 0), [], 'first iteration: nothing passed before');
  assert.equal(journeysPassedBefore([], 2), null, 'earlier iterations without laps: unknown');
});

test('rollbackEvidence + rollbackCard: the regressed journeys, the findings, the commits', () => {
  const evidence = rollbackEvidence({
    decision: { toIteration: 1 },
    history: [{ n: 1, score: 70, milestone: 'core' }, { n: 2, score: 40, milestone: 'core' }],
    report: {
      journeys: [{ name: 'login', passed: false }, { name: 'never worked', passed: false }],
      findings: [{ severity: 'low', title: 'tiny' }, { severity: 'high', title: 'Save lost' }],
    },
    regressed: ['login'],
    evidenceDir: 'C:/runs/iter-2',
    cards: ['Add save'],
  });
  assert.deepEqual(evidence.failedJourneys.map((j) => j.name), ['login']);
  assert.deepEqual(evidence.findings.map((f) => f.title), ['Save lost']);
  assert.equal(evidence.scoreBefore, 70);
  const card = rollbackCard({ iteration: 2, fromTag: 'f', toTag: 't', reason: 'scoreDrop', evidence, reverted: [{ sha: 'c'.repeat(40), subject: 'Merge x' }] });
  assert.equal(card.kind, 'bug');
  assert.equal(card.severity, 'high');
  assert.match(card.text, /fell from 70 to 40/);
  assert.match(card.details, /ccccccc Merge x/);
  assert.match(card.details, /Add save/);
  assert.ok(card.acceptance.includes(REPRO_ACCEPTANCE));
});

// ---- against a real repo ---------------------------------------------------------------

test('tagIteration tags origin main and pushes the tag', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'one');
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  const res = await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.tag, 'luna-work/lwrun1/iter-1');
  assert.equal(git(origin, 'rev-parse', 'refs/tags/luna-work/lwrun1/iter-1^{commit}'), originMain(origin));
  // A second call (a restart) keeps the tag where it is.
  mergePackage(repo, 'two');
  const again = await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  assert.equal(again.ok, true);
  assert.notEqual(git(origin, 'rev-parse', 'refs/tags/luna-work/lwrun1/iter-1^{commit}'), originMain(origin));
});

test('rollback reverts exactly the first-parent range since the good tag, history only grows', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'good');
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  // Iteration 2: two packages merged and one fix-up commit, then the playtest broke.
  mergePackage(repo, 'alpha');
  mergePackage(repo, 'beta');
  fixupCommit(repo, 'self-check fix');
  const broken = originMain(origin);
  const expected = git(repo, 'rev-list', '--first-parent', `${good}..${broken}`).split('\n');
  assert.equal(expected.length, 3);

  const store = memoryStore();
  const evidenceDir = path.join(root, 'evidence', 'iter-2');
  const res = await cp.rollback({
    repoPath: repo,
    runId: RUN,
    iteration: 2,
    toIteration: 1,
    reason: 'coreJourneyBroken',
    evidence: {
      failedJourneys: [{ name: 'Checkout', passed: false, evidence: { screenshot: 'shots/checkout.png', steps: ['open cart', 'pay'] } }],
      findings: [{ severity: 'blocker', title: 'Pay button does nothing' }],
      evidenceDir,
      cards: ['Add the cart'],
    },
    todoStore: store,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.fromTag, 'luna-work/lwrun1/iter-2-rolled-back');
  assert.equal(res.toTag, 'luna-work/lwrun1/iter-1');
  assert.deepEqual(res.reverted.map((c) => c.sha), expected, 'newest first, merges and the fix-up');

  const after = originMain(origin);
  assert.notEqual(after, broken);
  assert.doesNotThrow(() => git(origin, 'merge-base', '--is-ancestor', broken, after), 'origin history was not rewritten');
  assert.equal(git(origin, 'diff', '--stat', good, after), '', 'main is back at the good tree');
  const subjects = git(origin, 'log', '--format=%s', `${broken}..${after}`).split('\n');
  assert.equal(subjects.length, 3);
  assert.ok(subjects.every((s) => s.startsWith('Revert')), subjects.join(' | '));
  assert.equal(git(origin, 'rev-parse', `refs/tags/${res.fromTag}^{commit}`), broken, 'the reverted work stays on a tag');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');

  // The rolled-back work is a bug card with the evidence and the commit list.
  assert.equal(res.cards.length, 1);
  assert.equal(store.list.length, 1);
  const card = store.list[0];
  assert.ok(card.tags.includes('run:lwrun1'));
  assert.ok(card.tags.includes('kind:bug'));
  assert.ok(card.tags.includes('sev:blocker'));
  assert.match(card.text, /Checkout/);
  for (const needle of ['shots/checkout.png', 'Pay button does nothing', evidenceDir, 'Add the cart', ...expected.map((s) => s.slice(0, 7))]) {
    assert.ok(card.details.includes(needle), `card details name ${needle}`);
  }
  assert.ok(card.acceptance.includes(REPRO_ACCEPTANCE));

  // ... and the rollback is in DECISIONS.md.
  assert.equal(res.decision, true);
  const decisions = fs.readFileSync(path.join(repo, 'design', 'DECISIONS.md'), 'utf8');
  assert.match(decisions, /roll main back from luna-work\/lwrun1\/iter-2-rolled-back to luna-work\/lwrun1\/iter-1 with 3 revert commit/);

  // A second call (a restart after the push) reverts nothing more.
  const again = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'coreJourneyBroken', todoStore: store });
  assert.equal(again.ok, true);
  assert.equal(again.nothing, true);
  assert.equal(originMain(origin), after);
  assert.equal(store.list.length, 1);
});

test('a rejected push leaves origin as it was and makes no card', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'good');
  const plain = createCheckpoints({ git: recorder(), tmpDir: () => root });
  await plain.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  mergePackage(repo, 'bad');
  const broken = originMain(origin);
  const rejecting = recorder((args) => (args[0] === 'push' && args.includes('HEAD:refs/heads/main') ? { ok: false, out: '', err: 'rejected (fetch first)' } : null));
  const cp = createCheckpoints({ git: rejecting, tmpDir: () => root });
  const store = memoryStore();
  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop', todoStore: store });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pushFailed');
  assert.equal(originMain(origin), broken);
  assert.equal(store.list.length, 0);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.equal(fs.existsSync(path.join(repo, 'design', 'DECISIONS.md')), false);
  assert.equal(git(origin, 'tag', '--list', 'luna-work/lwrun1/iter-2-rolled-back'), '', 'no rolled-back tag for a rollback that did not happen');
});

test('no good tag: nothing is reverted', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'x');
  const before = originMain(origin);
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'noGoodTag');
  assert.equal(originMain(origin), before);
});

// ---- the never-rule ---------------------------------------------------------------------

test('no force push or reset was ever issued (every git args list above)', () => {
  assert.ok(issued.length > 20, `the tests above ran git (${issued.length} calls)`);
  for (const args of issued) {
    assert.equal(forbiddenGit(args), null, args.join(' '));
    assert.ok(!args.includes('reset'), args.join(' '));
    assert.ok(!args.some((a) => a.startsWith('--force') || a === '-f'), args.join(' '));
    if (args[0] === 'push') assert.ok(!args.some((a) => a.startsWith('+') || a.startsWith(':')), args.join(' '));
  }
  assert.ok(issued.some((a) => a[0] === 'revert'), 'a revert ran');
  assert.ok(issued.some((a) => a[0] === 'push' && a.includes('refs/tags/luna-work/lwrun1/iter-1')), 'a tag was pushed');
});

test("no Luna's Work source builds a reset or force-push git call", () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(dir).filter((f) => /^lunaswork.*\.js$/.test(f));
  assert.ok(files.length > 5);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/\[\s*'reset'/.test(text), `${f}: a git reset args list`);
    for (const line of text.split('\n')) {
      if (/'push'/.test(line)) assert.ok(!/'--force|'-f'|'\+/.test(line), `${f}: ${line.trim()}`);
    }
  }
});
