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

// B5: processes that listen on a dev machine but are never the thing you are
// looking for. The panel answers "where is my app running" - svchost and its
// friends only bury the answer. Classified HERE (one place, unit-tested) and
// shipped as a flag; whether to hide them stays a renderer-side view decision,
// so the filter is a toggle and never a silent drop.
const SYSTEM_PROCS = new Set([
  // Windows
  'system', 'idle', 'svchost', 'services', 'lsass', 'wininit', 'smss', 'csrss',
  'winlogon', 'spoolsv', 'dashost', 'searchapp', 'searchhost', 'sihost',
  'msmpeng', 'wslservice', 'vmms', 'vmcompute', 'mssense', 'officeclicktorun',
  // macOS / Linux
  'launchd', 'systemd', 'systemd-resolve', 'systemd-resolved', 'rapportd',
  'controlce', 'controlcenter', 'sshd', 'cupsd', 'mdnsresponder',
  'avahi-daemon', 'rpcbind', 'rpc.statd', 'dnsmasq',
]);

// Ports that belong to the user even when the range rule below says otherwise -
// a local nginx/Caddy/Docker on 80 or 443 is exactly what you want to see.
const DEV_PORTS = new Set([
  80, 443, 3000, 3001, 4000, 4200, 5000, 5173, 5174, 5432, 6379, 7860,
  8000, 8080, 8081, 8888, 9000, 11434,
]);

/**
 * B5: is this row OS noise rather than something the user started?
 *
 * Three signals, cheapest first: a known system process name, the privileged
 * range below 1024 (binding it needs admin, so on a dev box it is the OS), and
 * the dynamic/ephemeral range from 49152 up, which on Windows is almost all
 * RPC. DEV_PORTS wins over both ranges - a heuristic that hides your own web
 * server is worse than no heuristic at all.
 *
 * @param {{port:number, name?:string}} row
 * @returns {boolean}
 */
function isSystemPort(row) {
  if (!row) return false;
  const port = row.port | 0;
  if (DEV_PORTS.has(port)) return false;
  if (SYSTEM_PROCS.has(String(row.name || '').toLowerCase())) return true;
  return port < 1024 || port >= 49152;
}

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

/**
 * One-shot scan of listening localhost ports.
 * Rows carry the B5 `system` flag; the parsers stay untagged so they remain
 * pure text -> rows, and the classification lives in exactly one place.
 */
async function scanPorts() {
  let rows;
  if (IS_WINDOWS) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
    rows = parseWindows(out);
  } else {
    // macOS / Linux: lsof over listening TCP sockets.
    const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    rows = parsePosix(out);
  }
  return rows.map((r) => ({ ...r, system: isSystemPort(r) }));
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
module.exports = {
  scanPorts,
  killProcess,
  PortWatcher,
  parseWindows,
  parsePosix,
  dedupeByPort,
  isSystemPort,
};
