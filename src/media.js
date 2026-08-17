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
const COMMAND_TIMEOUT_MS = 8000;

/** Runs a command and resolves with stdout; resolves '' on failure/timeout. */
function run(cmd, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout }, (err, stdout) =>
      resolve(err ? '' : stdout)
    );
  });
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
  return run('powershell.exe', args);
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
 * Parses volume.ps1's stdout into {level, muted} or null.
 * @param {string} stdout
 * @returns {{level:number, muted:boolean}|null}
 */
function parseVolume(stdout) {
  if (!stdout || !stdout.trim()) return null;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const level = data && typeof data.level === 'number' && Number.isFinite(data.level) ? data.level : null;
  if (level === null) return null;
  return { level: Math.max(0, Math.min(100, Math.round(level))), muted: data.muted === true };
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

/** Reads the system master volume/mute state. Resolves null off Windows or on failure. */
async function getVolume() {
  if (!IS_WINDOWS) return null;
  return parseVolume(await runVolume('get'));
}

/**
 * Sets the system master volume. `percent` is clamped to an integer 0-100
 * before it ever becomes an argv entry.
 * @param {number} percent
 * @returns {Promise<{level:number, muted:boolean}|null>}
 */
async function setVolume(percent) {
  if (!IS_WINDOWS) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return parseVolume(await runVolume('set', clamped));
}

/** Toggles system mute. Resolves null off Windows or on failure. */
async function toggleMute() {
  if (!IS_WINDOWS) return null;
  return parseVolume(await runVolume('mute'));
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
  MediaSampler,
  sendTransportCommand,
  getVolume,
  setVolume,
  toggleMute,
  IS_WINDOWS,
};
