// ============================================================================
// God Mode self-healing workers (src/orchestraHeal.js): the pure error
// classifier and heal decision, the resume brief section, and the heal
// controller with the run, the install and the timers faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LOCK_RETRY_MS,
  PERMISSION_RETRY_MS,
  classifyEnvError,
  normalizeHeals,
  healDecision,
  healBriefSection,
  createHealer,
} = require('../src/orchestraHeal.js');
const { createOrchestra } = require('../src/orchestra.js');
const sup = require('../src/orchestraSupervisor.js');
const { createFixupRunner } = require('../src/orchestraFixup.js');
const { agyTurnEndLine } = require('../src/agytranscript.js');
const { AgyTranscriptWatcher } = require('../src/agywatcher.js');

// ---- classifyEnvError ---------------------------------------------------------

test('classifyEnvError: a missing bare package is a dependency problem', () => {
  assert.deepEqual(classifyEnvError("Error: Cannot find module 'lodash'\nRequire stack:\n- /wt/a/src/x.js"), {
    kind: 'deps',
    match: "Cannot find module 'lodash'",
  });
  assert.equal(classifyEnvError("Cannot find package '@scope/tool' imported from /wt/a/x.mjs").kind, 'deps');
  assert.equal(classifyEnvError('Cannot find module "left-pad/lib/index.js"').kind, 'deps');
  assert.equal(classifyEnvError('npm test failed: node_modules is missing').kind, 'deps');
  assert.equal(classifyEnvError('the node_modules folder looks empty').kind, 'deps');
  assert.equal(classifyEnvError('blocked on a missing dependency').kind, 'deps');
});

test("classifyEnvError: the worker's own missing file is no environment error", () => {
  assert.equal(classifyEnvError("Cannot find module './util.js'"), null);
  assert.equal(classifyEnvError("Cannot find module '../src/orchestraHeal.js'"), null);
  assert.equal(classifyEnvError("Cannot find module 'C:\\wt\\a\\src\\gone.js'"), null);
  assert.equal(classifyEnvError("Cannot find module '/wt/a/gone.js'"), null);
});

test('classifyEnvError: locks and permission errors', () => {
  assert.deepEqual(classifyEnvError("EBUSY: resource busy or locked, rename 'C:\\wt\\a\\x'"), { kind: 'lock', match: 'EBUSY' });
  assert.equal(classifyEnvError('the file is in use: resource busy or locked').kind, 'lock');
  assert.deepEqual(classifyEnvError("EPERM: operation not permitted, unlink 'x'"), { kind: 'permission', match: 'EPERM' });
  assert.equal(classifyEnvError('EACCES: permission denied, open x').kind, 'permission');
  assert.equal(classifyEnvError('bash: ./run.sh: Permission denied').kind, 'permission');
});

test('classifyEnvError: dependencies win over a lock, a lock over a permission error', () => {
  assert.equal(classifyEnvError("EPERM: operation not permitted\nError: Cannot find module 'chalk'").kind, 'deps');
  assert.equal(classifyEnvError("EPERM: operation not permitted, rename\nEBUSY: resource busy or locked").kind, 'lock');
});

test('classifyEnvError: anything else, empty input and old text past the window are null', () => {
  for (const text of [null, undefined, '', '   ', 'AssertionError: expected 1 to equal 2', 'EPERMISSIONS are fine', 42]) {
    assert.equal(classifyEnvError(text), null, String(text));
  }
  const old = `EBUSY: resource busy or locked\n${'x'.repeat(7000)}`;
  assert.equal(classifyEnvError(old), null, 'only the end of a long text counts');
});

test('normalizeHeals keeps known kinds once, in a fixed order', () => {
  assert.deepEqual(normalizeHeals(undefined), []);
  assert.deepEqual(normalizeHeals('deps'), []);
  assert.deepEqual(normalizeHeals(['lock', 'junk', 'deps', 'deps']), ['deps', 'lock']);
});

// ---- healDecision ---------------------------------------------------------------

const stalledPkg = (extra = {}) => ({ id: 'a', root: '/wt/a', branch: 'luna/a', heals: [], lastWords: null, verifyTail: null, ...extra });

test('healDecision: a healable stall with a recognisable error, once per kind', () => {
  assert.deepEqual(healDecision(stalledPkg(), 'blocked', "Cannot find module 'lodash'"), {
    kind: 'deps',
    match: "Cannot find module 'lodash'",
    delayMs: 0,
  });
  assert.equal(healDecision(stalledPkg({ heals: ['deps'] }), 'blocked', "Cannot find module 'lodash'"), null, 'spent');
  assert.equal(healDecision(stalledPkg({ heals: ['deps'] }), 'blocked', 'EBUSY: resource busy or locked').kind, 'lock', 'another kind still heals');
});

test('healDecision: only blocked / noMarker / verifyFailed, only with a worktree', () => {
  for (const reason of ['timeout', 'needsApproval', 'closed', 'restarted', 'pushFailed', 'noCommitsFailed']) {
    assert.equal(healDecision(stalledPkg(), reason, "Cannot find module 'lodash'"), null, reason);
  }
  assert.equal(healDecision(stalledPkg({ root: null }), 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(stalledPkg({ branch: null }), 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(null, 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(stalledPkg(), 'blocked', 'the API key is missing'), null);
});

test('healDecision: the evidence that fits the reason - verify tail or last words', () => {
  const verify = healDecision(stalledPkg({ verifyTail: 'Error: EBUSY: resource busy or locked, open x' }), 'verifyFailed', '1 failing');
  assert.deepEqual(verify, { kind: 'lock', match: 'EBUSY', delayMs: LOCK_RETRY_MS });
  const words = healDecision(stalledPkg({ lastWords: 'npm test: EACCES: permission denied' }), 'noMarker', null);
  assert.deepEqual(words, { kind: 'permission', match: 'EACCES', delayMs: PERMISSION_RETRY_MS });
  // A verify failure is judged by its output, not by what the worker said before.
  assert.equal(healDecision(stalledPkg({ lastWords: 'EBUSY earlier' }), 'verifyFailed', 'AssertionError'), null);
});

test('healBriefSection says what LunaCore did and forbids repairing the environment by hand', () => {
  const deps = healBriefSection({ kind: 'deps', match: "Cannot find module 'lodash'", delayMs: 0 });
  assert.match(deps, /^## Self-heal \(LunaCore\)\n/);
  assert.match(deps, /dependency install \(npm ci\)/);
  assert.match(deps, /Cannot find module 'lodash'/);
  assert.match(deps, /no chmod, no icacls, no linking node_modules/);
  assert.match(deps, /LUNA_BLOCKED/);
  assert.match(healBriefSection({ kind: 'lock', match: 'EBUSY', delayMs: LOCK_RETRY_MS }), /waited 30 s .*locked file \(EBUSY\)/);
  assert.match(healBriefSection({ kind: 'permission', match: 'EPERM', delayMs: PERMISSION_RETRY_MS }), /waited 30 s .*permission error \(EPERM\)/);
});

// ---- createHealer ---------------------------------------------------------------

const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

function harness({ enabled = true, live = true, install = null, resumeOk = true } = {}) {
  const pkgs = new Map();
  const calls = { patches: [], records: [], commits: 0, installs: [], resumes: [], giveUps: [], events: [], timers: [], cleared: [] };
  let clock = 5000;
  const healer = createHealer({
    enabled: () => enabled,
    live: () => live,
    getPkg: (id) => pkgs.get(id) || null,
    patch: (id, fields) => {
      calls.patches.push([id, fields]);
      pkgs.set(id, { ...pkgs.get(id), ...fields });
    },
    record: (id, entry) => calls.records.push([id, entry]),
    commit: () => {
      calls.commits += 1;
    },
    installDeps: (root) => {
      calls.installs.push(root);
      return install ? install(root) : Promise.resolve({ ok: true, output: 'added 12 packages' });
    },
    resume: (id, section) => {
      calls.resumes.push([id, section]);
      return resumeOk;
    },
    giveUp: (id, reason, detail) => calls.giveUps.push([id, reason, detail]),
    onEvent: (kind, data) => calls.events.push([kind, data]),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      calls.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      calls.cleared.push(t);
      t.done = true;
    },
  });
  const stall = (id, extra = {}) => {
    const p = { id, state: 'stalled', root: `/wt/${id}`, branch: `luna/${id}`, heals: [], ...extra };
    pkgs.set(id, p);
    return p;
  };
  const fire = () => {
    clock += LOCK_RETRY_MS;
    for (const t of calls.timers) {
      if (!t.done) {
        t.done = true;
        t.fn();
      }
    }
  };
  return { healer, calls, pkgs, stall, fire };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a missing dependency: the heal is spent first, the install runs, the worker resumes once', async () => {
  const h = harness();
  const pkg = h.stall('a');
  assert.equal(h.healer.tryHeal(pkg, 'blocked', "Cannot find module 'lodash'"), true);
  assert.deepEqual(h.calls.patches, [['a', { heals: ['deps'] }]], 'spent before the fix runs');
  assert.deepEqual(h.calls.records[0], ['a', { at: 5000, kind: 'heal', reason: 'blocked', detail: "deps: Cannot find module 'lodash'" }]);
  assert.deepEqual(h.calls.events, [['healing', { id: 'a', kind: 'deps' }]]);
  assert.equal(h.healer.busy(), true);
  assert.equal(h.healer.isHealing('a'), true);
  assert.deepEqual(h.healer.view(h.pkgs.get('a')), { heals: ['deps'], healing: 'deps' });

  await flush();
  assert.deepEqual(h.calls.installs, ['/wt/a']);
  assert.equal(h.calls.resumes.length, 1);
  assert.equal(h.calls.resumes[0][0], 'a');
  assert.match(h.calls.resumes[0][1], /## Self-heal \(LunaCore\)/);
  assert.deepEqual(h.calls.records[1], ['a', { at: 5000, kind: 'heal', reason: 'blocked', detail: 'deps: resumed' }]);
  assert.deepEqual(h.calls.events.map(([k]) => k), ['healing', 'healed']);
  assert.equal(h.calls.commits, 1);
  assert.deepEqual(h.calls.giveUps, []);
  assert.equal(h.healer.busy(), false);
  assert.deepEqual(h.healer.view(h.pkgs.get('a')), { heals: ['deps'], healing: null });

  // The same error again: no second heal of this kind, ever.
  h.pkgs.set('a', { ...h.pkgs.get('a'), state: 'stalled' });
  assert.equal(h.healer.tryHeal(h.pkgs.get('a'), 'blocked', "Cannot find module 'lodash'"), false);
  assert.deepEqual(h.calls.installs, ['/wt/a']);
});

test('one heal at a time per package; off, or an unknown error, heals nothing', () => {
  const h = harness({ install: () => new Promise(() => {}) });
  const pkg = h.stall('a');
  assert.equal(h.healer.tryHeal(pkg, 'blocked', "Cannot find module 'lodash'"), true);
  assert.equal(h.healer.tryHeal(pkg, 'blocked', 'EBUSY: resource busy or locked'), false, 'one in flight');

  const off = harness({ enabled: false });
  assert.equal(off.healer.tryHeal(off.stall('a'), 'blocked', "Cannot find module 'lodash'"), false);
  assert.deepEqual([off.calls.patches, off.calls.records, off.calls.installs], [[], [], []]);

  const unknown = harness();
  assert.equal(unknown.healer.tryHeal(unknown.stall('a'), 'blocked', 'the API key is missing'), false);
  assert.equal(unknown.healer.view(unknown.pkgs.get('a')), null, 'nothing to show');
  assert.equal(unknown.healer.tryHeal(null, 'blocked', "Cannot find module 'x'"), false);
});

test('a failed install hands the stall to its usual handling, with the reason', async () => {
  const h = harness({ install: async () => ({ ok: false, output: 'npm ci\nnpm ERR! code E404\n' }) });
  assert.equal(h.healer.tryHeal(h.stall('a'), 'verifyFailed', "Error: Cannot find module 'chalk'"), true);
  await flush();
  assert.deepEqual(h.calls.resumes, []);
  assert.deepEqual(h.calls.giveUps, [['a', 'verifyFailed', "Error: Cannot find module 'chalk'"]]);
  assert.equal(h.calls.records[1][1].detail, 'deps: fix failed - npm ERR! code E404');
  assert.deepEqual(h.calls.events.map(([k]) => k), ['healing', 'healFailed']);
  assert.equal(h.healer.busy(), false);
});

test('an install that throws is a failed fix too', async () => {
  const h = harness({ install: async () => { throw new Error('spawn npm ENOENT'); } });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'chalk'");
  await flush();
  assert.equal(h.calls.records[1][1].detail, 'deps: fix failed - spawn npm ENOENT');
  assert.deepEqual(h.calls.giveUps, [['a', 'blocked', "Cannot find module 'chalk'"]]);
});

test('a lock waits LOCK_RETRY_MS, a permission error PERMISSION_RETRY_MS, then the worker resumes; nothing is installed', () => {
  const h = harness();
  assert.equal(h.healer.tryHeal(h.stall('a'), 'blocked', 'EBUSY: resource busy or locked'), true);
  assert.equal(h.healer.tryHeal(h.stall('b'), 'noMarker', 'EPERM: operation not permitted'), true);
  assert.deepEqual(h.calls.timers.map((t) => t.ms), [LOCK_RETRY_MS, PERMISSION_RETRY_MS]);
  assert.deepEqual(h.calls.resumes, [], 'not before the wait');
  h.fire();
  assert.deepEqual(h.calls.resumes.map(([id]) => id), ['a', 'b']);
  assert.match(h.calls.resumes[0][1], /waited 30 s .*locked file/);
  assert.match(h.calls.resumes[1][1], /waited 30 s .*permission error/);
  assert.deepEqual(h.calls.installs, []);
  assert.deepEqual(h.pkgs.get('b').heals, ['permission']);
});

test('a heal cancelled meanwhile (kill, Retry by hand) does nothing when its fix lands', async () => {
  const d = deferred();
  const h = harness({ install: () => d.promise });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'lodash'");
  h.healer.cancel('a');
  assert.equal(h.healer.busy(), false);
  d.resolve({ ok: true });
  await flush();
  assert.deepEqual([h.calls.resumes, h.calls.giveUps], [[], []]);

  const t = harness();
  t.healer.tryHeal(t.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  t.healer.tryHeal(t.stall('b'), 'blocked', 'EPERM: operation not permitted');
  t.healer.cancelAll();
  assert.equal(t.calls.cleared.length, 2, 'both timers cleared');
  t.fire();
  assert.deepEqual([t.calls.resumes, t.calls.giveUps], [[], []]);
});

test('a package that left stalled meanwhile is not resumed; a run that is not live gives up', async () => {
  const d = deferred();
  const h = harness({ install: () => d.promise });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'lodash'");
  // The worker finished in its still-open tab while the install ran.
  h.pkgs.set('a', { ...h.pkgs.get('a'), state: 'finishing' });
  d.resolve({ ok: true });
  await flush();
  assert.deepEqual([h.calls.resumes, h.calls.giveUps], [[], []]);

  const paused = harness({ live: false });
  paused.healer.tryHeal(paused.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  paused.fire();
  assert.deepEqual(paused.calls.resumes, [], 'no worker starts in a paused run');
  assert.deepEqual(paused.calls.giveUps, [['a', 'blocked', 'EBUSY: resource busy or locked']]);
  assert.equal(paused.calls.records[1][1].detail, 'lock: not resumed');

  const noTab = harness({ resumeOk: false });
  noTab.healer.tryHeal(noTab.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  noTab.fire();
  assert.equal(noTab.calls.resumes.length, 1);
  assert.deepEqual(noTab.calls.giveUps, [['a', 'blocked', 'EBUSY: resource busy or locked']]);
  assert.deepEqual(noTab.calls.events.map(([k]) => k), ['healing', 'healFailed']);
});

// ---- End-to-end controller tests (injected fakes, no real CLIs) --------------------

const ARGON_MODEL = 'agy:gemini-4-argon-medium';
const LIVE_AGY = [
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
];
const tmpDirs = [];
test.after(async () => {
  for (const dir of tmpDirs) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const claudeTurn = (text) =>
  JSON.stringify({ message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function controllerHarness({
  packages,
  prefModel = 'opus',
  selfHeal = true,
  agyWarm = true,
  agyProfile = 'agy-1',
  installImpl = null,
  finishImpl = null,
  reviews = [],
  initialState = null,
  extraDeps = {},
} = {}) {
  let clock = 1700000000000;
  let seq = 0;
  const alive = new Set();
  const timers = [];
  const reviewQueue = [...reviews];
  const log = { sessions: [], closed: [], writes: [], installs: [], ticks: [], briefs: new Map(), events: [], lines: [], agyEnsures: 0, finishes: [] };
  const liveIds = LIVE_AGY.map((m) => m.id);
  const agyModels = {
    ensure: async () => {
      log.agyEnsures += 1;
      agyWarm = true;
      return LIVE_AGY.map((m) => ({ ...m }));
    },
    list: () => (agyWarm ? LIVE_AGY.map((m) => ({ ...m })) : []),
    isKnownId: (id) => agyWarm && liveIds.includes(id),
    resolveModelId: (model) => {
      if (!agyWarm) return null;
      const id = typeof model === 'string' && model.startsWith('agy:') ? model.slice(4) : null;
      return id && liveIds.includes(id) ? id : null;
    },
  };
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [
      { at: 101, text: 'one', done: false },
      { at: 102, text: 'two', done: false },
      { at: 103, text: 'three', done: false },
      { at: 104, text: 'four', done: false },
    ],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({
      ok: true,
      raw: { packages: packages || [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'sonnet', effort: 'medium' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (_repo, name, opts = {}) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `${opts.branchPrefix || 'luna/'}${name}` }),
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: (file, text) => {
      log.briefs.set(file, text);
      return true;
    },
    createSession: (opts) => {
      seq += 1;
      const id = `s${seq}`;
      log.sessions.push({ id, ...opts });
      alive.add(id);
      return { id };
    },
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    sessionAlive: (id) => alive.has(id),
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    installDeps: async (root, opts) => {
      log.installs.push([root, opts]);
      return installImpl ? installImpl(root, opts) : { ok: true, output: 'added 5' };
    },
    checkNodeModules: () => ({ ok: true }),
    finishPackage: async (pkg) => {
      log.finishes.push({ id: pkg.id, branch: pkg.branch, pushOnVerifyFail: pkg.pushOnVerifyFail });
      return finishImpl ? finishImpl(pkg) : { ok: true, headSha: 'sha-123' };
    },
    tickTodos: (projectId, ats) => log.ticks.push([projectId, ats]),
    workerSettings: () => ({ model: prefModel, effort: 'plan', permissionMode: 'bypassPermissions', integration: 'branches', allowedTools: [], selfHeal }),
    saveWorkerModel: () => {},
    saveState: () => {},
    loadState: () => initialState,
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    log: (line) => log.lines.push(line),
    agyProfileId: () => agyProfile,
    agyModels,
    freeProfileId: () => 'free-coding',
    codingProfileId: () => 'free-coding',
    freshEnv: () => ({ PATH: '/bin' }),
    usageLimits: () => [],
    reviewDiff: async () => ({ ok: true, diff: 'diff --git a/src/a.js b/src/a.js', stat: ' 1 file changed' }),
    runReview: async () => (reviewQueue.length ? reviewQueue.shift() : { ok: true, verdict: 'pass', reasons: [] }),
    ...extraDeps,
  });
  orch.restore();
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
  const byId = (id) => orch.view().packages.find((p) => p.id === id);
  const ctx = { projectId: 'p1', repoPath: path.resolve('/repo'), profileId: 'claude-cloud', env: {} };
  return { orch, log, ctx, advance, flush, byId, alive, now: () => clock };
}

test('to-do ticking: Sonnet, plain agy (via AgyTranscriptWatcher), agy:<id>, free-only, and hybrid free each tick once on push', async () => {
  // 1. Claude Sonnet
  {
    const s = controllerHarness({ prefModel: 'sonnet' });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'claude', workerModel: 'sonnet', integration: 'branches' });
    assert.equal(s.log.sessions[0].task.model, 'sonnet');
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }

  // 2. Plain agy driven through AgyTranscriptWatcher (no false noMarker stall, duplicate turn ignored)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-e2e-'));
    const cwd = path.join(root, 'wt');
    fs.mkdirSync(cwd, { recursive: true });
    tmpDirs.push(root);
    const s = controllerHarness({
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'agy', effort: 'medium' }],
    });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'agy', integration: 'branches' });
    assert.equal(s.log.sessions[0].profileId, 'agy-1');
    assert.equal(s.log.sessions[0].strictProfile, true);
    assert.equal(s.log.sessions[0].task.model, 'agy');

    const watcher = new AgyTranscriptWatcher(() => {}, {
      cwd,
      appDataDir: root,
      log: () => {},
      onTurnEnd: (turn) => s.orch.onTurnEnd('s1', turn.text),
    });
    watcher.snapshotBaseline();
    const convDir = path.join(root, 'brain', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    const file = path.join(convDir, 'transcript_full.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-17T08:00:00Z', content: 'start' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:01:00Z', content: 'Implemented.\nLUNA_DONE a' }),
      '',
    ].join('\n'));
    watcher.safeTick();
    watcher.stop();
    await s.flush();
    // Repeating turn end must not tick again.
    s.orch.onTurnEnd('s1', agyTurnEndLine('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }

  // 3. agy:<id> variant
  {
    const s = controllerHarness();
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'claude', workerModel: ARGON_MODEL, integration: 'branches' });
    assert.equal(s.log.sessions[0].profileId, 'agy-1');
    assert.equal(s.log.sessions[0].strictProfile, true);
    assert.equal(s.log.sessions[0].task.model, ARGON_MODEL);
    s.orch.onTurnEnd('s1', agyTurnEndLine('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }

  // 4. Free-only profile (luna-free/*)
  {
    const s = controllerHarness();
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'free', integration: 'branches' });
    assert.equal(s.log.sessions[0].profileId, 'free-coding');
    assert.equal(s.log.sessions[0].strictProfile, true);
    assert.match(s.log.sessions[0].branch, /^luna-free\//);
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.equal(s.log.finishes[0].pushOnVerifyFail, true);
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }

  // 5. Hybrid free package -> ticks once after Claude review PASS
  {
    const s = controllerHarness({
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'free', effort: 'medium' }],
    });
    const { plan } = await s.orch.makePlan({ ...s.ctx, workers: 'hybrid' });
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
    assert.equal(s.log.sessions[0].profileId, 'free-coding');
    assert.equal(s.log.sessions[0].strictProfile, true);
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }
});

test('mixed pool: Opus, Sonnet, agy:<id>, and free each launch on own profile and tick their cards once', async () => {
  const packages = [
    { id: 'p-opus', title: 'O', todoAts: [101], prompt: 'o', files: ['a.js'], dependsOn: [], verify: 'npm test', model: 'opus', effort: 'medium' },
    { id: 'p-sonnet', title: 'S', todoAts: [102], prompt: 's', files: ['b.js'], dependsOn: [], verify: 'npm test', model: 'sonnet', effort: 'medium' },
    { id: 'p-agy', title: 'G', todoAts: [103], prompt: 'g', files: ['c.js'], dependsOn: [], verify: 'npm test', model: 'agy-argon', effort: 'medium' },
    { id: 'p-free', title: 'F', todoAts: [104], prompt: 'f', files: ['d.js'], dependsOn: [], verify: 'npm test', model: 'free', effort: 'medium' },
  ];
  const s = controllerHarness({ packages });
  const pool = [{ model: 'opus' }, { model: 'sonnet' }, { model: 'agy-argon' }, { model: 'free:free-coding' }];
  const { plan } = await s.orch.makePlan({ ...s.ctx, modelPool: pool });
  const launched = await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, modelPool: pool, integration: 'branches' });
  assert.equal(launched.ok, true);

  // MAX_PARALLEL is 3: opus, sonnet, and agy:<id> start first; free launches once a slot frees.
  const sessionOf = (pkgId) => s.log.sessions.find((sess) => sess.branch === s.byId(pkgId).branch);
  const sOpus = sessionOf('p-opus');
  const sSonnet = sessionOf('p-sonnet');
  const sAgy = sessionOf('p-agy');
  assert.equal(sOpus.profileId, 'claude-cloud');
  assert.equal(sOpus.task.model, 'opus');
  assert.equal('strictProfile' in sOpus, false);
  assert.equal(sSonnet.profileId, 'claude-cloud');
  assert.equal(sSonnet.task.model, 'sonnet');
  assert.equal(sAgy.profileId, 'agy-1');
  assert.equal(sAgy.strictProfile, true);
  assert.equal(sAgy.task.model, ARGON_MODEL);

  s.orch.onTurnEnd(sOpus.id, claudeTurn('LUNA_DONE p-opus'));
  await s.flush();
  const sFree = sessionOf('p-free');
  assert.ok(sFree, 'free package launches once a pool slot frees');
  assert.equal(sFree.profileId, 'free-coding');
  assert.equal(sFree.strictProfile, true);

  s.orch.onTurnEnd(sSonnet.id, claudeTurn('LUNA_DONE p-sonnet'));
  s.orch.onTurnEnd(sAgy.id, agyTurnEndLine('LUNA_DONE p-agy'));
  s.orch.onTurnEnd(sFree.id, claudeTurn('LUNA_DONE p-free'));
  await s.flush();

  for (const id of ['p-opus', 'p-sonnet', 'p-agy', 'p-free']) assert.equal(s.byId(id).state, 'pushed');
  assert.deepEqual(s.log.ticks.sort((a, b) => a[1][0] - b[1][0]), [['p1', [101]], ['p1', [102]], ['p1', [103]], ['p1', [104]]]);
});

test('free packages do not tick when verify pushes WIP, dropped/killed, or handed over unfinished to Sonnet', async () => {
  // 1. Free-only verifyFailed with WIP pushed to luna-free/* -> no tick
  {
    const s = controllerHarness({
      selfHeal: false,
      finishImpl: async () => ({ ok: false, stage: 'verify', output: 'AssertionError: 1 != 2', pushed: true }),
    });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'free', integration: 'branches' });
    // Exhaust MAX_VERIFY_ROUNDS -> stall #1 -> autoResume opens s2 -> exhaust again -> terminal stall.
    for (let i = 0; i < 3; i += 1) {
      s.orch.onTurnEnd('s1', claudeTurn('LUNA_DONE a'));
      await s.flush();
    }
    assert.equal(s.byId('a').state, 'launched', 'auto-resumed once on s2');
    for (let i = 0; i < 3; i += 1) {
      s.orch.onTurnEnd('s2', claudeTurn('LUNA_DONE a'));
      await s.flush();
    }
    assert.equal(s.byId('a').state, 'stalled');
    assert.deepEqual(s.log.ticks, []);
  }

  // 2. Hybrid free: reviewFail hands over unfinished -> 0 ticks; killed on Sonnet -> 0 ticks
  {
    const s = controllerHarness({
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'free', effort: 'medium' }],
      reviews: [{ ok: true, verdict: 'fail', reasons: ['missing edge check'] }],
    });
    const { plan } = await s.orch.makePlan({ ...s.ctx, workers: 'hybrid' });
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'launched', 'handed over to Sonnet unfinished');
    assert.equal(s.log.sessions[1].profileId, 'claude-cloud');
    assert.deepEqual(s.log.ticks, [], 'no tick when handed over unfinished');
    s.orch.kill();
    await s.flush();
    assert.deepEqual(s.log.ticks, [], 'no tick when dropped/killed');
  }

  // 3. Hybrid free stalled twice -> handed over unfinished (0 ticks), then ticks once when Sonnet lands
  {
    const s = controllerHarness({
      selfHeal: false,
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'free', effort: 'medium' }],
    });
    const { plan } = await s.orch.makePlan({ ...s.ctx, workers: 'hybrid' });
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_BLOCKED a: stuck 1'));
    s.orch.onTurnEnd('s2', claudeTurn('LUNA_BLOCKED a: stuck 2'));
    await s.flush();
    assert.equal(s.log.sessions[2].profileId, 'claude-cloud');
    assert.equal(s.log.sessions[2].task.model, 'sonnet');
    assert.deepEqual(s.log.ticks, [], 'still unfinished on hand-over');
    s.orch.onTurnEnd('s3', claudeTurn('LUNA_DONE a'));
    await s.flush();
    assert.equal(s.byId('a').state, 'pushed');
    assert.deepEqual(s.log.ticks, [['p1', [101]]]);
  }
});

test("self-heal: agy:<id> stall with 'Cannot find module x' heals deps and resumes on agy with the same model", async () => {
  const s = controllerHarness({ selfHeal: true });
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'claude', workerModel: ARGON_MODEL, integration: 'branches' });
  s.orch.onTurnEnd('s1', agyTurnEndLine("Error: Cannot find module 'x'\nLUNA_BLOCKED a: Cannot find module 'x'"));
  await s.flush();

  // installs[0] is the initial worktree install; installs[1] is self-heal's fresh install.
  assert.equal(s.log.installs.length, 2);
  assert.deepEqual(s.log.installs[1][1], { fresh: true });
  assert.equal(s.log.sessions.length, 2);
  const resumed = s.log.sessions[1];
  assert.equal(resumed.profileId, 'agy-1', 'resumes on own agy profile, never Claude');
  assert.equal(resumed.strictProfile, true);
  assert.equal(resumed.task.model, ARGON_MODEL, 'keeps exact agy:<id> model');
  assert.match(s.log.briefs.get(resumed.task.briefPath), /## Self-heal \(LunaCore\)/);
  assert.deepEqual(s.byId('a').heal, { heals: ['deps'], healing: null });

  s.orch.onTurnEnd('s2', agyTurnEndLine('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.byId('a').state, 'pushed');
  assert.deepEqual(s.log.ticks, [['p1', [101]]]);
});

test('self-heal: plain agy noMarker populates lastWords and refuses reopen if agyProfileId disappears', async () => {
  const s = controllerHarness({
    selfHeal: true,
    packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'agy', effort: 'medium' }],
  });
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'agy', integration: 'branches' });
  // Exhaust 3 nudges -> noMarker stall with lastWords mentioning missing module.
  for (let i = 0; i < 4; i += 1) {
    s.orch.onTurnEnd('s1', agyTurnEndLine("Still stuck: Cannot find module 'x'"));
    s.advance(6000);
  }
  // lastWords is captured from agy PLANNER_RESPONSE and drives deps classification before reopen resets it.
  assert.match(s.byId('a').lastWords || '', /Cannot find module 'x'/);
  await s.flush();
  assert.equal(s.log.installs.length, 2);
  assert.deepEqual(s.log.installs[1][1], { fresh: true });
  assert.equal(s.log.sessions[1].profileId, 'agy-1');
  assert.equal(s.log.sessions[1].task.model, 'agy');

  // Missing agyProfileId must refuse reopen rather than falling back to Claude.
  const wtRoot = path.resolve('/.luna-worktrees/repo/a');
  const noAgy = controllerHarness({
    agyProfile: null,
    initialState: {
      id: 'r-no-agy',
      repoPath: path.resolve('/repo'),
      profileId: 'claude-cloud',
      workers: 'agy',
      started: true,
      packages: [{
        id: 'a',
        title: 'A',
        todoAts: [101],
        prompt: 'do a',
        files: ['src/a.js'],
        dependsOn: [],
        verify: 'npm test',
        model: 'agy',
        state: 'stalled',
        root: wtRoot,
        cwd: wtRoot,
        branch: 'luna/a',
      }],
    },
  });
  const refused = await noAgy.orch.retry({ planId: 'r-no-agy', id: 'a' });
  assert.deepEqual(refused, { ok: false, error: 'noTab' });
  assert.equal(noAgy.log.sessions.length, 0, 'never falls back to Claude profile');
  assert.match(noAgy.log.lines.join('\n'), /refusing to fall back to Claude/);
});

test('self-heal: EBUSY on a free-only and hybrid-free worker waits LOCK_RETRY_MS and resumes on free profile', async () => {
  // 1. Free-only worker
  {
    const s = controllerHarness({ selfHeal: true });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'free', integration: 'branches' });
    const installsBeforeHeal = s.log.installs.length;
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_BLOCKED a: EBUSY: resource busy or locked'));
    s.advance(LOCK_RETRY_MS);
    await s.flush();

    assert.equal(s.log.installs.length, installsBeforeHeal, 'lock heal runs no fresh install');
    assert.equal(s.log.sessions.length, 2);
    assert.equal(s.log.sessions[1].profileId, 'free-coding', 'resumes on free profile, never Claude');
    assert.equal(s.log.sessions[1].strictProfile, true);
    assert.match(s.log.briefs.get(s.log.sessions[1].task.briefPath), /## Self-heal \(LunaCore\)/);
  }

  // 2. Hybrid free worker
  {
    const s = controllerHarness({
      selfHeal: true,
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'free', effort: 'medium' }],
    });
    const { plan } = await s.orch.makePlan({ ...s.ctx, workers: 'hybrid' });
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'hybrid', integration: 'branches' });
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_BLOCKED a: EBUSY: resource busy or locked'));
    s.advance(LOCK_RETRY_MS);
    await s.flush();

    assert.equal(s.log.sessions.length, 2);
    assert.equal(s.log.sessions[1].profileId, 'free-coding', 'hybrid free self-heal keeps coding profile');
    assert.equal(s.log.sessions[1].strictProfile, true);
    assert.equal(s.byId('a').modelOverride, null);
  }
});

test('escalation, retry, fix-up and failover pause keep non-Claude packages on their own kind', async () => {
  // 1. Non-Claude packages stay on their kind even if Settings workerModel is sonnet (no Opus escalation)
  {
    const s = controllerHarness({
      prefModel: 'sonnet',
      selfHeal: false,
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: ARGON_MODEL, effort: 'medium' }],
    });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'agy', integration: 'branches' });
    s.orch.onTurnEnd('s1', agyTurnEndLine('LUNA_BLOCKED a: bug 1'));
    s.orch.onTurnEnd('s2', agyTurnEndLine('LUNA_BLOCKED a: bug 2'));
    await s.flush();
    assert.equal(s.byId('a').escalated, false);
    assert.equal(s.byId('a').modelOverride, null);
    assert.equal(s.log.sessions[1].profileId, 'agy-1');
    assert.equal(s.log.sessions[1].task.model, ARGON_MODEL);
    assert.ok(!s.log.events.some(([k]) => k === 'escalated'));
  }

  // 2. Claude Sonnet still escalates to Opus after two stalls and shows on board
  {
    const s = controllerHarness({ prefModel: 'sonnet', selfHeal: false });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'claude', workerModel: 'sonnet', integration: 'branches' });
    s.orch.onTurnEnd('s1', claudeTurn('LUNA_BLOCKED a: hard bug 1'));
    s.orch.onTurnEnd('s2', claudeTurn('LUNA_BLOCKED a: hard bug 2'));
    await s.flush();
    assert.equal(s.byId('a').escalated, true);
    assert.equal(s.byId('a').modelOverride, 'opus');
    assert.equal(s.log.sessions[2].task.model, 'opus');
    assert.ok(s.log.events.some(([k]) => k === 'escalated'));
  }

  // 3. Restored agy:<id> package on retry warms agyModels before reopen and preserves buildPlanner: 'agy'
  {
    const wtRoot = path.resolve('/.luna-worktrees/repo/a');
    const stored = {
      id: 'r-agy',
      repoPath: path.resolve('/repo'),
      profileId: 'claude-cloud',
      agyProfileId: 'agy-1',
      buildPlanner: 'agy',
      workers: 'agy',
      workerModel: ARGON_MODEL,
      started: true,
      packages: [{
        id: 'a',
        title: 'A',
        todoAts: [101],
        prompt: 'do a',
        files: ['src/a.js'],
        dependsOn: [],
        verify: 'npm test',
        model: ARGON_MODEL,
        state: 'launched',
        root: wtRoot,
        cwd: wtRoot,
        branch: 'luna/a',
      }],
    };
    const s = controllerHarness({ initialState: stored, agyWarm: false });
    assert.equal(s.orch.view().buildPlanner, 'agy');
    const retried = await s.orch.retry({ planId: 'r-agy', id: 'a' });
    assert.equal(retried.ok, true);
    assert.equal(s.log.agyEnsures, 1);
    assert.equal(s.log.sessions[0].profileId, 'agy-1');
    assert.equal(s.log.sessions[0].strictProfile, true);
    assert.equal(s.log.sessions[0].task.model, ARGON_MODEL);
  }

  // 4. pauseExternal ignores pure agy / free runs, and mixed-pool pause only resumes Claude workers (agy keeps nudging)
  {
    const pureAgy = controllerHarness();
    const { plan: pa } = await pureAgy.orch.makePlan(pureAgy.ctx);
    await pureAgy.orch.launch({ planId: pa.id, ids: null, prompts: {}, workers: 'agy', integration: 'branches' });
    assert.equal(pureAgy.orch.pauseExternal(pureAgy.now() + 60000), false);
    assert.equal(pureAgy.orch.view().pausedUntil, null);

    const mixed = controllerHarness({
      packages: [
        { id: 'c', title: 'C', todoAts: [101], prompt: 'c', files: ['a.js'], dependsOn: [], verify: 'npm test', model: 'opus', effort: 'medium' },
        { id: 'g', title: 'G', todoAts: [102], prompt: 'g', files: ['b.js'], dependsOn: [], verify: 'npm test', model: 'agy-argon', effort: 'medium' },
      ],
    });
    const pool = [{ model: 'opus' }, { model: 'agy-argon' }];
    const { plan: pm } = await mixed.orch.makePlan({ ...mixed.ctx, modelPool: pool });
    await mixed.orch.launch({ planId: pm.id, ids: null, prompts: {}, modelPool: pool, integration: 'branches' });
    const resetAt = mixed.now() + 60000;
    assert.equal(mixed.orch.pauseExternal(resetAt), true);
    // While Claude is paused, the active agy worker still gets nudged after NUDGE_DELAY_MS.
    mixed.orch.onTurnEnd('s2', agyTurnEndLine('still working'));
    mixed.advance(6000);
    assert.equal(mixed.log.writes.length, 1);
    assert.equal(mixed.log.writes[0][0], 's2');
    mixed.log.writes.length = 0;
    mixed.advance(180000);
    assert.deepEqual(mixed.log.writes, [['s1', sup.RESUME_TEXT]], 'only Claude tab receives RESUME_TEXT');
  }

  // 5. createFixupRunner respects agy profileId and strictProfile
  {
    const sessions = [];
    const runner = createFixupRunner({
      getPlan: () => ({ id: 'gm-agy', profileId: 'claude-cloud', agyProfileId: 'agy-1', workers: 'agy', workerModel: ARGON_MODEL, projectId: 'p1', followups: false }),
      createSession: (opts) => (sessions.push(opts), { id: 'fx1' }),
      writeBrief: () => true,
      removeBrief: () => true,
      closeSession: () => {},
      sessionAlive: () => false,
      profileId: () => 'agy-1',
      strictProfile: () => true,
      model: () => ARGON_MODEL,
      permissionMode: () => 'bypassPermissions',
      setTimer: () => null,
      clearTimer: () => {},
    });
    const done = runner.run({ root: path.resolve('/wt/int'), brief: 'fix' });
    assert.equal(sessions[0].profileId, 'agy-1');
    assert.equal(sessions[0].strictProfile, true);
    assert.equal(sessions[0].task.model, ARGON_MODEL);
    runner.onTurnEnd('fx1', agyTurnEndLine('LUNA_DONE selfcheck'));
    assert.deepEqual(await done, { ok: true });
  }
});

test('regression: Opus path keeps exact createSession args, self-heal, and single todo tick', async () => {
  const s = controllerHarness({ selfHeal: true, prefModel: 'opus' });
  const { plan } = await s.orch.makePlan(s.ctx);
  const launched = await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'claude', workerModel: 'opus', integration: 'branches' });
  assert.equal(launched.ok, true);

  const first = s.log.sessions[0];
  assert.equal(first.profileId, 'claude-cloud');
  assert.equal('strictProfile' in first, false, 'Opus createSession opts unchanged');
  assert.equal(first.task.model, 'opus');

  s.orch.onTurnEnd('s1', claudeTurn("Error: Cannot find module 'lodash'\nLUNA_BLOCKED a: Cannot find module 'lodash'"));
  await s.flush();
  assert.equal(s.log.installs.length, 2);
  assert.deepEqual(s.log.installs[1], [first.cwd, { fresh: true }]);
  assert.equal(s.log.sessions.length, 2);
  const healed = s.log.sessions[1];
  assert.equal(healed.profileId, 'claude-cloud');
  assert.equal('strictProfile' in healed, false);
  assert.equal(healed.task.model, 'opus');
  assert.match(s.log.briefs.get(healed.task.briefPath), /## Self-heal \(LunaCore\)/);

  s.orch.onTurnEnd('s2', claudeTurn('LUNA_DONE a'));
  await s.flush();
  assert.equal(s.byId('a').state, 'pushed');
  assert.deepEqual(s.log.ticks, [['p1', [101]]]);
});

test('review fixes: retry killed live agy:<id>, mixed-pool pause, finishRun/shutdownResume cold warm, and hybrid fail-closed', async () => {
  // 1. Retrying a killed agy:<id> package with a still-open live tab warms agyModels and replaces the tab on agy.
  {
    let warm = true;
    const liveIds = LIVE_AGY.map((m) => m.id);
    const s = controllerHarness({
      packages: [{ id: 'a', title: 'A', todoAts: [101], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: ARGON_MODEL, effort: 'medium' }],
      extraDeps: {
        agyModels: {
          ensure: async () => {
            s.log.agyEnsures += 1;
            warm = true;
            return LIVE_AGY.map((m) => ({ ...m }));
          },
          list: () => (warm ? LIVE_AGY.map((m) => ({ ...m })) : []),
          isKnownId: (id) => warm && liveIds.includes(id),
          resolveModelId: (model) => {
            if (!warm) return null;
            const id = typeof model === 'string' && model.startsWith('agy:') ? model.slice(4) : null;
            return id && liveIds.includes(id) ? id : null;
          },
        },
      },
    });
    const { plan } = await s.orch.makePlan(s.ctx);
    await s.orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'agy', workerModel: ARGON_MODEL, integration: 'branches' });
    assert.equal(s.byId('a').sessionId, 's1');
    s.orch.kill();
    warm = false;
    const beforeEnsures = s.log.agyEnsures;
    const retried = await s.orch.retry({ planId: plan.id, id: 'a' });
    assert.equal(retried.ok, true);
    assert.equal(s.log.agyEnsures, beforeEnsures + 1);
    assert.equal(s.log.sessions[1].profileId, 'agy-1');
    assert.equal(s.log.sessions[1].strictProfile, true);
    assert.equal(s.log.sessions[1].strictBackend, 'agy');
    assert.equal(s.log.sessions[1].task.model, ARGON_MODEL);
    assert.deepEqual(s.log.closed, ['s1']);
  }

  // 2. Mixed-pool pauseExternal ('claude') lets pending agy launch via pump(), active agy heal & get sleep credit, and reports pausedUntil: null while agy runs.
  {
    let saved = null;
    const mixed = controllerHarness({
      selfHeal: true,
      packages: [
        { id: 'c', title: 'C', todoAts: [101], prompt: 'c', files: ['a.js'], dependsOn: [], verify: 'npm test', model: 'opus', effort: 'medium' },
        { id: 'g1', title: 'G1', todoAts: [102], prompt: 'g1', files: ['b.js'], dependsOn: [], verify: 'npm test', model: 'agy-argon', effort: 'medium' },
        { id: 'g2', title: 'G2', todoAts: [103], prompt: 'g2', files: ['e.js'], dependsOn: ['g1'], verify: 'npm test', model: 'agy-argon', effort: 'medium' },
      ],
      extraDeps: { saveState: (data) => (saved = data) },
    });
    const pool = [{ model: 'opus' }, { model: 'agy-argon' }];
    const { plan } = await mixed.orch.makePlan({ ...mixed.ctx, modelPool: pool });
    await mixed.orch.launch({ planId: plan.id, ids: null, prompts: {}, modelPool: pool, integration: 'branches' });
    const resetAt = mixed.now() + 120000;
    assert.equal(mixed.orch.pauseExternal(resetAt), true);
    assert.equal(mixed.orch.powerState().pausedUntil, null, 'PC must not sleep while unpaused agy runs');

    // Active agy stalls with missing dep -> self-heals on agy while Claude stays paused.
    mixed.orch.onTurnEnd('s2', agyTurnEndLine("Error: Cannot find module 'chalk'\nLUNA_BLOCKED g1: Cannot find module 'chalk'"));
    await mixed.flush();
    assert.equal(mixed.log.sessions.length, 3);
    assert.equal(mixed.log.sessions[2].profileId, 'agy-1');
    assert.equal(mixed.log.sessions[2].strictBackend, 'agy');
    assert.equal(mixed.log.sessions[2].task.model, ARGON_MODEL);

    // PC sleeps for 20s: active agy gets full sleep credit while paused Claude excludes pauseStartedAt.
    mixed.orch.onSystemSuspend();
    mixed.advance(20000);
    mixed.orch.onSystemResume();
    assert.equal(saved.packages.find((p) => p.id === 'g1').pausedMs, 20000);
    assert.equal(saved.packages.find((p) => p.id === 'c').pausedMs, 0);
    // Clear the 20s post-wake resumeGate before g1 pushes so pump() launches g2 right away.
    mixed.advance(25000);

    // g1 finishes -> pump() launches dependent pending g2 even while Claude is still paused.
    mixed.orch.onTurnEnd('s3', agyTurnEndLine('LUNA_DONE g1'));
    await mixed.flush();
    assert.equal(mixed.byId('g1').state, 'pushed');
    assert.equal(mixed.byId('g2').state, 'launched');
    assert.equal(mixed.log.sessions[3].task.model, ARGON_MODEL);

    // g2 finishes -> only paused Claude remains active, so powerState exposes pausedUntil now.
    mixed.orch.onTurnEnd('s4', agyTurnEndLine('LUNA_DONE g2'));
    await mixed.flush();
    assert.equal(mixed.orch.powerState().pausedUntil, resetAt);
  }

  // 3. finishRun() warms cold agyModels so fixup keeps agy:<id> + strictBackend: 'agy'; legacy fixup still falls back to Claude when strictProfile is false.
  {
    const wtRoot = path.resolve('/.luna-worktrees/repo/a');
    const stored = {
      id: 'fin-agy',
      repoPath: path.resolve('/repo'),
      profileId: 'claude-cloud',
      agyProfileId: 'agy-1',
      workers: 'agy',
      workerModel: ARGON_MODEL,
      baseBranch: 'main',
      integrationMode: 'merge',
      started: true,
      packages: [{
        id: 'a',
        title: 'A',
        todoAts: [101],
        prompt: 'do a',
        files: ['src/a.js'],
        dependsOn: [],
        verify: 'npm test',
        model: ARGON_MODEL,
        state: 'pushed',
        root: wtRoot,
        cwd: wtRoot,
        branch: 'luna/a',
        headSha: 'abc1234',
      }],
    };
    let resolveSelfCheck = false;
    let scCalls = 0;
    const s = controllerHarness({
      initialState: stored,
      agyWarm: false,
      extraDeps: {
        workerSettings: () => ({ model: 'opus', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'merge', checkCommand: 'npm test', allowedTools: [], selfHeal: true }),
        createSession: (opts) => {
          const sess = { id: `s${s.log.sessions.length + 1}`, ...opts };
          s.log.sessions.push(sess);
          s.alive.add(sess.id);
          if (opts.branch === null) setImmediate(() => s.orch.onTurnEnd(sess.id, agyTurnEndLine('LUNA_DONE selfcheck')));
          return { id: sess.id };
        },
        integrateMerge: async (_args, extra) => {
          const bp = await extra.beforePush(path.resolve('/wt/int'), { baseSha: 'base0' });
          assert.equal(bp.ok, true);
          return { ok: true, merged: ['a'], skipped: [] };
        },
        runSelfCheck: async () => {
          scCalls += 1;
          if (scCalls === 1) return { tests: 'failed', syntax: 'skipped', smoke: 'skipped', tail: 'fail', manualActions: [] };
          resolveSelfCheck = true;
          return { tests: 'passed', syntax: 'passed', smoke: 'skipped', manualActions: [] };
        },
      },
    });
    const fin = await s.orch.finishRun({ planId: 'fin-agy' });
    assert.equal(fin.ok, true);
    assert.equal(resolveSelfCheck, true);
    assert.equal(s.log.agyEnsures, 1);
    const fx = s.log.sessions.find((sess) => sess.branch === null);
    assert.equal(fx.profileId, 'agy-1');
    assert.equal(fx.strictProfile, true);
    assert.equal(fx.strictBackend, 'agy');
    assert.equal(fx.task.model, ARGON_MODEL);

    // Legacy falsy plan.profileId Claude fallback vs strict missing profile fail-closed:
    const legacySessions = [];
    const legacyRunner = createFixupRunner({
      getPlan: () => ({ id: 'gm-legacy', profileId: null, projectId: 'p1', followups: false }),
      createSession: (opts) => (legacySessions.push(opts), { id: 'fx-leg' }),
      writeBrief: () => true,
      closeSession: () => {},
      sessionAlive: () => false,
      model: () => 'opus',
      permissionMode: () => 'bypassPermissions',
      setTimer: () => null,
      clearTimer: () => {},
    });
    const legDone = legacyRunner.run({ root: path.resolve('/wt/int'), brief: 'fix' });
    assert.equal(legacySessions.length, 1);
    assert.equal('strictProfile' in legacySessions[0], false);
    legacyRunner.onTurnEnd('fx-leg', claudeTurn('LUNA_DONE selfcheck'));
    assert.deepEqual(await legDone, { ok: true });

    const strictRunner = createFixupRunner({
      getPlan: () => ({ id: 'gm-strict', profileId: 'claude-cloud', agyProfileId: null, projectId: 'p1', followups: false }),
      createSession: () => assert.fail('strict missing profile must not launch session'),
      writeBrief: () => true,
      closeSession: () => {},
      sessionAlive: () => false,
      profileId: () => null,
      strictProfile: () => true,
      strictBackend: () => 'agy',
      model: () => ARGON_MODEL,
      permissionMode: () => 'bypassPermissions',
      setTimer: () => null,
      clearTimer: () => {},
    });
    assert.deepEqual(await strictRunner.run({ root: path.resolve('/wt/int'), brief: 'fix' }), { ok: false });
  }

  // 4. shutdownResume.resume() warms cold agyModels for interrupted agy:<id> runs and marks isBusy() true while awaiting beforeResume().
  {
    const wtRoot = path.resolve('/.luna-worktrees/repo/a');
    let releaseEnsure = null;
    const ensurePromise = new Promise((r) => {
      releaseEnsure = r;
    });
    const stored = {
      id: 'shut-agy',
      repoPath: path.resolve('/repo'),
      profileId: 'claude-cloud',
      agyProfileId: 'agy-1',
      workers: 'agy',
      workerModel: ARGON_MODEL,
      started: true,
      interrupted: { kind: 'shutdown', at: 1700000000000, autoResumeAt: 1700000060000 },
      packages: [{
        id: 'a',
        title: 'A',
        todoAts: [101],
        prompt: 'do a',
        files: ['src/a.js'],
        dependsOn: [],
        verify: 'npm test',
        model: ARGON_MODEL,
        state: 'launched',
        root: wtRoot,
        cwd: wtRoot,
        branch: 'luna/a',
      }],
    };
    const s = controllerHarness({
      initialState: stored,
      agyWarm: false,
      extraDeps: {
        agyModels: {
          ensure: async () => {
            s.log.agyEnsures += 1;
            await ensurePromise;
            return LIVE_AGY.map((m) => ({ ...m }));
          },
          list: () => (s.log.agyEnsures > 0 ? LIVE_AGY.map((m) => ({ ...m })) : []),
          isKnownId: (id) => s.log.agyEnsures > 0 && LIVE_AGY.some((m) => m.id === id),
          resolveModelId: (m) => (s.log.agyEnsures > 0 && m === ARGON_MODEL ? ARGON_MODEL.slice(4) : null),
        },
      },
    });
    const resuming = s.orch.resumeInterrupted({ planId: 'shut-agy' });
    assert.equal(s.orch.isBusy(), true, 'isBusy includes shutdownResume.isResuming()');
    const blockedPlan = await s.orch.makePlan(s.ctx);
    assert.deepEqual(blockedPlan, { ok: false, error: 'busy' });
    releaseEnsure();
    await resuming;
    await s.flush();
    assert.equal(s.orch.isBusy(), false);
    assert.equal(s.log.agyEnsures, 1);
    assert.equal(s.log.sessions[0].profileId, 'agy-1');
    assert.equal(s.log.sessions[0].task.model, ARGON_MODEL);
  }

  // 5. Hybrid run fails closed (refuses Claude fallback) if plan.hybridProfileId is missing.
  {
    const wtRoot = path.resolve('/.luna-worktrees/repo/a');
    const stored = {
      id: 'hyb-bad',
      repoPath: path.resolve('/repo'),
      profileId: 'claude-cloud',
      workers: 'hybrid',
      hybridProfileId: null,
      started: true,
      packages: [{
        id: 'a',
        title: 'A',
        todoAts: [101],
        prompt: 'do a',
        files: ['src/a.js'],
        dependsOn: [],
        verify: 'npm test',
        model: 'free',
        state: 'stalled',
        error: 'blocked',
        root: wtRoot,
        cwd: wtRoot,
        branch: 'luna/a',
      }],
    };
    const s = controllerHarness({ initialState: stored });
    const retried = await s.orch.retry({ planId: 'hyb-bad', id: 'a' });
    assert.equal(retried.ok, false);
    assert.equal(retried.error, 'noTab');
    assert.equal(s.log.sessions.length, 0);
  }
});
