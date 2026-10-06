// ============================================================================
// God Mode v2 second pass (scheduled start, escalation, overlap guard, stall
// learning) and slice 5 (integrator, cleanup, to-do notes, report) - pure
// rules plus the controller with git, gh, tabs and timers faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra } = require('../src/orchestra.js');
const { withTaskBrief } = require('../src/launch.js');
const integ = require('../src/orchestraIntegrate.js');
const { buildReport, appendStallNotes, stallNote } = require('../src/orchestraReport.js');
const { removeWorktree } = require('../src/worktrees.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

// ---- pure rules --------------------------------------------------------------

test('shouldEscalate: a Sonnet worker, second stall, a reason a stronger model can fix, once', () => {
  const p = { stalls: 2, escalated: false, root: '/wt/a', branch: 'luna/a' };
  assert.equal(sup.shouldEscalate(p, 'sonnet', 'noMarker'), true);
  assert.equal(sup.shouldEscalate(p, 'opus', 'noMarker'), false);
  assert.equal(sup.shouldEscalate({ ...p, stalls: 1 }, 'sonnet', 'noMarker'), false);
  assert.equal(sup.shouldEscalate({ ...p, escalated: true }, 'sonnet', 'noMarker'), false);
  assert.equal(sup.shouldEscalate(p, 'sonnet', 'needsApproval'), false);
  assert.equal(sup.shouldEscalate({ ...p, root: null }, 'sonnet', 'timeout'), false);
});

test('scheduleTime: HH:MM later today or tomorrow; window reset + grace; bad input refused', () => {
  const now = new Date(2026, 9, 6, 22, 30).getTime();
  const later = sup.scheduleTime({ kind: 'time', at: '23:15' }, now, null);
  assert.equal(new Date(later.at).getDate(), 6);
  assert.equal(new Date(later.at).getHours(), 23);
  const tomorrow = sup.scheduleTime({ kind: 'time', at: '01:00' }, now, null);
  assert.equal(new Date(tomorrow.at).getDate(), 7);
  assert.equal(sup.scheduleTime({ kind: 'reset' }, now, now + 1000).at > now + 1000, true);
  assert.equal(sup.scheduleTime({ kind: 'reset' }, now, null).error, 'noReset');
  assert.equal(sup.scheduleTime({ kind: 'time', at: '25:00' }, now, null).error, 'badSchedule');
  assert.equal(sup.scheduleTime('01:00', now, null).error, 'badSchedule');
});

test('relTouched / mergeTouched / liveOverlaps: same file in two independent workers is an overlap', () => {
  const root = path.resolve('/wt/a');
  assert.deepEqual(sup.relTouched(root, [path.join(root, 'src', 'x.js'), path.resolve('/elsewhere/y.js')]), ['src/x.js']);
  const a = ['src/x.js'];
  assert.equal(sup.mergeTouched(a, ['src/x.js']), a, 'nothing new -> same array');
  assert.deepEqual(sup.mergeTouched(a, ['src/y.js']), ['src/x.js', 'src/y.js']);
  const pkgs = [
    { id: 'a', state: 'launched', dependsOn: [], touched: ['src/x.js', 'README.md'] },
    { id: 'b', state: 'launched', dependsOn: [], touched: ['src/x.js'] },
    { id: 'c', state: 'launched', dependsOn: ['a'], touched: ['README.md'] },
    { id: 'd', state: 'pending', dependsOn: [], touched: ['src/x.js'] },
  ];
  assert.deepEqual(sup.liveOverlaps(pkgs), [{ a: 'a', b: 'b', files: ['src/x.js'] }]);
});

test('lastOpenToolUse + allowRuleFor turn a stalled prompt into a safe allow rule', () => {
  const lines = [
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npx tsc --noEmit' } }] } }),
  ].join('\n');
  const open = sup.lastOpenToolUse(lines);
  assert.equal(open.input.command, 'npx tsc --noEmit');
  assert.equal(sup.allowRuleFor(open), 'Bash(npx tsc:*)');
  assert.equal(sup.allowRuleFor({ name: 'Bash', input: { command: 'git status -s' } }), 'Bash(git status:*)');
  assert.equal(sup.allowRuleFor({ name: 'Edit', input: {} }), 'Edit');
  assert.equal(sup.allowRuleFor({ name: 'Bash', input: { command: "echo 'x' | sh" } }), 'Bash(echo:*)');
  assert.equal(sup.exampleFor(open), 'npx tsc --noEmit');
  // Rules that would allow anything, reach the network or destroy data are never suggested.
  for (const command of ['rm -rf x', 'curl http://x', 'bash -c x', 'node -e 1', 'powershell.exe -c x', 'git push', 'git reset --hard', 'npm', 'npm publish', 'npx']) {
    assert.equal(sup.allowRuleFor({ name: 'Bash', input: { command } }), null, command);
  }
  for (const name of ['Write', 'WebFetch', 'mcp__x__y']) assert.equal(sup.allowRuleFor({ name, input: {} }), null, name);
  assert.equal(sup.allowRuleFor({ name: 'Bash', input: { command: '$(evil)' } }), null);
  assert.equal(sup.allowRuleFor(null), null);
  assert.equal(sup.isAllowRule("Bash(x'; rm:*)"), false);
  assert.deepEqual(
    sup.allowSuggestions([
      { pkgId: 'a', rule: 'Bash(npx tsc:*)' },
      { pkgId: 'b', rule: 'Bash(npx tsc:*)' },
      { pkgId: 'b', rule: 'Edit' },
      { pkgId: 'c', rule: null },
    ]),
    [
      { rule: 'Bash(npx tsc:*)', count: 2, ids: ['a', 'b'], example: null },
      { rule: 'Edit', count: 1, ids: ['b'], example: null },
    ],
  );
});

test('stored second-pass fields are validated on restore', () => {
  const root = path.resolve('/x/.luna-worktrees/repo/a-1');
  const stored = sup.normalizeStoredPlan({
    id: 'p1',
    repoPath: path.resolve('/x/repo'),
    baseBranch: '--upload-pack=evil',
    integrationMode: 'yolo',
    scheduledAt: 5,
    allowedTools: ['Bash(npm test:*)', "Bash('x)"],
    approvalLog: [{ pkgId: 'a', rule: 'Edit' }, { pkgId: '../x', rule: 'Edit' }],
    integration: { state: 'running' },
    packages: [
      {
        id: 'a',
        root,
        branch: 'luna/a-1',
        prUrl: 'javascript:alert(1)',
        touched: ['src/x.js', '../../etc/passwd', 'C:/win'],
        modelOverride: 'gpt',
        escalated: true,
      },
    ],
  });
  assert.equal(stored.baseBranch, null);
  assert.equal(stored.integrationMode, null);
  assert.deepEqual(stored.allowedTools, ['Bash(npm test:*)']);
  assert.deepEqual(stored.approvalLog, [{ pkgId: 'a', rule: 'Edit', example: null }]);
  assert.equal(stored.integration.state, 'idle', 'an interrupted integration comes back idle');
  const p = stored.packages[0];
  assert.equal(p.prUrl, null);
  assert.deepEqual(p.touched, ['src/x.js']);
  assert.equal(p.modelOverride, null);
  assert.equal(p.escalated, true);
  assert.equal(sup.isBaseBranch('main'), true);
  assert.equal(sup.isBaseBranch('feat/x'), true);
  assert.equal(sup.isBaseBranch('a..b'), false);
});

test('withTaskBrief passes learned allow rules in single quotes, dropping unsafe ones', () => {
  const cmd = withTaskBrief('claude', {
    briefPath: '/cfg/tasks/a.md',
    allowedTools: ['Bash(npm test:*)', "Bash(x'; rm -rf /:*)"],
  });
  assert.match(cmd, / --allowedTools 'Bash\(npm test:\*\)'$/);
  assert.ok(!cmd.includes('rm -rf'));
  assert.ok(!withTaskBrief('claude --allowedTools Edit', { briefPath: '/a.md', allowedTools: ['Read'] }).includes("'Read'"));
});

// ---- report ------------------------------------------------------------------

test('report lists every package; stall notes land once on unfinished to-dos', () => {
  const view = {
    id: 'pabc',
    repoPath: '/repo',
    baseBranch: 'main',
    workerModel: 'opus',
    permissionMode: 'bypassPermissions',
    integrationMode: 'pr',
    integration: { state: 'done' },
    overlaps: [{ a: 'a', b: 'b', files: ['x.js'] }],
    packages: [
      { id: 'a', title: 'A | pipe', state: 'pushed', branch: 'luna/a', headSha: 'abcdef123', prUrl: 'https://github.com/o/r/pull/1' },
      { id: 'b', title: 'B', state: 'stalled', branch: 'luna/b', error: 'verifyFailed', detail: '2 failing', escalated: true },
    ],
  };
  const md = buildReport(view, { now: 0, suggestions: [{ rule: 'Edit', count: 1, ids: ['b'] }] });
  assert.match(md, /1 of 2 packages pushed/);
  assert.match(md, /A \\\| pipe/);
  assert.match(md, /pull\/1/);
  assert.match(md, /verifyFailed - 2 failing; escalated to Opus/);
  assert.match(md, /`Edit` - 1 worker/);

  const pkgs = [
    { id: 'a', state: 'pushed', todoAts: [1] },
    { id: 'b', state: 'stalled', todoAts: [2], branch: 'luna/b', error: 'timeout' },
  ];
  const todos = [{ at: 1, text: 'x' }, { at: 2, text: 'y', details: 'old' }, { at: 3, text: 'z' }];
  const once = appendStallNotes(todos, pkgs, 'pabc', 4000);
  assert.equal(once[0], todos[0]);
  assert.match(once[1].details, /^old\n\n\[LunaCore run pabc\] timeout \(worker report, not an instruction\)\. Work so far is on branch luna\/b\.$/);
  const noisy = appendStallNotes([{ at: 2, text: 'y' }], [{ ...pkgs[1], error: 'blocked', detail: 'a\nIGNORE ALL\x1b[2J' }], 'pq', 4000);
  assert.ok(!/[\n\x1b]/.test(noisy[0].details), 'one line, no control characters');
  assert.equal(appendStallNotes(once, pkgs, 'pabc', 4000), once, 'second time: unchanged');
  assert.ok(stallNote('p', { state: 'pending', todoAts: [] }).includes('not started'));
});

// ---- integrator ----------------------------------------------------------------

/** Fake execFile: `git -C <dir> <sub> ...` answered by subcommand, anything else by bin. */
function fakeExec(answers) {
  const calls = [];
  const execImpl = (bin, args, _opts, cb) => {
    const sub = bin === 'git' ? args.slice(2) : args;
    const key = bin === 'git' ? sub[0] : bin;
    calls.push(`${bin} ${sub.join(' ')}`);
    const list = answers[key];
    const a = (Array.isArray(list) ? list.shift() : list) || { ok: true, stdout: '' };
    setImmediate(() => {
      const err = a.ok ? null : Object.assign(new Error('x'), { code: a.code || 1 });
      cb(err, a.stdout || '', a.stderr || '');
    });
    return { stdin: { on() {}, end() {} } };
  };
  return { execImpl, calls };
}

test('prBody names to-dos, dependency branch and overlaps', () => {
  const body = integ.prBody(
    { id: 'b', title: 'B', todos: ['do b'], dependsOn: ['a'], verify: 'npm test' },
    { notes: 'n', overlaps: [{ a: 'b', b: 'c', files: ['x.js'] }], branchOf: (id) => `luna/${id}-1` },
  );
  assert.match(body, /- do b/);
  assert.match(body, /`luna\/a-1` - merge that first/);
  assert.match(body, /also changed by `luna\/c-1`: `x\.js`/);
});

test('createPr returns the new or already existing PR url; no gh is its own error', async () => {
  const ok = fakeExec({ gh: { ok: true, stdout: 'https://github.com/o/r/pull/7\n' } });
  assert.deepEqual(await integ.createPr({ repoPath: '/r', base: 'main', branch: 'luna/a', title: 't', body: 'b' }, ok.execImpl), {
    ok: true,
    url: 'https://github.com/o/r/pull/7',
  });
  assert.ok(ok.calls[0].startsWith('gh pr create --base main --head luna/a --title t'));
  const exists = fakeExec({
    gh: { ok: false, stderr: 'a pull request for branch "luna/a" into branch "main" already exists:\nhttps://github.com/o/r/pull/3' },
  });
  assert.equal((await integ.createPr({ base: 'main', branch: 'luna/a', title: 't', body: '' }, exists.execImpl)).url, 'https://github.com/o/r/pull/3');
  const none = fakeExec({ gh: { ok: false, code: 'ENOENT' } });
  assert.equal((await integ.createPr({ base: 'main', branch: 'luna/a', title: 't', body: '' }, none.execImpl)).error, 'noGh');
});

test('mergeOne: a resolved conflict is committed; markers left behind abort the merge', async () => {
  const good = fakeExec({ merge: { ok: false }, diff: [{ ok: true, stdout: 'a.js\n' }, { ok: true, stdout: '' }], grep: { ok: false } });
  const res = await integ.mergeOne('/wt', 'luna/a', { execImpl: good.execImpl, resolve: async () => ({ ok: true }) });
  assert.deepEqual(res, { ok: true, resolved: 1 });
  assert.ok(good.calls.includes('git commit --no-edit'));

  const bad = fakeExec({
    merge: [{ ok: false }, { ok: true }],
    diff: [{ ok: true, stdout: 'a.js\n' }, { ok: true, stdout: '' }],
    grep: { ok: true, stdout: 'a.js:3:<<<<<<< HEAD' },
  });
  const res2 = await integ.mergeOne('/wt', 'luna/a', { execImpl: bad.execImpl, resolve: async () => ({ ok: true }) });
  assert.equal(res2.stage, 'conflict');
  assert.ok(bad.calls.includes('git merge --abort'));
  assert.ok(!bad.calls.includes('git commit --no-edit'));
});

test('integrateMerge merges in order, verifies each, pushes the base; a red verify pushes nothing', async () => {
  const wt = { ok: true, root: '/wt/int', cwd: '/wt/int', branch: 'luna/p-integration' };
  const removed = [];
  const deps = (git, verify) => ({
    execImpl: git.execImpl,
    addWorktree: async (_r, _n, opts) => ({ ...wt, base: opts.base }),
    removeWorktree: async (_r, root) => removed.push(root),
    resolve: async () => ({ ok: true }),
    verifyImpl: verify,
    installImpl: async () => ({ ok: true }),
  });
  const pkgs = [
    { id: 'a', branch: 'luna/a', verify: 'npm test' },
    { id: 'b', branch: 'luna/b', verify: '' },
  ];
  const green = fakeExec({ 'rev-parse': [{ ok: true, stdout: 'base1\n' }, { ok: true, stdout: 'head1\n' }] });
  const res = await integ.integrateMerge({ repoPath: '/r', base: 'main', slug: 'p', packages: pkgs }, deps(green, async () => ({ ok: true })));
  assert.deepEqual(res.merged, ['a', 'b']);
  assert.equal(res.ok, true);
  assert.equal(res.headSha, 'head1');
  const merges = green.calls.filter((c) => c.startsWith('git merge'));
  assert.deepEqual(merges.map((c) => c.split(' ').pop()), ['refs/heads/luna/a', 'refs/heads/luna/b']);
  assert.ok(green.calls.includes('git push origin HEAD:refs/heads/main'));
  assert.deepEqual(removed, ['/wt/int']);

  const red = fakeExec({ 'rev-parse': { ok: true, stdout: 'base1\n' } });
  const res2 = await integ.integrateMerge(
    { repoPath: '/r', base: 'main', slug: 'p', packages: pkgs },
    deps(red, async () => ({ ok: false, output: 'FAIL x' })),
  );
  assert.equal(res2.ok, false);
  assert.equal(res2.stage, 'verify');
  assert.equal(res2.failedId, 'a');
  assert.ok(!red.calls.some((c) => c.startsWith('git push')), 'never pushes after a red verify');
  assert.equal(res2.root, '/wt/int', 'failed integration worktree kept for inspection');
});

test('removeWorktree refuses a worktree with uncommitted work', async () => {
  const dirty = fakeExec({ status: { ok: true, stdout: ' M x.js\n' } });
  assert.equal((await removeWorktree('/r', '/wt/a', { execImpl: dirty.execImpl })).error, 'dirty');
  assert.ok(!dirty.calls.some((c) => c.includes('worktree remove')));
  const clean = fakeExec({});
  assert.equal((await removeWorktree('/r', '/wt/a', { execImpl: clean.execImpl })).ok, true);
  assert.ok(clean.calls.includes('git worktree remove -- /wt/a'));
});

// ---- controller ----------------------------------------------------------------

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

function setup({ packages, settings, finish, resetAt = null, extraDeps = {} } = {}) {
  let clock = new Date(2026, 9, 6, 22, 0).getTime();
  let seq = 0;
  const log = { sessions: [], closed: [], events: [], prs: [], removed: [], notes: null, report: null, worktrees: [] };
  const timers = [];
  const alive = new Set();
  let todos = [1, 2, 3].map((at) => ({ at, text: `t${at}`, done: false }));
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => todos,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages, notes: 'why' }, costUsd: 0 }),
    addWorktree: async (repo, name, opts = {}) => {
      log.worktrees.push([name, opts.base]);
      return { ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` };
    },
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    finishPackage: finish || (async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] })),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => settings || { model: 'opus', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] },
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    usageResetAt: () => resetAt,
    createPr: async (args) => {
      log.prs.push(args);
      return { ok: true, url: `https://github.com/o/r/pull/${log.prs.length}` };
    },
    removeWorktree: async (_repo, root) => {
      log.removed.push(root);
      return { ok: true };
    },
    updateTodos: (_pid, fn) => {
      todos = fn(todos);
      log.notes = todos;
    },
    writeReport: (id, text) => {
      log.report = text;
      return `/cfg/runs/${id}.md`;
    },
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    ...extraDeps,
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const state = () => orch.view().packages.map((p) => p.state);
  return { orch, log, ctx, advance, flush, alive, state };
}

async function started(opts, launchExtra = {}) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  const res = await s.orch.launch({ planId: plan.id, ...launchExtra });
  return { ...s, planId: plan.id, res };
}

test('a scheduled run waits for its time, then starts by itself; cancel keeps it held', async () => {
  const s = await started({ packages: [pkg('a', [1])] }, { schedule: { kind: 'time', at: '23:00' } });
  assert.equal(s.res.ok, true);
  assert.deepEqual(s.state(), ['pending']);
  assert.ok(s.orch.view().scheduledAt > 0);
  assert.equal(s.log.sessions.length, 0);
  s.advance(60 * 60 * 1000);
  await s.flush();
  assert.deepEqual(s.state(), ['launched']);
  assert.equal(s.orch.view().scheduledAt, null);

  const c = await started({ packages: [pkg('a', [1])] }, { schedule: { kind: 'time', at: '23:00' } });
  assert.equal(c.orch.unschedule({ planId: c.planId }).ok, true);
  c.advance(2 * 60 * 60 * 1000);
  await c.flush();
  assert.deepEqual(c.state(), ['pending']);

  const r = await started({ packages: [pkg('a', [1])] }, { schedule: { kind: 'reset' } });
  assert.equal(r.res.error, 'noReset', 'no known reset time -> refused, nothing armed');
});

test('a Sonnet worker stalled twice restarts once on Opus in its worktree', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { model: 'sonnet', permissionMode: 'bypassPermissions' } });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: cannot find the API'));
  assert.deepEqual(s.state(), ['stalled']);
  await s.flush(); // the run settled and finalized (nothing pushed) - then Retry
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a' })).ok, true);
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: still stuck'));
  await s.flush();
  const v = s.orch.view().packages[0];
  assert.equal(v.state, 'launched');
  assert.equal(v.escalated, true);
  assert.equal(v.model, 'opus');
  assert.deepEqual(s.log.closed, ['s1']);
  assert.equal(s.log.sessions[1].task.model, 'opus');
  assert.equal(s.log.sessions[1].cwd, path.join('/wt', s.log.worktrees[0][0]), 'same worktree');
  assert.ok(s.log.events.some(([k]) => k === 'escalated'));
  // A third stall does not escalate again.
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED a: nope'));
  assert.deepEqual(s.state(), ['stalled']);
});

test('two workers changing the same file raise one overlap warning', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  const [ra, rb] = s.log.worktrees.map(([n]) => path.join('/wt', n));
  s.orch.onFiles('s1', [path.join(ra, 'src', 'x.js')]);
  s.orch.onFiles('s2', [path.join(rb, 'src', 'y.js')]);
  assert.equal(s.orch.view().overlaps.length, 0);
  s.orch.onFiles('s2', [path.join(rb, 'src', 'x.js')]);
  s.orch.onFiles('s2', [path.join(rb, 'src', 'x.js'), path.join(rb, 'z.js')]);
  assert.deepEqual(s.orch.view().overlaps, [{ a: 'a', b: 'b', files: ['src/x.js'] }]);
  assert.equal(s.log.events.filter(([k]) => k === 'overlap').length, 1);
});

test('approval stalls are logged as allow-rule suggestions', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onApproval('s1', 'Bash(npx tsc:*)', 'npx tsc --noEmit');
  s.orch.onApproval('s2', 'Bash(npx tsc:*)');
  const v = s.orch.view();
  assert.deepEqual(v.suggestions, [{ rule: 'Bash(npx tsc:*)', count: 2, ids: ['a', 'b'], example: 'npx tsc --noEmit' }]);
  assert.equal(v.packages[0].detail, 'Bash(npx tsc:*)');
  assert.equal(s.orch.ownsSession('s1'), true);
  assert.equal(s.orch.ownsSession('s9'), false);
});

test('a dependent package starts from its dependency\'s pushed head', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.log.worktrees[1][1], 'a5678aaa');
});

test('a settled run opens PRs in dependency order, removes pushed worktrees, notes stalled to-dos, writes the report', async () => {
  const s = await started({ packages: [pkg('b', [2], { dependsOn: ['a'] }), pkg('a', [1]), pkg('c', [3])] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED c: no idea'));
  await s.flush();
  s.orch.onTurnEnd('s3', turn('LUNA_DONE b'));
  await s.flush(8);
  const v = s.orch.view();
  assert.equal(v.integration.state, 'done');
  const byId = (id) => v.packages.find((p) => p.id === id);
  assert.deepEqual(s.log.prs.map((p) => p.branch), [byId('a').branch, byId('b').branch], 'a before b');
  assert.equal(s.log.prs[0].base, 'main');
  assert.equal(s.log.prs[0].repoPath, '/repo');
  assert.equal(byId('a').prUrl, 'https://github.com/o/r/pull/1');
  assert.equal(s.log.removed.length, 2, 'pushed worktrees removed, the stalled one kept');
  assert.equal(byId('c').state, 'stalled');
  assert.ok(s.log.closed.length >= 2, 'pushed tabs closed before removal');
  assert.match(s.log.notes.find((t) => t.at === 3).details, /blocked - no idea/);
  assert.equal(s.log.notes.find((t) => t.at === 1).details, undefined);
  assert.match(s.log.report, /2 of 3 packages pushed/);
  assert.ok(s.log.events.some(([k]) => k === 'finalized'));

  // Finishing again (after nothing new) creates no duplicate PRs.
  const again = await s.orch.finishRun({ planId: s.planId });
  assert.equal(again.ok, true);
  assert.equal(s.log.prs.length, 2);
});

test('merge mode marks merged packages only when the integration pushed; no base branch fails cleanly', async () => {
  const merges = [];
  const s = await started(
    {
      packages: [pkg('a', [1])],
      extraDeps: {
        confirmMerge: async () => true,
        integrateMerge: async (args) => (merges.push(args), { ok: true, merged: ['a'], headSha: 'x' }),
      },
    },
    { integration: 'merge' },
  );
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush(8);
  assert.equal(merges[0].base, 'main');
  assert.deepEqual(merges[0].packages.map((p) => p.id), ['a']);
  assert.equal(s.orch.view().packages[0].merged, true);
  assert.equal(s.orch.view().integrationMode, 'merge');

  const n = await started({ packages: [pkg('a', [1])], extraDeps: { baseBranchOf: async () => null } });
  n.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await n.flush(8);
  assert.equal(n.orch.view().integration.state, 'failed');
  assert.equal(n.orch.view().integration.error, 'noBaseBranch');
});

test('merge mode needs the native confirmation; the checkout must still be on the base branch', async () => {
  const declined = await started({ packages: [pkg('a', [1])], extraDeps: { confirmMerge: async () => false } }, { integration: 'merge' });
  assert.equal(declined.res.error, 'mergeDeclined');
  assert.equal(declined.log.sessions.length, 0, 'nothing launched');
  const none = await started({ packages: [pkg('a', [1])] }, { integration: 'merge' });
  assert.equal(none.res.error, 'mergeDeclined', 'no dialog available = no merge');

  let branch = 'main';
  const moved = await started({ packages: [pkg('a', [1])], extraDeps: { baseBranchOf: async () => branch } });
  branch = 'feature';
  moved.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await moved.flush(8);
  assert.equal(moved.orch.view().integration.error, 'baseMoved');
  assert.equal(moved.log.prs.length, 0);
});

test('a killed run does not finalize by itself', async () => {
  const s = await started({ packages: [pkg('a', [1]), pkg('b', [2])] });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  s.orch.kill();
  await s.flush(8);
  assert.equal(s.orch.view().integration.state, 'idle');
  assert.equal(s.log.prs.length, 0);
});

test('a package pushed while the finalizer runs is integrated by a second pass', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const prs = [];
  const s = await started({
    packages: [pkg('a', [1]), pkg('b', [2])],
    extraDeps: {
      createPr: async (args) => {
        prs.push(args.branch);
        if (prs.length === 1) await gate;
        return { ok: true, url: `https://github.com/o/r/pull/${prs.length}` };
      },
    },
  });
  s.orch.onTurnEnd('s2', turn('LUNA_BLOCKED b: stuck'));
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush(8); // settled -> finalizing, PR for a in flight
  // Mati unblocks b by hand; it finishes while the finalizer still runs.
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush(8);
  release();
  await s.flush(16);
  assert.equal(prs.length, 2);
  assert.ok(s.orch.view().packages.every((p) => p.prUrl));
});

test('a dependency merge failure leaves no worktree to resume', async () => {
  const s = await started({
    packages: [pkg('a', [1]), pkg('b', [2]), pkg('c', [3], { dependsOn: ['a', 'b'] })],
    extraDeps: { mergeDeps: async () => ({ ok: false, detail: 'luna/b: conflict' }) },
  });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush(8);
  const c = s.orch.view().packages.find((p) => p.id === 'c');
  assert.equal(c.state, 'failed');
  assert.equal(c.error, 'depMergeFailed');
  assert.equal(c.branch, null);
  assert.equal(s.log.removed.filter((r) => r.includes('c-')).length, 1, 'its fresh worktree is removed');
});

test('finishRun is refused while a worker runs and works after a kill', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  assert.equal((await s.orch.finishRun({ planId: s.planId })).error, 'runActive');
  s.orch.kill();
  const res = await s.orch.finishRun({ planId: s.planId, integration: 'branches' });
  assert.equal(res.ok, true);
  assert.equal(s.orch.view().integration.state, 'done');
  assert.equal(s.log.prs.length, 0);
  assert.match(s.log.notes.find((t) => t.at === 1).details, /killed/);
});
