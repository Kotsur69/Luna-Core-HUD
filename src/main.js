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

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
// @lydell/node-pty: utrzymywany fork node-pty z prebuildami (N-API),
// dziala bez kompilacji node-gyp / Visual Studio. API zgodne z node-pty.
const pty = require('@lydell/node-pty');

// ---- Konfiguracja -----------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

// Domyslna powloka dla danego systemu.
const DEFAULT_SHELL = IS_WINDOWS
  ? 'powershell.exe'
  : process.env.SHELL || 'bash';

// Po starcie powloki automatycznie odpalamy `claude`. Ustaw na false, jesli
// wolisz recznie wpisac komende w terminalu (np. gdy CLI nie jest na PATH).
const AUTO_LAUNCH_CLAUDE = true;

// Katalog startowy sesji - domowy uzytkownika.
const START_CWD = os.homedir();

// ---- Stan globalny ----------------------------------------------------------

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

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

function startPty() {
  ptyProcess = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: START_CWD,
    env: process.env,
  });

  // PASSIVE OBSERVER: caly surowy stdout PTY -> renderer (xterm.js + przyszly parser).
  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', data);
    }
  });

  // Gdy proces PTY sie zakonczy - informujemy renderer.
  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', exitCode);
    }
    ptyProcess = null;
  });

  // Auto-start Claude CLI. PTY buforuje wejscie, wiec komenda wykona sie,
  // gdy tylko powloka bedzie gotowa. Krotkie opoznienie = czystszy prompt.
  if (AUTO_LAUNCH_CLAUDE) {
    setTimeout(() => {
      if (ptyProcess) ptyProcess.write('claude\r');
    }, 600);
  }
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

  // Dopasowanie rozmiaru PTY do rozmiaru terminala w oknie (xterm-addon-fit).
  ipcMain.on('pty:resize', (_event, size) => {
    if (!ptyProcess || !size) return;
    const cols = Math.max(1, size.cols | 0);
    const rows = Math.max(1, size.rows | 0);
    ptyProcess.resize(cols, rows);
  });
}

// ---- Cykl zycia aplikacji ---------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startPty();

  app.on('activate', () => {
    // macOS: odtworz okno po kliknieciu w Dock, jesli wszystkie zamkniete.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (!ptyProcess) startPty();
    }
  });
});

app.on('window-all-closed', () => {
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
