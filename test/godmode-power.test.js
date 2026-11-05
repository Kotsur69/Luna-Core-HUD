// ============================================================================
// God Mode power options: src/powerctl.js (argv, XML, no-op off Windows) and
// the sleep-at-limit / shutdown-when-done flows through the real controller,
// with exec, timers, keep-awake and powerMonitor's resume all faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createPowerCtl,
  wakeTaskXml,
  localStamp,
  hasSleepState,
  wakeTimerSetting,
  parseBatteryPercent,
  WAKE_TASK_NAME,
  SHUTDOWN_COMMENT,
} = require('../src/powerctl.js');
const { createOrchestra, RESUME_GRACE_MS } = require('../src/orchestra.js');
const { SLEEP_COUNTDOWN_MS, createBatteryGuard, percentOf, LOW_BATTERY_PCT } = require('../src/orchestraPower.js');
const { ABORT_FINISH_AFTER_MS } = require('../src/orchestraFinalize.js');
const { createVerifyQueue } = require('../src/verifyQueue.js');
const { batteryNotice, BATTERY_NOTICES } = require('../src/orchestraWiring.js');

const POWERCFG_A = [
  'The following sleep states are available on this system:',
  '    Standby (S3)',
  '    Hibernate',
  '',
  'The following sleep states are not available on this system:',
  '    Standby (S1)',
].join('\r\n');
const RTCWAKE = (hex) =>
  [
    '    Power Setting GUID: bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d  (Allow wake timers)',
    '      Possible Setting Index: 000',
    '      Possible Setting Friendly Name: Disable',
    `    Current AC Power Setting Index: ${hex}`,
    '    Current DC Power Setting Index: 0x00000000',
  ].join('\r\n');

/** A fake exec: records every call, answers per executable. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const answer = answers[file];
    const res = typeof answer === 'function' ? await answer(args) : answer;
    return { ok: true, code: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { exec, calls };
}

function winCtl(answers) {
  const fx = fakeExec(answers);
  const files = { written: new Map(), removed: [] };
  const ctl = createPowerCtl({
    platform: 'win32',
    exec: fx.exec,
    tmpDir: () => '/tmp',
    writeFile: (file, data) => files.written.set(file, data),
    removeFile: (file) => files.removed.push(file),
  });
  return { ctl, calls: fx.calls, files };
}

// ---- powerctl ----------------------------------------------------------------

test('off Windows every power function is a no-op that says unsupported', async () => {
  const fx = fakeExec();
  const ctl = createPowerCtl({ platform: 'linux', exec: fx.exec });
  for (const fn of ['scheduleWake', 'cancelWake', 'sleepNow', 'canWake', 'shutdownIn', 'abortShutdown']) {
    assert.deepEqual(await ctl[fn](Date.now()), { ok: false, reason: 'unsupported' }, fn);
  }
  assert.equal(fx.calls.length, 0);
});

test('scheduleWake writes a WakeToRun task XML and hands it to schtasks as argv', async () => {
  const at = new Date(2026, 9, 22, 5, 31, 0).getTime();
  const { ctl, calls, files } = winCtl();
  assert.deepEqual(await ctl.scheduleWake(at), { ok: true });
  assert.equal(calls.length, 1);
  const [file] = [...files.written.keys()];
  assert.deepEqual(calls[0].file, 'schtasks.exe');
  assert.deepEqual(calls[0].args, ['/Create', '/TN', WAKE_TASK_NAME, '/XML', file, '/F']);
  assert.deepEqual(files.removed, [file], 'the temp XML goes after');
  const buf = files.written.get(file);
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE with BOM');
  const xml = buf.toString('utf16le');
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/);
  assert.match(xml, /<StartBoundary>2026-10-22T05:31:00<\/StartBoundary>/);
  assert.match(xml, /<Arguments>\/c exit 0<\/Arguments>/, 'harmless action');
  assert.equal(localStamp(at), '2026-10-22T05:31:00');
  assert.equal(wakeTaskXml(at).includes('rundll32'), false);
  assert.equal((await ctl.scheduleWake(NaN)).ok, false);
});

test('scheduleWake reports a schtasks failure', async () => {
  const { ctl } = winCtl({ 'schtasks.exe': { ok: false, code: 1, stderr: 'Access is denied.' } });
  const res = await ctl.scheduleWake(Date.now() + 1000);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'schtasksFailed');
});

test('cancelWake, sleepNow, shutdownIn and abortShutdown use fixed argv', async () => {
  const { ctl, calls } = winCtl();
  await ctl.cancelWake();
  await ctl.sleepNow();
  await ctl.shutdownIn(120);
  await ctl.abortShutdown();
  assert.deepEqual(calls[0], { file: 'schtasks.exe', args: ['/Delete', '/TN', WAKE_TASK_NAME, '/F'], opts: undefined });
  assert.equal(calls[1].file, 'powershell.exe');
  const script = calls[1].args[calls[1].args.length - 1];
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.match(script, /SetSuspendState\('Suspend', \$false, \$false\)/);
  assert.equal(calls.some((c) => /rundll32/i.test(c.file) || c.args.some((a) => /powrprof/i.test(a))), false);
  assert.deepEqual(calls[2], { file: 'shutdown.exe', args: ['/s', '/t', '120', '/c', SHUTDOWN_COMMENT], opts: undefined });
  assert.deepEqual(calls[3], { file: 'shutdown.exe', args: ['/a'], opts: undefined });
  assert.equal((await ctl.shutdownIn(-1)).ok, false);
});

test('canWake reads powercfg: sleep states and the wake-timer setting', async () => {
  assert.equal(hasSleepState(POWERCFG_A), true);
  assert.equal(hasSleepState('No states:\r\n    Hibernate\r\n\r\nNot available:\r\n    Standby (S3)'), false);
  assert.equal(wakeTimerSetting(RTCWAKE('0x00000002')), 2);
  const on = winCtl({ 'powercfg.exe': (args) => ({ stdout: args[0] === '/a' ? POWERCFG_A : RTCWAKE('0x00000001') }) });
  assert.deepEqual(await on.ctl.canWake(), { ok: true, reason: null });
  const off = winCtl({ 'powercfg.exe': (args) => ({ stdout: args[0] === '/a' ? POWERCFG_A : RTCWAKE('0x00000000') }) });
  assert.deepEqual(await off.ctl.canWake(), { ok: false, reason: 'wakeTimersOff' });
  const none = winCtl({ 'powercfg.exe': { stdout: 'Available:\r\n    Hibernate\r\n' } });
  assert.deepEqual(await none.ctl.canWake(), { ok: false, reason: 'noSleepState' });
  const broken = winCtl({ 'powercfg.exe': { ok: false, code: 1 } });
  assert.deepEqual(await broken.ctl.canWake(), { ok: true, reason: 'unknown' });
});

// ---- the flows through the controller -----------------------------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const pkg = (id, todoAts) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'opus' });

function setup({ answers = {}, packages = [pkg('a', [1]), pkg('b', [2])], createPr, extra = {} } = {}) {
  let clock = new Date(2026, 9, 22, 1, 0).getTime();
  let seq = 0;
  const timers = [];
  const alive = new Set();
  const log = { events: [], report: null, appended: [], awake: [], flushed: 0 };
  const power = winCtl(answers);
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    writePty: (id) => alive.has(id),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }),
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    createPr: createPr || (async () => ({ ok: true, url: 'https://github.com/o/r/pull/1' })),
    removeWorktree: async () => ({ ok: true }),
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
    power: power.ctl,
    awake: { release: () => log.awake.push('release'), restore: () => log.awake.push('restore') },
    flush: () => {
      log.flushed += 1;
    },
    appendReport: (id, line) => log.appended.push([id, line]),
    ...extra,
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
  const setClock = (ms) => {
    clock = ms;
  };
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const ran = (file, first) => power.calls.filter((c) => c.file === file && (!first || c.args[0] === first));
  return { orch, log, ctx, advance, flush, alive, power, ran, now: () => clock, setClock };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  await s.flush();
  return { ...s, planId: plan.id };
}

test('sleep at the limit: wake scheduled for reset + grace, keep-awake released, then 60 s and suspend', async () => {
  const s = await started();
  s.orch.setOptions({ sleepOnLimit: true });
  const until = s.now() + 3_600_000;
  s.orch.onUsageLimit('s1', until);
  await s.flush();
  const create = s.ran('schtasks.exe', '/Create');
  assert.equal(create.length, 1);
  const xml = s.power.files.written.get(create[0].args[4]).toString('utf16le');
  assert.match(xml, new RegExp(`<StartBoundary>${localStamp(until + RESUME_GRACE_MS)}</StartBoundary>`));
  assert.deepEqual(s.log.awake, ['release']);
  assert.equal(s.orch.view().power.sleep.phase, 'countdown');
  assert.equal(s.ran('powershell.exe').length, 0, 'not before the countdown ends');
  s.advance(SLEEP_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.ran('powershell.exe').length, 1);
  assert.equal(s.orch.view().power.sleep.phase, 'sleeping');
});

test('no sleep when the wake task could not be scheduled', async () => {
  const s = await started({ answers: { 'schtasks.exe': { ok: false, code: 1, stderr: 'denied' } } });
  s.orch.setOptions({ sleepOnLimit: true });
  s.orch.onUsageLimit('s1', s.now() + 3_600_000);
  await s.flush();
  s.advance(SLEEP_COUNTDOWN_MS * 2);
  await s.flush();
  assert.equal(s.ran('powershell.exe').length, 0);
  assert.deepEqual(s.log.awake, [], 'keep-awake never let go');
  assert.equal(s.orch.view().power.sleep, null);
  assert.equal(s.orch.view().power.sleepError, 'schtasksFailed');
});

test('no sleep while a worker waits on a permission prompt, or with the option off', async () => {
  const s = await started();
  s.orch.onUsageLimit('s1', s.now() + 3_600_000);
  await s.flush();
  assert.equal(s.ran('schtasks.exe').length, 0, 'option off: nothing scheduled');

  const t = await started();
  t.orch.setOptions({ sleepOnLimit: true });
  t.orch.onApproval('s2', 'Bash(npm test:*)');
  t.orch.onUsageLimit('s1', t.now() + 3_600_000);
  await t.flush();
  t.advance(SLEEP_COUNTDOWN_MS);
  await t.flush();
  assert.equal(t.ran('schtasks.exe', '/Create').length, 0);
  assert.equal(t.ran('powershell.exe').length, 0);
});

test('a kill during the countdown cancels the sleep and the wake task', async () => {
  const s = await started();
  s.orch.setOptions({ sleepOnLimit: true });
  s.orch.onUsageLimit('s1', s.now() + 3_600_000);
  await s.flush();
  s.orch.kill();
  await s.flush();
  s.advance(SLEEP_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.ran('powershell.exe').length, 0);
  assert.equal(s.ran('schtasks.exe', '/Delete').length, 1);
  assert.deepEqual(s.log.awake, ['release', 'restore']);
});

test('unticking while paused cancels the countdown and deletes the wake task', async () => {
  const s = await started();
  s.orch.setOptions({ sleepOnLimit: true });
  s.orch.onUsageLimit('s1', s.now() + 3_600_000);
  await s.flush();
  s.orch.setOptions({ sleepOnLimit: false });
  await s.flush();
  s.advance(SLEEP_COUNTDOWN_MS);
  await s.flush();
  assert.equal(s.ran('powershell.exe').length, 0);
  assert.equal(s.ran('schtasks.exe', '/Delete').length, 1);
  assert.deepEqual(s.log.awake, ['release', 'restore']);
  assert.equal(s.orch.view().power.sleep, null);
  assert.ok(s.orch.view().pausedUntil, 'the run itself stays paused');
});

test('resume after the wake: past pausedUntil the run resumes now; before it the timer is re-armed', async () => {
  const s = await started();
  s.orch.setOptions({ sleepOnLimit: true });
  const until = s.now() + 3_600_000;
  s.orch.onUsageLimit('s1', until);
  await s.flush();
  s.advance(SLEEP_COUNTDOWN_MS);
  await s.flush();

  // Woke early (someone opened the lid): still paused, resume re-armed.
  s.setClock(until - 10 * 60 * 1000);
  s.orch.onSystemResume();
  await s.flush();
  assert.equal(s.orch.view().pausedUntil, until);
  assert.equal(s.ran('schtasks.exe', '/Delete').length, 1, 'the wake task goes');
  assert.deepEqual(s.log.awake, ['release', 'restore'], 'keep-awake back');
  s.advance(10 * 60 * 1000 + RESUME_GRACE_MS);
  await s.flush();
  assert.equal(s.orch.view().pausedUntil, null, 're-armed timer resumed the run');

  // The wake task's own wake, past the reset, with timers that missed the sleep.
  const t = await started();
  t.orch.setOptions({ sleepOnLimit: true });
  const u2 = t.now() + 3_600_000;
  t.orch.onUsageLimit('s1', u2);
  await t.flush();
  t.advance(SLEEP_COUNTDOWN_MS);
  await t.flush();
  t.setClock(u2 + RESUME_GRACE_MS / 2);
  t.orch.onSystemResume();
  await t.flush();
  assert.equal(t.orch.view().pausedUntil, null);
  assert.ok(t.log.events.some(([k]) => k === 'resumed'));
});

test('shutdown when done: only after finalize resolved, keep-awake released, writes flushed, report noted', async () => {
  let releasePr;
  const prGate = new Promise((r) => {
    releasePr = r;
  });
  const s = await started({
    createPr: async () => {
      await prGate;
      return { ok: true, url: 'https://github.com/o/r/pull/1' };
    },
  });
  s.orch.setOptions({ shutdownWhenDone: true });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush(10);
  assert.equal(s.orch.view().settled, true);
  assert.equal(s.ran('shutdown.exe').length, 0, 'finalize still integrating');
  releasePr();
  await s.flush(20);
  const shut = s.ran('shutdown.exe', '/s');
  assert.equal(shut.length, 1);
  assert.deepEqual(shut[0].args, ['/s', '/t', '120', '/c', SHUTDOWN_COMMENT]);
  assert.ok(s.log.report, 'the report was written first');
  assert.equal(s.log.flushed, 1);
  assert.deepEqual(s.log.awake, ['release']);
  assert.equal(s.log.appended.length, 1);
  assert.equal(s.log.appended[0][0], s.planId);
  assert.match(s.log.appended[0][1], /^- PC shut down at \d\d:\d\d$/);
  assert.equal(s.orch.view().power.shutdown.phase, 'countdown');

  // Cancel shutdown -> shutdown /a, keep-awake back.
  await s.orch.cancelShutdown();
  assert.equal(s.ran('shutdown.exe', '/a').length, 1);
  assert.deepEqual(s.log.awake, ['release', 'restore']);
  assert.equal(s.orch.view().power.shutdown, null);
});

test('no shutdown when the option is off at the end, even if it was on at the start', async () => {
  const s = await started();
  s.orch.setOptions({ shutdownWhenDone: true });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush(10);
  s.orch.setOptions({ shutdownWhenDone: false });
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush(20);
  assert.equal(s.orch.view().integration.state, 'done');
  assert.equal(s.ran('shutdown.exe').length, 0);
});

test('no shutdown on a killed run, even after Finish run by hand', async () => {
  const s = await started();
  s.orch.setOptions({ shutdownWhenDone: true });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush(10);
  s.orch.kill();
  await s.flush(10);
  await s.orch.finishRun({ planId: s.planId });
  await s.flush(10);
  assert.equal(s.ran('shutdown.exe').length, 0);
});

test('unticking during the shutdown countdown aborts it', async () => {
  const s = await started();
  s.orch.setOptions({ shutdownWhenDone: true });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  s.orch.onTurnEnd('s2', turn('LUNA_DONE b'));
  await s.flush(20);
  assert.equal(s.ran('shutdown.exe', '/s').length, 1);
  s.orch.setOptions({ shutdownWhenDone: false });
  await s.flush();
  assert.equal(s.ran('shutdown.exe', '/a').length, 1);
  assert.match(s.log.appended[1][1], /^- Shutdown canceled at \d\d:\d\d$/);
});

// ---- battery ------------------------------------------------------------------

test('powerctl batteryPercent: Win32_Battery through powershell, parsed; none without a battery', async () => {
  assert.equal(parseBatteryPercent('87\r\n'), 87);
  assert.equal(parseBatteryPercent('42,6'), 43);
  assert.equal(parseBatteryPercent(''), null, 'no battery: powershell prints nothing');
  assert.equal(parseBatteryPercent('140'), null);
  assert.equal(parseBatteryPercent('n/a'), null);
  const win = winCtl({ 'powershell.exe': { stdout: '63\r\n' } });
  assert.deepEqual(await win.ctl.batteryPercent(), { ok: true, percent: 63 });
  assert.equal(win.calls[0].file, 'powershell.exe');
  assert.match(win.calls[0].args.join(' '), /Win32_Battery/);
  const desktop = winCtl({ 'powershell.exe': { stdout: '' } });
  assert.deepEqual(await desktop.ctl.batteryPercent(), { ok: false, reason: 'noBattery' });
  assert.deepEqual(await createPowerCtl({ platform: 'linux' }).batteryPercent(), { ok: false, reason: 'unsupported' });
  assert.equal(percentOf({ ok: true, percent: 15 }), 15);
  assert.equal(percentOf({ ok: false, reason: 'noBattery' }), null);
});

/**
 * A battery guard over a fake powerMonitor. `state.percent` is what the next
 * read returns (null = no percentage available).
 */
function fakeBattery({ onBattery = false, percent = null, anyRunActive = () => true } = {}) {
  const state = { onBattery, percent, notices: [], reads: 0 };
  const events = {};
  const guard = createBatteryGuard({
    isOnBattery: () => state.onBattery,
    onBatteryEvent: (fn) => {
      events.battery = fn;
    },
    onAcEvent: (fn) => {
      events.ac = fn;
    },
    readPercent: async () => {
      state.reads += 1;
      return state.percent === null ? { ok: false, reason: 'noBattery' } : { ok: true, percent: state.percent };
    },
    anyRunActive: () => anyRunActive(),
    notify: (kind, info) => state.notices.push([kind, info.percent]),
    // The poll never fires on its own here; tests read by hand.
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const unplug = (pct = state.percent) => {
    state.onBattery = true;
    state.percent = pct;
    events.battery();
  };
  const plugIn = () => {
    state.onBattery = false;
    events.ac();
  };
  return { guard, state, unplug, plugIn };
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

test('battery guard: one warning per battery period, a new period warns again', async () => {
  const b = fakeBattery();
  b.guard.start();
  assert.deepEqual(b.state.notices, []);
  b.unplug(80);
  await settle();
  b.guard.onRunStart();
  b.guard.onRunStart();
  await b.guard.readNow();
  assert.deepEqual(b.state.notices, [['battery', null]], 'once, not on every check');
  assert.deepEqual(b.guard.view(), { onBattery: true, percent: 80, held: false, thresholdPct: LOW_BATTERY_PCT });
  b.plugIn();
  b.guard.onRunStart();
  assert.equal(b.state.notices.length, 1, 'on mains: no warning');
  b.unplug(70);
  await settle();
  assert.equal(b.state.notices.length, 2, 'a new battery period warns once more');
});

test('battery guard: no warning while no run is live; started on battery warns at the run start', async () => {
  let live = false;
  const b = fakeBattery({ onBattery: true, percent: 50, anyRunActive: () => live });
  b.guard.start();
  await settle();
  assert.deepEqual(b.state.notices, []);
  live = true;
  b.guard.onRunStart();
  assert.deepEqual(b.state.notices, [['battery', 50]]);
});

test('battery notification text: pl without diacritics, en, the level filled in', () => {
  assert.match(batteryNotice('battery', 'en'), /on battery/);
  assert.match(batteryNotice('batteryLow', 'pl', { percent: 12 }), /^Bateria 12% /);
  assert.match(batteryNotice('batteryLow', 'en', { percent: 12 }), /^Battery at 12% /);
  assert.equal(batteryNotice('nope', 'en'), null);
  for (const entry of Object.values(BATTERY_NOTICES)) {
    assert.ok(entry.pl && entry.en);
    assert.doesNotMatch(entry.pl, /[^\x00-\x7f]/, 'pl without diacritics');
  }
});

test('verify queue: a held verify waits at the head of the queue and runs once allowed', async () => {
  let ran = 0;
  const queue = createVerifyQueue({
    runImpl: async () => {
      ran += 1;
      return { ok: true, output: '' };
    },
  });
  let allow;
  const hold = new Promise((r) => {
    allow = r;
  });
  const first = queue.run('npm test', '/wt/a', { whenAllowed: () => hold });
  const second = queue.run('npm test', '/wt/b', {});
  await settle();
  assert.equal(ran, 0, 'nothing starts while held - not even the next one');
  allow();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(ran, 2);
});

/** A started run with a battery guard and the real serial verify queue. */
async function batteryRun({ onBattery = false, percent = null } = {}) {
  let orch = null;
  const b = fakeBattery({ onBattery, percent, anyRunActive: () => !!(orch && orch.view() && orch.view().started) });
  const verifies = [];
  const queue = createVerifyQueue({
    runImpl: async (_cmd, cwd) => {
      verifies.push(cwd);
      return { ok: true, output: '' };
    },
  });
  const s = setup({
    extra: {
      battery: b.guard,
      finishPackage: async (p, hooks) => {
        const res = await queue.run('npm test', p.root, hooks);
        return res.ok ? { ok: true, headSha: `${p.id}5678aaa`, files: [] } : { ok: false, stage: 'verify', output: res.output };
      },
    },
  });
  orch = s.orch;
  b.guard.start();
  await settle();
  const { plan } = await s.orch.makePlan(s.ctx);
  await s.orch.launch({ planId: plan.id });
  await s.flush();
  return { ...s, b, verifies, planId: plan.id };
}

test('starting a run on battery shows the warning once (board + notification)', async () => {
  const r = await batteryRun({ onBattery: true, percent: 64 });
  assert.equal(r.alive.size, 2, 'above the threshold the workers launch');
  assert.deepEqual(r.b.state.notices, [['battery', 64]]);
  assert.deepEqual(r.orch.view().battery, { onBattery: true, percent: 64, held: false, thresholdPct: LOW_BATTERY_PCT });
  r.orch.tick();
  r.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await r.flush(10);
  assert.equal(r.b.state.notices.length, 1, 'not repeated while the run goes on');
});

test('below the threshold no worker launches; plugging in launches them', async () => {
  const r = await batteryRun({ onBattery: true, percent: 12 });
  assert.equal(r.orch.view().started, true, 'Approve still starts the run');
  assert.equal(r.alive.size, 0, 'no worker on a low battery');
  assert.equal(r.orch.view().battery.held, true);
  assert.deepEqual(r.b.state.notices, [['battery', 12], ['batteryLow', 12]]);
  assert.deepEqual(await r.orch.launch({ planId: r.planId, ids: ['a'] }), { ok: false, error: 'batteryLow' });
  r.b.plugIn();
  await r.flush(10);
  assert.equal(r.alive.size, 2, 'plugged in: the held packages launch');
  assert.equal(r.orch.view().battery.onBattery, false);
});

test('below the threshold a new verify waits, the running worker is not killed; plugging in resumes the verify', async () => {
  const r = await batteryRun();
  assert.equal(r.alive.size, 2);
  r.b.unplug(15);
  await r.flush(10);
  assert.equal(r.orch.view().battery.held, true);
  r.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await r.flush(10);
  const a = r.orch.view().packages.find((p) => p.id === 'a');
  const b = r.orch.view().packages.find((p) => p.id === 'b');
  assert.equal(r.verifies.length, 0, 'the verify did not start');
  assert.deepEqual([a.state, a.verifyPhase], ['finishing', 'queued']);
  assert.equal(b.state, 'launched', 'the other worker keeps running');
  assert.ok(r.alive.has('s2'), 'its tab is not closed');
  r.b.plugIn();
  await r.flush(12);
  assert.equal(r.verifies.length, 1, 'plugged in: the verify runs');
  assert.equal(r.orch.view().packages.find((p) => p.id === 'a').state, 'pushed');
});

test('no battery percentage available: warns only, nothing is held', async () => {
  const r = await batteryRun({ onBattery: true, percent: null });
  assert.equal(r.alive.size, 2);
  assert.deepEqual(r.b.state.notices, [['battery', null]]);
  assert.equal(r.orch.view().battery.held, false);
  r.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await r.flush(10);
  assert.equal(r.verifies.length, 1);
});

test('a Retry that would launch a worker is refused on a low battery; a live tab is only nudged', async () => {
  const r = await batteryRun();
  r.alive.delete('s2');
  r.orch.onSessionClosed('s2');
  await r.flush();
  r.b.unplug(10);
  await r.flush();
  assert.deepEqual(await r.orch.retry({ planId: r.planId, id: 'b' }), { ok: false, error: 'batteryLow' });
  r.b.plugIn();
  await r.flush();
  assert.equal((await r.orch.retry({ planId: r.planId, id: 'b' })).ok, true);
});

// ---- Abort finish ---------------------------------------------------------------

test('a finish past the threshold can be aborted; Retry is refused before and works after', async () => {
  // The PR step hangs forever: the finish never ends on its own.
  const s = await started({ createPr: () => new Promise(() => {}), extra: { integrateDrainMs: 0 } });
  s.orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  await s.flush(10);
  s.alive.delete('s2');
  s.orch.onSessionClosed('s2');
  await s.flush(10);
  const integ = s.orch.view().integration;
  assert.equal(integ.running, true, 'the run is finishing');
  assert.equal(integ.startedAt, s.now());
  assert.equal(integ.abortAfter, integ.startedAt + ABORT_FINISH_AFTER_MS);
  assert.deepEqual(await s.orch.retry({ planId: s.planId, id: 'b' }), { ok: false, error: 'busy' });
  assert.deepEqual(s.orch.abortFinalize({ planId: s.planId }), { ok: false, error: 'tooEarly' });

  s.setClock(s.now() + ABORT_FINISH_AFTER_MS + 1000);
  assert.deepEqual(s.orch.abortFinalize({ planId: 'another' }), { ok: false, error: 'noPlan' });
  assert.deepEqual(s.orch.abortFinalize(null), { ok: false, error: 'noPlan' });
  assert.deepEqual(s.orch.abortFinalize({ planId: s.planId }), { ok: true });
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await s.flush(10);
  }
  const after = s.orch.view().integration;
  assert.equal(after.running, false, 'the board is free');
  assert.deepEqual([after.state, after.error], ['failed', 'abortedByUser']);
  assert.ok(s.log.report, 'the report is still written');
  assert.deepEqual(s.orch.abortFinalize({ planId: s.planId }), { ok: false, error: 'notFinishing' });
  const retried = await s.orch.retry({ planId: s.planId, id: 'b' });
  assert.equal(retried.ok, true, 'Retry works again');
  assert.equal(s.orch.view().packages.find((p) => p.id === 'b').state, 'launched');
});
