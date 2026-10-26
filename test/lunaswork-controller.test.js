// ============================================================================
// Luna's Work outer loop controller (src/lunaswork.js). Every dep is a fake:
// store, settings, God Mode, Director, builder, adapter, Playtester, Critic,
// clock and timers. Covers each verdict (SHIP needs the second opus
// Playtester; PLATEAU, RED, STOP, WAIT), persistence of every transition and
// resume after a restart, the red self-check gate (never pushed to main),
// model choices with reasons, isRiskyCard, the check command and model
// precedence, and the mutual exclusion with God Mode both ways.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  createLunasWork,
  isRiskyCard,
  riskReason,
  conflictedPaths,
  landedCards,
  effectiveModels,
  checkCommandFor,
  shipAgrees,
  restoreRun,
  parseModelOverride,
  FALLBACK_WAIT_MS,
} = require('../src/lunaswork');
const { createGodModeBuilder } = require('../src/lunasworkBuild');
const { createFinalizer } = require('../src/orchestraFinalize');
const { selfCheckGate, fixupBrief } = require('../src/orchestraSelfCheck');
const { DEFAULT_MODELS } = require('../src/lunasworkRules');

// Never touched on disk: every dep that would use it is a fake.
const REPO = path.resolve(os.tmpdir(), 'lw-controller-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-controller-runs');
const HOUR = 60 * 60 * 1000;
const START_CLOCK = 1_700_000_000_000;

const PHASES_OF_A_LAP = ['directing', 'building', 'launching', 'playtesting', 'critiquing'];
// A queued answer that means "the fake's default answer for this call".
const DEFAULT = Symbol('default');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));

/** Lets the async fakes run until `cond` holds (or gives up). */
async function until(cond) {
  for (let i = 0; i < 100 && !cond(); i += 1) await tick();
  assert.ok(cond(), 'condition reached');
}

const card = (at, extra = {}) => ({ at, text: `card ${at}`, done: false, tags: ['run:lwtest1'], size: 'S', ...extra });

const STOP_CARD = { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' };
const NO_CARDS = { ok: true, cards: [], model: 'opus', modelReason: 'setting' };

/**
 * A controller with a fake for every dep. `h.next.<dep>` is a queue of
 * scripted answers (a value, a function of the call's opts, or DEFAULT); an
 * empty queue falls back to the default answer.
 */
function harness(opts = {}) {
  const h = {
    clock: opts.clock || START_CLOCK,
    stored: opts.stored === undefined ? null : clone(opts.stored),
    saves: [],
    events: [],
    timers: [],
    ended: [],
    awake: { held: 0, released: 0 },
    adapters: [],
    launchFails: false,
    calls: { director: [], build: [], playtest: [], critic: [], shipGate: [] },
    next: { director: [], build: [], playtest: [], critic: [] },
    scores: opts.scores ? [...opts.scores] : [],
    todos: opts.todos ? clone(opts.todos) : [card(1), card(2)],
    settings: opts.settings || { models: {}, freeFallback: false, projects: {} },
    profile: { adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' },
    godMode: { active: false, checkCommand: 'npm test' },
    pack: { complete: true, missing: [] },
    confirm: true,
    confirms: [],
    syncs: [],
    sync: { ok: true },
    projects: { game: REPO },
  };

  const defaults = {
    director: (o) => {
      if (o.iteration > 12) throw new Error('runaway test run');
      const open = h.todos.filter((t) => !t.done);
      return { ok: true, stop: false, cards: open.slice(0, 3), model: 'opus', modelReason: 'setting', notes: 'next cards' };
    },
    build: (o) => {
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true } : t));
      return {
        ok: true,
        planId: 'p1',
        killed: false,
        integration: { state: 'done', error: null, skipped: [], selfCheck: { tests: 'passed', fixups: 0, pushedIntegrationBranch: null } },
        // God Mode's settled view names a package's cards by text.
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text) }] },
      };
    },
    playtest: (o) => ({
      ok: true,
      mode: o.mode,
      model: o.mode === 'shipConfirm' ? 'opus' : 'sonnet',
      modelReason: o.mode === 'shipConfirm' ? 'SHIP confirmation pass' : 'exploratory pass',
      report: {
        mode: o.mode,
        findings: [],
        scores: [{ milestone: 'skeleton', criterion: 'loads', score: 9 }],
        journeys: [{ name: 'j', passed: true }],
        screens: [],
      },
    }),
    critic: () => {
      const score = h.scores.length ? h.scores.shift() : 50;
      return {
        ok: true,
        verdict: 'continue',
        model: 'sonnet',
        modelReason: 'regular iteration',
        milestone: { name: 'skeleton', passed: false, score },
        next: 'skeleton',
        allPassed: false,
      };
    },
  };

  const take = (dep, o) => {
    const queued = h.next[dep].length ? h.next[dep].shift() : DEFAULT;
    if (queued === DEFAULT) return defaults[dep](o);
    return typeof queued === 'function' ? queued(o) : queued;
  };

  const deps = {
    store: {
      load: () => (h.stored ? clone(h.stored) : null),
      save: (data) => {
        h.stored = data === null ? null : clone(data);
        h.saves.push(h.stored);
        return true;
      },
    },
    settings: () => h.settings,
    projectOf: (id) => (id in h.projects ? { id, repoPath: h.projects[id] } : null),
    profileFor: () => h.profile,
    packStatus: () => h.pack,
    godModeActive: () => h.godMode.active,
    godModeCheckCommand: () => h.godMode.checkCommand,
    confirmStart: async (ctx) => {
      h.confirms.push(ctx);
      return typeof h.confirm === 'function' ? h.confirm(ctx) : h.confirm;
    },
    todoStore: () => ({
      read: () => h.todos,
      write: (list) => {
        h.todos = list;
        return true;
      },
    }),
    director: async (o) => {
      h.calls.director.push(o);
      return take('director', o);
    },
    build: async (o) => {
      h.calls.build.push(clone(o));
      return take('build', o);
    },
    createAdapter: (name, o) => {
      const adapter = {
        name,
        evidenceDir: path.join(EVIDENCE, `lunaswork-${o.runId}`, `iter-${o.iteration}`),
        started: 0,
        stopped: 0,
        start: async (profile) => {
          adapter.started += 1;
          adapter.profile = profile;
          if (h.launchFails) throw new Error('app did not answer');
          return { url: 'http://localhost:3000' };
        },
        stop: async () => {
          adapter.stopped += 1;
          return true;
        },
        tools: () => ({}),
      };
      h.adapters.push(adapter);
      return adapter;
    },
    playtest: async (o) => {
      h.calls.playtest.push({ mode: o.mode, free: o.free, running: !!o.adapter && o.adapter.stopped === 0 });
      return take('playtest', o);
    },
    shipGate: (o) => {
      h.calls.shipGate.push(o);
      return { allPassed: o.scores.length > 0 && o.scores.every((s) => s.score >= 8) };
    },
    critic: async (o) => {
      h.calls.critic.push(o);
      return take('critic', o);
    },
    gitLog: async () => 'abc123 a commit',
    syncCheckout: async (repoPath) => {
      h.syncs.push({ repoPath, phase: h.stored && h.stored.phase });
      return h.sync;
    },
    limitResumeAt: () => h.clock + HOUR,
    awake: { hold: () => (h.awake.held += 1), release: () => (h.awake.released += 1) },
    onRunEnd: [(run) => h.ended.push(run)],
    newRunId: () => 'lwtest1',
    now: () => h.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock + ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    log: () => {},
    ...(opts.deps || {}),
  };

  const ctl = createLunasWork(deps);
  ctl.subscribe((event) => h.events.push({ type: event.type, phase: event.status.phase, storedPhase: h.stored && h.stored.phase }));
  h.ctl = ctl;
  /** Lets the step loop run until it ends or waits. */
  h.settle = async () => {
    for (let i = 0; i < 5; i += 1) await ctl.idle();
  };
  /** Fires the earliest pending timer at its time, then lets the loop run. */
  h.fire = async () => {
    const pending = h.timers.filter((t) => !t.cleared).sort((a, b) => a.at - b.at);
    assert.ok(pending.length, 'a timer is pending');
    const t = pending[0];
    t.cleared = true;
    h.clock = Math.max(h.clock, t.at);
    t.fn();
    await h.settle();
  };
  h.start = async (payload = { projectId: 'game' }) => {
    const res = await ctl.start(payload);
    await h.settle();
    return res;
  };
  return h;
}

const shipCritic = () => ({
  ok: true,
  verdict: 'ship',
  model: 'opus',
  modelReason: 'milestone gate',
  milestone: { name: 'polish', passed: true, score: 95 },
  next: null,
  allPassed: true,
});

const redBuild = () => ({
  ok: true,
  planId: 'p1',
  killed: false,
  integration: {
    state: 'failed',
    error: 'selfCheckFailed',
    skipped: [],
    selfCheck: { tests: 'failed', fixups: 1, pushedIntegrationBranch: 'luna/p1-integration' },
  },
  plan: { packages: [] },
});

const doneBuild = () => ({ ok: true, integration: { state: 'done', skipped: [] }, plan: { packages: [] } });

const modelEntries = (h, role) => h.ctl.runLog().filter((e) => e.kind === 'model' && (!role || e.role === role));
const logText = (h) => h.ctl.runLog().map((e) => e.text || '').join('\n');

// ---- isRiskyCard ------------------------------------------------------------------

test('isRiskyCard: files or text touching IPC, auth or migrations / schema', () => {
  assert.equal(riskReason({ text: 'Wire the save button', files: ['src/preload.js'] }, []), 'ipc');
  assert.equal(riskReason({ text: 'x', files: ['src/lunasworkipc.js'] }, []), 'ipc');
  assert.equal(riskReason({ text: 'Expose the export through contextBridge' }, []), 'ipc');
  assert.equal(riskReason({ text: 'Add an ipcMain handler for export' }, []), 'ipc');
  assert.equal(riskReason({ text: 'x', files: ['src/auth/session.ts'] }, []), 'auth');
  assert.equal(riskReason({ text: 'Add OAuth sign-in' }, []), 'auth');
  assert.equal(riskReason({ text: 'Check authorization on every quote route' }, []), 'auth');
  assert.equal(riskReason({ text: 'x', files: ['src/authorisation.js'] }, []), 'auth');
  assert.equal(riskReason({ text: 'x', files: ['db/migrations/0003_quotes.sql'] }, []), 'migration');
  assert.equal(riskReason({ text: 'x', details: 'Change the schema of the quotes table' }, []), 'migration');
  assert.equal(isRiskyCard({ text: 'x', files: ['supabase/schema.sql'] }, []), true);
});

test('isRiskyCard: ordinary UI cards are not risky ("author" is not auth)', () => {
  assert.equal(isRiskyCard({ text: 'Show the author name under the title', files: ['src/components/Header.tsx'] }, []), false);
  assert.equal(isRiskyCard({ text: 'List the authors', files: ['src/authors/List.tsx'] }, []), false);
  assert.equal(isRiskyCard({ text: 'Bigger header font', files: ['src/styles.css'] }, []), false);
  assert.equal(isRiskyCard({ text: 'No files at all' }, []), false);
  assert.equal(isRiskyCard(null, []), false);
});

test('isRiskyCard: a file that had a merge conflict in the previous iteration', () => {
  const history = [
    { n: 1, files: ['src/old.js'] },
    { n: 2, files: ['src/quote/Calc.ts', 'src/ui/'] },
  ];
  assert.equal(riskReason({ text: 'Fix rounding', files: ['src/quote/Calc.ts'] }, history), 'conflict');
  // Windows separators and a leading ./ name the same file.
  assert.equal(isRiskyCard({ text: 'Fix rounding', files: ['.\\src\\quote\\Calc.ts'] }, history), true);
  // A card naming a folder covers a conflict inside it.
  assert.equal(isRiskyCard({ text: 'Tidy', files: ['src/quote'] }, history), true);
  // Only the previous iteration counts, not an older one.
  assert.equal(isRiskyCard({ text: 'Tidy', files: ['src/old.js'] }, history), false);
  assert.equal(isRiskyCard({ text: 'Tidy', files: ['src/other.js'] }, history), false);
  assert.equal(isRiskyCard({ text: 'Tidy', files: ['src/quote/Calc.ts'] }, []), false);
});

test('conflictedPaths reads the God Mode merge result: skipped conflicts and launch conflicts', () => {
  const settled = {
    integration: {
      skipped: [
        { id: 'a', stage: 'conflict', files: ['src/a.js', 'src/b.js'] },
        { id: 'b', stage: 'verify', files: ['src/never.js'] },
      ],
    },
    plan: { packages: [{ id: 'c', failure: { code: 'conflict', files: ['src/a.js', 'src/c.js'] } }, { id: 'd', failure: null }] },
  };
  assert.deepEqual(conflictedPaths(settled), ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.deepEqual(conflictedPaths(null), []);
});

test('conflicted paths are recorded per iteration and feed the next iteration\'s risk check', async () => {
  const h = harness({ scores: [40, 50] });
  h.next.build.push({ ...doneBuild(), integration: { state: 'done', skipped: [{ id: 'x', stage: 'conflict', files: ['src/a.js'] }] } });
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.deepEqual(restoreRun(h.stored).conflicts, [{ n: 1, files: ['src/a.js'] }]);
});

// ---- models and the check command ---------------------------------------------------

test('effectiveModels: run override > per-project override > global default', () => {
  const settings = {
    models: { director: 'sonnet', builder: 'opus' },
    projects: { game: { models: { builder: 'auto', critic: 'haiku' } } },
  };
  const { models, sources } = effectiveModels(settings, 'game', { critic: 'opus', playtester: 'haiku' });
  assert.equal(models.director, 'sonnet');
  assert.equal(sources.director, 'global');
  assert.equal(models.builder, 'auto');
  assert.equal(sources.builder, 'project');
  assert.equal(models.critic, 'opus');
  assert.equal(sources.critic, 'run');
  assert.equal(models.playtester, 'haiku');
  assert.equal(sources.playtester, 'run');
  assert.equal(models.reviewer, DEFAULT_MODELS.reviewer);
  // Another project gets none of this project's override.
  assert.equal(effectiveModels(settings, 'other', {}).models.builder, 'opus');
});

test('parseModelOverride refuses an unknown role or model as a whole', () => {
  assert.deepEqual(parseModelOverride(undefined), {});
  assert.deepEqual(parseModelOverride({ builder: 'sonnet' }), { builder: 'sonnet' });
  assert.equal(parseModelOverride({ builder: 'gpt-5' }), null);
  assert.equal(parseModelOverride({ wizard: 'opus' }), null);
  assert.equal(parseModelOverride(['opus']), null);
});

test("checkCommandFor: the profile's checkCommand, else God Mode's setting", () => {
  assert.equal(checkCommandFor({ checkCommand: 'npm run check' }, 'npm test'), 'npm run check');
  assert.equal(checkCommandFor({ checkCommand: '  ' }, 'npm test -- --silent'), 'npm test -- --silent');
  assert.equal(checkCommandFor(null, 'pytest'), 'pytest');
  // Both empty: '' = God Mode's finalizer falls back to its own default.
  assert.equal(checkCommandFor({ checkCommand: '' }, ''), '');
});

test("checkCommand precedence end to end; God Mode's own default is unchanged", async () => {
  const h = harness();
  h.profile = { ...h.profile, checkCommand: 'npm run check' };
  h.next.critic.push(shipCritic());
  await h.start();
  assert.equal(h.calls.build[0].checkCommand, 'npm run check');

  const h2 = harness();
  h2.godMode.checkCommand = 'npm test -- --runInBand';
  h2.next.critic.push(shipCritic());
  await h2.start();
  assert.equal(h2.calls.build[0].checkCommand, 'npm test -- --runInBand');

  // God Mode alone: its worker settings pass through untouched, and its
  // fix-up brief still defaults to npm test.
  const builder = createGodModeBuilder({ orchestra: {}, profileId: () => null, env: () => ({}) });
  const base = { model: 'opus', integration: 'pr', checkCommand: 'npm test' };
  assert.equal(builder.workerSettings(base), base);
  assert.match(fixupBrief({ tests: 'failed', syntax: 'skipped', smoke: 'skipped', tail: '' }, ''), /run `npm test`/);
});

// ---- verdicts ------------------------------------------------------------------------

test('SHIP: the Critic passes every gate AND a second, fresh opus Playtester agrees', async () => {
  const h = harness();
  h.next.critic.push(shipCritic());
  await h.start();

  const status = h.ctl.status();
  assert.equal(status.phase, 'done');
  assert.equal(status.verdict, 'ship');
  assert.deepEqual(h.calls.playtest.map((c) => c.mode), ['explore', 'shipConfirm']);
  // A fresh app for each pass, every one stopped afterwards.
  assert.equal(h.adapters.length, 2);
  assert.ok(h.adapters.every((a) => a.started === 1 && a.stopped === 1));
  assert.ok(h.calls.playtest.every((c) => c.running));
  // The SHIP pass is graded on its own scores.
  assert.equal(h.calls.shipGate.length, 1);
  const ship = modelEntries(h, 'playtester').find((e) => e.reason === 'SHIP confirmation pass');
  assert.equal(ship.model, 'opus');
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].verdict, 'ship');
  assert.equal(h.awake.held, 1);
  assert.equal(h.awake.released, 1);
});

test('SHIP is not given when the second Playtester disagrees - the run continues', async () => {
  const h = harness({ scores: [60] });
  h.next.critic.push(shipCritic());
  h.next.playtest.push(DEFAULT, (o) => ({
    ok: true,
    mode: o.mode,
    model: 'opus',
    modelReason: 'SHIP confirmation pass',
    report: { findings: [], scores: [{ criterion: 'loads', score: 5 }], journeys: [], screens: [] },
  }));
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();

  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.calls.director.length, 2, 'a second iteration was directed');
  assert.match(logText(h), /SHIP confirmation does not agree/);
});

test('SHIP is not given on the Critic alone when the confirmation pass fails', async () => {
  const h = harness();
  h.next.critic.push(shipCritic());
  h.next.playtest.push(DEFAULT, { ok: false, error: 'timeout', model: 'opus', modelReason: 'SHIP confirmation pass' });
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
});

test('shipAgrees needs a working pass, every gate on its scores, and no blocker', () => {
  const pass = { ok: true, report: { findings: [] } };
  assert.equal(shipAgrees(pass, { allPassed: true }), true);
  assert.equal(shipAgrees(pass, { allPassed: false }), false);
  assert.equal(shipAgrees({ ok: false }, { allPassed: true }), false);
  assert.equal(shipAgrees({ ok: true, report: { findings: [{ severity: 'blocker' }] } }, { allPassed: true }), false);
});

test('PLATEAU: 3 iterations with no score gain and no card closed', async () => {
  const h = harness({ scores: [50, 50, 48, 50] });
  // Nothing to build: no card can close.
  for (let i = 0; i < 6; i += 1) h.next.director.push(NO_CARDS);
  await h.start();
  const status = h.ctl.status();
  assert.equal(status.verdict, 'plateau');
  assert.equal(status.iteration, 4);
  assert.equal(h.calls.build.length, 0);
  assert.equal(h.ended.length, 1);
});

test('no PLATEAU while cards keep closing', async () => {
  const todos = Array.from({ length: 8 }, (_, i) => card(i + 1));
  const h = harness({ todos, scores: [50, 50, 50, 50, 50] });
  for (let i = 0; i < 4; i += 1) {
    h.next.director.push(() => ({ ok: true, cards: [h.todos.find((t) => !t.done)], model: 'opus', modelReason: 'setting' }));
  }
  h.next.director.push(STOP_CARD);
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().iteration, 5);
});

test('RED: red after fix-up in 2 iterations in a row', async () => {
  const h = harness({ scores: [40, 60] });
  h.next.build.push(redBuild(), redBuild());
  await h.start();
  const status = h.ctl.status();
  assert.equal(status.verdict, 'red');
  assert.equal(status.iteration, 2);
  assert.deepEqual(restoreRun(h.stored).history.map((r) => r.selfCheck), ['red', 'red']);
  assert.match(logText(h), /red result kept on luna\/p1-integration/);
});

test('a single red iteration does not stop the run', async () => {
  const h = harness({ scores: [40, 60] });
  h.next.build.push(redBuild());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.deepEqual(restoreRun(h.stored).history.map((r) => r.selfCheck), ['red']);
});

test("red self-check through God Mode's real finalizer: one fix-up, luna/<slug>-integration pushed, never main", async () => {
  // A Luna's Work build is in progress, so God Mode's worker settings carry
  // the project's check command (the lunasworkBuild workerSettings overlay).
  const hook = deferred();
  const orchestra = {
    makePlan: async (ctx) => {
      hook.resolve(ctx.onRunSettled);
      return { ok: true, plan: { id: 'plwtest', errors: [] } };
    },
    launch: async () => ({ ok: true }),
    cancelPlanWait: () => ({ ok: true }),
  };
  const builder = createGodModeBuilder({ orchestra, profileId: () => 'default', env: () => ({}) });
  const building = builder.build({
    projectId: 'game',
    repoPath: REPO,
    cards: [{ at: 1, text: 'x', model: 'opus' }],
    checkCommand: 'npm run check',
  });
  const onRunSettled = await hook.promise;

  const plan = {
    id: 'plwtest',
    projectId: 'game',
    repoPath: REPO,
    baseBranch: 'main',
    integrationMode: 'merge',
    approvalLog: [],
    integration: { state: 'idle', error: null, detail: null, at: null },
    packages: [{ id: 'a', state: 'pushed', branch: 'luna/a-1', verify: '', dependsOn: [], merged: false }],
  };
  const checks = [];
  const pushes = [];
  const basePushes = [];
  let fixups = 0;
  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => {
      plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
    },
    commit: () => {},
    view: () => ({ id: plan.id, packages: [] }),
    onRunEvent: () => {},
    now: () => 1,
    // Stands in for orchestraIntegrate.integrateMerge: the base is pushed
    // only when the beforePush gate says so.
    integrateMerge: async (args, extra) => {
      const gate = await extra.beforePush('/integration', { baseSha: null, merged: ['a'], skipped: [] });
      if (!gate.ok) return { ok: false, stage: 'beforePush', detail: gate.reason, merged: [], skipped: [] };
      basePushes.push(args.base);
      return { ok: true, merged: ['a'], skipped: [] };
    },
    runSelfCheck: async (args) => {
      checks.push(args.checkCommand);
      return { tests: 'failed', syntax: 'skipped', smoke: 'skipped', manualActions: [], tail: 'boom' };
    },
    runFixup: async () => {
      fixups += 1;
      return { ok: true };
    },
    pushBranch: async (_root, branch) => {
      pushes.push(branch);
      return { ok: true };
    },
    checkCommand: () => builder.workerSettings({ checkCommand: 'npm test' }).checkCommand,
  });
  await finalizer.finalize();

  assert.deepEqual(checks, ['npm run check', 'npm run check'], 'checked, fixed up once, checked again');
  assert.equal(fixups, 1);
  assert.deepEqual(pushes, ['luna/plwtest-integration']);
  assert.deepEqual(basePushes, [], 'main is never pushed');
  assert.equal(plan.integration.state, 'failed');
  assert.equal(plan.integration.error, 'selfCheckFailed');

  onRunSettled({ planId: plan.id, killed: false, integration: plan.integration, plan: { packages: [] } });
  const result = await building;

  // The controller reads that result as a red iteration.
  const h = harness({ scores: [40] });
  h.next.build.push(result);
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.deepEqual(restoreRun(h.stored).history.map((r) => r.selfCheck), ['red']);
  assert.match(logText(h), /luna\/plwtest-integration/);
});

test('STOP (kill switch): the running step finishes first, then the run ends', async () => {
  const h = harness();
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);

  const res = h.ctl.stop();
  assert.equal(res.ok, true);
  assert.equal(h.ctl.status().stopRequested, true);
  assert.equal(h.ctl.status().phase, 'building', 'the build is not cut off');

  build.resolve(doneBuild());
  await h.settle();
  const status = h.ctl.status();
  assert.equal(status.verdict, 'stop');
  assert.equal(status.stopReason, 'killSwitch');
  assert.equal(h.adapters.length, 0, 'nothing launched after the stop');
  assert.equal(h.ended.length, 1);
  assert.equal(h.awake.released, 1);
  assert.equal(h.ctl.stop().reason, 'no-run');
});

test('STOP from a `stop` steer card: the Director step ends the run, nothing is built', async () => {
  const h = harness();
  h.next.director.push({ ...STOP_CARD, cards: [card(1)] });
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().stopReason, 'steer');
  assert.equal(h.calls.build.length, 0);
});

test('a God Mode kill during the build stops the run', async () => {
  const h = harness();
  h.next.build.push({ ok: false, killed: true, integration: { state: 'idle' }, plan: { packages: [] } });
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().stopReason, 'godModeKilled');
});

test('WAIT: a usage limit pauses until the reset and then continues, with no cap', async () => {
  const h = harness();
  const limit = { ok: false, error: 'limit', detail: 'Claude AI usage limit reached' };
  h.next.critic.push(limit, limit, limit, limit, shipCritic());
  await h.start();

  let status = h.ctl.status();
  assert.equal(status.phase, 'critiquing');
  assert.equal(status.waitReason, 'limit');
  assert.equal(status.waitUntil, h.clock + HOUR);
  assert.equal(h.stored.waitUntil, status.waitUntil, 'the wait is persisted');
  assert.equal(h.calls.critic.length, 1);

  for (let i = 0; i < 4; i += 1) await h.fire();
  status = h.ctl.status();
  assert.equal(h.calls.critic.length, 5);
  assert.equal(status.verdict, 'ship');
  // The iteration was not repeated: one Director, one build.
  assert.equal(h.calls.director.length, 1);
  assert.equal(h.calls.build.length, 1);
});

test('WAIT without a known reset time looks again after the fallback wait', async () => {
  const h = harness({ deps: { limitResumeAt: () => null } });
  h.next.director.push({ ok: true, error: 'limit', cards: [], fallback: true });
  await h.start();
  assert.equal(h.ctl.status().waitUntil, h.clock + FALLBACK_WAIT_MS);
});

test('WAIT uses the resume time the builder reports (God Mode planning hit the limit)', async () => {
  const h = harness();
  h.next.build.push({ ok: false, error: 'limit', resumeAt: START_CLOCK + 3 * HOUR });
  await h.start();
  assert.equal(h.ctl.status().waitUntil, START_CLOCK + 3 * HOUR);
  assert.equal(h.ctl.status().phase, 'building');
});

test('STOP while waiting ends the run at once', async () => {
  const h = harness();
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'limit');
  h.ctl.stop();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.ok(h.timers.every((t) => t.cleared));
});

test('freeFallback: builders and the Playtester switch to the free providers while limited', async () => {
  const h = harness({ settings: { models: {}, freeFallback: true, projects: {} } });
  h.next.build.push({ ok: false, error: 'limit', resumeAt: START_CLOCK + 2 * HOUR });
  h.next.critic.push(shipCritic());
  await h.start();
  assert.deepEqual(h.calls.build.map((b) => b.free), [false, true]);
  assert.equal(h.calls.playtest[0].free, true);
  assert.equal(h.timers.length, 0, 'no wait');
  assert.equal(h.ctl.status().verdict, 'ship');
  assert.match(logText(h), /builder switches to the free providers/);
});

test('freeFallback does not cover the Director: it waits', async () => {
  const h = harness({ settings: { models: {}, freeFallback: true, projects: {} } });
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'limit');
});

test('freeFallback without a free profile waits for the reset after all', async () => {
  const h = harness({ settings: { models: {}, freeFallback: true, projects: {} } });
  h.next.build.push({ ok: false, error: 'limit', resumeAt: START_CLOCK + 2 * HOUR }, { ok: false, error: 'noFreeProfile' });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'limit');
  assert.equal(h.ctl.status().waitUntil, START_CLOCK + 2 * HOUR);
});

test('God Mode busy with another run: the build is tried again later', async () => {
  const h = harness();
  h.next.build.push({ ok: false, error: 'godModeBusy' });
  h.next.critic.push(shipCritic());
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'godModeBusy');
  await h.fire();
  assert.equal(h.calls.build.length, 2);
  assert.equal(h.ctl.status().verdict, 'ship');
});

// ---- persistence and resume ---------------------------------------------------------

test('every transition is persisted before it is announced', async () => {
  const h = harness();
  h.next.critic.push(shipCritic());
  await h.start();
  const phaseEvents = h.events.filter((e) => e.type === 'phase');
  assert.deepEqual(phaseEvents.map((e) => e.phase), ['preprod', ...PHASES_OF_A_LAP, 'done']);
  for (const e of phaseEvents) assert.equal(e.storedPhase, e.phase);
  assert.deepEqual([...new Set(h.saves.map((s) => s.phase))], ['preprod', ...PHASES_OF_A_LAP, 'done']);
  assert.equal(h.saves.find((s) => s.phase === 'directing').iteration, 1);
});

test('resume after a restart: the run goes on from its phase, earlier steps are not repeated', async () => {
  const h1 = harness();
  // God Mode made plan p7, then LunaCore "dies" mid-build.
  h1.next.build.push((o) => {
    o.onPlan('p7');
    return new Promise(() => {});
  });
  await h1.ctl.start({ projectId: 'game' });
  await until(() => h1.calls.build.length === 1);
  assert.equal(h1.stored.phase, 'building');
  assert.equal(h1.stored.current.planId, 'p7', 'the build plan id is saved');
  assert.equal(h1.calls.build[0].resumePlanId, null);

  const h2 = harness({ stored: h1.stored, todos: h1.todos });
  h2.next.critic.push(shipCritic());
  assert.equal(h2.ctl.resume(), true);
  await h2.settle();
  assert.equal(h2.calls.director.length, 0, 'the Director is not asked again');
  assert.equal(h2.calls.build.length, 1);
  // The builder is told which plan to finish first (lunasworkBuild).
  assert.equal(h2.calls.build[0].resumePlanId, 'p7');
  assert.deepEqual(h2.calls.build[0].cards.map((c) => c.at), h1.calls.build[0].cards.map((c) => c.at));
  assert.equal(h2.ctl.status().verdict, 'ship');
  assert.equal(h2.ctl.status().runId, 'lwtest1');
  assert.equal(h2.awake.held, 1);
});

test('resume in playtesting starts the app again (it died with LunaCore) and stops it after', async () => {
  const h1 = harness();
  h1.next.playtest.push(() => new Promise(() => {}));
  await h1.ctl.start({ projectId: 'game' });
  await until(() => h1.calls.playtest.length === 1);
  assert.equal(h1.stored.phase, 'playtesting');

  const h2 = harness({ stored: h1.stored, todos: h1.todos });
  h2.next.critic.push(shipCritic());
  h2.ctl.resume();
  await h2.settle();
  assert.equal(h2.calls.build.length, 0);
  assert.deepEqual(h2.calls.playtest.map((c) => c.mode), ['explore', 'shipConfirm']);
  assert.equal(h2.adapters.length, 2, 'explore relaunch + SHIP pass');
  assert.ok(h2.adapters.every((a) => a.stopped === 1));
  assert.equal(h2.ctl.status().verdict, 'ship');
});

test('resume in critiquing after the Critic ran does not make its cards twice', async () => {
  const h1 = harness();
  h1.next.critic.push(shipCritic());
  h1.next.playtest.push(DEFAULT, () => new Promise(() => {})); // dies during the SHIP pass
  await h1.ctl.start({ projectId: 'game' });
  await until(() => h1.calls.playtest.length === 2);
  assert.equal(h1.stored.phase, 'critiquing');
  assert.ok(h1.stored.current.critic, 'the Critic result is saved');

  const h2 = harness({ stored: h1.stored, todos: h1.todos });
  h2.ctl.resume();
  await h2.settle();
  assert.equal(h2.calls.critic.length, 0);
  assert.deepEqual(h2.calls.playtest.map((c) => c.mode), ['shipConfirm']);
  assert.equal(h2.ctl.status().verdict, 'ship');
});

test('resume of a waiting run re-arms the wait; nothing runs before the reset', async () => {
  const h1 = harness();
  h1.next.critic.push({ ok: false, error: 'limit' });
  await h1.start();
  const resumeAt = h1.stored.waitUntil;

  const h2 = harness({ stored: h1.stored, todos: h1.todos, clock: START_CLOCK + 1000 });
  h2.next.critic.push(shipCritic());
  h2.ctl.resume();
  await h2.settle();
  assert.equal(h2.calls.critic.length, 0);
  assert.equal(h2.ctl.status().waitUntil, resumeAt);
  await h2.fire();
  assert.equal(h2.calls.critic.length, 1);
  assert.equal(h2.ctl.status().verdict, 'ship');
});

test('resume of a finished run only reports it; onRunEnd fires once across restarts', async () => {
  const h1 = harness();
  h1.next.critic.push(shipCritic());
  await h1.start();
  assert.equal(h1.ended.length, 1);

  const h2 = harness({ stored: h1.stored });
  assert.equal(h2.ctl.resume(), false);
  assert.equal(h2.ended.length, 0);
  assert.equal(h2.ctl.status().verdict, 'ship');
  assert.equal(h2.ctl.status().active, false);

  // A crash between the verdict and the callbacks: the next start fires them.
  const h3 = harness({ stored: { ...h1.stored, endNotified: false } });
  h3.ctl.resume();
  assert.equal(h3.ended.length, 1);
});

test('resume ends a run whose project is gone from this PC', () => {
  const h = harness({ stored: { id: 'lwtest1', projectId: 'game', repoPath: REPO, phase: 'building', iteration: 1, history: [] } });
  h.projects = {};
  assert.equal(h.ctl.resume(), false);
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().stopReason, 'projectMissing');
});

test('restoreRun keeps the controller phases and drops a corrupt run', () => {
  assert.equal(restoreRun({ id: 'lw1', repoPath: REPO, phase: 'preprod' }).phase, 'preprod');
  assert.equal(restoreRun({ id: 'lw1', repoPath: REPO, phase: 'done' }).verdict, 'stop');
  assert.equal(restoreRun({ id: 'lw1', repoPath: REPO, phase: 'bogus' }).phase, 'directing');
  assert.equal(restoreRun({ id: '../x', repoPath: REPO }), null);
  assert.equal(restoreRun({ id: 'lw1', repoPath: 'relative/dir' }), null);
  assert.equal(restoreRun(null), null);
  const cards = restoreRun({ id: 'lw1', repoPath: REPO, current: { cards: [{ at: 1, model: 'gpt' }, { text: 'no at' }] } }).current.cards;
  assert.deepEqual(cards.map((c) => [c.at, c.model]), [[1, 'opus']]);
});

// ---- models logged -------------------------------------------------------------------

test('every model choice is logged with its reason (auto builder: L/risky opus, S/M sonnet)', async () => {
  const todos = [
    card(1, { size: 'L' }),
    card(2, { size: 'S', files: ['src/preload.js'] }),
    card(3, { size: 'M', files: ['src/view.js'] }),
    card(4, { size: 'S', files: ['src/quote.js'] }),
  ];
  const h = harness({ todos, scores: [40, 50] });
  h.next.director.push(
    { ok: true, cards: todos.slice(0, 3), model: 'opus', modelReason: 'setting' },
    { ok: true, cards: [todos[3]], model: 'sonnet', modelReason: 'regular iteration' },
    { ...STOP_CARD, model: 'sonnet', modelReason: 'regular iteration' },
  );
  h.next.build.push({ ...doneBuild(), integration: { state: 'done', skipped: [{ id: 'x', stage: 'conflict', files: ['src/quote.js'] }] } });
  await h.start({ projectId: 'game', models: { builder: 'auto' } });

  const byCard = Object.fromEntries(modelEntries(h, 'builder').map((e) => [e.card, e]));
  assert.deepEqual([byCard[1].model, byCard[1].reason], ['opus', 'large or risky card']);
  assert.deepEqual([byCard[2].model, byCard[2].reason], ['opus', 'large or risky card (ipc)']);
  assert.deepEqual([byCard[3].model, byCard[3].reason], ['sonnet', 'small or medium card']);
  // src/quote.js conflicted in iteration 1.
  assert.deepEqual([byCard[4].model, byCard[4].reason, byCard[4].n], ['opus', 'large or risky card (conflict)', 2]);
  // The build gets each card's model.
  assert.deepEqual(h.calls.build[0].cards.map((c) => c.model), ['opus', 'opus', 'sonnet']);

  const director = modelEntries(h, 'director');
  assert.ok(director.some((e) => e.model === 'opus' && e.reason === 'setting'));
  assert.ok(director.some((e) => e.model === 'sonnet' && e.reason === 'regular iteration'));
  assert.ok(modelEntries(h, 'critic').length >= 2);
  assert.ok(modelEntries(h, 'critic').every((e) => e.reason === 'regular iteration'));
  assert.ok(modelEntries(h, 'playtester').some((e) => e.reason === 'exploratory pass'));
  // The log is part of the stored run.
  assert.ok(restoreRun(h.stored).log.some((e) => e.kind === 'model' && e.reason === 'large or risky card (ipc)'));
});

test('a fixed builder setting is logged as the setting', async () => {
  const h = harness();
  h.next.critic.push(shipCritic());
  await h.start();
  const builders = modelEntries(h, 'builder');
  assert.equal(builders.length, 2);
  assert.ok(builders.every((e) => e.model === 'opus' && e.reason === 'setting'));
});

test('start: the effective models (run > project > global) are stored in the run', async () => {
  const h = harness({
    settings: { models: { director: 'sonnet' }, freeFallback: false, projects: { game: { models: { builder: 'haiku' } } } },
  });
  h.next.critic.push(shipCritic());
  await h.start({ projectId: 'game', models: { critic: 'haiku' } });
  const stored = restoreRun(h.stored);
  assert.equal(stored.models.director, 'sonnet');
  assert.equal(stored.models.builder, 'haiku');
  assert.equal(stored.models.critic, 'haiku');
  assert.equal(stored.modelSources.critic, 'run');
  assert.equal(stored.modelSources.builder, 'project');
  assert.equal(stored.modelSources.director, 'global');
  assert.deepEqual(h.ctl.status().models, stored.models);
  // The override is this run's only: the settings are not changed.
  assert.deepEqual(h.settings.projects.game.models, { builder: 'haiku' });
  assert.equal(h.calls.critic[0].models.critic, 'haiku');
});

// ---- mutual exclusion -----------------------------------------------------------------

test("mutual exclusion: Luna's Work refuses to start while God Mode is on the project", async () => {
  const h = harness();
  h.godMode.active = true;
  const res = await h.start();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'god-mode-active');
  assert.match(res.message, /God Mode has a plan or run on this project/);
  assert.equal(h.stored, null);
  assert.equal(h.calls.director.length, 0);
});

test("mutual exclusion: God Mode is refused on the project while Luna's Work runs", async () => {
  const h = harness();
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  const blocked = h.ctl.godModeBlock('game');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'lunasWorkActive');
  assert.match(blocked.message, /Luna's Work is running on this project/);
  assert.equal(h.ctl.godModeBlock('other'), null);
  assert.equal(h.ctl.isActiveOn('game'), true);

  // A second Luna's Work run is refused too.
  assert.equal((await h.ctl.start({ projectId: 'game' })).reason, 'run-active');

  h.ctl.stop();
  build.resolve(doneBuild());
  await h.settle();
  assert.equal(h.ctl.godModeBlock('game'), null, 'free again once the run ended');
});

test('start refuses an unknown project, bad models, a missing profile or pack, and a declined dialog', async () => {
  const h = harness();
  assert.equal((await h.ctl.start({ projectId: 'nope' })).reason, 'bad-project');
  assert.equal((await h.ctl.start(null)).reason, 'bad-project');
  assert.equal((await h.ctl.start({ projectId: 'game', models: { builder: 'gpt' } })).reason, 'bad-models');
  const profile = h.profile;
  h.profile = null;
  assert.equal((await h.ctl.start({ projectId: 'game' })).reason, 'no-profile');
  h.profile = profile;
  h.pack = { complete: false, missing: ['SHIP_CRITERIA.md'] };
  const pack = await h.ctl.start({ projectId: 'game' });
  assert.equal(pack.reason, 'pack-incomplete');
  assert.deepEqual(pack.missing, ['SHIP_CRITERIA.md']);
  h.pack = { complete: true };
  h.confirm = false;
  assert.equal((await h.ctl.start({ projectId: 'game' })).reason, 'declined');
  h.projects = { game: null };
  assert.equal((await h.ctl.start({ projectId: 'game' })).reason, 'no-folder');
  assert.equal(h.stored, null, 'no refused start leaves a run behind');
});

test('the confirmed commands are pinned in the run: a later settings change does not reach it', async () => {
  const h = harness();
  h.profile = { ...h.profile, startCommand: 'npm run dev', checkCommand: 'npm run check' };
  const build = deferred();
  h.next.build.push(() => build.promise);
  h.next.critic.push(shipCritic());
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].profile.startCommand, 'npm run dev');
  assert.equal(h.confirms[0].checkCommand, 'npm run check');

  // The renderer rewrites the profile mid-run.
  h.profile = { ...h.profile, startCommand: 'evil', checkCommand: 'evil' };
  h.godMode.checkCommand = 'evil';
  build.resolve(doneBuild());
  await h.settle();
  assert.equal(h.calls.build[0].checkCommand, 'npm run check');
  assert.ok(h.adapters.length >= 1);
  assert.ok(h.adapters.every((a) => a.profile.startCommand === 'npm run dev'));
  // ... and it survives a restart.
  assert.equal(restoreRun(h.stored).profile.startCommand, 'npm run dev');
  assert.equal(restoreRun(h.stored).checkCommand, 'npm run check');
});

test('resume refuses a run without a valid pinned profile (nothing confirmed to run)', () => {
  const h = harness({ stored: { id: 'lwtest1', projectId: 'game', repoPath: REPO, phase: 'launching', iteration: 1, history: [], profile: { startCommand: '' } } });
  assert.equal(h.ctl.resume(), false);
  assert.equal(h.ctl.status().stopReason, 'noProfile');
  assert.equal(h.adapters.length, 0);
});

test('a second start while the confirmation dialog is open is refused, not stacked', async () => {
  const h = harness();
  const answer = deferred();
  h.confirm = () => answer.promise;
  const first = h.ctl.start({ projectId: 'game' });
  const second = await h.ctl.start({ projectId: 'game' });
  assert.equal(second.reason, 'busy');
  assert.equal(h.confirms.length, 1);
  answer.resolve(false);
  assert.equal((await first).reason, 'declined');
  // Closed dialog: a new start may ask again.
  h.confirm = true;
  h.next.critic.push(shipCritic());
  assert.equal((await h.start()).ok, true);
});

test('every God Mode plan the run makes is remembered, so the next build may replace only those', async () => {
  const h = harness({ scores: [40] });
  h.next.build.push((o) => {
    o.onPlan('p1');
    return doneBuild();
  });
  h.next.director.push(DEFAULT, { ok: true, cards: [card(2)], model: 'opus', modelReason: 'setting' }, STOP_CARD);
  h.next.build.push((o) => {
    o.onPlan('p2');
    return doneBuild();
  });
  await h.start();
  assert.deepEqual(h.calls.build.map((b) => b.ownPlanIds), [[], ['p1']]);
  assert.deepEqual(restoreRun(h.stored).planIds, ['p1', 'p2']);
});

test('God Mode starting during the confirmation dialog still refuses the start', async () => {
  const h = harness({ deps: {} });
  h.confirm = true;
  const original = h.godMode;
  let asked = 0;
  // The dialog is open; meanwhile God Mode plans on the project.
  h.godMode = { checkCommand: 'npm test', get active() { asked += 1; return asked > 1; } };
  const res = await h.start();
  assert.equal(res.reason, 'god-mode-active');
  h.godMode = original;
});

// ---- status, events, app lifecycle -------------------------------------------------------

test('status() carries the seams later packages build on', async () => {
  const h = harness({ scores: [40, 55] });
  h.next.director.push(DEFAULT, DEFAULT, () => new Promise(() => {}));
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.director.length === 3);

  const s = h.ctl.status();
  assert.equal(s.active, true);
  assert.equal(s.runId, 'lwtest1');
  assert.equal(s.iteration, 3);
  assert.equal(s.phase, 'directing');
  assert.equal(s.role, 'director');
  assert.equal(s.models.director, 'opus');
  assert.equal(s.verdict, null);
  assert.equal(s.phaseStartedAt, h.clock);
  assert.equal(s.waitUntil, null);
  assert.deepEqual(s.scores, { skeleton: [{ n: 1, score: 40 }, { n: 2, score: 55 }] });
  assert.equal(s.evidenceDir, path.join(EVIDENCE, 'lunaswork-lwtest1', 'iter-2'));
});

test('subscribe: an event on every transition; unsubscribe stops them; a throwing listener is harmless', async () => {
  const h = harness();
  const seen = [];
  const off = h.ctl.subscribe((e) => seen.push(e.status.phase));
  h.ctl.subscribe(() => {
    throw new Error('bad listener');
  });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  assert.deepEqual(seen, ['preprod', 'directing', 'building']);
  off();
  h.next.critic.push(shipCritic());
  build.resolve(doneBuild());
  await h.settle();
  assert.equal(h.ctl.status().verdict, 'ship');
  assert.deepEqual(seen, ['preprod', 'directing', 'building']);
});

test('the app is always stopped, even when the Playtester throws', async () => {
  const h = harness();
  h.next.playtest.push(() => {
    throw new Error('playwright crashed');
  });
  await h.start();
  assert.equal(h.adapters.length, 1);
  assert.equal(h.adapters[0].stopped, 1);
  assert.equal(h.ctl.status().waitReason, 'error', 'the phase is retried later');
  assert.equal(h.ctl.status().phase, 'playtesting');
});

test('an app that does not start still gets a Critic pass (an empty report)', async () => {
  const h = harness();
  h.launchFails = true;
  h.next.critic.push(shipCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(h.calls.playtest.length, 0);
  assert.equal(h.calls.critic[0].report.errors[0].code, 'launchFailed');
  // The SHIP pass cannot confirm without a running app.
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.ok(h.adapters.every((a) => a.stopped === 1));
});

test('the PC is kept awake for the run and released at its end', async () => {
  const h = harness();
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  assert.equal(h.awake.held, 1);
  assert.equal(h.awake.released, 0);
  h.ctl.stop();
  build.resolve(doneBuild());
  await h.settle();
  assert.equal(h.awake.released, 1);
});

// ---- merged work, checkout, retries --------------------------------------------------------

/** A build that ticks its cards (God Mode does at push) and returns `result`. */
const tickingBuild = (h, result) => (o) => {
  const ats = new Set(o.cards.map((c) => c.at));
  h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true, doneAt: 1 } : t));
  return typeof result === 'function' ? result(o) : result;
};

test('landedCards: only cards of merged packages in a done integration', () => {
  const cards = [{ at: 1, text: 'one' }, { at: 2, text: 'two' }, { at: 3, text: 'three' }];
  const settled = {
    integration: { state: 'done' },
    plan: { packages: [{ merged: true, todos: ['one'] }, { merged: false, todos: ['two'] }, { merged: true, todos: ['3'] }] },
  };
  assert.deepEqual(landedCards(settled, cards), [1, 3]);
  assert.deepEqual(landedCards({ ...settled, integration: { state: 'failed' } }, cards), []);
  assert.deepEqual(landedCards(null, cards), []);
});

test('a red build counts no card as closed and reopens the ticked ones for the Director', async () => {
  const h = harness({ scores: [40] });
  h.next.build.push(tickingBuild(h, redBuild()));
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.deepEqual(restoreRun(h.stored).history.map((r) => [r.selfCheck, r.cardsClosed]), [['red', 0]]);
  assert.ok(h.todos.every((t) => t.done === false && !('doneAt' in t)), 'back to open');
  assert.match(logText(h), /2 card\(s\) reopened/);
});

test('a package skipped at merge: its card is reopened, the merged one stays closed', async () => {
  const h = harness({ scores: [40] });
  h.next.build.push(
    tickingBuild(h, {
      ok: true,
      integration: { state: 'done', skipped: [{ id: 'b', stage: 'verify', files: [] }] },
      plan: { packages: [{ id: 'a', merged: true, todos: ['card 1'] }, { id: 'b', merged: false, todos: ['card 2'] }] },
    }),
  );
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(restoreRun(h.stored).history[0].cardsClosed, 1);
  assert.deepEqual(h.todos.map((t) => [t.at, t.done]), [[1, true], [2, false]]);
});

test('the checkout is fast-forwarded after every build, before the app is launched', async () => {
  const h = harness();
  h.next.critic.push(shipCritic());
  await h.start();
  assert.deepEqual(h.syncs, [{ repoPath: REPO, phase: 'building' }]);
  // A failed fast-forward is logged; the run goes on.
  const h2 = harness();
  h2.sync = { ok: false, detail: 'no fast-forward: local changes' };
  h2.next.critic.push(shipCritic());
  await h2.start();
  assert.equal(h2.ctl.status().verdict, 'ship');
  assert.match(logText(h2), /checkout not updated: no fast-forward/);
});

test('a Stop pressed during a step that ends in a wait ends the run, it does not wait first', async () => {
  for (const answer of [{ ok: true, error: 'limit', cards: [] }, () => Promise.reject(new Error('boom'))]) {
    const h = harness();
    const director = deferred();
    h.next.director.push(() => director.promise);
    await h.ctl.start({ projectId: 'game' });
    await until(() => h.calls.director.length === 1);
    h.ctl.stop();
    director.resolve(typeof answer === 'function' ? answer() : answer);
    await h.settle();
    assert.equal(h.ctl.status().verdict, 'stop');
    assert.equal(h.ctl.status().waitUntil, null);
    assert.ok(h.timers.every((t) => t.cleared));
  }
});

test('a God Mode build error is retried, and three in a row stop the run (stepFailed)', async () => {
  const h = harness();
  h.next.build.push({ ok: false, error: 'timeout' }, { ok: false, error: 'planErrors' }, DEFAULT);
  h.next.critic.push(shipCritic());
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'error');
  assert.equal(restoreRun(h.stored).failures.count, 1);
  assert.equal(h.calls.critic.length, 0, 'no Playtester / Critic pass on an unchanged app');
  await h.fire();
  await h.fire();
  assert.equal(h.calls.build.length, 3);
  assert.equal(h.ctl.status().verdict, 'ship');
  assert.equal(restoreRun(h.stored).history.length, 1, 'the failed tries are not iterations');

  const h2 = harness();
  h2.next.build.push({ ok: false, error: 'noClaude' }, { ok: false, error: 'noClaude' }, { ok: false, error: 'noClaude' });
  await h2.start();
  await h2.fire();
  await h2.fire();
  assert.equal(h2.ctl.status().verdict, 'stop');
  assert.equal(h2.ctl.status().stopReason, 'stepFailed');
  assert.equal(h2.awake.released, 1);
});

test('a failed Critic is retried instead of scoring the iteration 0', async () => {
  const h = harness();
  h.next.critic.push({ ok: false, error: 'badJson', model: 'opus', modelReason: 'setting' }, shipCritic());
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'error');
  assert.equal(h.stored.current.critic, null, 'nothing saved from the failed pass');
  await h.fire();
  assert.equal(h.calls.critic.length, 2);
  assert.equal(h.ctl.status().verdict, 'ship');
});

test('a step that keeps throwing ends the run instead of retrying forever', async () => {
  const h = harness();
  const boom = () => {
    throw new Error('playwright crashed');
  };
  h.next.playtest.push(boom, boom, boom);
  await h.start();
  await h.fire();
  await h.fire();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().stopReason, 'stepFailed');
  assert.ok(h.adapters.every((a) => a.stopped === 1));
});

test('the SHIP confirmation pass never runs on the free providers', async () => {
  const h = harness({ settings: { models: {}, freeFallback: true, projects: {} } });
  h.next.playtest.push({ ok: false, error: 'limit' });
  h.next.critic.push(shipCritic());
  await h.start();
  assert.deepEqual(h.calls.playtest.map((c) => [c.mode, c.free]), [['explore', false], ['explore', true], ['shipConfirm', false]]);
  assert.equal(h.ctl.status().verdict, 'ship');
});

test('a limited SHIP pass waits for the reset (no free fallback for it)', async () => {
  const h = harness({ settings: { models: {}, freeFallback: true, projects: {} } });
  h.next.critic.push(shipCritic());
  h.next.playtest.push(DEFAULT, { ok: false, error: 'limit' });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'limit');
  await h.fire();
  assert.equal(h.ctl.status().verdict, 'ship');
  assert.equal(h.calls.critic.length, 1, 'the Critic is not asked again');
});

// ---- checkpoints (deps.checkpoints, src/lunasworkCheckpoint.js) ----------------------

/** A fake checkpoint dep; `rollbackAnswer` is what rollback() returns. */
function fakeCheckpoints(rollbackAnswer) {
  const cp = { tags: [], rollbacks: [] };
  cp.dep = {
    tagIteration: async (o) => {
      cp.tags.push(o);
      return { ok: true, tag: `luna-work/${o.runId}/iter-${o.iteration}`, sha: 'a'.repeat(40) };
    },
    rollback: async (o) => {
      cp.rollbacks.push(o);
      return rollbackAnswer || {
        ok: true,
        fromTag: `luna-work/${o.runId}/iter-${o.iteration}-rolled-back`,
        toTag: `luna-work/${o.runId}/iter-${o.toIteration}`,
        reverted: [{ sha: 'b'.repeat(40), subject: 'Merge package pk' }],
        cards: [99],
        decision: true,
      };
    },
  };
  return cp;
}

const oneCardEach = (h) => () => ({ ok: true, cards: [h.todos.find((t) => !t.done)], model: 'opus', modelReason: 'setting' });

test('checkpoints: a green iteration is tagged; a score drop past the margin is rolled back', async () => {
  const cp = fakeCheckpoints();
  const todos = Array.from({ length: 4 }, (_, i) => card(i + 1));
  const h = harness({ todos, scores: [60, 30], deps: { checkpoints: cp.dep } });
  h.next.director.push(oneCardEach(h), oneCardEach(h), STOP_CARD);
  await h.start();
  assert.deepEqual(cp.tags.map((t) => t.iteration), [1], 'the rolled-back iteration is not tagged');
  assert.equal(cp.rollbacks.length, 1);
  const call = cp.rollbacks[0];
  assert.equal(call.iteration, 2);
  assert.equal(call.toIteration, 1);
  assert.equal(call.reason, 'scoreDrop');
  assert.equal(call.evidence.scoreBefore, 60);
  assert.equal(call.evidence.scoreNow, 30);
  assert.deepEqual(call.evidence.cards, ['card 2']);
  // The rolled-back iteration's card is open again; iteration 1's stays done.
  assert.equal(h.todos.find((t) => t.at === 2).done, false);
  assert.equal(h.todos.find((t) => t.at === 1).done, true);
  const run = h.ended[0];
  assert.deepEqual(run.history.map((r) => r.rolledBack), [false, true]);
  assert.equal(run.laps.length, 2);
  assert.equal(run.laps[0].checkpoint.tag, 'luna-work/lwtest1/iter-1');
  assert.equal(run.laps[1].checkpoint.rollback.ok, true);
  assert.equal(run.laps[1].checkpoint.rollback.toTag, 'luna-work/lwtest1/iter-1');
  assert.match(run.laps[1].checkpoint.rollback.why, /fell from 60 to 30/);
  assert.deepEqual(run.laps[1].checkpoint.rollback.reopened, [2]);
  assert.ok(h.ctl.runLog().some((e) => /rolled back luna-work\/lwtest1\/iter-2-rolled-back -> luna-work\/lwtest1\/iter-1/.test(e.text || '')));
});

test('checkpoints: only a journey that passed before rolls back; one that never passed does not', async () => {
  const cp = fakeCheckpoints();
  const h = harness({ todos: Array.from({ length: 6 }, (_, i) => card(i + 1)), scores: [50, 50, 50], deps: { checkpoints: cp.dep } });
  const journeys = (login) => (o) => ({
    ok: true,
    model: 'sonnet',
    modelReason: 'exploratory pass',
    report: { mode: o.mode, findings: [], scores: [], screens: [], journeys: [{ name: 'login', passed: login }, { name: 'export', passed: false }] },
  });
  h.next.playtest.push(journeys(true), journeys(true), journeys(false));
  h.next.director.push(DEFAULT, DEFAULT, DEFAULT, STOP_CARD);
  await h.start();
  assert.deepEqual(cp.tags.map((t) => t.iteration), [1, 2], '"export" never passed: no rollback for it');
  assert.equal(cp.rollbacks.length, 1);
  assert.equal(cp.rollbacks[0].reason, 'coreJourneyBroken');
  assert.equal(cp.rollbacks[0].toIteration, 2);
  assert.deepEqual(cp.rollbacks[0].evidence.failedJourneys.map((j) => j.name), ['login']);
});

test('checkpoints: a failed rollback keeps the iteration and its cards, and is reported', async () => {
  const cp = fakeCheckpoints({ ok: false, error: 'pushFailed', detail: 'rejected', fromTag: 'f', toTag: 't' });
  const todos = Array.from({ length: 4 }, (_, i) => card(i + 1));
  const h = harness({ todos, scores: [60, 30], deps: { checkpoints: cp.dep } });
  h.next.director.push(oneCardEach(h), oneCardEach(h), STOP_CARD);
  await h.start();
  const run = h.ended[0];
  assert.deepEqual(run.history.map((r) => r.rolledBack), [false, false]);
  assert.equal(run.laps[1].checkpoint.rollback.ok, false);
  assert.equal(run.laps[1].checkpoint.rollback.error, 'pushFailed');
  assert.equal(h.todos.find((t) => t.at === 2).done, true, 'nothing reverted, nothing reopened');
});

test('checkpoints: a red iteration is neither tagged nor rolled back', async () => {
  const cp = fakeCheckpoints();
  const h = harness({ scores: [40, 60], deps: { checkpoints: cp.dep } });
  h.next.build.push(redBuild(), redBuild());
  await h.start();
  assert.equal(h.ctl.status().verdict, 'red');
  assert.equal(cp.tags.length, 0);
  assert.equal(cp.rollbacks.length, 0);
});

test('a `stop` steer card is closed once it stopped the run', async () => {
  const stopCard = { at: 9, text: 'stop', done: false, tags: ['steer'] };
  const h = harness({ todos: [card(1), stopCard] });
  h.next.director.push({ ...STOP_CARD, cards: [card(1)] });
  await h.start();
  assert.equal(h.ctl.status().stopReason, 'steer');
  assert.equal(h.todos.find((t) => t.at === 9).done, true);
  assert.equal(h.todos.find((t) => t.at === 1).done, false);
});

// ---- hand me the wheel (C11) --------------------------------------------------------

const { parseCommitLog } = require('../src/lunasworkHandback');

const HAND_BASE = 'a'.repeat(40);

/** The hand-back deps: HEAD at the pause, Mati's commits, DECISIONS.md lines and ARCHITECTURE.md sections. */
function handbackFake(commits = []) {
  const f = { reads: [], lines: [], blocks: [], commits };
  f.deps = {
    handback: {
      head: async () => HAND_BASE,
      commits: async (repoPath, base) => {
        f.reads.push({ repoPath, base });
        return { ok: true, commits: f.commits, more: 0 };
      },
      architecture: ({ block }) => {
        f.blocks.push(block);
        return true;
      },
    },
    recordDecision: ({ line }) => {
      f.lines.push(line);
      return true;
    },
  };
  return f;
}

/** A run that asked for the wheel during its first build and got it at the end of iteration 1. */
async function handedRun(f, opts = {}) {
  const h = harness({ ...opts, deps: { ...f.deps, ...(opts.deps || {}) } });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  const asked = await h.ctl.handOver();
  build.resolve(doneBuild());
  await h.settle();
  return { h, asked };
}

test('hand me the wheel: the run pauses only at the end of the current iteration', async () => {
  const f = handbackFake();
  const h = harness({ deps: f.deps });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);

  const res = await h.ctl.handOver();
  assert.equal(res.ok, true);
  assert.equal(res.status.wheel, 'requested');
  assert.equal(h.ctl.status().phase, 'building', 'the build is not cut off');
  assert.equal(h.stored.handRequested, true, 'the request is persisted');
  assert.ok(h.events.some((e) => e.type === 'wheel'));

  build.resolve(doneBuild());
  await h.settle();
  const s = h.ctl.status();
  assert.equal(s.active, true);
  assert.equal(s.phase, 'handed');
  assert.equal(s.wheel, 'handed');
  assert.equal(s.role, null);
  assert.equal(s.iteration, 2, 'iteration 1 ended; the run waits before iteration 2');
  assert.equal(s.handedAt, h.clock);
  assert.equal(s.feedback.wheel, 'handed', 'the phone sees it too');
  // The rest of iteration 1 ran: launch, Playtester, Critic - then nothing more.
  assert.equal(h.calls.playtest.length, 1);
  assert.equal(h.calls.critic.length, 1);
  assert.equal(h.calls.director.length, 1);
  assert.equal(h.ctl.status().scores.skeleton.length, 1, 'iteration 1 was scored');
  assert.ok(h.adapters.every((a) => a.stopped >= a.started), 'the app under test is stopped');
  assert.equal(h.stored.phase, 'handed');
  assert.equal(h.stored.handBase, HAND_BASE, "main's commit at the pause is kept");
  assert.equal(h.stored.handRequested, false);
  assert.match(logText(h), /wheel handed to Mati before iteration 2, main at aaaaaaa/);
});

test('while handed no builder runs; decision deadlines still take their default', async () => {
  const f = handbackFake();
  const { h } = await handedRun(f);
  assert.equal(h.ctl.status().phase, 'handed');
  const builds = h.calls.build.length;
  const directors = h.calls.director.length;

  const asked = h.ctl.ask({ question: 'Add lodash?', options: ['approve', 'reject'], defaultAnswer: 'approve', deadlineMs: HOUR });
  assert.equal(asked.ok, true);
  assert.equal(h.ctl.status().pendingDecisions.length, 1);
  await h.fire();
  assert.equal(h.ctl.status().pendingDecisions.length, 0, 'the deadline ticked while handed');
  assert.ok(f.lines.some((l) => /Add lodash/.test(l) && /default after deadline/.test(l)));

  // Nothing ran: no Director, no builder, and the run is still Mati's.
  assert.equal(h.calls.build.length, builds);
  assert.equal(h.calls.director.length, directors);
  assert.equal(h.ctl.status().phase, 'handed');
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0, 'no step timer either');
});

test('a run waiting on a usage limit before its Director is handed at once; the wait keeps ticking', async () => {
  const f = handbackFake();
  const h = harness({ deps: f.deps });
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  assert.equal(h.ctl.status().waitReason, 'limit');

  const res = await h.ctl.handOver();
  assert.equal(res.status.phase, 'handed', 'no iteration was under way');
  assert.equal(res.status.waitUntil, START_CLOCK + HOUR, 'the usage-limit wait is kept');

  await h.fire();
  assert.equal(h.ctl.status().phase, 'handed');
  assert.equal(h.ctl.status().waitUntil, null, 'the reset passed while Mati had the wheel');
  assert.equal(h.calls.director.length, 1, 'and nothing ran at the reset');

  await h.ctl.handBack();
  await h.settle();
  assert.ok(h.calls.director.length >= 2, 'the run goes on from directing');
  assert.equal(h.calls.director[1].iteration, 1, 'the same iteration, it never started');
});

test('a hand-back while the usage-limit wait is still on waits for the reset first', async () => {
  const f = handbackFake();
  const h = harness({ deps: f.deps });
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  await h.ctl.handOver();
  await h.ctl.handBack();
  await h.settle();
  const s = h.ctl.status();
  assert.equal(s.phase, 'directing');
  assert.equal(s.waitUntil, START_CLOCK + HOUR);
  assert.equal(h.calls.director.length, 1, 'nothing before the reset');
  await h.fire();
  assert.ok(h.calls.director.length >= 2);
});

test("hand-back: the Critic turns Mati's commits into DECISIONS.md entries and the run continues from directing", async () => {
  const log = [
    `\x1e${'b'.repeat(40)}\x1fFix the header size`,
    '',
    '3\t1\tsrc/Header.tsx',
    '-\t-\tpublic/logo.png',
    `\x1e${'c'.repeat(40)}\x1fAdd PDF export`,
    '',
    '120\t0\tsrc/export/pdf.ts',
  ].join('\n');
  const f = handbackFake(parseCommitLog(log));
  const { h } = await handedRun(f);
  assert.equal(h.ctl.status().phase, 'handed');
  h.clock += HOUR;
  const syncsBefore = h.syncs.length;

  const res = await h.ctl.handBack();
  assert.equal(res.ok, true);
  assert.deepEqual(f.reads, [{ repoPath: REPO, base: HAND_BASE }], 'every commit since the pause');
  const date = new Date(h.clock).toISOString().slice(0, 10);
  assert.deepEqual(f.lines, [
    `- Mati changed "Fix the header size" by hand (bbbbbbb; 2 files: src/Header.tsx, public/logo.png; +3 -1), hand-back ${date}`,
    `- Mati changed "Add PDF export" by hand (ccccccc; 1 file: src/export/pdf.ts; +120 -0), hand-back ${date}`,
  ]);
  assert.equal(f.blocks.length, 1, 'ARCHITECTURE.md gets one section');
  assert.match(f.blocks[0], /^## Manual changes \(hand-back .+, before iteration 2\)/);
  assert.match(f.blocks[0], /bbbbbbb Fix the header size/);
  assert.match(f.blocks[0], /Files touched: src\/Header\.tsx, public\/logo\.png, src\/export\/pdf\.ts/);
  assert.equal(h.syncs.length, syncsBefore + 1, 'main is fast-forwarded first');
  assert.match(logText(h), /hand-back: 2 manual commit\(s\) read, 2 recorded in DECISIONS\.md/);

  await h.settle();
  assert.equal(h.calls.director[1].iteration, 2, 'the run goes on from directing at iteration 2');
  assert.equal(h.ctl.status().wheel, 'running');
  assert.equal(h.stored.handBase, null);
});

test('the wheel request can be withdrawn before the pause; refusals are plain', async () => {
  const f = handbackFake();
  const h = harness({ deps: f.deps });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);

  assert.equal((await h.ctl.handBack()).reason, 'notHanded');
  assert.equal((await h.ctl.handOver({ runId: 'lwother' })).reason, 'otherRun');
  assert.equal((await h.ctl.handOver({ runId: 'lwtest1' })).ok, true);
  assert.equal((await h.ctl.handOver()).ok, true, 'asking twice is harmless');
  const back = await h.ctl.handBack();
  assert.equal(back.ok, true);
  assert.equal(back.status.wheel, 'running', 'withdrawn');

  build.resolve(doneBuild());
  await until(() => h.calls.director.length >= 2);
  assert.notEqual(h.ctl.status().phase, 'handed', 'the run went straight on');
  h.ctl.stop();
  await h.settle();
  assert.equal((await h.ctl.handOver()).reason, 'no-run');
});

test('a Stop while handed ends the run at once; the wheel is refused while stopping', async () => {
  const { h } = await handedRun(handbackFake());
  assert.equal((await h.ctl.handOver()).reason, 'handed');
  h.ctl.stop();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().active, false);
  assert.equal(h.ended.length, 1);

  const h2 = harness();
  const build = deferred();
  h2.next.build.push(() => build.promise);
  await h2.ctl.start({ projectId: 'game' });
  await until(() => h2.calls.build.length === 1);
  h2.ctl.stop();
  assert.equal((await h2.ctl.handOver()).reason, 'stopping');
  build.resolve(doneBuild());
  await h2.settle();
});

test('resume while handed stays handed; a hand-back cut off by a restart is done again', async () => {
  const f = handbackFake([{ sha: 'd'.repeat(40), subject: 'Rename the store', files: [], added: 0, deleted: 0 }]);
  const { h } = await handedRun(f);
  const stored = clone(h.stored);

  const after = harness({ stored, deps: f.deps });
  assert.equal(after.ctl.resume(), true);
  await after.settle();
  assert.equal(after.ctl.status().phase, 'handed');
  assert.equal(after.calls.director.length + after.calls.build.length, 0, 'nothing runs after the restart');

  const cut = harness({ stored: { ...stored, handBackRequested: true }, deps: f.deps });
  assert.equal(cut.ctl.resume(), true);
  await until(() => cut.calls.director.length > 0);
  assert.equal(cut.calls.director[0].iteration, 2);
  const date = new Date(cut.clock).toISOString().slice(0, 10);
  assert.deepEqual(f.lines, [`- Mati changed "Rename the store" by hand (ddddddd; no file changes), hand-back ${date}`]);
  await cut.settle();
});

test('restoreRun keeps the wheel fields only where they make sense', () => {
  const h = harness();
  const base = { id: 'lwtest1', projectId: 'game', repoPath: REPO, models: DEFAULT_MODELS, history: [], iteration: 2, profile: h.profile, startedAt: 1 };
  const handed = restoreRun({ ...base, phase: 'handed', handedAt: 5, handBase: HAND_BASE, handBackRequested: true, wheelSeq: 9 });
  assert.equal(handed.phase, 'handed');
  assert.equal(handed.handBase, HAND_BASE);
  assert.equal(handed.handBackRequested, true);
  assert.equal(handed.wheelSeq, 9);
  const building = restoreRun({ ...base, phase: 'building', handRequested: true, handBase: HAND_BASE, handedAt: 5 });
  assert.equal(building.handRequested, true);
  assert.equal(building.handBase, null);
  assert.equal(building.handedAt, null);
  assert.equal(restoreRun({ ...base, phase: 'handed', handBase: 'not-a-sha' }).handBase, null);
  assert.equal(restoreRun({ ...base, phase: 'done', handRequested: true }).handRequested, false);
});

test('phone wheel actions: only the newest of this run counts, once', async () => {
  const h = harness();
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);

  const list = [
    { id: 3, runId: 'lwtest1', action: 'back' },
    { id: 5, runId: 'lwtest1', action: 'hand' },
    { id: 9, runId: 'lwother', action: 'back' },
    { id: 11, runId: 'lwtest1', action: 'drive' },
  ];
  assert.equal(await h.ctl.applyWheel(list), true);
  assert.equal(h.ctl.status().wheel, 'requested');
  assert.equal(h.stored.wheelSeq, 5);
  assert.equal(await h.ctl.applyWheel(list), false, 'never applied twice');
  assert.equal(await h.ctl.applyWheel([{ id: 6, runId: 'lwtest1', action: 'back' }]), true);
  assert.equal(h.ctl.status().wheel, 'running');
  assert.equal(await h.ctl.applyWheel([{ id: 7, runId: 'lwtest1', action: 'back' }]), false);
  assert.match(logText(h), /wheel back from the phone refused \(notHanded\)/);
  assert.equal(await h.ctl.applyWheel('nope'), false);
  build.resolve(doneBuild());
  await h.settle();
});

test('a Stop pressed while the run is being handed over wins: the run ends, it is not left handed', async () => {
  const f = handbackFake();
  const head = deferred();
  const h = harness({ deps: { ...f.deps, handback: { ...f.deps.handback, head: () => head.promise } } });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  await h.ctl.handOver();
  build.resolve(doneBuild());
  await until(() => h.calls.critic.length === 1);
  await tick();

  h.ctl.stop();
  head.resolve(HAND_BASE);
  await h.settle();
  assert.equal(h.ctl.status().active, false);
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ended.length, 1);
});

test('the wait timer firing while a waiting run is handed over does not start the Director', async () => {
  const f = handbackFake();
  const head = deferred();
  const h = harness({ deps: { ...f.deps, handback: { ...f.deps.handback, head: () => head.promise } } });
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  const handing = h.ctl.handOver();
  await h.fire();
  head.resolve(HAND_BASE);
  const res = await handing;
  await h.settle();
  assert.equal(res.status.phase, 'handed');
  assert.equal(h.calls.director.length, 1, 'no Director while the wheel was being handed over');
});

test('a wheel request withdrawn while the hand-over is under way is honoured: the run goes on', async () => {
  const f = handbackFake();
  const head = deferred();
  const h = harness({ deps: { ...f.deps, handback: { ...f.deps.handback, head: () => head.promise } } });
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  await h.ctl.handOver();
  build.resolve(doneBuild());
  await until(() => h.calls.critic.length === 1);
  await tick();

  assert.equal((await h.ctl.handBack()).ok, true, 'withdrawn');
  head.resolve(HAND_BASE);
  await until(() => h.calls.director.length >= 2);
  assert.notEqual(h.ctl.status().phase, 'handed');
  h.ctl.stop();
  await h.settle();
});

test('a Stop during an at-once hand-over whose wait timer already fired still ends the run', async () => {
  const f = handbackFake();
  const head = deferred();
  const h = harness({ deps: { ...f.deps, handback: { ...f.deps.handback, head: () => head.promise } } });
  h.next.director.push({ ok: true, error: 'limit', cards: [] });
  await h.start();
  const handing = h.ctl.handOver();
  await h.fire();
  h.ctl.stop();
  head.resolve(HAND_BASE);
  await handing;
  await h.settle();
  assert.equal(h.ctl.status().active, false);
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.ctl.status().wheel, 'running');
});

test('a phone wheel unit from far in the future is ignored and does not block later taps', async () => {
  const h = harness();
  const build = deferred();
  h.next.build.push(() => build.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.build.length === 1);
  assert.equal(await h.ctl.applyWheel([{ id: Number.MAX_SAFE_INTEGER, runId: 'lwtest1', action: 'hand' }]), false);
  assert.equal(h.stored.wheelSeq, 0);
  assert.equal(await h.ctl.applyWheel([{ id: h.clock, runId: 'lwtest1', action: 'hand' }]), true);
  build.resolve(doneBuild());
  await h.settle();
});

// ---- loop hooks: graph refresh, i18n, Lighthouse, reviews, second opinion ----------------

/** Fake loop-hook deps; `over.<dep>` replaces a default answer (a function of the call's opts). */
function hookFakes(over = {}) {
  const calls = { refreshGraph: [], reviews: [], secondOpinion: [], i18n: [], lighthouse: [] };
  const answers = {
    refreshGraph: () => ({ ok: true, committed: true, notes: [] }),
    reviews: () => ({ due: [], cards: [], notes: [] }),
    // null: no CLI order set, the second opinion is off.
    secondOpinion: () => null,
    i18n: () => ({ cards: [], notes: [] }),
    lighthouse: () => ({ results: [], notes: [] }),
    ...over,
  };
  const deps = Object.fromEntries(Object.keys(calls).map((k) => [k, async (o) => {
    calls[k].push(clone(o));
    return answers[k](o, calls[k].length);
  }]));
  return { calls, deps };
}

const lapNotes = (h, n) => (h.stored.laps.find((l) => l.n === n) || { notes: [] }).notes;
const cardOf = (text, extra = {}) => ({ kind: 'feel', severity: 'medium', text, details: 'why', acceptance: ['it is fixed'], files: [], ...extra });
const gateCritic = (extra = {}) => ({
  ok: true,
  verdict: 'continue',
  model: 'opus',
  modelReason: 'milestone gate',
  milestone: { name: 'skeleton', passed: true, score: 90 },
  next: 'core',
  allPassed: false,
  ...extra,
});
const lighthouseResults = (performance) => [{
  route: 'http://localhost:3000/',
  device: 'desktop',
  scores: { performance, accessibility: 95, bestPractices: 95, seo: 95 },
  reportPath: path.join(EVIDENCE, 'lh.json'),
}];

test('LW 2.23: the code graph is refreshed after every merge, never after an empty or red build', async () => {
  const f = hookFakes();
  const h = harness({ deps: f.deps, todos: [card(1), card(2), card(3)] });
  h.next.director.push(
    { ok: true, cards: [card(1), card(2)], model: 'opus', modelReason: 'setting' },
    { ok: true, cards: [card(3)], model: 'opus', modelReason: 'setting' },
    NO_CARDS,
    STOP_CARD,
  );
  h.next.build.push(DEFAULT, redBuild());
  await h.start();

  assert.equal(h.ctl.status().verdict, 'stop');
  assert.deepEqual(f.calls.refreshGraph, [{ repoPath: REPO, runId: 'lwtest1', iteration: 1 }], 'only the merged iteration');
  assert.equal(f.calls.i18n.length, 1, 'the i18n check follows the same merge');
  assert.match(logText(h), /code graph refreshed, codemaps committed/);
});

test('LW 2.23: a failing graph refresh is a note in the run report; the run goes on', async () => {
  const f = hookFakes({
    refreshGraph: (o, nth) => {
      if (nth === 1) throw new Error('index server down');
      return { ok: false, notes: ['code graph not re-indexed (cli): no such repo'] };
    },
  });
  const h = harness({ deps: f.deps, todos: [card(1), card(2), card(3)] });
  h.next.director.push(DEFAULT, { ok: true, cards: [card(3)], model: 'opus', modelReason: 'setting' }, STOP_CARD);
  await h.start();

  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.stored.stopReason, 'steer', 'not stepFailed: the refresh never failed a step');
  assert.equal(h.calls.critic.length, 2, 'both iterations went on to the Critic');
  assert.deepEqual(lapNotes(h, 1), ['graph refresh failed: index server down']);
  assert.deepEqual(lapNotes(h, 2), ['code graph not re-indexed (cli): no such repo']);
});

test('i18n: after a merge only the missing-keys card is filed, and never twice while it is open', async () => {
  const missing = cardOf('translation keys', { kind: 'bug', extraTags: ['i18n'] });
  const hardcoded = cardOf('2 UI string(s) hard-coded instead of translated', { kind: 'missing', severity: 'low' });
  const f = hookFakes({
    i18n: (o, nth) => ({ cards: [{ ...missing, text: `${nth + 2} translation key(s) missing or empty in pl/en` }, hardcoded], notes: [] }),
  });
  const h = harness({ deps: f.deps, todos: [card(1), card(2), card(3)] });
  h.next.director.push(DEFAULT, { ok: true, cards: [card(3)], model: 'opus', modelReason: 'setting' }, STOP_CARD);
  await h.start();

  assert.equal(f.calls.i18n.length, 2);
  const filed = h.todos.filter((t) => /translation key|hard-coded/.test(t.text));
  assert.equal(filed.length, 1, 'one card for the missing keys, the heuristic card left out');
  assert.equal(filed[0].text, '3 translation key(s) missing or empty in pl/en');
  assert.ok(filed[0].tags.includes('i18n') && filed[0].tags.includes('run:lwtest1'));
});

test('reviews: a failing reviewer never stops the run; review cards go to the to-do list', async () => {
  const reviewCard = cardOf('Validate the quote id in the export handler', { kind: 'bug', severity: 'high', extraTags: ['review:security'] });
  const f = hookFakes({
    reviews: (o, nth) => {
      if (nth === 1) throw new Error('reviewer crashed');
      return { due: ['security'], cards: [reviewCard], notes: ['performance review failed: timeout'] };
    },
  });
  const h = harness({ deps: f.deps, todos: [card(1), card(2), card(3)] });
  h.next.director.push(DEFAULT, { ok: true, cards: [card(3)], model: 'opus', modelReason: 'setting' }, STOP_CARD);
  await h.start();

  assert.equal(h.ctl.status().verdict, 'stop');
  assert.equal(h.stored.stopReason, 'steer');
  assert.deepEqual(f.calls.reviews.map((c) => [c.iteration, c.isGate]), [[1, false], [2, false]]);
  assert.deepEqual(lapNotes(h, 1), ['reviews failed: reviewer crashed']);
  assert.deepEqual(lapNotes(h, 2), ['performance review failed: timeout']);
  const filed = h.todos.find((t) => t.text === 'Validate the quote id in the export handler');
  assert.ok(filed, 'the review card is filed');
  assert.ok(filed.tags.includes('review:security') && filed.tags.includes('kind:bug') && filed.tags.includes('run:lwtest1'));
});

test('reviews run at a milestone gate with isGate (the cleanup review is due)', async () => {
  const f = hookFakes();
  const h = harness({ deps: f.deps });
  h.next.critic.push(gateCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.deepEqual(f.calls.reviews.map((c) => [c.iteration, c.isGate]), [[1, true]]);
});

test('second opinion: a disagreement at a gate keeps it closed until Mati opens it', async () => {
  const milestones = [];
  const f = hookFakes({
    secondOpinion: () => ({
      skipped: false, ok: true, cli: 'codex', verdict: 'continue', warnings: [], notes: [],
      cards: [cardOf('The quote total ignores VAT', { kind: 'bug', severity: 'high' })],
    }),
  });
  const h = harness({ deps: { ...f.deps, onMilestone: [(run, ctx) => milestones.push(ctx.milestone)] } });
  h.next.critic.push(gateCritic());
  const director = deferred();
  h.next.director.push(DEFAULT, () => director.promise);
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.calls.director.length === 2);

  assert.equal(f.calls.secondOpinion.length, 1);
  assert.equal(f.calls.secondOpinion[0].isGate, true);
  assert.equal(h.ctl.status().milestone, 'skeleton', 'the gate stays closed');
  assert.deepEqual(milestones, [], 'no milestone email for a held gate');
  const hold = h.stored.gateHold;
  assert.equal(hold.milestone, 'skeleton');
  assert.equal(hold.reason, 'blockingFindings');
  assert.equal(hold.cli, 'codex');
  const pending = h.ctl.status().pendingDecisions;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, hold.decisionId);
  assert.match(pending[0].question, /second opinion \(codex\) disagrees .* skeleton gate/);
  const filed = h.todos.find((t) => t.text === 'The quote total ignores VAT');
  assert.ok(filed && filed.tags.includes('second-opinion'), 'its new finding is merged into the cards');
  assert.ok(lapNotes(h, 1).some((n) => /gate skeleton held: the second opinion \(codex\) disagrees/.test(n)));

  assert.equal(h.ctl.answer({ id: hold.decisionId, answer: 'approve' }).ok, true);
  assert.equal(h.stored.gateHold, null);
  assert.equal(h.ctl.status().milestone, 'core', 'Mati opened the gate');
  assert.deepEqual(milestones, ['skeleton']);
  director.resolve(STOP_CARD);
  await h.settle();
});

test('second opinion: the next Critic resolves a held gate; it is not asked again on that pass', async () => {
  const f = hookFakes({
    secondOpinion: () => ({ skipped: false, ok: true, cli: 'gemini', verdict: 'ship', cards: [], warnings: [], notes: [] }),
  });
  const h = harness({ deps: f.deps });
  h.next.critic.push(gateCritic(), gateCritic());
  h.next.director.push(DEFAULT, NO_CARDS, STOP_CARD);
  await h.start();

  assert.equal(f.calls.secondOpinion.length, 1, 'only the first gate pass asked the second opinion');
  assert.equal(h.stored.gateHold, null);
  assert.equal(h.ctl.status().milestone, 'core', 'the next Critic passed the gate');
  assert.ok(lapNotes(h, 1).some((n) => /held: the second opinion \(gemini\) disagrees \(verdict\)/.test(n)));
  assert.deepEqual(lapNotes(h, 2), ['gate skeleton hold resolved by the Critic: passed']);
});

test('second opinion: a missing CLI is a report note and the Critic alone opens the gate', async () => {
  const f = hookFakes({
    secondOpinion: () => ({ skipped: true, note: 'second opinion skipped: codex not installed, gemini not logged in' }),
  });
  const h = harness({ deps: f.deps });
  h.next.critic.push(gateCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(h.ctl.status().milestone, 'core');
  assert.equal(h.stored.gateHold, null);
  assert.deepEqual(lapNotes(h, 1), ['second opinion skipped: codex not installed, gemini not logged in']);
});

test('second opinion is not asked when the Critic does not pass a gate', async () => {
  const f = hookFakes();
  const h = harness({ deps: f.deps });
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(f.calls.secondOpinion.length, 0);
});

test('Lighthouse: every iteration after launch, results kept with the run, a breach filed once', async () => {
  const f = hookFakes({
    lighthouse: (o, nth) => ({ results: lighthouseResults([95, 60, 55][nth - 1]), notes: [], budgets: { performance: 80 } }),
  });
  const h = harness({ deps: f.deps, scores: [10, 20, 30, 40] });
  h.next.director.push(DEFAULT, NO_CARDS, NO_CARDS, STOP_CARD);
  await h.start();

  assert.equal(h.ctl.status().verdict, 'stop');
  assert.deepEqual(f.calls.lighthouse.map((c) => [c.iteration, c.url, c.projectId]), [
    [1, 'http://localhost:3000', 'game'], [2, 'http://localhost:3000', 'game'], [3, 'http://localhost:3000', 'game'],
  ]);
  assert.deepEqual(h.stored.lighthouse.map((e) => [e.iteration, e.results[0].scores.performance]), [[1, 95], [2, 60], [3, 55]]);
  const breaches = h.todos.filter((t) => /^Performance \d+ on http:\/\/localhost:3000\/ is below its budget of 80$/.test(t.text));
  assert.equal(breaches.length, 1, 'the same breach is not filed again while its card is open');
  assert.ok(breaches[0].tags.includes('lighthouse'));
  // Persisted: a restart keeps the trend.
  assert.equal(restoreRun(clone(h.stored)).lighthouse.length, 3);
});

test('Lighthouse is skipped when the app did not start, and a failure never stops the run', async () => {
  const f = hookFakes({
    lighthouse: () => {
      throw new Error('chrome-devtools gone');
    },
  });
  const h = harness({ deps: f.deps });
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  assert.equal(h.ctl.status().verdict, 'stop');
  assert.deepEqual(lapNotes(h, 1), ['lighthouse failed: chrome-devtools gone']);

  const g = hookFakes();
  const h2 = harness({ deps: g.deps });
  h2.launchFails = true;
  h2.next.director.push(DEFAULT, STOP_CARD);
  await h2.start();
  assert.equal(g.calls.lighthouse.length, 0);
});

test('loop hooks after a restart in critiquing: reviews and the second opinion are not run twice', async () => {
  const f = hookFakes({ secondOpinion: () => ({ skipped: true, note: 'second opinion skipped: x' }) });
  const h = harness({ deps: f.deps });
  h.next.critic.push(gateCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  const saved = h.saves.find((s) => s.phase === 'critiquing' && s.current.hooks && s.current.hooks.reviewed);
  assert.ok(saved, 'the hooks are saved as done with the Critic');

  const g = hookFakes();
  const again = harness({ deps: g.deps, stored: saved });
  again.next.director.push(STOP_CARD);
  assert.equal(again.ctl.resume(), true);
  await again.settle();
  assert.equal(g.calls.reviews.length, 0);
  assert.equal(g.calls.secondOpinion.length, 0);
  assert.equal(again.calls.critic.length, 0, 'the saved Critic stands');
});

test('second opinion: Mati opening a held gate while its iteration is still ending opens it as it ends', async () => {
  const milestones = [];
  const f = hookFakes({
    secondOpinion: () => ({ skipped: false, ok: true, cli: 'codex', verdict: 'ship', cards: [], warnings: [], notes: [] }),
  });
  const tag = deferred();
  const checkpoints = { tagIteration: () => tag.promise, rollback: async () => ({ ok: false, error: 'unused' }) };
  const h = harness({ deps: { ...f.deps, checkpoints, onMilestone: [(run, ctx) => milestones.push(ctx.milestone)] } });
  h.next.critic.push(gateCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.ctl.start({ projectId: 'game' });
  await until(() => !!(h.stored.gateHold && h.stored.phase === 'critiquing' && h.stored.current.hooks && h.stored.current.hooks.reviewed));

  // The checkpoint tag is still being pushed: endIteration has not finished.
  assert.equal(h.ctl.answer({ id: h.stored.gateHold.decisionId, answer: 'approve' }).ok, true);
  assert.equal(h.stored.gateHold.approved, true);
  assert.deepEqual(milestones, [], 'not yet: the iteration opens it as it ends');
  tag.resolve({ ok: true, tag: 'luna-work/lwtest1/iter-1' });
  await h.settle();

  assert.equal(h.stored.gateHold, null);
  assert.equal(h.ctl.status().milestone, 'core', 'the approval was not lost to endIteration');
  assert.deepEqual(milestones, ['skeleton'], 'one milestone email');
});

test('a restart right after the gate was held keeps it held (the hold is not taken for the next Critic)', async () => {
  const f = hookFakes({
    secondOpinion: () => ({ skipped: false, ok: true, cli: 'codex', verdict: 'ship', cards: [], warnings: [], notes: [] }),
  });
  const h = harness({ deps: f.deps });
  h.next.critic.push(gateCritic());
  h.next.director.push(DEFAULT, STOP_CARD);
  await h.start();
  const saved = h.saves.find((s) => s.phase === 'critiquing' && s.gateHold && !(s.current.hooks && s.current.hooks.reviewed));
  assert.ok(saved, 'a save with the hold but the hooks not done yet');

  const g = hookFakes();
  const again = harness({ deps: g.deps, stored: saved });
  again.next.director.push(STOP_CARD);
  assert.equal(again.ctl.resume(), true);
  await again.settle();
  assert.equal(g.calls.secondOpinion.length, 0);
  assert.equal(again.ctl.status().milestone, 'skeleton', 'still held');
  assert.equal(again.stored.gateHold.milestone, 'skeleton');
});
