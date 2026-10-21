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
// First run (src/hostsetup.js): no cloud session -> the HUD's GitHub browser
// login; then, with no phone in host-keys.local.json, the pairing window
// (src/hostpairing.js). Until both are done the tray says "Needs setup" and
// the host neither heartbeats, clones nor claims commands.
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
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
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

/**
 * A hostcommands.js row (cleanRow) -> hostauth.js verifyCommand(): the signed
 * fields are exactly the row's, so what runs is what was signed.
 */
function commandVerifier(auth) {
  return async (row) =>
    auth.verifyCommand({
      grant: row.grant,
      command: { host: row.host, kind: row.kind, payload: row.payload, nonce: row.nonce, expires_at: row.expiresAt },
      sig: row.sig,
    });
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
let teed = false;
function teeConsole(file) {
  if (teed) return; // a second switch into host mode must not wrap console twice
  teed = true;
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

/** The claude CLI's env for host jobs: the session env, ~/.local/bin on PATH (native installer). */
function jobEnv() {
  const { buildSessionEnv } = require('./sessionenv');
  const env = buildSessionEnv(process.env, {});
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = (env[key] || '').split(sep);
  return parts.some((p) => p.toLowerCase() === binDir.toLowerCase()) ? env : { ...env, [key]: binDir + sep + (env[key] || '') };
}

/** The real dependencies of src/hostactions.js in this process. */
function actionDeps({ cloud, repos, puts, configSync, after }) {
  const { app } = require('electron');
  const { createNews } = require('./missionnews');
  const { loadNews } = require('./missionnewsstore');
  const { runJob } = require('./missionrunner');
  const { readUiPrefs } = require('./uiprefs');
  const { loadRepoList, fetchDir } = require('./gitstation');
  const { addProject } = require('./projects');
  return {
    news: createNews({ linksFile: () => path.join(app.getPath('userData'), 'news-links.json') }),
    loadNews,
    runJob,
    model: () => readUiPrefs().missionModel,
    env: jobEnv,
    lang: () => readUiPrefs().lang,
    snapshots: () => cloud.snapshots,
    repoDirs: () => loadRepoList().repos,
    fetchDir,
    refreshRepos: () => puts.repos.refresh(),
    cloneRepo: (url) => repos.clone(url),
    folderExists: (url) => Boolean(repos.dirOf({ remote: url })),
    addProject,
    onProjectsChanged: () => {
      if (configSync) configSync.soon();
      after();
    },
  };
}

/**
 * Starts host mode in this process.
 * @param {{electron: object, machine: string, makeDefault?: boolean,
 *   cloud?: object|null, onStop?: () => void, chatTabs?: object|null}} opts
 *   cloud = the HUD's running cloud (switch mode), else one is started here;
 *   onStop = what Stop does instead of quitting (switch mode: show the HUD);
 *   chatTabs = the HUD's read-only tabs for phone sessions (switch mode only)
 */
function startHost({ electron, machine, makeDefault = false, cloud: given = null, onStop = null, chatTabs = null }) {
  const { app, Tray, Menu, shell, dialog, powerSaveBlocker, nativeImage } = electron;
  const { execFile } = require('child_process');
  const paths = require('./paths');
  const { startCloud } = require('./cloudsync');
  const { startConfigSync } = require('./configsync');
  const { createSnapshotPuts } = require('./snapshotputs');
  const { readAllRepos } = require('./gitstation');
  const { loadSkills } = require('./skills');
  const { UsageWatcher } = require('./usage');
  const { usageSnapshot } = require('./usagesnapshot');
  const { hostSnapshot, HEARTBEAT_MS } = require('./hostsnapshot');
  const { createHostCommands } = require('./hostcommands');
  const { createHostRepos, readOwners } = require('./hostrepos');
  const { writeDefault, readDefault } = require('./hostdefault');
  const { createHostAuth } = require('./hostauth');
  const { createHostPairing, hasPairedPhone, forgetAll } = require('./hostpairing');
  const { decideSetup, hostText, langOf, setupLine, confirmPairing } = require('./hostsetup');
  const { createHostActions } = require('./hostactions');
  const { createHostChat } = require('./hostchat');
  const { createHostEvents } = require('./hostevents');
  const { createHostPush } = require('./hostpush');
  const { spawn } = require('child_process');
  const { randomUUID } = require('crypto');

  paths.ensureUserDir();
  const logFile = path.join(app.getPath('logs'), 'host.log');
  teeConsole(logFile);
  console.log(`[hostmain] host mode on ${machine}${given ? ' (switched from the HUD)' : ''}`);

  const defaultFile = paths.local('host-default.local.json');
  const keysPath = paths.local('host-keys.local.json');
  const lang = langOf(require('./uiprefs').readUiPrefs().lang || app.getLocale());
  const tx = (key, vars) => hostText(lang, key, vars);
  const cloud = given || startCloud({ machine });
  const configSync = given ? null : startConfigSync({ cloud, onChanged: (names) => names.includes('projects') && syncRepos() });

  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  const timers = [];
  const timeouts = [];
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
    if (setupState() !== 'ready') return;
    await repos.sync(listProjects());
    heartbeat();
  }

  function heartbeat() {
    if (setupState() !== 'ready') return refreshTray();
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
        sessions: chat ? chat.sessions() : [],
      },
      Date.now(),
    );
    cloud.snapshots.put('host', snap).catch((err) => console.error('[hostmain] heartbeat failed:', err.message));
    refreshTray();
  }

  // ---- live chat (src/hostchat.js), its events and push notifications ----
  const push = cloud.client ? createHostPush({ invoke: (body) => cloud.client.functions.invoke('push', { body }), machine, log: console.error }) : null;
  const events = cloud.client ? createHostEvents({ client: cloud.client, host: machine, log: console.error }) : null;
  const chat = events
    ? createHostChat({
        spawn,
        randomUUID,
        events,
        env: jobEnv,
        // Only a cloned project of this host's own list: the phone sends an id, never a path.
        repoDir: (repoId) => {
          const p = listProjects().find((x) => x.id === repoId);
          return p ? repos.dirOf(p) : null;
        },
        notify: (kind, info) => {
          if (push) push.chat(kind, info);
        },
        onSessionsChanged: () => heartbeat(),
        log: console.error,
      })
    : null;
  const detachTabs = chat && chatTabs ? chatTabs.attach(chat) : null;
  const pruneEvents = () => {
    if (events && setupState() === 'ready') events.prune().catch((err) => console.error('[hostmain] event prune failed:', err.message));
  };

  // ---- signed commands (src/hostactions.js, src/hostchat.js) ----
  const auth = createHostAuth({ host: machine, keysPath, noncesPath: paths.local('host-nonces.local.json'), log: console.error });
  const handlers = { ...createHostActions(actionDeps({ cloud, repos, puts, configSync, after: heartbeat })), ...(chat ? chat.handlers : {}) };
  const commands = cloud.client ? createHostCommands({ client: cloud.client, host: machine, verify: commandVerifier(auth), handlers, log: console.error }) : null;
  let commandsOn = false;

  // ---- setup: login, then pairing ----
  function setupState() {
    const s = cloud.status();
    return decideSetup({ configured: s.configured !== false && Boolean(cloud.client), loggedIn: s.loggedIn, paired: hasPairedPhone(keysPath) });
  }
  const pairing = cloud.client
    ? createHostPairing({
        client: cloud.client,
        host: machine,
        keysPath,
        confirm: ({ code, label }) => confirmPairing({ dialog, lang, machine, code, label }),
        onPaired: () => {
          followSetup();
          syncRepos();
        },
        log: console.error,
      })
    : null;
  let pairingOffered = false;

  function openPairing() {
    if (!pairing || !cloud.status().loggedIn) return;
    pairing.open();
    refreshTray();
    dialog.showMessageBox({ type: 'info', title: tx('pairHintTitle'), message: tx('pairHint', { machine }), noLink: true }).catch(() => {});
  }

  async function forgetPhones() {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: tx('forgetTitle'),
      message: tx('forgetMessage'),
      buttons: [tx('forgetConfirm'), tx('cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    try {
      forgetAll(keysPath);
    } catch (err) {
      console.error('[hostmain] forgetting the phones failed:', err.message);
    }
    auth.forgetGrants();
    console.log('[hostmain] every paired phone forgotten');
    followSetup();
  }

  /** Commands run only once set up; the first time pairing is due it opens by itself. */
  function followSetup() {
    const state = setupState();
    const ready = Boolean(commands) && state === 'ready';
    if (ready && !commandsOn) commands.start();
    if (!ready && commandsOn) commands.stop();
    commandsOn = ready;
    if (state === 'pair' && !pairingOffered) {
      pairingOffered = true;
      openPairing();
    }
    if (state !== 'pair' && state !== 'ready' && pairing) pairing.close();
    refreshTray();
    return state;
  }

  function login() {
    cloud.login().then(followSetup, (err) => console.error('[hostmain] login failed:', err.message));
  }

  // ---- usage (the HUD already puts it in switch mode) ----
  let usageWatcher = null;
  if (!given) {
    let latest = null;
    const putUsage = () => {
      const snap = usageSnapshot(latest);
      if (!snap) return;
      cloud.snapshots.put('usage', snap).catch(() => {});
      if (push && cloud.status().loggedIn) push.usage(snap);
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
    const state = setupState();
    const ready = state === 'ready';
    const label = trayLabel({ machine, isDefault: readDefault(defaultFile) === machine });
    tray.setToolTip(ready ? label : `${label} · ${tx('needsSetup')}`);
    const pairOpen = Boolean(pairing && pairing.isOpen());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label, enabled: false },
        { label: ready ? setupLine(lang, state) : `${tx('needsSetup')}: ${setupLine(lang, state)}`, enabled: false },
        { type: 'separator' },
        ...(state === 'login' ? [{ label: tx('login'), click: () => login() }] : []),
        ...(pairing && cloud.status().loggedIn ? [{ label: pairOpen ? tx('pairOpen') : tx('pair'), enabled: !pairOpen, click: () => openPairing() }] : []),
        { label: tx('forget'), enabled: hasPairedPhone(keysPath), click: () => forgetPhones().catch((err) => console.error('[hostmain] forget failed:', err.message)) },
        { type: 'separator' },
        { label: tx('openLog'), click: () => shell.openPath(logFile) },
        { label: tx('stop'), click: () => stop() },
      ]),
    );
  }
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-yellow.png'));
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  // Only now: setDefault() refreshes the tray, which must exist by then.
  if (makeDefault) setDefault();
  refreshTray();

  // First run: the GitHub login in the browser, same flow as the HUD.
  timeouts.push(setTimeout(() => {
    if (setupState() === 'login') login();
  }, LOGIN_CHECK_MS));

  every(() => {
    followSetup();
    heartbeat();
  }, HEARTBEAT_MS);
  every(syncRepos, REPOS_EVERY_MS);
  every(pruneEvents, PRUNE_EVERY_MS);
  timeouts.push(setTimeout(() => {
    if (followSetup() !== 'ready') return;
    syncRepos();
    puts.repos.refresh();
    pruneEvents();
  }, LOGIN_CHECK_MS * 2));

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    console.log('[hostmain] host mode stopped');
    timers.forEach(clearInterval);
    timeouts.forEach(clearTimeout);
    if (commands) commands.stop();
    if (detachTabs) detachTabs();
    if (chat) chat.stopAll();
    if (pairing) pairing.close();
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
      // Only once the HUD is up: its cloud must exist, or a second one would start.
      app.whenReady().then(() => {
        const { cloud } = hud();
        if (host || !cloud) {
          if (!cloud) console.error('[hostmain] HUD cloud not ready, host switch ignored');
          return;
        }
        const windows = BrowserWindow.getAllWindows();
        const showAll = () => windows.filter((w) => !w.isDestroyed()).forEach((w) => w.show());
        windows.forEach((w) => w.hide());
        try {
          host = startHost({
            electron,
            machine,
            makeDefault: parseHostArgs(commandLine).makeDefault,
            cloud,
            chatTabs: hud().chatTabs || null,
            onStop: () => {
              host = null;
              showAll();
            },
          });
        } catch (err) {
          console.error('[hostmain] switch into host mode failed:', err.message);
          host = null;
          showAll();
        }
      });
    });
  }

  if (decision === 'host') {
    // No window ever opens: closing nothing must not quit, Stop does.
    app.on('window-all-closed', () => {});
    app.whenReady().then(() => {
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
      host = startHost({ electron, machine, makeDefault: args.makeDefault });
    }).catch((err) => {
      // No window and no tray: holding the lock would block every later --host.
      console.error('[hostmain] host mode failed to start:', err && err.message);
      app.quit();
    });
  }
  return decision;
}

module.exports = { boot, startHost, parseHostArgs, decideBoot, decideSecondInstance, trayLabel, skillNames, commandVerifier, actionDeps };
