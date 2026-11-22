// ============================================================================
// LunaCore - the OS processes under each tab (read-only, zero tokens)
// ----------------------------------------------------------------------------
// One snapshot: for every live session, the processes that descend from its
// PTY's shell (the agent CLI, its test runners, dev servers, ...), each with
// the localhost ports it listens on (src/ports.js, matched by process id):
//
//   { [sessionId]: [{ pid, ppid, name, label, ports: [3000, ...] }] }
//
// How: one process list per snapshot - Get-CimInstance Win32_Process on
// Windows, `ps` elsewhere - run with execFile, never through a shell, with a
// fixed argument list (no value from the renderer or a session ever reaches
// it). Command lines can hold tokens and passwords, so they never leave this
// module: `label` is src/tooldetail.js' commandSummary() of it (binary and
// plain arguments, secrets scrubbed, at most 80 characters) and `name` is a
// sanitized executable name.
//
// Bounded: at most MAX_SESSIONS roots, MAX_PROCS_PER_SESSION processes per
// root, MAX_DEPTH levels below it, MAX_PORTS_PER_PROC ports per process. A
// process id the OS reused can make the parent links loop; each process is
// visited once.
// Polling (only while a view is open) lives in src/sessionProcsIpc.js.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { scanPorts } = require('./ports');
const { commandSummary, safeLabel } = require('./tooldetail');

/**
 * The WMI process query took 12-15 s on a loaded machine (measured
 * 2026-11-22 while the full test suite ran); a 10 s limit killed it.
 */
const RUN_TIMEOUT_MS = 30000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_SESSIONS = 64;
const MAX_PROCS_PER_SESSION = 64;
const MAX_DEPTH = 12;
const MAX_PORTS_PER_PROC = 16;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PID = 0x7fffffff;

/** Every process with its parent, name and command line, as JSON. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
].join('; ');
// Absolute paths: a bare name is looked up on PATH (and on Windows in the
// working directory first), where another program could stand in.
const WINDOWS_POWERSHELL = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const WINDOWS_COMMAND = Object.freeze({ cmd: WINDOWS_POWERSHELL, args: Object.freeze(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]) });
const POSIX_COMMAND = Object.freeze({ cmd: '/bin/ps', args: Object.freeze(['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']) });

const isPid = (n) => Number.isInteger(n) && n > 0 && n <= MAX_PID;

/**
 * Runs a fixed command with execFile (no shell) and resolves its stdout.
 * Rejects with the reason when it fails or times out.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function execRunner(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: MAX_BUFFER, timeout: RUN_TIMEOUT_MS, shell: false }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Parses Get-CimInstance's JSON (an object for one process, else an array).
 * @param {string} stdout
 * @returns {{pid:number, ppid:number, name:string, cmd:string}[]}
 * @throws {Error} when the output is not that JSON
 */
function parseWindowsProcesses(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('process list is not JSON');
  }
  const rows = Array.isArray(data) ? data : [data];
  return rows
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: typeof r.Name === 'string' ? r.Name : '',
      cmd: typeof r.CommandLine === 'string' ? r.CommandLine : '',
    }))
    .filter((r) => isPid(r.pid) && Number.isInteger(r.ppid));
}

/**
 * Parses `ps -o pid= -o ppid= -o args=` lines.
 * @param {string} stdout
 * @returns {{pid:number, ppid:number, name:string, cmd:string}[]}
 */
function parsePosixProcesses(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3].trim();
    const first = cmd.split(/\s+/)[0] || '';
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: first.split('/').pop() || '', cmd });
  }
  return rows.filter((r) => isPid(r.pid));
}

/**
 * Every process on this machine.
 * @param {(cmd: string, args: string[]) => Promise<string>} runner
 * @param {string} platform
 */
async function listProcesses(runner, platform) {
  if (platform === 'win32') {
    return parseWindowsProcesses(await runner(WINDOWS_COMMAND.cmd, [...WINDOWS_COMMAND.args]));
  }
  return parsePosixProcesses(await runner(POSIX_COMMAND.cmd, [...POSIX_COMMAND.args]));
}

/**
 * The processes below `rootPid`, breadth first, bounded in depth and count.
 * @param {{pid:number, ppid:number}[]} rows
 * @param {number} rootPid
 */
function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const visited = new Set([rootPid]);
  let level = [rootPid];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && out.length < MAX_PROCS_PER_SESSION; depth++) {
    const next = [];
    for (const parent of level) {
      for (const child of byParent.get(parent) || []) {
        if (visited.has(child.pid) || out.length >= MAX_PROCS_PER_SESSION) continue;
        visited.add(child.pid);
        out.push(child);
        next.push(child.pid);
      }
    }
    level = next;
  }
  return out;
}

/** procId -> its listening ports, sorted, bounded. */
function portsByPid(portRows) {
  const map = new Map();
  for (const row of Array.isArray(portRows) ? portRows : []) {
    const pid = Number(row && row.procId);
    const port = Number(row && row.port);
    if (!isPid(pid) || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(port);
  }
  return new Map([...map].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b).slice(0, MAX_PORTS_PER_PROC)]));
}

/** One process as the renderer sees it: no raw command line. */
function entryOf(row, ports) {
  const name = safeLabel(row.name.split(/[\\/]/).pop());
  return {
    pid: row.pid,
    ppid: row.ppid,
    name,
    label: commandSummary(row.cmd) || name,
    ports: ports.get(row.pid) || [],
  };
}

/** The {sessionId, pid} roots that validate, at most MAX_SESSIONS. */
function validRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((r) => r && typeof r.sessionId === 'string' && SESSION_ID_RE.test(r.sessionId) && isPid(r.pid))
    .slice(0, MAX_SESSIONS);
}

/**
 * One snapshot of the processes and ports under each session's PTY.
 * Spawns nothing when there is no live session.
 * @param {{sessionId: string, pid: number}[]} roots live sessions and their PTY pids
 * @param {{runner?: (cmd: string, args: string[]) => Promise<string>,
 *   platform?: string, scanPorts?: () => Promise<{port:number, procId:number}[]>}} [deps]
 * @returns {Promise<Record<string, {pid:number, ppid:number, name:string, label:string, ports:number[]}[]>>}
 * @throws {Error} when the process list cannot be read
 */
async function snapshotSessionProcs(roots, { runner = execRunner, platform = process.platform, scanPorts: scan = scanPorts } = {}) {
  const valid = validRoots(roots);
  if (valid.length === 0) return {};
  const [rows, portRows] = await Promise.all([listProcesses(runner, platform), scan()]);
  const ports = portsByPid(portRows);
  return Object.fromEntries(valid.map(({ sessionId, pid }) => [
    sessionId,
    descendantsOf(rows, pid).map((row) => entryOf(row, ports)),
  ]));
}

module.exports = {
  MAX_PROCS_PER_SESSION,
  WINDOWS_COMMAND,
  POSIX_COMMAND,
  parseWindowsProcesses,
  parsePosixProcesses,
  descendantsOf,
  portsByPid,
  snapshotSessionProcs,
};
