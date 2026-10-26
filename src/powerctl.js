// ============================================================================
// LunaCore - power control for God Mode runs (Windows only)
// ----------------------------------------------------------------------------
// The OS half of two run options (src/orchestraPower.js decides WHEN):
//
//   - scheduleWake(atMs) / cancelWake(): a one-shot Task Scheduler task with
//     WakeToRun, so a machine put to sleep at the usage limit wakes up for
//     the reset. Its action does nothing; waking is the whole point.
//   - sleepNow(): a real Suspend (S3 / modern standby) through
//     SetSuspendState - never rundll32 powrprof, which hibernates instead.
//   - canWake(): best effort - is there a sleep state, are wake timers on.
//   - shutdownIn(seconds) / abortShutdown(): shutdown /s /t, shutdown /a.
//
// Every child process goes through execFile with an argv array, never a
// shell string. On any other OS every function is a no-op that returns
// {ok:false, reason:'unsupported'}.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WAKE_TASK_NAME = 'LunaCore God Mode wake';
const SHUTDOWN_COMMENT = 'LunaCore God Mode run finished';
const EXEC_TIMEOUT_MS = 20 * 1000;
// The wake task expires (and deletes itself) this long after its trigger.
const WAKE_TASK_TTL_MS = 60 * 60 * 1000;
const MAX_SHUTDOWN_DELAY_S = 315360000; // shutdown.exe's own upper bound
const SUSPEND_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null";
// RTCWAKE: "Allow wake timers" under the current power scheme's Sleep group.
const WAKE_TIMER_QUERY = ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'RTCWAKE'];

const UNSUPPORTED = Object.freeze({ ok: false, reason: 'unsupported' });

/** Promise wrapper over child_process.execFile. Never rejects. */
function defaultExec(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: EXEC_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const pad = (n) => String(n).padStart(2, '0');

/** Task Scheduler wants local wall-clock time without a zone: 2026-10-22T05:31:00. */
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The wake task's XML: one time trigger at `atMs`, WakeToRun, a no-op action.
 * @param {number} atMs epoch ms
 * @returns {string}
 */
function wakeTaskXml(atMs) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wakes the PC for a LunaCore God Mode run after the usage limit resets.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localStamp(atMs)}</StartBoundary>
      <EndBoundary>${localStamp(atMs + WAKE_TASK_TTL_MS)}</EndBoundary>
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
    <StartWhenAvailable>false</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\cmd.exe</Command>
      <Arguments>/c exit 0</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The first block of `powercfg /a` lists the AVAILABLE sleep states (the
 * header is localized; the state codes are not).
 * @param {string} text
 * @returns {boolean}
 */
function hasSleepState(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.trim());
  if (start < 0) return false;
  const end = lines.findIndex((l, i) => i > start && !l.trim());
  const block = lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
  return /\bS[0-3]\b/.test(block);
}

/**
 * Current AC value of RTCWAKE from `powercfg /query`: 0 off, 1 on,
 * 2 important timers only. null when it cannot be read.
 * @param {string} text
 * @returns {number|null}
 */
function wakeTimerSetting(text) {
  const hex = String(text || '').match(/0x[0-9a-f]{8}/gi);
  return hex && hex.length ? parseInt(hex[0], 16) : null;
}

/**
 * @param {{
 *   platform?: string,
 *   exec?: (file:string, args:string[], opts?:object) => Promise<{ok:boolean, code:number, stdout:string, stderr:string}>,
 *   writeFile?: (file:string, data:Buffer) => void,
 *   removeFile?: (file:string) => void,
 *   tmpDir?: () => string,
 * }} [deps]
 */
function createPowerCtl(deps = {}) {
  const platform = deps.platform || process.platform;
  const exec = deps.exec || defaultExec;
  const writeFile = deps.writeFile || ((file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' }));
  const removeFile = deps.removeFile || ((file) => fs.rmSync(file, { force: true }));
  const tmpDir = deps.tmpDir || os.tmpdir;

  if (platform !== 'win32') {
    const none = async () => UNSUPPORTED;
    return { scheduleWake: none, cancelWake: none, sleepNow: none, canWake: none, shutdownIn: none, abortShutdown: none };
  }

  const fail = (res, reason) => ({ ok: false, reason, detail: (res.stderr || res.stdout || '').trim().slice(0, 200) || null });

  async function scheduleWake(atMs) {
    if (!Number.isFinite(atMs)) return { ok: false, reason: 'badTime' };
    const file = path.join(tmpDir(), `lunacore-wake-${process.pid}-${Date.now()}.xml`);
    try {
      // schtasks reads UTF-16 LE with a BOM reliably; UTF-8 is hit and miss.
      writeFile(file, Buffer.from(`﻿${wakeTaskXml(atMs)}`, 'utf16le'));
    } catch {
      return { ok: false, reason: 'writeFailed' };
    }
    try {
      const res = await exec('schtasks.exe', ['/Create', '/TN', WAKE_TASK_NAME, '/XML', file, '/F']);
      return res.ok ? { ok: true } : fail(res, 'schtasksFailed');
    } finally {
      try {
        removeFile(file);
      } catch {
        // A leftover temp file is harmless.
      }
    }
  }

  async function cancelWake() {
    const res = await exec('schtasks.exe', ['/Delete', '/TN', WAKE_TASK_NAME, '/F']);
    return res.ok ? { ok: true } : fail(res, 'schtasksFailed');
  }

  async function sleepNow() {
    const res = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SUSPEND_SCRIPT], { timeout: 0 });
    return res.ok ? { ok: true } : fail(res, 'suspendFailed');
  }

  async function canWake() {
    const states = await exec('powercfg.exe', ['/a']);
    if (states.ok && !hasSleepState(states.stdout)) return { ok: false, reason: 'noSleepState' };
    const timers = await exec('powercfg.exe', WAKE_TIMER_QUERY);
    const value = timers.ok ? wakeTimerSetting(timers.stdout) : null;
    if (value === 0) return { ok: false, reason: 'wakeTimersOff' };
    if (value === 2) return { ok: false, reason: 'wakeTimersImportantOnly' };
    if (value === 1 && states.ok) return { ok: true, reason: null };
    return { ok: true, reason: 'unknown' };
  }

  async function shutdownIn(seconds) {
    const n = Math.round(Number(seconds));
    if (!Number.isFinite(n) || n < 0 || n > MAX_SHUTDOWN_DELAY_S) return { ok: false, reason: 'badDelay' };
    const res = await exec('shutdown.exe', ['/s', '/t', String(n), '/c', SHUTDOWN_COMMENT]);
    return res.ok ? { ok: true } : fail(res, 'shutdownFailed');
  }

  async function abortShutdown() {
    const res = await exec('shutdown.exe', ['/a']);
    return res.ok ? { ok: true } : fail(res, 'shutdownFailed');
  }

  return { scheduleWake, cancelWake, sleepNow, canWake, shutdownIn, abortShutdown };
}

module.exports = {
  createPowerCtl,
  defaultExec,
  wakeTaskXml,
  localStamp,
  hasSleepState,
  wakeTimerSetting,
  WAKE_TASK_NAME,
  SHUTDOWN_COMMENT,
};
