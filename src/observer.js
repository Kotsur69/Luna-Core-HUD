// ============================================================================
// LunaCore - Passive Observer (Faza 3)
// ----------------------------------------------------------------------------
// Czyste, pasywne wyciaganie metryk. ZERO dodatkowych tokenow:
//   * detectTools()          - wykrywa nazwy narzedzi w surowym stdout PTY
//                              (strip ANSI + dopasowanie znanych narzedzi).
//   * TranscriptWatcher      - tailuje plik transcript JSONL Claude Code i
//                              liczy realne zuzycie context window z pola usage.
//
// Nic tu nie pisze do `claude` ani nie modyfikuje jego wejscia - tylko czyta.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 1. Detekcja narzedzi ze stdout ----------------------------------------

// Sekwencje ANSI/VT: CSI (\x1b[...X), OSC (\x1b]...BEL/ST), oraz proste \x1b(B itp.
// Usuwamy je, zeby regex narzedzi dzialal na czystym tekscie TUI.
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Znane narzedzia Claude Code. W TUI wywolanie renderuje sie jako "Nazwa(args)".
 * Klucz = etykieta kafelka w Skill Trackerze (data-skill w index.html).
 * Wartosc = regex-owa alternatywa nazw, ktore mapuja sie na ten kafelek.
 */
const TOOL_TILES = {
  Read: ['Read'],
  Edit: ['Edit', 'MultiEdit', 'NotebookEdit'],
  Write: ['Write'],
  Bash: ['Bash', 'BashOutput', 'KillShell'],
  Grep: ['Grep'],
  Glob: ['Glob'],
  Web: ['WebFetch', 'WebSearch'],
  Task: ['Task', 'Agent'],
};

// Odwrotna mapa: nazwa narzedzia -> kafelek. Oraz jeden regex na wszystko.
const TOOL_TO_TILE = new Map();
for (const [tile, names] of Object.entries(TOOL_TILES)) {
  for (const n of names) TOOL_TO_TILE.set(n, tile);
}
const ALL_TOOL_NAMES = [...TOOL_TO_TILE.keys()];
// Dopasowanie "Nazwa(" - tak Claude Code wypisuje aktywne narzedzie w strumieniu.
const TOOL_RE = new RegExp('\\b(' + ALL_TOOL_NAMES.join('|') + ')\\(', 'g');

/**
 * Zwraca liste kafelkow, ktore powinny sie zapalic dla danej porcji stdout.
 * @param {string} raw surowe dane z ptyProcess.onData
 * @returns {string[]} unikalne etykiety kafelkow (np. ["Bash", "Read"])
 */
function detectTools(raw) {
  if (!raw) return [];
  const clean = String(raw).replace(ANSI_RE, '');
  const tiles = new Set();
  let m;
  TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(clean)) !== null) {
    const tile = TOOL_TO_TILE.get(m[1]);
    if (tile) tiles.add(tile);
  }
  return [...tiles];
}

// ---- 2. Tailowanie transcript JSONL (realne tokeny) ------------------------

// Limit okna kontekstu modelu. 200k = domyslne dla Claude (Opus/Sonnet).
// Zmien, jesli uzywasz wariantu 1M-context.
const CONTEXT_LIMIT = 200000;

// Katalog, w ktorym Claude Code trzyma transcripty sesji (per-projekt).
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Ile bajtow z konca pliku czytamy, szukajac ostatniego wpisu z usage.
const TAIL_BYTES = 128 * 1024;

/** Znajduje najswiezszy plik .jsonl w drzewie ~/.claude/projects. */
function findNewestTranscript() {
  let newest = null;
  let newestMtime = 0;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null; // katalog jeszcze nie istnieje
  }
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, dirent.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs;
          newest = full;
        }
      } catch {
        /* plik zniknal miedzy readdir a stat - ignoruj */
      }
    }
  }
  return newest;
}

/** Czyta koncowke pliku i zwraca ostatni obiekt usage (lub null). */
function readLatestUsage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // Idziemy od konca - interesuje nas najswiezszy wpis z usage.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj && obj.message && obj.message.usage;
        if (usage && typeof usage.input_tokens === 'number') return usage;
      } catch {
        /* niepelna/uszkodzona linia (np. urwany zapis) - probuj dalej */
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

/** Zamienia obiekt usage na metryki context window. */
function usageToMetrics(usage) {
  const tokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  const percent = Math.min(1, tokens / CONTEXT_LIMIT);
  return { tokens, limit: CONTEXT_LIMIT, percent };
}

/**
 * Cyklicznie sprawdza najswiezszy transcript i emituje metryki context window,
 * gdy plik sie zmieni. Czysto lokalne, zadnych zadan do modelu.
 */
class TranscriptWatcher {
  /** @param {(metrics: {tokens:number,limit:number,percent:number}) => void} onMetrics */
  constructor(onMetrics, intervalMs = 1500) {
    this.onMetrics = onMetrics;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.currentFile = null;
    this.lastMtime = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick(); // pierwsza proba od razu
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const file = findNewestTranscript();
    if (!file) return;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    // Nic sie nie zmienilo od ostatniego odczytu - pomijamy parsowanie.
    if (file === this.currentFile && mtime === this.lastMtime) return;
    this.currentFile = file;
    this.lastMtime = mtime;

    const usage = readLatestUsage(file);
    if (usage) this.onMetrics(usageToMetrics(usage));
  }
}

module.exports = { detectTools, TranscriptWatcher, CONTEXT_LIMIT, TOOL_TILES };
