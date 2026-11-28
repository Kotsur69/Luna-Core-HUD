// ============================================================================
// Luna's Work checkpoints + rollback (src/lunasworkCheckpoint.js), against a
// real temp git repo with a bare origin. Covers: the iteration tag is created
// and pushed, the revert range is exactly main's first-parent commits since
// the last good tag (merges and fix-up commits), origin's history only grows,
// the rolled-back work becomes a bug card with the evidence and the reverted
// commits, DECISIONS.md gets the rollback, a rejected push leaves origin as
// it was - and, over every git args list the module issued, that no force
// push or reset was ever run. Staging data (LW 3.29, src/lunasworkStaging.js)
// with a fake command runner: the backup runs before the migration, a failed
// backup blocks it, and a rollback restores the data with the code.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { removeDir, patientGit } = require('../test-support/under-load');

const {
  tagName,
  rolledBackTagName,
  forbiddenGit,
  guardedGit,
  parseLog,
  revertArgs,
  regressedJourneys,
  journeysPassedBefore,
  rollbackEvidence,
  rollbackCard,
  createCheckpoints,
  mergeSubject,
  PACK_COMMIT_PREFIX,
} = require('../src/lunasworkCheckpoint');
const { treeSubject, treeMessageArgs, commitGoodTree } = require('../src/lunasworkTreeRestore');
const { REPRO_ACCEPTANCE } = require('../src/lunasworkCritic');
const { commitDesignPack } = require('../src/lunasworkPackCommit');
const { createStaging, backupDirFor, MANIFEST_FILE } = require('../src/lunasworkStaging');
const { validateProfile } = require('../src/lunasworkSettings');

const RUN = 'lwrun1';
const STAGING_PROFILE = validateProfile({
  startCommand: 'npm start',
  stagingUrl: 'https://staging.example.test',
  stagingMigrateCommand: 'supabase db push --project-ref stagingrefabcdefghij',
  stagingDeployCommand: 'vercel deploy --yes',
  stagingBackupCommand: 'supabase db dump --data-only -f "%LUNA_BACKUP_DIR%/data.sql"',
  stagingRestoreCommand: 'psql -f "%LUNA_BACKUP_DIR%/data.sql"',
}).profile;
// Every args list the module sent to git, across all tests in this file.
const issued = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A bare origin and a clone on `main`, with one pushed commit. */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cp-'));
  t.after(async () => {
    try {
      await removeDir(root);
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

/** Writes `files` ({relPath: text}) into the checkout, creating folders. */
function writeFiles(repo, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
}

/** A God Mode package merge with its real merge subject, writing `files`, pushed. */
function mergeGodModePackage(repo, branch, files) {
  git(repo, 'checkout', '-b', branch);
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', `feat: ${branch}`);
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', '-m', mergeSubject(branch), branch);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
}

/** A plain commit straight on main writing `files`, pushed. */
function commitOnMain(repo, subject, files) {
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', subject);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
}

const originMain = (origin) => git(origin, 'rev-parse', 'refs/heads/main');

/**
 * execGit's {ok, out, err} shape (out trimmed) with test-support's patient cap:
 * under load one real git call has taken longer than execGit's 60 s, and a
 * timed-out tag read made a correct rollback answer `noGoodTag`.
 */
async function patientExecGit(cwd, args) {
  const res = await patientGit(cwd, args);
  return { ok: res.ok, out: res.out.trim(), err: res.err };
}

/** The real runner (patient cap), recording every args list. `override` may answer a call instead. */
function recorder(override) {
  return async (cwd, args) => {
    issued.push([...args]);
    const answer = override ? override(args) : null;
    return answer || patientExecGit(cwd, args);
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
  // An inconclusive lap ran no journey: its empty list must not hide a later regression.
  const unplayed = { n: 4, selfCheck: 'green', journeysPassed: [], inconclusive: { reason: 'compile-failed', detail: 'x', errors: [] } };
  assert.deepEqual(journeysPassedBefore([...laps, unplayed], 4), ['login'], 'inconclusive laps are skipped');
  assert.deepEqual(regressedJourneys(now, journeysPassedBefore([...laps, unplayed], 4)), ['login']);
  assert.equal(journeysPassedBefore([unplayed], 1), null, 'only unplayed laps: unknown');
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
  assert.equal(res.method, 'revert', 'a conflict-free rollback stays a revert sequence');
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

test('a rollback after an earlier rollback reverts only what is still applied: no Reapply chain, back at the good tree', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  mergePackage(repo, 'one');
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  mergePackage(repo, 'two');
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 2 })).ok, true);
  const good = originMain(origin);

  // Iteration 3: a package and a fix-up broke the game - rolled back to iter-2.
  mergePackage(repo, 'three');
  fixupCommit(repo, 'three fix');
  const first = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 3, toIteration: 2, reason: 'scoreDrop' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.reverted.length, 2);
  // The checkout follows origin (syncCheckout), and the next Director's pack
  // commit takes the rollback's DECISIONS.md line along.
  git(repo, 'pull', '--ff-only', 'origin', 'main');
  const pack = await commitDesignPack({ repoPath: repo, git: recorder(), label: 'iteration 4 contracts and assets' });
  assert.equal(pack.committed, true, JSON.stringify(pack));

  // Iteration 4: two more packages, then the core journey broke again.
  mergePackage(repo, 'four-a');
  mergePackage(repo, 'four-b');
  const broken = originMain(origin);
  const second = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 4, toIteration: 2, reason: 'coreJourneyBroken' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.reverted.map((c) => c.subject), ['Merge package four-b', 'Merge package four-a']);

  const after = originMain(origin);
  const made = git(origin, 'log', '--format=%s', `${broken}..${after}`).split('\n');
  assert.deepEqual(made, ['Revert "Merge package four-a"', 'Revert "Merge package four-b"'], 'two reverts, nothing else');
  const all = git(origin, 'log', '--format=%s', `${good}..${after}`).split('\n');
  assert.ok(!all.some((s) => /^Reapply|^Revert "Revert/.test(s)), all.join(' | '));
  assert.equal(git(origin, 'diff', '--stat', good, after, '--', '.', ':(exclude)design'), '', 'the code is back at the iter-2 tree');
  assert.match(git(origin, 'show', `${after}:design/DECISIONS.md`), /iter-3-rolled-back/, 'the design pack history stays');
});

test('a "This reverts commit" line that is not a real revert does not make a rollback miss the good tree', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const logs = [];
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root, log: (l) => logs.push(l) });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  // The broken change, then a commit whose message claims to revert it but changes something else.
  fixupCommit(repo, 'broken change');
  const broken = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'unrelated\n');
  git(repo, 'add', 'other.txt');
  git(repo, 'commit', '-m', 'chore: tidy', '-m', `This reverts commit ${broken}.`);
  mergePackage(repo, 'later');
  const head = originMain(origin);

  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reverted.length, 3, 'every commit since the good tag, as before netting');
  const after = originMain(origin);
  assert.equal(git(origin, 'diff', '--stat', good, after), '', 'main is back at the good tree');
  assert.equal(git(origin, 'rev-list', '--count', `${head}..${after}`), '3', 'only the full revert reached origin');
  assert.ok(logs.some((l) => /do not reach luna-work\/lwrun1\/iter-1 - reverting every commit/.test(l)), logs.join('\n'));
});

test('commit bodies that cannot be read never block a rollback: pairs are matched by subject', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const bodyLog = (args) => (args.includes('--format=%H%x1f%B%x1e') ? { ok: false, out: '', err: 'stdout maxBuffer exceeded' } : null);
  const logs = [];
  const cp = createCheckpoints({ git: recorder(bodyLog), tmpDir: () => root, log: (l) => logs.push(l) });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  // An earlier rollback's revert of package x, then package y broke the game.
  mergePackage(repo, 'x');
  git(repo, 'revert', '--no-edit', '-m', '1', 'HEAD');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  mergePackage(repo, 'y');

  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.reverted.map((c) => c.subject), ['Merge package y']);
  assert.equal(git(origin, 'diff', '--stat', good, originMain(origin)), '', 'main is back at the good tree');
  assert.ok(logs.some((l) => /commit bodies not read \(stdout maxBuffer exceeded\)/.test(l)), logs.join('\n'));
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

const junctionTest = process.platform === 'win32' ? test : test.skip;

junctionTest('the temporary revert worktree: a node_modules junction is unlinked first, its target keeps every file', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'good');
  await createCheckpoints({ git: recorder(), tmpDir: () => root }).tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  mergePackage(repo, 'bad');
  const broken = originMain(origin);
  // node_modules ignored, as in every real project: an untracked one makes git
  // refuse the removal, an ignored one is deleted - through the junction.
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\nnode_modules\n');
  // The trap: the throwaway worktree's node_modules junctioned to a real one.
  const target = path.join(root, 'main-node_modules');
  fs.mkdirSync(path.join(target, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(target, 'left-pad', 'index.js'), 'module.exports = 1;');
  const links = [];
  const run = async (cwd, args) => {
    issued.push([...args]);
    if (args[0] === 'push' && args.includes('HEAD:refs/heads/main')) return { ok: false, out: '', err: 'rejected (fetch first)' };
    const res = await patientExecGit(cwd, args);
    if (res.ok && args[0] === 'worktree' && args[1] === 'add') {
      const link = path.join(args[args.length - 2], 'node_modules');
      fs.symlinkSync(target, link, 'junction');
      links.push(link);
    }
    return res;
  };
  t.after(() => {
    // Never delete through a link left behind by a failed run.
    for (const link of links) {
      try {
        fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
  });
  const res = await createCheckpoints({ git: run, tmpDir: () => root }).rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop', todoStore: memoryStore() });
  assert.equal(res.error, 'pushFailed', JSON.stringify(res));
  assert.equal(originMain(origin), broken);
  assert.equal(links.length, 1, 'the junction was planted');
  assert.equal(fs.existsSync(links[0]), false, 'the worktree (and its link) is gone');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.deepEqual(fs.readdirSync(target), ['left-pad']);
  assert.equal(fs.readFileSync(path.join(target, 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1;');
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

// ---- the tree fallback: a revert sequence that conflicts ----------------------------------

const TREE_SUBJECT = 'revert: roll back to luna-work/lwrun1/iter-1';
// Answers the rollback's revert sequence the way a conflict does; everything else runs for real.
const conflictingRevert = (args) =>
  args[0] === 'revert' && args[1] === '--no-edit' ? { ok: false, out: '', err: 'error: could not revert 1234567... merge: luna/x (LunaCore God Mode)' } : null;

test('a rollback whose revert sequence conflicts restores the good tag\'s tree in one new commit (method tree), design-pack docs kept', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  commitOnMain(repo, 'docs: game design', { 'design/GDD.md': '# GDD\nscene: none\n' });
  const logs = [];
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root, log: (l) => logs.push(l) });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  // Iteration 2: two package merges on the same file (the first also notes its
  // scene in the GDD), the Director's design-pack commit on that same GDD line,
  // then a fix-up commit. Reverting newest-first skips the pack commit, so the
  // first package's revert conflicts on design/GDD.md.
  mergeGodModePackage(repo, 'luna/scene-worker-a1', { 'app.txt': 'v1\nscene\n', 'scene.txt': 'forest\n', 'design/GDD.md': '# GDD\nscene: forest\n' });
  mergeGodModePackage(repo, 'luna/hud-worker-b2', { 'app.txt': 'v1\nscene\nhud\n' });
  commitOnMain(repo, `${PACK_COMMIT_PREFIX} iteration 3 contracts`, { 'design/GDD.md': '# GDD\nscene: forest (approved)\n' });
  commitOnMain(repo, 'fix: hud overlap', { 'app.txt': 'v1\nscene\nhud fixed\n' });
  const broken = originMain(origin);

  const store = memoryStore();
  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'coreJourneyBroken', todoStore: store });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.method, 'tree');
  assert.ok(res.revertDetail, 'the revert failure is kept');
  assert.deepEqual(
    res.reverted.map((c) => c.subject),
    ['fix: hud overlap', mergeSubject('luna/hud-worker-b2'), mergeSubject('luna/scene-worker-a1')],
    'the work since the good tag is undone, the design-pack commit is not',
  );

  const after = originMain(origin);
  assert.doesNotThrow(() => git(origin, 'merge-base', '--is-ancestor', broken, after), 'origin history was not rewritten');
  assert.equal(git(origin, 'rev-list', '--count', `${broken}..${after}`), '1', 'exactly one new commit');
  assert.equal(git(origin, 'log', '-1', '--format=%s', after), TREE_SUBJECT);
  assert.equal(git(origin, 'rev-parse', `${after}^`), broken, 'a fast-forward on top of the broken head');
  assert.equal(git(origin, 'diff', '--stat', good, after, '--', '.', ':(exclude)design'), '', 'the code is the good tag\'s');
  assert.equal(git(origin, 'ls-tree', '--name-only', after, 'scene.txt'), '', 'a file added since the good tag is gone');
  assert.equal(git(origin, 'show', `${after}:design/GDD.md`), '# GDD\nscene: forest (approved)', 'the design-pack doc stays');
  assert.equal(git(origin, 'rev-parse', `refs/tags/${res.fromTag}^{commit}`), broken, 'the reverted work stays on a tag');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('lunaswork-revert-')), [], 'no temporary folder left behind');
  assert.ok(logs.some((l) => /restoring the tree of luna-work\/lwrun1\/iter-1 in one commit/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /could not remove|kept .*lunaswork-revert-/.test(l)), logs.join('\n'));

  assert.equal(store.list.length, 1);
  assert.match(store.list[0].details, /restoring the tree of luna-work\/lwrun1\/iter-1/);
  for (const c of res.reverted) assert.ok(store.list[0].details.includes(c.sha.slice(0, 7)), `card names ${c.subject}`);
  const decisions = fs.readFileSync(path.join(repo, 'design', 'DECISIONS.md'), 'utf8');
  assert.match(decisions, /roll main back from luna-work\/lwrun1\/iter-2-rolled-back to luna-work\/lwrun1\/iter-1 by restoring its tree in one commit \(3 commit\(s\) undone/);

  // A restart after the push restores nothing more.
  const again = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'coreJourneyBroken', todoStore: store });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.nothing, true);
  assert.equal(originMain(origin), after);
  assert.equal(store.list.length, 1);
});

test('tree fallback: two merges on one file and a later fix land main on exactly the good tree', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  const cp = createCheckpoints({ git: recorder(conflictingRevert), tmpDir: () => root });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  mergeGodModePackage(repo, 'luna/a', { 'app.txt': 'v1\na\n', 'a.txt': 'a\n' });
  mergeGodModePackage(repo, 'luna/b', { 'app.txt': 'v1\na\nb\n' });
  commitOnMain(repo, 'fix: b after a', { 'app.txt': 'v1\na fixed\nb\n' });
  const broken = originMain(origin);
  const res = await cp.rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.method, 'tree');
  assert.match(res.revertDetail, /could not revert/);
  const after = originMain(origin);
  assert.equal(git(origin, 'rev-parse', `${after}^{tree}`), git(origin, 'rev-parse', `${good}^{tree}`), 'the good tag\'s tree, byte for byte');
  assert.equal(git(origin, 'rev-parse', `${after}^`), broken);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
});

test('tree fallback: a rejected push leaves origin as it was, with no tag and no card', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  await createCheckpoints({ git: recorder(), tmpDir: () => root }).tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  mergeGodModePackage(repo, 'luna/a', { 'app.txt': 'v1\na\n' });
  const broken = originMain(origin);
  const rejecting = recorder((args) =>
    conflictingRevert(args) || (args[0] === 'push' && args.some((a) => a.endsWith(':refs/heads/main')) ? { ok: false, out: '', err: 'rejected (fetch first)' } : null));
  const store = memoryStore();
  const res = await createCheckpoints({ git: rejecting, tmpDir: () => root }).rollback({ repoPath: repo, runId: RUN, iteration: 2, toIteration: 1, reason: 'scoreDrop', todoStore: store });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pushFailed', JSON.stringify(res));
  assert.equal(res.method, 'tree');
  assert.match(res.detail, /^rejected \(fetch first\) \(tree restore, after the revert stopped: error: could not revert/, 'both causes are named');
  assert.equal(originMain(origin), broken);
  assert.equal(store.list.length, 0);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(origin, 'tag', '--list', 'luna-work/lwrun1/iter-2-rolled-back'), '');
});

test('commitGoodTree: kept docs come from the head in calls of at most 100 paths; absent ones are dropped', async () => {
  const head = 'a'.repeat(40);
  const good = 'b'.repeat(40);
  const keep = Array.from({ length: 250 }, (_, i) => `design/doc${i}.md`);
  const atHead = new Set(keep.slice(0, 240));
  const calls = [];
  const fake = async (cwd, args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') {
      const paths = args.slice(args.indexOf('--') + 1).filter((p) => atHead.has(p));
      return { ok: true, out: paths.map((p) => `100644 blob ${'c'.repeat(40)}\t${p}`).join('\0'), err: '' };
    }
    if (args[0] === 'write-tree') return { ok: true, out: 'd'.repeat(40), err: '' };
    if (args[0] === 'commit-tree') return { ok: true, out: 'e'.repeat(40), err: '' };
    return { ok: true, out: '', err: '' };
  };
  const res = await commitGoodTree(guardedGit(fake), 'dir', { headSha: head, goodSha: good, keep, message: treeMessageArgs({ toTag: 't', goodSha: good, fromTag: 'f', undone: 2 }) });
  assert.deepEqual(res, { ok: true, sha: 'e'.repeat(40) });
  assert.deepEqual(calls[0], ['read-tree', good]);
  const pathsIn = (args) => (args[0] === 'ls-tree' || args.includes('--remove') ? args.slice(args.indexOf('--') + 1).length : args.filter((a) => a === '--cacheinfo').length);
  const batched = calls.filter((a) => a[0] === 'ls-tree' || a[0] === 'update-index');
  assert.ok(batched.every((a) => pathsIn(a) <= 100), batched.map(pathsIn).join(','));
  assert.equal(batched.filter((a) => a.includes('--add')).reduce((n, a) => n + pathsIn(a), 0), 240);
  assert.deepEqual(batched.filter((a) => a.includes('--remove')).flatMap((a) => a.slice(a.indexOf('--') + 1)), keep.slice(240));
  assert.deepEqual(calls.at(-1).slice(0, 4), ['commit-tree', 'd'.repeat(40), '-p', head]);
  assert.ok(calls.at(-1).includes(treeSubject('t')));
});

// ---- staging data: backup before migrate, restore with the rollback (LW 3.29) -----------

/** A schema change committed straight on main and pushed. */
function commitMigration(repo, name) {
  const dir = path.join(repo, 'supabase', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `create table ${name.replace(/\W/g, '_')} (id int);\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', `feat: migration ${name}`);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
}

/** The staging flow over the real repo with a fake command runner. */
function stagingOver(root, onStep) {
  const runsRoot = path.join(root, 'runs');
  const steps = [];
  const staging = createStaging({
    git: recorder(),
    runsRoot: () => runsRoot,
    now: () => 1,
    runCommand: async (o) => {
      steps.push(o.step);
      const answer = onStep ? onStep(o) : null;
      if (answer) return answer;
      if (o.step === 'backup') fs.writeFileSync(path.join(o.env.LUNA_BACKUP_DIR, 'data.sql'), 'snapshot');
      return { ok: true, code: 0 };
    },
  });
  // The last staged commit, as the previous iteration left it.
  const stagedAt = (repo, sha = git(repo, 'rev-parse', 'HEAD')) => {
    const file = path.join(runsRoot, `lunaswork-${RUN}`, 'staging.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastAppliedSha: sha, production: [] }));
  };
  return { staging, steps, runsRoot, stagedAt };
}

function stagingCtx(repo, store, events, iteration = 2) {
  return {
    run: () => ({
      id: RUN,
      iteration,
      repoPath: repo,
      profile: STAGING_PROFILE,
      startedAt: null,
      history: [{ n: 1, milestone: 'core', selfCheck: 'green', coreJourneysOk: true, rolledBack: false }],
      laps: [],
      decisions: [],
    }),
    ask: () => assert.fail('nothing here touches production'),
    logEvent: (text) => events.push(text),
    todoStore: store,
  };
}

test('staging: the backup runs before the migration and is linked to the checkpoint tag', async (t) => {
  const { root, repo } = makeRepo(t);
  const { staging, steps, runsRoot, stagedAt } = stagingOver(root);
  stagedAt(repo);
  const before = git(repo, 'rev-parse', 'HEAD');
  commitMigration(repo, '20261027_quotes.sql');
  const events = [];
  const res = await staging.applyIteration(stagingCtx(repo, memoryStore(), events));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.migrated, true);
  assert.deepEqual(steps, ['backup', 'migrate', 'deploy']);
  const dir = backupDirFor(runsRoot, RUN, 2);
  assert.equal(res.backup, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'data.sql'), 'utf8'), 'snapshot');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.tag, 'luna-work/lwrun1/iter-2');
  assert.equal(manifest.dataOf, 'luna-work/lwrun1/iter-1');
  assert.deepEqual(manifest.migrations, ['supabase/migrations/20261027_quotes.sql']);
  // A restart before the iteration was recorded: the same diff again keeps the
  // snapshot from before the migration - a new one would hold migrated data.
  steps.length = 0;
  stagedAt(repo, before);
  fs.writeFileSync(path.join(dir, 'data.sql'), 'snapshot');
  const again = await staging.applyIteration(stagingCtx(repo, memoryStore(), events));
  assert.equal(again.ok, true);
  assert.deepEqual(steps, ['migrate', 'deploy']);
  assert.ok(events.some((e) => /backup from before the restart kept/.test(e)), events.join(' | '));
  // The next iteration without a schema change takes no backup at all.
  steps.length = 0;
  git(repo, 'commit', '--allow-empty', '-m', 'chore: nothing');
  const next = await staging.applyIteration(stagingCtx(repo, memoryStore(), events, 3));
  assert.equal(next.ok, true);
  assert.equal(next.migrated, false);
  assert.deepEqual(steps, ['migrate', 'deploy']);
});

test('staging: a failed backup blocks the migration - a card and a note instead', async (t) => {
  const { root, repo } = makeRepo(t);
  const { staging, steps, runsRoot, stagedAt } = stagingOver(root, (o) => (o.step === 'backup' ? { ok: false, code: 1, detail: 'pg_dump: connection refused' } : null));
  stagedAt(repo);
  const before = git(repo, 'rev-parse', 'HEAD');
  commitMigration(repo, '20261027_quotes.sql');
  const store = memoryStore();
  const events = [];
  const res = await staging.applyIteration(stagingCtx(repo, store, events));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'backupFailed');
  assert.deepEqual(steps, ['backup'], 'neither migrate nor deploy ran');
  assert.equal(fs.existsSync(path.join(backupDirFor(runsRoot, RUN, 2), MANIFEST_FILE)), false);
  assert.ok(events.some((e) => /backup failed \(pg_dump: connection refused\) - the migration was NOT applied/.test(e)), events.join(' | '));
  assert.equal(store.list.length, 1);
  assert.match(store.list[0].text, /Staging backup failed - the migration was not applied/);
  assert.match(store.list[0].details, /20261027_quotes\.sql/);
  // The migration is still pending: the next try starts from the same commit.
  const state = JSON.parse(fs.readFileSync(path.join(runsRoot, `lunaswork-${RUN}`, 'staging.json'), 'utf8'));
  assert.equal(state.lastAppliedSha, before);
});

test('staging: a rollback restores the matching data snapshot together with the code revert', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'good');
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  assert.equal((await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 })).ok, true);
  const good = originMain(origin);
  const restores = [];
  const { staging, stagedAt } = stagingOver(root, (o) => {
    if (o.step !== 'restore') return null;
    restores.push({ dir: o.env.LUNA_BACKUP_DIR, originAtRestore: originMain(origin), command: o.command });
    return { ok: true, code: 0 };
  });
  // Iteration 2: a schema change, snapshotted before it went to staging, then the playtest broke.
  stagedAt(repo);
  commitMigration(repo, '20261027_quotes.sql');
  const store = memoryStore();
  assert.equal((await staging.applyIteration(stagingCtx(repo, store, []))).ok, true);
  const broken = originMain(origin);

  const res = await cp.rollback({
    repoPath: repo,
    runId: RUN,
    iteration: 2,
    toIteration: 1,
    reason: 'coreJourneyBroken',
    todoStore: store,
    restoreData: (ctx) => staging.restoreData({ ...ctx, profile: STAGING_PROFILE, todoStore: store }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(git(origin, 'diff', '--stat', good, originMain(origin)), '', 'the code is back at the good tag');
  assert.deepEqual(res.data, {
    restored: true,
    iteration: 2,
    note: "staging data restored from the snapshot taken before iteration 2's schema change",
  });
  assert.equal(restores.length, 1);
  assert.equal(restores[0].dir, backupDirFor(path.join(root, 'runs'), RUN, 2));
  assert.equal(restores[0].command, STAGING_PROFILE.stagingRestoreCommand);
  assert.notEqual(restores[0].originAtRestore, broken, 'the data goes back only once the revert is on origin');
  const decisions = fs.readFileSync(path.join(repo, 'design', 'DECISIONS.md'), 'utf8');
  assert.match(decisions, /with 1 revert commit\(s\) and restore the staging data snapshot of iteration 2 because/);
  const card = store.list.find((c) => /Redo the work rolled back/.test(c.text));
  assert.match(card.details, /Staging data: staging data restored/);
});

test('staging: a failed restore keeps the code rollback, files a card and says so', async (t) => {
  const { root, origin, repo } = makeRepo(t);
  mergePackage(repo, 'good');
  const cp = createCheckpoints({ git: recorder(), tmpDir: () => root });
  await cp.tagIteration({ repoPath: repo, runId: RUN, iteration: 1 });
  const { staging, stagedAt } = stagingOver(root, (o) => (o.step === 'restore' ? { ok: false, code: 2, detail: 'psql: FATAL password' } : null));
  stagedAt(repo);
  commitMigration(repo, '20261027_quotes.sql');
  const store = memoryStore();
  await staging.applyIteration(stagingCtx(repo, store, []));
  const broken = originMain(origin);
  const res = await cp.rollback({
    repoPath: repo,
    runId: RUN,
    iteration: 2,
    toIteration: 1,
    reason: 'scoreDrop',
    todoStore: store,
    restoreData: (ctx) => staging.restoreData({ ...ctx, profile: STAGING_PROFILE, todoStore: store }),
  });
  assert.equal(res.ok, true, 'the code revert stands');
  assert.notEqual(originMain(origin), broken);
  assert.equal(res.data.restored, false);
  assert.match(res.data.note, /NOT restored from the iter-2 snapshot/);
  // The note goes into the repo's DECISIONS.md: the command output stays in the card.
  assert.doesNotMatch(res.data.note, /psql|[\\/]runs[\\/]/);
  const restoreCard = store.list.find((c) => /Staging data was not restored after a rollback/.test(c.text));
  assert.match(restoreCard.details, /psql: FATAL password/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'design', 'DECISIONS.md'), 'utf8'), /and restore the staging data/);
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
