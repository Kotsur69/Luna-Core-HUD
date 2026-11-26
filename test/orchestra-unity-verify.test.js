// ============================================================================
// Unity verify commands in God Mode (src/orchestraUnityVerify.js).
// Live in Luna's Work run lwmwxd1zal (2026-11-26): every Unity package went red
// at the integration with "No Pipeline instance found for project: ...", because
// its verify (`unity command ...`) needs an editor and none is open on the
// integration worktree. The planner side keeps such commands out of `verify`;
// the integration side defers a verify that failed only for want of an editor.
// Git, verify and the fix-up worker are faked; nothing touches a real repo.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const uv = require('../src/orchestraUnityVerify.js');
const integ = require('../src/orchestraIntegrate.js');
const sup = require('../src/orchestraSupervisor.js');
const { buildReport } = require('../src/orchestraReport.js');
const { createMergeRunDeps } = require('../src/orchestraMergeRun.js');

// What the unity CLI printed in the integration worktree of run pmwxdbopo.
const NO_PIPELINE = 'Error: No Pipeline instance found for project: C:\\Users\\Kotsur69\\source\\repos\\.luna-worktrees\\blade&bullet\\pmwxdbopo-integration';
// The verify the planner wrote for the game-clock package.
const GAME_CLOCK_VERIFY =
  'unity command script recompile && unity command test run --filter GameClockTests && unity command console read (edit mode: ok true, empty errors/warnings)';

// ---- integration side: which red verify only lacked an editor ----------------

test('unityEditorMissing: the no-Pipeline error alone defers', () => {
  assert.equal(uv.unityEditorMissing({ ok: false, output: NO_PIPELINE, timedOut: false }), true);
  assert.equal(uv.unityEditorMissing({ ok: false, output: `Compiling...\n${NO_PIPELINE}\nSee unity --help` }), true);
});

test('unityEditorMissing: a real failure, a timeout or a green run never defers', () => {
  assert.equal(uv.unityEditorMissing({ ok: true, output: NO_PIPELINE }), false, 'green is green');
  assert.equal(uv.unityEditorMissing({ ok: false, output: 'not ok 1 - clock ticks\nError: expected 2' }), false);
  assert.equal(uv.unityEditorMissing({ ok: false, output: `${NO_PIPELINE}\n[LunaCore: verify timed out]`, timedOut: true }), false);
  // `npm test; unity ...`: the tests failed too - red, whatever the editor says.
  assert.equal(uv.unityEditorMissing({ ok: false, output: `\u2716 clock ticks (3ms)\n${NO_PIPELINE}` }), false);
  // Another error came first: that one is the failure.
  assert.equal(uv.unityEditorMissing({ ok: false, output: `TypeError: x is not a function\n${NO_PIPELINE}` }), false);
  assert.equal(uv.unityEditorMissing({ ok: false, output: '' }), false);
  assert.equal(uv.unityEditorMissing(null), false);
});

test('deferToUnityEditor: only a verify whose failing part can only be the unity CLI is deferred', () => {
  const missing = { ok: false, output: NO_PIPELINE };
  // All unity, or a prefix chained with && (the unity call ran, so the prefix passed).
  for (const cmd of [
    GAME_CLOCK_VERIFY,
    'unity command test run',
    'npm test && unity command test run --filter X',
    '(cd Game && unity test run)',
    'unity command script recompile; unity command test run',
    'timeout 600 unity command test run',
  ]) {
    assert.equal(uv.deferToUnityEditor(cmd, missing), true, cmd);
  }
  // A part that may have failed, or never ran, or no unity call at all: red.
  for (const cmd of [
    'grep -q "class X" Assets/X.cs; unity command script recompile',
    'dotnet build || unity command test run',
    'unity command script recompile && grep -q "class X" Assets/X.cs',
    'unity command test run | tee log.txt',
    'npm test',
    'pwsh -c "unity command test run"',
    '',
  ]) {
    assert.equal(uv.deferToUnityEditor(cmd, missing), false, cmd);
  }
  assert.equal(uv.deferToUnityEditor('unity command test run', { ok: false, output: 'not ok 1 - x' }), false, 'a real failure');
  assert.equal(uv.deferToUnityEditor(undefined, missing), false);
});

const WT = { ok: true, root: '/wt/int', cwd: '/wt/int', branch: 'luna/p-integration' };

/** Fake execFile: git answers ok (rev-parse with a sha); every call is recorded. */
function fakeGit() {
  const calls = [];
  const execImpl = (bin, argv, _opts, cb) => {
    const cmd = `${bin} ${(bin === 'git' ? argv.slice(2) : argv).join(' ')}`;
    calls.push(cmd);
    const stdout = cmd.startsWith('git rev-parse') ? 'sha1\n' : '';
    setImmediate(() => cb(null, stdout, ''));
    return { stdin: { on() {}, end() {} } };
  };
  return { execImpl, calls };
}

function integDeps(git, verify) {
  const fixups = [];
  return {
    fixups,
    deps: {
      execImpl: git.execImpl,
      addWorktree: async (_r, _n, opts) => ({ ...WT, base: opts.base }),
      removeWorktree: async () => ({ ok: true }),
      resolve: async () => ({ ok: true }),
      verifyImpl: verify,
      installImpl: async () => ({ ok: true }),
      fixup: async (a) => (fixups.push(a), { ok: false }),
    },
  };
}

const args = (packages) => ({ repoPath: '/r', base: 'main', slug: 'p', packages });

test('integrateMerge: a verify red only for want of a Unity editor is merged, marked verifyDeferred, run once, no fix-up', async () => {
  const git = fakeGit();
  const runs = [];
  const verify = async (cmd, cwd) => (runs.push([cmd, cwd]), cmd === GAME_CLOCK_VERIFY ? { ok: false, output: NO_PIPELINE } : { ok: true, output: '' });
  const { deps, fixups } = integDeps(git, verify);
  const res = await integ.integrateMerge(
    args([
      { id: 'game-clock', branch: 'luna/game-clock', verify: GAME_CLOCK_VERIFY, dependsOn: [] },
      { id: 'playtest-cli', branch: 'luna/playtest-cli', verify: 'npm test', dependsOn: ['game-clock'] },
    ]),
    deps,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.merged, ['game-clock', 'playtest-cli']);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.verifyDeferred, ['game-clock']);
  assert.deepEqual(res.fixedUp, []);
  assert.equal(runs.filter(([cmd]) => cmd === GAME_CLOCK_VERIFY).length, 1, 'a missing editor does not appear on a re-run');
  assert.deepEqual(fixups, [], 'no fix-up worker for a missing editor');
  assert.ok(!git.calls.some((c) => c.startsWith('git reset --hard')), 'the merge stays');
  assert.ok(git.calls.includes('git push origin HEAD:refs/heads/main'));
});

test('integrateMerge: a genuine red verify in a Unity package is still red', async () => {
  const git = fakeGit();
  const red = 'not ok 1 - GameClockTests.Ticks\nAssertionError: expected 1 got 0';
  const { deps, fixups } = integDeps(git, async (cmd) => (cmd === 'red' ? { ok: false, output: red } : { ok: true, output: '' }));
  const res = await integ.integrateMerge(
    args([
      { id: 'game-clock', branch: 'luna/game-clock', verify: 'red' },
      { id: 'hud', branch: 'luna/hud', verify: 'green' },
    ]),
    deps,
  );
  assert.deepEqual(res.merged, ['hud']);
  assert.deepEqual(res.verifyDeferred, []);
  assert.equal(res.skipped[0].id, 'game-clock');
  assert.equal(res.skipped[0].stage, 'verify');
  assert.ok(fixups.length >= 1, 'a real failure still gets its fix-up worker');
  assert.ok(git.calls.includes('git reset --hard sha1'));
});

test('integrateMerge: a package deferred on the second pass is marked too', async () => {
  const git = fakeGit();
  let first = true;
  const UNITY = 'unity command test run --filter A';
  // The first try is a real red (reset away); on the second pass only the editor is missing.
  const verify = async (cmd) => {
    if (cmd !== UNITY) return { ok: true, output: '' };
    if (first) return { ok: false, output: 'not ok 1 - flaky' };
    return { ok: false, output: NO_PIPELINE };
  };
  const { deps } = integDeps(git, verify);
  deps.fixup = async () => ((first = false), { ok: false });
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: UNITY },
      { id: 'b', branch: 'luna/b', verify: 'green' },
    ]),
    deps,
  );
  assert.deepEqual(res.merged, ['b', 'a']);
  assert.deepEqual(res.secondPass, ['a']);
  assert.deepEqual(res.verifyDeferred, ['a']);
});

test('integrateMerge: the no-Pipeline text from a verify that hides another failure is red', async () => {
  const git = fakeGit();
  // `grep -q` fails silently, then the unity call prints the no-Pipeline error: the exit code is unity's.
  const hidden = 'grep -q "class GameClock" Assets/Scripts/GameClock.cs; unity command test run';
  const { deps } = integDeps(git, async (cmd) => (cmd === hidden || cmd === 'npm test' ? { ok: false, output: NO_PIPELINE } : { ok: true, output: '' }));
  const res = await integ.integrateMerge(
    args([
      { id: 'a', branch: 'luna/a', verify: hidden },
      { id: 'b', branch: 'luna/b', verify: 'npm test' },
      { id: 'c', branch: 'luna/c', verify: 'green' },
    ]),
    deps,
  );
  assert.deepEqual(res.merged, ['c']);
  assert.deepEqual(res.verifyDeferred, []);
  assert.deepEqual(res.skipped.map((s) => [s.id, s.stage]), [
    ['a', 'verify'],
    ['b', 'verify'],
  ]);
});

test('createMergeRunDeps records verifyDeferred only when there is one, added up over passes', async () => {
  const plan = { id: 'p1', repoPath: '/r', integration: { state: 'running' }, packages: [] };
  let answer = { ok: true, fixedUp: [], secondPass: [] };
  const mr = createMergeRunDeps({ getPlan: () => plan, runFixup: async () => ({ ok: true }), integrateMerge: async () => answer });
  await mr.integrateMerge({ packages: [] }, {});
  assert.equal('verifyDeferred' in plan.integration, false, 'nothing deferred: no key');
  answer = { ok: true, verifyDeferred: ['a', 'NOT AN ID'] };
  await mr.integrateMerge({ packages: [] }, {});
  answer = { ok: true, verifyDeferred: ['b', 'a'] };
  await mr.integrateMerge({ packages: [] }, {});
  assert.deepEqual(plan.integration.verifyDeferred, ['a', 'b']);
  answer = { ok: false, verifyDeferred: ['c'] };
  await mr.integrateMerge({ packages: [] }, {});
  assert.deepEqual(plan.integration.verifyDeferred, ['a', 'b'], 'a failed integration merged nothing');
});

test('normalizeStoredPlan keeps integration.verifyDeferred (valid ids only), and adds no key without one', () => {
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: '/r',
    packages: [{ id: 'a' }],
    integration: { state: 'done', verifyDeferred: ['a', 'NOT AN ID', null] },
  }).integration;
  assert.deepEqual(stored.verifyDeferred, ['a']);
  const plain = sup.normalizeStoredPlan({ id: 'p1', repoPath: '/r', packages: [{ id: 'a' }] }).integration;
  assert.equal('verifyDeferred' in plain, false);
});

test('the report says which merged packages had their verify deferred to the Unity editor', () => {
  const md = buildReport(
    {
      id: 'p1',
      repoPath: '/r',
      integrationMode: 'merge',
      integration: { state: 'done', skipped: [], verifyDeferred: ['game-clock'] },
      packages: [
        { id: 'game-clock', title: 'Game clock', state: 'pushed', branch: 'luna/game-clock', merged: true },
        { id: 'hud', title: 'HUD', state: 'pushed', branch: 'luna/hud', merged: true },
      ],
    },
    { now: 0, suggestions: [] },
  );
  assert.match(md, /\| game-clock - Game clock \|.*verify deferred to the live Unity editor/);
  assert.doesNotMatch(md, /\| hud - HUD \|.*verify deferred/);
});

// ---- planning side: no editor-bound or prose verify in a Unity build -----------

test('editorBoundReason: the unity CLI and the editor in batch mode need an editor', () => {
  assert.equal(uv.editorBoundReason(GAME_CLOCK_VERIFY), 'unity');
  assert.equal(uv.editorBoundReason('unity command script recompile'), 'unity');
  assert.equal(uv.editorBoundReason('cd Game && unity test run --platform PlayMode'), 'unity');
  assert.equal(uv.editorBoundReason('pwsh -c "unity command test run"'), 'unity');
  assert.equal(uv.editorBoundReason('Unity.exe -batchmode -projectPath . -runTests'), 'unity');
  assert.equal(uv.editorBoundReason('"C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.1f1\\Editor\\Unity.exe" -batchmode -quit -projectPath .'), 'unity');
  // Wrappers and a second line.
  assert.equal(uv.editorBoundReason('timeout 600 unity command test run'), 'unity');
  assert.equal(uv.editorBoundReason('npx unity test run'), 'unity');
  assert.equal(uv.editorBoundReason('UNITY_LOG=1 unity command test run'), 'unity');
  assert.equal(uv.editorBoundReason('env UNITY_LOG=1 unity command test run'), 'unity');
  assert.equal(uv.editorBoundReason('npm test\nunity command test run'), 'unity');
  // A word that only ends in "unity" is not the editor.
  assert.equal(uv.editorBoundReason('./community.sh -runTests'), null);
});

test('editorBoundReason: prose is not a shell command', () => {
  assert.equal(uv.editorBoundReason('dotnet test (edit mode: ok true, empty errors/warnings)'), 'prose');
  assert.equal(uv.editorBoundReason('see `scripts/check.sh`'), 'prose');
  // A unity call inside prose is still a unity call: that reason wins.
  assert.equal(uv.editorBoundReason('run `unity test --help` first'), 'unity');
  assert.equal(uv.editorBoundReason('Open the editor and confirm the clock ticks'), 'prose');
  assert.equal(uv.editorBoundReason("Check the editor's Console"), 'prose');
});

test('editorBoundReason: a shell command that runs without an editor is kept', () => {
  for (const ok of [
    '',
    'npm test',
    'grep -q "class GameClock" Assets/Scripts/GameClock.cs',
    'grep -rq "the unity clock" Assets/Scripts',
    'grep -q "unity" Packages/manifest.json',
    '(cd tools && npm test)',
    'test -f Assets/LunaPlaytest/PlaytestDriver.cs && ! grep -rq "UnityEditor" Assets/LunaPlaytest/PlaytestDriver.cs',
    'node --test test/clock.test.js',
    // Short file names and command names are not English words.
    'diff a b',
    'test -f a && test -f b',
    'make && make test',
    'npm run check && cd tools && npm run check',
  ]) {
    assert.equal(uv.editorBoundReason(ok), null, ok);
  }
  assert.equal(uv.editorBoundReason(undefined), null);
});

test('editorFreeVerify: an editor-bound verify becomes an editor check in the prompt; verify is emptied', () => {
  const pkg = { id: 'game-clock', prompt: 'Build the game clock. Commit when done.', verify: GAME_CLOCK_VERIFY, files: ['Assets/Scripts/GameClock.cs'] };
  const out = uv.editorFreeVerify(pkg, 8000);
  assert.equal(out.verify, '');
  assert.ok(out.prompt.startsWith(pkg.prompt), 'the prompt itself is never cut');
  assert.match(out.prompt, /against your own Unity editor/);
  assert.ok(out.prompt.includes('unity command test run --filter GameClockTests'), 'the check itself is kept for the worker');
  assert.deepEqual(out.files, pkg.files);
  assert.equal(pkg.verify, GAME_CLOCK_VERIFY, 'the input is not mutated');

  // No verify: the same object.
  for (const none of [{ id: 'n', prompt: 'p', verify: '' }, { id: 'n', prompt: 'p', verify: '   ' }, { id: 'n', prompt: 'p' }]) {
    assert.equal(uv.editorFreeVerify(none, 8000), none);
  }

  // No room for the note: the verify is still emptied, the prompt stays whole.
  const full = { id: 'f', prompt: 'x'.repeat(8000), verify: 'unity command test run' };
  const capped = uv.editorFreeVerify(full, 8000);
  assert.equal(capped.verify, '');
  assert.equal(capped.prompt, full.prompt);
  const near = uv.editorFreeVerify({ ...full, prompt: 'x'.repeat(7950) }, 8000);
  assert.equal(near.prompt.length, 8000, 'a note that does not fit is shortened to the cap');
  // The caller can tell a whole note from a shortened or dropped one.
  assert.ok(out.prompt.endsWith(uv.editorCheckNote(GAME_CLOCK_VERIFY)));
  assert.ok(!near.prompt.endsWith(uv.editorCheckNote('unity command test run')));
});

// Blade&bullet (2026-11-26): God Mode runs a verify through cmd.exe, where
// grep and test do not exist, and workers committed grep.cmd / unity.cmd /
// wrapper .ps1 shims to make theirs pass. In a Unity build no package keeps one.
test('editorFreeVerify: ANY verify moves into the prompt in a Unity build - a shell check too - with its text kept', () => {
  for (const verify of ['grep -q GameClock Assets/Scripts/GameClock.cs', 'npm test', 'test -f Assets/Scripts/GameClock.cs']) {
    const pkg = { id: 'k', prompt: 'Build it.', verify };
    const out = uv.editorFreeVerify(pkg, 8000);
    assert.equal(out.verify, '', verify);
    assert.ok(out.prompt.startsWith('Build it.\n\n'), verify);
    assert.ok(out.prompt.includes(verify), `${verify}: its former text is in the prompt`);
    assert.ok(out.prompt.endsWith(uv.editorCheckNote(verify)), verify);
    assert.equal(pkg.verify, verify, 'the input is not mutated');
  }
  // A shell check needs no editor: its note does not claim it does.
  const shell = uv.editorCheckNote('grep -q GameClock Assets/Scripts/GameClock.cs');
  assert.match(shell, /^Check: /);
  assert.doesNotMatch(shell, /Unity editor/);
  // An editor-bound one keeps the editor check's text.
  assert.match(uv.editorCheckNote(GAME_CLOCK_VERIFY), /^Editor check: .*against your own Unity editor/);
});

test('editorCheckNote / editorFreeVerify: a noEditor package never opens Unity and lists the check as not run here', () => {
  assert.deepEqual([...uv.CHECK_ROLES], ['editor', 'noEditor']);
  for (const verify of [GAME_CLOCK_VERIFY, 'Open the editor and check the HUD', 'grep -q Hud Assets/Scripts/Hud.cs']) {
    const note = uv.editorCheckNote(verify, 'noEditor');
    assert.match(note, /do not open the Unity editor/i, verify);
    assert.match(note, /not run here/, verify);
    assert.match(note, /after the merge in the live Unity editor/, verify);
    assert.match(note, /usings, asmdef references, method signatures/, verify);
    assert.doesNotMatch(note, /run it yourself|against your own Unity editor/, verify);
    const out = uv.editorFreeVerify({ id: 'hud', prompt: 'Build the HUD.', verify }, 8000, 'noEditor');
    assert.equal(out.verify, '');
    assert.ok(out.prompt.endsWith(note));
  }
  // The default role is today's editor check.
  assert.equal(uv.editorCheckNote(GAME_CLOCK_VERIFY), uv.editorCheckNote(GAME_CLOCK_VERIFY, 'editor'));
});

test('withUnityPlannerRules: verify is always "" in a Unity project; no grep or shell check is suggested; other args stay', () => {
  const out = uv.withUnityPlannerRules({ cwd: '/r', extraPrompt: 'Re-size the packages.' });
  assert.equal(out.cwd, '/r');
  assert.ok(out.extraPrompt.startsWith('Re-size the packages.'));
  assert.match(out.extraPrompt, /Unity project/);
  assert.match(out.extraPrompt, /"verify" is always "" \(empty\)/);
  assert.match(out.extraPrompt, /definition of done/);
  assert.match(out.extraPrompt, /live Unity editor/);
  const rules = uv.UNITY_PLANNER_RULES.join('\n');
  assert.doesNotMatch(rules, /grep|test -f|\[ -f|static check/i, 'no shell check is offered as an alternative');
  assert.doesNotMatch(rules, /leave it empty \(""\), or/, 'empty is the only verify');
  assert.equal(uv.withUnityPlannerRules({}).extraPrompt, rules);
});

// ---- self-check side: the gate before the push to main -------------------------

test('selfCheckCommandOf: a non-Unity run keeps its command, else the npm test fallback, exactly as before', () => {
  const plain = (command) => uv.selfCheckCommandOf({ command, build: null, unityDir: false, fallback: 'npm test' });
  assert.deepEqual(plain('npm run check'), { checkCommand: 'npm run check' });
  assert.deepEqual(plain('  npm run check  '), { checkCommand: 'npm run check' });
  assert.deepEqual(plain(''), { checkCommand: 'npm test' });
  assert.deepEqual(plain(null), { checkCommand: 'npm test' });
  assert.deepEqual(plain('npm test'), { checkCommand: 'npm test' });
});

test('selfCheckCommandOf: a Unity build never falls back to npm test; God Mode\'s default reads as no command', () => {
  const unity = (command, build, unityDir = false) => uv.selfCheckCommandOf({ command, build, unityDir, fallback: 'npm test' });
  // No command at all, or God Mode's default: no check command (tests skipped).
  for (const [cmd, build, dir] of [['', { own: false }], [null, null, true], ['npm test', { own: false }], ['npm test', null, true]]) {
    assert.deepEqual(unity(cmd, build, dir), { checkCommand: '', unity: { own: false } }, String(cmd));
  }
  // God Mode's own 'Final check command' when set to something else: kept, read by its shape.
  assert.deepEqual(unity('unity command test run', { own: false }), { checkCommand: 'unity command test run', unity: { own: false } });
  assert.deepEqual(unity('pwsh tools/check.ps1', null, true), { checkCommand: 'pwsh tools/check.ps1', unity: { own: false } });
  // The profile's own command - even `npm test` - is run, read by its output.
  assert.deepEqual(unity('npm test', { own: true }), { checkCommand: 'npm test', unity: { own: true } });
  assert.deepEqual(unity('tools\\check.cmd', { own: true }, true), { checkCommand: 'tools\\check.cmd', unity: { own: true } });
});

test('selfCheckDeferred: God Mode\'s command by shape + output, the profile\'s own by output; never outside a Unity build', () => {
  const missing = { ok: false, output: NO_PIPELINE, timedOut: false };
  // God Mode's command: the deferToUnityEditor rule, unchanged.
  assert.equal(uv.selfCheckDeferred('unity command test run', missing, { own: false }), true);
  assert.equal(uv.selfCheckDeferred('npm test', missing, { own: false }), false, '`npm test` hides what it runs');
  assert.equal(uv.selfCheckDeferred('grep -q X f; unity command test run', missing, { own: false }), false);
  // The profile's own command: the output decides (Mati wrote the command).
  assert.equal(uv.selfCheckDeferred('npm test', missing, { own: true }), true);
  assert.equal(uv.selfCheckDeferred('pwsh tools/check.ps1', missing, { own: true }), true);
  // Any other failure, a timeout, or a green run: never deferred.
  assert.equal(uv.selfCheckDeferred('npm test', { ok: false, output: `not ok 1 - clock\n${NO_PIPELINE}` }, { own: true }), false);
  assert.equal(uv.selfCheckDeferred('npm test', { ok: false, output: 'Error: Cannot find module' }, { own: true }), false);
  assert.equal(uv.selfCheckDeferred('unity command test run', { ...missing, timedOut: true }, { own: false }), false);
  assert.equal(uv.selfCheckDeferred('unity command test run', { ok: true, output: NO_PIPELINE }, { own: true }), false);
  // Not a Unity build.
  assert.equal(uv.selfCheckDeferred('unity command test run', missing, null), false);
  assert.equal(uv.selfCheckDeferred('unity command test run', missing, undefined), false);
});

test("selfCheckDeferred: the profile's own command stays red when its output shows a real failure next to the no-Pipeline line", () => {
  // A wrapper (pwsh / npm script) that carries on after a failing step and
  // then calls the unity CLI: the no-Pipeline line is last, the real red is above it.
  const genuine = [
    'Assets/Scripts/Clock.cs(3,4): error CS1002: ; expected',
    'Tests failed: 3 of 10 failed',
    'Assertion failed in clock.test',
    'compile failed: 3 errors',
    'Compilation failed with 2 errors',
    "'grep' is not recognized as an internal or external command,",
    'bash: grep: command not found',
    'NullReferenceException: Object reference not set to an instance of an object',
    'FAIL tools/check.test.js',
    'Failed: 2, Passed: 8',
    '2 failing',
  ];
  for (const line of genuine) {
    const result = { ok: false, output: `${line}\n${NO_PIPELINE}` };
    assert.equal(uv.selfCheckDeferred('pwsh tools/check.ps1', result, { own: true }), false, line);
    assert.equal(uv.selfCheckDeferred('npm test', result, { own: true }), false, line);
  }
  // The wrapper's own exit noise and passing counts are not a failure of their own.
  const noise = [
    `> game@1.0.0 test\n> unity command test run\n\n${NO_PIPELINE}`,
    `${NO_PIPELINE}\nnpm error Lifecycle script \`test\` failed with error:\nnpm error code 1\nnpm error command failed`,
    `npm ERR! Test failed.  See above for more details.\n${NO_PIPELINE}`,
    `Build succeeded. 0 Warning(s) 0 Error(s)\nFailed: 0, Passed: 12\n0 failing\n${NO_PIPELINE}`,
  ];
  for (const output of noise) {
    assert.equal(uv.selfCheckDeferred('npm test', { ok: false, output }, { own: true }), true, output);
  }
  // God Mode's command keeps deferToUnityEditor's rule exactly (shape + output).
  const compiled = { ok: false, output: `Assets/Scripts/Clock.cs(3,4): error CS1002: ; expected\n${NO_PIPELINE}` };
  assert.equal(uv.selfCheckDeferred('unity command test run', compiled, { own: false }), uv.deferToUnityEditor('unity command test run', compiled));
});

test('UNITY_FIXUP_RULE forbids a package.json, *.cmd shims and wrapper scripts made to pass the check', () => {
  assert.match(uv.UNITY_FIXUP_RULE, /package\.json/);
  assert.match(uv.UNITY_FIXUP_RULE, /\*\.cmd/);
  assert.match(uv.UNITY_FIXUP_RULE, /wrapper scripts/);
  assert.match(uv.UNITY_FIXUP_RULE, /LUNA_BLOCKED selfcheck/);
});
