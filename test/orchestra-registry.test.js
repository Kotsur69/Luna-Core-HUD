// ============================================================================
// Multi God Mode registry (docs/MULTI_GODMODE_PLAN.md A2): one God Mode
// controller per project. Most tests drive fake controllers, so routing and
// the cross-run guards are checked in isolation; the last ones run two real
// createOrchestra controllers on a temp per-project store (two projects side
// by side, a restart, the same repo twice).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOrchestraRegistry, repoKey } = require('../src/orchestraRegistry.js');
const { createOrchestra } = require('../src/orchestra.js');
const { createOrchestraStore } = require('../src/orchestraStore.js');

/**
 * A controller double: records every call, answers from `spec`.
 * spec: {view, running, busy, repo, planningRepo, sessions, fixups, restores, throws,
 *   workers (tabs running right now - pauseExternal pauses only with some)}
 */
function fakeController(projectId, spec = {}) {
  const calls = [];
  const owned = new Set(spec.sessions || []);
  const fixups = new Set(spec.fixups || []);
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    if (spec.throws && spec.throws.includes(name)) throw new Error(`${name} exploded`);
  };
  return {
    projectId,
    calls,
    view: () => spec.view || null,
    planWait: () => spec.planWait || null,
    isRunning: () => spec.running === true,
    isBusy: () => spec.busy === true,
    repoPath: () => (spec.view ? spec.repo || null : null),
    planningRepo: () => spec.planningRepo || null,
    ownsSession: (id) => owned.has(id),
    restore: () => {
      record('restore')();
      return spec.restores === true;
    },
    kill: () => {
      record('kill')();
      return !!(spec.view && spec.view.started);
    },
    tick: record('tick'),
    onSystemResume: record('resume'),
    onTurnEnd: record('turnEnd'),
    onUsageLimit: record('usageLimit'),
    onApproval: record('approval'),
    onFiles: record('files'),
    onSessionClosed: (id) => {
      record('closed')(id);
      return owned.has(id) || fixups.has(id);
    },
    workerSessions: () => spec.workers || [],
    pauseExternal: (until) => {
      record('pauseExternal')(until);
      return (spec.workers || []).length > 0;
    },
  };
}

/** A registry over fake controllers built from `specs[projectId]`. */
function setup(specs = {}) {
  const logs = [];
  const made = [];
  const registry = createOrchestraRegistry({
    makeController: (projectId) => {
      const c = fakeController(projectId, specs[projectId === null ? '(none)' : projectId]);
      made.push(c);
      return c;
    },
    log: (line) => logs.push(line),
  });
  return { registry, logs, made };
}

const names = (c) => c.calls.map((call) => call[0]);
const live = (id, extra = {}) => ({ id, started: true, killed: false, settled: false, ...extra });

test('makeController is required', () => {
  assert.throws(() => createOrchestraRegistry({}), TypeError);
  assert.throws(() => createOrchestraRegistry(), TypeError);
});

test('ensure makes one controller per project and get never makes one', () => {
  const { registry, made } = setup();
  assert.equal(registry.get('alpha'), null);
  const a = registry.ensure('alpha');
  assert.equal(registry.ensure('alpha'), a, 'the same controller every time');
  assert.equal(registry.get('alpha'), a);
  const none = registry.ensure(null);
  assert.equal(none.projectId, null, 'a tab with no project plans under null');
  // Anything that is not a string is the "no project" key, never its own run.
  assert.equal(registry.ensure(undefined), none);
  assert.equal(registry.ensure(42), none);
  assert.equal(made.length, 2);
  assert.deepEqual(registry.entries().map((e) => e.projectId), ['alpha', null]);
});

test('session events go to the controller that owns the session, and only to it', () => {
  const { registry } = setup({ alpha: { sessions: ['s-a'] }, beta: { sessions: ['s-b'] } });
  const a = registry.ensure('alpha');
  const b = registry.ensure('beta');
  assert.equal(registry.bySession('s-b').projectId, 'beta');
  assert.equal(registry.ownsSession('s-a'), true);
  assert.equal(registry.ownsSession('nobody'), false);

  registry.onTurnEnd('s-b', 'LUNA_DONE x');
  registry.onUsageLimit('s-b', 123);
  registry.onApproval('s-b', 'Bash(npm test:*)', 'npm test');
  registry.onFiles('s-b', ['/r/a.js']);
  assert.equal(registry.onSessionClosed('s-b'), true);

  assert.deepEqual(a.calls, [], 'the other project never hears of it');
  assert.deepEqual(b.calls, [
    ['turnEnd', 's-b', 'LUNA_DONE x'],
    ['usageLimit', 's-b', 123],
    ['approval', 's-b', 'Bash(npm test:*)', 'npm test'],
    ['files', 's-b', ['/r/a.js']],
    ['closed', 's-b'],
  ]);
});

test('a tab nobody owns as a package (a fix-up worker) is offered to every run for turn end and close only', () => {
  const { registry } = setup({ alpha: {}, beta: { fixups: ['fix-1'] } });
  const a = registry.ensure('alpha');
  const b = registry.ensure('beta');
  registry.onTurnEnd('fix-1', 'done');
  assert.equal(registry.onSessionClosed('fix-1'), true, 'the fix-up owner claimed it');
  assert.equal(registry.onSessionClosed('stranger'), false);
  // Limits, approvals and file lists only ever matter to a package's own run.
  registry.onUsageLimit('fix-1', 1);
  registry.onApproval('fix-1', null, null);
  registry.onFiles('fix-1', []);
  assert.deepEqual(names(a), ['turnEnd', 'closed', 'closed']);
  assert.deepEqual(names(b), ['turnEnd', 'closed', 'closed']);
});

test('byPlanId finds the run with that plan; an unknown, junk or ambiguous id names none', () => {
  const { registry } = setup({ alpha: { view: live('p1') }, beta: { view: live('p2') }, gamma: { view: live('p2') } });
  registry.ensure('alpha');
  registry.ensure('beta');
  assert.equal(registry.byPlanId('p1').projectId, 'alpha');
  assert.equal(registry.byPlanId('p2').projectId, 'beta');
  registry.ensure('gamma');
  assert.equal(registry.byPlanId('p2'), null, 'two projects share the id: refuse rather than guess');
  assert.equal(registry.byPlanId('nope'), null);
  assert.equal(registry.byPlanId(''), null);
  assert.equal(registry.byPlanId({ id: 'p1' }), null);
});

test('views lists every run that has a plan, with its project', () => {
  const { registry } = setup({ alpha: { view: live('p1'), running: true }, beta: {} });
  registry.ensure('alpha');
  registry.ensure('beta');
  assert.deepEqual(registry.views(), [{ projectId: 'alpha', view: live('p1'), running: true }]);
});

test('repoBusy: the same repo in another project is refused, compared resolved and case-insensitive', () => {
  const repo = path.join(os.tmpdir(), 'Luna-Repo');
  const { registry } = setup({ alpha: { view: live('p1'), repo } });
  registry.ensure('alpha');
  assert.equal(registry.repoBusy('beta', repo), true);
  assert.equal(registry.repoBusy('beta', path.join(repo.toUpperCase(), '.')), true, 'case and dot segments do not matter');
  assert.equal(registry.repoBusy('beta', path.join(repo, 'sub', '..')), true);
  assert.equal(registry.repoBusy('beta', path.join(os.tmpdir(), 'Other-Repo')), false);
  assert.equal(registry.repoBusy('alpha', repo), false, "a project's own run never blocks it");
  assert.equal(registry.repoBusy('beta', ''), false);
  assert.equal(registry.repoBusy('beta', null), false);
  assert.equal(repoKey(repo), path.resolve(repo).toLowerCase());
});

test('repoBusy: a settled run frees its repo; a plan being made holds it already', () => {
  const repo = path.join(os.tmpdir(), 'Luna-Repo');
  const { registry } = setup({
    done: { view: live('p1', { settled: true }), repo },
    killed: { view: live('p2', { killed: true }), repo: `${repo}-k` },
    planning: { planningRepo: `${repo}-p`, busy: true },
  });
  ['done', 'killed', 'planning'].forEach((id) => registry.ensure(id));
  assert.equal(registry.repoBusy('x', repo), false, 'settled: free');
  assert.equal(registry.repoBusy('x', `${repo}-k`), true, 'killed but not settled: Retry can still use its worktrees');
  assert.equal(registry.repoBusy('x', `${repo}-p`), true, 'no plan yet, but the planner is running on it');
});

test("othersActive: another project's live run counts, the asking project's own never does", () => {
  const { registry } = setup({
    alpha: { view: live('p1'), running: true },
    waiting: { view: live('p2') },
    held: { view: { id: 'p3', started: false, killed: false, settled: false } },
    done: { view: live('p4', { settled: true }) },
    planning: { busy: true },
  });
  registry.ensure('alpha');
  assert.equal(registry.othersActive('alpha'), false);
  assert.equal(registry.othersActive('beta'), true);
  registry.ensure('held');
  registry.ensure('done');
  assert.equal(registry.othersActive('alpha'), false, 'held and settled runs are not active');
  registry.ensure('waiting');
  assert.equal(registry.othersActive('alpha'), true, 'started, every worker waiting on Mati: still active');
  const only = setup({ planning: { busy: true } });
  only.registry.ensure('planning');
  assert.equal(only.registry.othersActive('alpha'), true, 'planning counts');
  assert.equal(only.registry.othersActive('planning'), false);
});

test('anyRunning and anyOpen look at every run', () => {
  const { registry } = setup({ alpha: { view: live('p1', { settled: true }) }, beta: { view: live('p2'), running: true } });
  registry.ensure('alpha');
  assert.equal(registry.anyRunning(), false);
  assert.equal(registry.anyOpen(), false);
  registry.ensure('beta');
  assert.equal(registry.anyRunning(), true);
  assert.equal(registry.anyOpen(), true);
});

test('killAll stops every run, even when one controller throws', () => {
  const { registry, logs } = setup({
    alpha: { view: live('p1') },
    beta: { view: live('p2'), throws: ['kill'] },
    gamma: { view: live('p3') },
    held: { view: { id: 'p4', started: false } },
  });
  const all = ['alpha', 'beta', 'gamma', 'held'].map((id) => registry.ensure(id));
  assert.equal(registry.killAll(), 2, 'alpha and gamma stopped; beta threw; held had nothing running');
  for (const c of all) assert.deepEqual(names(c), ['kill'], `${c.projectId} was asked`);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /kill failed for project beta: kill exploded/);
});

test('tick and onSystemResume fan out to every run; one throwing does not stop the rest', () => {
  const { registry, logs } = setup({ alpha: { throws: ['tick', 'resume'] }, beta: {} });
  const a = registry.ensure('alpha');
  const b = registry.ensure('beta');
  registry.tick();
  registry.onSystemResume();
  assert.deepEqual(names(a), ['tick', 'resume']);
  assert.deepEqual(names(b), ['tick', 'resume']);
  assert.equal(logs.length, 2);
});

test('restoreAll brings back every stored run and keeps no controller for one that did not come back', () => {
  const { registry, logs } = setup({
    alpha: { restores: true },
    beta: { restores: true },
    stale: { restores: false },
    broken: { throws: ['restore'] },
  });
  const restored = registry.restoreAll(['alpha', 'beta', 'alpha', 'stale', 'broken']);
  assert.deepEqual(restored, ['alpha', 'beta'], 'each project once');
  assert.deepEqual(registry.entries().map((e) => e.projectId), ['alpha', 'beta']);
  assert.equal(registry.get('stale'), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /restore failed for project broken/);
  assert.deepEqual(registry.restoreAll('junk'), []);
});

test('restoreAll keeps a controller that already existed, restored or not', () => {
  const { registry } = setup({ alpha: { restores: false } });
  const a = registry.ensure('alpha');
  assert.deepEqual(registry.restoreAll(['alpha']), []);
  assert.equal(registry.get('alpha'), a);
});

// --- Real controllers on a temp per-project store ---------------------------

const todo = (at, text) => ({ at, text, done: false });
const pkg = (id, todoAts) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' });

/** Two real God Mode controllers wired like main.js does, minus the IO. */
function realRegistry(dir) {
  const store = createOrchestraStore({ userDir: () => dir });
  let seq = 0;
  const registry = createOrchestraRegistry({
    makeController: (projectId) =>
      createOrchestra({
        now: () => 1700000000000 + (projectId === 'beta' ? 1 : 0),
        readTodos: () => [todo(1, `${projectId} one`)],
        dirtyCount: async () => 0,
        runPlanner: async () => ({ ok: true, raw: { packages: [pkg(`${projectId}-a`, [1])], notes: '' }, costUsd: 0 }),
        addWorktree: async (repo, name) => ({ ok: true, root: path.join(repo, '.wt', name), cwd: repo, branch: `luna/${name}` }),
        briefDir: () => path.join(dir, 'tasks'),
        writeBrief: () => true,
        createSession: () => ({ id: `s${(seq += 1)}` }),
        loadState: () => store.loadRun(projectId),
        saveState: (data) => store.saveRun(projectId, data),
        repoBusy: (repoPath) => registry.repoBusy(projectId, repoPath),
        otherRunsActive: () => registry.othersActive(projectId),
      }),
  });
  return { registry, store };
}

test('plans for two projects coexist, are stored separately and both survive a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-orch-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repoA = path.join(dir, 'repo-a');
  const repoB = path.join(dir, 'repo-b');

  const first = realRegistry(dir);
  const a = await first.registry.ensure('alpha').makePlan({ projectId: 'alpha', repoPath: repoA, profileId: 'p', env: {} });
  const b = await first.registry.ensure('beta').makePlan({ projectId: 'beta', repoPath: repoB, profileId: 'p', env: {} });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(a.plan.id, b.plan.id);
  assert.deepEqual(first.registry.views().map((v) => [v.projectId, v.view.id]), [
    ['alpha', a.plan.id],
    ['beta', b.plan.id],
  ]);
  assert.deepEqual(first.store.listStored().sort(), ['alpha', 'beta'], 'one file per project');
  assert.equal(first.store.loadRun('alpha').id, a.plan.id);
  assert.equal(first.store.loadRun('beta').id, b.plan.id);

  // Restart: a fresh registry over the same config folder.
  const second = realRegistry(dir);
  assert.deepEqual(second.registry.restoreAll(second.store.listStored()).sort(), ['alpha', 'beta']);
  assert.equal(second.registry.get('alpha').view().id, a.plan.id);
  assert.equal(second.registry.get('beta').view().id, b.plan.id);
  assert.equal(second.registry.get('alpha').view().started, false, 'restored runs are held');
  assert.equal(second.registry.anyRunning(), false);

  // Discarding one leaves the other's file alone.
  assert.equal(second.registry.get('alpha').discard().ok, true);
  assert.deepEqual(second.store.listStored(), ['beta']);
});

test('the same repo in a second project is refused with repoBusy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-orch-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'Shared');
  const { registry } = realRegistry(dir);
  assert.equal((await registry.ensure('alpha').makePlan({ projectId: 'alpha', repoPath: repo, profileId: 'p', env: {} })).ok, true);
  const res = await registry.ensure('beta').makePlan({ projectId: 'beta', repoPath: path.join(repo.toUpperCase(), '.'), profileId: 'p', env: {} });
  assert.deepEqual(res, { ok: false, error: 'repoBusy' });
  assert.equal(registry.get('beta').view(), null, 'no plan was made');
  // Alpha's own replan is not blocked by itself.
  assert.equal((await registry.get('alpha').makePlan({ projectId: 'alpha', repoPath: repo, profileId: 'p', env: {} })).ok, true);
});

// --- A3: account-aware pause (docs/MULTI_GODMODE_PLAN.md) -------------------

const { createClaudeAccounts, ACCOUNT_ENV } = require('../src/claudeaccounts.js');

const TOKEN_A = `sk-ant-oat01-${'a'.repeat(40)}`;
const TOKEN_B = `sk-ant-oat01-${'b'.repeat(40)}`;
const HOUR = 60 * 60 * 1000;

/** A reversible stand-in for Electron's safeStorage. */
const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

/**
 * Fake runs over the REAL account store, wired like main.js: the store merges
 * the registry's memory into its picks; the registry reads the store's list.
 * `ids` are the accounts to add, in preference order (none: no accounts set up).
 */
function accountSetup(t, specs, { ids = ['a', 'b'], ownBackend = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-orch-acc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: 1_700_000_000_000 };
  let registry = null;
  const accounts = createClaudeAccounts({
    file: () => path.join(dir, 'claude-accounts.local.json'),
    safeStorage: fakeStorage,
    now: () => clock.now,
    extraLimits: () => registry.limitedAccounts(),
    onLimitCleared: (id) => registry.clearAccountLimit(id),
  });
  const tokens = { a: TOKEN_A, b: TOKEN_B };
  const idOf = {};
  for (const name of ids) idOf[name] = accounts.add(name, tokens[name]).id;
  const made = {};
  registry = createOrchestraRegistry({
    now: () => clock.now,
    accounts: () => accounts.list().accounts,
    onClaudeAccount: (sessionId) => !ownBackend.includes(sessionId),
    makeController: (projectId) => {
      made[projectId] = fakeController(projectId, specs[projectId]);
      return made[projectId];
    },
  });
  Object.keys(specs).forEach((id) => registry.ensure(id));
  /**
   * main.js's transcript onUsageLimit for a worker on `account`: the registry
   * notes the limit, failoverTab moves the tab when another account is free,
   * and only otherwise does the registry decide who waits.
   */
  const workerLimit = (sessionId, account, resetsAt) => {
    const accountId = account ? idOf[account] : null;
    if (accountId) registry.noteAccountLimit(accountId, resetsAt);
    const res = accountId ? accounts.markLimited(accountId, resetsAt) : { switchTo: accounts.freeAccount() };
    if (res.switchTo) return { movedTo: res.switchTo.label };
    registry.onUsageLimit(sessionId, resetsAt, { onAccount: !ownBackend.includes(sessionId) });
    return { movedTo: null };
  };
  const launchAccount = () => {
    const id = accounts.authLayer({})[ACCOUNT_ENV] || null;
    return Object.keys(idOf).find((name) => idOf[name] === id) || null;
  };
  return { registry, accounts, made, clock, idOf, workerLimit, launchAccount };
}

const pausesOf = (c) => c.calls.filter((call) => call[0] === 'pauseExternal');

test('A3: one account limited - the worker moves to the other account and no run pauses', (t) => {
  const env = accountSetup(t, {
    alpha: { sessions: ['s-a'], workers: ['s-a'] },
    beta: { sessions: ['s-b'], workers: ['s-b'] },
  });
  const res = env.workerLimit('s-a', 'a', env.clock.now + 2 * HOUR);
  assert.deepEqual(res, { movedTo: 'b' });
  for (const c of Object.values(env.made)) {
    assert.deepEqual(names(c).filter((n) => n === 'usageLimit' || n === 'pauseExternal'), [], `${c.projectId} keeps going`);
  }
  assert.deepEqual(env.registry.allAccountsOut(null), { out: false, until: null });
});

test('A3: both accounts limited - every run with live workers pauses until the EARLIEST reset', (t) => {
  const env = accountSetup(t, {
    alpha: { sessions: ['s-a'], workers: ['s-a'] },
    beta: { sessions: ['s-b'], workers: ['s-b'] },
    held: { view: { id: 'p3', started: false } },
  });
  const weekly = env.clock.now + 3 * 24 * HOUR;
  const fiveHour = env.clock.now + 2 * HOUR;
  assert.deepEqual(env.workerLimit('s-a', 'a', weekly), { movedTo: 'b' }, 'a goes first: its tab moves to b');
  assert.deepEqual(env.workerLimit('s-b', 'b', fiveHour), { movedTo: null }, 'then b runs out too');
  assert.deepEqual(pausesOf(env.made.alpha), [['pauseExternal', fiveHour]]);
  assert.deepEqual(pausesOf(env.made.beta), [['pauseExternal', fiveHour]], 'b resets first, so every run resumes then');
  assert.deepEqual(names(env.made.held), [], 'a run with no live worker is left alone');
  assert.equal(names(env.made.beta).includes('usageLimit'), false, 'the owner pauses through pauseAll, not twice');
});

test('A3: a worker launched while one account is out starts on the free account, and back on the preferred one after its reset', (t) => {
  const env = accountSetup(t, { alpha: {} });
  assert.equal(env.launchAccount(), 'a', 'preferred account first');
  // Only the registry knows (e.g. the usage meter saw it): the store has no cooldown.
  env.registry.noteAccountLimit(env.idOf.a, env.clock.now + HOUR);
  assert.equal(env.accounts.list().accounts.find((x) => x.id === env.idOf.a).limitedUntil, env.clock.now + HOUR);
  assert.equal(env.launchAccount(), 'b');
  env.clock.now += HOUR + 1;
  assert.equal(env.launchAccount(), 'a', 'the limit cleared on its own');
  assert.deepEqual(env.registry.limitedAccounts(), {});
});

test('A3: Mati clearing a cooldown in Settings clears the registry memory too', (t) => {
  const env = accountSetup(t, { alpha: {} });
  env.registry.noteAccountLimit(env.idOf.a, env.clock.now + HOUR);
  assert.equal(env.launchAccount(), 'b');
  env.accounts.clearLimit(env.idOf.a);
  assert.equal(env.launchAccount(), 'a');
  assert.deepEqual(env.registry.limitedAccounts(), {});
});

test('A3: another account still free (the failover loop guard said no) or its own backend - only that run waits', (t) => {
  const env = accountSetup(t, {
    alpha: { sessions: ['s-a'], workers: ['s-a'] },
    beta: { sessions: ['s-b'], workers: ['s-b'] },
  });
  env.registry.onUsageLimit('s-a', env.clock.now + HOUR, { onAccount: true });
  env.registry.onUsageLimit('s-b', env.clock.now + HOUR, { onAccount: false });
  assert.deepEqual(names(env.made.alpha), ['usageLimit']);
  assert.deepEqual(names(env.made.beta), ['usageLimit']);
  assert.equal(pausesOf(env.made.alpha).length + pausesOf(env.made.beta).length, 0);
});

test('A3: a run whose workers all use their own backend is not paused when the Claude accounts run out', (t) => {
  const env = accountSetup(
    t,
    { alpha: { sessions: ['s-a'], workers: ['s-a'] }, zai: { sessions: ['s-z'], workers: ['s-z'] } },
    { ownBackend: ['s-z'] },
  );
  env.workerLimit('s-a', 'a', env.clock.now + HOUR);
  env.workerLimit('s-a', 'b', env.clock.now + 2 * HOUR);
  assert.deepEqual(pausesOf(env.made.alpha), [['pauseExternal', env.clock.now + HOUR]]);
  assert.deepEqual(names(env.made.zai), []);
});

test('A3: no accounts set up - every run on the /login account pauses until the reported reset', (t) => {
  const env = accountSetup(t, { alpha: { sessions: ['s-a'], workers: ['s-a'] }, beta: { workers: ['s-b'] } }, { ids: [] });
  const until = env.clock.now + HOUR;
  assert.deepEqual(env.workerLimit('s-a', null, until), { movedTo: null });
  assert.deepEqual(pausesOf(env.made.alpha), [['pauseExternal', until]]);
  assert.deepEqual(pausesOf(env.made.beta), [['pauseExternal', until]]);
  // A tab no run owns (a plain terminal) pauses nothing.
  env.registry.onUsageLimit('plain-tab', until, { onAccount: true });
  assert.equal(pausesOf(env.made.alpha).length, 1);
});

test('A3: the account memory keeps the later reset, takes the meter exactly, forgets expired ones and ignores junk', () => {
  let now = 1000;
  const registry = createOrchestraRegistry({ now: () => now, makeController: () => fakeController(null) });
  registry.noteAccountLimit('a', 5000);
  registry.noteAccountLimit('a', 3000);
  assert.deepEqual(registry.limitedAccounts(), { a: 5000 }, 'a weekly wall outlasts a 5 h one');
  registry.setAccountLimit('a', 2000);
  assert.deepEqual(registry.limitedAccounts(), { a: 2000 }, "the meter's real reset replaces the guess");
  registry.noteAccountLimit('b', null);
  assert.equal(registry.limitedAccounts().b, 1000 + 60 * 60 * 1000, 'no readable reset: an hour');
  registry.clearAccountLimit('b');
  registry.noteAccountLimit('', 9000);
  registry.noteAccountLimit({ id: 'x' }, 9000);
  registry.setAccountLimit('c', 500);
  assert.deepEqual(registry.limitedAccounts(), { a: 2000 });
  now = 2001;
  assert.deepEqual(registry.limitedAccounts(), {});
});

test('A3: every controller gets the same shared power flow; none without power deps', () => {
  const seen = [];
  const power = { power: { scheduleWake: async () => ({ ok: true }) } };
  const registry = createOrchestraRegistry({
    power,
    makeController: (projectId, shared) => {
      seen.push(shared.powerFlow);
      return fakeController(projectId);
    },
  });
  registry.ensure('alpha');
  registry.ensure('beta');
  assert.ok(registry.powerFlow);
  assert.equal(seen[0], registry.powerFlow);
  assert.equal(seen[1], registry.powerFlow);
  const bare = setup({ alpha: {} });
  bare.registry.ensure('alpha');
  assert.equal(bare.registry.powerFlow, null);
});
