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

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {TranscriptWatcher | null} */
let transcriptWatcher = null;
/** @type {PortWatcher | null} */
let portWatcher = null;
/** @type {UsageWatcher | null} */
let usageWatcher = null;
// Profile wczytane z config/ oraz id aktualnie aktywnego.
let profiles = [];
let activeProfileId = null;
// Projekty (katalogi robocze) wczytane z config/ + id aktywnego i realny cwd.
let projects = [];
let activeProjectId = null;
let activeCwd = START_CWD;
// Ostatni znany rozmiar terminala - odtwarzany przy restarcie sesji.
let lastSize = { cols: 80, rows: 24 };

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

function launchProfile(profile) {
  activeProfileId = profile.id;
  // Nadpisania srodowiska z profilu (np. ANTHROPIC_BASE_URL dla LM Studio),
  // czyszczenie markerow sesji-rodzica (transkrypt!) + gwarancja, ze `claude`
  // z ~/.local/bin jest na PATH sesji.
  const env = withClaudeOnPath(
    stripClaudeSessionMarkers({ ...process.env, ...(profile.env || {}) }),
  );

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: lastSize.cols,
    rows: lastSize.rows,
    cwd: safeCwd(activeCwd),
    env,
  });
  ptyProcess = proc;

  // PASSIVE OBSERVER: caly surowy stdout PTY -> renderer (xterm.js) + detekcja narzedzi.
  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 1. Surowy strumien na ekran terminala (bez zmian - user widzi 1:1).
      mainWindow.webContents.send('pty:data', data);
      // 2. Skill Tracker: wykryj nazwy narzedzi i zapal odpowiednie kafelki.
      const tiles = detectTools(data);
      if (tiles.length > 0) {
        mainWindow.webContents.send('metrics:tools', tiles);
      }
    }
  });

  // Gdy proces PTY sie zakonczy - informujemy renderer. Guard: ignorujemy exit
  // starego procesu po restarcie (proc !== ptyProcess), zeby nie wysylac falszywego
  // "sesja zakonczona" i nie zerowac nowej sesji.
  proc.onExit(({ exitCode }) => {
    if (proc !== ptyProcess) return; // to stary proces po przelaczeniu profilu
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', exitCode);
    }
    ptyProcess = null;
  });

  // Wpisz komende startowa profilu (pusta = sama powloka, bez auto-startu).
  // PTY buforuje wejscie, wiec komenda wykona sie, gdy powloka bedzie gotowa.
  const command = [profile.command, ...(profile.args || [])].join(' ').trim();
  if (command) {
    setTimeout(() => {
      if (ptyProcess === proc) proc.write(`${command}\r`);
    }, 600);
  }
}

/**
 * Restart sesji PTY z innym profilem: ubija biezacy proces i startuje nowy.
 * Renderer dostaje 'pty:restarted' (czysci terminal + pokazuje aktywny profil).
 * @param {string} profileId
 */
function restartPty(profileId) {
  const profile = getProfile(profiles, profileId);
  if (!profile) return;

  if (ptyProcess) {
    const old = ptyProcess;
    ptyProcess = null; // odcinamy stary proces (jego onExit sie zignoruje)
    try {
      old.kill();
    } catch {
      /* proces mogl juz nie zyc */
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pty:restarted', {
      id: profile.id,
      label: profile.label,
      folder: path.basename(safeCwd(activeCwd)),
    });
  }
  launchProfile(profile);
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

/** Startuje sesje z aktywnym profilem (przy pierwszym uruchomieniu). */
function startActiveProfile() {
  const loaded = loadProfiles();
  profiles = loaded.profiles;
  const profile = getProfile(profiles, loaded.activeProfile) || profiles[0];
  launchProfile(profile);
}

// ---- Passive Observer: metryki context window (transcript JSONL) ------------

function startTranscriptWatcher() {
  transcriptWatcher = new TranscriptWatcher((metrics) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('metrics:context', metrics);
    }
  });
  transcriptWatcher.start();
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
  ipcMain.on('pty:write', (_event, data) => {
    if (ptyProcess) ptyProcess.write(data);
  });

  // ACTION INJECTOR (przyciski GUI): wysyla gotowa komende + Enter (\r).
  // To wlasnie tego uzywa przycisk COMPACT CONTEXT -> "/compact".
  ipcMain.on('pty:command', (_event, text) => {
    if (!ptyProcess || typeof text !== 'string') return;
    const line = text.endsWith('\r') ? text : `${text}\r`;
    ptyProcess.write(line);
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
    if (!ptyProcess || !payload || typeof payload.text !== 'string') return;
    // Normalizacja koncow linii: w bufor wejscia wchodza wylacznie "\n".
    const text = payload.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    ptyProcess.write(`\x1b[200~${text}\x1b[201~`);
    if (payload.submit) ptyProcess.write('\r');
  });

  // Dopasowanie rozmiaru PTY do rozmiaru terminala w oknie (xterm-addon-fit).
  ipcMain.on('pty:resize', (_event, size) => {
    if (!size) return;
    const cols = Math.max(1, size.cols | 0);
    const rows = Math.max(1, size.rows | 0);
    lastSize = { cols, rows }; // zapamietaj do odtworzenia przy restarcie
    if (ptyProcess) ptyProcess.resize(cols, rows);
  });

  // FAZA 4: renderer pyta o dostepne profile (do wypelnienia przelacznika).
  ipcMain.handle('profiles:list', () => ({ profiles, activeProfile: activeProfileId }));

  // FAZA 4: przelaczenie profilu -> restart sesji PTY z nowym srodowiskiem.
  ipcMain.on('pty:restart', (_event, profileId) => {
    if (typeof profileId === 'string') restartPty(profileId);
  });

  // Przelacznik projektu: renderer pobiera liste katalogow roboczych.
  ipcMain.handle('projects:list', () => ({ projects, activeProject: activeProjectId }));

  // Przelaczenie projektu -> zmiana cwd + restart sesji z BIEZACYM profilem.
  // (Ten sam mechanizm restartu co profil; rozni sie tylko katalogiem startowym.)
  ipcMain.on('pty:switch-project', (_event, projectId) => {
    const proj = getProject(projects, projectId);
    if (!proj || !activeProfileId) return;
    activeCwd = proj.path;
    activeProjectId = proj.id;
    restartPty(activeProfileId);
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
  startActiveProfile();
  startTranscriptWatcher();
  startPortWatcher();
  startUsageWatcher();
  // Pre-warm skanu skilli (7A) po chwili, zeby jednorazowy koszt ~2s nie
  // opoznial startu okna. Wynik trafia do cache i pozniej odpowiada natychmiast.
  setTimeout(() => loadSkills(), 3000);

  app.on('activate', () => {
    // macOS: odtworz okno po kliknieciu w Dock, jesli wszystkie zamkniete.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (!ptyProcess) startActiveProfile();
    }
  });
});

app.on('window-all-closed', () => {
  if (transcriptWatcher) {
    transcriptWatcher.stop();
    transcriptWatcher = null;
  }
  if (portWatcher) {
    portWatcher.stop();
    portWatcher = null;
  }
  if (usageWatcher) {
    usageWatcher.stop();
    usageWatcher = null;
  }
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
