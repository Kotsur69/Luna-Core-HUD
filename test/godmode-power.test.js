// ============================================================================
// God Mode power options: src/powerctl.js (argv, XML, no-op off Windows) and
// the sleep-at-limit / shutdown-when-done flows through the real controller,
// with exec, timers, keep-awake and powerMonitor's resume all faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createPowerCtl, wakeTaskXml, localStamp, hasSleepState, wakeTimerSetting, WAKE_TASK_NAME, SHUTDOWN_COMMENT } =
  require('../src/powerctl.js');
const { createOrchestra, RESUME_GRACE_MS } = require('../src/orchestra.js');
const { SLEEP_COUNTDOWN_MS } = require('../src/orchestraPower.js');

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

function setup({ answers = {}, packages = [pkg('a', [1]), pkg('b', [2])], createPr } = {}) {
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
