// ============================================================================
// LunaCore - Luna's Work `electron` tester adapter (LW 3.35)
// ----------------------------------------------------------------------------
// Same interface as the web adapter (src/lunasworkAdapters.js):
//
//   start(profile) -> {handle}   runs the profile's startCommand in the project
//                                dir with the in-process wrapper added through
//                                NODE_OPTIONS=--require (no CDP port), and
//                                waits for the wrapper's ready line: the first
//                                window has loaded
//   tools()        -> the bridge (helpers/playtest-bridge) with the narrow
//                     desktop tool set - windows, screenshot, click / type by
//                     selector or accessible name, keys, menus, console
//                     errors, DOM text. Nothing that reads files or runs code.
//   stop()         -> final screenshots of every window into the evidence
//                     dir, a graceful quit, then the whole process tree is
//                     killed (idempotent)
//
// Evidence dir: app.log (stdout / stderr), the Playtester's screenshots (the
// bridge writes them), final-<window>.png. The control file with the per-run
// token lives there only while the app runs.
//
// TRUST BOUNDARY: as for `web` - the command comes ONLY from the profile
// (LunaCore's local settings), re-validated here. The token is random per
// start and never leaves this machine.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { validateElectronProfile } = require('./lunasworkAdapterProfiles');
const { bridgeTools, noTools, WRAPPER_PATH } = require('./lunasworkBridge');
const { saveScreenshot } = require('../helpers/playtest-bridge/bridge');
const { TOKEN_ENV, READY_PREFIX } = require('../helpers/playtest-bridge/control');

const APP_LOG = 'app.log';
const CONTROL_FILE = '.playtest-control.json';
const READY_POLL_MS = 250;
const QUIT_GRACE_MS = 3000;
const QUIT_POLL_MS = 100;
const STOP_CALL_TIMEOUT_MS = 10 * 1000;
const MAX_FINAL_SHOTS = 10;
const MAX_LINE_CHARS = 64 * 1024;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * NODE_OPTIONS with `--require "<file>"` appended. Node unescapes `\` and `"`
 * inside the quotes, so both are escaped - a Windows path keeps its backslashes.
 */
function nodeOptionsWith(previous, file) {
  const quoted = `"${file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [typeof previous === 'string' ? previous.trim() : '', `--require ${quoted}`].filter(Boolean).join(' ');
}

/** {port, windows} from the wrapper's ready line, or null. */
function parseReady(line) {
  const i = line.indexOf(READY_PREFIX);
  if (i < 0) return null;
  try {
    const info = JSON.parse(line.slice(i + READY_PREFIX.length));
    return Number.isInteger(info.port) && info.port > 0 && info.port < 65536 ? { port: info.port, windows: info.windows | 0 } : null;
  } catch {
    return null;
  }
}

/**
 * @param {{projectDir:string, evidenceDir:string, spawn:Function, now:()=>number, sleep:Function,
 *   platform:string, env:object, killTree:(pid:number)=>Promise<boolean>, newToken:()=>string,
 *   nodeBinary:string, callControl:Function}} ctx
 */
function createElectronAdapter(ctx) {
  const controlFile = path.join(ctx.evidenceDir, CONTROL_FILE);
  let child = null;
  let log = null;
  let exit = null;
  let ready = null; // {port, windows} once the wrapper said so
  let control = null;
  let stopping = null;
  let pending = '';

  const toLog = (chunk) => {
    if (log) log.write(chunk);
  };

  function onStdout(chunk) {
    toLog(chunk);
    pending = `${pending}${chunk}`.slice(-MAX_LINE_CHARS);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const info = !ready && parseReady(line);
      if (info) ready = info;
    }
  }

  function launch(profile, token) {
    fs.mkdirSync(ctx.evidenceDir, { recursive: true });
    log = fs.createWriteStream(path.join(ctx.evidenceDir, APP_LOG), { flags: 'a' });
    log.write(`[lunaswork] $ ${profile.startCommand}\n`);
    const env = { ...ctx.env, NODE_OPTIONS: nodeOptionsWith(ctx.env.NODE_OPTIONS, WRAPPER_PATH), [TOKEN_ENV]: token };
    // Inherited from an Electron parent it would start the app as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    child = ctx.spawn(profile.startCommand, {
      cwd: ctx.projectDir,
      shell: true,
      windowsHide: true,
      // POSIX: own process group, so stop() can kill the whole tree.
      detached: ctx.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    if (child.stdout) child.stdout.on('data', (c) => onStdout(String(c)));
    if (child.stderr) child.stderr.on('data', toLog);
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      toLog(`[lunaswork] exited code=${code} signal=${signal}\n`);
    });
    child.on('error', (err) => {
      exit = { code: null, signal: null, error: err.message };
      toLog(`[lunaswork] spawn error: ${err.message}\n`);
    });
  }

  function exitReason() {
    if (exit.error) return `start command failed: ${exit.error}`;
    return `app exited before its first window loaded (code ${exit.code}, signal ${exit.signal}) - a single-instance app may already be running`;
  }

  async function waitReady(profile) {
    const deadline = ctx.now() + profile.readyTimeoutSec * 1000;
    while (ctx.now() < deadline) {
      if (ready) return { ok: true };
      if (exit) return { ok: false, reason: exitReason() };
      await ctx.sleep(READY_POLL_MS);
    }
    if (ready) return { ok: true };
    if (exit) return { ok: false, reason: exitReason() };
    return { ok: false, reason: `no app window loaded within ${profile.readyTimeoutSec}s` };
  }

  async function start(profile) {
    if (child) throw new Error('electron adapter is already started');
    const { profile: valid, reason } = validateElectronProfile(profile);
    if (!valid) throw new Error(`invalid project profile: ${reason}`);
    const token = ctx.newToken();
    launch(valid, token);
    const res = await waitReady(valid);
    if (!res.ok) {
      await stop();
      throw new Error(`${res.reason} - see ${path.join(ctx.evidenceDir, APP_LOG)}`);
    }
    control = { port: ready.port, token };
    // Read by the bridge the Playtester starts; owner-only where the OS has modes.
    fs.writeFileSync(controlFile, JSON.stringify(control), { mode: 0o600 });
    return { handle: { kind: 'electron', pid: child.pid, windows: ready.windows } };
  }

  /** Best effort: one final screenshot per window, as evidence of how the run ended. */
  async function finalScreenshots() {
    const call = (tool, args) => ctx.callControl(control, tool, args, { timeoutMs: STOP_CALL_TIMEOUT_MS });
    const listed = await call('list_windows', {});
    const windows = Array.isArray(listed && listed.windows) ? listed.windows.slice(0, MAX_FINAL_SHOTS) : [];
    for (const w of windows) {
      if (!Number.isInteger(w.id)) continue;
      const name = `final-${w.id}.png`;
      try {
        const shot = await call('screenshot', { name, windowId: w.id });
        saveScreenshot(ctx.evidenceDir, name, shot && shot.png);
      } catch (err) {
        toLog(`[lunaswork] final screenshot of window ${w.id} failed: ${errText(err)}\n`);
      }
    }
  }

  async function quitGracefully() {
    await ctx.callControl(control, 'quit', {}, { timeoutMs: STOP_CALL_TIMEOUT_MS });
    const deadline = ctx.now() + QUIT_GRACE_MS;
    while (!exit && ctx.now() < deadline) await ctx.sleep(QUIT_POLL_MS);
  }

  async function shutdown() {
    if (control && !exit) {
      try {
        await finalScreenshots();
      } catch (err) {
        toLog(`[lunaswork] final screenshots failed: ${errText(err)}\n`);
      }
      try {
        await quitGracefully();
      } catch (err) {
        toLog(`[lunaswork] quit failed: ${errText(err)}\n`);
      }
    }
    // Whatever is still running - the app, npm / npx around it, helpers it spawned.
    let killed = true;
    if (child && !exit && Number.isInteger(child.pid)) killed = await ctx.killTree(child.pid);
    control = null;
    try {
      fs.rmSync(controlFile, { force: true });
    } catch {
      // The token dies with the app anyway.
    }
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

  /** Fresh objects every call; nothing until the app is up. */
  function tools() {
    if (!control) return noTools();
    return bridgeTools('electron', { evidenceDir: ctx.evidenceDir, nodeBinary: ctx.nodeBinary, args: ['--control', controlFile] });
  }

  return { name: 'electron', evidenceDir: ctx.evidenceDir, start, stop, tools };
}

module.exports = {
  APP_LOG,
  CONTROL_FILE,
  nodeOptionsWith,
  parseReady,
  createElectronAdapter,
};
