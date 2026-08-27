// ============================================================================
// LunaCore - Sound Manager (mpv audio engine)
// ----------------------------------------------------------------------------
// Owns ONE persistent `mpv --idle` process, controlled over its JSON IPC pipe.
// Every play() call sends a `loadfile` command down that pipe - no per-event
// process spawn. A key-click sound fired at typing speed (10-20/sec) would
// spawn 10-20 OS processes per second; one process absorbs mpv's ~50-150ms
// startup cost once at app boot, and every trigger after that is a
// sub-millisecond local IPC write. See SOUNDS_IMPLEMENTATION_PLAN.md §2.
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

// `channel` distinguishes multiple SoundManager instances in the same process
// (§11.2 runs SFX and narration on separate mpv processes so a keystroke tick
// can't cut off a multi-sentence readout) - same pid, different pipe.
function ipcPath(channel) {
  const tag = channel ? `-${channel}` : '';
  return IS_WINDOWS
    ? `\\\\.\\pipe\\lunacore-mpv-${process.pid}${tag}`
    : path.join(os.tmpdir(), `lunacore-mpv-${process.pid}${tag}.sock`);
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
  /** @param {{volume?: number, channel?: string, onBusyChange?: (busy: boolean) => void}} [opts]
   *   volume: 0..100, default 70; channel: pipe-name suffix so a second
   *   instance (§11.2 narration) doesn't collide with the default SFX
   *   instance; onBusyChange: called with true when playback starts and
   *   false when this instance goes fully idle again (voice ducking rides
   *   this - see src/voiceduck.js). Omitted on the SFX instance, so it
   *   never bothers reading mpv's event stream. */
  constructor(opts = {}) {
    this.volume = clampVolume(opts.volume);
    this.enabled = true; // user toggle (Preferences); wired from uiprefs by main.js
    this.available = false; // becomes true once mpv --idle is confirmed alive
    this.proc = null;
    this.sock = null;
    this.warned = false;
    this.pending = []; // commands queued while the IPC socket is still connecting
    this.ipcPath = ipcPath(opts.channel);
    // Playback-busy tracking, only when a listener asked for it. mpv emits
    // one start-file and one end-file per loaded file over the same IPC
    // socket; counting the pair tells us when the channel goes from silent
    // to playing and back. `_evtBuf` reassembles newline-delimited JSON
    // that a socket read can split mid-line.
    this.onBusyChange = typeof opts.onBusyChange === 'function' ? opts.onBusyChange : null;
    this.activeFiles = 0;
    this.busy = false;
    this._evtBuf = '';
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
        // Without this, mpv fully unloads (tears down the audio device) the
        // instant a clip finishes - and a keystroke click is often <50ms, so
        // the NEXT loadfile has to cold-start WASAPI from scratch before any
        // sample reaches the speaker. That cold-start latency alone can
        // exceed the clip's own duration, so most rapid-fire SFX never
        // actually become audible. keep-open pauses on the last frame
        // instead, keeping the audio device warm between triggers.
        '--keep-open=yes',
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
    if (this.onBusyChange) {
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => this._readEvents(chunk));
    }
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
   * Feeds a raw socket chunk through the newline-delimited-JSON reassembler
   * and acts on mpv's start-file / end-file events. Anything else (property
   * changes, command replies, malformed lines) is ignored.
   */
  _readEvents(chunk) {
    this._evtBuf += chunk;
    const lines = this._evtBuf.split('\n');
    this._evtBuf = lines.pop() || ''; // keep the trailing partial line
    for (const line of lines) {
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === 'start-file') this._setActive(this.activeFiles + 1);
      else if (msg.event === 'end-file') this._setActive(this.activeFiles - 1);
    }
  }

  /** Updates the in-flight-file count and fires onBusyChange on a 0<->1+ edge. */
  _setActive(n) {
    this.activeFiles = Math.max(0, n);
    const busy = this.activeFiles > 0;
    if (busy === this.busy) return;
    this.busy = busy;
    try {
      this.onBusyChange(busy);
    } catch {
      /* a listener throwing must not take the audio channel down */
    }
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
    this._evtBuf = '';
    // Release a duck that was holding for a clip we're about to kill.
    if (this.busy) this._setActive(0);
  }
}

module.exports = { SoundManager };
