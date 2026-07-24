// ============================================================================
// LunaCore - localhost port tracker (Phase 7B / backlog)
// ----------------------------------------------------------------------------
// Passive view of listening ports on this machine (dev servers etc.):
//   * scanPorts()   - one-shot scan -> list of { port, procId, name }.
//   * PortWatcher   - periodic scan with a callback (like TranscriptWatcher).
//   * killProcess() - kills a process by PID (only on an explicit user action).
//
// In the spirit of the Passive Observer: this only reads system state
// (Get-NetTCPConnection / lsof). Zero tokens, nothing reaches the model.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// Addresses treated as "localhost / locally reachable".
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);

// PowerShell: listening TCP ports plus the owning process name, as JSON.
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$c = Get-NetTCPConnection -State Listen
$out = foreach ($x in $c) {
  $p = Get-Process -Id $x.OwningProcess
  [pscustomobject]@{ port=[int]$x.LocalPort; procId=[int]$x.OwningProcess; name=$p.ProcessName; addr=$x.LocalAddress }
}
$out | ConvertTo-Json -Compress
`;

/** Runs a command and resolves with stdout. Resolves empty on failure. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

/** Parses PowerShell output (object or array) into a normalized list. */
function parseWindows(stdout) {
  if (!stdout.trim()) return [];
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  // ConvertTo-Json emits a bare object for a single element - normalize to array.
  const rows = Array.isArray(data) ? data : [data];
  return dedupeByPort(
    rows
      .filter((r) => r && LOCAL_ADDRS.has(String(r.addr)))
      .map((r) => ({ port: r.port | 0, procId: r.procId | 0, name: r.name || '?' }))
  );
}

/** Parses `lsof` output (macOS/Linux) into a normalized list. */
function parsePosix(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    // Format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || parts[0] === 'COMMAND') continue;
    const name = parts[0];
    const procId = parts[1] | 0;
    const addr = parts[8]; // e.g. 127.0.0.1:3000 or *:8080
    const m = addr.match(/:(\d+)$/);
    if (!m) continue;
    rows.push({ port: m[1] | 0, procId, name });
  }
  return dedupeByPort(rows);
}

/** Drops duplicate ports (same port on several interfaces) and sorts. */
function dedupeByPort(rows) {
  const byPort = new Map();
  for (const r of rows) {
    if (r.port > 0 && !byPort.has(r.port)) byPort.set(r.port, r);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** One-shot scan of listening localhost ports. */
async function scanPorts() {
  if (IS_WINDOWS) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
    return parseWindows(out);
  }
  // macOS / Linux: lsof over listening TCP sockets.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return parsePosix(out);
}

/** Kills a process by PID. Resolves to whether it worked. */
function killProcess(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      execFile('taskkill', ['/PID', String(id), '/F', '/T'], { windowsHide: true }, (err) => {
        resolve(!err);
      });
    } else {
      try {
        process.kill(id, 'SIGKILL');
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

/**
 * Periodically scans ports and emits the list whenever it changes.
 * Emitting only on a real change keeps IPC and DOM churn down.
 */
class PortWatcher {
  /** @param {(ports: Array<{port:number,procId:number,name:string}>) => void} onUpdate */
  constructor(onUpdate, intervalMs = 4000) {
    this.onUpdate = onUpdate;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastJson = '';
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick(); // first scan immediately
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return; // do not overlap scans if the previous one is running
    this.busy = true;
    try {
      const ports = await scanPorts();
      const json = JSON.stringify(ports);
      if (json !== this.lastJson) {
        this.lastJson = json;
        this.onUpdate(ports);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Forces an immediate scan (e.g. right after killing a process). */
  refresh() {
    this.lastJson = ''; // force an emit on the next scan
    this.tick();
  }
}

// The parsers are pure (string -> list) - exported for the tests. The scan
// itself spawns system processes, so only the parsing is unit-tested.
module.exports = { scanPorts, killProcess, PortWatcher, parseWindows, parsePosix, dedupeByPort };
