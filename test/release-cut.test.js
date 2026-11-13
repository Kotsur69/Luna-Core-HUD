// ============================================================================
// LunaCore - release cut (src/releaseCut.js) and its two ways in:
//   - the post-merge 'release' step ("Create a new release after finish",
//     orchestraFinalize.js releaseGate + orchestraPostMerge.js)
//   - "Release now" (orchestra:release-now in src/orchestraFinishIpc.js)
// git, gh, npm and the file system are fakes: nothing is pushed, built or
// published, and no real repo is touched.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const release = require('../src/releaseCut.js');
const { createFinalizer, releaseGate, postMergeContext, POST_MERGE_STEPS } = require('../src/orchestraFinalize.js');
const { createPostMergeServices } = require('../src/orchestraPostMerge.js');
const { buildReport } = require('../src/orchestraReport.js');
const finishIpc = require('../src/orchestraFinishIpc.js');

const REPO = path.resolve('/repo');
const LANDED = 'c'.repeat(40);
const HEAD_SHA = 'a1'.repeat(20);
const RELEASE_SHA = 'b2'.repeat(20);
const MOVED_SHA = 'd4'.repeat(20);
const README = [
  '# LunaCore',
  '',
  'Intro line.',
  '',
  '> **Current release: v0.20.0 — two accounts, one God Mode.**',
  '> - **Account failover:** store several Claude logins.',
  '>',
  '> **v0.19.0 — Luna\'s Work goes from build to launch.**',
  '> - Staging.',
  '',
  '## Rest',
  '',
].join('\n');
const SUBJECTS = [
  'feat: release after finish',
  'chore: luna wip',
  'fix(report): keep the email line',
  "Merge branch 'luna/x' into main",
  'docs: readme typo',
  'feat(gm): resend the report email',
];

/**
 * Fake git / gh / npm / fs. `opts` flips single answers to model a refusal.
 * Every call is logged as a string ('git status --porcelain', 'npm test', ...).
 */
function fakeTools(opts = {}) {
  const files = new Map([
    [path.join(REPO, 'package.json'), JSON.stringify({ name: 'lunacore', version: opts.version || '0.20.0', scripts: opts.scripts || { test: 'node --test', dist: 'electron-builder --win' } })],
    [path.join(REPO, 'package-lock.json'), '{"version":"0.20.0"}'],
    [path.join(REPO, 'README.md'), README],
  ]);
  const calls = [];
  const writes = [];
  const subjects = opts.subjects || SUBJECTS;
  let head = HEAD_SHA;
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
  const no = (stderr = 'failed', code = 1) => ({ ok: false, code, stdout: '', stderr });
  const fs = {
    readFileSync: (f) => {
      if (!files.has(f)) throw Object.assign(new Error(`ENOENT ${f}`), { code: 'ENOENT' });
      return files.get(f);
    },
    writeFileSync: (f, text) => {
      writes.push(f);
      files.set(f, String(text));
    },
    existsSync: (f) => files.has(f),
    lstatSync: (f) => {
      if (!files.has(f)) throw Object.assign(new Error(`ENOENT ${f}`), { code: 'ENOENT' });
      return { isFile: () => !(opts.linkedAsset && f.endsWith(opts.linkedAsset)) };
    },
    copyFileSync: (from, to) => {
      calls.push(`copy ${path.basename(from)} -> ${path.basename(to)}`);
      files.set(to, files.get(from));
    },
  };
  const gitAnswer = (args) => {
    const [cmd, ...rest] = args;
    const line = args.join(' ');
    if (cmd === 'status') return ok(opts.dirty ? ' M src/main.js\n' : '');
    if (cmd === 'symbolic-ref') return ok(`${opts.branch || 'main'}\n`);
    if (cmd === 'merge-base') return opts.notLanded ? no('') : ok();
    if (cmd === 'fetch') return opts.fetchFails ? no('fatal: unable to access https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r') : ok();
    if (cmd === 'rev-parse' && rest[0] === 'HEAD') return ok(`${head}
`);
    if (cmd === 'rev-list' && rest[1].startsWith('HEAD..')) return ok(`${opts.behind || 0}\n`);
    if (cmd === 'describe') return opts.noTag ? no('fatal: No names found') : ok('v0.20.0\n');
    if (cmd === 'rev-list') return ok(`${opts.count === undefined ? subjects.length : opts.count}\n`);
    if (cmd === 'log') return ok(`${subjects.join('\n')}\n`);
    if (cmd === 'rev-parse') return opts.tagExists ? ok('deadbeef\n') : no('');
    if (cmd === 'push' && opts.pushFails) return no('! [rejected] main -> main (non-fast-forward)');
    if (cmd === 'commit') head = RELEASE_SHA;
    if (['add', 'commit', 'tag', 'push'].includes(cmd)) return ok();
    return no(`unexpected git ${line}`);
  };
  const exec = async (bin, args, o) => {
    if (bin === 'git') {
      assert.deepEqual(args.slice(0, 2), ['-C', REPO]);
      calls.push(`git ${args.slice(2).join(' ')}`);
      return gitAnswer(args.slice(2));
    }
    calls.push(`${bin} ${args.join(' ')}`);
    assert.equal(o.cwd, REPO);
    if (bin === 'gh' && args[0] === 'auth') {
      if (opts.noGh) return { ok: false, code: 'ENOENT', stdout: '', stderr: '' };
      return opts.noAuth ? no('You are not logged into any GitHub hosts.') : ok('Logged in');
    }
    if (bin === 'gh' && args[0] === 'release') return ok('https://github.com/Kotsur69/Luna-Core-HUD/releases/tag/v0.21.0\n');
    return no(`unexpected ${bin}`);
  };
  const shell = async (command, o) => {
    calls.push(command);
    assert.equal(o.cwd, REPO);
    if (command === 'npm test') {
      if (opts.moved) head = MOVED_SHA;
      return { ok: !opts.redTests, output: opts.redTests ? '# fail 2' : '# pass 10', timedOut: false };
    }
    const bump = /^npm version (\S+) --no-git-tag-version$/.exec(command);
    if (bump) {
      const pkg = JSON.parse(files.get(path.join(REPO, 'package.json')));
      files.set(path.join(REPO, 'package.json'), JSON.stringify({ ...pkg, version: bump[1] }));
      return { ok: true, output: `v${bump[1]}`, timedOut: false };
    }
    if (command === 'npm run dist') {
      const v = JSON.parse(files.get(path.join(REPO, 'package.json'))).version;
      const dist = (name) => path.join(REPO, 'dist', name);
      files.set(dist(`LunaCore Setup ${v}.exe`), 'EXE');
      files.set(dist(`LunaCore Setup ${v}.exe.blockmap`), 'MAP');
      files.set(dist(`LunaCore-${v}-portable.exe`), 'PORTABLE');
      files.set(dist('latest.yml'), opts.badLatest ? `path: LunaCore Setup ${v}.exe\n` : `version: ${v}\nfiles:\n  - url: LunaCore-Setup-${v}.exe\npath: LunaCore-Setup-${v}.exe\n`);
      return { ok: true, output: 'built', timedOut: false };
    }
    return { ok: false, output: `unexpected ${command}`, timedOut: false };
  };
  return { deps: { exec, shell, fs }, calls, writes, files };
}

const cut = (tools, over = {}) => release.cutRelease({ repoPath: REPO, base: 'main', landedSha: LANDED, ...over }, tools.deps);

const assertNothingChanged = (tools) => {
  assert.deepEqual(tools.writes, [], 'no file written');
  for (const c of tools.calls) {
    assert.ok(!/^git (add|commit|tag|push)\b/.test(c), `unexpected ${c}`);
    assert.ok(!/^npm (version|run dist)/.test(c), `unexpected ${c}`);
    assert.ok(!/^gh release/.test(c), `unexpected ${c}`);
  }
};

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test('version bump: minor when any feat: since the last tag, else patch', () => {
  assert.equal(release.nextVersion('0.20.0', ['fix: a', 'feat(x): b']), '0.21.0');
  assert.equal(release.nextVersion('0.20.3', ['fix: a', 'docs: b']), '0.20.4');
  assert.equal(release.nextVersion('1.4.2', ['feat!: breaking']), '1.5.0');
  // A feat only inside a merge subject or a wip commit does not count.
  assert.equal(release.nextVersion('0.20.0', ["Merge branch 'feat: x'", 'chore: luna wip']), '0.20.1');
  assert.equal(release.nextVersion('v0.20.0', ['feat: a']), null);
  assert.equal(release.nextVersion('0.20', ['feat: a']), null);
});

test('notes: feat/fix subjects only, wip commits and merges left out, prefixes stripped', () => {
  const notes = release.buildNotes(SUBJECTS);
  assert.deepEqual(notes.features, ['release after finish', 'resend the report email']);
  assert.deepEqual(notes.fixes, ['keep the email line']);
  assert.equal(release.releaseTitle(notes), 'release after finish');
  assert.equal(release.releaseTitle({ features: [], fixes: ['Stop the chip stretching.'] }), 'stop the chip stretching');
  assert.equal(release.releaseTitle({ features: [], fixes: [] }), 'maintenance release');
  assert.ok(release.isSkippedSubject('chore: luna wip'));
  assert.ok(release.isSkippedSubject("Merge pull request #4 from x"));
});

test('README: new current block on top, the previous one demoted, its dash kept', () => {
  const notes = release.buildNotes(SUBJECTS);
  const out = release.updateReadme(README, '0.21.0', 'release after finish', notes);
  const lines = out.split('\n');
  const at = lines.indexOf('> **Current release: v0.21.0 — release after finish.**');
  assert.equal(at, 4);
  assert.deepEqual(lines.slice(at + 1, at + 4), ['> - release after finish', '> - resend the report email', '> - Fix: keep the email line']);
  assert.equal(lines[at + 4], '>');
  assert.equal(lines[at + 5], '> **v0.20.0 — two accounts, one God Mode.**');
  assert.equal(out.match(/Current release:/g).length, 1);
  assert.ok(out.includes("> **v0.19.0 — Luna's Work goes from build to launch.**"));
  assert.ok(out.endsWith('## Rest\n'));
});

test('README without a release block gets one under the intro; long bullets wrap', () => {
  const long = 'x '.repeat(60).trim();
  const out = release.updateReadme('# App\n\nIntro.\n\n## Use\n', '1.0.0', 'first', { features: [long], fixes: [] });
  const lines = out.split('\n');
  assert.equal(lines[4], '> **Current release: v1.0.0 - first.**');
  assert.ok(lines[5].startsWith('> - x'));
  assert.ok(lines[6].startsWith('>   x'), 'continuation line indented');
  assert.ok(lines.every((l) => l.length <= 78));
});

test('release notes file and the dist asset names', () => {
  const text = release.releaseNotes('0.21.0', 'release after finish', release.buildNotes(SUBJECTS));
  assert.match(text, /^## LunaCore v0\.21\.0 - release after finish\n\n### Features\n\n- release after finish\n- resend the report email\n\n### Fixes\n\n- keep the email line\n$/);
  assert.deepEqual(release.distAssets('0.21.0'), {
    setup: 'LunaCore Setup 0.21.0.exe',
    setupBlockmap: 'LunaCore Setup 0.21.0.exe.blockmap',
    dashedSetup: 'LunaCore-Setup-0.21.0.exe',
    dashedBlockmap: 'LunaCore-Setup-0.21.0.exe.blockmap',
    portable: 'LunaCore-0.21.0-portable.exe',
    latest: 'latest.yml',
    notes: 'release-notes-v0.21.0.md',
  });
});

// ---------------------------------------------------------------------------
// cutRelease
// ---------------------------------------------------------------------------

test('a release runs exactly the manual steps, in order, and never forces', async () => {
  const tools = fakeTools();
  const res = await cut(tools);
  assert.deepEqual(res, {
    ok: true,
    version: '0.21.0',
    tag: 'v0.21.0',
    title: 'release after finish',
    url: 'https://github.com/Kotsur69/Luna-Core-HUD/releases/tag/v0.21.0',
  });
  const order = (needle) => tools.calls.findIndex((c) => c.startsWith(needle));
  const steps = [
    'git status --porcelain',
    'git merge-base --is-ancestor',
    'git fetch --quiet origin refs/heads/main:refs/remotes/origin/main',
    'gh auth status',
    'npm test',
    'npm version 0.21.0 --no-git-tag-version',
    'git add -- package.json README.md package-lock.json',
    'git commit',
    'git tag -a v0.21.0',
    `git push origin ${RELEASE_SHA}:refs/heads/main`,
    'git push origin refs/tags/v0.21.0',
    'npm run dist',
    'copy LunaCore Setup 0.21.0.exe -> LunaCore-Setup-0.21.0.exe',
    'copy LunaCore Setup 0.21.0.exe.blockmap -> LunaCore-Setup-0.21.0.exe.blockmap',
    'gh release create v0.21.0',
  ];
  const at = steps.map(order);
  assert.ok(at.every((i) => i >= 0), `missing step: ${steps[at.indexOf(-1)]}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps in order');

  assert.ok(tools.calls.includes(`git tag -a v0.21.0 -m v0.21.0 - release after finish ${RELEASE_SHA}`), 'the tag names the release commit');
  assert.match(tools.files.get(path.join(REPO, 'dist', 'release-notes-v0.21.0.md')), /^## LunaCore v0.21.0/);
  const commit = tools.calls.find((c) => c.startsWith('git commit'));
  assert.equal(commit, `git commit -m chore(release): v0.21.0 - release after finish -m ${release.CO_AUTHOR}`);
  const gh = tools.calls.find((c) => c.startsWith('gh release'));
  assert.equal(
    gh,
    [
      'gh release create v0.21.0 --title LunaCore v0.21.0 --notes-file',
      path.join('dist', 'release-notes-v0.21.0.md'),
      '--latest',
      path.join('dist', 'latest.yml'),
      path.join('dist', 'LunaCore-0.21.0-portable.exe'),
      path.join('dist', 'LunaCore-Setup-0.21.0.exe'),
      path.join('dist', 'LunaCore-Setup-0.21.0.exe.blockmap'),
    ].join(' '),
  );
  for (const c of tools.calls) {
    assert.ok(!/(^|\s)(--force|-f|--force-with-lease)(\s|$)/.test(c), `forced: ${c}`);
    assert.ok(!/^git (reset|stash|checkout|clean)\b/.test(c), `unexpected: ${c}`);
  }
  assert.match(tools.files.get(path.join(REPO, 'README.md')), /^> \*\*Current release: v0\.21\.0 — release after finish\.\*\*$/m);
  assert.equal(JSON.parse(tools.files.get(path.join(REPO, 'package.json'))).version, '0.21.0');
  assert.equal(tools.files.get(path.join(REPO, 'dist', 'LunaCore-Setup-0.21.0.exe')), 'EXE');
});

test('patch release when only fixes came since the last tag', async () => {
  const tools = fakeTools({ subjects: ['fix: one', 'chore: luna wip'] });
  const res = await cut(tools);
  assert.equal(res.version, '0.20.1');
  assert.ok(tools.calls.includes('npm version 0.20.1 --no-git-tag-version'));
});

test('refusals: nothing is written, committed, tagged, pushed, built or published', async () => {
  const cases = [
    [{ dirty: true }, {}, 'uncommitted changes'],
    [{ redTests: true }, {}, 'tests failed'],
    [{ noAuth: true }, {}, 'gh not authenticated (gh auth login)'],
    [{ noGh: true }, {}, 'gh not installed'],
    [{ notLanded: true }, {}, 'run not landed on base'],
    [{}, { landedSha: null }, 'run not landed on base'],
    [{ scripts: { test: 'node --test' } }, {}, 'no dist script in package.json'],
    [{ branch: 'feature' }, {}, 'not on main'],
    [{ behind: 2 }, {}, 'local main is behind origin'],
    [{ count: 0 }, {}, 'nothing new since v0.20.0'],
    [{ noTag: true }, {}, 'no previous v* tag'],
    [{ tagExists: true }, {}, 'v0.21.0 already exists'],
    [{ fetchFails: true }, {}, 'could not fetch origin/main'],
    [{ moved: true }, {}, 'main moved during the tests'],
    [{}, { base: '--upload-pack=x' }, 'bad base branch'],
    [{}, { repoPath: 'relative/repo' }, 'no repo'],
  ];
  for (const [opts, over, reason] of cases) {
    const tools = fakeTools(opts);
    const res = await cut(tools, over);
    assert.equal(res.ok, false, reason);
    assert.equal(res.refused, true, reason);
    assert.equal(res.reason, reason);
    assertNothingChanged(tools);
  }
});

test('red tests are checked before any change; a dirty tree before the tests run', async () => {
  const red = fakeTools({ redTests: true });
  await cut(red);
  assert.ok(red.calls.includes('npm test'));
  const dirty = fakeTools({ dirty: true });
  await cut(dirty);
  assert.ok(!dirty.calls.includes('npm test'), 'no test run on a dirty tree');
});

test('latest.yml not naming the dashed setup stops before gh release', async () => {
  const tools = fakeTools({ badLatest: true });
  const res = await cut(tools);
  assert.equal(res.ok, false);
  assert.equal(res.refused, false);
  assert.equal(res.stage, 'assets');
  assert.ok(!tools.calls.some((c) => c.startsWith('gh release')));
});

test('a rejected push is a failure with its stage, never retried with force', async () => {
  const tools = fakeTools({ pushFails: true });
  const res = await cut(tools);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'push');
  assert.equal(tools.calls.filter((c) => c.startsWith('git push')).length, 1);
  assert.ok(!tools.calls.includes('npm run dist'));
});

test('releaseResult: released / skipped (refusal) / error', () => {
  assert.deepEqual(release.releaseResult({ ok: true, version: '0.21.0', tag: 'v0.21.0', title: 't', url: 'u' }), {
    released: true, version: '0.21.0', tag: 'v0.21.0', title: 't', url: 'u',
  });
  assert.deepEqual(release.releaseResult({ ok: false, refused: true, stage: 'tests', reason: 'tests failed' }), { skipped: 'tests failed' });
  assert.deepEqual(release.releaseResult({ ok: false, refused: false, stage: 'push', reason: 'rejected' }), { error: 'push: rejected' });
});

test('unreleasedCount: commits since the last v* tag, read-only', async () => {
  const tools = fakeTools({ count: 7 });
  assert.deepEqual(await release.unreleasedCount(REPO, tools.deps), { ok: true, tag: 'v0.20.0', count: 7 });
  assert.deepEqual(await release.unreleasedCount(REPO, fakeTools({ noTag: true }).deps), { ok: false, reason: 'no previous v* tag' });
  assertNothingChanged(tools);
});

// ---------------------------------------------------------------------------
// After finish: the post-merge release step
// ---------------------------------------------------------------------------

test('releaseGate: ticked only, once per run, never on a red self-check', () => {
  const done = [{ id: 'core', state: 'pushed', merged: true, skipped: false }];
  const ctx = (over) => ({ options: { releaseAfter: true }, previous: {}, selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped' }, packages: done, ...over });
  assert.equal(releaseGate(ctx()), true);
  assert.equal(releaseGate(ctx({ options: {} })), false);
  assert.equal(releaseGate(ctx({ previous: { release: { released: true } } })), false);
  assert.equal(releaseGate(ctx({ previous: { release: { skipped: 'tests failed' } } })), true, 'a skipped release may run again');
  assert.equal(releaseGate(ctx({ selfCheck: { tests: 'failed' } })), 'self-check failed');
  assert.equal(releaseGate(ctx({ selfCheck: null })), 'self-check did not run');
  assert.equal(releaseGate(ctx({ selfCheck: { tests: 'skipped', syntax: 'ok', smoke: 'ok' } })), 'self-check tests did not run');
  assert.deepEqual(POST_MERGE_STEPS.map((s) => s.name), ['localBase', 'cleanup', 'supabase', 'release']);
});

test('releaseGate: an unfinished run is skipped with a reason, never released', () => {
  const ok = { selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'ok' }, options: { releaseAfter: true }, previous: {} };
  const pkg = (id, state, merged, skipped = false) => ({ id, state, merged, skipped });
  const merged = pkg('core', 'pushed', true);
  for (const other of [
    pkg('ui', 'stalled', false),
    pkg('ui', 'failed', false),
    pkg('ui', 'pending', false),
    pkg('ui', 'launched', false),
    pkg('ui', 'finishing', false),
    pkg('ui', 'killed', false),
    pkg('ui', 'closed', false),
    // Pushed, but skipped from this merge pass (conflict / red verify).
    pkg('ui', 'pushed', false, true),
    // Pushed, not merged yet (no pass took it).
    pkg('ui', 'pushed', false),
  ]) {
    assert.equal(releaseGate({ ...ok, packages: [merged, other] }), 'run not finished: 1 package(s) not merged (ui)', `${other.state}`);
  }
  assert.equal(
    releaseGate({ ...ok, packages: [pkg('a', 'stalled', false), pkg('b', 'pending', false), merged] }),
    'run not finished: 2 package(s) not merged (a, b)',
  );
  assert.equal(releaseGate({ ...ok, packages: [] }), 'run not finished: no packages');
  assert.equal(releaseGate({ ...ok, packages: undefined }), 'run not finished: no packages');
  // The tick and the once-per-run guard still come first.
  assert.equal(releaseGate({ ...ok, options: {}, packages: [pkg('ui', 'stalled', false)] }), false);
  assert.equal(releaseGate({ ...ok, previous: { release: { released: true } }, packages: [pkg('ui', 'stalled', false)] }), false);
  // Every package merged (in this or an earlier pass): released.
  assert.equal(releaseGate({ ...ok, packages: [merged, pkg('ui', 'pushed', true)] }), true);
});

function finalizePlan(over = {}) {
  return {
    id: 'pabc123',
    projectId: 'proj1',
    repoPath: REPO,
    baseBranch: 'main',
    integrationMode: 'merge',
    workerModel: 'opus',
    permissionMode: 'bypassPermissions',
    notes: '',
    approvalLog: [],
    options: { releaseAfter: true },
    integration: { state: 'idle', error: null, detail: null, at: null, selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped', fixups: 0, tail: '' } },
    packages: [
      { id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core-ab12c', dependsOn: [], verify: 'npm test', merged: false },
      { id: 'ui', title: 'UI', state: 'pushed', branch: 'luna/ui-cd34e', dependsOn: [], verify: 'npm test', merged: false },
    ],
    ...over,
  };
}

function runFinalize(plan, integrateMerge, impl) {
  const order = [];
  const reports = [];
  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => Object.assign(plan.packages.find((p) => p.id === id), fields),
    commit: () => {},
    view: () => ({ ...plan, packages: plan.packages.map((p) => ({ ...p })), integration: { ...plan.integration } }),
    onRunEvent: () => {},
    now: () => 5000,
    integrateMerge,
    writeReport: (_id, text) => reports.push(text),
    postMerge: {
      updateLocalBase: async () => (order.push('localBase'), { updated: true, from: 'a'.repeat(40), to: LANDED }),
      cleanupMergedRun: async () => (order.push('cleanup'), { worktree: 'none', deleted: [], kept: [] }),
      releaseAfterMerge: async (ctx) => (order.push('release'), impl(ctx)),
    },
    sleep: async () => {},
  });
  return { finalizer, order, reports };
}

const landed = (skipped = []) => async () => ({ ok: true, merged: ['core', 'ui'].filter((id) => !skipped.some((s) => s.id === id)), skipped, headSha: LANDED });

test('ticked: after merge + local base update the release runs once and lands in the report', async () => {
  const plan = finalizePlan();
  const seen = [];
  const { finalizer, order, reports } = runFinalize(plan, landed(), (ctx) => {
    seen.push(ctx);
    return { released: true, version: '0.21.0', tag: 'v0.21.0', url: 'https://github.com/o/r/releases/tag/v0.21.0' };
  });
  await finalizer.finalize();
  assert.deepEqual(order, ['localBase', 'cleanup', 'release']);
  assert.equal(seen[0].headSha, LANDED);
  assert.equal(seen[0].results.localBase.updated, true);
  assert.equal(plan.integration.postMerge.release.released, true);
  assert.match(reports[reports.length - 1], /- Released `v0\.21\.0`: https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.21\.0/);

  // A second pass (more merges) does not release again.
  plan.packages.push({ id: 'late', title: 'Late', state: 'pushed', branch: 'luna/late-1', dependsOn: [], verify: 'npm test', merged: false });
  const again = runFinalize(plan, async () => ({ ok: true, merged: ['late'], skipped: [], headSha: LANDED }), () => assert.fail('released twice'));
  await again.finalizer.finalize();
  assert.deepEqual(again.order, ['localBase', 'cleanup']);
});

test('a partial run (a package skipped from the merge) does not release; a failed run or an unticked one does not either', async () => {
  const partial = runFinalize(finalizePlan(), landed([{ id: 'ui', stage: 'conflict', detail: 'x', files: [] }]), () => assert.fail('released a partial run'));
  await partial.finalizer.finalize();
  assert.deepEqual(partial.order, ['localBase', 'cleanup']);
  assert.equal(partial.finalizer.isRunning(), false);
  assert.match(partial.reports[partial.reports.length - 1], /- Release skipped: run not finished: 1 package\(s\) not merged \(ui\)/);

  const failed = runFinalize(finalizePlan(), async () => ({ ok: false, merged: [], skipped: [], stage: 'verify', detail: 'red' }), () => assert.fail('released a failed run'));
  await failed.finalizer.finalize();
  assert.deepEqual(failed.order, []);

  const off = runFinalize(finalizePlan({ options: {} }), landed(), () => assert.fail('released without the tick'));
  await off.finalizer.finalize();
  assert.deepEqual(off.order, ['localBase', 'cleanup']);
});

test('a stalled run merges what is done but releases only once a later pass finishes the run', async () => {
  // "Finish run" while one package is stalled: the pushed one merges, no release.
  const plan = finalizePlan();
  plan.packages[1] = { ...plan.packages[1], state: 'stalled', error: 'noMarker' };
  const first = runFinalize(plan, async () => ({ ok: true, merged: ['core'], skipped: [], headSha: LANDED }), () => assert.fail('released a stalled run'));
  await first.finalizer.finalize();
  assert.deepEqual(first.order, ['localBase', 'cleanup']);
  assert.equal(plan.packages[0].merged, true);
  assert.deepEqual(plan.integration.postMerge.release.skipped, 'run not finished: 1 package(s) not merged (ui)');
  assert.notEqual(plan.integration.postMerge.release.released, true);

  // Retry -> the stalled one pushes; the next pass merges it and the run is complete.
  plan.packages[1] = { ...plan.packages[1], state: 'pushed', error: null };
  let releases = 0;
  const second = runFinalize(plan, async () => ({ ok: true, merged: ['ui'], skipped: [], headSha: LANDED }), () => {
    releases += 1;
    return { released: true, version: '0.22.0', tag: 'v0.22.0', url: 'u' };
  });
  await second.finalizer.finalize();
  assert.deepEqual(second.order, ['localBase', 'cleanup', 'release']);
  assert.equal(releases, 1);
  assert.equal(plan.integration.postMerge.release.released, true);

  // A further pass never releases the same run again.
  plan.packages.push({ id: 'late', title: 'Late', state: 'pushed', branch: 'luna/late-1', dependsOn: [], verify: 'npm test', merged: false });
  const third = runFinalize(plan, async () => ({ ok: true, merged: ['late'], skipped: [], headSha: LANDED }), () => assert.fail('released twice'));
  await third.finalizer.finalize();
  assert.deepEqual(third.order, ['localBase', 'cleanup']);
});

test('postMergeContext carries each package state for the release gate', () => {
  const plan = finalizePlan();
  plan.packages[0] = { ...plan.packages[0], merged: true };
  plan.packages[1] = { ...plan.packages[1], state: 'stalled' };
  const ctx = postMergeContext(plan, { skipped: [{ id: 'ui' }], headSha: LANDED }, 'pabc123');
  assert.deepEqual(ctx.packages.map((p) => [p.id, p.state, p.merged, p.skipped]), [
    ['core', 'pushed', true, false],
    ['ui', 'stalled', false, true],
  ]);
});

test('createPostMergeServices releases only the landed head and maps the answer', async () => {
  const asked = [];
  const services = createPostMergeServices({
    release: async (opts) => (asked.push(opts), { ok: false, refused: true, stage: 'status', reason: 'uncommitted changes' }),
  });
  const result = await services.impls.releaseAfterMerge({ repoPath: REPO, base: 'main', headSha: LANDED });
  assert.deepEqual(asked, [{ repoPath: REPO, base: 'main', landedSha: LANDED }]);
  assert.deepEqual(result, { skipped: 'uncommitted changes' });
});

test('the report says "Release skipped" / "Released" from the stored step result', () => {
  const view = (release) => ({ id: 'p1', repoPath: '/r', baseBranch: 'main', packages: [], integration: { state: 'done', postMerge: { release } } });
  assert.match(buildReport(view({ skipped: 'gh not authenticated (gh auth login)' }), { now: 1 }), /- Release skipped: gh not authenticated/);
  assert.match(buildReport(view({ released: true, tag: 'v1.2.0', url: 'https://github.com/o/r/releases/tag/v1.2.0' }), { now: 1 }), /- Released `v1\.2\.0`: https/);
  assert.match(buildReport(view({ released: true, tag: 'v1.2.0', url: 'javascript:alert(1)' }), { now: 1 }), /- Released `v1\.2\.0`: no release URL/);
});

// ---------------------------------------------------------------------------
// Release now (IPC) - the project id is never trusted
// ---------------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map();
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

function releaseIpc(over = {}) {
  const log = { cuts: [], recorded: [], appended: [], confirms: [] };
  const target = {
    planId: 'pabc123', projectId: 'luna', repoPath: REPO, base: 'main', headSha: LANDED,
    landed: true, releaseAfter: false, released: false, busy: false, ...(over.target || {}),
  };
  const ipcMain = fakeIpcMain();
  finishIpc.register(ipcMain, {
    runsDir: () => null,
    resendRunEmail: async () => ({ ok: false }),
    projects: () => [{ id: 'luna', path: REPO }, { id: 'other', path: path.resolve('/other') }],
    releaseTarget: () => (over.noRun ? null : target),
    unreleasedCount: async () => ({ ok: true, count: 4, tag: 'v0.20.0' }),
    cutRelease: over.cutRelease || (async (opts) => (log.cuts.push(opts), { ok: true, version: '0.21.0', tag: 'v0.21.0', url: 'https://github.com/o/r/releases/tag/v0.21.0' })),
    releaseResult: release.releaseResult,
    recordRelease: (planId, result) => log.recorded.push([planId, result]),
    appendReport: (planId, line) => log.appended.push([planId, line]),
    confirmRelease: async (info) => (log.confirms.push(info), over.declined !== true),
  });
  return { ipcMain, log };
}

test('release now: unknown or foreign project ids, no landed run, already released are refused', async () => {
  for (const bad of [null, 7, '', '../luna', 'nope', 'x'.repeat(101)]) {
    const { ipcMain, log } = releaseIpc();
    assert.deepEqual(await ipcMain.call('orchestra:release-now', bad), { ok: false, reason: 'unknownProject' }, String(bad));
    assert.equal(log.cuts.length, 0);
  }
  const cases = [
    [{}, 'other', 'noRun'],
    [{ noRun: true }, 'luna', 'noRun'],
    [{ target: { landed: false } }, 'luna', 'run not landed on base'],
    [{ target: { released: true } }, 'luna', 'already released'],
    [{ target: { busy: true } }, 'luna', 'busy'],
    [{ target: { repoPath: path.resolve('/elsewhere') } }, 'luna', 'noRun'],
  ];
  for (const [over, id, reason] of cases) {
    const { ipcMain, log } = releaseIpc(over);
    assert.deepEqual(await ipcMain.call('orchestra:release-now', id), { ok: false, reason }, reason);
    assert.equal(log.cuts.length, 0);
    assert.equal(log.confirms.length, 0);
  }
});

test('release now asks natively first; declined means nothing runs', async () => {
  const declined = releaseIpc({ declined: true });
  assert.deepEqual(await declined.ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'declined' });
  assert.deepEqual(declined.log.confirms, [{ base: 'main', count: 4 }]);
  assert.equal(declined.log.cuts.length, 0);
});

test('release now cuts the landed head, records the result on the run and in its report', async () => {
  const { ipcMain, log } = releaseIpc();
  const res = await ipcMain.call('orchestra:release-now', 'luna');
  assert.deepEqual(res, { ok: true, version: '0.21.0', tag: 'v0.21.0', url: 'https://github.com/o/r/releases/tag/v0.21.0' });
  assert.deepEqual(log.cuts, [{ repoPath: REPO, base: 'main', landedSha: LANDED }]);
  assert.equal(log.recorded[0][0], 'pabc123');
  assert.equal(log.recorded[0][1].released, true);
  assert.deepEqual(log.appended, [['pabc123', '- Released v0.21.0: https://github.com/o/r/releases/tag/v0.21.0']]);

  const refused = releaseIpc({ cutRelease: async () => ({ ok: false, refused: true, stage: 'tests', reason: 'tests failed' }) });
  assert.deepEqual(await refused.ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'tests failed' });
  assert.deepEqual(refused.log.recorded[0][1], { skipped: 'tests failed' });
  assert.deepEqual(refused.log.appended[0][1], '- Release skipped: tests failed');
});

test('release now runs one at a time', async () => {
  let finish;
  const { ipcMain } = releaseIpc({ cutRelease: () => new Promise((r) => (finish = r)) });
  const first = ipcMain.call('orchestra:release-now', 'luna');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'busy' });
  finish({ ok: false, refused: true, stage: 'gh', reason: 'gh not installed' });
  assert.deepEqual(await first, { ok: false, reason: 'gh not installed' });
});

test('unreleased count: registered projects only', async () => {
  const { ipcMain } = releaseIpc();
  assert.deepEqual(await ipcMain.call('orchestra:unreleased-count', 'luna'), { ok: true, count: 4, tag: 'v0.20.0' });
  assert.deepEqual(await ipcMain.call('orchestra:unreleased-count', '../luna'), { ok: false, reason: 'unknownProject' });
  assert.deepEqual(await ipcMain.call('orchestra:unreleased-count', { id: 'luna' }), { ok: false, reason: 'unknownProject' });
});

// ---------------------------------------------------------------------------
// Hardening (security review)
// ---------------------------------------------------------------------------

test('tool output that reaches the board is redacted', async () => {
  assert.equal(release.redact('fatal: https://bob:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r'), 'fatal: https://***@github.com/o/r');
  assert.equal(release.redact('token github_pat_ABCDEFGHIJKLMNOPQRSTUV_xyz leaked'), 'token *** leaked');
  const tools = fakeTools({ pushFails: true });
  const res = await cut(tools);
  assert.equal(res.stage, 'push');
  assert.doesNotMatch(res.reason, /ghp_|github_pat_/);
});

test('a dist asset that is a link is never copied or published', async () => {
  const tools = fakeTools({ linkedAsset: 'latest.yml' });
  const res = await cut(tools);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'assets');
  assert.match(res.reason, /latest\.yml missing or not a regular file/);
  assert.ok(!tools.calls.some((c) => c.startsWith('gh release') || c.startsWith('copy ')));
});

test('commit subjects lose bidi / zero-width characters before the README and the commit', () => {
  const notes = release.buildNotes(['feat: safe\u202Etxt.exe name\u200Bhere']);
  assert.equal(notes.features[0], 'safe txt.exe name here');
});

test('after a decline the release dialog does not come back for a while', async () => {
  let clock = 0;
  const confirms = [];
  const ipcMain = fakeIpcMain();
  finishIpc.register(ipcMain, {
    runsDir: () => null,
    resendRunEmail: async () => ({ ok: false }),
    projects: () => [{ id: 'luna', path: REPO }],
    releaseTarget: () => ({ planId: 'pabc123', projectId: 'luna', repoPath: REPO, base: 'main', headSha: LANDED, landed: true, released: false, busy: false }),
    cutRelease: async () => assert.fail('no release after a decline'),
    confirmRelease: async (info) => (confirms.push(info), false),
    now: () => clock,
  });
  assert.deepEqual(await ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'declined' });
  clock += 5000;
  assert.deepEqual(await ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'declined' });
  assert.equal(confirms.length, 1, 'no second dialog inside the cooldown');
  clock += 60 * 1000;
  await ipcMain.call('orchestra:release-now', 'luna');
  assert.equal(confirms.length, 2);
});

test('the run is checked again after the dialog: a changed board cancels the release', async () => {
  let target = { planId: 'pabc123', projectId: 'luna', repoPath: REPO, base: 'main', headSha: LANDED, landed: true, released: false, busy: false };
  const cuts = [];
  const ipcMain = fakeIpcMain();
  finishIpc.register(ipcMain, {
    runsDir: () => null,
    resendRunEmail: async () => ({ ok: false }),
    projects: () => [{ id: 'luna', path: REPO }],
    releaseTarget: () => target,
    cutRelease: async (o) => (cuts.push(o), { ok: true }),
    confirmRelease: async () => {
      // While the dialog is open a finalize starts on the run.
      target = { ...target, busy: true };
      return true;
    },
  });
  assert.deepEqual(await ipcMain.call('orchestra:release-now', 'luna'), { ok: false, reason: 'busy' });
  assert.deepEqual(cuts, []);
});
