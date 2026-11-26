// ============================================================================
// Luna's Work compile revert (src/lunasworkCompileRevert.js) and the targeted
// merge revert behind it (src/lunasworkCheckpoint.js revertMerges). Fakes only:
// no Unity, no git. Covers: Unity's compiler lines parsed (both slashes, the
// `(line,col): error CSnnnn: msg` shape, a cap of 10), errors mapped to the
// package that touched the file, what the build merged, the decision (one
// package, the whole iteration, nothing), the step itself (revert, cards
// reopened with the errors, one event line, the replay, at most one per
// iteration, a failed revert reported) and revertMerges' git calls.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_COMPILE_ERRORS,
  MAX_COMPILE_REVERTS,
  parseCompileErrors,
  normalizePath,
  samePath,
  guiltyPackages,
  mergesOf,
  cleanMerges,
  cleanCompileRevert,
  compileRevertPlan,
  createCompileRevert,
} = require('../src/lunasworkCompileRevert');
const { createCheckpoints, pickMerges, mergeSubject, fixupSubject, forbiddenGit, COMPILE_FAILED_REASON, rollbackCard, reasonText } = require('../src/lunasworkCheckpoint');
const { cleanInconclusive } = require('../src/lunasworkRules');
const { restoreRun } = require('../src/lunasworkRun');

const sha = (c) => c.repeat(40);
const HEAD = sha('c');
const A = { id: 'player', title: 'Player movement', branch: 'luna/player-k3x9q', cards: [1, 2], touched: ['Assets/Scripts/Player.cs', 'Assets/Scripts/PlayerInput.cs'] };
const B = { id: 'hud', title: 'HUD', branch: 'luna/hud-k3x9q', cards: [3], touched: ['Assets/UI/Hud.cs'] };
const playerError = "Assets/Scripts/Player.cs(12,5): error CS0246: The type or namespace name 'Hitbox' could not be found";
const enemyError = "Assets/Scripts/Enemy.cs(40,9): error CS1061: 'Player' does not contain a definition for 'Dash'";

const compileEnv = (errors) => ({ reason: 'compile-failed', detail: "Unity could not compile the game's scripts", errors });
const mergedCurrent = (extra = {}) => ({
  cards: [{ at: 1, text: 'card 1' }, { at: 2, text: 'card 2' }, { at: 3, text: 'card 3' }],
  build: { selfCheck: 'green', closed: [1, 2, 3], built: [1, 2, 3] },
  merges: { headSha: HEAD, packages: [A, B] },
  launch: { ok: false, error: 'compile' },
  compileRevert: null,
  ...extra,
});

// ---- parsing ----------------------------------------------------------------------------

test('parseCompileErrors: the (line,col): error CSxxxx: msg shape, both slashes, path-less errors kept', () => {
  const parsed = parseCompileErrors([
    playerError,
    'Assets\\Scripts\\Hud.cs(3,1): error CS1002: ; expected',
    'error CS0006: Metadata file could not be found',
    'Assets/Scripts/Odd.cs(7): error CS0103: no column',
  ]);
  assert.deepEqual(parsed[0], {
    path: 'Assets/Scripts/Player.cs', line: 12, code: 'CS0246', message: "The type or namespace name 'Hitbox' could not be found", text: playerError,
  });
  assert.deepEqual([parsed[1].path, parsed[1].line, parsed[1].code, parsed[1].message], ['Assets\\Scripts\\Hud.cs', 3, 'CS1002', '; expected']);
  assert.deepEqual([parsed[2].path, parsed[2].code], [null, 'CS0006'], 'no file: kept, path null');
  assert.deepEqual([parsed[3].path, parsed[3].line], ['Assets/Scripts/Odd.cs', 7]);
  // A console log tag in front is not part of the path.
  assert.equal(parseCompileErrors([`[Error] ${playerError}`])[0].path, 'Assets/Scripts/Player.cs');
});

test('parseCompileErrors: caps at 10, drops duplicates and warnings, ignores what is not text', () => {
  const many = Array.from({ length: 14 }, (_, i) => `Assets/F${i}.cs(${i + 1},1): error CS0103: name ${i}`);
  const parsed = parseCompileErrors([many[0], many[0], 'Assets/W.cs(1,1): warning CS0414: unused', 7, null, '  ', ...many.slice(1)]);
  assert.equal(MAX_COMPILE_ERRORS, 10);
  assert.equal(parsed.length, 10);
  assert.deepEqual(parsed.map((e) => e.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(parsed.every((e) => !/warning/.test(e.text)));
  assert.deepEqual(parseCompileErrors(undefined), []);
});

test('paths compare with slashes and case normalised, on whole path segments', () => {
  assert.equal(normalizePath('.\\Assets\\Scripts\\Player.CS'), 'assets/scripts/player.cs');
  assert.ok(samePath('Assets\\Scripts\\Player.cs', 'assets/scripts/player.cs'));
  // A Unity project below the repo root: God Mode's touched path has the folder.
  assert.ok(samePath('Assets/Scripts/Player.cs', 'Game/Assets/Scripts/Player.cs'));
  // An absolute path in the error.
  assert.ok(samePath('C:\\Users\\dev\\Game\\Assets\\Scripts\\Player.cs', 'Assets/Scripts/Player.cs'));
  assert.equal(samePath('Assets/Scripts/MyPlayer.cs', 'Player.cs'), false, 'not a segment boundary');
  assert.equal(samePath('Assets/Scripts/Player.cs', 'Assets/Scripts/Enemy.cs'), false);
  assert.equal(samePath('', 'Assets/A.cs'), false);
});

test('guiltyPackages: each error to the package that touched its file; the rest are unmapped', () => {
  const one = guiltyPackages(parseCompileErrors([playerError, playerError.replace('(12,5)', '(30,2)')]), [A, B]);
  assert.deepEqual(one.packages.map((p) => p.id), ['player']);
  assert.deepEqual(one.unmapped, []);
  const mixed = guiltyPackages(parseCompileErrors([playerError, enemyError, 'error CS0006: no file']), [A, B]);
  assert.deepEqual(mixed.packages.map((p) => p.id), ['player']);
  assert.deepEqual(mixed.unmapped, ['Assets/Scripts/Enemy.cs', 'error CS0006: no file']);
});

// ---- what the build merged -----------------------------------------------------------------

const settled = (integration, packages) => ({ ok: true, integration, plan: { packages } });

test('mergesOf: only a done integration that pushed a head; merged packages with their cards and touched files', () => {
  const cards = [{ at: 1, text: 'card 1' }, { at: 2, text: 'card 2' }, { at: 3, text: 'card 3' }];
  const packages = [
    { id: 'player', title: 'Player movement', merged: true, branch: A.branch, touched: A.touched, todos: ['card 1', '2'] },
    { id: 'hud', merged: false, branch: B.branch, touched: B.touched, todos: ['card 3'] },
    { id: 'nobranch', merged: true, touched: ['x.cs'], todos: ['card 3'] },
  ];
  const merges = mergesOf(settled({ state: 'done', headSha: HEAD }, packages), cards);
  assert.deepEqual(merges, { headSha: HEAD, packages: [{ ...A }] });
  assert.equal(mergesOf(settled({ state: 'done' }, packages), cards), null, 'no pushed head: nothing merged this iteration');
  assert.equal(mergesOf(settled({ state: 'failed', headSha: HEAD }, packages), cards), null, 'red: never reached main');
  assert.equal(mergesOf(settled({ state: 'done', headSha: HEAD }, [packages[1]]), cards), null);
  assert.equal(mergesOf(null, cards), null);
});

test('cleanMerges / cleanCompileRevert keep only valid fields; a stored run keeps both', () => {
  assert.equal(cleanMerges({ headSha: 'abc', packages: [A] }), null);
  assert.deepEqual(cleanMerges({ headSha: HEAD, packages: [{ ...A, branch: 'luna/../x' }, B] }).packages.map((p) => p.id), ['hud']);
  assert.equal(cleanCompileRevert({ attempts: 0 }), null);
  const record = cleanCompileRevert({ attempts: 5, ok: true, scope: 'nope', packages: ['player', 3], reverted: [{ sha: sha('a'), subject: 's' }, { sha: 'x' }], reopened: [1, 'x'], errors: [playerError] });
  assert.deepEqual(record, {
    attempts: MAX_COMPILE_REVERTS, ok: true, scope: 'packages', packages: ['player'], reverted: [{ sha: sha('a'), subject: 's' }], reopened: [1], errors: [playerError],
  });
  const run = restoreRun({
    id: 'lwtest1', projectId: 'game', repoPath: path.resolve(os.tmpdir(), 'lw-cr'), phase: 'playtesting', iteration: 2, startedAt: 1,
    current: mergedCurrent({ compileRevert: { attempts: 1, ok: true, scope: 'packages', packages: ['player'], reverted: [], reopened: [1, 2], errors: [] } }),
  });
  assert.ok(run, 'the stored run reads back');
  assert.equal(run.current.merges.headSha, HEAD);
  assert.deepEqual(run.current.merges.packages.map((p) => p.id), ['player', 'hud']);
  assert.equal(run.current.compileRevert.attempts, 1);
});

test('an inconclusive marker keeps the first ten compiler errors (the card needs them)', () => {
  const errors = Array.from({ length: 12 }, (_, i) => `Assets/F${i}.cs(1,1): error CS0103: e${i}`);
  assert.equal(cleanInconclusive({ reason: 'compile-failed', detail: 'x', errors }).errors.length, 10);
});

// ---- the decision ------------------------------------------------------------------------------

test('compileRevertPlan: one package, the whole iteration, or nothing', () => {
  const traced = compileRevertPlan(compileEnv([playerError]), mergedCurrent());
  assert.equal(traced.action, 'packages');
  assert.deepEqual(traced.packages.map((p) => p.id), ['player']);
  assert.equal(traced.headSha, HEAD);
  for (const errors of [[enemyError], [playerError, enemyError], ['error CS0006: no file']]) {
    const plan = compileRevertPlan(compileEnv(errors), mergedCurrent());
    assert.equal(plan.action, 'iteration', `unmapped: ${errors.join(' | ')}`);
    assert.deepEqual(plan.packages.map((p) => p.id), ['player', 'hud']);
  }
  const none = (env, current) => compileRevertPlan(env, current).why;
  // No compiler message at all: no evidence against this iteration's code, so no revert.
  assert.equal(none(compileEnv([]), mergedCurrent()), 'noErrors');
  assert.equal(none(compileEnv(['Assets/W.cs(1,1): warning CS0414: unused']), mergedCurrent()), 'noErrors');
  assert.equal(none({ reason: 'editor-busy', errors: [] }, mergedCurrent()), 'notCompile');
  assert.equal(none({ reason: 'still-compiling', errors: [] }, mergedCurrent()), 'notCompile');
  assert.equal(none(null, mergedCurrent()), 'notCompile');
  assert.equal(none(compileEnv([playerError]), mergedCurrent({ merges: null })), 'noMerge');
  assert.equal(none(compileEnv([playerError]), mergedCurrent({ build: { selfCheck: 'red' } })), 'noMerge');
  assert.equal(none(compileEnv([playerError]), mergedCurrent({ compileRevert: { attempts: 1, ok: true } })), 'retried');
});

// ---- the step ------------------------------------------------------------------------------------

/** createCompileRevert with a fake for every dep; `run` is a plain object the fakes update. */
function stepHarness(opts = {}) {
  const h = {
    run: {
      id: 'lwtest1', projectId: 'game', repoPath: '/repo', iteration: 3, evidenceDir: '/ev',
      history: opts.history || [
        { n: 1, score: 60, selfCheck: 'green', coreJourneysOk: true, rolledBack: false },
        { n: 2, score: 65, selfCheck: 'green', coreJourneysOk: true, rolledBack: false },
      ],
      current: mergedCurrent(opts.current),
    },
    events: [],
    logs: [],
    reopened: [],
    syncs: 0,
    calls: { revertMerges: [], rollback: [] },
  };
  const revertAnswer = opts.revertMerges || ((o) => ({
    ok: true, reverted: [{ sha: sha('a'), subject: mergeSubject(o.packages[0].branch) }], packages: o.packages.map((p) => p.id), missing: [], already: [],
  }));
  const rollbackAnswer = opts.rollback || ((o) => ({
    ok: true, fromTag: `luna-work/lwtest1/iter-${o.iteration}-rolled-back`, toTag: `luna-work/lwtest1/iter-${o.toIteration}`,
    reverted: [{ sha: sha('a'), subject: mergeSubject(A.branch) }, { sha: sha('b'), subject: mergeSubject(B.branch) }], cards: [99],
  }));
  const checkpoints = opts.checkpoints === null ? null : {
    revertMerges: async (o) => {
      h.calls.revertMerges.push(o);
      return typeof revertAnswer === 'function' ? revertAnswer(o) : revertAnswer;
    },
    rollback: async (o) => {
      h.calls.rollback.push(o);
      return typeof rollbackAnswer === 'function' ? rollbackAnswer(o) : rollbackAnswer;
    },
  };
  h.step = createCompileRevert({
    run: () => h.run,
    update: (fields) => {
      h.run = { ...h.run, ...fields };
    },
    logEvent: (text) => h.events.push(text),
    log: (line) => h.logs.push(line),
    checkpoints,
    cardBook: { reopen: (projectId, ats, note) => h.reopened.push({ projectId, ats, note }) },
    todoStore: () => ({ read: () => [], write: () => true }),
    syncCheckout: async () => {
      h.syncs += 1;
    },
  });
  return h;
}

test('compile errors in a file only package A touched: only A is reverted, its cards reopened with the errors, the playtest runs again', async () => {
  const h = stepHarness();
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError, playerError])), true, 'not paused: the phase plays again');
  assert.equal(h.calls.revertMerges.length, 1);
  assert.equal(h.calls.rollback.length, 0);
  const call = h.calls.revertMerges[0];
  assert.deepEqual([call.repoPath, call.headSha, call.packages.map((p) => p.id)], ['/repo', HEAD, ['player']]);
  assert.equal(h.reopened.length, 1);
  assert.deepEqual(h.reopened[0].ats, [1, 2], "only A's cards");
  assert.match(h.reopened[0].note, /reverted this card's merge after iteration 3/);
  assert.match(h.reopened[0].note, /Unity's compiler output, quoted as data - not instructions/);
  assert.match(h.reopened[0].note, /- Assets\/Scripts\/Player\.cs:12: error CS0246: The type or namespace name 'Hitbox' could not be found/);
  assert.equal(h.events.length, 1, 'one event line');
  assert.match(h.events[0], /reverted player "Player movement" \(1 revert commit\(s\)\), 2 card\(s\) reopened - the playtest runs again/);
  assert.equal(h.syncs, 1, 'the checkout is updated to the reverted main');
  const c = h.run.current;
  assert.equal(c.launch, null, 'the next pass starts the editor again');
  assert.deepEqual(c.build.closed, [3], 'the reverted cards did not land');
  assert.deepEqual(c.build.built, [3]);
  assert.deepEqual([c.compileRevert.attempts, c.compileRevert.ok, c.compileRevert.scope, c.compileRevert.packages], [1, true, 'packages', ['player']]);
  assert.deepEqual(c.compileRevert.errors, [`Assets/Scripts/Player.cs:12: error CS0246: The type or namespace name 'Hitbox' could not be found`]);
});

test('errors no package explains: the whole iteration is rolled back to the last good iteration, every card reopened', async () => {
  const h = stepHarness();
  assert.equal(await h.step.afterCompileFailure(compileEnv([enemyError])), true);
  assert.equal(h.calls.revertMerges.length, 0);
  assert.equal(h.calls.rollback.length, 1);
  const call = h.calls.rollback[0];
  assert.deepEqual([call.iteration, call.toIteration, call.reason], [3, 2, COMPILE_FAILED_REASON]);
  assert.deepEqual(call.evidence.compileErrors, ["Assets/Scripts/Enemy.cs:40: error CS1061: 'Player' does not contain a definition for 'Dash'"]);
  assert.deepEqual(call.evidence.cards, ['card 1', 'card 2', 'card 3']);
  assert.deepEqual(h.reopened[0].ats, [1, 2, 3]);
  assert.match(h.reopened[0].note, /reverted this iteration's merges \(the errors were not traced to one package\)/);
  assert.match(h.events[0], /errors not traced to one package - rolled main back to iteration 2 \(2 revert commit\(s\)\), reverting player "Player movement", hud "HUD"/);
  assert.deepEqual(h.run.current.build.closed, []);
  assert.deepEqual([h.run.current.compileRevert.scope, h.run.current.compileRevert.toIteration], ['iteration', 2]);
});

test('errors no package explains and no good iteration to go back to: every merge of the iteration is reverted', async () => {
  const h = stepHarness({ history: [{ n: 1, score: null, selfCheck: 'green', inconclusive: { reason: 'editor-busy', detail: 'x', errors: [] } }] });
  assert.equal(await h.step.afterCompileFailure(compileEnv(['error CS0006: no file'])), true);
  assert.equal(h.calls.rollback.length, 0);
  assert.deepEqual(h.calls.revertMerges[0].packages.map((p) => p.id), ['player', 'hud']);
  assert.match(h.events[0], /reverted every merge: player "Player movement", hud "HUD"/);
});

test('a good iteration before an inconclusive one: the rollback would take that work too, so only this iteration\'s merges are reverted', async () => {
  const h = stepHarness({
    history: [
      { n: 1, score: 60, selfCheck: 'green', coreJourneysOk: true, rolledBack: false },
      { n: 2, score: null, selfCheck: 'green', inconclusive: { reason: 'editor-busy', detail: 'x', errors: [] } },
    ],
  });
  assert.equal(await h.step.afterCompileFailure(compileEnv([enemyError])), true);
  assert.equal(h.calls.rollback.length, 0, 'iteration 2 keeps its work');
  assert.deepEqual(h.calls.revertMerges[0].packages.map((p) => p.id), ['player', 'hud']);
  assert.deepEqual(h.reopened[0].ats, [1, 2, 3]);
  assert.equal(h.run.current.compileRevert.toIteration, undefined);
});

test('no merge this iteration, no compiler message, editor busy, still compiling, no checkpoints: nothing is reverted (the caller pauses)', async () => {
  const cases = [
    [{ current: { merges: null } }, compileEnv([playerError])],
    [{}, compileEnv([])],
    [{}, { reason: 'editor-busy', detail: 'busy', errors: [] }],
    [{}, { reason: 'still-compiling', detail: 'compiling', errors: [] }],
    [{}, { reason: 'missing-scripts', detail: 'stale', errors: [] }],
    [{ checkpoints: null }, compileEnv([playerError])],
  ];
  for (const [opts, env] of cases) {
    const h = stepHarness(opts);
    assert.equal(await h.step.afterCompileFailure(env), false, env.reason);
    assert.deepEqual([h.calls.revertMerges.length, h.calls.rollback.length, h.reopened.length, h.events.length, h.syncs], [0, 0, 0, 0, 0]);
    assert.equal(h.run.current.compileRevert, null);
  }
});

test('a replay that still does not compile goes the old way: no second revert', async () => {
  const h = stepHarness();
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), true);
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), false, 'the second failure pauses');
  assert.equal(await h.step.afterCompileFailure(compileEnv([enemyError])), false);
  assert.equal(h.calls.revertMerges.length, 1);
  assert.equal(h.calls.rollback.length, 0);
  assert.equal(h.events.length, 1);
});

test('a failed revert is reported, recorded and counts as the one try: the caller pauses, main keeps the merges', async () => {
  const h = stepHarness({ revertMerges: { ok: false, error: 'revertFailed', detail: 'CONFLICT (content): Merge conflict in Assets/Scripts/Player.cs' } });
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), false);
  assert.equal(h.reopened.length, 0, 'no card reopens for work still on main');
  assert.equal(h.syncs, 0);
  assert.match(h.events[0], /reverting player "Player movement" failed \(revertFailed: CONFLICT \(content\)[^)]*\) - main keeps the merges, the playtest waits as before/);
  const record = h.run.current.compileRevert;
  assert.deepEqual([record.ok, record.error, record.attempts], [false, 'revertFailed', 1]);
  assert.deepEqual(h.run.current.build.closed, [1, 2, 3]);
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), false);
  assert.equal(h.calls.revertMerges.length, 1, 'never tried twice in one iteration');
});

test('a revert that throws is reported, not swallowed', async () => {
  const h = stepHarness({
    revertMerges: () => {
      throw new Error('git exploded');
    },
  });
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), false);
  assert.match(h.events[0], /failed \(failed: git exploded\)/);
  assert.equal(h.run.current.compileRevert.detail, 'git exploded');
});

test('a restart after the push: merges already reverted on main count as reverted, their cards reopen', async () => {
  const h = stepHarness({ revertMerges: { ok: true, nothing: true, reverted: [], packages: [], missing: [], already: ['player'] } });
  assert.equal(await h.step.afterCompileFailure(compileEnv([playerError])), true);
  assert.deepEqual(h.reopened[0].ats, [1, 2]);
  assert.match(h.events[0], /reverted player "Player movement" \(0 revert commit\(s\)\)/);
});

test('the rollback card and reason of a compile rollback carry the compiler errors', () => {
  const evidence = { compileErrors: ["Assets/Scripts/Enemy.cs:40: error CS1061: 'Player' does not contain a definition for 'Dash'"], cards: ['card 1'] };
  assert.match(reasonText(COMPILE_FAILED_REASON, evidence), /^Unity could not compile the scripts after the merge: Assets\/Scripts\/Enemy\.cs:40/);
  const made = rollbackCard({ iteration: 3, fromTag: 'f', toTag: 't', reason: COMPILE_FAILED_REASON, evidence, reverted: [] });
  assert.match(made.details, /Compile errors:\n- Assets\/Scripts\/Enemy\.cs:40: error CS1061/);
});

// ---- revertMerges: the git side, with a fake runner --------------------------------------------

const ORIGIN_HEAD = sha('f');
const log = (rows) => rows.map(([s, parents, subject]) => `${s}\t${parents}\t${subject}`).join('\n');
const MAIN_LOG = [
  [sha('9'), `${sha('8')}`, 'docs(luna-work): iteration 4 contracts and assets'],
  [sha('8'), `${sha('7')} ${sha('6')}`, mergeSubject(B.branch)],
  [sha('7'), `${sha('5')}`, fixupSubject('player')],
  [sha('5'), `${sha('4')} ${sha('3')}`, mergeSubject(A.branch)],
  [sha('4'), `${sha('2')}`, fixupSubject('hud')],
  [sha('2'), `${sha('1')} ${sha('0')}`, mergeSubject('luna/hud-older')],
];

test('pickMerges: a package merge plus its fix-up right after it; missing and already reverted packages named', () => {
  const all = MAIN_LOG.map(([s, parents, subject]) => ({ sha: s, merge: parents.includes(' '), subject }));
  const picked = pickMerges(all, all, [A, { id: 'ghost', branch: 'luna/ghost-1' }]);
  assert.deepEqual(picked.commits.map((c) => c.sha), [sha('7'), sha('5')], 'newest first');
  assert.deepEqual([picked.reverted, picked.missing, picked.already], [['player'], ['ghost'], []]);
  // An older plan's "fix: make hud ..." is not B's fix-up: it does not follow B's merge.
  assert.deepEqual(pickMerges(all, all, [B]).commits.map((c) => c.sha), [sha('8')]);
  const reverted = pickMerges(all, all.filter((c) => c.sha !== sha('5')), [A]);
  assert.deepEqual([reverted.commits.length, reverted.already], [0, ['player']]);
  // Bounded at the iteration's pushed head: a merge newer than it is not this iteration's.
  const newer = { sha: sha('d'), merge: true, subject: mergeSubject(A.branch) };
  const bounded = pickMerges([newer, ...all], [newer, ...all], [A], sha('9'));
  assert.deepEqual(bounded.commits.map((c) => c.sha), [sha('7'), sha('5')]);
  assert.deepEqual(pickMerges([newer, ...all], [newer, ...all], [A]).commits.map((c) => c.sha), [sha('d')], 'unbounded: the newest');
});

/** A guarded checkpoints instance over a scripted git: `answers(args)` or the defaults below. */
function fakeGit(t, answers = () => null) {
  const calls = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cr-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    const scripted = answers(args);
    if (scripted) return scripted;
    const line = args.join(' ');
    if (line === 'rev-parse --abbrev-ref HEAD') return { ok: true, out: 'main', err: '' };
    if (line === 'rev-parse FETCH_HEAD^{commit}') return { ok: true, out: ORIGIN_HEAD, err: '' };
    if (line === 'rev-parse HEAD') return { ok: true, out: sha('e'), err: '' };
    if (args[0] === 'log' && args.includes('--format=%H%x09%P%x09%s')) return { ok: true, out: log(MAIN_LOG), err: '' };
    if (args[0] === 'log') return { ok: true, out: '', err: '' };
    return { ok: true, out: '', err: '' };
  };
  return { calls, cp: createCheckpoints({ git, tmpDir: () => tmp }) };
}

test('revertMerges: reverts only the named package merges (and fix-up) on origin main with new commits, pushed as a fast-forward', async (t) => {
  const { calls, cp } = fakeGit(t);
  const res = await cp.revertMerges({ repoPath: '/repo', headSha: HEAD, packages: [A] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.reverted.map((c) => c.sha), [sha('7'), sha('5')]);
  assert.deepEqual([res.packages, res.missing, res.already, res.headAfter], [['player'], [], [], sha('e')]);
  const lines = calls.map((c) => c.args.join(' '));
  assert.ok(lines.includes(`merge-base --is-ancestor ${HEAD} ${ORIGIN_HEAD}`), "the iteration's head is on origin main");
  assert.ok(lines.some((l) => l.startsWith('log --first-parent --max-count=200 --format=%H%x09%P%x09%s')));
  assert.ok(lines.includes(`revert --no-edit -m 1 ${sha('7')} ${sha('5')}`), 'one revert sequence, newest first');
  assert.ok(lines.includes('push origin HEAD:refs/heads/main'));
  assert.ok(lines.some((l) => l.startsWith('worktree add --detach')) && lines.some((l) => l.startsWith('worktree remove')));
  assert.ok(calls.every((c) => forbiddenGit(c.args) === null), 'no force push, no reset');
});

test('revertMerges: a merge already reverted (restart) is not reverted again', async (t) => {
  const body = `${sha('d')}\x1fRevert "${mergeSubject(A.branch)}"\n\nThis reverts commit ${sha('5')}, reversing\nchanges made to ${sha('4')}.\n\x1e`;
  const rows = [[sha('d'), sha('9'), `Revert "${mergeSubject(A.branch)}"`], ...MAIN_LOG];
  const { calls, cp } = fakeGit(t, (args) => {
    if (args[0] !== 'log') return null;
    return { ok: true, out: args.includes('--format=%H%x1f%B%x1e') ? body : log(rows), err: '' };
  });
  const res = await cp.revertMerges({ repoPath: '/repo', headSha: HEAD, packages: [A] });
  assert.deepEqual([res.ok, res.nothing, res.already], [true, true, ['player']]);
  assert.ok(!calls.some((c) => c.args[0] === 'revert' || c.args[0] === 'push'));
});

test('revertMerges: failures come back as errors, origin untouched', async (t) => {
  const notOnBranch = fakeGit(t, (args) => (args[0] === 'merge-base' ? { ok: false, out: '', err: 'not an ancestor' } : null));
  assert.deepEqual(await notOnBranch.cp.revertMerges({ repoPath: '/repo', headSha: HEAD, packages: [A] }), { ok: false, error: 'mergeNotOnBranch', detail: 'not an ancestor' });
  const missing = fakeGit(t);
  const none = await missing.cp.revertMerges({ repoPath: '/repo', headSha: HEAD, packages: [{ id: 'ghost', branch: 'luna/ghost-1' }] });
  assert.deepEqual([none.ok, none.error, none.missing], [false, 'mergesNotFound', ['ghost']]);
  const conflict = fakeGit(t, (args) => (args[0] === 'revert' && args[1] === '--no-edit' ? { ok: false, out: '', err: 'CONFLICT (content)' } : null));
  const failed = await conflict.cp.revertMerges({ repoPath: '/repo', headSha: HEAD, packages: [A] });
  assert.deepEqual([failed.ok, failed.error, failed.detail], [false, 'revertFailed', 'CONFLICT (content)']);
  assert.ok(conflict.calls.some((c) => c.args.join(' ') === 'revert --abort'));
  assert.ok(!conflict.calls.some((c) => c.args[0] === 'push'));
  for (const calls of [notOnBranch.calls, missing.calls, conflict.calls]) assert.ok(!calls.some((c) => c.args[0] === 'push'));
  assert.deepEqual(await missing.cp.revertMerges({ repoPath: '/repo', headSha: 'nope', packages: [A] }), { ok: false, error: 'noMergeHead' });
});
