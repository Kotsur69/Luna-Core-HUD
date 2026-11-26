// ============================================================================
// LunaCore - close Unity editors left open on Luna worktrees
// ----------------------------------------------------------------------------
// God Mode / Luna's Work workers open Unity editors on their git worktrees
// (the scene-worker brief tells them to) and nothing closed them: editors
// stayed for hours, held RAM and locked the folders, so `git worktree remove`
// failed ("Permission denied", "being used by another process").
//
// findEditors lists the Unity.exe processes whose -projectPath is the given
// worktree root or a folder under it. HARD RULE: an editor on the main
// checkout (any protected path, or a folder under / above one) is never
// matched, even if a worktree root were somehow a parent of the checkout.
// A Unity.exe whose parent is another match (AssetImportWorker, shader
// compiler) is left out: the parent's tree kill takes it along.
//
// closeEditors asks each match to quit through its Unity Pipeline port
// (Library/Pipeline/.unity-pipeline-port, when the port file names that pid),
// waits QUIT_WAIT_MS, then stops the process tree (procTree.killTree:
// `taskkill /PID <pid> /T /F`) - only after a fresh process list confirms the
// pid is still that editor, so a reused pid is never killed. Never rejects.
// All I/O is injectable.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const procTree = require('./procTree');
const { createPipelineClient, descriptorFile, pipelineCommandDidNotRun, PIPELINE_ERROR } = require('../helpers/playtest-bridge/pipeline-http');

const QUIT_WAIT_MS = 20 * 1000;
const POLL_MS = 500;
const QUIT_REQUEST_TIMEOUT_MS = 5 * 1000;
const LIST_TIMEOUT_MS = 30 * 1000;
const MAX_DETAIL_CHARS = 300;
const MAX_LIST_BUFFER = 4 * 1024 * 1024;
// How deep under a folder a Unity project (ProjectSettings/ProjectVersion.txt) is looked for.
const DEFAULT_PROJECT_DEPTH = 2;
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Packages', 'Assets']);
const PROJECT_MARKER = Object.freeze(['ProjectSettings', 'ProjectVersion.txt']);
const LIST_SCRIPT =
  "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
// -projectPath <dir>, -projectPath "<dir>" or -projectPath=<dir>, any case.
const PROJECT_PATH_RE = /(?:^|\s)-projectpath(?:\s+|=)(?:"([^"]+)"|(\S+))/gi;
// Quit requests, tried in order. delayCall lets the HTTP reply leave before the editor exits;
// Exit(0) never shows a save dialog. A Pipeline without `script eval` falls back to the menu.
const QUIT_COMMANDS = Object.freeze([
  ['script eval', { code: 'UnityEditor.EditorApplication.delayCall += () => UnityEditor.EditorApplication.Exit(0);\nreturn "exiting";' }],
  ['editor invoke_menu', { path: 'File/Exit' }],
]);

const errText = (err) => String(err instanceof Error ? err.message : err).slice(0, MAX_DETAIL_CHARS);
const isPid = (v) => Number.isInteger(v) && v > 0;
const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const slashes = (p, platform) => (platform === 'win32' ? String(p).replace(/\//g, '\\') : String(p));

/** A folder in comparable form: resolved, separators normalised, no trailing one, case-folded on Windows. */
function pathKey(dir, platform = process.platform) {
  const resolved = pathApi(platform).resolve(slashes(dir, platform)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or a folder under it. */
function isWithin(parent, child, platform = process.platform) {
  const a = pathKey(parent, platform);
  const b = pathKey(child, platform);
  const sep = pathApi(platform).sep;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** Every -projectPath value of a Unity command line (normally one). */
function projectPathsOf(commandLine) {
  return [...String(commandLine || '').matchAll(PROJECT_PATH_RE)].map((m) => (m[1] || m[2] || '').trim()).filter(Boolean);
}

/** The -projectPath of a Unity command line, or null (also null when it names several). */
function projectPathOf(commandLine) {
  const all = projectPathsOf(commandLine);
  return all.length === 1 ? all[0] : null;
}

/** Protected paths as a list (repoPath may be one path or several). */
const protectedList = (repoPath) => (Array.isArray(repoPath) ? repoPath : [repoPath]).filter((p) => typeof p === 'string' && p);

/** Default process list: Unity.exe processes via CIM on Windows, none elsewhere. */
function listUnityProcesses({ platform = process.platform, execImpl = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT];
    execImpl('powershell.exe', args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_LIST_BUFFER }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`listing Unity processes failed: ${errText(String(stderr || '').trim() || err)}`));
      const text = String(stdout || '').trim();
      if (!text) return resolve([]);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return reject(new Error('listing Unity processes gave output that is not JSON'));
      }
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === 'object');
      return resolve(rows.map((r) => ({ pid: r.ProcessId, parentPid: r.ParentProcessId, commandLine: String(r.CommandLine || '') })));
    });
  });
}

/**
 * Unity editors whose project is `worktreeRoot` or a folder under it, never a protected one.
 * @param {string} worktreeRoot
 * @param {{repoPath?:string|string[], listProcesses?:()=>Promise<Array<{pid:number, parentPid?:number, commandLine:string}>>,
 *   platform?:string}} [opts] repoPath: the main checkout (or several protected folders)
 * @returns {Promise<Array<{pid:number, projectPath:string}>>} rejects only when the process list fails
 */
async function findEditors(worktreeRoot, opts = {}) {
  const platform = opts.platform || process.platform;
  const api = pathApi(platform);
  const listProcesses = typeof opts.listProcesses === 'function' ? opts.listProcesses : () => listUnityProcesses({ platform });
  if (typeof worktreeRoot !== 'string' || !api.isAbsolute(slashes(worktreeRoot, platform))) return [];
  const guarded = protectedList(opts.repoPath);
  const rows = await listProcesses();
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !isPid(row.pid)) continue;
    // Several -projectPath values: no telling which one Unity honours, so the editor is left alone.
    const projectPath = projectPathOf(row.commandLine);
    if (!projectPath || !api.isAbsolute(slashes(projectPath, platform))) continue;
    if (!isWithin(worktreeRoot, projectPath, platform)) continue;
    // Never the main checkout: not on it, not under it, not above it.
    if (guarded.some((g) => isWithin(g, projectPath, platform) || isWithin(projectPath, g, platform))) continue;
    matches.push({ pid: row.pid, parentPid: row.parentPid, projectPath });
  }
  const pids = new Set(matches.map((m) => m.pid));
  return matches.filter((m) => !pids.has(m.parentPid)).map(({ pid, projectPath }) => ({ pid, projectPath }));
}

/**
 * Default graceful quit: only when the project's Pipeline port file names this pid.
 * @param {{readFile?:Function, createClient?:Function, fetch?:Function}} [deps]
 * @returns {Promise<{sent:boolean, detail:string}>} never rejects
 */
async function quitViaPipeline(projectPath, pid, deps = {}) {
  const readFile = deps.readFile || ((f) => fs.promises.readFile(f, 'utf8'));
  const createClient = deps.createClient || createPipelineClient;
  let owner;
  try {
    const raw = JSON.parse(String(await readFile(descriptorFile(projectPath))));
    owner = { pid: raw && raw.pid, projectPath: raw && raw.projectPath };
  } catch (err) {
    return { sent: false, detail: err && err.code === 'ENOENT' ? 'no Unity Pipeline port file' : 'unreadable Unity Pipeline port file' };
  }
  if (owner.pid !== pid) return { sent: false, detail: `the Pipeline port file belongs to pid ${String(owner.pid).slice(0, 20)}` };
  // The port file sits in a folder a worker can write: it must name this very project.
  if (typeof owner.projectPath === 'string' && pathKey(owner.projectPath) !== pathKey(projectPath)) {
    return { sent: false, detail: 'the Pipeline port file names another project' };
  }
  let last = null;
  try {
    const clientOpts = { projectDir: projectPath, timeoutMs: QUIT_REQUEST_TIMEOUT_MS, readFile };
    const client = createClient(deps.fetch ? { ...clientOpts, fetch: deps.fetch } : clientOpts);
    for (const [command, parameters] of QUIT_COMMANDS) {
      try {
        await client.exec(command, parameters);
        return { sent: true, detail: command };
      } catch (err) {
        last = err;
        // The editor refused this command (not found, disabled): try the next one.
        if (err && err.code === PIPELINE_ERROR.failed) continue;
        // Timed out or dropped: the quit may have run, the wait tells.
        if (!pipelineCommandDidNotRun(err)) return { sent: true, detail: `${command} (no reply)` };
        break;
      }
    }
  } catch (err) {
    last = err;
  }
  return { sent: false, detail: errText(last || 'no quit command ran') };
}

/** Default liveness probe: signal 0. EPERM still means the process exists. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/** Polls until `pid` is gone or the wait is over; true when it went. */
async function waitForExit(pid, { running, sleep, now, waitMs, pollMs }) {
  const deadline = now() + waitMs;
  for (;;) {
    if (!(await running(pid))) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** One editor: graceful quit, wait, then (pid confirmed) tree kill. Never rejects. */
async function closeOne({ pid, projectPath }, ctx) {
  const done = (how) => ({ ok: true, pid, projectPath, how });
  const fail = (detail) => ({ ok: false, pid, projectPath, detail: errText(detail) });
  try {
    const quit = await ctx.quit(projectPath, pid);
    if (quit && quit.sent && (await waitForExit(pid, ctx))) return done('quit');
    if (!(await ctx.running(pid))) return done('quit');
    // Re-check that the pid is still this editor before anything is killed.
    // Not listed any more: this editor is gone (a live pid was reused by another process - never killed).
    const still = await ctx.find();
    if (!still.some((e) => e.pid === pid)) return done('quit');
    const killed = await ctx.kill(pid);
    if ((killed && killed.ok) || !(await ctx.running(pid))) return done('killed');
    return fail(`taskkill failed: ${(killed && (killed.reason || killed.detail)) || 'failed'}`);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Closes every Unity editor on `worktreeRoot` (see the header). Never rejects.
 * @param {string} worktreeRoot
 * @param {{repoPath?:string|string[], listProcesses?:Function,
 *   quitViaPipeline?:(projectPath:string, pid:number)=>Promise<{sent:boolean}>,
 *   killTree?:(pid:number)=>Promise<{ok:boolean, reason?:string}>, isRunning?:(pid:number)=>boolean|Promise<boolean>,
 *   sleep?:(ms:number)=>Promise<void>, now?:()=>number, skip?:(projectPath:string)=>boolean, platform?:string,
 *   waitMs?:number, pollMs?:number}} [opts] skip: an editor to leave open (e.g. a worktree with an open tab)
 * @returns {Promise<{closed:Array<{pid:number, projectPath:string, how:'quit'|'killed'}>,
 *   failed:Array<{pid:number|null, projectPath:string|null, detail:string}>}>}
 */
async function closeEditors(worktreeRoot, opts = {}) {
  const out = { closed: [], failed: [] };
  const findOpts = { repoPath: opts.repoPath, listProcesses: opts.listProcesses, platform: opts.platform };
  let editors;
  try {
    editors = await findEditors(worktreeRoot, findOpts);
  } catch (err) {
    out.failed.push({ pid: null, projectPath: null, detail: errText(err) });
    return out;
  }
  const skip = typeof opts.skip === 'function' ? opts.skip : () => false;
  const ctx = {
    find: () => findEditors(worktreeRoot, findOpts),
    quit: opts.quitViaPipeline || ((projectPath, pid) => quitViaPipeline(projectPath, pid)),
    kill: opts.killTree || ((pid) => procTree.killTree(pid)),
    running: opts.isRunning || isRunning,
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now || Date.now,
    waitMs: Number.isFinite(opts.waitMs) ? opts.waitMs : QUIT_WAIT_MS,
    pollMs: Number.isFinite(opts.pollMs) ? opts.pollMs : POLL_MS,
  };
  const results = await Promise.all(editors.filter((e) => !skip(e.projectPath)).map((e) => closeOne(e, ctx)));
  for (const r of results) {
    if (r.ok) out.closed.push({ pid: r.pid, projectPath: r.projectPath, how: r.how });
    else out.failed.push({ pid: r.pid, projectPath: r.projectPath, detail: r.detail });
  }
  return out;
}

/** True when `dir` holds a Unity project (ProjectSettings/ProjectVersion.txt) at most `maxDepth` folders down. */
function hasUnityProject(dir, { maxDepth = DEFAULT_PROJECT_DEPTH, fsImpl = fs } = {}) {
  const walk = (d, depth) => {
    if (fsImpl.existsSync(path.join(d, ...PROJECT_MARKER))) return true;
    if (depth >= maxDepth) return false;
    let entries;
    try {
      entries = fsImpl.readdirSync(d, { withFileTypes: true });
    } catch {
      return false; // a folder that cannot be read holds no project we could see
    }
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && walk(path.join(d, e.name), depth + 1));
  };
  return typeof dir === 'string' && walk(dir, 0);
}

/**
 * The production wiring: closeEditors only on Windows and only when the folder
 * holds a Unity project, so a non-Unity removal never starts PowerShell.
 * @param {string} worktreeRoot
 * @param {object} [opts] closeEditors options, plus maxDepth for the project search
 */
function closeEditorsIfUnity(worktreeRoot, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' || !hasUnityProject(worktreeRoot, { maxDepth: opts.maxDepth })) {
    return Promise.resolve({ closed: [], failed: [] });
  }
  return closeEditors(worktreeRoot, opts);
}

module.exports = {
  QUIT_WAIT_MS,
  POLL_MS,
  QUIT_COMMANDS,
  pathKey,
  isWithin,
  projectPathOf,
  listUnityProcesses,
  findEditors,
  quitViaPipeline,
  isRunning,
  closeEditors,
  hasUnityProject,
  closeEditorsIfUnity,
};
