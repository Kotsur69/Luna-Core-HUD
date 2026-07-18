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
  /** Rejestruje callback wywolywany dla kazdej porcji danych z terminala. */
  onData: (callback) => {
    ipcRenderer.on('pty:data', (_event, data) => callback(data));
  },
  /** Powiadomienie o zakonczeniu procesu PTY (np. wyjscie z `claude`/powloki). */
  onExit: (callback) => {
    ipcRenderer.on('pty:exit', (_event, code) => callback(code));
  },

  // --- ACTION INJECTOR: renderer -> stdin PTY ---
  /** Surowe wejscie z klawiatury (xterm.js onData) do PTY. */
  write: (data) => ipcRenderer.send('pty:write', data),
  /** Gotowa komenda z przycisku GUI (dopisze Enter). Np. runCommand('/compact'). */
  runCommand: (text) => ipcRenderer.send('pty:command', text),
  /** Dopasowanie rozmiaru PTY do liczby kolumn/wierszy terminala. */
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
});
