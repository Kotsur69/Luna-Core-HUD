// ============================================================================
// LunaCore - headless host mode (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Host runtime". `LunaCore --host` starts Electron
// without the HUD window: a tray icon ("Luna host · <machine> · default",
// Stop, Open log) and only the cloud auth / sync, snapshots, usage, git
// station and host modules. None of the Windows-only HUD code is loaded, so
// the same entry runs on macOS. Electron (not plain Node) keeps safeStorage
// for the cloud session.
//
//   boot()        called first thing by main.js: takes the single-instance
//                 lock and decides 'host' (run here), 'quit' (another copy
//                 has the lock and takes over) or 'hud' (main.js carries on)
//   startHost()   the runtime: tray, keep-awake, heartbeat (`host` snapshot
//                 every 30 s), the command loop, clones of missing repos
//
// A second `--host` launch while the HUD runs switches the running app into
// host mode (its windows hide, Stop brings them back). A second plain launch
// behaves as before.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_FLAG = '--host';
const DEFAULT_FLAG = '--make-default';
const REPOS_EVERY_MS = 10 * 60 * 1000;
const USAGE_PUT_EVERY_MS = 5 * 60 * 1000;
const LOGIN_CHECK_MS = 5000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

// ---- pure parts (test/hostmain.test.js) ------------------------------------

/** argv -> {host, makeDefault}. Only the exact flags count. */
function parseHostArgs(argv) {
  const list = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  const host = list.includes(HOST_FLAG);
  return { host, makeDefault: host && list.includes(DEFAULT_FLAG) };
}

/** What this process does at startup. */
function decideBoot({ host, gotLock }) {
  if (!host) return 'hud';
  return gotLock ? 'host' : 'quit';
}

/**
 * The lock holder's answer to a second launch.
 * @param {{mode: 'hud'|'host', argv: string[]}} s
 * @returns {'switch'|'make-default'|'ignore'}
 */
function decideSecondInstance({ mode, argv }) {
  const args = parseHostArgs(argv);
  if (!args.host) return 'ignore';
  if (mode === 'hud') return 'switch';
  return args.makeDefault ? 'make-default' : 'ignore';
}

/** The tray's first line. */
function trayLabel({ machine, isDefault }) {
  return `Luna host · ${machine}${isDefault ? ' · default' : ''}`;
}

/** Skill scan result (skills.js) -> names. */
const skillNames = (scan) =>
  (scan && Array.isArray(scan.categories) ? scan.categories : []).flatMap((c) => (Array.isArray(c.skills) ? c.skills.map((s) => s && s.name) : []));

/** The hostauth.js verifier, whatever shape it exports; null when absent (every row refused). */
function loadVerifier(load = () => require('./hostauth')) {
  let mod;
  try {
    mod = load();
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') console.error('[hostmain] hostauth failed to load:', err.message);
    return null;
  }
  if (mod && typeof mod.verifyCommand === 'function') return mod.verifyCommand;
  if (mod && typeof mod.createHostAuth === 'function') {
    const auth = mod.createHostAuth();
    if (auth && typeof auth.verify === 'function') return (row) => auth.verify(row);
  }
  return null;
}

// ---- runtime ---------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Mirrors console.log / console.error into the host log ("Open log"). */
function teeConsole(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`);
  } catch (err) {
    console.error('[hostmain] log rotate failed:', err.message);
  }
  for (const name of ['log', 'error']) {
    const orig = console[name].bind(console);
    console[name] = (...args) => {
      orig(...args);
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
      } catch {
        // The log is a convenience; a locked file must not break the host.
      }
    };
  }
}

/** Slash command names from ~/.claude/commands/*.md. */
function commandNames(home = os.homedir()) {
  try {
    return fs
      .readdirSync(path.join(home, '.claude', 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/** MCP server names from ~/.claude.json. */
function mcpNames(home = os.homedir()) {
  const { collectServers } = require('./mcphealth');
  try {
    return collectServers(readJson(path.join(home, '.claude.json'))).map((s) => s.name);
  } catch {
    return [];
  }
}

/** Synced projects with this host's local path: [{id, name, path, remote}]. */
function syncedProjects() {
  const { projectFiles, resolveStoredPath } = require('./projects');
  const { createProjectsProvider } = require('./projectsync');
  const { normalizeText } = require('./localized');
  const { units } = createProjectsProvider(projectFiles()).read(Date.now());
  return units.map(([k, v]) => {
    const label = normalizeText(v.label);
    return {
      id: k.slice('proj:entry:'.length),
      name: typeof label === 'string' ? label : label.en || label.pl || '',
      path: resolveStoredPath(v.path),
      remote: v.remote || null,
    };
  });
}

/**
 * Starts host mode in this process.
 * @param {{electron: object, machine: string, makeDefault?: boolean,
 *   cloud?: object|null, onStop?: () => void}} opts
 *   cloud = the HUD's running cloud (switch mode), else one is started here;
 *   onStop = what Stop does instead of quitting (switch mode: show the HUD)
 */
function startHost({ electron, machine, makeDefault = false, cloud: given = null, onStop = null }) {
  const { app, Tray, Menu, shell, powerSaveBlocker, nativeImage } = electron;
  const { execFile } = require('child_process');
  const paths = require('./paths');
  const { startCloud } = require('./cloudsync');
  const { startConfigSync } = require('./configsync');
  const { createSnapshotPuts } = require('./snapshotputs');
  const { readAllRepos, fetchDir, loadRepoList } = require('./gitstation');
  const { loadSkills } = require('./skills');
  const { UsageWatcher } = require('./usage');
  const { usageSnapshot } = require('./usagesnapshot');
  const { hostSnapshot, HEARTBEAT_MS } = require('./hostsnapshot');
  const { createHostCommands } = require('./hostcommands');
  const { createHostRepos, readOwners } = require('./hostrepos');
  const { writeDefault, readDefault } = require('./hostdefault');

  paths.ensureUserDir();
  const logFile = path.join(app.getPath('logs'), 'host.log');
  teeConsole(logFile);
  console.log(`[hostmain] host mode on ${machine}${given ? ' (switched from the HUD)' : ''}`);

  const defaultFile = paths.local('host-default.local.json');
  const cloud = given || startCloud({ machine });
  const configSync = given ? null : startConfigSync({ cloud, onChanged: (names) => names.includes('projects') && syncRepos() });
  if (makeDefault) setDefault();

  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  const timers = [];
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.push(t);
    return t;
  };

  const repos = createHostRepos({ execFile, owners: () => readOwners(readJson(paths.local('host.local.json'))) });
  const puts = createSnapshotPuts({
    snapshots: () => cloud.snapshots,
    loggedIn: () => cloud.status().loggedIn,
    machine,
    readAll: readAllRepos,
    historyFile: () => null,
  });
  let skills = [];
  loadSkills()
    .then((scan) => {
      skills = skillNames(scan);
    })
    .catch((err) => console.error('[hostmain] skill scan failed:', err.message));

  function setDefault() {
    try {
      writeDefault(defaultFile, machine);
      if (configSync) configSync.soon();
    } catch (err) {
      console.error('[hostmain] --make-default failed:', err.message);
    }
    refreshTray();
  }

  function listProjects() {
    try {
      return syncedProjects();
    } catch (err) {
      console.error('[hostmain] project list unreadable:', err.message);
      return [];
    }
  }

  async function syncRepos() {
    await repos.sync(listProjects());
    heartbeat();
  }

  function heartbeat() {
    const statuses = repos.statuses();
    const { createRepoKeys } = require('./missionrepokey');
    const keys = createRepoKeys();
    const list = listProjects().map((p) => {
      const dir = repos.dirOf(p);
      const key = dir ? keys.resolve(dir).key : null;
      return { id: p.id, key: key && key.startsWith('git:') ? key : null, name: p.name, cloned: Boolean(dir), status: statuses.get(p.id) || null };
    });
    const snap = hostSnapshot(
      {
        version: app.getVersion(),
        os: process.platform,
        isDefault: readDefault(defaultFile) === machine,
        repos: list,
        skills,
        commands: commandNames(),
        mcp: mcpNames(),
        sessions: [],
      },
      Date.now(),
    );
    cloud.snapshots.put('host', snap).catch((err) => console.error('[hostmain] heartbeat failed:', err.message));
    refreshTray();
  }

  // ---- signed commands ----
  const handlers = {
    'git.fetchAll': async () => {
      const { repos: list } = loadRepoList();
      const results = await Promise.all(list.map((dir) => fetchDir(dir).then((r) => r.ok)));
      await puts.repos.refresh();
      return { fetched: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
    },
    'repo.clone': async (payload) => {
      const res = await repos.clone(payload.url);
      if (res.status === 'cloned' && res.dir) {
        const { addProject } = require('./projects');
        addProject({ path: res.dir });
        if (configSync) configSync.soon();
      }
      heartbeat();
      return { status: res.status };
    },
  };
  const commands = cloud.client ? createHostCommands({ client: cloud.client, host: machine, verify: loadVerifier(), handlers, log: console.error }) : null;
  let commandsOn = false;
  function followLogin() {
    const loggedIn = cloud.status().loggedIn;
    if (commands && loggedIn && !commandsOn) commands.start();
    if (commands && !loggedIn && commandsOn) commands.stop();
    commandsOn = Boolean(commands && loggedIn);
  }

  // ---- usage (the HUD already puts it in switch mode) ----
  let usageWatcher = null;
  if (!given) {
    let latest = null;
    const putUsage = () => {
      const snap = usageSnapshot(latest);
      if (snap) cloud.snapshots.put('usage', snap).catch(() => {});
    };
    usageWatcher = new UsageWatcher((usage) => {
      latest = usage;
      putUsage();
    });
    usageWatcher.start();
    every(putUsage, USAGE_PUT_EVERY_MS);
  }

  // ---- tray ----
  let tray = null;
  function refreshTray() {
    if (!tray) return;
    const label = trayLabel({ machine, isDefault: readDefault(defaultFile) === machine });
    tray.setToolTip(label);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label, enabled: false },
        { label: cloud.status().loggedIn ? 'Cloud: logged in' : 'Cloud: logged out', enabled: false },
        { type: 'separator' },
        { label: 'Open log', click: () => shell.openPath(logFile) },
        { label: 'Stop', click: () => stop() },
      ]),
    );
  }
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-yellow.png'));
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  refreshTray();

  // First run: the GitHub login in the browser, same flow as the HUD.
  if (!given) {
    setTimeout(() => {
      const s = cloud.status();
      if (s.configured && !s.loggedIn) cloud.login().then(followLogin, (err) => console.error('[hostmain] login failed:', err.message));
    }, LOGIN_CHECK_MS);
  }

  every(() => {
    followLogin();
    heartbeat();
  }, HEARTBEAT_MS);
  every(syncRepos, REPOS_EVERY_MS);
  setTimeout(() => {
    followLogin();
    syncRepos();
    puts.repos.refresh();
  }, LOGIN_CHECK_MS * 2);

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    console.log('[hostmain] host mode stopped');
    timers.forEach(clearInterval);
    if (commands) commands.stop();
    if (usageWatcher) usageWatcher.stop();
    if (configSync) configSync.stop();
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    if (tray) tray.destroy();
    tray = null;
    if (onStop) onStop();
    else app.quit();
  }

  return { stop, setDefault };
}

/**
 * main.js's first call. Takes the single-instance lock and routes the launch.
 * @param {{argv: string[], hud: () => ({cloud: object|null})}} opts
 *   hud() = the running HUD's cloud, for a switch into host mode
 * @returns {'host'|'quit'|'hud'}
 */
function boot({ argv, hud }) {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const { machineName } = require('./missionledgersync');
  const args = parseHostArgs(argv);
  const gotLock = app.requestSingleInstanceLock();
  const decision = decideBoot({ host: args.host, gotLock });
  if (decision === 'quit') {
    // The lock holder switches into host mode (second-instance below).
    app.quit();
    return decision;
  }
  const machine = machineName(os.hostname());
  let host = null;
  const mode = () => (host ? 'host' : decision);

  if (gotLock) {
    app.on('second-instance', (_event, commandLine) => {
      const what = decideSecondInstance({ mode: mode(), argv: commandLine });
      if (what === 'make-default' && host) host.setDefault();
      if (what !== 'switch') return;
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((w) => w.hide());
      host = startHost({
        electron,
        machine,
        makeDefault: parseHostArgs(commandLine).makeDefault,
        cloud: hud().cloud,
        onStop: () => {
          host = null;
          windows.filter((w) => !w.isDestroyed()).forEach((w) => w.show());
        },
      });
    });
  }

  if (decision === 'host') {
    // No window ever opens: closing nothing must not quit, Stop does.
    app.on('window-all-closed', () => {});
    app.whenReady().then(() => {
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
      host = startHost({ electron, machine, makeDefault: args.makeDefault });
    });
  }
  return decision;
}

module.exports = { boot, startHost, parseHostArgs, decideBoot, decideSecondInstance, trayLabel, skillNames, loadVerifier };
