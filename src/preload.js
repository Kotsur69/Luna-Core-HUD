// ============================================================================
// LunaCore - preload (secure IPC bridge)
// ----------------------------------------------------------------------------
// Runs in an isolated context between the main process and the renderer.
// Exposes to the page ONLY a narrow, explicit `window.lunacore` API - the
// renderer gets no direct access to Node.js or ipcRenderer.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lunacore', {
  // --- PASSIVE OBSERVER: PTY stdout stream -> renderer ---
  // NOTE: since the tabs version, every event carries a sessionId. The renderer
  // keeps a separate xterm buffer per tab, so it needs to know whose data this
  // is - otherwise a background session's output would spill into the terminal
  // you're looking at.
  /** A chunk of terminal data: ({ sessionId, data }). */
  onData: (callback) => {
    ipcRenderer.on('pty:data', (_event, payload) => callback(payload));
  },
  /** A given tab's PTY process exiting: ({ sessionId, code }). */
  onExit: (callback) => {
    ipcRenderer.on('pty:exit', (_event, payload) => callback(payload));
  },

  // --- PASSIVE OBSERVER: Phase 3 metrics (read-only) ---
  /** Context-window metrics: ({ sessionId, metrics: {tokens,limit,percent} }). */
  onContext: (callback) => {
    ipcRenderer.on('metrics:context', (_event, payload) => callback(payload));
  },
  /** Skill Tracker tiles to light up: ({ sessionId, tiles: ["Shell",...] }). */
  onTools: (callback) => {
    ipcRenderer.on('metrics:tools', (_event, payload) => callback(payload));
  },
  /** §6.1: a completed turn: ({ sessionId, turn: {startedAt,endedAt,text} }). */
  onTurnEnd: (callback) => {
    ipcRenderer.on('metrics:turnend', (_event, payload) => callback(payload));
  },
  /** CONCEPT_MCP_DEBUGGER.md: an MCP call start/end: ({ sessionId, events }). */
  onMcp: (callback) => {
    ipcRenderer.on('metrics:mcp', (_event, payload) => callback(payload));
  },
  /** Active-Files Heatmap's git-sourced signal (src/gitfiles.js): files git
   *  sees as changed that the transcript path missed (Bash/PowerShell writes).
   *  ({ sessionId, files: [{file, added, removed}] }). */
  onGitFiles: (callback) => {
    ipcRenderer.on('metrics:gitfiles', (_event, payload) => callback(payload));
  },

  // --- Tabs (multi-session) ---
  /** Fetches { sessions: [{id,profileId,profileLabel,folder,alive}], activeSessionId }. */
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  /** Change to the tab list or the active one: ({ sessions, activeSessionId }). */
  onSessions: (callback) => {
    ipcRenderer.on('sessions:update', (_event, payload) => callback(payload));
  },
  /** New tab (defaults to the current profile + project). */
  createSession: (opts = {}) => ipcRenderer.send('sessions:create', opts),
  /** Closes a tab; the last one is replaced with a fresh one, never left empty. */
  closeSession: (sessionId) => ipcRenderer.send('sessions:close', sessionId),
  /** Shows the chosen tab. The other tabs' processes keep running in the background. */
  activateSession: (sessionId) => ipcRenderer.send('sessions:activate', sessionId),
  /** Restores + focuses the HUD window (a minimized/background window ignores a plain focus). */
  focusWindow: () => ipcRenderer.send('window:focus'),
  /** Flashes the taskbar button until the window is focused (busy -> idle cue, opt-in). No-op if already focused. */
  flashWindow: () => ipcRenderer.send('window:flash'),
  /**
   * Opens a clicked `file:line` link from the terminal in the configured
   * editor. Payload: { sessionId, file, line, col }. `file` is the raw token
   * text - main resolves it against THAT session's own cwd and rejects
   * anything that escapes it before spawning (see src/editor.js). Resolves
   * { ok: true } or { ok: false, reason }.
   */
  openInEditor: (payload) => ipcRenderer.invoke('editor:open', payload),

  // --- PHASE 4: launch profiles ---
  /** Fetches { profiles, activeProfile } to fill the switcher. Profiles are redacted (no env/secrets). */
  getProfiles: () => ipcRenderer.invoke('profiles:list'),
  /** Switches profile -> restarts THIS tab; the others are left untouched. */
  switchProfile: (id, sessionId) =>
    ipcRenderer.send('pty:restart', { profileId: id, sessionId }),
  /** Session restart: ({ sessionId, id, label, folder }). */
  onRestarted: (callback) => {
    ipcRenderer.on('pty:restarted', (_event, profile) => callback(profile));
  },

  // --- AI providers: template catalog + generated-profile CRUD ---
  /** Fetches the shipped provider templates (LM Studio, Kimi, GLM, ...); no secrets in this list. */
  getProviders: () => ipcRenderer.invoke('providers:list'),
  /** Builds a profile from a template + user input (apiKey/model/...) and saves it; returns { profiles, activeProfile, addedId } or { ok:false, reason }. */
  addProviderProfile: (payload) => ipcRenderer.invoke('profiles:add-from-template', payload),
  /** Updates an existing generated profile's model/key; returns { profiles, activeProfile } or { ok:false, reason }. */
  updateProviderProfile: (id, payload) => ipcRenderer.invoke('profiles:update-from-template', { id, ...payload }),
  /** Removes a profile (local-added or a shipped default) by id; returns { profiles, activeProfile } or null. */
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  /** Opens a provider template's docs page. Main resolves the URL from config/providers.json itself - this bridge cannot be used to open an arbitrary page. */
  openProviderDocs: (templateId) => ipcRenderer.send('providers:open-docs', templateId),

  // --- LM Studio CLI control (Settings model picker - replaces "go local claude") ---
  /** Whether the `lms` CLI is reachable; returns { ok, version } or { ok:false, reason }. */
  getLmsCliStatus: () => ipcRenderer.invoke('lmstudiocli:status'),
  /** Every model downloaded to disk (not just a currently-loaded one); returns { ok, models } or { ok:false, reason }. */
  listDownloadedLmStudioModels: () => ipcRenderer.invoke('lmstudiocli:list'),
  /** Force-loads a model via `lms load`; returns { ok, message } or { ok:false, reason, message? }. */
  loadLmStudioModel: (payload) => ipcRenderer.invoke('lmstudiocli:load', payload),

  // --- Project switcher (working directory) ---
  /** Fetches { projects, activeProject } to fill the switcher. */
  getProjects: () => ipcRenderer.invoke('projects:list'),
  /** Switches the working directory -> restarts THIS tab in the new folder. */
  switchProject: (id, sessionId) =>
    ipcRenderer.send('pty:switch-project', { projectId: id, sessionId }),
  /** Native folder picker; returns the path or null (cancelled). */
  pickProjectFolder: () => ipcRenderer.invoke('projects:pick-folder'),
  /** Appends a new project to projects.local.json; returns { projects, activeProject } or null. */
  addProject: (entry) => ipcRenderer.invoke('projects:add', entry),
  /** Removes a project by id (local-added or a shipped default); returns { projects, activeProject } or null. */
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),

  // --- Active-Files Heatmap: does the file still exist on disk ---
  /** Checks fs.existsSync for a list of paths; returns { [path]: boolean }. */
  checkFilesExist: (paths) => ipcRenderer.invoke('files:check-exist', paths),
  /** Accumulated `git diff HEAD -- <file>` behind a heatmap row, on an explicit
   *  click. Read-only local git read: ({ ok, diff, truncated, reason }),
   *  reason is 'notRepo' | 'noSession' | 'outside' | 'gitFailed' | null. */
  getFileDiff: (sessionId, file) => ipcRenderer.invoke('files:diff', { sessionId, file }),

  // --- 7B: localhost port tracker ---
  /** List of listening ports: [{ port, procId, name }]. */
  onPorts: (callback) => {
    ipcRenderer.on('ports:update', (_event, ports) => callback(ports));
  },
  /** Opens http://localhost:PORT in the browser. */
  openPort: (port) => ipcRenderer.send('ports:open', port),
  /** Kills a process by PID; returns Promise<boolean>. */
  killPort: (pid) => ipcRenderer.invoke('ports:kill', pid),

  // --- MCP server health ---
  /** Fetches { servers: [{name, scope, transport, enabled, lastUsed, calls, status}] }. */
  getMcpHealth: () => ipcRenderer.invoke('mcp:health'),
  /** Handshakes ONE stdio server by name; Promise<{ok, reason, tools, ms}>. */
  probeMcpServer: (name) => ipcRenderer.invoke('mcp:probe', name),

  // --- Diagnostics tile: consolidated self-checks (mpv, claude, MCP usage) ---
  /** Fetches { rows:[...], status, issues }. Pass { rescan:true } to re-mine MCP usage. */
  getDiagnostics: (opts) => ipcRenderer.invoke('diag:report', opts),
  /**
   * Opens the mpv installation page in the browser. Like openClaudeDocs, it
   * takes no argument - the URL is hardcoded in main.js, so the renderer cannot
   * point the system browser at an arbitrary address.
   */
  openMpvDocs: () => ipcRenderer.send('diag:mpv-docs'),

  // --- Git station ---
  /** Fetches the watched repos: [{path, name, status, lastCommit, state, error}]. */
  getRepos: () => ipcRenderer.invoke('git:list'),
  /** Fetches one repo and re-reads it; Promise<{ok, error, repo}>. */
  fetchRepo: (dir) => ipcRenderer.invoke('git:fetch', dir),
  /** Walks the configured roots for repos and saves what it finds; Promise<string[]>. */
  scanRepos: () => ipcRenderer.invoke('git:scan'),
  /** Ctrl+G quick-menu: commit/push/fetch/status on the active tab's own repo. */
  gitQuickAction: (sessionId, action, message) =>
    ipcRenderer.invoke('git:quickAction', { sessionId, action, message }),

  // --- 7C: action cheat-sheets ---
  /** Fetches { groups: [{ title, note, commands: [{label, command}] }] }. */
  getCheatsheets: () => ipcRenderer.invoke('cheatsheets:list'),

  // --- 7A: skill cheat-sheet by category ---
  /** Fetches { categories: [{ name, skills: [{name, description}] }], total }. */
  getSkills: () => ipcRenderer.invoke('skills:list'),
  /** A5: forces a fresh scan of the skill directories, bypassing the cache. */
  rescanSkills: () => ipcRenderer.invoke('skills:rescan'),

  // --- Prompt library ---
  /** Fetches { groups: [{ title, note, prompts: [{label, text, note}] }] }. */
  getPrompts: () => ipcRenderer.invoke('prompts:list'),

  // --- Ctrl+B: recommended libraries & tools directory ---
  /** Fetches { categories: [{ title, items: [{id, name, url, description}] }], total }. */
  getLibraries: () => ipcRenderer.invoke('libraries:list'),
  /** Opens a catalog entry in the default browser. Takes the entry's ID, NOT a
   *  URL: main resolves the address from config/libraries.json itself, so this
   *  bridge cannot be used to open an arbitrary page (src/libraries.js header). */
  openLibrary: (id) => ipcRenderer.send('libraries:open', id),
  /** Sends a /ask question to Claude (headless, Sonnet), grounded in the current
   *  libraries catalog. Promise<{ok, summary, recommended, suggestions} | {ok:false, reason}>. */
  askLibraries: (question) => ipcRenderer.invoke('ask:query', question),
  /** "Add to my library": persists an /ask suggestion card into the local
   *  override. Payload: {name, url, description, category}.
   *  Promise<{ok, categories, total} | {ok:false, reason}>. */
  addLibraryItem: (item) => ipcRenderer.invoke('libraries:add', item),

  // --- Highlight extractor (batch clip trimmer) ---
  /** Checks whether ffmpeg is on PATH (not bundled). Promise<{ok, version}>. */
  getFfmpegStatus: () => ipcRenderer.invoke('highlights:ffmpeg-status'),
  /** Native folder picker for the source/output folder. `role` is 'source' or
   *  'output' (only changes the dialog's title/default path); returns the
   *  picked path or null (cancelled). */
  pickHighlightsFolder: (role) => ipcRenderer.invoke('highlights:pick-folder', role),
  /** Starts a batch tail-trim of every clip in sourceFolder into outputFolder.
   *  Payload: {sourceFolder, outputFolder, seconds, extensions}. Returns
   *  immediately (does not wait for the batch to finish); progress streams
   *  over onHighlightProgress. Promise<{ok, jobId, files} | {ok:false, reason}>. */
  runHighlightBatch: (payload) => ipcRenderer.invoke('highlights:run', payload),
  /** Cancels a running batch by job id (fire-and-forget). */
  cancelHighlightBatch: (jobId) => ipcRenderer.send('highlights:cancel', jobId),
  /** Registers a callback with per-file batch progress:
   *  {jobId, event, file?, index?, total?, reason?}. */
  onHighlightProgress: (callback) => {
    ipcRenderer.on('highlights:progress', (_e, payload) => callback(payload));
  },

  // --- Scratchpad (local notepad) ---
  /** Reads the scratchpad content; Promise<string> ('' when empty). */
  getScratchpad: () => ipcRenderer.invoke('scratchpad:read'),
  /** Writes the scratchpad content; Promise<boolean>. */
  saveScratchpad: (text) => ipcRenderer.invoke('scratchpad:write', text),

  // --- Session export (transcript -> Markdown) ---
  /** Renders the given tab's transcript (defaults to the active tab) to a .md
   *  file the user picks in a save dialog.
   *  Promise<{ok:true, path:string} | {ok:false, reason:string}>. */
  exportSession: (sessionId) => ipcRenderer.invoke('session:export', sessionId),

  // --- Clipboard history (opt-in; see src/clipboard.js) ---
  /** Registers a callback with the history: [{text, at}] (newest first). */
  onClipboard: (callback) => {
    ipcRenderer.on('clipboard:update', (_event, list) => callback(list));
  },
  /** Fetches { enabled: boolean, entries: [{text, at}] }. */
  getClipboardState: () => ipcRenderer.invoke('clipboard:state'),
  /** Turns the watcher on/off (persists the pref); Promise<{enabled, entries}>. */
  setClipboardEnabled: (enabled) => ipcRenderer.invoke('clipboard:enable', enabled),
  /** Puts a stored clip back on the system clipboard; Promise<boolean>. */
  copyClipboardEntry: (text) => ipcRenderer.invoke('clipboard:copy', text),
  /** Drops one clip; Promise with the remaining list. */
  removeClipboardEntry: (text) => ipcRenderer.invoke('clipboard:remove', text),
  /** Drops the whole history (and its file); Promise with the empty list. */
  clearClipboard: () => ipcRenderer.invoke('clipboard:clear'),

  // --- Pin-board todos (one list per project) ---
  /** Fetches the named (or active) tab's project list: [{text, done, at}]. */
  getTodos: (sessionId) => ipcRenderer.invoke('todo:read', sessionId),
  /** Writes that project's whole list; Promise<boolean>. */
  saveTodos: (list, sessionId) => ipcRenderer.invoke('todo:write', list, sessionId),

  // --- God Mode (unattended to-do runner, see reference/GODMODE_PLAN.md) ---
  /** Usage-limit / connection-drop signal from a session's raw stdout: ({ sessionId, type }). */
  onGodModeSignal: (callback) => {
    ipcRenderer.on('godmode:signal', (_event, payload) => callback(payload));
  },
  /** Native "are you sure" popup gating every arm; resolves true only on an explicit Yes. */
  confirmGodMode: (openCount) => ipcRenderer.invoke('godmode:confirm', openCount),

  // --- Device panel: microphone mute ---
  /**
   * Reads or changes the default mic's mute state.
   * action: 'get' | 'toggle' | 'mute' | 'unmute'.
   * Promise resolves { muted, available } or null when there is no mic.
   */
  micState: (action) => ipcRenderer.invoke('devices:mic', action),

  // --- Usage meter (5h + week) ---
  /** Registers a callback with usage state: {fiveHour, sevenDay, ...} or {error}. */
  onUsage: (callback) => {
    ipcRenderer.on('usage:update', (_event, usage) => callback(usage));
  },
  /** Forces a usage refresh; Promise with the fresh state. */
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),

  // --- E1: machine telemetry (RAM / CPU / uptime) ---
  /**
   * Registers a callback with a sample:
   * { at, mem:{total,free,used,percent}|null, cpu:{percent|null,cores,speedMhz|null},
   *   uptime:number|null, load:[1,5,15]|null }.
   * A one-way stream - the renderer never polls the machine itself.
   */
  onTelemetry: (callback) => {
    ipcRenderer.on('telemetry:update', (_event, payload) => callback(payload));
  },

  // --- Media Deck: now-playing (GSMTC) + system volume ---
  /**
   * Registers a callback with a now-playing sample:
   * {title, artist, appId, isPlaying} | null (nothing currently playing).
   */
  onMedia: (callback) => {
    ipcRenderer.on('media:update', (_event, state) => callback(state));
  },
  /**
   * Sends one play/pause/skip/volume command.
   * {type:'transport', action:'play'|'pause'|'toggle'|'next'|'prev'} or
   * {type:'volume', action:'get'|'set'|'mute', value?:number}.
   * Promise resolves with the resulting state (or a boolean for transport).
   */
  mediaCommand: (payload) => ipcRenderer.invoke('media:command', payload),

  // --- D3: whether Claude Code is installed at all ---
  /** Fetches { found: boolean, path: string|null }. */
  getClaudeStatus: () => ipcRenderer.invoke('claude:status'),
  /**
   * Opens the official installation instructions in the browser.
   * Deliberately takes no argument - the address is hardcoded in main.js, so
   * the renderer cannot point at an arbitrary URL to open in the system browser.
   */
  openClaudeDocs: () => ipcRenderer.send('claude:docs'),

  // --- D5: updates (notify, user clicks) ---
  /**
   * Registers a callback with the update state:
   * { state, info: {version, releaseDate, url}|null, percent, error, reason }
   * where state = idle|checking|none|available|downloading|ready|error|unsupported.
   */
  onUpdateState: (callback) => {
    ipcRenderer.on('update:state', (_event, state) => callback(state));
  },
  /** Replays the last known state (+ the app's current version); Promise. */
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  /** Manual check for a newer version. Downloads nothing. */
  checkUpdate: () => ipcRenderer.send('update:check'),
  /** User's consent to DOWNLOAD the update. */
  downloadUpdate: () => ipcRenderer.send('update:download'),
  /** Consent to restart and install the downloaded update. */
  installUpdate: () => ipcRenderer.send('update:install'),
  /**
   * Opens the release page in the browser.
   * Deliberately takes no argument - the address is built in main.js (see openClaudeDocs).
   */
  openReleases: () => ipcRenderer.send('update:open-releases'),

  // --- Themes + UI preferences (theme/language) ---
  /** Fetches { themes: [{id,label,vars,terminal}] }. */
  getThemes: () => ipcRenderer.invoke('themes:list'),
  // --- C1: HUD layout presets ---
  /** Fetches { layouts: [{id,label,columns,rows,areas,regionOrder,chrome,slots}], activeLayout }. */
  getLayouts: () => ipcRenderer.invoke('layouts:list'),
  /** Fetches the remembered preferences { theme, lang }. */
  getUiPrefs: () => ipcRenderer.invoke('ui:get'),
  /** Writes partial preferences { theme?, lang? }; returns the new state. */
  setUiPrefs: (partial) => ipcRenderer.invoke('ui:set', partial),
  /**
   * Opens the native terminal background image picker; reads the file IN MAIN
   * (the renderer has no fs access) and returns { dataUrl } (CSP: only
   * data:/'self' in img-src), { error: 'tooLarge' | 'unsupported' }, or null
   * on cancel.
   */
  pickTermBgImage: () => ipcRenderer.invoke('termcustom:pickBgImage'),

  // --- ACTION INJECTOR: renderer -> stdin PTY ---
  /**
   * Pastes multi-line text (bracketed paste) into the session.
   * @param {string} text prompt content
   * @param {boolean} [submit=false] whether to send it right away (append Enter)
   */
  // All injectors accept an optional sessionId. Omitting it targets the active
  // tab - exactly the one the user is looking at.
  pastePrompt: (text, submit = false, sessionId) =>
    ipcRenderer.send('pty:paste', { text, submit, sessionId }),
  /**
   * Saves an image that was PASTED over a terminal pane and pastes its path
   * into the session (Claude Code reads a screenshot by path, not by bitmap).
   *
   * invoke, not send, so the renderer can tell a failed save from a successful
   * one - see src/screenshots.js for why a save can legitimately fail.
   *
   * @param {Uint8Array} bytes the pasted image, straight off the paste event
   * @param {string} mime e.g. 'image/png'
   * @param {string} [sessionId] the tab that was pasted into
   * @returns {Promise<{ok: boolean, path?: string}>}
   */
  pasteScreenshot: (bytes, mime, sessionId) =>
    ipcRenderer.invoke('pty:screenshot', { bytes, mime, sessionId }),
  /** Raw keyboard input (xterm.js onData) into a given tab's PTY. */
  write: (data, sessionId) => ipcRenderer.send('pty:write', { data, sessionId }),
  /** A ready-made command from a GUI button (appends Enter). E.g. runCommand('/compact'). */
  runCommand: (text, sessionId) => ipcRenderer.send('pty:command', { text, sessionId }),
  /** Matches the PTY size to a tab's terminal column/row count. */
  resize: (cols, rows, sessionId) =>
    ipcRenderer.send('pty:resize', { cols, rows, sessionId }),

  // --- Sound feedback ---
  /**
   * Fires a UI sound/voice cue by key, e.g. 'sfx.navClick', 'voice.done'.
   * @param {string} key
   * @param {{variant?: string}} [opts] variant: for 'sfx.keystroke', which of
   *   the 4 clips to play (id from config/sounds.json's variants list).
   */
  playSound: (key, opts) => ipcRenderer.send('sound:play', { key, opts }),
  /** Raw bytes of one file in assets/keysounds/ (keysynth.js's sample
   * engine) - the renderer's CSP blocks fetch() outright, so this goes
   * through the main process like every other local resource. Resolves to
   * null if the file is missing. */
  readKeysound: (name) => ipcRenderer.invoke('keysynth:read', name),
});
