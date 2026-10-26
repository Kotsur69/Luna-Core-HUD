// ============================================================================
// LunaCore - Luna's Work tester adapters (docs/LUNAS_WORK_PLAN.md, slice 1.3a)
// ----------------------------------------------------------------------------
// One interface per adapter (plan: "Tester adapters"):
//
//   start(profile) -> Promise<{url}|{handle}>  launch the app under test
//   tools()        -> the ONLY tools the Playtester may use
//   stop()         -> Promise<boolean>         tear it all down (idempotent)
//   evidenceDir    -> <userDir>/runs/lunaswork-<runId>/iter-<N>/
//   ensureBrowsers(matrix) -> Promise<{ok, installed}>  install engines once
//
// Only `web` exists. It spawns the profile's startCommand in the project dir,
// logs stdout/stderr to server.log in the evidence dir, polls the profile url
// until it answers 2xx/3xx, and kills the whole process tree on stop. LW
// 2.21a: an optional seedCommand runs to completion first (same dir, same
// log), so the Playtester meets the builders' fixtures; a failing seed fails
// the start.
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
const { ENGINES, BASELINE_COMBO } = require('./lunasworkRules');

const RUNS_DIR = 'runs';
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_ITERATION = 10000;
const POLL_INTERVAL_MS = 500;
const POLL_REQUEST_TIMEOUT_MS = 3000;
const SERVER_LOG = 'server.log';
const BROWSERS_LOG = 'browsers.log';
// <runsRoot>/.playwright-browsers.json: the engines already installed, so the
// install step runs on first use of an engine only.
const BROWSERS_MARKER = '.playwright-browsers.json';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BROWSERS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VIEWPORT = 4000;
const SEED_TIMEOUT_MS = 5 * 60 * 1000;

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

// ---- browser matrix -----------------------------------------------------------------

const viewportOk = (n) => Number.isInteger(n) && n > 0 && n <= MAX_VIEWPORT;

/**
 * The matrix entries the adapter can honour (a known engine, a sane viewport);
 * the Chromium desktop baseline when nothing usable is left.
 * @param {unknown} matrix lunasworkRules.matrixFor()
 * @returns {Array<{engine:string, width:number, height:number}>}
 */
function cleanMatrix(matrix) {
  const list = (Array.isArray(matrix) ? matrix : []).filter(
    (c) => c && ENGINES.includes(c.engine) && viewportOk(c.width) && viewportOk(c.height),
  );
  return list.length ? list : [BASELINE_COMBO];
}

/** Distinct engines of a matrix, in matrix order. */
const enginesOf = (matrix) => [...new Set(cleanMatrix(matrix).map((c) => c.engine))];

/** Chromium keeps the plain server name; other engines get their own server. */
const serverFor = (engine) => (engine === 'chromium' ? PLAYWRIGHT_SERVER : `${PLAYWRIGHT_SERVER}-${engine}`);

/**
 * Engines installed within BROWSERS_TTL_MS. The MCP package is @latest, so a
 * marker without an age limit would outlive a Playwright upgrade that needs
 * new browser builds; an expired marker reinstalls (idempotent, quick).
 */
function readInstalled(runsRoot, now) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runsRoot, BROWSERS_MARKER), 'utf8'));
    const at = Date.parse(raw && raw.at);
    if (!Number.isFinite(at) || now - at > BROWSERS_TTL_MS || at > now) return [];
    return Array.isArray(raw.engines) ? raw.engines.filter((e) => ENGINES.includes(e)) : [];
  } catch {
    return []; // missing or broken marker: install again, it is idempotent
  }
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
  let seeder = null; // the seed command while it runs

  const spawnInProject = (command) => ctx.spawn(command, {
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

  /**
   * LW 2.21a: runs the profile's seedCommand and waits for it to exit 0.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  function seed(command) {
    toLog(`[lunaswork] seed $ ${command}\n`);
    return new Promise((resolve) => {
      let timer = null;
      const finish = (res) => {
        clearTimeout(timer);
        seeder = null;
        resolve(res);
      };
      try {
        seeder = spawnInProject(command);
      } catch (err) {
        finish({ ok: false, reason: `seed command failed: ${err.message}` });
        return;
      }
      if (seeder.stdout) seeder.stdout.on('data', toLog);
      if (seeder.stderr) seeder.stderr.on('data', toLog);
      seeder.on('error', (err) => finish({ ok: false, reason: `seed command failed: ${err.message}` }));
      seeder.on('exit', (code, signal) => {
        toLog(`[lunaswork] seed exited code=${code} signal=${signal}\n`);
        finish(code === 0 ? { ok: true } : { ok: false, reason: `seed command exited with code ${code} (signal ${signal})` });
      });
      if (Number.isInteger(seeder.pid)) {
        const { pid } = seeder;
        timer = setTimeout(() => {
          killTree(pid, ctx);
          finish({ ok: false, reason: `seed command did not finish within ${SEED_TIMEOUT_MS / 1000}s` });
        }, SEED_TIMEOUT_MS);
      }
    });
  }

  function launch(profile) {
    toLog(`[lunaswork] $ ${profile.startCommand}\n`);
    child = spawnInProject(profile.startCommand);
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
    if (child || log) throw new Error('web adapter is already started');
    const { profile: valid, reason } = validateProfile(profile);
    if (!valid) throw new Error(`invalid project profile: ${reason}`);
    if (valid.adapter !== 'web') throw new Error(`profile adapter is '${valid.adapter}', not 'web'`);

    log = openLog(ctx.evidenceDir);
    if (valid.seedCommand) {
      const seeded = await seed(valid.seedCommand);
      if (!seeded.ok) {
        await stop();
        throw new Error(`${seeded.reason} - see ${path.join(ctx.evidenceDir, SERVER_LOG)}`);
      }
    }
    launch(valid);
    const ready = await waitReady(valid);
    if (!ready.ok) {
      await stop();
      throw new Error(`${ready.reason} - see ${path.join(ctx.evidenceDir, SERVER_LOG)}`);
    }
    readyUrl = valid.url;
    return { url: valid.url };
  }

  async function shutdown() {
    let killed = true;
    if (seeder && Number.isInteger(seeder.pid)) killed = await killTree(seeder.pid, ctx);
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

  /**
   * One Playwright MCP server per engine of the matrix, each launched with
   * its `--browser` and the viewport of that engine's first combo. Fresh
   * objects every call, so a caller cannot edit the allow-list in place.
   * @param {{matrix?:object[]}} [opts] matrix = lunasworkRules.matrixFor(); default the baseline
   */
  function tools({ matrix } = {}) {
    const mcpServers = {};
    const allowedTools = [];
    const combos = cleanMatrix(matrix);
    for (const engine of enginesOf(combos)) {
      const first = combos.find((c) => c.engine === engine);
      const args = [
        PLAYWRIGHT_PACKAGE, '--headless', '--isolated',
        '--browser', engine,
        '--viewport-size', `${first.width}x${first.height}`,
        '--output-dir', ctx.evidenceDir,
      ];
      if (readyUrl) args.push('--allowed-origins', new URL(readyUrl).origin);
      const server = serverFor(engine);
      mcpServers[server] = { type: 'stdio', command: 'npx', args };
      allowedTools.push(...PLAYWRIGHT_TOOLS.map((t) => `mcp__${server}__${t}`));
    }
    return { mcpConfig: { mcpServers }, allowedTools };
  }

  /**
   * Installs the Playwright browsers of the matrix that were never installed
   * before (`playwright install`, the version @playwright/mcp itself uses).
   * Logged to browsers.log in the evidence dir. Never rejects.
   * @returns {Promise<{ok:boolean, installed:string[], error?:string}>}
   */
  function ensureBrowsers(matrix) {
    const done = readInstalled(ctx.runsRoot, ctx.now());
    const missing = enginesOf(matrix).filter((e) => !done.includes(e));
    if (!missing.length) return Promise.resolve({ ok: true, installed: [] });
    // Engines come only from the ENGINES allow-list, so the command is fixed text.
    const command = `npx -y --package=${PLAYWRIGHT_PACKAGE} playwright install ${missing.join(' ')}`;
    const note = (line) => {
      try {
        fs.mkdirSync(ctx.evidenceDir, { recursive: true });
        fs.appendFileSync(path.join(ctx.evidenceDir, BROWSERS_LOG), `[lunaswork] ${line}
`);
      } catch {
        // logging is best effort; the result still carries the outcome
      }
    };
    note(`first use of ${missing.join(', ')} - $ ${command}`);
    return new Promise((resolve) => {
      // cwd = the runs folder, never the project: npx must not pick up a
      // `playwright` the project ships.
      const opts = { cwd: ctx.runsRoot, shell: true, windowsHide: true, timeout: INSTALL_TIMEOUT_MS };
      try {
        fs.mkdirSync(ctx.runsRoot, { recursive: true });
      } catch (e) {
        note(`could not create ${ctx.runsRoot}: ${e.message}`);
        resolve({ ok: false, installed: [], error: String(e.message).slice(0, 300) });
        return;
      }
      ctx.execFile(command, [], opts, (err, stdout, stderr) => {
        if (stdout) note(String(stdout).trim());
        if (stderr) note(String(stderr).trim());
        if (err) {
          note(`install failed: ${err.message}`);
          resolve({ ok: false, installed: [], error: String(err.message).slice(0, 300) });
          return;
        }
        try {
          fs.mkdirSync(ctx.runsRoot, { recursive: true });
          fs.writeFileSync(
            path.join(ctx.runsRoot, BROWSERS_MARKER),
            JSON.stringify({ engines: [...done, ...missing], at: new Date(ctx.now()).toISOString() }),
          );
        } catch (e) {
          note(`could not record the install: ${e.message}`);
        }
        note(`installed ${missing.join(', ')}`);
        resolve({ ok: true, installed: missing });
      });
    });
  }

  return {
    name: 'web', evidenceDir: ctx.evidenceDir, iteration: ctx.iteration, start, stop, tools, ensureBrowsers,
  };
}

// ---- factory ------------------------------------------------------------------------

const FACTORIES = { web: createWebAdapter };

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} name adapter name from the profile
 * @param {{projectDir:string, runId:string, iteration:number, runsRoot?:string,
 *   spawn?:Function, fetch?:Function, now?:()=>number, sleep?:Function,
 *   platform?:string, execFile?:Function, kill?:Function}} opts
 * @returns {{name:string, evidenceDir:string, iteration:number, start:Function, stop:Function,
 *   tools:Function, ensureBrowsers:Function}}
 * @throws for an unknown / not-yet-built adapter, a bad projectDir, runId or iteration
 */
function createAdapter(name, opts = {}) {
  if (RESERVED_ADAPTERS.includes(name)) throw new Error(`tester adapter '${name}' is not available yet`);
  if (!ADAPTERS.includes(name) || !FACTORIES[name]) throw new Error(`unknown tester adapter '${String(name)}'`);
  if (typeof opts.projectDir !== 'string' || !path.isAbsolute(opts.projectDir)) {
    throw new Error('projectDir must be an absolute path');
  }
  const runsRoot = path.resolve(opts.runsRoot || defaultRunsRoot());
  return FACTORIES[name]({
    projectDir: opts.projectDir,
    evidenceDir: evidenceDirFor(runsRoot, opts.runId, opts.iteration),
    runsRoot,
    iteration: opts.iteration,
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
  SEED_TIMEOUT_MS,
  SERVER_LOG,
  BROWSERS_LOG,
  BROWSERS_MARKER,
  evidenceDirFor,
  killTree,
  createAdapter,
};
