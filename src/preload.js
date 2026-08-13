// ============================================================================
// LunaCore - preload (bezpieczny most IPC)
// ----------------------------------------------------------------------------
// Dziala w izolowanym kontekscie miedzy procesem glownym a rendererem.
// Udostepnia stronie TYLKO waskie, jawne API `window.lunacore` - renderer
// nie dostaje bezposredniego dostepu do Node.js ani ipcRenderer.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lunacore', {
  // --- PASSIVE OBSERVER: strumien stdout PTY -> renderer ---
  // UWAGA: od wersji z zakladkami kazde zdarzenie niesie sessionId. Renderer
  // trzyma osobny bufor xterm na zakladke, wiec musi wiedziec, czyje to dane -
  // inaczej wyjscie sesji w tle wsypaloby sie do terminala, na ktory patrzysz.
  /** Porcja danych z terminala: ({ sessionId, data }). */
  onData: (callback) => {
    ipcRenderer.on('pty:data', (_event, payload) => callback(payload));
  },
  /** Zakonczenie procesu PTY danej zakladki: ({ sessionId, code }). */
  onExit: (callback) => {
    ipcRenderer.on('pty:exit', (_event, payload) => callback(payload));
  },

  // --- PASSIVE OBSERVER: metryki Fazy 3 (tylko odczyt) ---
  /** Metryki context window: ({ sessionId, metrics: {tokens,limit,percent} }). */
  onContext: (callback) => {
    ipcRenderer.on('metrics:context', (_event, payload) => callback(payload));
  },
  /** Kafelki Skill Trackera do zapalenia: ({ sessionId, tiles: ["Shell",...] }). */
  onTools: (callback) => {
    ipcRenderer.on('metrics:tools', (_event, payload) => callback(payload));
  },

  // --- Zakladki (multi-sesja) ---
  /** Pobiera { sessions: [{id,profileId,profileLabel,folder,alive}], activeSessionId }. */
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  /** Zmiana listy zakladek lub aktywnej: ({ sessions, activeSessionId }). */
  onSessions: (callback) => {
    ipcRenderer.on('sessions:update', (_event, payload) => callback(payload));
  },
  /** Nowa zakladka (domyslnie biezacy profil + projekt). */
  createSession: (opts = {}) => ipcRenderer.send('sessions:create', opts),
  /** Zamyka zakladke; ostatnia jest zastepowana swieza, nie usuwana w pustke. */
  closeSession: (sessionId) => ipcRenderer.send('sessions:close', sessionId),
  /** Pokazuje wybrana zakladke. Procesy pozostalych zyja dalej w tle. */
  activateSession: (sessionId) => ipcRenderer.send('sessions:activate', sessionId),

  // --- FAZA 4: profile uruchomieniowe ---
  /** Pobiera { profiles, activeProfile } do wypelnienia przelacznika. */
  getProfiles: () => ipcRenderer.invoke('profiles:list'),
  /** Przelacza profil -> restart TEJ zakladki; pozostale zostaja nietkniete. */
  switchProfile: (id, sessionId) =>
    ipcRenderer.send('pty:restart', { profileId: id, sessionId }),
  /** Restart sesji: ({ sessionId, id, label, folder }). */
  onRestarted: (callback) => {
    ipcRenderer.on('pty:restarted', (_event, profile) => callback(profile));
  },

  // --- Przelacznik projektu (katalog roboczy) ---
  /** Pobiera { projects, activeProject } do wypelnienia przelacznika. */
  getProjects: () => ipcRenderer.invoke('projects:list'),
  /** Przelacza katalog roboczy -> restart TEJ zakladki w nowym folderze. */
  switchProject: (id, sessionId) =>
    ipcRenderer.send('pty:switch-project', { projectId: id, sessionId }),
  /** Natywny wybor folderu; zwraca sciezke albo null (anulowano). */
  pickProjectFolder: () => ipcRenderer.invoke('projects:pick-folder'),
  /** Dopisuje nowy projekt do projects.local.json; zwraca { projects, activeProject } albo null. */
  addProject: (entry) => ipcRenderer.invoke('projects:add', entry),

  // --- Active-Files Heatmap: czy plik nadal istnieje na dysku ---
  /** Sprawdza fs.existsSync dla listy sciezek; zwraca { [path]: boolean }. */
  checkFilesExist: (paths) => ipcRenderer.invoke('files:check-exist', paths),

  // --- 7B: tracker portow localhost ---
  /** Lista nasluchujacych portow: [{ port, procId, name }]. */
  onPorts: (callback) => {
    ipcRenderer.on('ports:update', (_event, ports) => callback(ports));
  },
  /** Otwiera http://localhost:PORT w przegladarce. */
  openPort: (port) => ipcRenderer.send('ports:open', port),
  /** Ubija proces po PID; zwraca Promise<boolean>. */
  killPort: (pid) => ipcRenderer.invoke('ports:kill', pid),

  // --- 7C: sciagawki akcji ---
  /** Pobiera { groups: [{ title, note, commands: [{label, command}] }] }. */
  getCheatsheets: () => ipcRenderer.invoke('cheatsheets:list'),

  // --- 7A: sciagawka skilli wg kategorii ---
  /** Pobiera { categories: [{ name, skills: [{name, description}] }], total }. */
  getSkills: () => ipcRenderer.invoke('skills:list'),
  /** A5: wymusza swiezy skan katalogow skilli, pomijajac cache. */
  rescanSkills: () => ipcRenderer.invoke('skills:rescan'),

  // --- Biblioteka promptow ---
  /** Pobiera { groups: [{ title, note, prompts: [{label, text, note}] }] }. */
  getPrompts: () => ipcRenderer.invoke('prompts:list'),

  // --- Brudnopis (lokalny notatnik) ---
  /** Wczytuje tresc brudnopisu; Promise<string> ('' gdy pusty). */
  getScratchpad: () => ipcRenderer.invoke('scratchpad:read'),
  /** Zapisuje tresc brudnopisu; Promise<boolean>. */
  saveScratchpad: (text) => ipcRenderer.invoke('scratchpad:write', text),

  // --- Licznik zuzycia limitow (5h + tydzien) ---
  /** Rejestruje callback ze stanem zuzycia: {fiveHour, sevenDay, ...} lub {error}. */
  onUsage: (callback) => {
    ipcRenderer.on('usage:update', (_event, usage) => callback(usage));
  },
  /** Wymusza odswiezenie zuzycia; Promise ze swiezym stanem. */
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),

  // --- E1: telemetria maszyny (RAM / CPU / uptime) ---
  /**
   * Rejestruje callback z probka:
   * { at, mem:{total,free,used,percent}|null, cpu:{percent|null,cores,speedMhz|null},
   *   uptime:number|null, load:[1,5,15]|null }.
   * Jednokierunkowy strumien - renderer nigdy nie odpytuje maszyny sam.
   */
  onTelemetry: (callback) => {
    ipcRenderer.on('telemetry:update', (_event, payload) => callback(payload));
  },

  // --- D3: czy Claude Code jest w ogole zainstalowane ---
  /** Pobiera { found: boolean, path: string|null }. */
  getClaudeStatus: () => ipcRenderer.invoke('claude:status'),
  /**
   * Otwiera oficjalna instrukcje instalacji w przegladarce.
   * Bez argumentu celowo - adres jest zaszyty w main.js, wiec renderer nie moze
   * wskazac dowolnego URL-a do otwarcia w systemowej przegladarce.
   */
  openClaudeDocs: () => ipcRenderer.send('claude:docs'),

  // --- D5: aktualizacje (powiadom, uzytkownik klika) ---
  /**
   * Rejestruje callback ze stanem aktualizacji:
   * { state, info: {version, releaseDate, url}|null, percent, error, reason }
   * gdzie state = idle|checking|none|available|downloading|ready|error|unsupported.
   */
  onUpdateState: (callback) => {
    ipcRenderer.on('update:state', (_event, state) => callback(state));
  },
  /** Odgrywa ostatni znany stan (+ biezaca wersje aplikacji); Promise. */
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  /** Reczne sprawdzenie dostepnosci nowej wersji. Nic nie pobiera. */
  checkUpdate: () => ipcRenderer.send('update:check'),
  /** Zgoda uzytkownika na POBRANIE aktualizacji. */
  downloadUpdate: () => ipcRenderer.send('update:download'),
  /** Zgoda na restart i instalacje pobranej aktualizacji. */
  installUpdate: () => ipcRenderer.send('update:install'),
  /**
   * Otwiera strone wydania w przegladarce.
   * Bez argumentu celowo - adres sklada main.js (patrz openClaudeDocs).
   */
  openReleases: () => ipcRenderer.send('update:open-releases'),

  // --- Motywy + preferencje UI (motyw/jezyk) ---
  /** Pobiera { themes: [{id,label,vars,terminal}] }. */
  getThemes: () => ipcRenderer.invoke('themes:list'),
  // --- C1: presety ukladu HUD ---
  /** Pobiera { layouts: [{id,label,columns,rows,areas,regionOrder,chrome,slots}], activeLayout }. */
  getLayouts: () => ipcRenderer.invoke('layouts:list'),
  /** Pobiera zapamietane preferencje { theme, lang }. */
  getUiPrefs: () => ipcRenderer.invoke('ui:get'),
  /** Zapisuje czesciowe preferencje { theme?, lang? }; zwraca nowy stan. */
  setUiPrefs: (partial) => ipcRenderer.invoke('ui:set', partial),
  /**
   * Otwiera natywny picker obrazu tla terminala; czyta plik W MAIN (renderer
   * nie ma dostepu do fs) i zwraca { dataUrl } (CSP: tylko data:/'self' w
   * img-src), { error: 'tooLarge' | 'unsupported' }, lub null przy anulowaniu.
   */
  pickTermBgImage: () => ipcRenderer.invoke('termcustom:pickBgImage'),

  // --- ACTION INJECTOR: renderer -> stdin PTY ---
  /**
   * Wkleja wielolinijkowy tekst (bracketed paste) do sesji.
   * @param {string} text tresc prompta
   * @param {boolean} [submit=false] czy od razu wyslac (dopisac Enter)
   */
  // Wszystkie wstrzykiwacze przyjmuja opcjonalne sessionId. Pominiecie go trafia
  // do zakladki aktywnej - czyli dokladnie tam, na co uzytkownik patrzy.
  pastePrompt: (text, submit = false, sessionId) =>
    ipcRenderer.send('pty:paste', { text, submit, sessionId }),
  /** Surowe wejscie z klawiatury (xterm.js onData) do PTY danej zakladki. */
  write: (data, sessionId) => ipcRenderer.send('pty:write', { data, sessionId }),
  /** Gotowa komenda z przycisku GUI (dopisze Enter). Np. runCommand('/compact'). */
  runCommand: (text, sessionId) => ipcRenderer.send('pty:command', { text, sessionId }),
  /** Dopasowanie rozmiaru PTY do liczby kolumn/wierszy terminala zakladki. */
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
});
