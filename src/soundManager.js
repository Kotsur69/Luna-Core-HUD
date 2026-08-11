// ============================================================================
// LunaCore - Sound Manager (mpv audio engine)
// ----------------------------------------------------------------------------
// Owns ONE persistent `mpv --idle` process, controlled over its JSON IPC pipe.
// Every play() call sends a `loadfile` command down that pipe - no per-event
// process spawn. A key-click sound fired at typing speed (10-20/sec) would
// spawn 10-20 OS processes per second; one process absorbs mpv's ~50-150ms
// startup cost once at app boot, and every trigger after that is a
// sub-millisecond local IPC write. See SOUNDS_IMPLEMENTATION_PLAN.md §1.
//
// Fails silent + loud-once: if mpv is not on PATH, start() logs ONE warning
// and every play() call becomes a no-op. The HUD must never crash or block
// because a sound file is missing or mpv isn't installed - same
// degrade-gracefully rule usage.js follows for a dead network.
//
// Not unit-tested (thin OS-process wrapper, same as PortWatcher/UsageWatcher
// aren't) - verify manually via `npx electron . --enable-logging`, with mpv
// installed and with it removed from PATH, confirming both paths.
// ============================================================================

'use strict';

const { spawn, execSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WINDOWS = process.platform === 'win32';

// How long to wait after spawning mpv before the first IPC connect attempt -
// mpv needs a moment to create the pipe/socket. Windows: named pipe (no
// filesystem entry). POSIX: unix socket path in tmpdir.
const CONNECT_DELAY_MS = 400;
const MAX_CONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 300;

function ipcPath() {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\lunacore-mpv-${process.pid}`
    : path.join(os.tmpdir(), `lunacore-mpv-${process.pid}.sock`);
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
}

/** Finds mpv on PATH, or at a user-configured override. Throws if absent. */
function resolveMpv() {
  const override = process.env.LUNACORE_MPV_PATH;
  if (override && fs.existsSync(override)) return override;
  // `spawn` on Windows needs the .exe resolved by the shell, so probe with
  // `where`/`command -v` rather than trusting a bare name would resolve.
  const probe = IS_WINDOWS ? 'where mpv' : 'command -v mpv';
  try {
    const out = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    /* not found */
  }
  throw new Error('mpv not found');
}

class SoundManager {
  /** @param {{volume?: number}} [opts] volume: 0..100, default 70 */
  constructor(opts = {}) {
    this.volume = clampVolume(opts.volume);
    this.enabled = true; // user toggle (Preferences); wired from uiprefs by main.js
    this.available = false; // becomes true once mpv --idle is confirmed alive
    this.proc = null;
    this.sock = null;
    this.warned = false;
    this.pending = []; // commands queued while the IPC socket is still connecting
    this.ipcPath = ipcPath();
  }

  /** Spawns `mpv --idle` and opens the IPC socket. Call once at app startup. */
  start() {
    let mpvPath;
    try {
      mpvPath = resolveMpv();
    } catch {
      this._warnOnce('mpv not found on PATH - sound feedback disabled (silent fallback)');
      return;
    }

    this.proc = spawn(
      mpvPath,
      [
        '--idle=yes',
        '--no-video',
        '--no-terminal',
        '--no-config',
        `--input-ipc-server=${this.ipcPath}`,
        `--volume=${this.volume}`,
      ],
      { stdio: 'ignore' },
    );

    this.proc.on('error', () => this._warnOnce('mpv failed to start - sound feedback disabled'));
    this.proc.on('exit', () => {
      this.available = false;
      this.sock = null;
    });

    setTimeout(() => this._connect(), CONNECT_DELAY_MS);
  }

  _connect(attempt = 0) {
    const sock = net.createConnection(this.ipcPath);
    sock.on('connect', () => {
      this.sock = sock;
      this.available = true;
      for (const cmd of this.pending.splice(0)) this._send(cmd);
    });
    sock.on('error', () => {
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        setTimeout(() => this._connect(attempt + 1), RECONNECT_DELAY_MS);
      } else {
        this._warnOnce('could not reach mpv IPC socket - sound feedback disabled');
      }
    });
  }

  _send(commandObj) {
    if (!this.sock) {
      this.pending.push(commandObj);
      return;
    }
    try {
      this.sock.write(JSON.stringify(commandObj) + '\n');
    } catch {
      /* pipe closed mid-write - next play() call will re-warn if still dead */
    }
  }

  _warnOnce(msg) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[soundManager] ${msg}`);
  }

  /**
   * Plays a resolved absolute file path. `replace` (default) cuts off whatever
   * is currently playing - correct for short UI blips; pass `append-play` for
   * voice lines that should queue instead of clipping each other.
   * @param {string} filePath
   * @param {{mode?: 'replace'|'append-play'}} [opts]
   */
  play(filePath, { mode = 'replace' } = {}) {
    if (!this.enabled || !this.available || !fs.existsSync(filePath)) return;
    this._send({ command: ['loadfile', filePath, mode] });
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  setVolume(vol) {
    this.volume = clampVolume(vol);
    this._send({ command: ['set_property', 'volume', this.volume] });
  }

  stop() {
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        /* already dead */
      }
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already dead */
      }
    }
    this.proc = null;
    this.sock = null;
    this.available = false;
  }
}

module.exports = { SoundManager };
