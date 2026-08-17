// ============================================================================
// LunaCore - Electron main process
// ----------------------------------------------------------------------------
// Responsible for:
//   * creating the app window,
//   * starting the pseudo-terminal (node-pty) with a system shell + `claude`,
//   * the IPC bridge: renderer <-> PTY (Action Injector + Passive Observer).
//
// THE "ZERO EXTRA TOKENS" RULE:
//   This file injects NO hidden prompts. It only:
//   - passes raw user input (keyboard + buttons) to PTY stdin,
//   - relays the raw PTY stdout stream to the renderer to display/parse.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
// @lydell/node-pty: a maintained fork of node-pty with prebuilds (N-API),
// works without compiling node-gyp / Visual Studio. API-compatible with node-pty.
const pty = require('@lydell/node-pty');
// Passive Observer (Phase 3): tool detection from stdout + tailing the
// JSONL transcript for real context-window usage. Read-only, zero tokens.
const { detectTools, detectApprovalPrompt, TranscriptWatcher, isLongTurn } = require('./observer');
// §4.2: literal TUI substrings used to recognize an approval prompt - data,
// not code, since the CLI text can change between releases (config/sound-triggers.json).
const { loadSoundTriggers } = require('./soundTriggers');
// Launch profiles (Phase 4): "how to start a session" definitions from JSON.
const { loadProfiles, getProfile } = require('./profiles');
// Building the start command: decides whether a session can be pinned by id.
const { withSessionId, findExecutable } = require('./launch');
// Project switcher: session working directories (cwd) from config/projects.json.
const { loadProjects, getProject, addProject } = require('./projects');
// Localhost port tracker (7B): passive scan of listening ports + kill.
const { killProcess, PortWatcher } = require('./ports');

// MCP server health: config + transcript-mined usage, and an on-demand probe.
const { getMcpHealth, probeServer } = require('./mcphealth');

// Git station: status for the watched repos, plus fetch.
const { readAllRepos, fetchRepo, scanForRepos } = require('./gitstation');
// Action cheat-sheets (7C): command groups sent through the Action Injector.
const { loadCheatsheets } = require('./cheatsheets');
// Skill cheat-sheet (7A): auto-scans skill directories -> categories.
const { loadSkills, rescanSkills } = require('./skills');
// Prompt library: multi-line prompts for repeated use.
const { loadPrompts } = require('./prompts');
// Scratchpad: local notepad kept as a plain text file.
const { readScratchpad, writeScratchpad } = require('./scratchpad');
// Themes (theming): CSS token maps + xterm colors from config/themes.json.
const { loadThemes } = require('./theme');
const { loadLayouts } = require('./layouts');
// UI preferences (theme + language) persisted in config/ui.local.json.
const { readUiPrefs, writeUiPrefs } = require('./uiprefs');
// Usage limit counter (5h + week) - GET read from the CLI's OAuth endpoint.
const { fetchUsage, UsageWatcher, nextUsageAnnounced } = require('./usage');
// E1: machine telemetry (RAM / CPU / uptime). Plain `os`, zero dependencies,
// zero network - Passive Observer in the strictest possible sense.
const { TelemetryWatcher } = require('./telemetry');
// GPU usage (System tab): own slow timer, shells out to Get-Counter. See
// src/gpu.js's header for why it stays out of telemetry.js's pure sample().
const { GpuSampler } = require('./gpu');
// Media Deck: now-playing (GSMTC) polling + transport/volume commands, own
// timer - see src/media.js's header for why it owns its own IPC push rather
// than being stamped onto another watcher's tick like GpuSampler is.
const { MediaSampler, sendTransportCommand, getVolume, setVolume, toggleMute } = require('./media');

// Clipboard history + pin-board todos + device panel (LUNACORE_HUD_WIDGET_PLAN.md).
const {
  ClipboardWatcher,
  readHistory,
  writeHistory,
  removeEntry,
  clearHistory,
} = require('./clipboard');

const { readTodos, writeTodos } = require('./todo');

const { micState } = require('./devices');
// Sound feedback: persistent `mpv --idle` process + JSON IPC.
const { SoundManager } = require('./soundManager');
const { resolveSoundFile } = require('./sounds');
// §11.2: read Claude's actual output aloud. Zero extra tokens - extraction is
// plain regex on the same transcript fragment TranscriptWatcher already
// tails, synthesis is offline Windows SAPI, no model call in either step.
const { extractSpokenText } = require('./ttsExtract');
const { synthesizeToWav } = require('./tts');
// D5: updates. Same PURE decisions - `electron-updater` is loaded lazily in
// getAutoUpdater(), only once it's known this build can actually update
// itself.
const {
  supportsUpdates,
  normalizeUpdateInfo,
  releaseUrl,
  releasesUrl,
  progressPercent,
} = require('./update');

// ---- Configuration -----------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

// Subscription usage limit counter. Set to false to COMPLETELY disable
// network requests to the usage endpoint (the tile then shows an 'off' state).
const ENABLE_USAGE_METER = true;

// Default shell for the current OS.
const DEFAULT_SHELL = IS_WINDOWS
  ? 'powershell.exe'
  : process.env.SHELL || 'bash';

// Default (fallback) session start directory - the user's home. The real cwd
// is held by the mutable `activeCwd` below and changed by the project switcher.
const START_CWD = os.homedir();

/**
 * Returns the path if it's an existing directory; otherwise the home directory.
 * Protects pty.spawn from throwing when a project points at a folder that
 * doesn't exist (e.g. the repo only exists on another machine - LunaCore is
 * meant to be portable).
 * @param {string} dir
 */
function safeCwd(dir) {
  try {
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* does not exist / no access */
  }
  return START_CWD;
}

// ---- Global state ----------------------------------------------------------

/**
 * A session = one tab: its own PTY, its own profile, its own working directory,
 * and its OWN TranscriptWatcher. That last part is the whole point of
 * multi-session mode - with two live sessions a global watcher would show the
 * metrics of whichever one last twitched, i.e. someone else's numbers in the
 * context bar.
 *
 * @typedef {{
 *   id: string, proc: import('node-pty').IPty|null, profileId: string,
 *   projectId: string|null, cwd: string, size: {cols:number,rows:number},
 *   watcher: TranscriptWatcher|null, alive: boolean
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {string|null} id of the session shown in the window */
let activeSessionId = null;
let sessionSeq = 0;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {PortWatcher | null} */
let portWatcher = null;
/** @type {UsageWatcher | null} */
let usageWatcher = null;
/** @type {TelemetryWatcher | null} */
let telemetryWatcher = null;
/** @type {GpuSampler | null} */
let gpuSampler = null;
/** @type {MediaSampler | null} */
let mediaSampler = null;

// Only ever non-null while the user has the clipboard history switched ON -
// stopping it has to actually stop the reading, not just hide the widget.
/** @type {ClipboardWatcher | null} */
let clipboardWatcher = null;
/** @type {SoundManager | null} */
let soundManager = null;
// §11.2: separate mpv instance for spoken narration, own IPC pipe (see
// soundManager.js's `channel` opt) - so a multi-sentence readout gets its own
// `append-play` queue and can't be cut off by an unrelated SFX `replace`.
/** @type {SoundManager | null} */
let narrationManager = null;
// 50%/80% voice announcements (§4.4) - which thresholds already fired for the
// CURRENT 5h window. nextUsageAnnounced() (usage.js) re-arms both once usage
// drops back below 40%.
let usageAnnounced = { at50: false, at80: false };
// Worst-case time for soundManager's mpv IPC socket to come up: CONNECT_DELAY_MS
// (400) + MAX_CONNECT_ATTEMPTS * RECONNECT_DELAY_MS (5 * 300) from soundManager.js.
// play() silently no-ops while `available` is still false, so the startup
// greeting is fired after this margin rather than right after start().
const STARTUP_GREETING_DELAY_MS = 2000;
// Profiles loaded from config/ plus the default id (for new sessions).
let profiles = [];
let activeProfileId = null;
// Projects (working directories) loaded from config/ + the default id and the real cwd.
let projects = [];
let activeProjectId = null;
let activeCwd = START_CWD;
// Last known terminal size - the starting point for newly created sessions.
let lastSize = { cols: 80, rows: 24 };

/** The session currently shown in the window (or null). */
function activeSession() {
  return activeSessionId ? sessions.get(activeSessionId) || null : null;
}

/**
 * Resolves a session from an IPC payload. A missing/unknown id => the active
 * session, so a call without a sessionId behaves like the single-session version.
 * @param {unknown} sessionId
 */
function resolveSession(sessionId) {
  if (typeof sessionId === 'string' && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }
  return activeSession();
}

/** Sends an event to the renderer, if the window is alive. */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Serializable session description for the renderer (no process handles). */
function sessionSummary(s) {
  const profile = getProfile(profiles, s.profileId);
  return {
    id: s.id,
    profileId: s.profileId,
    profileLabel: profile ? profile.label : s.profileId,
    projectId: s.projectId,
    cwd: s.cwd,
    folder: path.basename(s.cwd) || s.cwd,
    alive: s.alive,
  };
}

/** Broadcasts the full tab list + which one is active. */
function broadcastSessions() {
  send('sessions:update', {
    sessions: [...sessions.values()].map(sessionSummary),
    activeSessionId,
  });
}

// ---- App window ---------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0a0710', // dark background before CSS loads (no white flash)
    title: 'LunaCore',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Safe defaults: the renderer has no direct access to Node.js. All
      // communication goes through the contextBridge in preload.js.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs access to ipcRenderer
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A2: headless check of the widget contract, off unless asked for.
  if (process.argv.includes('--luna-probe')) {
    mainWindow.webContents.once('did-finish-load', () => runWidgetProbe(mainWindow));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Runs the widget probe and quits: `npx electron . --luna-probe`.
 *
 * Remounts every mounted widget several times and prints the bus subscriber
 * counts before and after. This exists because a widget whose cleanup forgets a
 * disposer looks perfectly normal - it just renders twice per event, for the
 * rest of the session, and nothing on screen says so. Counts that grew are the
 * only visible symptom, and until Phase C starts moving panels around nothing
 * else would ever exercise unmount() at all.
 *
 * `rows` is the positive half: one marker element per converted widget means it
 * mounted exactly once - neither missing nor duplicated. It is counted per
 * widget rather than for `ports` alone, or the probe would keep proving the one
 * case while staying silent about every widget added after it.
 *
 * C1 added the second pass: cycling every layout preset. That is the operation
 * this whole contract was built for - it moves every widget root at once and
 * genuinely unmounts the ones the next preset has no region for - so the counts
 * either come back where they started or a disposer is missing.
 */
async function runWidgetProbe(win) {
  const script = `(async () => {
    // renderer.js has a top-level await now (the layout presets arrive over
    // IPC), so it is still importing when did-finish-load fires. Wait for it
    // instead of declaring the renderer broken.
    const deadline = Date.now() + 10000;
    while (!window.__luna && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.__luna) return JSON.stringify({ error: 'no __luna - renderer never finished importing' });
    const mounted = __luna.mounted();
    const before = __luna.stats();
    // Marker count on the untouched first paint, so a later 0 can be blamed on
    // the right pass instead of on "somewhere in the probe".
    const rowsAtStart = {
      autocompact: document.querySelectorAll('#autocompact-toggle').length,
      context: document.querySelectorAll('#ctx-fill').length,
    };
    for (let pass = 0; pass < 3; pass++) for (const id of mounted) __luna.remount(id);
    const afterRemounts = __luna.stats();
    const rowsAfterRemounts = {
      autocompact: document.querySelectorAll('#autocompact-toggle').length,
      context: document.querySelectorAll('#ctx-fill').length,
    };

    // Every preset, twice round, then back to where we started.
    const startedOn = __luna.activeLayout();
    const presets = __luna.layouts();
    for (let pass = 0; pass < 2; pass++) for (const id of presets) __luna.layout(id);
    __luna.layout(startedOn);

    // Every theme, then back to the first. A theme sets only the tokens it
    // cares about, so the set of inline properties on :root has to come back to
    // exactly what it was - anything extra is a token the previous theme wrote
    // and this one never cleared, which silently changes the HUD from here on.
    // initAppearance() is async and is NOT awaited by renderer.js, so __luna
    // can exist while themesById is still empty. Without this wait the whole
    // theme pass runs over an empty list and reports a clean sweep it never
    // took - the one probe result worse than a failure.
    const themeDeadline = Date.now() + 10000;
    while (__luna.themes().length === 0 && Date.now() < themeDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const themes = __luna.themes();
    if (themes.length === 0) return JSON.stringify({ error: 'no themes - initAppearance never resolved' });
    const tokensAtStart = __luna.tokens();
    for (const id of themes) __luna.theme(id);
    __luna.theme(themes[0]);
    const tokensAfterThemes = __luna.tokens();

    return JSON.stringify({
      widgets: __luna.widgets(),
      mounted,
      remountedTo: __luna.mounted(),
      presets,
      startedOn,
      endedOn: __luna.activeLayout(),
      before,
      afterRemounts,
      after: __luna.stats(),
      rowsAtStart,
      rowsAfterRemounts,
      themes,
      // Equal = no theme leaked a token past its own switch. Printed as a
      // difference rather than two long lists, because the lists are ~45 entries
      // and only the delta is ever interesting.
      themeTokensLeaked: tokensAfterThemes.filter((t) => !tokensAtStart.includes(t)),
      themeTokensLost: tokensAtStart.filter((t) => !tokensAfterThemes.includes(t)),
      rows: {
        ports: document.querySelectorAll('#ports-list').length,
        scratchpad: document.querySelectorAll('#pad-text').length,
        usage: document.querySelectorAll('#usage-body').length,
        skilltracker: document.querySelectorAll('#skill-list').length,
        activefiles: document.querySelectorAll('#afile-list').length,
        context: document.querySelectorAll('#ctx-fill').length,
        // spark.js shares the context widget's root - counted separately so a
        // half-mounted block (bar without chart) cannot pass unnoticed.
        spark: document.querySelectorAll('#ctx-spark-line').length,
        autocompact: document.querySelectorAll('#autocompact-toggle').length,
        // The three list builders: their CONTENT is async config, which may not
        // have landed yet, so the marker is the container the module renders
        // into - that is what has to exist exactly once.
        cheatsheets: document.querySelectorAll('#cheatsheets').length,
        prompts: document.querySelectorAll('#prompts').length,
        skills: document.querySelectorAll('#skills-search').length,
        // Everything below was added after the probe was written. The header
        // says why they belong here: a marker list that stops growing keeps
        // proving the same widgets while staying silent about every one added
        // since, which is the failure mode this probe exists to catch.
        media: document.querySelectorAll('#media-title').length,
        sessiontimeline: document.querySelectorAll('#stimeline-track').length,
        devices: document.querySelectorAll('#dev-mic-state').length,
        todo: document.querySelectorAll('#todo-form').length,
        clipboard: document.querySelectorAll('#clip-enabled').length,
        mcp: document.querySelectorAll('#mcp-list').length,
        git: document.querySelectorAll('#git-list').length,
      },
    });
  })()`;

  // Also written to a FILE, not just stdout. A packaged Windows app is a GUI
  // subsystem binary: it never attaches to the parent console, so console.log
  // vanishes and the probe appears to pass silently - which is the one thing a
  // probe must never do. D2 needs this exact check to work on the built .exe,
  // because that is where packaging faults live and no test can reach them.
  const outFile = path.join(app.getPath('userData'), 'luna-probe.json');
  let payload;
  try {
    payload = await win.webContents.executeJavaScript(script, true);
    console.log('[luna-probe]', payload);
  } catch (err) {
    payload = JSON.stringify({ error: String((err && err.message) || err) });
    console.error('[luna-probe] FAILED', err);
  }
  try {
    fs.writeFileSync(outFile, payload, 'utf8');
    console.log('[luna-probe] wrote', outFile);
  } catch {
    /* stdout already carried it in the unpackaged case */
  }
  app.quit();
}

// ---- Pseudo-terminal (node-pty) ----------------------------------------------

/**
 * Starts a PTY session for the given profile: spawns a shell with env
 * overrides and (if the profile has a command, e.g. "claude") types it in
 * after a short delay.
 * @param {{id:string,label:string,command:string,args:string[],env:Object}} profile
 */
/**
 * The native Claude Code installer drops into ~/.local/bin, and the installer
 * doesn't always add that folder to PATH. If a `claude` binary lives there, we
 * prepend that directory to the spawned session's PATH - so profile
 * auto-start, typing `claude`, and the cheat-sheets all work without a
 * hand-typed full path.
 * @param {Record<string,string>} env
 */
function withClaudeOnPath(env) {
  try {
    const binDir = path.join(os.homedir(), '.local', 'bin');
    const exe = path.join(binDir, IS_WINDOWS ? 'claude.exe' : 'claude');
    if (!fs.existsSync(exe)) return env;
    // On Windows the PATH variable is sometimes named "Path" - find the existing key.
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const sep = IS_WINDOWS ? ';' : ':';
    const parts = (env[key] || '').split(sep);
    if (!parts.some((p) => p.toLowerCase() === binDir.toLowerCase())) {
      env[key] = binDir + sep + (env[key] || '');
    }
  } catch {
    /* don't block session start if anything goes wrong */
  }
  return env;
}

/**
 * When LunaCore itself was launched from inside a Claude Code session (e.g.
 * `npm start` run from Claude's own terminal), the process inherits session
 * markers in env: CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID,
 * etc. A nested `claude` sees them and starts as a "child session" -> DISABLES
 * transcript saving ("transcript saving is off - inherited claude_code_child_session
 * marker"). And without a transcript neither the Context Window bar nor the
 * sparkline works (they read the JSONL). So we strip the markers, so a session
 * inside LunaCore is always a full, top-level one - regardless of where
 * LunaCore itself was launched from. We don't touch config (ANTHROPIC_*).
 * @param {Record<string,string>} env
 */
function stripClaudeSessionMarkers(env) {
  const EXPLICIT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_EFFORT']);
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE') || EXPLICIT.has(key)) delete env[key];
  }
  return env;
}

/**
 * Guarantees color in the PTY session.
 *
 * Reason: when LunaCore is launched from a terminal that disables color
 * (Claude Code sets NO_COLOR=1 so its own output stays clean), a nested
 * `claude` inherits that variable and renders COMPLETELY WITHOUT COLOR - the
 * Claude logo comes out white instead of orange. This is not a theme bug:
 * xterm receives plain text, so no theme can fix it.
 *
 * So we clear the color-suppressing variables and declare a 256-color +
 * truecolor terminal. We do NOT override COLORTERM if the user set it deliberately.
 * @param {Record<string,string>} env
 */
function withColorSupport(env) {
  delete env.NO_COLOR;
  // FORCE_COLOR=0 is an explicit "no color"; any other value is left alone.
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR;
  env.TERM = 'xterm-256color';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';
  return env;
}

/**
 * Attaches a PTY + TranscriptWatcher to an existing session record. Split out
 * because both creating a tab and restarting it under a new profile or
 * directory use this, always the same way.
 * @param {Session} session
 * @param {{id:string,label:string,command:string,args:string[],env:Object}} profile
 */
function spawnInto(session, profile) {
  // Environment overrides from the profile (e.g. ANTHROPIC_BASE_URL for LM
  // Studio), clearing parent-session markers (transcript!) + guaranteeing
  // `claude` from ~/.local/bin is on the session's PATH.
  // Order matters: color is set on the INHERITED env first, and only then is
  // the profile applied on top - so a profile that deliberately sets TERM or
  // NO_COLOR still wins.
  const env = withClaudeOnPath(
    stripClaudeSessionMarkers({
      ...withColorSupport({ ...process.env }),
      ...(profile.env || {}),
    }),
  );

  const cwd = safeCwd(session.cwd);
  session.cwd = cwd;
  session.profileId = profile.id;

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-256color',
    cols: session.size.cols,
    rows: session.size.rows,
    cwd,
    env,
  });
  session.proc = proc;
  session.alive = true;

  // PASSIVE OBSERVER: this session's raw stdout -> renderer + tool detection.
  // Every event carries a sessionId, since the renderer keeps a separate buffer per tab.
  proc.onData((data) => {
    send('pty:data', { sessionId: session.id, data });
    const tiles = detectTools(data);
    if (tiles.length > 0) send('metrics:tools', { sessionId: session.id, tiles });

    // §4.2: fire voice.needYou once per prompt APPEARANCE, not once per stdout
    // chunk - a TUI redraw repeats the same text while Mati is still reading
    // it. approvalShowing clears on this session's next input (see registerIpc).
    if (soundManager && !session.approvalShowing) {
      const patterns = loadSoundTriggers().approvalPrompt;
      if (detectApprovalPrompt(data, patterns)) {
        session.approvalShowing = true;
        if (readUiPrefs().voiceEnabled !== false) {
          const resolved = resolveSoundFile('voice.needYou');
          if (resolved) soundManager.play(resolved.path);
        }
      }
    }
  });

  // Guard: ignore the exit of a process already detached from the session
  // (profile restart / tab close), so we don't send a false "session ended".
  proc.onExit(({ exitCode }) => {
    if (session.proc !== proc) return;
    session.proc = null;
    session.alive = false;
    send('pty:exit', { sessionId: session.id, code: exitCode });
    broadcastSessions();
  });

  // The profile's start command (empty = bare shell, no auto-start).
  const command = [profile.command, ...(profile.args || [])].join(' ').trim();
  // When WE launch `claude`, we dictate the session id - the transcript is then
  // named exactly <uuid>.jsonl and the watcher looks it up instead of inferring
  // ownership from file timestamps. Null = this session cannot be pinned (bare
  // shell, foreign command, or a resume that brings its own id).
  const transcriptId = randomUUID();
  const pinnedCommand = withSessionId(command, transcriptId);
  session.transcriptId = pinnedCommand ? transcriptId : null;

  // Its own transcript watcher, scoped to this session's directory.
  if (session.watcher) session.watcher.stop();
  session.watcher = new TranscriptWatcher(
    (metrics) => send('metrics:context', { sessionId: session.id, metrics }),
    {
      cwd,
      sessionUuid: session.transcriptId,
      // Skill Tracker fed from the transcript's structured tool_use entries.
      // Same IPC channel as the stdout scan - the payload differs: `events`
      // carries a start/end lifecycle (B8), `tiles` is the old flat blink the
      // stdout backstop above still sends.
      onTools: (events) => send('metrics:tools', { sessionId: session.id, events }),
      // §4.3/§11.1: "All done" voice line, gated on turn duration in checkTurnEnd.
      // §6.1: also forwarded to the renderer for the session timeline widget -
      // checkTurnEnd only ever drove sound/TTS, it never reached the UI before.
      onTurnEnd: (turn) => {
        checkTurnEnd(turn);
        send('metrics:turnend', { sessionId: session.id, turn });
      },
    },
  );
  session.watcher.start();

  // PTY buffers input, so the command runs once the shell is ready.
  const startCommand = pinnedCommand || command;
  if (startCommand) {
    setTimeout(() => {
      if (session.proc === proc) proc.write(`${startCommand}\r`);
    }, 600);
  }
}

/**
 * Creates a new tab and makes it active.
 * @param {{profileId?:string, projectId?:string}} [opts]
 * @returns {Session|null}
 */
function createSession(opts = {}) {
  const profile =
    getProfile(profiles, opts.profileId || activeProfileId) || profiles[0];
  if (!profile) return null;

  const project = getProject(projects, opts.projectId || activeProjectId);
  const session = {
    id: `s${++sessionSeq}`,
    proc: null,
    profileId: profile.id,
    projectId: project ? project.id : null,
    cwd: project ? project.path : activeCwd,
    size: { ...lastSize },
    watcher: null,
    // Session id handed to `claude --session-id`; null when it could not be
    // pinned. Set by spawnInto, which owns the start command.
    transcriptId: null,
    alive: false,
    // §4.2: true while an approval-prompt match is still on screen for this
    // session, so a TUI redraw repeating the same text doesn't replay the
    // sound on every stdout chunk. Cleared on the session's next input.
    approvalShowing: false,
  };

  sessions.set(session.id, session);
  spawnInto(session, profile);
  activeSessionId = session.id;
  broadcastSessions();
  return session;
}

/** Kills a session's process and watcher, without removing it from the map. */
function teardownSession(session) {
  if (session.watcher) {
    session.watcher.stop();
    session.watcher = null;
  }
  if (session.proc) {
    const old = session.proc;
    session.proc = null; // detach, so onExit ignores it
    try {
      old.kill();
    } catch {
      /* the process may already be dead */
    }
  }
  session.alive = false;
}

/**
 * Closes a tab. The last one is never left removed into a void - a fresh one
 * is created immediately, so the window is never left without a terminal.
 * @param {string} sessionId
 */
function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  teardownSession(session);
  sessions.delete(sessionId);

  if (sessions.size === 0) {
    createSession();
    return;
  }
  if (activeSessionId === sessionId) {
    activeSessionId = [...sessions.keys()][sessions.size - 1];
  }
  broadcastSessions();
}

/**
 * Restarts ONE session under a (possibly different) profile and directory.
 * The renderer gets 'pty:restarted' and clears that tab's buffer.
 * @param {Session} session
 * @param {{profileId?:string, projectId?:string}} [opts]
 */
function restartSession(session, opts = {}) {
  const profile =
    getProfile(profiles, opts.profileId || session.profileId) || profiles[0];
  if (!profile) return;

  if (opts.projectId) {
    const project = getProject(projects, opts.projectId);
    if (project) {
      session.projectId = project.id;
      session.cwd = project.path;
    }
  }

  teardownSession(session);
  send('pty:restarted', {
    sessionId: session.id,
    id: profile.id,
    label: profile.label,
    folder: path.basename(safeCwd(session.cwd)),
  });
  spawnInto(session, profile);
  broadcastSessions();
}

/** Loads projects from config/ and sets the active working directory (cwd). */
function startActiveProjects() {
  const loaded = loadProjects();
  projects = loaded.projects;
  const proj = getProject(projects, loaded.activeProject) || projects[0];
  if (proj) {
    activeProjectId = proj.id;
    activeCwd = proj.path;
  }
}

/**
 * Loads profiles and opens the first tab (at app start).
 * B1: the profile remembered in ui.local.json takes priority - we start
 * where things left off. When the remembered profile no longer exists in the
 * config (someone deleted it / a different machine), we silently fall back
 * to activeProfile from profiles.json.
 */
function startActiveProfile() {
  const loaded = loadProfiles();
  profiles = loaded.profiles;
  const remembered = readUiPrefs().profile;
  const profile =
    getProfile(profiles, remembered) ||
    getProfile(profiles, loaded.activeProfile) ||
    profiles[0];
  if (profile) activeProfileId = profile.id;
  createSession();
}

// ---- Passive Observer: localhost ports (7B) ---------------------------------

function startPortWatcher() {
  portWatcher = new PortWatcher((ports) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ports:update', ports);
    }
  });
  portWatcher.start();
}

// ---- Passive Observer: subscription usage limits (5h + week) -----------

/** Plays voice.usage50/usage80 on a fresh threshold crossing (§4.4). */
function checkUsageThresholds(usage) {
  const pct =
    usage && usage.fiveHour && typeof usage.fiveHour.pct === 'number' ? usage.fiveHour.pct : null;
  const { next, fire } = nextUsageAnnounced(pct, usageAnnounced);
  usageAnnounced = next;
  if (!fire || !soundManager || readUiPrefs().voiceEnabled === false) return;
  const resolved = resolveSoundFile(`voice.${fire}`);
  if (resolved) soundManager.play(resolved.path);
}

// ---- Passive Observer: long task end (SOUNDS_IMPLEMENTATION_PLAN.md §3) --

/** Plays voice.done, but only when the completed turn ran long enough (§3). */
function checkTurnEnd({ startedAt, endedAt, text }) {
  const prefs = readUiPrefs();
  if (
    soundManager &&
    prefs.voiceEnabled !== false &&
    isLongTurn(startedAt, endedAt, prefs.soundLongTaskMinutes)
  ) {
    const resolved = resolveSoundFile('voice.done');
    if (resolved) soundManager.play(resolved.path);
  }
  maybeReadOutputAloud(text);
}

/**
 * §11.2: speaks the finished turn's prose aloud via Windows SAPI, gated
 * solely by the soundReadOutputEnabled opt-in (default off) - unlike
 * voice.done this is not also gated by soundLongTaskMinutes, since the point
 * is reading back what Claude said regardless of how long the turn took.
 * Fire-and-forget: synthesis is async and this must never block the PTY/IPC
 * event loop it's called from.
 * @param {string} [text] raw newly-appended transcript fragment from
 *   TranscriptWatcher's onTurnEnd (observer.js)
 */
function maybeReadOutputAloud(text) {
  const prefs = readUiPrefs();
  if (!narrationManager || !prefs.soundReadOutputEnabled || prefs.voiceEnabled === false) return;
  const spoken = extractSpokenText(text);
  if (!spoken) return;
  synthesizeToWav(spoken).then((wavFile) => {
    if (wavFile && narrationManager) narrationManager.play(wavFile, { mode: 'append-play' });
  });
}

function startUsageWatcher() {
  if (!ENABLE_USAGE_METER) return;
  usageWatcher = new UsageWatcher((usage) => {
    checkUsageThresholds(usage);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage:update', usage);
    }
  });
  usageWatcher.start();
}

// ---- E1: Passive Observer: machine telemetry (RAM / CPU / uptime) ----------
//
// The toggle exists for the same reason as ENABLE_USAGE_METER: the README
// promises every measurement can be disabled. This one in particular touches
// neither network nor disk - it's four calls into `os` - so disabling it is a
// matter of taste, not privacy. But the choice should still belong to the
// user, not to us.

const ENABLE_TELEMETRY = true;

function startTelemetryWatcher() {
  if (!ENABLE_TELEMETRY) return;
  gpuSampler = new GpuSampler();
  gpuSampler.start();
  telemetryWatcher = new TelemetryWatcher((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Stamped on here, not inside telemetry.js: gpuSampler runs on its own
      // slower timer (see src/gpu.js), so this is always whatever GPU reading
      // is currently cached, not a fresh sample taken on this tick.
      payload.gpu = gpuSampler.current();
      mainWindow.webContents.send('telemetry:update', payload);
    }
  });
  telemetryWatcher.start();
}

// ---- Media Deck: now-playing (GSMTC) + system volume ------------------------
//
// Action Injector, not Passive Observer - explicit user clicks cause explicit
// OS-level effects (play/pause/skip, volume). Still never touches the PTY:
// its whole IPC path (media:*) is entirely separate from pty:write/command.
// No user-facing toggle for v1, same as GpuSampler/ENABLE_TELEMETRY below.

const ENABLE_MEDIA_DECK = true;

function startMediaWatcher() {
  if (!ENABLE_MEDIA_DECK) return;
  mediaSampler = new MediaSampler(2000, (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('media:update', state);
    }
  });
  mediaSampler.start();
}

// ---- Clipboard history ------------------------------------------------------
//
// Unlike every other watcher here this one is USER-GATED (uiprefs
// `clipboardEnabled`, default false) and can be started and stopped at
// runtime, because switching the widget off must stop LunaCore reading the
// clipboard at all - see src/clipboard.js's header for why that matters more
// here than anywhere else in the app.

function startClipboardWatcher() {
  if (clipboardWatcher) return;
  clipboardWatcher = new ClipboardWatcher(
    () => clipboard.readText(),
    (list) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard:update', list);
      }
    }
  );
  clipboardWatcher.start();
}

function stopClipboardWatcher() {
  if (!clipboardWatcher) return;
  clipboardWatcher.stop();
  clipboardWatcher = null;
}

// ---- D5: updates ("notify, don't download" mode) -----------------------
// The check runs once, at startup. DOWNLOADING NEVER STARTS ON ITS OWN - only
// after the user clicks. The reasoning is in src/update.js's header: the
// binary is unsigned, and an app whose entire promise is "I only read what I
// list in the README" has no right to pull down 80 MB in the background.
//
// State is kept HERE, because the renderer may attach later than the network
// response arrives. The `update:status` channel replays the last state on
// request - the exact same rule as "feed replays its last payload" from §A2:
// a widget mounted between polls would otherwise sit empty.

const ENABLE_AUTO_UPDATE = true;

/** Last known update state. The update:state channel broadcasts every change. */
let updateState = { state: 'idle', info: null, percent: 0, error: null, reason: null };

/** electron-updater instance. null until it turns out to be needed. */
let updaterInstance = null;

// The version is appended on EVERY broadcast, rather than kept separately in
// the renderer: "current" is a statement about two numbers at once, so if
// they arrived over two channels the HUD would have an in-between state
// showing one without the other.
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  send('update:state', { ...updateState, version: app.getVersion() });
}

/** Environment facts for the pure supportsUpdates() decision. */
function updateEnv() {
  return {
    isPackaged: app.isPackaged,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
  };
}

function errorText(err) {
  if (!err) return 'unknown';
  return String(err.message || err);
}

/**
 * Lazily creates and configures electron-updater.
 *
 * Called ONLY after supportsUpdates() says "yes" - in a dev clone the module
 * looks for dev-app-update.yml and throws, so merely loading it in dev would
 * be an error.
 */
function getAutoUpdater() {
  if (updaterInstance) return updaterInstance;

  const { autoUpdater } = require('electron-updater');

  // Two lines that implement the "notify, user clicks" choice. Without them
  // electron-updater downloads immediately by default and installs on exit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    setUpdateState({
      state: 'available',
      info: normalizeUpdateInfo(info),
      percent: 0,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState({ state: 'none', info: null, percent: 0, error: null });
  });

  autoUpdater.on('download-progress', (p) => {
    setUpdateState({ state: 'downloading', percent: progressPercent(p), error: null });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ state: 'ready', info: normalizeUpdateInfo(info), percent: 100 });
  });

  // No network, a firewall, a private repo - everything lands here. The error
  // state is visible in the HUD, because a silent update failure is worse
  // than none: the user would think they have the latest version.
  autoUpdater.on('error', (err) => {
    setUpdateState({ state: 'error', error: errorText(err) });
  });

  updaterInstance = autoUpdater;
  return autoUpdater;
}

/** Polls GitHub for a newer release. Downloads nothing. */
function checkForUpdate() {
  const support = supportsUpdates(updateEnv());
  if (!ENABLE_AUTO_UPDATE || !support.supported) return;

  setUpdateState({ state: 'checking', error: null });
  try {
    // checkForUpdates() returns a promise that can reject IN PARALLEL with the
    // 'error' event. Without this .catch() a network failure is an unhandled rejection.
    Promise.resolve(getAutoUpdater().checkForUpdates()).catch((err) => {
      setUpdateState({ state: 'error', error: errorText(err) });
    });
  } catch (err) {
    setUpdateState({ state: 'error', error: errorText(err) });
  }
}

/**
 * Sets the startup state and - as long as it's allowed to - polls for updates.
 *
 * A build that cannot update itself gets the 'unsupported' state along with a
 * REASON (a code, not a sentence - the renderer translates it), so the HUD
 * can show "portable version: download manually" instead of pretending
 * everything is up to date.
 */
function startUpdateCheck() {
  if (!ENABLE_AUTO_UPDATE) {
    setUpdateState({ state: 'unsupported', reason: 'off' });
    return;
  }

  const support = supportsUpdates(updateEnv());
  if (!support.supported) {
    setUpdateState({ state: 'unsupported', reason: support.reason });
    return;
  }

  checkForUpdate();
}

// ---- IPC channels -------------------------------------------------------------

function registerIpc() {
  // ACTION INJECTOR (keyboard): raw input from xterm.js -> PTY stdin.
  // Payload: { sessionId?, data } - a missing sessionId lands on the active session.
  ipcMain.on('pty:write', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { data: payload };
    const session = resolveSession(p.sessionId);
    if (session && session.proc) session.proc.write(p.data);
    // §4.2: any input from Mati means an approval prompt (if showing) got answered.
    if (session) session.approvalShowing = false;
  });

  // ACTION INJECTOR (GUI buttons): sends a ready-made command + Enter (\r).
  // This is exactly what the COMPACT CONTEXT button uses -> "/compact".
  ipcMain.on('pty:command', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { text: payload };
    const session = resolveSession(p.sessionId);
    if (!session || !session.proc || typeof p.text !== 'string') return;
    const line = p.text.endsWith('\r') ? p.text : `${p.text}\r`;
    session.proc.write(line);
    session.approvalShowing = false;
  });

  // ACTION INJECTOR (prompt library): pastes MULTI-LINE text.
  //
  // Why not a plain write(): in Claude Code's TUI every "\r"/"\n" is an Enter,
  // so a multi-line prompt sent raw would submit after the first line (the
  // rest would go as separate messages). So we use bracketed paste mode
  // (ESC[200~ ... ESC[201~) - the terminal standard signaling "this is a
  // paste, not keystrokes". The TUI inserts the whole thing into the input
  // buffer, preserving line breaks and NOT submitting.
  //
  // { text: string, submit?: boolean } - submit only appends Enter.
  ipcMain.on('pty:paste', (_event, payload) => {
    const session = resolveSession(payload && payload.sessionId);
    if (!session || !session.proc || !payload || typeof payload.text !== 'string') return;
    // Line-ending normalization: only "\n" enters the input buffer.
    const text = payload.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    session.proc.write(`\x1b[200~${text}\x1b[201~`);
    if (payload.submit) session.proc.write('\r');
    session.approvalShowing = false;
  });

  // Matches the PTY size to the window's terminal size (xterm-addon-fit).
  // Size is remembered per session - every tab has its own xterm buffer.
  ipcMain.on('pty:resize', (_event, size) => {
    if (!size) return;
    const cols = Math.max(1, size.cols | 0);
    const rows = Math.max(1, size.rows | 0);
    lastSize = { cols, rows }; // starting point for the next tabs
    const session = resolveSession(size.sessionId);
    if (!session) return;
    session.size = { cols, rows };
    if (session.proc) session.proc.resize(cols, rows);
  });

  // ---- Tabs (multi-session) ----------------------------------------------

  ipcMain.handle('sessions:list', () => ({
    sessions: [...sessions.values()].map(sessionSummary),
    activeSessionId,
  }));

  // New tab: defaults to the same profile and project as currently selected.
  ipcMain.on('sessions:create', (_event, opts) => {
    createSession(opts && typeof opts === 'object' ? opts : {});
  });

  ipcMain.on('sessions:close', (_event, sessionId) => {
    if (typeof sessionId === 'string') closeSession(sessionId);
  });

  // Switches the visible tab. The other tabs' processes keep running in the
  // background - that's the whole point of tabs: a long run in one, work in another.
  ipcMain.on('sessions:activate', (_event, sessionId) => {
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) return;
    activeSessionId = sessionId;
    broadcastSessions();
  });

  // PHASE 4: the renderer asks for the available profiles (to fill the switcher).
  ipcMain.handle('profiles:list', () => ({ profiles, activeProfile: activeProfileId }));

  // PHASE 4: switching profile -> restart THIS tab with the new environment.
  // Other tabs are left untouched; a profile is a session's trait, not the app's.
  ipcMain.on('pty:restart', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { profileId: payload };
    const session = resolveSession(p.sessionId);
    if (!session || typeof p.profileId !== 'string') return;
    activeProfileId = p.profileId; // default profile for the next tabs
    writeUiPrefs({ profile: p.profileId }); // B1: remember for next start
    restartSession(session, { profileId: p.profileId });
  });

  // Project switcher: the renderer fetches the list of working directories.
  ipcMain.handle('projects:list', () => ({ projects, activeProject: activeProjectId }));

  // "Add project": native folder picker (Windows/macOS/Linux), so adding a
  // repo from another drive/directory doesn't require a manual config edit.
  // null = the user cancelled the dialog.
  ipcMain.handle('projects:pick-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  // Active-Files Heatmap (Mati, 2026-08-13): renderer has no fs access (context
  // isolation), so "is this file still on disk" has to be answered here. Read
  // -only, no watcher - the widget polls this every few seconds on its own
  // timer, same cadence as its live-indicator self-heal.
  ipcMain.handle('files:check-exist', (_event, paths) => {
    const out = {};
    if (!Array.isArray(paths)) return out;
    for (const p of paths) {
      if (typeof p === 'string' && p) out[p] = fs.existsSync(p);
    }
    return out;
  });

  // Writes a new entry to projects.local.json and returns the freshly reloaded
  // list - the same shape as projects:list, so the renderer simply swaps the
  // switcher's contents. Does not change activeProject: adding a folder should
  // not switch the current tab away (that's what the separate pty:switch-project is for).
  ipcMain.handle('projects:add', (_event, entry) => {
    const result = addProject(entry);
    if (!result) return null;
    projects = result.projects;
    return result;
  });

  // Project switch -> change cwd + restart the session with the CURRENT profile.
  // (The same restart mechanism as a profile switch; only the starting directory differs.)
  ipcMain.on('pty:switch-project', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { projectId: payload };
    const proj = getProject(projects, p.projectId);
    const session = resolveSession(p.sessionId);
    if (!proj || !session) return;
    activeCwd = proj.path; // default directory for the next tabs
    activeProjectId = proj.id;
    restartSession(session, { projectId: proj.id });
  });

  // 7B: open http://localhost:PORT in the default browser.
  ipcMain.on('ports:open', (_event, port) => {
    const p = port | 0;
    if (p > 0 && p <= 65535) shell.openExternal(`http://localhost:${p}`);
  });

  // 7B: kill a process by PID (on an explicit user click) + refresh the list.
  ipcMain.handle('ports:kill', async (_event, pid) => {
    const ok = await killProcess(pid);
    if (ok && portWatcher) portWatcher.refresh();
    return ok;
  });

  // Media Deck: play/pause/skip/volume. `type`/`action` are checked against a
  // fixed whitelist and `value` is clamped inside media.js before it ever
  // reaches a shell argv - same discipline ports:kill's pid argument gets.
  ipcMain.handle('media:command', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const { type, action, value } = payload;
    if (type === 'transport') {
      if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(action)) return false;
      const ok = await sendTransportCommand(action);
      // Force an immediate re-sample instead of waiting up to SAMPLE_MS for the
      // next scheduled tick - without this the UI can lag a full poll interval
      // behind a click even though the transport command itself already landed.
      if (ok && mediaSampler) mediaSampler.tick();
      return ok;
    }
    if (type === 'volume') {
      if (action === 'get') return getVolume();
      if (action === 'set') return setVolume(value);
      if (action === 'mute') return toggleMute();
    }
    return null;
  });

  // 7C: the renderer fetches cheat-sheet groups to build the collapsibles + buttons.
  ipcMain.handle('cheatsheets:list', () => loadCheatsheets());

  // 7A: the renderer fetches skills grouped into categories (cached result).
  ipcMain.handle('skills:list', () => loadSkills());

  // A5: forced re-scan (UI button) - a new skill no longer needs a restart.
  ipcMain.handle('skills:rescan', () => rescanSkills());

  // Prompt library: groups of multi-line prompts to paste.
  ipcMain.handle('prompts:list', () => loadPrompts());

  // Scratchpad: reads and writes the local notepad (validated in scratchpad.js).
  ipcMain.handle('scratchpad:read', () => readScratchpad());
  ipcMain.handle('scratchpad:write', (_event, text) => writeScratchpad(text));

  // Clipboard history. `enabled` is the switch the widget shows: it flips the
  // persisted pref AND starts/stops the real watcher, so "off" means LunaCore
  // is not reading the clipboard rather than merely not displaying it.
  ipcMain.handle('clipboard:state', () => ({
    enabled: readUiPrefs().clipboardEnabled,
    entries: clipboardWatcher ? clipboardWatcher.current() : readHistory(),
  }));
  ipcMain.handle('clipboard:enable', (_event, enabled) => {
    const on = enabled === true;
    writeUiPrefs({ clipboardEnabled: on });
    if (on) startClipboardWatcher();
    else stopClipboardWatcher();
    return { enabled: on, entries: clipboardWatcher ? clipboardWatcher.current() : readHistory() };
  });
  // Copying a stored clip back to the system clipboard. Writing (not reading)
  // is unconditional: it is the user pressing a button, not a background watch.
  ipcMain.handle('clipboard:copy', (_event, text) => {
    if (typeof text !== 'string' || !text) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('clipboard:remove', (_event, text) => {
    const next = removeEntry(clipboardWatcher ? clipboardWatcher.current() : readHistory(), text);
    if (clipboardWatcher) return clipboardWatcher.setList(next);
    // Watcher off: the history is frozen but still readable/deletable, so the
    // edit goes straight to the file rather than being silently dropped.
    writeHistory(next);
    return next;
  });
  ipcMain.handle('clipboard:clear', () => {
    if (clipboardWatcher) return clipboardWatcher.setList([]);
    clearHistory();
    return [];
  });

  // MCP health. The scan streams every transcript on disk, so it is only ever
  // run on request - never on a timer, and never at boot.
  ipcMain.handle('mcp:health', () => getMcpHealth());
  // Probing spawns a real server, so the renderer may only name one: it sends a
  // NAME, and the spec that gets executed is looked up from the config we read
  // ourselves. A path or argv arriving from the renderer is never run.
  ipcMain.handle('mcp:probe', async (_event, name) => {
    if (typeof name !== 'string' || !name) return { ok: false, reason: 'badName', tools: null, ms: 0 };
    const { servers } = await getMcpHealth();
    const server = servers.find((s) => s.name === name);
    if (!server) return { ok: false, reason: 'unknown', tools: null, ms: 0 };
    return probeServer(server);
  });

  // Git station: read + fetch. No pull, commit or push by design - see the
  // header of src/gitstation.js.
  ipcMain.handle('git:list', () => readAllRepos());
  ipcMain.handle('git:fetch', (_event, dir) =>
    typeof dir === 'string' && dir
      ? fetchRepo(dir)
      : Promise.resolve({ ok: false, error: 'badPath', repo: null })
  );
  ipcMain.handle('git:scan', () => scanForRepos());

  // Pin-board todos: whole-list read/write, the scratchpad's shape (the list
  // operations themselves are pure and live in the renderer widget).
  ipcMain.handle('todo:read', () => readTodos());
  ipcMain.handle('todo:write', (_event, list) => writeTodos(list));

  // Device panel: microphone mute. `action` is whitelisted inside devices.js
  // before it can reach a shell argv, same discipline media:command uses.
  ipcMain.handle('devices:mic', (_event, action) => micState(action));

  // Themes: list of available themes (CSS tokens + xterm colors).
  // D3. Answers "is Claude Code installed at all?" so the HUD can say so in
  // words instead of leaving a newcomer staring at `command not found`.
  // Searched on the env AFTER withClaudeOnPath(), so a native install in
  // ~/.local/bin that never made it onto PATH still counts as found.
  ipcMain.handle('claude:status', () => {
    const env = withClaudeOnPath({ ...process.env });
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const found = findExecutable('claude', env[key], IS_WINDOWS, fs.existsSync);
    return { found: Boolean(found), path: found };
  });

  // The URL lives HERE, not in the renderer. openExternal on a renderer-supplied
  // string would be an open redirect straight into the user's browser; this way
  // the renderer can only ask for the one page we chose.
  ipcMain.on('claude:docs', () => {
    shell.openExternal('https://docs.claude.com/en/docs/claude-code/overview');
  });

  ipcMain.handle('themes:list', () => loadThemes());

  // C1: layout presets (grid + widget-to-region assignment).
  ipcMain.handle('layouts:list', () => loadLayouts());

  // UI preferences: reads {theme, lang} and writes a partial update (returns the new state).
  ipcMain.handle('ui:get', () => readUiPrefs());
  ipcMain.handle('ui:set', (_event, partial) => {
    const next = writeUiPrefs(partial);
    // Sound prefs take effect immediately, no restart - same live-apply as
    // theme/lang. soundManager may still be null if this fires before
    // app.whenReady()'s init line runs.
    if (next && soundManager) {
      soundManager.setEnabled(next.soundEnabled);
      soundManager.setVolume(next.soundVolume);
    }
    if (next && narrationManager) {
      narrationManager.setEnabled(next.soundEnabled);
      narrationManager.setVolume(next.soundVolume);
    }
    return next;
  });

  // Terminal Appearance Customizer §2: background image. The renderer's CSP
  // only allows 'self'/data: for img-src, so a raw file path could never be
  // used as a CSS background-image - this reads the file HERE and hands back
  // a data: URI. Capped at 4MB source size so ui.local.json (which stores the
  // encoded result directly, same as every other pref) doesn't balloon.
  const BG_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
  const BG_IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  ipcMain.handle('termcustom:pickBgImage', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose terminal background image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    const mime = BG_IMAGE_MIME[path.extname(filePath).toLowerCase()];
    if (!mime) return { error: 'unsupported' };
    if (fs.statSync(filePath).size > BG_IMAGE_MAX_BYTES) return { error: 'tooLarge' };

    const dataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    return { dataUrl };
  });

  // Sound feedback: renderer never touches mpv directly (contextIsolation).
  // Missing key, disabled entry, or missing asset file all resolve to null in
  // resolveSoundFile() - a silent no-op, matching soundManager's own
  // degrade-gracefully rule for a missing mpv.
  ipcMain.on('sound:play', (_event, payload) => {
    if (!soundManager || !payload || typeof payload.key !== 'string') return;
    if (payload.key.startsWith('voice.') && readUiPrefs().voiceEnabled === false) return;
    const resolved = resolveSoundFile(payload.key, payload.opts || {});
    if (resolved) soundManager.play(resolved.path);
  });

  // Usage limits: forced read (refresh button). When disabled - return an
  // 'off' state; when the watcher is running - refresh it (it will emit
  // usage:update), and separately return a fresh read for the call itself.
  ipcMain.handle('usage:refresh', async () => {
    if (!ENABLE_USAGE_METER) return { error: 'off' };
    if (usageWatcher) usageWatcher.refresh();
    return fetchUsage();
  });

  // ---- D5: updates ------------------------------------------------------

  // State replay. The widget mounts later than the network response arrives,
  // so without this channel it would show 'idle' until the next change.
  ipcMain.handle('update:status', () => ({ ...updateState, version: app.getVersion() }));

  // Manual check (refresh button).
  ipcMain.on('update:check', () => checkForUpdate());

  // The user's consent to download. This is the ONLY place anything is
  // downloaded from - autoDownload stays false.
  ipcMain.on('update:download', () => {
    const support = supportsUpdates(updateEnv());
    if (!ENABLE_AUTO_UPDATE || !support.supported) return;

    setUpdateState({ state: 'downloading', percent: 0, error: null });
    try {
      Promise.resolve(getAutoUpdater().downloadUpdate()).catch((err) => {
        setUpdateState({ state: 'error', error: errorText(err) });
      });
    } catch (err) {
      setUpdateState({ state: 'error', error: errorText(err) });
    }
  });

  // Consent to restart and install. Only here does anything on disk actually change.
  ipcMain.on('update:install', () => {
    if (updateState.state !== 'ready') return;
    try {
      // isSilent=false: the installer must be visible. The binary is unsigned,
      // so SmartScreen may appear - a silent install would leave the user
      // facing an unexplained system window.
      getAutoUpdater().quitAndInstall(false, true);
    } catch (err) {
      setUpdateState({ state: 'error', error: errorText(err) });
    }
  });

  // Release page. The address is built HERE, never comes from the renderer:
  // shell.openExternal on a UI string would be an open redirect straight into
  // the user's browser (the same rule as the docs link).
  ipcMain.on('update:open-releases', () => {
    const version = updateState.info && updateState.info.version;
    shell.openExternal(version ? releaseUrl(version) : releasesUrl());
  });
}

// ---- App lifecycle ---------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startActiveProjects(); // sets cwd before the first session starts
  startActiveProfile(); // opens the first tab (with its watcher)
  startPortWatcher();
  startUsageWatcher();
  startTelemetryWatcher();
  startMediaWatcher();
  // Only if the user has previously opted in - the pref defaults to false, so
  // a fresh install starts with nothing watching the clipboard.
  if (readUiPrefs().clipboardEnabled) startClipboardWatcher();
  // Sound feedback: volume/enabled come from the persisted prefs (Appearance
  // panel); readUiPrefs() already falls back to SoundManager-matching
  // defaults (volume 70, enabled true) if ui.local.json predates these keys.
  soundManager = new SoundManager({ volume: readUiPrefs().soundVolume });
  soundManager.setEnabled(readUiPrefs().soundEnabled !== false);
  soundManager.start();
  // §11.2 narration channel - own mpv instance/pipe, same enabled/volume as
  // the SFX channel; whether it actually SPEAKS on a given turn is decided
  // per-turn in maybeReadOutputAloud() via soundReadOutputEnabled.
  narrationManager = new SoundManager({ volume: readUiPrefs().soundVolume, channel: 'voice' });
  narrationManager.setEnabled(readUiPrefs().soundEnabled !== false);
  narrationManager.start();
  // Startup greeting (SOUNDS_IMPLEMENTATION_PLAN.md §3) - delayed
  // so it fires after the mpv IPC socket is actually up (see
  // STARTUP_GREETING_DELAY_MS above); play() is a silent no-op if mpv never
  // came up or the user disabled sound in the meantime.
  setTimeout(() => {
    if (!soundManager || readUiPrefs().voiceEnabled === false) return;
    const resolved = resolveSoundFile('voice.welcome');
    if (resolved) soundManager.play(resolved.path);
  }, STARTUP_GREETING_DELAY_MS);
  // D5. One HTTPS request at startup, downloads nothing. Fired after
  // createWindow(), so the HUD has time to paint; the request itself is
  // asynchronous anyway and doesn't block the event loop.
  startUpdateCheck();
  // A5: the skill scan (7A) is now async (fs.promises) and doesn't block the
  // event loop, so it no longer needs to be delayed behind the window - the
  // earlier it starts, the better the odds the cache is ready before the
  // skills widget asks for it.
  loadSkills();

  app.on('activate', () => {
    // macOS: recreate the window after a Dock click, if all were closed.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (sessions.size === 0) startActiveProfile();
    }
  });
});

app.on('window-all-closed', () => {
  // Every tab has its own process and its own watcher - clean up all of them.
  for (const session of sessions.values()) teardownSession(session);
  sessions.clear();
  activeSessionId = null;

  if (portWatcher) {
    portWatcher.stop();
    portWatcher = null;
  }
  if (usageWatcher) {
    usageWatcher.stop();
    usageWatcher = null;
  }
  if (telemetryWatcher) {
    telemetryWatcher.stop();
    telemetryWatcher = null;
  }
  if (gpuSampler) {
    gpuSampler.stop();
    gpuSampler = null;
  }
  stopClipboardWatcher();
  if (soundManager) {
    soundManager.stop();
    soundManager = null;
  }
  if (narrationManager) {
    narrationManager.stop();
    narrationManager = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
