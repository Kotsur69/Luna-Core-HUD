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
// Wiedza o modelach: realne okno kontekstu + krotka etykieta do kafelka.
const { contextLimitFor, modelLabel, DEFAULT_CONTEXT_LIMIT } = require('./models');
// Cennik do szacowania kosztu sesji (B4). Czyta wylacznie config/, zero sieci.
const { loadRates, rateFor, estimateCost } = require('./rates');

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
  // "Shell", not "Bash": on Windows the CLI reaches for the PowerShell tool for
  // most shell work. Counted across recent transcripts on this machine it was
  // PowerShell 49 vs Bash 19 - and PowerShell mapped to no tile at all, so the
  // shell tile simply never lit. One tile covers both; the label follows.
  Shell: ['Bash', 'BashOutput', 'KillShell', 'PowerShell'],
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
 * @returns {string[]} unikalne etykiety kafelkow (np. ["Shell", "Read"])
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

// Domyslne okno kontekstu. NIE jest juz twarda stala uzywana do liczenia -
// realny limit wyznacza models.contextLimitFor() na podstawie modelu z
// transkryptu i obserwowanego zuzycia. Zostaje jako wartosc domyslna/eksport.
const CONTEXT_LIMIT = DEFAULT_CONTEXT_LIMIT;

// Katalog, w ktorym Claude Code trzyma transcripty sesji (per-projekt).
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Ile bajtow z konca pliku czytamy, szukajac ostatniego wpisu z usage.
const TAIL_BYTES = 128 * 1024;

/**
 * Zamienia katalog roboczy na nazwe katalogu, w ktorym Claude Code trzyma jego
 * transcripty. CLI koduje sciezke, zastepujac kazdy znak niealfanumeryczny
 * mysinikiem, np.:
 *   C:\Users\mmazur\.local\bin  ->  C--Users-mmazur--local-bin
 * (podwojny mysinik bierze sie z pary separator + kropka).
 *
 * To jest sedno obslugi wielu sesji naraz: bez tego nie da sie powiedziec,
 * ktory transcript nalezy do ktorej zakladki.
 * @param {string} cwd
 * @returns {string}
 */
function encodeProjectDir(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Pliki transcriptow juz przypisane do zyjacych watcherow.
 *
 * Katalog transcriptow jest kluczowany FOLDEREM, a plik SESJA - wiec dwie
 * zakladki otwarte na tym samym repo widza ten sam katalog z dwoma plikami.
 * Bez rezerwacji obie wybralyby "najswiezszy" i pokazywalyby te sama sesje.
 * Wszystkie watchery zyja w tym samym procesie glownym, wiec zwykly Set
 * wystarcza za rejestr: kazdy plik moze miec tylko jednego wlasciciela.
 */
const claimedTranscripts = new Set();

/** Zwraca [{ full, mtimeMs, birthMs }] dla plikow .jsonl w katalogu. */
function listJsonl(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // katalog sesji jeszcze nie powstal
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(dir, file);
    try {
      const st = fs.statSync(full);
      out.push({ full, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.ctimeMs });
    } catch {
      /* plik zniknal miedzy readdir a stat - ignoruj */
    }
  }
  return out;
}

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

/**
 * Czyta koncowke pliku i zwraca ostatnia probke: { usage, model } (lub null).
 * Model bierzemy z tej samej linii co usage - jedno parsowanie, dwa pozytki:
 * realne okno kontekstu (B2) i plakietka modelu (B3).
 */
function readLatestSample(file) {
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
        const message = obj && obj.message;
        const usage = message && message.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          return { usage, model: typeof message.model === 'string' ? message.model : '' };
        }
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

/**
 * Sums token usage from a JSONL fragment, bucketed BY MODEL (B4).
 *
 * Why separate from readLatestSample: the context bar needs the LAST entry (the
 * current composition of the window), while cost needs the SUM over the whole
 * session. Two different numbers from one file - confusing them would shrink the
 * cost down to a single turn.
 *
 * Why per model: switching with `/model` mid-session is normal, and the session
 * then holds turns billed at different rates. Pricing one cumulative total at
 * the LAST seen model's rate re-prices history on every switch - the displayed
 * cost would visibly DROP going Opus -> Sonnet, which is nonsense: spent money
 * does not come back.
 *
 * Pure function: text -> counters, so it is testable without touching disk.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {Map<string, {input:number,output:number,cacheRead:number,cacheWrite:number}>}
 */
function sumUsageByModel(text) {
  const byModel = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(line);
      const message = obj && obj.message;
      const usage = message && message.usage;
      if (!usage) continue;
      const model = typeof message.model === 'string' ? message.model : '';
      let totals = byModel.get(model);
      if (!totals) {
        totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        byModel.set(model, totals);
      }
      totals.input += usage.input_tokens || 0;
      totals.output += usage.output_tokens || 0;
      totals.cacheRead += usage.cache_read_input_tokens || 0;
      totals.cacheWrite += usage.cache_creation_input_tokens || 0;
    } catch {
      /* niepelna/uszkodzona linia - pomijamy */
    }
  }
  return byModel;
}

/**
 * Extracts Skill Tracker tiles from `tool_use` entries in a JSONL fragment.
 *
 * Why not stdout: detectTools() scrapes the TUI for the literal "Name(" shape,
 * which ties us to how Claude Code happens to render a tool call this release -
 * change the rendering and the tiles silently stop lighting. The transcript
 * carries the same fact as structured data (`message.content[].type ===
 * "tool_use"`, with `name`), so we read that instead and keep the stdout scan
 * only as a backstop.
 *
 * Unknown names (MCP tools like `mcp__server__thing`) map to no tile and are
 * skipped - the tracker shows the built-in tools it has tiles for.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {string[]} unique tile labels
 */
function toolsFromLines(text) {
  const tiles = new Set();
  for (const ev of toolEventsFromLines(text)) {
    if (ev.phase === 'start') tiles.add(ev.tile);
  }
  return [...tiles];
}

/**
 * Extracts the tool LIFECYCLE from a JSONL fragment (B8).
 *
 * The tiles above answer "which tool ran". They cannot answer "is it still
 * running", which is why a two-minute Bash used to look exactly like an instant
 * Read. The transcript does carry the missing half: a `tool_use` block has an
 * `id`, and the tool_result that closes it - in a later user message - carries
 * the same value as `tool_use_id`. Pairing them gives a real start and a real
 * end, still purely by reading, so this stays Passive Observer.
 *
 * A `tool_result` does NOT repeat the tool's name, so an end event has no tile
 * of its own; foldToolEvents() resolves it from the id that opened it.
 *
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {{phase:'start'|'end', id:string, tile?:string, at:number|null}[]}
 *   events in file order
 */
function toolEventsFromLines(text) {
  const events = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    // Cheap pre-filter: most transcript lines carry neither shape.
    if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj && obj.message && obj.message.content;
      if (!Array.isArray(content)) continue;
      // Wall-clock from the entry itself, not from when we happened to read it:
      // the watcher polls every 1.5 s, so read time is far too coarse to time a
      // tool with.
      const at = Date.parse(obj.timestamp) || null;
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'tool_use' && typeof part.id === 'string') {
          const tile = TOOL_TO_TILE.get(part.name);
          // No tile (an MCP tool, say) means nothing to light - and skipping the
          // start means its end is later ignored as an orphan, which is correct.
          if (tile) events.push({ phase: 'start', id: part.id, tile, at });
        } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          events.push({ phase: 'end', id: part.tool_use_id, at });
        }
      }
    } catch {
      /* incomplete/corrupt line - skip */
    }
  }
  return events;
}

/**
 * Folds raw events into the set of tools currently in flight and returns the
 * transitions worth sending to the renderer.
 *
 * `open` is the caller's id -> tile map and IS mutated: it has to survive across
 * ticks, because a tool routinely starts in one appended chunk and ends in
 * another. Duplicate starts, and ends for ids we never saw open, are dropped -
 * so the renderer only ever receives balanced pairs.
 *
 * @param {Map<string,string>} open live id -> tile map, mutated in place
 * @param {{phase:string, id:string, tile?:string, at:number|null}[]} events
 * @returns {{phase:'start'|'end', id:string, tile:string, at:number|null}[]}
 */
function foldToolEvents(open, events) {
  const out = [];
  for (const ev of events || []) {
    if (ev.phase === 'start') {
      if (open.has(ev.id)) continue; // already counted - re-read of the same line
      open.set(ev.id, ev.tile);
      out.push({ phase: 'start', id: ev.id, tile: ev.tile, at: ev.at });
    } else {
      const tile = open.get(ev.id);
      if (!tile) continue; // orphan: started before we attached, or has no tile
      open.delete(ev.id);
      out.push({ phase: 'end', id: ev.id, tile, at: ev.at });
    }
  }
  return out;
}

/** Aggregate across every model - the plain token counters shown in the UI. */
function sumUsageLines(text) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of sumUsageByModel(text).values()) {
    totals.input += t.input;
    totals.output += t.output;
    totals.cacheRead += t.cacheRead;
    totals.cacheWrite += t.cacheWrite;
  }
  return totals;
}

// Cennik ladujemy raz na proces (plik configu nie zmienia sie w trakcie sesji).
let ratesCache = null;

/**
 * Estimates session cost from per-model buckets.
 *
 * Each bucket is priced with ITS OWN model's rate and the results are summed, so
 * a mid-session `/model` switch keeps the earlier turns at the price actually
 * paid for them. A model missing from the price table contributes nothing and
 * flags the result `partial` - a silently incomplete number would read as a
 * complete one.
 * @param {Map<string, object>} byModel
 * @returns {{usd:number, partial:boolean}|null} null when nothing could be priced
 */
function estimateSessionCost(byModel) {
  if (!ratesCache) ratesCache = loadRates();
  const mult = {
    cacheReadMultiplier: ratesCache.cacheReadMultiplier,
    cacheWriteMultiplier: ratesCache.cacheWriteMultiplier,
  };

  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const [model, totals] of byModel) {
    const rate = rateFor(model, ratesCache.rates);
    if (!rate) {
      unpriced++;
      continue;
    }
    const part = estimateCost(totals, rate, mult);
    if (part) {
      usd += part.usd;
      priced++;
    }
  }
  if (priced === 0) return null;
  return { usd, partial: unpriced > 0 };
}

/**
 * Zamienia obiekt usage na metryki context window.
 * @param {object} usage pole `usage` z transkryptu
 * @param {string} [model] id modelu z tej samej linii - wyznacza realne okno
 */
function usageToMetrics(usage, model = '') {
  const tokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  // Okno liczone z modelu I z obserwacji - patrz komentarz w models.js.
  const limit = contextLimitFor(model, tokens);
  const percent = Math.min(1, tokens / limit);
  return { tokens, limit, percent, model: String(model || ''), modelLabel: modelLabel(model) };
}

/**
 * Cyklicznie sprawdza transcript i emituje metryki context window, gdy plik sie
 * zmieni. Czysto lokalne, zadnych zadan do modelu.
 *
 * Dwa tryby:
 *   * z `cwd`  - patrzy WYLACZNIE w katalog transcriptow tego katalogu roboczego.
 *                Tego wymaga tryb wielu sesji: przy dwoch zywych zakladkach
 *                "najswiezszy w calym drzewie" pokazywalby metryki tej, w ktorej
 *                ostatnio cos sie dzialo - czyli cudze liczby.
 *   * bez cwd  - stare zachowanie (najswiezszy w calym drzewie). Sluzy tez jako
 *                zapasowe wyjscie, dopoki katalog sesji nie powstanie: CLI tworzy
 *                go dopiero przy pierwszej wymianie zdan, a do tego czasu nie
 *                mamy czego tailowac.
 */
class TranscriptWatcher {
  /**
   * @param {(metrics: {tokens:number,limit:number,percent:number}) => void} onMetrics
   * @param {{cwd?: string, intervalMs?: number}} [options]
   */
  constructor(onMetrics, options = {}) {
    // Zgodnosc wstecz: kiedys drugim argumentem byl goly interwal w ms.
    const opts = typeof options === 'number' ? { intervalMs: options } : options || {};
    this.onMetrics = onMetrics;
    // Optional: called with Skill Tracker start/end events from newly appended
    // lines - never a bare tile list, the renderer needs both halves (B8).
    this.onTools = typeof opts.onTools === 'function' ? opts.onTools : null;
    // B8: tools currently in flight, id -> tile. Spans ticks by design - a tool
    // routinely starts in one appended chunk and finishes in a later one.
    this.openTools = new Map();
    this.intervalMs = opts.intervalMs || 1500;
    this.scopeDir = opts.cwd
      ? path.join(PROJECTS_DIR, encodeProjectDir(opts.cwd))
      : null;
    // Session id we asked the CLI for via `--session-id`. The transcript is
    // named after it, so this turns file selection from a guess into a lookup.
    this.sessionUuid = opts.sessionUuid || null;
    this.timer = null;
    this.currentFile = null;
    this.lastMtime = 0;
    // Plik przypisany tej sesji na stale (patrz pickFile).
    this.pinned = null;
    this.baseline = new Map();
    this.startedAt = 0;
    // B4: per-model usage for this session + how far we have already summed.
    this.byModel = new Map();
    this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.costOffset = 0;
    this.costFile = null;
  }

  /**
   * Doczytuje TYLKO to, co dopisano od ostatniego ticku, i dolicza do sumy.
   * Czytanie calego pliku co 1.5 s byloby marnotrawstwem przy dlugiej sesji,
   * a suma i tak jest przyrostowa. Offset przesuwamy wylacznie do ostatniego
   * pelnego "\n" - urwana linia doliczy sie przy nastepnym ticku.
   * @param {string} file
   */
  accumulate(file) {
    // Zmiana pliku (restart/przypiecie innej sesji) = liczymy od zera.
    if (file !== this.costFile) {
      this.costFile = file;
      this.costOffset = 0;
      this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      this.byModel = new Map();
      this.openTools.clear();
    }
    // A first pass over an existing file is HISTORY, not live activity: it would
    // flash every tile the session ever used. Tokens still count (the spend is
    // real); tiles do not.
    const firstPass = this.costOffset === 0;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      // Plik skrocony (rzadkie, ale nie zakladajmy) - przelicz od nowa.
      if (size < this.costOffset) {
        this.costOffset = 0;
        this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        this.byModel = new Map();
      }
      const length = size - this.costOffset;
      if (length <= 0) return;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, this.costOffset);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return; // jeszcze ani jednej pelnej linii
      const complete = text.slice(0, lastNewline);
      this.costOffset += Buffer.byteLength(complete, 'utf8') + 1;
      for (const [model, add] of sumUsageByModel(complete)) {
        let bucket = this.byModel.get(model);
        if (!bucket) {
          bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          this.byModel.set(model, bucket);
        }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          bucket[key] += add[key];
          this.totals[key] += add[key];
        }
      }

      if (this.onTools) {
        const events = foldToolEvents(this.openTools, toolEventsFromLines(complete));
        if (firstPass) {
          // Everything in that first pass already happened; a tool left open by
          // a killed session must not light a tile now. Fold it (so the map
          // stays balanced) and then forget it - history is history.
          this.openTools.clear();
        } else if (events.length > 0) {
          this.onTools(events);
        }
      }
    } catch {
      /* plik zniknal / brak dostepu - koszt po prostu sie nie zaktualizuje */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /**
   * Zdjecie stanu katalogu w chwili startu sesji. Wszystko, co bylo tu
   * wczesniej, nalezy do cudzych sesji - chyba ze zacznie rosnac po naszym
   * starcie, co oznacza wznowienie (--continue) wlasnie do tego pliku.
   */
  snapshotBaseline() {
    this.startedAt = Date.now();
    this.baseline = new Map();
    if (!this.scopeDir) return;
    for (const f of listJsonl(this.scopeDir)) this.baseline.set(f.full, f.mtimeMs);
  }

  /**
   * Wybiera plik do tailowania i PRZYPINA go na stale.
   *
   * Bez przypiecia kazdy tick bralby "najswiezszy w katalogu" - a przy dwoch
   * zakladkach na tym samym folderze najswiezszy jest ten, w ktorym ostatnio
   * cos napisano, czyli czesto cudzy. Wtedy pasek kontekstu klamie, a uzbrojony
   * auto-compact potrafi strzelic /compact w sesje, ktora wcale nie jest pelna.
   *
   * Kolejnosc wyboru:
   *   1. plik utworzony PO starcie sesji  -> nowa sesja, na pewno nasz
   *   2. plik z baseline, ktory urosl PO starcie -> wznowienie (--continue)
   * Pliki zajete przez inne watchery pomijamy. Gdy nie ma kandydata, zwracamy
   * null: swieza sesja, ktora jeszcze nie wymienila zdania, naprawde ma 0%.
   */
  pickFile() {
    if (this.pinned) return this.pinned;

    // Deterministic path: we told the CLI which session id to use, and the
    // transcript is named `<session-id>.jsonl`, so there is nothing to infer.
    // The heuristics below cannot distinguish two sessions started moments
    // apart in ONE folder - whichever watcher happens to tick first claims the
    // new file, regardless of which PTY actually created it. That race is what
    // swapped the readings between an Opus tab and a Sonnet tab.
    if (this.sessionUuid && this.scopeDir) {
      const target = path.join(this.scopeDir, `${this.sessionUuid}.jsonl`);
      if (!fs.existsSync(target)) return null; // not written yet - a fresh session really is 0%
      this.pinned = target;
      claimedTranscripts.add(target);
      return this.pinned;
    }

    if (!this.scopeDir) return findNewestTranscript();

    const free = listJsonl(this.scopeDir).filter((f) => !claimedTranscripts.has(f.full));
    const fresh = free.filter((f) => !this.baseline.has(f.full) || f.birthMs >= this.startedAt);
    const resumed = free.filter(
      (f) => this.baseline.has(f.full) && f.mtimeMs > this.baseline.get(f.full)
    );
    const pool = fresh.length > 0 ? fresh : resumed;
    if (pool.length === 0) {
      // Katalog jeszcze nie istnieje - dopoki tak jest, stary globalny fallback
      // nie moze pomylic sesji, bo innych zakladek na tym folderze nie ma.
      return fs.existsSync(this.scopeDir) ? null : findNewestTranscript();
    }

    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.pinned = pool[0].full;
    claimedTranscripts.add(this.pinned);
    return this.pinned;
  }

  start() {
    if (this.timer) return;
    this.snapshotBaseline();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick(); // pierwsza proba od razu
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Zwolnij rezerwacje, zeby restart tej samej zakladki mogl ja odzyskac.
    if (this.pinned) claimedTranscripts.delete(this.pinned);
    this.pinned = null;
  }

  tick() {
    const file = this.pickFile();
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

    this.accumulate(file); // B4: dolicz nowe linie do sumy sesji
    const sample = readLatestSample(file);
    if (!sample) return;

    const metrics = usageToMetrics(sample.usage, sample.model);
    // B6: which file these numbers came from. The renderer offers it as a
    // copy button - the pinning rules make "which transcript is this tab on"
    // a real question, and the answer is worth one click instead of a hunt.
    metrics.file = file;
    metrics.totals = { ...this.totals };
    metrics.elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    // Koszt tylko dla modeli z cennika - nieznany backend nie dostaje zmyslonej kwoty.
    // Priced per model, so switching mid-session does not re-price the history.
    const cost = estimateSessionCost(this.byModel);
    if (cost) metrics.cost = cost;
    this.onMetrics(metrics);
  }
}

module.exports = {
  detectTools,
  TranscriptWatcher,
  encodeProjectDir,
  usageToMetrics,
  sumUsageLines,
  sumUsageByModel,
  toolsFromLines,
  toolEventsFromLines,
  foldToolEvents,
  CONTEXT_LIMIT,
  TOOL_TILES,
};
