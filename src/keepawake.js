// ============================================================================
// LunaCore - "Don't sleep" toggle (runs an external keep-awake .bat)
// ----------------------------------------------------------------------------
// The God Mode panel's second switch. ON launches Mati's own keep-awake script
// (a .bat that runs keep-awake.ps1 -KeepDisplayOn: blocks sleep AND the screen
// timeout); OFF kills that process tree. Windows drops the power request the
// moment the script's process dies, so killing it is a clean release.
//
// Independent of God Mode's own blocker (src/overnight.js), which only lives
// for the duration of a run and never keeps the display on.
//
// The script path is per-machine, so it lives in config/keepawake.local.json
// ({ "script": "C:\\...\\Keep Awake.bat" }), never in the repo. No file, no
// toggle: status() reports available:false and the UI disables the switch.
//
// Everything that touches the OS (spawn, execFile, fs) is injected so the
// tests never start a real process.
// ============================================================================

'use strict';

const path = require('path');

const CONFIG_FILE = 'keepawake.local.json';
const KILL_TIMEOUT_MS = 5000;
// The path is spliced into a cmd.exe command line, so anything cmd would read
// as syntax is refused outright rather than escaped.
const CMD_META = /["&|<>^%!\r\n]/;

/**
 * Validates the configured script path at the boundary.
 * @param {unknown} raw parsed keepawake.local.json
 * @param {(p:string)=>boolean} exists
 * @returns {{ok:true, script:string}|{ok:false, reason:string}}
 */
function resolveScript(raw, exists) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-configured' };
  const script = raw.script;
  if (typeof script !== 'string' || !script.trim()) return { ok: false, reason: 'not-configured' };
  const trimmed = script.trim();
  if (!path.win32.isAbsolute(trimmed) || CMD_META.test(trimmed)) return { ok: false, reason: 'invalid-path' };
  if (!/\.(bat|cmd)$/i.test(trimmed)) return { ok: false, reason: 'invalid-path' };
  if (!exists(trimmed)) return { ok: false, reason: 'missing' };
  return { ok: true, script: trimmed };
}

/**
 * @param {{
 *   platform: string,
 *   readConfig: () => unknown,
 *   exists: (p:string) => boolean,
 *   spawn: Function,
 *   execFile: Function,
 *   execFileSync: Function,
 *   onChange?: (status:Object) => void,
 * }} deps
 */
function createKeepAwake({ platform, readConfig, exists, spawn, execFile, execFileSync, onChange = () => {} }) {
  let child = null;
  let lastError = null;

  function resolve() {
    if (platform !== 'win32') return { ok: false, reason: 'unsupported' };
    try {
      return resolveScript(readConfig(), exists);
    } catch (err) {
      console.error('[keepawake] config read failed:', err && err.message);
      return { ok: false, reason: 'not-configured' };
    }
  }

  function status() {
    const resolved = resolve();
    return {
      on: child !== null,
      available: resolved.ok,
      reason: resolved.ok ? null : resolved.reason,
      error: lastError,
    };
  }

  function notify() {
    onChange(status());
  }

  function start() {
    if (child) return status();
    const resolved = resolve();
    if (!resolved.ok) {
      lastError = resolved.reason;
      return status();
    }
    lastError = null;
    let proc;
    try {
      // cmd /s /c ""<path>"": /s strips the outer quote pair, the inner pair
      // keeps a path with spaces ("Keep Awake.bat") as one token. Verbatim
      // args so Node does not re-escape the quotes. A .bat cannot be spawned
      // directly (Node refuses it with EINVAL since the 2024 BatBadBut fix).
      proc = spawn('cmd.exe', ['/d', '/s', '/c', `""${resolved.script}""`], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: 'ignore',
      });
    } catch (err) {
      lastError = 'spawn-failed';
      console.error('[keepawake] spawn failed:', err && err.message);
      return status();
    }
    child = proc;
    proc.on('error', (err) => {
      console.error('[keepawake] process error:', err && err.message);
      if (child !== proc) return;
      child = null;
      lastError = 'spawn-failed';
      notify();
    });
    // Covers both OFF and the script dying on its own (window closed, a
    // PowerShell error), so the switch never claims a blocker that is gone.
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      notify();
    });
    return status();
  }

  function stop() {
    const proc = child;
    if (!proc) return status();
    child = null;
    // /T takes the PowerShell grandchild with it - killing only cmd.exe would
    // orphan the process that actually holds the power request.
    execFile(
      'taskkill',
      ['/pid', String(proc.pid), '/T', '/F'],
      { windowsHide: true, timeout: KILL_TIMEOUT_MS },
      (err) => {
        if (err) console.error('[keepawake] taskkill failed:', err.message);
      },
    );
    return status();
  }

  /**
   * Quit-path variant: blocks until taskkill returns. The async stop() is not
   * enough on quit - Electron can exit before taskkill runs, and the script
   * does NOT die with its parent (verified live), so it would keep the
   * machine awake after LunaCore is gone.
   */
  function stopSync() {
    const proc = child;
    if (!proc) return;
    child = null;
    try {
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: KILL_TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch (err) {
      console.error('[keepawake] taskkill on quit failed:', err && err.message);
    }
  }

  function set(on) {
    return on === true ? start() : stop();
  }

  return { status, set, stop, stopSync };
}

module.exports = { createKeepAwake, resolveScript, CONFIG_FILE };
