// ============================================================================
// LunaCore - Media Deck: now-playing polling + transport/volume commands
// ----------------------------------------------------------------------------
// Wraps helpers/media/now-playing.ps1 (GSMTC) and helpers/media/volume.ps1
// (Core Audio COM interop) the same way gpu.js wraps Get-Counter and tts.js
// wraps SAPI: execFile/spawn with an ARGS ARRAY (never a shell string), a
// bounded timeout, and "missing capability degrades to null/false, never
// throws" - see gpu.js's and tts.js's own header comments for why.
//
// The one piece of renderer-controlled input here is a volume percentage,
// which is clamped to an integer 0-100 BEFORE it becomes an argv entry -
// same discipline tts.js uses for why text never touches the command line.
//
// MediaSampler differs from gpu.js's GpuSampler in one way: GpuSampler is a
// passive getter stamped onto telemetry's own tick (nothing else polls the
// GPU independently), but Media Deck has no host tick to ride on, so it owns
// its own push via an onUpdate callback - same shape as UsageWatcher/
// TelemetryWatcher - fired only when the reading actually changed (cheap
// JSON-string compare), so "still playing the same song" doesn't spam IPC
// every tick given a shell spawn here is 100-300ms+, per gpu.js's own note.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

const NOW_PLAYING_SCRIPT = path.join(__dirname, '..', 'helpers', 'media', 'now-playing.ps1');
const VOLUME_SCRIPT = path.join(__dirname, '..', 'helpers', 'media', 'volume.ps1');

const SAMPLE_MS = 2000;
// Generous on purpose: on a loaded laptop a bare `powershell.exe` start alone
// was measured at 5-8 s (endpoint security scanning the spawn), and volume.ps1
// adds its C# interop load on top. The old 8 s cap killed the mute toggle
// there before it could answer, which surfaced as a click that did nothing.
const COMMAND_TIMEOUT_MS = 30000;
const ERROR_DETAIL_MAX = 300;

/**
 * Runs a command and resolves {stdout, error}. `error` is null on success,
 * otherwise a short human-readable reason (timeout, exit code + stderr).
 * Never rejects.
 */
function runDetailed(cmd, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      if (!err) return resolve({ stdout: out, error: null });
      const detail = String((stderr && String(stderr).trim()) || err.message || '').slice(0, ERROR_DETAIL_MAX);
      const reason = err.killed ? `timed out after ${timeout} ms` : `exit ${err.code}: ${detail}`;
      return resolve({ stdout: out, error: reason });
    });
  });
}

/** Runs a command and resolves with stdout; resolves '' on failure/timeout. */
async function run(cmd, args, timeout = COMMAND_TIMEOUT_MS) {
  const { stdout, error } = await runDetailed(cmd, args, timeout);
  return error ? '' : stdout;
}

function runNowPlaying(action) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    NOW_PLAYING_SCRIPT,
    '-Action',
    action,
  ]);
}

/** Runs volume.ps1; resolves {stdout, error} (see runDetailed). */
function runVolume(action, level) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    VOLUME_SCRIPT,
    '-Action',
    action,
  ];
  if (typeof level === 'number') args.push('-Level', String(level));
  return runDetailed('powershell.exe', args);
}

/**
 * Parses now-playing.ps1's `get` stdout into {title, artist, appId, isPlaying}
 * or null. Null covers every "nothing to show" case alike (no session,
 * malformed output) - same one-shape-for-unknown rule gpu.js's parseGpu uses.
 * @param {string} stdout
 * @returns {{title:string, artist:string, appId:string, isPlaying:boolean}|null}
 */
function parseNowPlaying(stdout) {
  if (!stdout || !stdout.trim()) return null;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  return {
    title: typeof data.title === 'string' ? data.title : '',
    artist: typeof data.artist === 'string' ? data.artist : '',
    appId: typeof data.appId === 'string' ? data.appId : '',
    isPlaying: data.isPlaying === true,
  };
}

/**
 * Extracts the last JSON object line from a script's stdout. Tolerates a BOM,
 * CRLF line endings and stray lines around the payload (PowerShell warnings,
 * progress text) - a whole-stdout JSON.parse failed on any such noise.
 * @param {string} stdout
 * @returns {object|null}
 */
function lastJsonObject(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const data = JSON.parse(line);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
      // Not the payload line - keep scanning upward.
    }
  }
  return null;
}

/**
 * Parses volume.ps1's stdout into {level, muted} or null.
 * @param {string} stdout
 * @returns {{level:number, muted:boolean}|null}
 */
function parseVolume(stdout) {
  const data = lastJsonObject(stdout);
  if (!data) return null;
  const level = typeof data.level === 'number' && Number.isFinite(data.level) ? data.level : null;
  if (level === null) return null;
  return { level: Math.max(0, Math.min(100, Math.round(level))), muted: data.muted === true };
}

/**
 * Extracts the {"error": "..."} message volume.ps1 prints on failure.
 * @param {string} stdout
 * @returns {string|null}
 */
function parseVolumeError(stdout) {
  const data = lastJsonObject(stdout);
  if (!data || typeof data.error !== 'string' || !data.error.trim()) return null;
  return data.error.trim().slice(0, ERROR_DETAIL_MAX);
}

/** One-shot now-playing sample. Resolves null off Windows or with no session. */
async function sampleMedia() {
  if (!IS_WINDOWS) return null;
  return parseNowPlaying(await runNowPlaying('get'));
}

/**
 * Fires one of the five GSMTC transport commands against the current session.
 * @param {'play'|'pause'|'toggle'|'next'|'prev'} action
 * @returns {Promise<boolean>}
 */
async function sendTransportCommand(action) {
  if (!IS_WINDOWS) return false;
  if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(action)) return false;
  const out = await runNowPlaying(action);
  if (!out || !out.trim()) return false;
  try {
    return JSON.parse(out).ok === true;
  } catch {
    return false;
  }
}

/**
 * Test seam shared by the volume calls: `runner(action, level)` resolves
 * {stdout, error} like runVolume, `isWindows` overrides the platform check,
 * `log(message)` receives failure reports.
 * @typedef {{runner?:Function, isWindows?:boolean, log?:Function}} VolumeDeps
 */

function defaultLog(message) {
  console.warn(`[media] ${message}`);
}

/**
 * Runs one volume.ps1 action and parses its state. Every failure - timeout,
 * non-zero exit, script-reported error, unparseable output - is logged with
 * its reason and resolves null; the IPC contract (state or null) is unchanged.
 * @param {'get'|'set'|'mute'} action
 * @param {number|undefined} level
 * @param {VolumeDeps} [deps]
 * @returns {Promise<{level:number, muted:boolean}|null>}
 */
async function volumeCommand(action, level, deps = {}) {
  const { runner = runVolume, isWindows = IS_WINDOWS, log = defaultLog } = deps;
  if (!isWindows) return null;
  let result;
  try {
    result = await runner(action, level);
  } catch (err) {
    result = { stdout: '', error: (err && err.message) || String(err) };
  }
  const stdout = result && typeof result.stdout === 'string' ? result.stdout : '';
  const state = parseVolume(stdout);
  if (state) return state;
  const reason =
    parseVolumeError(stdout) ||
    (result && result.error) ||
    `unparseable output: ${JSON.stringify(stdout.slice(0, 120))}`;
  log(`volume '${action}' failed: ${reason}`);
  return null;
}

/**
 * Reads the system master volume/mute state. Resolves null off Windows or on failure.
 * @param {VolumeDeps} [deps]
 */
async function getVolume(deps) {
  return volumeCommand('get', undefined, deps);
}

/**
 * Sets the system master volume. `percent` is clamped to an integer 0-100
 * before it ever becomes an argv entry.
 * @param {number} percent
 * @param {VolumeDeps} [deps]
 * @returns {Promise<{level:number, muted:boolean}|null>}
 */
async function setVolume(percent, deps) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return volumeCommand('set', clamped, deps);
}

let pendingToggle = null;

/**
 * Toggles system mute. Resolves null off Windows or on failure. The toggle is
 * a read-then-set inside volume.ps1, so two overlapping runs (a second click
 * while a slow first one is still in flight) would cancel each other out;
 * concurrent callers share the one in-flight toggle instead.
 * @param {VolumeDeps} [deps]
 * @returns {Promise<{level:number, muted:boolean}|null>}
 */
function toggleMute(deps) {
  if (pendingToggle) return pendingToggle;
  pendingToggle = volumeCommand('mute', undefined, deps).finally(() => {
    pendingToggle = null;
  });
  return pendingToggle;
}

/**
 * Polls now-playing on its own timer and pushes to `onUpdate` only when the
 * reading changed (cheap JSON-string compare) - unlike GpuSampler (a passive
 * getter stamped onto telemetry's tick), this owns its own push since Media
 * Deck has no host tick to ride on.
 */
class MediaSampler {
  constructor(intervalMs = SAMPLE_MS, onUpdate = null) {
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.latest = null;
    this.latestKey = '';
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const sample = await sampleMedia();
      const key = JSON.stringify(sample);
      if (key !== this.latestKey) {
        this.latestKey = key;
        this.latest = sample;
        if (this.onUpdate) this.onUpdate(sample);
      }
    } finally {
      this.busy = false;
    }
  }

  current() {
    return this.latest;
  }
}

module.exports = {
  sampleMedia,
  parseNowPlaying,
  parseVolume,
  parseVolumeError,
  MediaSampler,
  sendTransportCommand,
  getVolume,
  setVolume,
  toggleMute,
  IS_WINDOWS,
};
