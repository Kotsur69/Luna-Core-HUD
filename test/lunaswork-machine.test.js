// ============================================================================
// Luna's Work machine guard (src/lunasworkMachine.js). Every OS touch is a
// fake: the command runner (a fake registry + Task Scheduler), disk space,
// git, mail. Covers the watchdog task (installed with the run, quits a second
// copy, removed at the end) and resume after a simulated crash, Windows Update
// paused and restored (and the admin question asked once), evidence cleanup
// keeping gate / SHIP / rollback folders, settled worktree cleanup, and the
// low-disk stop + email.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WATCHDOG_TASK_NAME,
  ALL_PAUSE_VALUES,
  PAUSE_SPAN_MS,
  pauseStamp,
  parseRegValue,
  restoreCommands,
  watchdogTaskXml,
  evidenceToKeep,
  parseWorktreeList,
  worktreeCandidates,
  createMachineGuard,
} = require('../src/lunasworkMachine');
const { decideBoot, isWatchdogLaunch, WATCHDOG_FLAG } = require('../src/hostmain');
const { createLunasWork } = require('../src/lunaswork');
const { buildRunReport } = require('../src/lunasworkReport');

const REPO = path.resolve(os.tmpdir(), 'lw-machine-repo');
const EXE = path.resolve(os.tmpdir(), 'LunaCore', 'LunaCore.exe');
const START = Date.UTC(2026, 9, 26, 8, 0, 0);
const GB = 1024 ** 3;
const PROFILE = { adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' };
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr) => ({ ok: false, code: 1, stdout: '', stderr });

/** A fake reg.exe over an in-memory key, and a fake schtasks.exe. */
function fakeOs({ values = {}, denied = false } = {}) {
  const o = { reg: new Map(Object.entries(values)), tasks: new Map(), calls: [], xml: [] };
  o.exec = async (file, args) => {
    o.calls.push([file, ...args]);
    if (file === 'reg.exe') {
      const [op, key, , name] = args;
      if (op === 'query') {
        return o.reg.has(name)
          ? ok(`\r\n${key}\r\n    ${name}    REG_SZ    ${o.reg.get(name)}\r\n\r\n`)
          : fail('ERROR: The system was unable to find the specified registry key or value.');
      }
      if (denied) return fail('ERROR: Access is denied.');
      if (op === 'add') o.reg.set(name, args[7]);
      if (op === 'delete') o.reg.delete(name);
      return ok('The operation completed successfully.');
    }
    if (file === 'schtasks.exe') {
      if (args[0] === '/Create') o.tasks.set(args[2], o.xml[o.xml.length - 1]);
      if (args[0] === '/Delete') o.tasks.delete(args[2]);
      return ok('SUCCESS');
    }
    return fail('unknown program');
  };
  o.writeFile = (_file, data) => o.xml.push(data.toString('utf16le').replace(/^\ufeff/, ''));
  o.regWrites = () => o.calls.filter((c) => c[0] === 'reg.exe' && c[1] !== 'query');
  o.regQueries = () => o.calls.filter((c) => c[0] === 'reg.exe' && c[1] === 'query');
  return o;
}

/** A controller stand-in: status / snapshot / stop / ask / subscribe over a plain run. */
function fakeController(run) {
  const c = { run: run ? clone(run) : null, listeners: new Set(), stops: [], asks: [] };
  c.status = () => (c.run ? { active: c.run.phase !== 'done', runId: c.run.id, phase: c.run.phase } : { active: false, runId: null });
  c.snapshot = () => (c.run ? clone(c.run) : null);
  c.stop = (reason) => {
    c.stops.push(reason);
    return { ok: true };
  };
  c.ask = (spec) => {
    c.asks.push(spec);
    const id = 5000 + c.asks.length;
    c.run.decisions = [...(c.run.decisions || []), { id, status: 'pending', options: spec.options }];
    return { ok: true, id };
  };
  c.subscribe = (fn) => {
    c.listeners.add(fn);
    return () => c.listeners.delete(fn);
  };
  c.emit = (type) => {
    for (const fn of [...c.listeners]) fn({ type, status: c.status() });
  };
  return c;
}

function memoryStore(initial = null) {
  const s = { data: initial ? clone(initial) : null };
  s.load = () => (s.data ? clone(s.data) : null);
  s.save = (d) => {
    s.data = d === null ? null : clone(d);
    return true;
  };
  return s;
}

const RUN = { id: 'lwrun1', phase: 'directing', repoPath: REPO, iteration: 1, history: [], laps: [] };

function guard(opts = {}) {
  const g = {
    os: opts.os || fakeOs(opts.osOpts),
    store: opts.store || memoryStore(),
    controller: opts.controller || fakeController(RUN),
    clock: START,
    free: opts.free === undefined ? 50 * GB : opts.free,
    mails: [],
    timers: [],
    logs: [],
  };
  g.guard = createMachineGuard({
    controller: g.controller,
    store: g.store,
    platform: opts.platform || 'win32',
    exec: g.os.exec,
    writeFile: g.os.writeFile,
    removeFile: () => {},
    tmpDir: () => os.tmpdir(),
    launch: { command: EXE, args: [] },
    user: 'PC\\mati',
    freeBytes: async () => (typeof g.free === 'function' ? g.free() : g.free),
    runsRoot: () => opts.runsRoot || path.join(os.tmpdir(), 'lw-machine-no-runs'),
    git: opts.git || { run: async () => fail('no git'), removeWorktree: async () => ({ ok: false }) },
    worktreeInUse: opts.worktreeInUse,
    godModeBusy: opts.godModeBusy,
    email: async (msg) => g.mails.push(msg),
    now: () => g.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: g.clock + ms, cleared: false };
      g.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    log: (line) => g.logs.push(line),
  });
  g.guard.attach();
  g.settle = async () => {
    for (let i = 0; i < 3; i += 1) {
      await g.guard.idle();
      await tick();
    }
  };
  return g;
}

/** A real controller whose Director answers when `answer` says (never by default: the run sits in `directing`). */
function realController({ store = memoryStore(), runId = 'lwcrash1', onDirector = () => {}, answer = new Promise(() => {}) } = {}) {
  return createLunasWork({
    store,
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => ({ id, repoPath: REPO }),
    profileFor: () => PROFILE,
    godModeActive: () => false,
    todoStore: () => ({ read: () => [], write: () => true }),
    director: () => {
      onDirector();
      return answer;
    },
    build: async () => ({ ok: true }),
    createAdapter: () => ({}),
    playtest: async () => ({}),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({ ok: true }),
    newRunId: () => runId,
    now: () => START,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
}

// ---- watchdog ----

test('watchdogTaskXml: logon + 5-minute trigger, the launch command with the watchdog flag, quoted and escaped', () => {
  const body = watchdogTaskXml({ command: EXE, args: ['C:\\Program Files\\Luna & Co\\app'], user: 'PC\\mati', startMs: START });
  assert.match(body, /<LogonTrigger>[\s\S]*<UserId>PC\\mati<\/UserId>/);
  assert.match(body, /<Interval>PT5M<\/Interval>/);
  assert.match(body, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/, 'the started LunaCore is never killed by the task');
  assert.ok(body.includes(`<Command>${EXE}</Command>`));
  assert.ok(body.includes(`<Arguments>&quot;C:\\Program Files\\Luna &amp; Co\\app&quot; ${WATCHDOG_FLAG}</Arguments>`));
  assert.equal(watchdogTaskXml({ command: 'LunaCore.exe', args: [], startMs: START }), null, 'relative command refused');
  assert.equal(watchdogTaskXml({ command: EXE, args: ['a"b'], startMs: START }), null, 'unquotable argument refused');
});

test('a watchdog launch quits while LunaCore runs, and starts the HUD when it does not', () => {
  assert.equal(isWatchdogLaunch(['LunaCore.exe', WATCHDOG_FLAG]), true);
  assert.equal(isWatchdogLaunch(['LunaCore.exe']), false);
  assert.equal(decideBoot({ host: false, gotLock: false, watchdog: true }), 'quit');
  assert.equal(decideBoot({ host: false, gotLock: true, watchdog: true }), 'hud');
  assert.equal(decideBoot({ host: false, gotLock: false }), 'hud', 'a plain second launch behaves as before');
});

test('the run starts: the watchdog task is installed; the run ends: it is removed', async () => {
  const g = guard();
  g.controller.emit('phase');
  await g.settle();
  assert.ok(g.os.tasks.has(WATCHDOG_TASK_NAME));
  assert.ok(g.os.tasks.get(WATCHDOG_TASK_NAME).includes(WATCHDOG_FLAG));
  assert.equal(g.guard.status().watchdog, true);

  g.controller.run.phase = 'done';
  g.controller.emit('phase');
  await g.settle();
  assert.equal(g.os.tasks.has(WATCHDOG_TASK_NAME), false);
  assert.equal(g.guard.status(), null);
  assert.equal(g.store.data, null);
});

test('resume after a simulated crash: the persisted run goes on, the watchdog is re-armed, the update pause is not read again', async () => {
  const runStore = memoryStore();
  const machineStore = memoryStore();
  const osFake = fakeOs({ values: { PauseUpdatesExpiryTime: '2026-01-01T00:00:00Z' } });
  let directorCalls = 0;
  const onDirector = () => {
    directorCalls += 1;
  };

  // First LunaCore: the run starts and the guard sets the machine up.
  const first = realController({ store: runStore, onDirector });
  const g1 = guard({ controller: first, store: machineStore, os: osFake });
  await first.start({ projectId: 'app' });
  await g1.settle();
  assert.equal(first.status().phase, 'directing');
  assert.equal(directorCalls, 1);
  assert.equal(g1.guard.status().updates.state, 'paused');
  const queriesBefore = osFake.regQueries().length;
  const pausedUntil = osFake.reg.get('PauseUpdatesExpiryTime');

  // Crash mid-Director: the process is gone, the scheduled task is still there.
  g1.guard.dispose();
  assert.ok(osFake.tasks.has(WATCHDOG_TASK_NAME), 'the task survives the crash and starts LunaCore again');

  // Second LunaCore, started by the watchdog: attach, resume, reconcile.
  let answerDirector;
  const answer = new Promise((resolve) => {
    answerDirector = resolve;
  });
  const second = realController({ store: runStore, onDirector, answer });
  const g2 = guard({ controller: second, store: machineStore, os: osFake });
  assert.equal(second.resume(), true);
  g2.guard.reconcile();
  await g2.settle();
  assert.equal(second.status().active, true);
  assert.equal(second.status().runId, 'lwcrash1');
  assert.equal(directorCalls, 2, 'the persisted run picks up at its phase');
  assert.ok(second.runLog().some((e) => e.text === 'resumed at directing'));
  assert.ok(osFake.tasks.has(WATCHDOG_TASK_NAME));
  assert.equal(osFake.regQueries().length, queriesBefore, 'the previous values are never re-read (they are the pause now)');
  assert.equal(osFake.reg.get('PauseUpdatesExpiryTime'), pausedUntil);
  assert.equal(g2.guard.status().updates.previous.PauseUpdatesExpiryTime, '2026-01-01T00:00:00Z');

  // The run ends (Stop; the Director's step finishes first): the original
  // setting comes back, the task goes.
  second.stop();
  answerDirector({ ok: true, cards: [] });
  await second.idle();
  await g2.settle();
  assert.equal(second.status().verdict, 'stop');
  assert.equal(osFake.reg.get('PauseUpdatesExpiryTime'), '2026-01-01T00:00:00Z');
  assert.equal(osFake.reg.has('PauseUpdatesStartTime'), false);
  assert.equal(osFake.tasks.has(WATCHDOG_TASK_NAME), false);
});

test('reconcile after a restart with no active run undoes what the finished run left', async () => {
  const osFake = fakeOs();
  const store = memoryStore({ runId: 'lwold1', watchdog: true, updates: { state: 'paused', until: START + 1000, previous: {} } });
  osFake.reg.set('PauseUpdatesExpiryTime', pauseStamp(START + 1000));
  osFake.tasks.set(WATCHDOG_TASK_NAME, 'x');
  const g = guard({ os: osFake, store, controller: fakeController(null) });
  g.guard.reconcile();
  await g.settle();
  assert.equal(osFake.tasks.has(WATCHDOG_TASK_NAME), false);
  assert.equal(osFake.reg.has('PauseUpdatesExpiryTime'), false, 'a value that was not there before is deleted');
  assert.equal(store.data, null);
});

// ---- Windows Update ----

test('parseRegValue and restoreCommands: earlier values come back, missing ones are deleted, junk is never written', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\r\n    PauseUpdatesExpiryTime    REG_SZ    2026-01-01T00:00:00Z\r\n';
  assert.equal(parseRegValue(out, 'PauseUpdatesExpiryTime'), '2026-01-01T00:00:00Z');
  assert.equal(parseRegValue(out, 'PauseUpdatesStartTime'), null);
  const cmds = restoreCommands({ PauseUpdatesExpiryTime: '2026-01-01T00:00:00Z', PauseUpdatesStartTime: 'x" & calc' });
  assert.equal(cmds.length, ALL_PAUSE_VALUES.length);
  assert.equal(cmds.find((c) => c[3] === 'PauseUpdatesExpiryTime')[0], 'add');
  assert.deepEqual(cmds.find((c) => c[3] === 'PauseUpdatesStartTime'), ['delete', cmds[0][1], '/v', 'PauseUpdatesStartTime', '/f']);
});

test('Windows Update is paused for the run and the previous setting restored at the end (fake runner)', async () => {
  const before = { PauseUpdatesExpiryTime: '2026-01-01T00:00:00Z', PauseFeatureUpdatesEndTime: '2026-01-01T00:00:00Z' };
  const g = guard({ osOpts: { values: before } });
  g.controller.emit('phase');
  await g.settle();
  const until = pauseStamp(START + PAUSE_SPAN_MS);
  assert.equal(g.os.reg.get('PauseUpdatesExpiryTime'), until);
  assert.equal(g.os.reg.get('PauseQualityUpdatesEndTime'), until);
  assert.equal(g.os.reg.get('PauseUpdatesStartTime'), pauseStamp(START));
  assert.equal(g.guard.status().updates.state, 'paused');
  for (const c of g.os.regWrites()) assert.match(c[c.indexOf('/d') + 1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'only formatted dates are written');

  g.controller.run.phase = 'done';
  g.controller.emit('phase');
  await g.settle();
  assert.deepEqual(Object.fromEntries(g.os.reg), before, 'exactly the earlier values, nothing else');
  assert.equal(g.controller.asks.length, 0);
});

test('a long run renews the pause at a new iteration when it runs short', async () => {
  const g = guard();
  g.controller.emit('phase');
  await g.settle();
  g.clock = START + PAUSE_SPAN_MS - 2 * 24 * 60 * 60 * 1000;
  g.controller.emit('phase');
  await g.settle();
  assert.equal(g.os.reg.get('PauseUpdatesExpiryTime'), pauseStamp(g.clock + PAUSE_SPAN_MS));
  assert.equal(g.os.reg.get('PauseUpdatesStartTime'), pauseStamp(START), 'the start stays');
});

test('no admin rights: a warning, one decision-queue question, the run goes on; `stop` ends it', async () => {
  const store = memoryStore();
  const osFake = fakeOs({ denied: true });
  const g = guard({ os: osFake, store });
  g.controller.emit('phase');
  await g.settle();
  assert.equal(g.guard.status().updates.state, 'denied');
  assert.equal(g.controller.asks.length, 1);
  assert.deepEqual(g.controller.asks[0].options, ['continue', 'stop']);
  assert.equal(g.controller.asks[0].defaultAnswer, 'continue');
  assert.deepEqual(g.controller.stops, [], 'never blocks or stops on its own');
  assert.ok(g.logs.some((l) => /WARNING: Windows Update not paused \(needs admin\)/.test(l)));
  assert.equal(osFake.reg.size, 0);

  // A restart: the question is not asked again.
  g.guard.dispose();
  const again = guard({ os: osFake, store, controller: g.controller });
  again.guard.reconcile();
  await again.settle();
  assert.equal(g.controller.asks.length, 1);

  // Mati answers `stop`.
  const id = again.guard.status().updates.decisionId;
  g.controller.run.decisions = g.controller.run.decisions.map((d) => (d.id === id ? { ...d, status: 'answered', answer: 'stop' } : d));
  g.controller.emit('decision');
  await again.settle();
  assert.deepEqual(g.controller.stops, ['updatesNotPaused']);
});

test('off Windows nothing OS-level runs; the guard still watches the disk', async () => {
  const g = guard({ platform: 'linux', free: 1 * GB });
  g.controller.emit('phase');
  await g.settle();
  assert.equal(g.os.calls.length, 0);
  assert.equal(g.guard.status().updates.state, 'unsupported');
  assert.deepEqual(g.controller.stops, ['lowDisk']);
});

// ---- cleanup ----

test('evidenceToKeep: last K, current, milestone gates, SHIP and rolled-back iterations', () => {
  const history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ n, milestone: n <= 3 ? 'skeleton' : n <= 6 ? 'core' : 'complete' }));
  const laps = [{ n: 2, rolledBack: true }, { n: 5, criticVerdict: 'ship', shipAgrees: false }, { n: 7, criticVerdict: 'continue' }];
  const keep = evidenceToKeep({ iterations: history.map((h) => h.n), history, laps, current: 10, keepLast: 3 });
  assert.deepEqual([...keep].sort((a, b) => a - b), [2, 3, 5, 6, 8, 9, 10]);
});

test('cleanup removes old evidence folders but keeps every gate, SHIP and the last ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-machine-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'lunaswork-lwrun1');
  for (let n = 1; n <= 10; n += 1) {
    fs.mkdirSync(path.join(runDir, `iter-${n}`), { recursive: true });
    fs.writeFileSync(path.join(runDir, `iter-${n}`, 'shot.png'), 'x');
  }
  fs.mkdirSync(path.join(runDir, 'baselines'));
  fs.mkdirSync(path.join(root, 'lunaswork-otherrun', 'iter-1'), { recursive: true });
  const history = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ n, milestone: n <= 3 ? 'skeleton' : n <= 6 ? 'core' : 'complete' }));
  const laps = [{ n: 4, criticVerdict: 'ship', shipAgrees: false }];
  const controller = fakeController({ ...RUN, iteration: 10, history, laps });
  const g = guard({ controller, runsRoot: root });

  await g.guard.cleanup();
  const left = fs.readdirSync(runDir).sort();
  assert.deepEqual(left, ['baselines', 'iter-10', 'iter-3', 'iter-4', 'iter-6', 'iter-8', 'iter-9']);
  assert.ok(fs.existsSync(path.join(root, 'lunaswork-otherrun', 'iter-1')), 'another run is never touched');
});

test('cleanup removes settled worktrees only: pushed, under .luna-worktrees/<repo>, on a luna/ branch, no open tab', async () => {
  const wtBase = path.join(path.dirname(REPO), '.luna-worktrees', path.basename(REPO));
  const porcelain = [
    `worktree ${REPO}`,
    'branch refs/heads/main',
    '',
    `worktree ${path.join(wtBase, 'core-ab12c')}`,
    'branch refs/heads/luna/core-ab12c',
    '',
    `worktree ${path.join(wtBase, 'ui-zz99x')}`,
    'branch refs/heads/luna/ui-zz99x',
    '',
    `worktree ${path.join(wtBase, 'open-tab')}`,
    'branch refs/heads/luna/open-tab',
    '',
    `worktree ${path.join(os.tmpdir(), 'elsewhere')}`,
    'branch refs/heads/luna/elsewhere',
    '',
  ].join('\n');
  const removed = [];
  const git = {
    run: async (_cwd, args) => {
      if (args[0] === 'worktree') return ok(porcelain);
      // ui-zz99x has a commit no remote has.
      if (args[0] === 'rev-list') return ok(args[2].endsWith('ui-zz99x') ? '1\n' : '0\n');
      return fail('?');
    },
    removeWorktree: async (_repo, root) => {
      removed.push(path.basename(root));
      return { ok: true };
    },
  };
  assert.deepEqual(
    worktreeCandidates(parseWorktreeList(porcelain), REPO).map((w) => w.branch),
    ['luna/core-ab12c', 'luna/ui-zz99x', 'luna/open-tab'],
  );
  const g = guard({ git, worktreeInUse: (root) => root.endsWith('open-tab') });
  await g.guard.cleanup();
  assert.deepEqual(removed, ['core-ab12c']);

  // Mid-build nothing is touched: a fresh worker worktree looks settled too.
  const building = guard({ git, controller: fakeController({ ...RUN, phase: 'building', iteration: 2 }) });
  await building.guard.cleanup();
  const busy = guard({ git, godModeBusy: () => true });
  await busy.guard.cleanup();
  assert.deepEqual(removed, ['core-ab12c']);
});

// ---- low disk ----

test('low disk: the run is stopped cleanly and Mati gets one email', async () => {
  const g = guard({ free: 3 * GB });
  g.controller.emit('phase');
  await g.settle();
  assert.deepEqual(g.controller.stops, ['lowDisk']);
  assert.equal(g.mails.length, 1);
  assert.match(g.mails[0].subject, /low disk space \(lw-machine-repo\)/);
  assert.match(g.mails[0].text, /Only 3\.0 GB is free/);
  assert.match(g.mails[0].text, /at least 5\.0 GB/);
  assert.ok(!g.mails[0].text.includes(REPO), 'the repo is named, its path is not');

  await g.guard.checkDisk();
  assert.equal(g.mails.length, 1, 'one email per run');
  assert.equal(g.controller.stops.length, 1);
});

test('low disk: a cleanup that frees enough space keeps the run going', async () => {
  let calls = 0;
  // Low at the first look, enough after the cleanup.
  const g = guard({ free: () => (calls++ === 0 ? 4 * GB : 6 * GB) });
  g.controller.emit('phase');
  await g.settle();
  assert.deepEqual(g.controller.stops, []);
  assert.equal(g.mails.length, 0);
});

test('the disk is checked again on a timer while the run goes on', async () => {
  let free = 50 * GB;
  const g = guard({ free: () => free });
  g.controller.emit('phase');
  await g.settle();
  assert.deepEqual(g.controller.stops, []);
  free = 1 * GB;
  const timer = g.timers.find((x) => !x.cleared);
  assert.ok(timer, 'a disk timer is armed');
  timer.cleared = true;
  timer.fn();
  await g.settle();
  assert.deepEqual(g.controller.stops, ['lowDisk']);
});

test('controller: stop(lowDisk) ends the run with that reason; unknown reasons are the kill switch', async () => {
  const a = realController({ runId: 'lwdisk1' });
  await a.start({ projectId: 'app' });
  a.stop('lowDisk');
  assert.equal(a.status().stopReason, 'lowDisk');
  const b = realController({ runId: 'lwdisk2' });
  await b.start({ projectId: 'app' });
  b.stop('anything else');
  assert.equal(b.status().stopReason, 'killSwitch');

  const report = buildRunReport({ ...a.snapshot(), phase: 'done', verdict: 'stop', stopReason: 'lowDisk' });
  assert.match(report, /the disk was almost full/);
  assert.match(report, /Free some space/);
});
