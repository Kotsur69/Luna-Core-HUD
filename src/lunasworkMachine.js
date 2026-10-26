// ============================================================================
// LunaCore - Luna's Work: survive the machine (LUNAS_WORK_PLAN B3)
// ----------------------------------------------------------------------------
// A run goes on for days on an unattended PC. This guard follows the run
// controller (src/lunaswork.js, through subscribe) and, while a run is going:
//
//   watchdog       a Task Scheduler task (at logon + every 5 minutes) that
//                  starts LunaCore with --lunaswork-watchdog; src/hostmain.js
//                  quits such a launch at once when LunaCore already runs.
//                  After a crash or a reboot LunaCore comes back and resume()
//                  picks the persisted run up. Removed when the run ends.
//   Windows Update the pause values under HKLM\...\WindowsUpdate\UX\Settings
//                  are set for the run (renewed while it lasts) and the
//                  previous values written back at its end. Without admin
//                  rights Mati is asked once through the decision queue
//                  (default: go on without the pause); the run never blocks.
//   disk cleanup   at every new iteration: old evidence folders (the last
//                  EVIDENCE_KEEP_LAST iterations, every milestone gate, SHIP
//                  and rollback iterations stay) and settled God Mode
//                  worktrees of the project (pushed, clean, no open tab).
//   low disk       under LOW_DISK_BYTES free on the repo drive (after one
//                  cleanup) the run is stopped cleanly (stopReason lowDisk)
//                  and Mati gets an email.
//
// Every OS command is a fixed program + argv built here, never model input
// (the only variable parts are dates this module formats and the registry's
// own earlier values, both checked against PAUSE_STAMP_RE). Everything that
// touches the OS (exec, fs, disk space, git, mail, clock, timers) is injected.
// The guard's own state (which run it set up, the previous update settings)
// is persisted, so a crash mid-run still restores Windows Update at the end.
// Every function resolves and never rejects; a failure is logged.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultExec, localStamp } = require('./powerctl');
const worktrees = require('./worktrees');
const { WATCHDOG_FLAG } = require('./hostmain');

const LOW_DISK_BYTES = 5 * 1024 ** 3;
const EVIDENCE_KEEP_LAST = 3;
const DISK_CHECK_MS = 10 * 60 * 1000;
const WATCHDOG_TASK_NAME = 'LunaCore Lunas Work watchdog';
const WATCHDOG_REPEAT = 'PT5M';
const UPDATE_KEY = 'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings';
// The pause the Settings app writes: start + end per update kind, one expiry.
const PAUSE_VALUES = Object.freeze({
  start: ['PauseUpdatesStartTime', 'PauseFeatureUpdatesStartTime', 'PauseQualityUpdatesStartTime'],
  end: ['PauseUpdatesExpiryTime', 'PauseFeatureUpdatesEndTime', 'PauseQualityUpdatesEndTime'],
});
const ALL_PAUSE_VALUES = [...PAUSE_VALUES.start, ...PAUSE_VALUES.end];
const DAY_MS = 24 * 60 * 60 * 1000;
// Paused this far ahead, renewed at an iteration when less than PAUSE_RENEW_MS is left.
const PAUSE_SPAN_MS = 7 * DAY_MS;
const PAUSE_RENEW_MS = 3 * DAY_MS;
const PAUSE_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const ITER_DIR_RE = /^iter-(\d{1,6})$/;
const OWN_BRANCH_RE = /^luna(-free)?\/[a-z0-9][a-z0-9-]{0,63}$/;
const ARG_FORBIDDEN_RE = /["\r\n\0]/;
const UPDATE_OPTIONS = ['continue', 'stop'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const detailOf = (res) => String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 200);

// ---- pure parts ---------------------------------------------------------------------

/** The registry's pause format: 2026-10-26T08:00:00Z (UTC, no millis). */
function pauseStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** One REG_SZ value out of `reg query <key> /v <name>`, or null. */
function parseRegValue(stdout, name) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}\t`));
  if (!line) return null;
  const m = line.match(/REG_SZ\s+(.+)$/);
  return m ? m[1].trim() : null;
}

/** reg.exe argv that sets every pause value (start = now, end = until). */
function pauseCommands(nowMs, untilMs) {
  const start = pauseStamp(nowMs);
  const end = pauseStamp(untilMs);
  return [
    ...PAUSE_VALUES.start.map((name) => ['add', UPDATE_KEY, '/v', name, '/t', 'REG_SZ', '/d', start, '/f']),
    ...PAUSE_VALUES.end.map((name) => ['add', UPDATE_KEY, '/v', name, '/t', 'REG_SZ', '/d', end, '/f']),
  ];
}

/**
 * reg.exe argv that puts the earlier values back: a value that was there is
 * written again (only in the pause format), one that was not is deleted.
 * @param {Record<string, string|null>} previous
 */
function restoreCommands(previous) {
  const prev = isObj(previous) ? previous : {};
  return ALL_PAUSE_VALUES.map((name) => {
    const value = prev[name];
    return typeof value === 'string' && PAUSE_STAMP_RE.test(value)
      ? ['add', UPDATE_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']
      : ['delete', UPDATE_KEY, '/v', name, '/f'];
  });
}

/** reg.exe's "Access is denied" (English or Polish Windows). */
const isDenied = (res) => /denied|odmowa/i.test(detailOf(res));

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One argv entry for a task's Arguments line, or null when it cannot be quoted safely. */
function quoteArg(arg) {
  if (typeof arg !== 'string' || !arg || ARG_FORBIDDEN_RE.test(arg)) return null;
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * The watchdog task's XML: at logon (of `user`, when known) and every
 * 5 minutes from `startMs`, start LunaCore with WATCHDOG_FLAG.
 * @param {{command:string, args:string[], user?:string|null, startMs:number}} spec
 * @returns {string|null} null when the command or an argument is unusable
 */
function watchdogTaskXml({ command, args, user, startMs }) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || ARG_FORBIDDEN_RE.test(command)) return null;
  const quoted = [...(Array.isArray(args) ? args : []), WATCHDOG_FLAG].map(quoteArg);
  if (quoted.includes(null)) return null;
  const logonUser = typeof user === 'string' && user && !ARG_FORBIDDEN_RE.test(user) ? `\n      <UserId>${xml(user)}</UserId>` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts LunaCore again while a Luna's Work run is going. Removed when the run ends.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${logonUser}
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>${WATCHDOG_REPEAT}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${localStamp(startMs)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(quoted.join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Pure: which iteration evidence folders stay. The last `keepLast`, the
 * current one, every milestone gate (the last iteration of a milestone the
 * run moved on from), SHIP iterations and rolled-back ones (their bug cards
 * point at the evidence).
 * @param {{iterations:number[], history?:object[], laps?:object[], current?:number, keepLast?:number}} input
 * @returns {Set<number>}
 */
function evidenceToKeep({ iterations, history = [], laps = [], current, keepLast = EVIDENCE_KEEP_LAST }) {
  const sorted = [...new Set((Array.isArray(iterations) ? iterations : []).filter(Number.isInteger))].sort((a, b) => a - b);
  const keep = new Set(keepLast > 0 ? sorted.slice(-keepLast) : []);
  if (Number.isInteger(current)) keep.add(current);
  const records = (Array.isArray(history) ? history : []).filter((r) => isObj(r) && Number.isInteger(r.n)).sort((a, b) => a.n - b.n);
  records.forEach((r, i) => {
    const next = records[i + 1];
    if (next && next.milestone !== r.milestone) keep.add(r.n);
    if (r.rolledBack === true) keep.add(r.n);
  });
  for (const lap of Array.isArray(laps) ? laps : []) {
    if (!isObj(lap) || !Number.isInteger(lap.n)) continue;
    if (lap.criticVerdict === 'ship' || lap.shipAgrees === true || lap.rolledBack === true) keep.add(lap.n);
  }
  return keep;
}

/** `git worktree list --porcelain` -> [{root, branch|null}]. */
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      cur = { root: line.slice('worktree '.length), branch: null };
      out.push(cur);
    } else if (cur && line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return out;
}

/** Inside `dir` (not `dir` itself), comparing resolved paths case-insensitively on Windows. */
function isInside(dir, p, platform = process.platform) {
  const norm = (x) => (platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const base = norm(dir);
  const target = norm(p);
  return target !== base && target.startsWith(base + path.sep);
}

/**
 * Pure: the project's LunaCore worktrees (under .luna-worktrees/<repo>/, on a
 * luna/ branch) that may be settled - the caller still checks pushed + clean.
 */
function worktreeCandidates(list, repoPath, platform = process.platform) {
  const base = path.dirname(worktrees.worktreePathFor(repoPath, 'x'));
  return (Array.isArray(list) ? list : []).filter(
    (w) => isObj(w) && typeof w.root === 'string' && OWN_BRANCH_RE.test(w.branch || '') && isInside(base, w.root, platform),
  );
}

/** The low-disk email: what happened, how much is free, what to do. */
function lowDiskEmail({ repoName, freeBytes, runId, iteration }) {
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  return {
    subject: `Luna's Work stopped: low disk space (${repoName})`,
    text: [
      `Luna's Work stopped the run ${runId} on ${repoName} at iteration ${iteration}.`,
      '',
      `Only ${gb(freeBytes)} GB is free on the project's drive; a run needs at least ${gb(LOW_DISK_BYTES)} GB.`,
      'Old evidence folders and settled worktrees were already cleaned up.',
      '',
      "Free some space, then start the run again from the Luna's Work panel.",
    ].join('\n'),
  };
}

// ---- the guard ----------------------------------------------------------------------

/**
 * @param {{
 *   controller: {status:Function, snapshot:Function, stop:Function, ask:Function, subscribe:Function},
 *   store: {load:()=>unknown, save:(data:object|null)=>boolean},
 *   platform?: string,
 *   exec?: (file:string, args:string[], opts?:object)=>Promise<{ok:boolean, code:number, stdout:string, stderr:string}>,
 *   launch?: {command:string, args:string[]}|null, user?: string|null,
 *   freeBytes?: (dir:string)=>Promise<number|null>,
 *   runsRoot: ()=>string,
 *   fsImpl?: {readdirSync:Function, rmSync:Function},
 *   git?: {run:(cwd:string, args:string[])=>Promise<{ok:boolean, stdout:string}>, removeWorktree:(repo:string, root:string)=>Promise<{ok:boolean}>},
 *   worktreeInUse?: (root:string)=>boolean,
 *   godModeBusy?: ()=>boolean,
 *   email?: (msg:{subject:string, text:string})=>Promise<unknown>,
 *   writeFile?: (file:string, data:Buffer)=>void, removeFile?: (file:string)=>void, tmpDir?: ()=>string,
 *   now?: ()=>number, setTimer?: Function, clearTimer?: Function, log?: (line:string)=>void,
 * }} deps
 */
function createMachineGuard(deps) {
  const platform = deps.platform || process.platform;
  const exec = deps.exec || defaultExec;
  const fsImpl = deps.fsImpl || fs;
  const now = deps.now || Date.now;
  const setTimer =
    deps.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && t.unref) t.unref();
      return t;
    });
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || (() => {});
  const writeFile = deps.writeFile || ((file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' }));
  const removeFile = deps.removeFile || ((file) => fs.rmSync(file, { force: true }));
  const tmpDir = deps.tmpDir || os.tmpdir;
  const freeBytes = deps.freeBytes || defaultFreeBytes;
  const git = deps.git || {
    run: (cwd, args) => worktrees.runGit(cwd, args),
    removeWorktree: (repo, root) => worktrees.removeWorktree(repo, root),
  };
  const windows = platform === 'win32';

  let state = loadState();
  let diskTimer = null;
  let stopping = false;
  // One operation at a time: begin / end / iteration work never interleave.
  let queue = Promise.resolve();

  function loadState() {
    try {
      const raw = deps.store.load();
      return isObj(raw) && typeof raw.runId === 'string' && RUN_ID_RE.test(raw.runId) ? raw : null;
    } catch {
      return null;
    }
  }

  function setState(next) {
    state = next;
    try {
      if (!deps.store.save(next)) log('[lunaswork-machine] state not saved');
    } catch (err) {
      log(`[lunaswork-machine] state not saved: ${errText(err)}`);
    }
  }

  const patch = (fields) => setState({ ...state, ...fields });

  function enqueue(fn) {
    queue = queue.then(fn).catch((err) => log(`[lunaswork-machine] ${errText(err)}`));
    return queue;
  }

  // ---- watchdog ----

  async function installWatchdog() {
    if (!windows || !deps.launch) return false;
    const body = watchdogTaskXml({ command: deps.launch.command, args: deps.launch.args, user: deps.user, startMs: now() });
    if (!body) {
      log('[lunaswork-machine] watchdog not installed: unusable launch command');
      return false;
    }
    const file = path.join(tmpDir(), `lunacore-watchdog-${process.pid}-${now()}.xml`);
    try {
      // schtasks reads UTF-16 LE with a BOM reliably (same as src/powerctl.js).
      writeFile(file, Buffer.from(`﻿${body}`, 'utf16le'));
    } catch (err) {
      log(`[lunaswork-machine] watchdog not installed: ${errText(err)}`);
      return false;
    }
    try {
      const res = await exec('schtasks.exe', ['/Create', '/TN', WATCHDOG_TASK_NAME, '/XML', file, '/F']);
      if (!res.ok) log(`[lunaswork-machine] watchdog not installed: ${detailOf(res)}`);
      return res.ok;
    } finally {
      try {
        removeFile(file);
      } catch {
        // A leftover temp file is harmless.
      }
    }
  }

  async function removeWatchdog() {
    if (!windows) return;
    const res = await exec('schtasks.exe', ['/Delete', '/TN', WATCHDOG_TASK_NAME, '/F']);
    if (!res.ok) log(`[lunaswork-machine] watchdog not removed: ${detailOf(res)}`);
  }

  // ---- Windows Update ----

  async function readPrevious() {
    const previous = {};
    for (const name of ALL_PAUSE_VALUES) {
      const res = await exec('reg.exe', ['query', UPDATE_KEY, '/v', name]);
      const value = res.ok ? parseRegValue(res.stdout, name) : null;
      previous[name] = value && PAUSE_STAMP_RE.test(value) ? value : null;
    }
    return previous;
  }

  /** @returns {Promise<{ok:boolean, denied?:boolean, detail?:string}>} */
  async function runReg(commands) {
    for (const args of commands) {
      const res = await exec('reg.exe', args);
      if (!res.ok) return { ok: false, denied: isDenied(res), detail: detailOf(res) };
    }
    return { ok: true };
  }

  /** Mati is asked once per run; the default goes on without the pause. */
  function askAboutUpdates(detail) {
    const res = deps.controller.ask({
      kind: 'other',
      question: 'Windows Update could not be paused for this run (LunaCore is not running as administrator). Go on without the pause?',
      detail: `A Windows restart mid-run is survived by the watchdog, but costs time. ${detail || ''}`.trim(),
      options: UPDATE_OPTIONS,
      defaultAnswer: 'continue',
    });
    return res && res.ok ? res.id : null;
  }

  async function pauseUpdates() {
    if (!windows) {
      patch({ updates: { state: 'unsupported' } });
      return;
    }
    const previous = await readPrevious();
    const until = now() + PAUSE_SPAN_MS;
    const res = await runReg(pauseCommands(now(), until));
    if (res.ok) {
      log(`[lunaswork-machine] Windows Update paused until ${pauseStamp(until)}`);
      patch({ updates: { state: 'paused', until, previous } });
      return;
    }
    // Part of the pause may be written: put the earlier values back.
    await runReg(restoreCommands(previous));
    log(`[lunaswork-machine] WARNING: Windows Update not paused (${res.denied ? 'needs admin' : res.detail || 'failed'}) - the run goes on`);
    const decisionId = askAboutUpdates(res.denied ? '' : res.detail);
    patch({ updates: { state: res.denied ? 'denied' : 'failed', decisionId, answered: false } });
  }

  /** At each new iteration: a long run keeps its pause. */
  async function renewPause() {
    const u = state && state.updates;
    if (!u || u.state !== 'paused' || !Number.isFinite(u.until) || u.until - now() > PAUSE_RENEW_MS) return;
    const until = now() + PAUSE_SPAN_MS;
    const res = await runReg(pauseCommands(now(), until).filter((args) => PAUSE_VALUES.end.includes(args[3])));
    if (res.ok) patch({ updates: { ...u, until } });
    else log(`[lunaswork-machine] Windows Update pause not renewed: ${res.detail}`);
  }

  async function restoreUpdates() {
    const u = state && state.updates;
    if (!u || u.state !== 'paused') return;
    const res = await runReg(restoreCommands(u.previous));
    if (res.ok) log('[lunaswork-machine] Windows Update settings restored');
    else log(`[lunaswork-machine] WARNING: Windows Update settings not restored: ${res.detail}`);
  }

  /** Mati answered the update question with `stop`: the run ends. */
  function checkUpdateAnswer() {
    const u = state && state.updates;
    if (!u || !Number.isFinite(u.decisionId) || u.answered) return;
    const run = deps.controller.snapshot();
    const decision = run && Array.isArray(run.decisions) ? run.decisions.find((d) => d && d.id === u.decisionId) : null;
    if (!decision || decision.status !== 'answered') return;
    patch({ updates: { ...u, answered: true } });
    if (decision.answer === 'stop') deps.controller.stop('updatesNotPaused');
  }

  // ---- cleanup ----

  function cleanupEvidence(run) {
    if (typeof run.id !== 'string' || !RUN_ID_RE.test(run.id)) return 0;
    const root = path.resolve(deps.runsRoot());
    const dir = path.join(root, `lunaswork-${run.id}`);
    let names;
    try {
      names = fsImpl.readdirSync(dir);
    } catch {
      return 0;
    }
    const byN = new Map();
    for (const name of names) {
      const m = String(name).match(ITER_DIR_RE);
      if (m) byN.set(Number(m[1]), name);
    }
    const keep = evidenceToKeep({ iterations: [...byN.keys()], history: run.history, laps: run.laps, current: run.iteration });
    let removed = 0;
    for (const [n, name] of byN) {
      if (keep.has(n)) continue;
      const target = path.join(dir, name);
      if (!isInside(dir, target, platform)) continue;
      try {
        fsImpl.rmSync(target, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        log(`[lunaswork-machine] evidence ${name} not removed: ${errText(err)}`);
      }
    }
    return removed;
  }

  /** Pushed = no commit on the branch that no remote has. */
  async function isPushed(repoPath, branch) {
    const res = await git.run(repoPath, ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes']);
    return res.ok && Number.parseInt(String(res.stdout).trim(), 10) === 0;
  }

  async function cleanupWorktrees(run) {
    // Only between builds: a God Mode worker's fresh worktree looks settled too.
    if (run.phase !== 'directing' || (deps.godModeBusy && deps.godModeBusy())) return 0;
    const listed = await git.run(run.repoPath, ['worktree', 'list', '--porcelain']);
    if (!listed.ok) return 0;
    let removed = 0;
    for (const w of worktreeCandidates(parseWorktreeList(listed.stdout), run.repoPath, platform)) {
      if (deps.worktreeInUse && deps.worktreeInUse(w.root)) continue;
      if (!(await isPushed(run.repoPath, w.branch))) continue;
      // removeWorktree refuses anything uncommitted.
      const res = await git.removeWorktree(run.repoPath, w.root);
      if (res && res.ok) removed += 1;
    }
    return removed;
  }

  /** @returns {Promise<{evidence:number, worktrees:number}>} */
  async function cleanup() {
    const run = deps.controller.snapshot();
    if (!run || run.phase === 'done') return { evidence: 0, worktrees: 0 };
    const evidence = cleanupEvidence(run);
    let wts = 0;
    try {
      wts = await cleanupWorktrees(run);
    } catch (err) {
      log(`[lunaswork-machine] worktree cleanup failed: ${errText(err)}`);
    }
    if (evidence || wts) log(`[lunaswork-machine] cleanup: ${evidence} evidence folder(s), ${wts} worktree(s) removed`);
    return { evidence, worktrees: wts };
  }

  // ---- low disk ----

  async function free(repoPath) {
    try {
      const n = await freeBytes(repoPath);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function sendLowDiskMail(run, bytes) {
    if (!deps.email || (state && state.lowDiskMailed)) return;
    if (state) patch({ lowDiskMailed: true });
    try {
      await deps.email(lowDiskEmail({ repoName: path.basename(run.repoPath), freeBytes: bytes, runId: run.id, iteration: run.iteration }));
    } catch (err) {
      log(`[lunaswork-machine] low-disk email failed: ${errText(err)}`);
    }
  }

  /** @returns {Promise<{ok:boolean, freeBytes:number|null, stopped?:boolean}>} */
  async function checkDisk() {
    const run = deps.controller.snapshot();
    if (!run || run.phase === 'done' || stopping) return { ok: true, freeBytes: null };
    let bytes = await free(run.repoPath);
    if (bytes === null || bytes >= LOW_DISK_BYTES) return { ok: true, freeBytes: bytes };
    await cleanup();
    bytes = await free(run.repoPath);
    if (bytes === null || bytes >= LOW_DISK_BYTES) return { ok: true, freeBytes: bytes };
    stopping = true;
    log(`[lunaswork-machine] low disk (${bytes} bytes free) - stopping run ${run.id}`);
    deps.controller.stop('lowDisk');
    await sendLowDiskMail(run, bytes);
    return { ok: false, freeBytes: bytes, stopped: true };
  }

  function armDiskTimer() {
    if (diskTimer) clearTimer(diskTimer);
    diskTimer = setTimer(() => {
      diskTimer = null;
      enqueue(async () => {
        if (!state) return;
        await checkDisk();
        if (state) armDiskTimer();
      });
    }, DISK_CHECK_MS);
  }

  function disarmDiskTimer() {
    if (diskTimer) clearTimer(diskTimer);
    diskTimer = null;
  }

  // ---- run lifecycle ----

  async function end() {
    disarmDiskTimer();
    if (!state) return;
    await removeWatchdog();
    await restoreUpdates();
    setState(null);
    stopping = false;
  }

  async function begin(runId) {
    // A guard left by an earlier run (it ended while LunaCore was down): undo it first.
    if (state && state.runId !== runId) await end();
    const fresh = !state;
    if (fresh) setState({ runId, watchdog: false, updates: null, lowDiskMailed: false });
    stopping = false;
    // Installed again after a restart too (/F replaces it): the task may be gone.
    patch({ watchdog: await installWatchdog() });
    if (fresh) await pauseUpdates();
    else await renewPause();
    armDiskTimer();
    await checkDisk();
  }

  async function newIteration() {
    if (!state) return;
    await renewPause();
    await cleanup();
    await checkDisk();
  }

  function onEvent(event) {
    const st = event && event.status;
    if (!isObj(st)) return queue;
    if (!st.active) return enqueue(end);
    if (typeof st.runId !== 'string' || !RUN_ID_RE.test(st.runId)) return queue;
    if (!state || state.runId !== st.runId) return enqueue(() => begin(st.runId));
    if (event.type === 'decision') return enqueue(checkUpdateAnswer);
    if (event.type === 'phase' && st.phase === 'directing') return enqueue(newIteration);
    return queue;
  }

  let unsubscribe = null;

  return {
    /** Follows the controller; call before controller.resume(). */
    attach: () => {
      if (!unsubscribe) unsubscribe = deps.controller.subscribe(onEvent);
    },
    /** After resume(): sets up a resumed run, or undoes what a finished one left. */
    reconcile: () => onEvent({ type: 'reconcile', status: deps.controller.status() }),
    checkDisk: () => enqueue(checkDisk),
    cleanup: () => enqueue(cleanup),
    status: () => (state ? { ...state, updates: state.updates ? { ...state.updates } : null } : null),
    /** Test seam: settles when the queued work is done. */
    idle: () => queue,
    /** Quit path: timers only - the watchdog and the pause stay for the restart. */
    dispose: () => {
      disarmDiskTimer();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}

/** Free bytes on the drive holding `dir` (fs.statfs), or null. */
async function defaultFreeBytes(dir) {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

module.exports = {
  LOW_DISK_BYTES,
  EVIDENCE_KEEP_LAST,
  DISK_CHECK_MS,
  WATCHDOG_TASK_NAME,
  UPDATE_KEY,
  ALL_PAUSE_VALUES,
  PAUSE_SPAN_MS,
  pauseStamp,
  parseRegValue,
  pauseCommands,
  restoreCommands,
  watchdogTaskXml,
  evidenceToKeep,
  parseWorktreeList,
  worktreeCandidates,
  lowDiskEmail,
  createMachineGuard,
};
