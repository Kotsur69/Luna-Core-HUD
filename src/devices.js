// ============================================================================
// LunaCore - Device panel (LUNACORE_HUD_WIDGET_PLAN.md §3, narrowed)
// ----------------------------------------------------------------------------
// Wraps helpers/devices/mic.ps1 the same way media.js wraps its two scripts:
// execFile with an ARGS ARRAY (never a shell string), a bounded timeout, and
// "missing capability degrades to null, never throws".
//
// NARROWED FROM THE PLAN, DELIBERATELY. The widget plan asked for Bluetooth,
// mic and webcam toggles via pnputil/devcon. Mic mute shipped; the other two
// did not, because pnputil device disabling fails the plan's own requirement
// that `checkDeviceStatus()` "reflect the real-time physical state": it needs
// elevation (so the toggle silently no-ops for a normal user), it persists
// after LunaCore exits (so the app changes the machine in a way its README
// does not claim), and its state cannot be read back cheaply - meaning the
// switch would drift out of sync with reality the first time anything else
// touched the device. A privacy control that lies about whether your camera is
// off is worse than no control. Mic mute has none of those problems: soft,
// instantly reversible, and readable.
//
// NO POLLER, unlike MediaSampler. Every read here is a ~200 ms PowerShell
// spawn, and mute state changes only when someone deliberately changes it - so
// this refreshes on mount, after each toggle, and when the user asks. An
// external change (Teams muting you) is picked up the next time the widget is
// looked at rather than costing a shell spawn every 2 s forever.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

const MIC_SCRIPT = path.join(__dirname, '..', 'helpers', 'devices', 'mic.ps1');

const COMMAND_TIMEOUT_MS = 8000;

const MIC_ACTIONS = ['get', 'toggle', 'mute', 'unmute'];

/** Runs a command and resolves with stdout; resolves '' on failure/timeout. */
function run(cmd, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout }, (err, stdout) =>
      resolve(err ? '' : stdout)
    );
  });
}

/**
 * Parses mic.ps1's stdout.
 *
 * Empty stdout is the script's documented "no capture endpoint / COM error"
 * signal, and maps to null - which the widget renders as "unavailable", never
 * as "unmuted". Guessing the safer-sounding default would be the same class of
 * lie the header rejects pnputil for.
 *
 * @param {string} stdout
 * @returns {{muted:boolean, available:boolean}|null}
 */
function parseMicState(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.muted !== 'boolean') return null;
    return { muted: obj.muted, available: true };
  } catch {
    return null;
  }
}

/**
 * Reads or changes the default microphone's mute state.
 * @param {'get'|'toggle'|'mute'|'unmute'} action
 * @returns {Promise<{muted:boolean, available:boolean}|null>} null when unavailable
 */
async function micState(action = 'get') {
  if (!IS_WINDOWS) return null;
  if (!MIC_ACTIONS.includes(action)) return null;
  const stdout = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    MIC_SCRIPT,
    '-Action',
    action,
  ]);
  return parseMicState(stdout);
}

module.exports = { parseMicState, micState, MIC_ACTIONS };
