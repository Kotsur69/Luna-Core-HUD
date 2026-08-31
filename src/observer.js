// ============================================================================
// LunaCore - Passive Observer (Phase 3)
// ----------------------------------------------------------------------------
// Pure, passive metrics extraction. ZERO extra tokens:
//   * detectTools()          - detects tool names in raw PTY stdout
//                              (strip ANSI + match against known tools).
//   * TranscriptWatcher      - tails Claude Code's JSONL transcript file and
//                              computes real context-window usage from the usage field.
//
// Nothing here writes to `claude` or modifies its input - it only reads.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// Model knowledge: the real context window + a short label for the tile.
const { contextLimitFor, modelLabel, DEFAULT_CONTEXT_LIMIT } = require('./models');
// Price table for session cost estimation (B4). Reads only from config/, no network.
const { loadRates, rateFor, estimateCost } = require('./rates');
// Diff-stat extraction for the Active-Files Heatmap (ACTIVE_FILES_HEATMAP_PLAN.md).
const { fileStatFromEntry, estimateTokens } = require('./filestat');

// ---- 1. Tool detection from stdout -----------------------------------------

// ANSI/VT sequences: CSI (\x1b[...X), OSC (\x1b]...BEL/ST), and simple \x1b(B etc.
// We strip them so the tool regex works against clean TUI text.
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Known Claude Code tools. In the TUI a call renders as "Name(args)".
 * Key = the tile label in the Skill Tracker (data-skill in index.html).
 * Value = a regex alternation of names that map to this tile.
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

// Reverse map: tool name -> tile. Plus a single regex for all of them.
const TOOL_TO_TILE = new Map();
for (const [tile, names] of Object.entries(TOOL_TILES)) {
  for (const n of names) TOOL_TO_TILE.set(n, tile);
}
const ALL_TOOL_NAMES = [...TOOL_TO_TILE.keys()];
// Matches "Name(" - the shape Claude Code writes an active tool as in the stream.
const TOOL_RE = new RegExp('\\b(' + ALL_TOOL_NAMES.join('|') + ')\\(', 'g');

/**
 * Returns the list of tiles that should light up for a given stdout chunk.
 * @param {string} raw raw data from ptyProcess.onData
 * @returns {string[]} unique tile labels (e.g. ["Shell", "Read"])
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

/**
 * Detects whether a raw stdout fragment contains an approval prompt (Claude
 * Code's y/n TUI). A heuristic over LITERAL substrings from
 * config/sound-triggers.json - see src/soundTriggers.js and
 * SOUNDS_IMPLEMENTATION_PLAN.md §3. Deliberately version-fragile: the TUI text
 * can change between CLI releases, which is why it is data (config), not a
 * constant in code.
 *
 * Whitespace on both sides is collapsed to single spaces before matching. The
 * TUI hard-wraps a long line at the viewport edge, so "API Error: Connection
 * lost mid-response" can reach us as two lines plus indentation, which a raw
 * includes() misses. Collapsing is what makes the match survive a reflow -
 * without it the same error is detected at one window width and not at
 * another, which is half of why auto-proceed only fired "sometimes".
 * @param {string} raw raw data from ptyProcess.onData
 * @param {string[]} patterns literal substrings, case-sensitive
 * @returns {boolean}
 */
function detectApprovalPrompt(raw, patterns) {
  if (!raw || !Array.isArray(patterns) || patterns.length === 0) return false;
  const clean = collapseWhitespace(String(raw).replace(ANSI_RE, ''));
  return patterns.some(
    (p) => typeof p === 'string' && p && clean.includes(collapseWhitespace(p)),
  );
}

/** Every run of whitespace (newlines and TUI padding included) -> one space. */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

// ---- 2. Tailing the JSONL transcript (real tokens) -------------------------

// Default context window. No longer a hard constant used for computation -
// the real limit is determined by models.contextLimitFor() from the model in
// the transcript and the observed usage. Kept as a default value/export.
const CONTEXT_LIMIT = DEFAULT_CONTEXT_LIMIT;

// Directory where Claude Code keeps session transcripts (per project).
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// How many bytes from the end of the file we read while looking for the last usage entry.
const TAIL_BYTES = 128 * 1024;

/**
 * Turns a working directory into the name of the directory where Claude Code
 * keeps its transcripts. The CLI encodes the path by replacing every
 * non-alphanumeric character with a hyphen, e.g.:
 *   C:\Users\mmazur\.local\bin  ->  C--Users-mmazur--local-bin
 * (the double hyphen comes from the separator + dot pair).
 *
 * This is the crux of handling multiple sessions at once: without it there is
 * no way to tell which transcript belongs to which tab.
 * @param {string} cwd
 * @returns {string}
 */
function encodeProjectDir(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Transcript files already claimed by live watchers.
 *
 * The transcript directory is keyed by FOLDER, and the file by SESSION - so
 * two tabs open on the same repo see the same directory holding two files.
 * Without a reservation both would pick the "newest one" and show the same
 * session. All watchers live in the same main process, so a plain Set is
 * enough as a registry: each file can have only one owner.
 */
const claimedTranscripts = new Set();

/** Returns [{ full, mtimeMs, birthMs }] for the .jsonl files in a directory. */
function listJsonl(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // the session directory does not exist yet
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(dir, file);
    try {
      const st = fs.statSync(full);
      out.push({ full, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.ctimeMs });
    } catch {
      /* file vanished between readdir and stat - ignore */
    }
  }
  return out;
}

/** Finds the newest .jsonl file across the ~/.claude/projects tree. */
function findNewestTranscript() {
  let newest = null;
  let newestMtime = 0;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null; // directory does not exist yet
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
        /* file vanished between readdir and stat - ignore */
      }
    }
  }
  return newest;
}

/**
 * Reads the tail of a file and returns the latest sample: { usage, model } (or null).
 * The model is taken from the same line as usage - one parse, two payoffs:
 * the real context window (B2) and the model badge (B3).
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
    // Walk from the end - we want the most recent entry that carries usage.
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
        /* incomplete/corrupt line (e.g. a truncated write) - keep trying */
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
      /* incomplete/corrupt line - skip */
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
 * Also carries file identity + diff stats for the Active-Files Heatmap
 * (ACTIVE_FILES_HEATMAP_PLAN.md §3.2): a start event's `file` comes from the
 * tool's own `input.file_path` (the documented tool schema); an end event's
 * `added`/`removed` come from the entry's top-level `toolUseResult` (an
 * undocumented CLI artefact - see plan §12/R4), read via fileStatFromEntry()
 * ONLY when the entry holds exactly one tool_result block, since that is the
 * only case where the single top-level `toolUseResult` is unambiguously
 * attributable to it (plan §2.5). Ambiguous or resultless entries still emit
 * their end event, just with file:'' and added/removed:0 - a dim row, not a
 * missing one.
 *
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {{phase:'start'|'end', id:string, tile?:string, at:number|null, file:string, added?:number, removed?:number}[]}
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
      const resultCount = content.reduce((n, p) => n + (p && p.type === 'tool_result' ? 1 : 0), 0);
      const stat = resultCount === 1 ? fileStatFromEntry(obj.toolUseResult) : null;
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'tool_use' && typeof part.id === 'string') {
          const tile = TOOL_TO_TILE.get(part.name);
          // No tile (an MCP tool, say) means nothing to light - and skipping the
          // start means its end is later ignored as an orphan, which is correct.
          if (tile) {
            const file = part.input && typeof part.input.file_path === 'string' ? part.input.file_path : '';
            events.push({ phase: 'start', id: part.id, tile, at, file });
          }
        } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          events.push({
            phase: 'end',
            id: part.tool_use_id,
            at,
            file: stat ? stat.file : '',
            added: stat ? stat.added : 0,
            removed: stat ? stat.removed : 0,
            // What this call put into the context window - non-zero only for a
            // Read. See the per-file weight note in src/filestat.js.
            //
            // The token ESTIMATE is made here rather than in the renderer so the
            // chars-per-token ratio has exactly one home. The renderer only ever
            // sums what it is given; it never re-derives the number, which is
            // how two parts of one HUD end up disagreeing about it.
            contextChars: stat ? stat.contextChars || 0 : 0,
            contextTokens: stat ? estimateTokens(stat.contextChars || 0, stat.file) : 0,
          });
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
 * `open`'s value is `{tile, file}`, not a bare tile string, so the file
 * identity survives the same cross-chunk gap the tile already does - the
 * file path is the identical "the end doesn't repeat what the start said"
 * problem the tile has, so it belongs here rather than in a per-widget join
 * map in the renderer (ACTIVE_FILES_HEATMAP_PLAN.md §3.2). The diff stat
 * itself (`added`/`removed`) is NOT joined through `open` - it travels on
 * the end event directly, straight from toolEventsFromLines().
 *
 * @param {Map<string,{tile:string, file:string}>} open live id -> {tile, file} map, mutated in place
 * @param {{phase:string, id:string, tile?:string, at:number|null, file?:string, added?:number, removed?:number}[]} events
 * @returns {{phase:'start'|'end', id:string, tile:string, at:number|null, file:string, added?:number, removed?:number}[]}
 */
function foldToolEvents(open, events) {
  const out = [];
  for (const ev of events || []) {
    if (ev.phase === 'start') {
      if (open.has(ev.id)) continue; // already counted - re-read of the same line
      const file = ev.file || '';
      open.set(ev.id, { tile: ev.tile, file });
      out.push({ phase: 'start', id: ev.id, tile: ev.tile, at: ev.at, file });
    } else {
      const opened = open.get(ev.id);
      if (!opened) continue; // orphan: started before we attached, or has no tile
      open.delete(ev.id);
      out.push({
        phase: 'end',
        id: ev.id,
        tile: opened.tile,
        at: ev.at,
        file: opened.file,
        added: ev.added || 0,
        removed: ev.removed || 0,
      });
    }
  }
  return out;
}

// ---- MCP call lifecycle (CONCEPT_MCP_DEBUGGER.md, safe half: no interception,
// no config writes - just the same transcript tailing every other Passive
// Observer here already does) -------------------------------------------------

// Non-greedy up to the first `__` - same rule mcphealth.js's NAME_RE anchors
// on, so a server name containing its own single underscores (e.g.
// `codebase-memory-mcp`, `claude_ai_Bigdata_com`) still splits correctly.
const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/**
 * Extracts MCP tool call lifecycle from a JSONL fragment - the same start/end
 * split as toolEventsFromLines()/foldToolEvents() (B8), but for MCP tools
 * specifically. toolEventsFromLines() skips them outright (an MCP name maps
 * to no Skill Tracker tile); this reads the same two entry shapes for the
 * server/tool/input/result payload instead of a tile.
 *
 * A tool_result entry never repeats the call's name (toolEventsFromLines'
 * own comment on this still applies), so every tool_result is emitted as an
 * end CANDIDATE regardless of what closed it, and left for foldMcpEvents() to
 * match against an open MCP call - or drop as an orphan when it closes some
 * other (non-MCP) tool instead. There is deliberately no 'mcp__' prefilter on
 * the whole line for this reason: a result line for an MCP call does not
 * itself contain that substring.
 *
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {{phase:'start', id:string, at:number|null, server:string, tool:string, input:object}
 *         | {phase:'end', id:string, at:number|null, content:*, ok:boolean}[]}
 */
function mcpEventsFromLines(text) {
  const events = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj && obj.message && obj.message.content;
      if (!Array.isArray(content)) continue;
      const at = Date.parse(obj.timestamp) || null;
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
          const m = MCP_NAME_RE.exec(part.name);
          if (!m) continue; // not an MCP tool - toolEventsFromLines() already covers those
          events.push({ phase: 'start', id: part.id, server: m[1], tool: m[2], input: part.input || {}, at });
        } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          events.push({ phase: 'end', id: part.tool_use_id, at, content: part.content, ok: part.is_error !== true });
        }
      }
    } catch {
      /* incomplete/corrupt line - skip */
    }
  }
  return events;
}

/**
 * Folds raw mcpEventsFromLines() output into balanced start/end pairs,
 * mirroring foldToolEvents()'s open-map-spans-ticks reasoning (a call
 * routinely starts in one appended chunk and finishes in a later one), but
 * carrying MCP payload (server/tool/input on start, content/ok/latency on
 * end) instead of a tile.
 *
 * @param {Map<string,{server:string, tool:string, input:object, at:number|null}>} open mutated in place
 * @param {ReturnType<typeof mcpEventsFromLines>} events
 * @returns {object[]} balanced start/end events, in file order
 */
function foldMcpEvents(open, events) {
  const out = [];
  for (const ev of events || []) {
    if (ev.phase === 'start') {
      if (open.has(ev.id)) continue; // already counted - re-read of the same line
      open.set(ev.id, { server: ev.server, tool: ev.tool, input: ev.input, at: ev.at });
      out.push({ phase: 'start', id: ev.id, server: ev.server, tool: ev.tool, input: ev.input, at: ev.at });
    } else {
      const opened = open.get(ev.id);
      if (!opened) continue; // orphan: this tool_result closed something else, or a call from before we attached
      open.delete(ev.id);
      out.push({
        phase: 'end',
        id: ev.id,
        server: opened.server,
        tool: opened.tool,
        input: opened.input,
        at: ev.at,
        ms: ev.at && opened.at ? ev.at - opened.at : null,
        ok: ev.ok !== false,
        content: ev.content,
      });
    }
  }
  return out;
}

// ---- 3. Task-complete detection (turn start/end, SOUNDS_IMPLEMENTATION_PLAN.md §3) --

/**
 * True if this fragment contains an assistant message whose turn is fully
 * done - `stop_reason` present and not `"tool_use"` (which means the turn
 * still has a pending tool call, control has not returned to Mati yet).
 * More reliable than regexing stdout for "is Claude done talking", and reuses
 * the same JSONL file TranscriptWatcher already tails - no new file I/O.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {boolean}
 */
function hasTurnEnd(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"stop_reason"')) continue;
    try {
      const obj = JSON.parse(line);
      const reason = obj && obj.message && obj.message.stop_reason;
      if (reason && reason !== 'tool_use') return true;
    } catch {
      /* incomplete line - skip */
    }
  }
  return false;
}

/**
 * True if this fragment contains a genuine user-authored prompt - a
 * `role: 'user'` message whose content is NOT purely `tool_result` blocks.
 * Claude Code also writes a `role: 'user'` entry to re-inject a finished
 * tool's output (see `resLine()` in test/observer.test.js) - that is the CLI
 * talking to itself, not Mati, so it must not reset the turn-start clock the
 * long-task announcement (§11.1) times against.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {boolean}
 */
function hasUserPromptStart(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"role"')) continue;
    try {
      const obj = JSON.parse(line);
      const message = obj && obj.message;
      if (!message || message.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string' && content.trim()) return true;
      if (Array.isArray(content) && content.some((p) => p && p.type && p.type !== 'tool_result')) {
        return true;
      }
    } catch {
      /* incomplete line - skip */
    }
  }
  return false;
}

/**
 * Gate for the "All done" announcement (§11.1): only fire when the completed
 * turn ran at least `thresholdMinutes` - Mati does not want a chime after
 * every quick back-and-forth, only after a long one ("like 10 mins Claude
 * cogitated"). `startedAt` of 0 means no user prompt was ever observed for
 * this turn (e.g. the watcher attached mid-turn on app restart) - treated as
 * unknown duration, so it does NOT announce rather than guessing.
 * @param {number} startedAt Date.now() when hasUserPromptStart() last fired, or 0
 * @param {number} endedAt Date.now() when hasTurnEnd() fired
 * @param {number} thresholdMinutes from the soundLongTaskMinutes preference
 * @returns {boolean}
 */
function isLongTurn(startedAt, endedAt, thresholdMinutes) {
  if (!startedAt || !endedAt || endedAt < startedAt) return false;
  const minutes = typeof thresholdMinutes === 'number' && thresholdMinutes >= 0 ? thresholdMinutes : 10;
  return endedAt - startedAt >= minutes * 60000;
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

// The price table is loaded once per process (the config file does not change mid-session).
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
 * Turns a usage object into context-window metrics.
 * @param {object} usage the `usage` field from the transcript
 * @param {string} [model] model id from the same line - determines the real window
 */
function usageToMetrics(usage, model = '') {
  const tokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  // Window computed from the model AND from observation - see the comment in models.js.
  const limit = contextLimitFor(model, tokens);
  const percent = Math.min(1, tokens / limit);
  return { tokens, limit, percent, model: String(model || ''), modelLabel: modelLabel(model) };
}

/**
 * Periodically checks the transcript and emits context-window metrics when
 * the file changes. Purely local, no calls to the model.
 *
 * Two modes:
 *   * with `cwd`    - looks ONLY in that working directory's transcript folder.
 *                     Required by multi-session mode: with two live tabs, "the
 *                     newest across the whole tree" would show the metrics of
 *                     whichever one last did something - someone else's numbers.
 *   * without cwd   - the old behaviour (newest across the whole tree). Also
 *                     serves as a fallback until the session directory exists:
 *                     the CLI only creates it on the first exchange, and until
 *                     then there is nothing to tail.
 */
class TranscriptWatcher {
  /**
   * @param {(metrics: {tokens:number,limit:number,percent:number}) => void} onMetrics
   * @param {{cwd?: string, intervalMs?: number}} [options]
   */
  constructor(onMetrics, options = {}) {
    // Backward compatibility: the second argument used to be a bare interval in ms.
    const opts = typeof options === 'number' ? { intervalMs: options } : options || {};
    this.onMetrics = onMetrics;
    // Optional: called with Skill Tracker start/end events from newly appended
    // lines - never a bare tile list, the renderer needs both halves (B8).
    this.onTools = typeof opts.onTools === 'function' ? opts.onTools : null;
    // B8: tools currently in flight, id -> tile. Spans ticks by design - a tool
    // routinely starts in one appended chunk and finishes in a later one.
    this.openTools = new Map();
    // Optional: called with MCP call start/end events (CONCEPT_MCP_DEBUGGER.md,
    // safe half) - same shape/reasoning as onTools, for mcp__ calls specifically.
    this.onMcp = typeof opts.onMcp === 'function' ? opts.onMcp : null;
    this.openMcp = new Map();
    // Optional: called with { startedAt, endedAt } when hasTurnEnd() fires on
    // newly appended lines (§4.3/§11.1's "All done" announcement).
    this.onTurnEnd = typeof opts.onTurnEnd === 'function' ? opts.onTurnEnd : null;
    // Wall-clock of the last genuine user prompt seen (hasUserPromptStart()).
    // 0 = none observed yet this session/tick-history, so a turn end right
    // now has an unknown duration (isLongTurn() treats that as "don't fire").
    this.turnStartedAt = 0;
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
    // The file permanently assigned to this session (see pickFile).
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
   * Reads ONLY what was appended since the last tick and adds it to the total.
   * Reading the whole file every 1.5 s would be wasteful over a long session,
   * and the sum is incremental anyway. The offset only ever advances to the
   * last complete "\n" - a truncated line gets picked up on the next tick.
   * @param {string} file
   */
  accumulate(file) {
    // A file change (restart / claiming a different session) = start counting from zero.
    if (file !== this.costFile) {
      this.costFile = file;
      this.costOffset = 0;
      this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      this.byModel = new Map();
      this.openTools.clear();
      this.openMcp.clear();
      this.turnStartedAt = 0;
    }
    // A first pass over an existing file is HISTORY, not live activity: it would
    // flash every tile the session ever used. Tokens still count (the spend is
    // real); tiles do not.
    const firstPass = this.costOffset === 0;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      // File got truncated (rare, but let's not assume otherwise) - recompute from scratch.
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
      if (lastNewline < 0) return; // not even one complete line yet
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

      if (this.onMcp) {
        const mcpEvents = foldMcpEvents(this.openMcp, mcpEventsFromLines(complete));
        if (firstPass) {
          // Same reasoning as onTools' firstPass guard above: a resumed
          // session's PAST calls must not replay as live flow/history now.
          this.openMcp.clear();
        } else if (mcpEvents.length > 0) {
          this.onMcp(mcpEvents);
        }
      }

      // §4.3/§11.1: guarded by !firstPass for the same reason as onTools above
      // - a resumed session's PAST turns must not replay a stale start/end.
      if (!firstPass) {
        if (hasUserPromptStart(complete)) this.turnStartedAt = Date.now();
        if (this.onTurnEnd && hasTurnEnd(complete)) {
          const startedAt = this.turnStartedAt;
          // Consumed: the NEXT end without a fresh start in between has an
          // unknown duration (isLongTurn() then correctly refuses to fire).
          this.turnStartedAt = 0;
          // `text` is the raw newly-appended fragment - §11.2's
          // ttsExtract.extractSpokenText() reads it to speak the turn aloud.
          // Passed through verbatim rather than parsed here: this watcher
          // stays a dumb signal source, the same split hasTurnEnd()/
          // isLongTurn() already use (detect here, decide at the call site).
          this.onTurnEnd({ startedAt, endedAt: Date.now(), text: complete });
        }
      }
    } catch {
      /* file vanished / no access - the cost simply does not get updated */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /**
   * A snapshot of the directory's state at session start. Everything that was
   * here already belongs to someone else's sessions - unless it starts growing
   * after our start, which means a resume (--continue) into exactly this file.
   */
  snapshotBaseline() {
    this.startedAt = Date.now();
    this.baseline = new Map();
    if (!this.scopeDir) return;
    for (const f of listJsonl(this.scopeDir)) this.baseline.set(f.full, f.mtimeMs);
  }

  /**
   * Picks the file to tail and PINS it permanently.
   *
   * Without pinning, every tick would pick "the newest in the directory" - and
   * with two tabs on the same folder, the newest is whichever one last had
   * something written to it, which is often someone else's. Then the context
   * bar lies, and an armed auto-compact can fire /compact into a session that
   * is not actually full.
   *
   * Selection order:
   *   1. a file created AFTER the session started  -> a new session, definitely ours
   *   2. a baseline file that grew AFTER the start  -> a resume (--continue)
   * Files claimed by other watchers are skipped. When there is no candidate,
   * returns null: a fresh session that has not exchanged a message yet really is 0%.
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
      // Directory does not exist yet - as long as that holds, the old global
      // fallback cannot mix up sessions, since there are no other tabs on this folder.
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
    this.tick(); // first attempt immediately
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Release the reservation so a restart of the same tab can reclaim it.
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
    // Nothing changed since the last read - skip parsing.
    if (file === this.currentFile && mtime === this.lastMtime) return;
    this.currentFile = file;
    this.lastMtime = mtime;

    this.accumulate(file); // B4: add the new lines to the session total
    const sample = readLatestSample(file);
    if (!sample) return;

    const metrics = usageToMetrics(sample.usage, sample.model);
    // B6: which file these numbers came from. The renderer offers it as a
    // copy button - the pinning rules make "which transcript is this tab on"
    // a real question, and the answer is worth one click instead of a hunt.
    metrics.file = file;
    metrics.totals = { ...this.totals };
    metrics.elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    // Cost only for models in the price table - an unknown backend gets no made-up amount.
    // Priced per model, so switching mid-session does not re-price the history.
    const cost = estimateSessionCost(this.byModel);
    if (cost) metrics.cost = cost;
    this.onMetrics(metrics);
  }
}

module.exports = {
  detectTools,
  detectApprovalPrompt,
  TranscriptWatcher,
  encodeProjectDir,
  usageToMetrics,
  sumUsageLines,
  sumUsageByModel,
  // Exported for the session -> Markdown export (src/sessionExport.js) so the
  // per-model pricing loop has exactly one home, not a second copy.
  estimateSessionCost,
  toolsFromLines,
  toolEventsFromLines,
  foldToolEvents,
  mcpEventsFromLines,
  foldMcpEvents,
  hasTurnEnd,
  hasUserPromptStart,
  isLongTurn,
  CONTEXT_LIMIT,
  TOOL_TILES,
};
