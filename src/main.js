// ============================================================================
// LunaCore - proces glowny Electrona (main process)
// ----------------------------------------------------------------------------
// Odpowiada za:
//   * utworzenie okna aplikacji,
//   * uruchomienie pseudoterminala (node-pty) z powloka systemowa + `claude`,
//   * most IPC: renderer <-> PTY (Action Injector + Passive Observer).
//
// ZASADA "ZERO DODATKOWYCH TOKENOW":
//   Ten plik NIE wstrzykuje zadnych ukrytych promptow. Jedynie:
//   - przekazuje surowe wejscie uzytkownika (klawiatura + przyciski) do stdin PTY,
//   - odsyla surowy strumien stdout PTY do renderera do wyswietlenia/parsowania.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
// @lydell/node-pty: utrzymywany fork node-pty z prebuildami (N-API),
// dziala bez kompilacji node-gyp / Visual Studio. API zgodne z node-pty.
const pty = require('@lydell/node-pty');
// Passive Observer (Faza 3): detekcja narzedzi ze stdout + tailowanie
// transcriptu JSONL po realne zuzycie context window. Tylko czyta, zero tokenow.
const { detectTools, TranscriptWatcher } = require('./observer');
// Profile uruchomieniowe (Faza 4): definicje "jak wystartowac sesje" z JSON.
const { loadProfiles, getProfile } = require('./profiles');
// Przelacznik projektu: katalogi robocze (cwd) sesji z config/projects.json.
const { loadProjects, getProject } = require('./projects');
// Tracker portow localhost (7B): pasywny skan nasluchujacych portow + kill.
const { killProcess, PortWatcher } = require('./ports');
// Sciagawki akcji (7C): grupy komend wysylanych przez Action Injector.
const { loadCheatsheets } = require('./cheatsheets');
// Sciagawka skilli (7A): auto-skan katalogow skilli -> kategorie.
const { loadSkills } = require('./skills');
// Biblioteka promptow: wielolinijkowe prompty do wielokrotnego uzycia.
const { loadPrompts } = require('./prompts');
// Brudnopis: lokalny notatnik trzymany jako zwykly plik tekstowy.
const { readScratchpad, writeScratchpad } = require('./scratchpad');
// Motywy (theming): mapy tokenow CSS + kolory xterm z config/themes.json.
const { loadThemes } = require('./theme');
// Preferencje UI (motyw + jezyk) trwale w config/ui.local.json.
const { readUiPrefs, writeUiPrefs } = require('./uiprefs');
// Licznik zuzycia limitow (5h + tydzien) - odczyt GET z endpointu OAuth CLI.
const { fetchUsage, UsageWatcher } = require('./usage');

// ---- Konfiguracja -----------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

// Licznik zuzycia limitow subskrypcji. Ustaw false, by CALKOWICIE wylaczyc
// zapytania sieciowe do endpointu usage (kafelek pokaze wtedy stan 'off').
const ENABLE_USAGE_METER = true;

// Domyslna powloka dla danego systemu.
const DEFAULT_SHELL = IS_WINDOWS
  ? 'powershell.exe'
  : process.env.SHELL || 'bash';

// Domyslny (awaryjny) katalog startowy sesji - domowy uzytkownika. Realny cwd
// trzyma mutowalne `activeCwd` ponizej i zmienia je przelacznik projektu.
const START_CWD = os.homedir();

/**
 * Zwraca sciezke, jesli to istniejacy katalog; inaczej katalog domowy.
 * Chroni pty.spawn przed rzuceniem, gdy projekt wskazuje nieistniejacy folder
 * (np. repo jest tylko na innej maszynie - LunaCore ma byc przenosne).
 * @param {string} dir
 */
function safeCwd(dir) {
  try {
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* nie istnieje / brak dostepu */
  }
  return START_CWD;
}

// ---- Stan globalny ----------------------------------------------------------

/**
 * Sesja = jedna zakladka: wlasny PTY, wlasny profil, wlasny katalog roboczy i
 * WLASNY TranscriptWatcher. To ostatnie jest istota trybu wielosesyjnego - przy
 * dwoch zywych sesjach globalny watcher pokazywalby metryki tej, w ktorej cos
 * ostatnio drgnelo, czyli cudze liczby w pasku kontekstu.
 *
 * @typedef {{
 *   id: string, proc: import('node-pty').IPty|null, profileId: string,
 *   projectId: string|null, cwd: string, size: {cols:number,rows:number},
 *   watcher: TranscriptWatcher|null, alive: boolean
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {string|null} id sesji pokazywanej w oknie */
let activeSessionId = null;
let sessionSeq = 0;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {PortWatcher | null} */
let portWatcher = null;
/** @type {UsageWatcher | null} */
let usageWatcher = null;
// Profile wczytane z config/ oraz id domyslnego (dla nowych sesji).
let profiles = [];
let activeProfileId = null;
// Projekty (katalogi robocze) wczytane z config/ + id domyslnego i realny cwd.
let projects = [];
let activeProjectId = null;
let activeCwd = START_CWD;
// Ostatni znany rozmiar terminala - punkt startowy dla nowo tworzonych sesji.
let lastSize = { cols: 80, rows: 24 };

/** Sesja aktualnie pokazywana w oknie (lub null). */
function activeSession() {
  return activeSessionId ? sessions.get(activeSessionId) || null : null;
}

/**
 * Rozwiazuje sesje z payloadu IPC. Brak/nieznane id => sesja aktywna, dzieki
 * czemu wywolanie bez sessionId zachowuje sie jak w wersji jednosesyjnej.
 * @param {unknown} sessionId
 */
function resolveSession(sessionId) {
  if (typeof sessionId === 'string' && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }
  return activeSession();
}

/** Wysyla zdarzenie do renderera, jesli okno zyje. */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Serializowalny opis sesji dla renderera (bez uchwytow procesu). */
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

/** Rozsyla pelna liste zakladek + wskazanie aktywnej. */
function broadcastSessions() {
  send('sessions:update', {
    sessions: [...sessions.values()].map(sessionSummary),
    activeSessionId,
  });
}

// ---- Okno aplikacji ---------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0a0710', // ciemne tlo zanim wczyta sie CSS (bez bialego blysku)
    title: 'LunaCore',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Bezpieczne domyslne ustawienia: renderer nie ma bezposredniego dostepu
      // do Node.js. Cala komunikacja idzie przez most contextBridge w preload.js.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload musi miec dostep do ipcRenderer
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- Pseudoterminal (node-pty) ----------------------------------------------

/**
 * Startuje sesje PTY wg wybranego profilu: spawnuje powloke z nadpisaniami env
 * i (jesli profil ma komende, np. "claude") wpisuje ja po krotkim opoznieniu.
 * @param {{id:string,label:string,command:string,args:string[],env:Object}} profile
 */
/**
 * Native install Claude Code laduje sie do ~/.local/bin, a instalator nie zawsze
 * dodaje ten katalog do PATH. Jesli lezy tam binarka `claude`, dopisujemy katalog
 * na poczatek PATH spawnowanej sesji - dzieki temu auto-start profilu, wpisanie
 * `claude` i sciagawki dzialaja bez recznego podawania pelnej sciezki.
 * @param {Record<string,string>} env
 */
function withClaudeOnPath(env) {
  try {
    const binDir = path.join(os.homedir(), '.local', 'bin');
    const exe = path.join(binDir, IS_WINDOWS ? 'claude.exe' : 'claude');
    if (!fs.existsSync(exe)) return env;
    // Na Windows zmienna PATH bywa jako "Path" - znajdz istniejacy klucz.
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const sep = IS_WINDOWS ? ';' : ':';
    const parts = (env[key] || '').split(sep);
    if (!parts.some((p) => p.toLowerCase() === binDir.toLowerCase())) {
      env[key] = binDir + sep + (env[key] || '');
    }
  } catch {
    /* nie blokuj startu sesji, gdyby cokolwiek poszlo nie tak */
  }
  return env;
}

/**
 * Gdy LunaCore samo zostalo uruchomione z wnetrza sesji Claude Code (np. `npm
 * start` odpalone z terminala Claude), proces dziedziczy markery sesji w env:
 * CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID itd. Zagniezdzony
 * `claude` widzi je i startuje jako "child session" -> WYLACZA zapis transkryptu
 * ("transcript saving is off - inherited claude_code_child_session marker").
 * A bez transkryptu nie dziala pasek Context Window ani sparkline (czytaja JSONL).
 * Czyscimy wiec markery, by sesja w LunaCore byla zawsze pelnoprawna, top-level -
 * niezaleznie od tego, skad LunaCore odpalono. Nie ruszamy configu (ANTHROPIC_*).
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
 * Podpina PTY + TranscriptWatcher do istniejacego rekordu sesji. Wydzielone,
 * bo uzywa tego zarowno tworzenie zakladki, jak i restart pod nowym profilem
 * lub katalogiem - zawsze tak samo.
 * @param {Session} session
 * @param {{id:string,label:string,command:string,args:string[],env:Object}} profile
 */
function spawnInto(session, profile) {
  // Nadpisania srodowiska z profilu (np. ANTHROPIC_BASE_URL dla LM Studio),
  // czyszczenie markerow sesji-rodzica (transkrypt!) + gwarancja, ze `claude`
  // z ~/.local/bin jest na PATH sesji.
  const env = withClaudeOnPath(
    stripClaudeSessionMarkers({ ...process.env, ...(profile.env || {}) }),
  );

  const cwd = safeCwd(session.cwd);
  session.cwd = cwd;
  session.profileId = profile.id;

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: session.size.cols,
    rows: session.size.rows,
    cwd,
    env,
  });
  session.proc = proc;
  session.alive = true;

  // PASSIVE OBSERVER: surowy stdout tej sesji -> renderer + detekcja narzedzi.
  // Kazde zdarzenie niesie sessionId, bo renderer trzyma osobny bufor na zakladke.
  proc.onData((data) => {
    send('pty:data', { sessionId: session.id, data });
    const tiles = detectTools(data);
    if (tiles.length > 0) send('metrics:tools', { sessionId: session.id, tiles });
  });

  // Guard: ignorujemy exit procesu juz odpietego od sesji (restart profilu /
  // zamkniecie zakladki), zeby nie wyslac falszywego "sesja zakonczona".
  proc.onExit(({ exitCode }) => {
    if (session.proc !== proc) return;
    session.proc = null;
    session.alive = false;
    send('pty:exit', { sessionId: session.id, code: exitCode });
    broadcastSessions();
  });

  // Wlasny watcher transcriptu, zawezony do katalogu tej sesji.
  if (session.watcher) session.watcher.stop();
  session.watcher = new TranscriptWatcher(
    (metrics) => send('metrics:context', { sessionId: session.id, metrics }),
    { cwd },
  );
  session.watcher.start();

  // Wpisz komende startowa profilu (pusta = sama powloka, bez auto-startu).
  // PTY buforuje wejscie, wiec komenda wykona sie, gdy powloka bedzie gotowa.
  const command = [profile.command, ...(profile.args || [])].join(' ').trim();
  if (command) {
    setTimeout(() => {
      if (session.proc === proc) proc.write(`${command}\r`);
    }, 600);
  }
}

/**
 * Tworzy nowa zakladke i czyni ja aktywna.
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
    alive: false,
  };

  sessions.set(session.id, session);
  spawnInto(session, profile);
  activeSessionId = session.id;
  broadcastSessions();
  return session;
}

/** Ubija proces i watcher sesji, nie usuwajac jej z mapy. */
function teardownSession(session) {
  if (session.watcher) {
    session.watcher.stop();
    session.watcher = null;
  }
  if (session.proc) {
    const old = session.proc;
    session.proc = null; // odpinamy, zeby onExit sie zignorowal
    try {
      old.kill();
    } catch {
      /* proces mogl juz nie zyc */
    }
  }
  session.alive = false;
}

/**
 * Zamyka zakladke. Ostatniej nie usuwamy w pustke - od razu tworzymy swiaza,
 * zeby okno nigdy nie zostalo bez terminala.
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
 * Restart JEDNEJ sesji pod (byc moze innym) profilem i katalogiem.
 * Renderer dostaje 'pty:restarted' i czysci bufor tej zakladki.
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

/** Wczytuje projekty z config/ i ustawia aktywny katalog roboczy (cwd). */
function startActiveProjects() {
  const loaded = loadProjects();
  projects = loaded.projects;
  const proj = getProject(projects, loaded.activeProject) || projects[0];
  if (proj) {
    activeProjectId = proj.id;
    activeCwd = proj.path;
  }
}

/** Wczytuje profile i otwiera pierwsza zakladke (przy starcie aplikacji). */
function startActiveProfile() {
  const loaded = loadProfiles();
  profiles = loaded.profiles;
  const profile = getProfile(profiles, loaded.activeProfile) || profiles[0];
  if (profile) activeProfileId = profile.id;
  createSession();
}

// ---- Passive Observer: porty localhost (7B) ---------------------------------

function startPortWatcher() {
  portWatcher = new PortWatcher((ports) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ports:update', ports);
    }
  });
  portWatcher.start();
}

// ---- Passive Observer: zuzycie limitow subskrypcji (5h + tydzien) -----------

function startUsageWatcher() {
  if (!ENABLE_USAGE_METER) return;
  usageWatcher = new UsageWatcher((usage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage:update', usage);
    }
  });
  usageWatcher.start();
}

// ---- Kanaly IPC -------------------------------------------------------------

function registerIpc() {
  // ACTION INJECTOR (klawiatura): surowe wejscie z xterm.js -> stdin PTY.
  // Payload: { sessionId?, data } - brak sessionId trafia do sesji aktywnej.
  ipcMain.on('pty:write', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { data: payload };
    const session = resolveSession(p.sessionId);
    if (session && session.proc) session.proc.write(p.data);
  });

  // ACTION INJECTOR (przyciski GUI): wysyla gotowa komende + Enter (\r).
  // To wlasnie tego uzywa przycisk COMPACT CONTEXT -> "/compact".
  ipcMain.on('pty:command', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { text: payload };
    const session = resolveSession(p.sessionId);
    if (!session || !session.proc || typeof p.text !== 'string') return;
    const line = p.text.endsWith('\r') ? p.text : `${p.text}\r`;
    session.proc.write(line);
  });

  // ACTION INJECTOR (biblioteka promptow): wkleja WIELOLINIJKOWY tekst.
  //
  // Dlaczego nie zwykly write(): w TUI Claude Code kazdy "\r"/"\n" to Enter,
  // wiec wielolinijkowy prompt wyslany surowo zostalby wyslany po pierwszej
  // linii (reszta poszlaby jako osobne wiadomosci). Uzywamy wiec bracketed
  // paste mode (ESC[200~ ... ESC[201~) - terminalowy standard sygnalizujacy
  // "to jest wklejka, nie klawisze". TUI wstawia calosc do bufora wejscia,
  // zachowujac lamania linii i NIE wysylajac.
  //
  // { text: string, submit?: boolean } - submit dopiero dopisuje Enter.
  ipcMain.on('pty:paste', (_event, payload) => {
    const session = resolveSession(payload && payload.sessionId);
    if (!session || !session.proc || !payload || typeof payload.text !== 'string') return;
    // Normalizacja koncow linii: w bufor wejscia wchodza wylacznie "\n".
    const text = payload.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    session.proc.write(`\x1b[200~${text}\x1b[201~`);
    if (payload.submit) session.proc.write('\r');
  });

  // Dopasowanie rozmiaru PTY do rozmiaru terminala w oknie (xterm-addon-fit).
  // Rozmiar zapamietujemy per sesja - kazda zakladka ma wlasny bufor xterm.
  ipcMain.on('pty:resize', (_event, size) => {
    if (!size) return;
    const cols = Math.max(1, size.cols | 0);
    const rows = Math.max(1, size.rows | 0);
    lastSize = { cols, rows }; // punkt startowy dla kolejnych zakladek
    const session = resolveSession(size.sessionId);
    if (!session) return;
    session.size = { cols, rows };
    if (session.proc) session.proc.resize(cols, rows);
  });

  // ---- Zakladki (multi-sesja) ----------------------------------------------

  ipcMain.handle('sessions:list', () => ({
    sessions: [...sessions.values()].map(sessionSummary),
    activeSessionId,
  }));

  // Nowa zakladka: domyslnie ten sam profil i projekt co aktualnie wybrane.
  ipcMain.on('sessions:create', (_event, opts) => {
    createSession(opts && typeof opts === 'object' ? opts : {});
  });

  ipcMain.on('sessions:close', (_event, sessionId) => {
    if (typeof sessionId === 'string') closeSession(sessionId);
  });

  // Przelaczenie widocznej zakladki. Procesy pozostalych zyja dalej w tle -
  // to jest caly sens zakladek: dlugi bieg w jednej, praca w drugiej.
  ipcMain.on('sessions:activate', (_event, sessionId) => {
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) return;
    activeSessionId = sessionId;
    broadcastSessions();
  });

  // FAZA 4: renderer pyta o dostepne profile (do wypelnienia przelacznika).
  ipcMain.handle('profiles:list', () => ({ profiles, activeProfile: activeProfileId }));

  // FAZA 4: przelaczenie profilu -> restart TEJ zakladki z nowym srodowiskiem.
  // Pozostale zakladki zostaja nietkniete; profil jest cecha sesji, nie aplikacji.
  ipcMain.on('pty:restart', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { profileId: payload };
    const session = resolveSession(p.sessionId);
    if (!session || typeof p.profileId !== 'string') return;
    activeProfileId = p.profileId; // domyslny profil dla kolejnych zakladek
    restartSession(session, { profileId: p.profileId });
  });

  // Przelacznik projektu: renderer pobiera liste katalogow roboczych.
  ipcMain.handle('projects:list', () => ({ projects, activeProject: activeProjectId }));

  // Przelaczenie projektu -> zmiana cwd + restart sesji z BIEZACYM profilem.
  // (Ten sam mechanizm restartu co profil; rozni sie tylko katalogiem startowym.)
  ipcMain.on('pty:switch-project', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { projectId: payload };
    const proj = getProject(projects, p.projectId);
    const session = resolveSession(p.sessionId);
    if (!proj || !session) return;
    activeCwd = proj.path; // domyslny katalog dla kolejnych zakladek
    activeProjectId = proj.id;
    restartSession(session, { projectId: proj.id });
  });

  // 7B: otworz http://localhost:PORT w domyslnej przegladarce.
  ipcMain.on('ports:open', (_event, port) => {
    const p = port | 0;
    if (p > 0 && p <= 65535) shell.openExternal(`http://localhost:${p}`);
  });

  // 7B: ubij proces po PID (na wyrazne klikniecie usera) + odswiez liste.
  ipcMain.handle('ports:kill', async (_event, pid) => {
    const ok = await killProcess(pid);
    if (ok && portWatcher) portWatcher.refresh();
    return ok;
  });

  // 7C: renderer pobiera grupy sciagawek do zbudowania zwijek + przyciskow.
  ipcMain.handle('cheatsheets:list', () => loadCheatsheets());

  // 7A: renderer pobiera skille pogrupowane w kategorie (wynik cache'owany).
  ipcMain.handle('skills:list', () => loadSkills());

  // Biblioteka promptow: grupy wielolinijkowych promptow do wklejenia.
  ipcMain.handle('prompts:list', () => loadPrompts());

  // Brudnopis: odczyt i zapis lokalnego notatnika (walidacja w scratchpad.js).
  ipcMain.handle('scratchpad:read', () => readScratchpad());
  ipcMain.handle('scratchpad:write', (_event, text) => writeScratchpad(text));

  // Motywy: lista dostepnych motywow (tokeny CSS + kolory xterm).
  ipcMain.handle('themes:list', () => loadThemes());

  // Preferencje UI: odczyt {theme, lang} i zapis czesciowy (zwraca nowy stan).
  ipcMain.handle('ui:get', () => readUiPrefs());
  ipcMain.handle('ui:set', (_event, partial) => writeUiPrefs(partial));

  // Zuzycie limitow: wymuszony odczyt (przycisk odswiezania). Gdy wylaczony -
  // zwroc stan 'off'; gdy watcher chodzi - odswiez go (wyemituje usage:update),
  // a rownolegle zwroc swiezy odczyt na potrzeby wywolania.
  ipcMain.handle('usage:refresh', async () => {
    if (!ENABLE_USAGE_METER) return { error: 'off' };
    if (usageWatcher) usageWatcher.refresh();
    return fetchUsage();
  });
}

// ---- Cykl zycia aplikacji ---------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startActiveProjects(); // ustala cwd, zanim wystartuje pierwsza sesja
  startActiveProfile(); // otwiera pierwsza zakladke (wraz z jej watcherem)
  startPortWatcher();
  startUsageWatcher();
  // Pre-warm skanu skilli (7A) po chwili, zeby jednorazowy koszt ~2s nie
  // opoznial startu okna. Wynik trafia do cache i pozniej odpowiada natychmiast.
  setTimeout(() => loadSkills(), 3000);

  app.on('activate', () => {
    // macOS: odtworz okno po kliknieciu w Dock, jesli wszystkie zamkniete.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (sessions.size === 0) startActiveProfile();
    }
  });
});

app.on('window-all-closed', () => {
  // Kazda zakladka ma wlasny proces i wlasny watcher - sprzatamy wszystkie.
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
  if (process.platform !== 'darwin') app.quit();
});
