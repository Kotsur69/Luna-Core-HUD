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

  // --- PASSIVE OBSERVER: metryki Fazy 3 (tylko odczyt) ---
  /** Metryki context window: { tokens, limit, percent } z transcriptu JSONL. */
  onContext: (callback) => {
    ipcRenderer.on('metrics:context', (_event, metrics) => callback(metrics));
  },
  /** Lista kafelkow Skill Trackera do zapalenia (np. ["Bash", "Read"]). */
  onTools: (callback) => {
    ipcRenderer.on('metrics:tools', (_event, tiles) => callback(tiles));
  },

  // --- FAZA 4: profile uruchomieniowe ---
  /** Pobiera { profiles, activeProfile } do wypelnienia przelacznika. */
  getProfiles: () => ipcRenderer.invoke('profiles:list'),
  /** Przelacza profil -> restart sesji PTY z nowym srodowiskiem. */
  switchProfile: (id) => ipcRenderer.send('pty:restart', id),
  /** Powiadomienie o restarcie sesji: { id, label } nowego profilu. */
  onRestarted: (callback) => {
    ipcRenderer.on('pty:restarted', (_event, profile) => callback(profile));
  },

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

  // --- ACTION INJECTOR: renderer -> stdin PTY ---
  /** Surowe wejscie z klawiatury (xterm.js onData) do PTY. */
  write: (data) => ipcRenderer.send('pty:write', data),
  /** Gotowa komenda z przycisku GUI (dopisze Enter). Np. runCommand('/compact'). */
  runCommand: (text) => ipcRenderer.send('pty:command', text),
  /** Dopasowanie rozmiaru PTY do liczby kolumn/wierszy terminala. */
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
});
