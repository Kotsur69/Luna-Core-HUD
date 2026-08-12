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
const { randomUUID } = require('crypto');
// @lydell/node-pty: utrzymywany fork node-pty z prebuildami (N-API),
// dziala bez kompilacji node-gyp / Visual Studio. API zgodne z node-pty.
const pty = require('@lydell/node-pty');
// Passive Observer (Faza 3): detekcja narzedzi ze stdout + tailowanie
// transcriptu JSONL po realne zuzycie context window. Tylko czyta, zero tokenow.
const { detectTools, detectApprovalPrompt, TranscriptWatcher, isLongTurn } = require('./observer');
// §4.2: literalne podciagi TUI, po ktorych rozpoznajemy monit o zgode - dane,
// nie kod, bo tekst CLI moze sie zmienic miedzy wydaniami (config/sound-triggers.json).
const { loadSoundTriggers } = require('./soundTriggers');
// Profile uruchomieniowe (Faza 4): definicje "jak wystartowac sesje" z JSON.
const { loadProfiles, getProfile } = require('./profiles');
// Budowanie komendy startowej: decyduje, czy sesje da sie przypiac po id.
const { withSessionId, findExecutable } = require('./launch');
// Przelacznik projektu: katalogi robocze (cwd) sesji z config/projects.json.
const { loadProjects, getProject } = require('./projects');
// Tracker portow localhost (7B): pasywny skan nasluchujacych portow + kill.
const { killProcess, PortWatcher } = require('./ports');
// Sciagawki akcji (7C): grupy komend wysylanych przez Action Injector.
const { loadCheatsheets } = require('./cheatsheets');
// Sciagawka skilli (7A): auto-skan katalogow skilli -> kategorie.
const { loadSkills, rescanSkills } = require('./skills');
// Biblioteka promptow: wielolinijkowe prompty do wielokrotnego uzycia.
const { loadPrompts } = require('./prompts');
// Brudnopis: lokalny notatnik trzymany jako zwykly plik tekstowy.
const { readScratchpad, writeScratchpad } = require('./scratchpad');
// Motywy (theming): mapy tokenow CSS + kolory xterm z config/themes.json.
const { loadThemes } = require('./theme');
const { loadLayouts } = require('./layouts');
// Preferencje UI (motyw + jezyk) trwale w config/ui.local.json.
const { readUiPrefs, writeUiPrefs } = require('./uiprefs');
// Licznik zuzycia limitow (5h + tydzien) - odczyt GET z endpointu OAuth CLI.
const { fetchUsage, UsageWatcher, nextUsageAnnounced } = require('./usage');
// E1: telemetria maszyny (RAM / CPU / uptime). Czyste `os`, zero zaleznosci,
// zero sieci - Passive Observer w najscislejszym mozliwym sensie.
const { TelemetryWatcher } = require('./telemetry');
// Sound feedback: persistent `mpv --idle` process + JSON IPC.
const { SoundManager } = require('./soundManager');
const { resolveSoundFile } = require('./sounds');
// §11.2: read Claude's actual output aloud. Zero extra tokens - extraction is
// plain regex on the same transcript fragment TranscriptWatcher already
// tails, synthesis is offline Windows SAPI, no model call in either step.
const { extractSpokenText } = require('./ttsExtract');
const { synthesizeToWav } = require('./tts');
// D5: aktualizacje. Same CZYSTE decyzje - `electron-updater` doladowywany jest
// leniwie w getAutoUpdater(), dopiero gdy wiadomo, ze ta kompilacja moze sie
// aktualizowac.
const {
  supportsUpdates,
  normalizeUpdateInfo,
  releaseUrl,
  releasesUrl,
  progressPercent,
} = require('./update');

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
/** @type {TelemetryWatcher | null} */
let telemetryWatcher = null;
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
 * Gwarantuje kolory w sesji PTY.
 *
 * Powod: gdy LunaCore odpalono z terminala, ktory wylacza kolory (Claude Code
 * ustawia NO_COLOR=1, zeby jego wlasny output byl czysty), zagniezdzony `claude`
 * dziedziczy ta zmienna i renderuje sie CALKOWICIE BEZ KOLOROW - logo Claude
 * wychodzi biale zamiast pomaranczowego. To nie jest usterka motywu: xterm dostaje
 * czysty tekst, wiec zaden theme tego nie naprawi.
 *
 * Czyscimy wiec zmienne tlumiace kolor i deklarujemy terminal 256-kolorowy +
 * truecolor. NIE nadpisujemy COLORTERM, jesli uzytkownik ustawil go swiadomie.
 * @param {Record<string,string>} env
 */
function withColorSupport(env) {
  delete env.NO_COLOR;
  // FORCE_COLOR=0 to jawne "bez kolorow"; kazda inna wartosc zostawiamy.
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR;
  env.TERM = 'xterm-256color';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';
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
  // Kolejnosc ma znaczenie: kolory ustawiamy na ODZIEDZICZONYM env, a dopiero
  // potem nakladamy profil - dzieki temu profil, ktory swiadomie ustawia TERM
  // albo NO_COLOR, nadal wygrywa.
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

  // PASSIVE OBSERVER: surowy stdout tej sesji -> renderer + detekcja narzedzi.
  // Kazde zdarzenie niesie sessionId, bo renderer trzyma osobny bufor na zakladke.
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
        const resolved = resolveSoundFile('voice.needYou');
        if (resolved) soundManager.play(resolved.path);
      }
    }
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

  // Komenda startowa profilu (pusta = sama powloka, bez auto-startu).
  const command = [profile.command, ...(profile.args || [])].join(' ').trim();
  // When WE launch `claude`, we dictate the session id - the transcript is then
  // named exactly <uuid>.jsonl and the watcher looks it up instead of inferring
  // ownership from file timestamps. Null = this session cannot be pinned (bare
  // shell, foreign command, or a resume that brings its own id).
  const transcriptId = randomUUID();
  const pinnedCommand = withSessionId(command, transcriptId);
  session.transcriptId = pinnedCommand ? transcriptId : null;

  // Wlasny watcher transcriptu, zawezony do katalogu tej sesji.
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
      onTurnEnd: (turn) => checkTurnEnd(turn),
    },
  );
  session.watcher.start();

  // PTY buforuje wejscie, wiec komenda wykona sie, gdy powloka bedzie gotowa.
  const startCommand = pinnedCommand || command;
  if (startCommand) {
    setTimeout(() => {
      if (session.proc === proc) proc.write(`${startCommand}\r`);
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

/**
 * Wczytuje profile i otwiera pierwsza zakladke (przy starcie aplikacji).
 * B1: pierwszenstwo ma profil zapamietany w ui.local.json - startujemy tam,
 * gdzie sie skonczylo. Gdy zapamietanego profilu juz nie ma w configu (ktos go
 * usunal / inna maszyna), cicho wracamy do activeProfile z profiles.json.
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

/** Plays voice.usage50/usage80 on a fresh threshold crossing (§4.4). */
function checkUsageThresholds(usage) {
  const pct =
    usage && usage.fiveHour && typeof usage.fiveHour.pct === 'number' ? usage.fiveHour.pct : null;
  const { next, fire } = nextUsageAnnounced(pct, usageAnnounced);
  usageAnnounced = next;
  if (!fire || !soundManager) return;
  const resolved = resolveSoundFile(`voice.${fire}`);
  if (resolved) soundManager.play(resolved.path);
}

// ---- Passive Observer: koniec dlugiego zadania (SOUNDS_IMPLEMENTATION_PLAN.md §3) --

/** Plays voice.done, but only when the completed turn ran long enough (§3). */
function checkTurnEnd({ startedAt, endedAt, text }) {
  if (soundManager && isLongTurn(startedAt, endedAt, readUiPrefs().soundLongTaskMinutes)) {
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
  if (!narrationManager || !readUiPrefs().soundReadOutputEnabled) return;
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

// ---- E1: Passive Observer: telemetria maszyny (RAM / CPU / uptime) ----------
//
// Wlacznik istnieje z tego samego powodu, co ENABLE_USAGE_METER: README obiecuje,
// ze kazdy pomiar da sie wylaczyc. Ten akurat nie dotyka ani sieci, ani dysku -
// to cztery wywolania do `os` - wiec wylaczenie go jest kwestia gustu, a nie
// prywatnosci. Sam wybor ma jednak nalezec do uzytkownika, nie do nas.

const ENABLE_TELEMETRY = true;

function startTelemetryWatcher() {
  if (!ENABLE_TELEMETRY) return;
  telemetryWatcher = new TelemetryWatcher((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('telemetry:update', payload);
    }
  });
  telemetryWatcher.start();
}

// ---- D5: aktualizacje (tryb "powiadom, nie pobieraj") -----------------------
// Sprawdzenie rusza raz, przy starcie. POBIERANIE NIE RUSZA SAMO - dopiero po
// klinieciu uzytkownika. Uzasadnienie jest w naglowku src/update.js: binarka
// jest niepodpisana, a aplikacja, ktorej cala obietnica to "czytam wylacznie to,
// co wymieniam w README", nie ma prawa sciagac 80 MB w tle.
//
// Stan trzymamy TUTAJ, bo renderer moze sie podlaczyc pozniej niz przyjdzie
// odpowiedz z sieci. Kanal `update:status` odgrywa ostatni stan na zadanie -
// dokladnie ta sama zasada, co "feed replays its last payload" z §A2: widget
// zamontowany miedzy odpytaniami inaczej stalby pusty.

const ENABLE_AUTO_UPDATE = true;

/** Ostatni znany stan aktualizacji. Kanal update:state rozsyla kazda zmiane. */
let updateState = { state: 'idle', info: null, percent: 0, error: null, reason: null };

/** Instancja electron-updater. null, dopoki nie okaze sie potrzebna. */
let updaterInstance = null;

// Wersja doklejana jest przy KAZDYM rozeslaniu, a nie trzymana osobno w
// rendererze: "aktualna" to zdanie o dwoch liczbach naraz, wiec gdyby przyszly
// dwoma kanalami, HUD mialby stan posredni, w ktorym pokazuje jedna bez drugiej.
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  send('update:state', { ...updateState, version: app.getVersion() });
}

/** Fakty o srodowisku dla czystej decyzji supportsUpdates(). */
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
 * Leniwie tworzy i konfiguruje electron-updater.
 *
 * Wywolywane WYLACZNIE po tym, jak supportsUpdates() powie "tak" - w klonie
 * deweloperskim modul szuka dev-app-update.yml i rzuca wyjatkiem, wiec samo jego
 * zaladowanie na dev byloby bledem.
 */
function getAutoUpdater() {
  if (updaterInstance) return updaterInstance;

  const { autoUpdater } = require('electron-updater');

  // Dwie linie, ktore realizuja wybor "powiadom, uzytkownik klika". Bez nich
  // electron-updater domyslnie pobiera od razu i instaluje przy wyjsciu.
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

  // Brak sieci, firewall, prywatne repo - wszystko trafia tutaj. Stan bledu jest
  // widoczny w HUD, bo cicha porazka aktualizacji jest gorsza niz zadna: uzytkownik
  // myslalby, ze ma najnowsza wersje.
  autoUpdater.on('error', (err) => {
    setUpdateState({ state: 'error', error: errorText(err) });
  });

  updaterInstance = autoUpdater;
  return autoUpdater;
}

/** Odpytuje GitHuba o nowsze wydanie. Nic nie pobiera. */
function checkForUpdate() {
  const support = supportsUpdates(updateEnv());
  if (!ENABLE_AUTO_UPDATE || !support.supported) return;

  setUpdateState({ state: 'checking', error: null });
  try {
    // checkForUpdates() zwraca obietnice, ktora potrafi odrzucic ROWNOLEGLE do
    // zdarzenia 'error'. Bez tego .catch() brak sieci to unhandled rejection.
    Promise.resolve(getAutoUpdater().checkForUpdates()).catch((err) => {
      setUpdateState({ state: 'error', error: errorText(err) });
    });
  } catch (err) {
    setUpdateState({ state: 'error', error: errorText(err) });
  }
}

/**
 * Ustala stan startowy i - o ile wolno - odpytuje o aktualizacje.
 *
 * Kompilacja, ktora nie moze sie aktualizowac, dostaje stan 'unsupported' wraz z
 * POWODEM (kodem, nie zdaniem - tlumaczy renderer), zeby HUD mogl pokazac
 * "wersja portable: pobierz recznie" zamiast udawac, ze wszystko jest aktualne.
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

// ---- Kanaly IPC -------------------------------------------------------------

function registerIpc() {
  // ACTION INJECTOR (klawiatura): surowe wejscie z xterm.js -> stdin PTY.
  // Payload: { sessionId?, data } - brak sessionId trafia do sesji aktywnej.
  ipcMain.on('pty:write', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { data: payload };
    const session = resolveSession(p.sessionId);
    if (session && session.proc) session.proc.write(p.data);
    // §4.2: any input from Mati means an approval prompt (if showing) got answered.
    if (session) session.approvalShowing = false;
  });

  // ACTION INJECTOR (przyciski GUI): wysyla gotowa komende + Enter (\r).
  // To wlasnie tego uzywa przycisk COMPACT CONTEXT -> "/compact".
  ipcMain.on('pty:command', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : { text: payload };
    const session = resolveSession(p.sessionId);
    if (!session || !session.proc || typeof p.text !== 'string') return;
    const line = p.text.endsWith('\r') ? p.text : `${p.text}\r`;
    session.proc.write(line);
    session.approvalShowing = false;
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
    session.approvalShowing = false;
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
    writeUiPrefs({ profile: p.profileId }); // B1: zapamietaj na nastepny start
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

  // A5: wymuszony re-skan (przycisk w UI) - nowy skill nie wymaga juz restartu.
  ipcMain.handle('skills:rescan', () => rescanSkills());

  // Biblioteka promptow: grupy wielolinijkowych promptow do wklejenia.
  ipcMain.handle('prompts:list', () => loadPrompts());

  // Brudnopis: odczyt i zapis lokalnego notatnika (walidacja w scratchpad.js).
  ipcMain.handle('scratchpad:read', () => readScratchpad());
  ipcMain.handle('scratchpad:write', (_event, text) => writeScratchpad(text));

  // Motywy: lista dostepnych motywow (tokeny CSS + kolory xterm).
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

  // C1: presety ukladu (siatka + przydzial widgetow do regionow).
  ipcMain.handle('layouts:list', () => loadLayouts());

  // Preferencje UI: odczyt {theme, lang} i zapis czesciowy (zwraca nowy stan).
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

  // Sound feedback: renderer never touches mpv directly (contextIsolation).
  // Missing key, disabled entry, or missing asset file all resolve to null in
  // resolveSoundFile() - a silent no-op, matching soundManager's own
  // degrade-gracefully rule for a missing mpv.
  ipcMain.on('sound:play', (_event, payload) => {
    if (!soundManager || !payload || typeof payload.key !== 'string') return;
    const resolved = resolveSoundFile(payload.key, payload.opts || {});
    if (resolved) soundManager.play(resolved.path);
  });

  // Zuzycie limitow: wymuszony odczyt (przycisk odswiezania). Gdy wylaczony -
  // zwroc stan 'off'; gdy watcher chodzi - odswiez go (wyemituje usage:update),
  // a rownolegle zwroc swiezy odczyt na potrzeby wywolania.
  ipcMain.handle('usage:refresh', async () => {
    if (!ENABLE_USAGE_METER) return { error: 'off' };
    if (usageWatcher) usageWatcher.refresh();
    return fetchUsage();
  });

  // ---- D5: aktualizacje ------------------------------------------------------

  // Odgrywka stanu. Widget montuje sie pozniej, niz przychodzi odpowiedz z
  // sieci, wiec bez tego kanalu pokazywalby 'idle' az do nastepnej zmiany.
  ipcMain.handle('update:status', () => ({ ...updateState, version: app.getVersion() }));

  // Reczne sprawdzenie (przycisk odswiezania).
  ipcMain.on('update:check', () => checkForUpdate());

  // Zgoda uzytkownika na pobranie. To JEDYNE miejsce, w ktorym cokolwiek jest
  // sciagane - autoDownload zostaje na false.
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

  // Zgoda na restart i instalacje. Dopiero tutaj cokolwiek zmienia sie na dysku.
  ipcMain.on('update:install', () => {
    if (updateState.state !== 'ready') return;
    try {
      // isSilent=false: instalator ma byc widoczny. Binarka jest niepodpisana,
      // wiec moze pojawic sie SmartScreen - cicha instalacja zostawilaby
      // uzytkownika przed niewyjasnionym oknem systemowym.
      getAutoUpdater().quitAndInstall(false, true);
    } catch (err) {
      setUpdateState({ state: 'error', error: errorText(err) });
    }
  });

  // Strona wydania. Adres skladany jest TUTAJ, nigdy nie przychodzi z renderera:
  // shell.openExternal na stringu z UI to otwarte przekierowanie prosto do
  // przegladarki uzytkownika (ta sama zasada, co przy linku do dokumentacji).
  ipcMain.on('update:open-releases', () => {
    const version = updateState.info && updateState.info.version;
    shell.openExternal(version ? releaseUrl(version) : releasesUrl());
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
  startTelemetryWatcher();
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
    if (!soundManager) return;
    const resolved = resolveSoundFile('voice.welcome');
    if (resolved) soundManager.play(resolved.path);
  }, STARTUP_GREETING_DELAY_MS);
  // D5. Jedno zapytanie HTTPS przy starcie, nic nie pobiera. Odpalane po
  // createWindow(), zeby HUD zdazyl sie narysowac; samo zapytanie i tak jest
  // asynchroniczne i nie blokuje event loopa.
  startUpdateCheck();
  // A5: skan skilli (7A) jest teraz async (fs.promises) i nie blokuje event
  // loopa, wiec nie trzeba juz go opozniac za oknem - im wczesniej wystartuje,
  // tym wieksza szansa, ze cache bedzie gotowy zanim widget skills go poprosi.
  loadSkills();

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
  if (telemetryWatcher) {
    telemetryWatcher.stop();
    telemetryWatcher = null;
  }
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
