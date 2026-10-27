// ============================================================================
// LunaCore - Luna's Work tester adapters (docs/LUNAS_WORK_PLAN.md, slice 1.3a)
// ----------------------------------------------------------------------------
// One interface per adapter (plan: "Tester adapters"):
//
//   start(profile) -> Promise<{url}|{handle}>  launch the app under test
//   tools()        -> the ONLY tools the Playtester may use
//   stop()         -> Promise<boolean>         tear it all down (idempotent)
//   evidenceDir    -> <userDir>/runs/lunaswork-<runId>/iter-<N>/
//
// Only `web` exists. It spawns the profile's startCommand in the project dir,
// logs stdout/stderr to server.log in the evidence dir, polls the profile url
// until it answers 2xx/3xx, and kills the whole process tree on stop. With a
// stagingUrl in the profile (LW 3.28a) nothing is launched: the iteration was
// deployed to staging (src/lunasworkStaging.js), so start() only waits for
// stagingUrl and the Playtester tests that.
//
// TRUST BOUNDARY: the command comes ONLY from the profile, which only ever
// comes from lunasworkSettings (LunaCore's local file). start() re-validates it
// and reads nothing from the project repo or from model output. Do not add a
// parameter that lets a caller pass a command in some other way.
//
// spawn / fetch / clock / kill are injected so the tests run without a server.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const paths = require('./paths');
const { ADAPTERS, RESERVED_ADAPTERS, validateProfile } = require('./lunasworkSettings');

const RUNS_DIR = 'runs';
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_ITERATION = 10000;
const POLL_INTERVAL_MS = 500;
const POLL_REQUEST_TIMEOUT_MS = 3000;
const SERVER_LOG = 'server.log';

// Playwright MCP, run by the Playtester's headless `claude -p`. Screenshots and
// console dumps land in the evidence dir via --output-dir.
const PLAYWRIGHT_SERVER = 'playwright';
const PLAYWRIGHT_PACKAGE = '@playwright/mcp@latest';
// The Playtester's allow-list. Deliberately missing: browser_evaluate /
// browser_run_code (arbitrary JS), browser_file_upload (reads local files),
// browser_install (downloads binaries).
const PLAYWRIGHT_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_resize',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_close',
];

// ---- evidence dir -------------------------------------------------------------------

const defaultRunsRoot = () => path.join(paths.userDir(), RUNS_DIR);

/**
 * The evidence folder for one iteration. Built only from a validated runId and
 * iteration, then checked to sit inside runsRoot - nothing can escape it.
 * @param {string} runsRoot absolute path of config/runs
 * @param {unknown} runId
 * @param {unknown} iteration
 * @returns {string}
 */
function evidenceDirFor(runsRoot, runId, iteration) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error('runId must be 1-40 lowercase letters or digits');
  }
  if (!Number.isInteger(iteration) || iteration < 1 || iteration > MAX_ITERATION) {
    throw new Error(`iteration must be a whole number from 1 to ${MAX_ITERATION}`);
  }
  const root = path.resolve(runsRoot);
  const dir = path.resolve(root, `lunaswork-${runId}`, `iter-${iteration}`);
  if (!dir.startsWith(root + path.sep)) throw new Error('evidence dir escapes the runs folder');
  return dir;
}

// ---- process tree -------------------------------------------------------------------

/**
 * Kills a process and everything it started. Windows: taskkill /T /F. POSIX:
 * the child was spawned detached, so it leads its own group - kill -pid.
 * @returns {Promise<boolean>}
 */
function killTree(pid, { platform, execFile, kill }) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
      return;
    }
    try {
      kill(-pid, 'SIGKILL');
      resolve(true);
    } catch {
      // No group (already gone, or not a leader) - try the single process.
      try {
        kill(pid, 'SIGKILL');
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

// ---- web adapter --------------------------------------------------------------------

/** HTTP 2xx/3xx counts as ready; redirects are not followed. */
async function answersReady(fetchFn, url) {
  try {
    const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS) });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

function openLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.createWriteStream(path.join(dir, SERVER_LOG), { flags: 'a' });
}

/**
 * @param {{projectDir:string, evidenceDir:string, spawn:Function, fetch:Function,
 *   now:()=>number, sleep:(ms:number)=>Promise<void>, platform:string,
 *   execFile:Function, kill:Function}} ctx
 */
function createWebAdapter(ctx) {
  let child = null;
  let log = null;
  let exit = null; // {code, signal} once the child has exited
  let readyUrl = null;
  let stopping = null;

  function launch(profile) {
    log = openLog(ctx.evidenceDir);
    log.write(`[lunaswork] $ ${profile.startCommand}\n`);
    child = ctx.spawn(profile.startCommand, {
      cwd: ctx.projectDir,
      shell: true,
      windowsHide: true,
      // POSIX: own process group, so stop() can kill the whole tree.
      detached: ctx.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Not pipe(): a dying server can still flush output after stop() closed the
    // log, and a piped write-after-end would crash the main process.
    const toLog = (chunk) => {
      if (log) log.write(chunk);
    };
    if (child.stdout) child.stdout.on('data', toLog);
    if (child.stderr) child.stderr.on('data', toLog);
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      if (log) log.write(`[lunaswork] exited code=${code} signal=${signal}\n`);
    });
    child.on('error', (err) => {
      exit = { code: null, signal: null, error: err.message };
      if (log) log.write(`[lunaswork] spawn error: ${err.message}\n`);
    });
  }

  async function waitReady(profile) {
    const deadline = ctx.now() + profile.readyTimeoutSec * 1000;
    while (ctx.now() < deadline) {
      if (exit) return { ok: false, reason: exitReason() };
      if (await answersReady(ctx.fetch, profile.url)) return { ok: true };
      await ctx.sleep(POLL_INTERVAL_MS);
    }
    if (exit) return { ok: false, reason: exitReason() };
    return { ok: false, reason: `app did not answer at ${profile.url} within ${profile.readyTimeoutSec}s` };
  }

  function exitReason() {
    if (exit.error) return `start command failed: ${exit.error}`;
    return `app exited before it was ready (code ${exit.code}, signal ${exit.signal})`;
  }

  async function start(profile) {
    if (child) throw new Error('web adapter is already started');
    const { profile: valid, reason } = validateProfile(profile);
    if (!valid) throw new Error(`invalid project profile: ${reason}`);
    if (valid.adapter !== 'web') throw new Error(`profile adapter is '${valid.adapter}', not 'web'`);

    // Staging: the app already runs remotely - wait for stagingUrl, launch nothing.
    const target = valid.stagingUrl ? { ...valid, url: valid.stagingUrl } : valid;
    if (!valid.stagingUrl) launch(valid);
    const ready = await waitReady(target);
    if (!ready.ok) {
      await stop();
      throw new Error(valid.stagingUrl ? ready.reason : `${ready.reason} - see ${path.join(ctx.evidenceDir, SERVER_LOG)}`);
    }
    readyUrl = target.url;
    return { url: target.url };
  }

  async function shutdown() {
    let killed = true;
    if (child && !exit && Number.isInteger(child.pid)) killed = await killTree(child.pid, ctx);
    if (log) {
      const stream = log;
      log = null;
      await new Promise((resolve) => stream.end(resolve));
    }
    return killed;
  }

  function stop() {
    if (!stopping) stopping = shutdown();
    return stopping;
  }

  /** Fresh objects every call, so a caller cannot edit the allow-list in place. */
  function tools() {
    const args = [PLAYWRIGHT_PACKAGE, '--headless', '--isolated', '--output-dir', ctx.evidenceDir];
    if (readyUrl) args.push('--allowed-origins', new URL(readyUrl).origin);
    return {
      mcpConfig: { mcpServers: { [PLAYWRIGHT_SERVER]: { type: 'stdio', command: 'npx', args } } },
      allowedTools: PLAYWRIGHT_TOOLS.map((t) => `mcp__${PLAYWRIGHT_SERVER}__${t}`),
    };
  }

  return { name: 'web', evidenceDir: ctx.evidenceDir, start, stop, tools };
}

// ---- factory ------------------------------------------------------------------------

const FACTORIES = { web: createWebAdapter };

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} name adapter name from the profile
 * @param {{projectDir:string, runId:string, iteration:number, runsRoot?:string,
 *   spawn?:Function, fetch?:Function, now?:()=>number, sleep?:Function,
 *   platform?:string, execFile?:Function, kill?:Function}} opts
 * @returns {{name:string, evidenceDir:string, start:Function, stop:Function, tools:Function}}
 * @throws for an unknown / not-yet-built adapter, a bad projectDir, runId or iteration
 */
function createAdapter(name, opts = {}) {
  if (RESERVED_ADAPTERS.includes(name)) throw new Error(`tester adapter '${name}' is not available yet`);
  if (!ADAPTERS.includes(name) || !FACTORIES[name]) throw new Error(`unknown tester adapter '${String(name)}'`);
  if (typeof opts.projectDir !== 'string' || !path.isAbsolute(opts.projectDir)) {
    throw new Error('projectDir must be an absolute path');
  }
  return FACTORIES[name]({
    projectDir: opts.projectDir,
    evidenceDir: evidenceDirFor(opts.runsRoot || defaultRunsRoot(), opts.runId, opts.iteration),
    spawn: opts.spawn || childProcess.spawn,
    fetch: opts.fetch || globalThis.fetch,
    now: opts.now || Date.now,
    sleep: opts.sleep || realSleep,
    platform: opts.platform || process.platform,
    execFile: opts.execFile || childProcess.execFile,
    kill: opts.kill || process.kill.bind(process),
  });
}

module.exports = {
  PLAYWRIGHT_TOOLS,
  POLL_INTERVAL_MS,
  SERVER_LOG,
  evidenceDirFor,
  killTree,
  createAdapter,
};
