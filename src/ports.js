// ============================================================================
// LunaCore - Tracker portow localhost (Faza 7B / backlog)
// ----------------------------------------------------------------------------
// Pasywny podglad nasluchujacych portow na maszynie (dev serwery itp.):
//   * scanPorts()   - jednorazowy skan -> lista { port, procId, name }.
//   * PortWatcher   - cykliczny skan z callbackiem (jak TranscriptWatcher).
//   * killProcess() - ubija proces po PID (akcja na wyrazne zadanie usera).
//
// W duchu Passive Observera: tylko czyta stan systemu (Get-NetTCPConnection /
// lsof). Zero tokenow, nic nie idzie do modelu.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// Adresy uznawane za "localhost / dostepne lokalnie".
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);

// PowerShell: nasluchujace porty TCP + nazwa procesu, jako JSON.
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$c = Get-NetTCPConnection -State Listen
$out = foreach ($x in $c) {
  $p = Get-Process -Id $x.OwningProcess
  [pscustomobject]@{ port=[int]$x.LocalPort; procId=[int]$x.OwningProcess; name=$p.ProcessName; addr=$x.LocalAddress }
}
$out | ConvertTo-Json -Compress
`;

/** Uruchamia komende i zwraca stdout (Promise). Odrzuca cicho na blad. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

/** Parsuje wynik PowerShell (obiekt lub tablica) na znormalizowana liste. */
function parseWindows(stdout) {
  if (!stdout.trim()) return [];
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  // ConvertTo-Json zwraca pojedynczy obiekt dla 1 elementu - ujednolic do tablicy.
  const rows = Array.isArray(data) ? data : [data];
  return dedupeByPort(
    rows
      .filter((r) => r && LOCAL_ADDRS.has(String(r.addr)))
      .map((r) => ({ port: r.port | 0, procId: r.procId | 0, name: r.name || '?' }))
  );
}

/** Parsuje `lsof` (macOS/Linux) na znormalizowana liste. */
function parsePosix(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    // Format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || parts[0] === 'COMMAND') continue;
    const name = parts[0];
    const procId = parts[1] | 0;
    const addr = parts[8]; // np. 127.0.0.1:3000 lub *:8080
    const m = addr.match(/:(\d+)$/);
    if (!m) continue;
    rows.push({ port: m[1] | 0, procId, name });
  }
  return dedupeByPort(rows);
}

/** Usuwa duplikaty portow (ten sam port na kilku interfejsach) i sortuje. */
function dedupeByPort(rows) {
  const byPort = new Map();
  for (const r of rows) {
    if (r.port > 0 && !byPort.has(r.port)) byPort.set(r.port, r);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Jednorazowy skan nasluchujacych portow localhost. */
async function scanPorts() {
  if (IS_WINDOWS) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
    return parseWindows(out);
  }
  // macOS / Linux: lsof nasluchujacych gniazd TCP.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return parsePosix(out);
}

/** Ubija proces po PID. Zwraca Promise<boolean> (czy sie udalo). */
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
 * Cyklicznie skanuje porty i emituje liste, gdy sie zmieni.
 * Emisja tylko przy realnej zmianie (mniej ruchu w IPC/DOM).
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
    this.tick(); // pierwszy skan od razu
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return; // nie nakladaj skanow, jesli poprzedni trwa
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

  /** Wymusza natychmiastowy skan (np. po zabiciu procesu). */
  refresh() {
    this.lastJson = ''; // wymus emisje przy nastepnym skanie
    this.tick();
  }
}

// Parsery sa czyste (string -> lista) - eksport na potrzeby testow. Sam skan
// (scanPorts) odpala procesy systemowe, wiec testujemy wylacznie parsowanie.
module.exports = { scanPorts, killProcess, PortWatcher, parseWindows, parsePosix, dedupeByPort };
