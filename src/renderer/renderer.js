// ============================================================================
// LunaCore - renderer (frontend)
// ----------------------------------------------------------------------------
// * Renderuje terminal xterm.js i spina go z PTY przez most window.lunacore.
// * Obsluguje fizyczny przycisk COMPACT CONTEXT (Action Injector).
//
// Dostep do procesu glownego wylacznie przez `window.lunacore` (patrz preload.js).
// Globale `Terminal` i `FitAddon` pochodza z bibliotek xterm zaladowanych w HTML.
// ============================================================================

'use strict';

// ---- Inicjalizacja terminala ------------------------------------------------

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  // Paleta dopasowana do motywu LunaCore (mroczny fiolet + neon).
  theme: {
    background: '#0c0912',
    foreground: '#e6dcff',
    cursor: '#c774ff',
    selectionBackground: '#3a2a5a',
    black: '#1a1424',
    brightBlack: '#4a3a63',
    magenta: '#c774ff',
    brightMagenta: '#e29bff',
    cyan: '#5ff2d6',
    brightCyan: '#8ffbe6',
    green: '#7CFF9B',
    yellow: '#ffd86b',
    red: '#ff6b8a',
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));

// Dopasuj terminal do kontenera i zsynchronizuj rozmiar PTY.
function fitAndResize() {
  try {
    fitAddon.fit();
    window.lunacore.resize(term.cols, term.rows);
  } catch (err) {
    // Ignoruj bledy dopasowania, gdy okno jest chwilowo o zerowym rozmiarze.
  }
}

// ---- Spiecie z PTY ----------------------------------------------------------

// PASSIVE OBSERVER: dane z procesu Claude CLI -> ekran terminala.
window.lunacore.onData((data) => {
  term.write(data);
});

// ACTION INJECTOR: kazde nacisniecie klawisza -> stdin PTY.
term.onData((data) => {
  window.lunacore.write(data);
});

// Status polaczenia PTY.
window.lunacore.onExit((code) => {
  setPtyStatus(false, `PTY: zakonczono (kod ${code})`);
  term.write(`\r\n\x1b[38;5;203m[LunaCore] Sesja PTY zakonczona (kod ${code}).\x1b[0m\r\n`);
});

// ---- Przycisk COMPACT CONTEXT (Faza 2) --------------------------------------

const compactBtn = document.getElementById('btn-compact');
compactBtn.addEventListener('click', () => {
  // Wysyla dokladnie "/compact" + Enter do aktywnej sesji - zero dodatkowych tokenow.
  window.lunacore.runCommand('/compact');
  pulse(compactBtn);
  term.focus();
});

// Krotka wizualna informacja zwrotna po kliknieciu.
function pulse(el) {
  el.classList.remove('is-pulsing');
  // wymus reflow, aby animacja odpalila sie ponownie
  void el.offsetWidth;
  el.classList.add('is-pulsing');
}

// ---- Wskaznik statusu PTY ----------------------------------------------------

function setPtyStatus(isLive, text) {
  const dot = document.getElementById('pty-status-dot');
  const label = document.getElementById('pty-status-text');
  dot.classList.toggle('dot--live', isLive);
  dot.classList.toggle('dot--dead', !isLive);
  label.textContent = text;
}

// ---- Zdarzenia okna ---------------------------------------------------------

window.addEventListener('resize', fitAndResize);

window.addEventListener('DOMContentLoaded', () => {
  fitAndResize();
});

// Pierwsze dopasowanie po pelnym ulozeniu layoutu + oznaczenie sesji jako aktywnej.
requestAnimationFrame(() => {
  fitAndResize();
  setPtyStatus(true, 'PTY: aktywne');
  term.focus();
});
