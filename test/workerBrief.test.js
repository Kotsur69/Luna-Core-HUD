// ============================================================================
// Worker briefs inside the worker's cwd (src/workerBrief.js): no --add-dir for
// the brief (Claude Code 2.1.326+ trust prompt), the brief git-excluded in a
// real worktree, cleanup, and the God Mode controller writing / finding /
// removing it on launch, resume, push and discard.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const wb = require('../src/workerBrief.js');
const { withTaskBrief, withAccountResume } = require('../src/launch.js');
const { workerLaunchCommand, planWorkerTask } = require('../src/orchestraPlanRunLaunch.js');
const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra } = require('../src/orchestra.js');

const UUID = '0b6f5d1e-1111-4222-8333-944455556666';

// ---- paths ---------------------------------------------------------------------

test('briefPathIn puts the brief in <cwd>/.luna-brief and refuses anything else', () => {
  const cwd = path.resolve('/wt/pkg-1');
  const file = wb.briefPathIn(cwd, 'pkg-1');
  assert.equal(file, path.join(cwd, '.luna-brief', 'pkg-1.md'));
  assert.equal(path.relative(cwd, file).startsWith('..'), false, 'inside the cwd');
  assert.equal(wb.isWorkerBrief(file), true);
  assert.equal(wb.relativeBriefPath(file), '.luna-brief/pkg-1.md');
  assert.throws(() => wb.briefPathIn('relative/dir', 'a'), TypeError);
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden']) assert.throws(() => wb.briefPathIn(cwd, bad), TypeError, bad);
  assert.equal(wb.isWorkerBrief(path.resolve('/cfg/tasks/a.md')), false);
  assert.equal(wb.relativeBriefPath(path.resolve('/cfg/tasks/a.md')), null);
});

// ---- launch commands -----------------------------------------------------------

test('withTaskBrief: no --add-dir for a brief, the message names it relative to cwd', () => {
  const brief = wb.briefPathIn(path.resolve('/wt/my pkg'), 'my-pkg');
  const msg = "'Your task brief is in the file `.luna-brief/my-pkg.md` - read it first, then carry it out.'";
  assert.equal(withTaskBrief('claude', { briefPath: brief, model: 'opus' }), `claude ${msg} --model opus`);
  assert.equal(withTaskBrief('agy', { briefPath: brief }), `agy --prompt-interactive ${msg}`);
  const plan = workerLaunchCommand('claude', planWorkerTask({ briefPath: brief, runSlug: 'r1' }));
  assert.doesNotMatch(plan, /--add-dir/);
  assert.ok(plan.startsWith(`claude ${msg} --restricted`));
  assert.doesNotMatch(withAccountResume('claude', UUID, { briefPath: brief, model: 'opus' }), /--add-dir/);
  // The quote checks still look at the full path.
  assert.equal(withTaskBrief('claude', { briefPath: wb.briefPathIn(path.resolve("/wt/it's"), 'a') }), null);
});

test('a tool kit keeps its own --add-dir art folders (not the brief)', () => {
  const art = path.resolve('/art');
  const cmd = withTaskBrief('claude', { briefPath: wb.briefPathIn(path.resolve('/wt/a'), 'a'), addDirs: [art] });
  assert.equal(cmd.match(/--add-dir/g).length, 1);
  assert.ok(cmd.endsWith(`--add-dir '${art}'`));
});

// ---- real git ------------------------------------------------------------------

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

async function tempRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brief-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'luna/w', wt);
  const common = path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir').trim());
  return { base, repo, wt, exclude: path.join(common, 'info', 'exclude') };
}

const lineCount = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() === wb.EXCLUDE_LINE).length;

test('excludeBriefFolder adds the line to the COMMON info/exclude once', async (t) => {
  const r = await tempRepo(t);
  const first = await wb.excludeBriefFolder(r.wt);
  assert.equal(first.ok, true);
  assert.equal(first.added, true);
  assert.equal(path.resolve(first.file), path.resolve(r.exclude), 'the common git dir, not the worktree one');
  const again = await Promise.all([wb.excludeBriefFolder(r.wt), wb.excludeBriefFolder(r.repo), wb.excludeBriefFolder(r.wt)]);
  assert.deepEqual(again.map((x) => x.added), [false, false, false]);
  assert.equal(lineCount(r.exclude), 1);
  assert.equal(fs.existsSync(path.join(r.repo, '.gitignore')), false, 'the tracked .gitignore is never written');
});

test('concurrent first calls still add the line only once', async (t) => {
  const r = await tempRepo(t);
  const res = await Promise.all([1, 2, 3, 4].map(() => wb.excludeBriefFolder(r.wt)));
  assert.equal(res.filter((x) => x.added).length, 1);
  assert.equal(lineCount(r.exclude), 1);
});

test('excludeBriefFolder outside a repo says notRepo', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brief-norepo-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  // A ceiling keeps git from finding a repo above the temp folder.
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  try {
    const res = await wb.excludeBriefFolder(dir);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'notRepo');
  } finally {
    if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prev;
  }
});

test('git add -A in a real worktree leaves the brief untracked; cleanup removes it', async (t) => {
  const r = await tempRepo(t);
  const brief = wb.briefPathIn(r.wt, 'w');
  let excluded = null;
  const ok = wb.writeWorkerBrief(brief, '# brief\n', {
    exclude: (cwd) => {
      excluded = wb.excludeBriefFolder(cwd);
      return excluded;
    },
  });
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(brief, 'utf8'), '# brief\n');
  // The folder's own .gitignore holds before info/exclude is even written.
  git(r.wt, 'add', '-A');
  assert.equal(git(r.wt, 'status', '--porcelain'), '', 'nothing to commit, brief ignored');
  assert.doesNotMatch(git(r.wt, 'ls-files'), /luna-brief/);
  // The info/exclude update starts on a later tick (writeWorkerBrief does not wait for it).
  while (!excluded) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await excluded).ok, true);
  assert.equal(lineCount(r.exclude), 1);
  // info/exclude alone also keeps it out (the folder's .gitignore removed).
  fs.rmSync(path.join(r.wt, '.luna-brief', '.gitignore'));
  git(r.wt, 'add', '-A');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');

  assert.equal(wb.removeWorkerBrief(brief), true);
  assert.equal(fs.existsSync(brief), false);
  assert.equal(fs.existsSync(path.dirname(brief)), false, 'an empty brief folder goes too');
  assert.equal(wb.removeWorkerBrief(brief), true, 'already gone is fine');
});

test('removeWorkerBrief keeps a folder with another brief and refuses foreign paths', async (t) => {
  const r = await tempRepo(t);
  const a = wb.briefPathIn(r.wt, 'a');
  const b = wb.briefPathIn(r.wt, 'b');
  const noExclude = { exclude: async () => ({ ok: true }) };
  assert.ok(wb.writeWorkerBrief(a, 'a', noExclude));
  assert.ok(wb.writeWorkerBrief(b, 'b', noExclude));
  assert.equal(wb.removeWorkerBrief(a), true);
  assert.equal(fs.existsSync(b), true);
  const foreign = path.join(r.wt, 'a.txt');
  assert.equal(wb.removeWorkerBrief(foreign), false);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(wb.removeWorkerBrief(null), false);
});

test('a .luna-brief folder that is a link is never written through or cleaned', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brief-link-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const outside = path.join(base, 'outside');
  const cwd = path.join(base, 'wt');
  fs.mkdirSync(outside);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(outside, 'x.md'), 'keep');
  fs.symlinkSync(outside, path.join(cwd, '.luna-brief'), 'junction');
  const logged = [];
  const ok = wb.writeWorkerBrief(wb.briefPathIn(cwd, 'x'), 'evil', { log: (m) => logged.push(m), exclude: async () => ({ ok: true }) });
  assert.equal(ok, false);
  assert.match(logged.join('\n'), /is a link/);
  assert.equal(fs.readFileSync(path.join(outside, 'x.md'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(outside, '.gitignore')), false);
  assert.equal(wb.removeWorkerBrief(wb.briefPathIn(cwd, 'x')), false);
  assert.equal(fs.existsSync(path.join(outside, 'x.md')), true);
});

// ---- God Mode controller --------------------------------------------------------

const turn = (text) => JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const pkg = (id, todoAts) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'opus' });

function setup(packages) {
  let clock = 1_000_000;
  let seq = 0;
  const log = { sessions: [], briefs: new Map(), removed: [] };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => {
      const root = path.resolve('/wt', name);
      return { ok: true, root, cwd: root, branch: `luna/${name}` };
    },
    headSha: async () => 'base',
    writeBrief: (file, text) => {
      log.briefs.set(file, text);
      return true;
    },
    removeBrief: (file) => {
      log.removed.push(file);
      return true;
    },
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}aaaaaaa` }),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions' }),
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
  });
  const advance = (ms) => {
    clock += ms;
    for (const t of [...timers]) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { orch, log, advance, flush, ctx: { projectId: 'p1', repoPath: path.resolve('/repo'), profileId: 'cloud', env: {} } };
}

async function started(packages) {
  const s = setup(packages);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  return { ...s, planId: plan.id };
}

test('a launched worker gets its brief inside its worktree cwd', async () => {
  const s = await started([pkg('a', [1])]);
  const first = s.log.sessions[0];
  assert.equal(path.dirname(first.task.briefPath), path.join(first.cwd, '.luna-brief'));
  assert.ok(s.log.briefs.has(first.task.briefPath));
  assert.doesNotMatch(withTaskBrief('claude', first.task), /--add-dir/);
});

test('a resumed (stalled) worker finds its brief at the same place in the worktree', async () => {
  const s = await started([pkg('a', [1])]);
  for (let i = 0; i <= sup.MAX_NUDGES; i += 1) {
    s.orch.onTurnEnd('s1', turn('working'));
    s.advance(10_000);
  }
  assert.equal(s.log.sessions.length, 2, 'automatic resume opened a new tab');
  const [first, second] = s.log.sessions;
  assert.equal(second.task.briefPath, first.task.briefPath);
  assert.match(s.log.briefs.get(second.task.briefPath), /RESUMING/);
});

test('the self-check fix-up writes its brief in its own cwd and removes it when it settles', async () => {
  const { createFixupRunner } = require('../src/orchestraFixup.js');
  const briefs = new Map();
  const removed = [];
  const sessions = [];
  const runner = createFixupRunner({
    getPlan: () => ({ id: 'gm-1', profileId: 'cloud', projectId: 'p1', followups: false }),
    createSession: (opts) => {
      sessions.push(opts);
      return { id: 'fx1' };
    },
    writeBrief: (file, text) => (briefs.set(file, text), true),
    removeBrief: (file) => (removed.push(file), true),
    closeSession: () => {},
    sessionAlive: () => false,
    model: () => 'opus',
    permissionMode: () => 'bypassPermissions',
    setTimer: () => null,
    clearTimer: () => {},
  });
  const root = path.resolve('/wt/integration');
  const done = runner.run({ root, brief: 'fix it' });
  const { briefPath } = sessions[0].task;
  assert.equal(sessions[0].cwd, root);
  assert.equal(path.dirname(briefPath), path.join(root, '.luna-brief'));
  assert.equal(briefs.get(briefPath), 'fix it');
  assert.doesNotMatch(withTaskBrief('claude', sessions[0].task), /--add-dir/);
  runner.onTurnEnd('fx1', turn('LUNA_DONE selfcheck'));
  assert.deepEqual(await done, { ok: true });
  assert.deepEqual(removed, [briefPath]);
});

test('a pushed package and a discarded run delete their briefs', async () => {
  const s = await started([pkg('a', [1]), pkg('b', [2])]);
  const briefA = s.log.sessions[0].task.briefPath;
  const briefB = s.log.sessions[1].task.briefPath;
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.orch.view().packages.find((p) => p.id === 'a').state, 'pushed');
  assert.deepEqual(s.log.removed, [briefA]);

  s.orch.kill();
  await s.flush();
  const res = s.orch.discard();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(s.log.removed.includes(briefB), 'the killed package brief goes with the run');
});
