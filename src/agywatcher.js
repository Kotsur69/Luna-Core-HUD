// ============================================================================
// LunaCore - Antigravity (`agy`) transcript watcher (read-only)
// ----------------------------------------------------------------------------
// The agy counterpart of observer.js' TranscriptWatcher, for one tab: finds
// the agy conversation that tab runs, tails its transcript and emits the same
// tool events and context metrics (src/agytranscript.js does the parsing).
//
// Picking the conversation, like TranscriptWatcher.pickFile() does without a
// session id, plus a workspace check agy makes possible:
//   1. a resumed id from the start command (`--conversation=<id>`) is read
//      directly - nothing to guess;
//   2. otherwise a transcript created after the tab started (a new
//      conversation), else one that existed and grew since (`--continue`),
//   3. only if agy's conversation_summaries.db says it runs in THIS tab's
//      folder - agy's brain/ folder is shared by every workspace,
//   4. never one another agy tab has already claimed; newest wins.
// The pick is permanent. Known limit: a new conversation started inside the
// same agy process (its /clear) is not followed.
//
// Nothing here writes to agy's files. Every read is validated; whatever cannot
// be read is logged with its reason and skipped, never thrown.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathKey } = require('./gitattribution');
const { UUID_RE, parseSteps, AgyTranscriptState, agyContextMetrics, workspacesFromRows } = require('./agytranscript');

/** agy CLI's app data folder (the IDE and Antigravity 2.0 use sibling folders). */
const AGY_APP_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SUMMARIES_DB = 'conversation_summaries.db';
/** Full first: transcript.jsonl truncates large fields, which would undercount. */
const TRANSCRIPT_FILES = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);
const DEFAULT_INTERVAL_MS = 1500;
/** At most this much is read per tick; a long history is caught up over several. */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** Transcripts claimed by live agy watchers: one owner per file (cf. claimedTranscripts). */
const claimedAgyTranscripts = new Set();

const defaultLog = (msg) => console.warn(`[agy-transcript] ${msg}`);
const errText = (err) => (err && (err.code || err.message)) || String(err);

/** The logs folder of one conversation. */
function logsDirOf(appDataDir, id) {
  return path.join(appDataDir, 'brain', id, '.system_generated', 'logs');
}

/**
 * The transcript of one conversation: {id, full, mtimeMs}, or null when it
 * has none yet (a conversation writes its file with its first step).
 */
function transcriptOf(appDataDir, id) {
  for (const name of TRANSCRIPT_FILES) {
    const full = path.join(logsDirOf(appDataDir, id), name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return { id, full, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
  }
  return null;
}

/**
 * Every conversation transcript under <appData>/brain. A missing brain folder
 * (agy never ran) is an empty list; any other failure throws to the caller.
 * @returns {{id:string, full:string, mtimeMs:number}[]}
 */
function listAgyTranscripts(appDataDir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(appDataDir, 'brain'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const found = transcriptOf(appDataDir, entry.name.toLowerCase());
    if (found) out.push(found);
  }
  return out;
}

/**
 * conversation id -> workspace folders, read from agy's summaries database.
 * @returns {{ok:true, byId:Map<string,string[]>}|{ok:false, reason:string}}
 */
function readConversationWorkspaces(appDataDir) {
  const file = path.join(appDataDir, SUMMARIES_DB);
  if (!fs.existsSync(file)) return { ok: false, reason: `${SUMMARIES_DB} not found` };
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('select conversation_id, workspace_uris from conversation_summaries').all();
    return { ok: true, byId: workspacesFromRows(rows) };
  } catch (err) {
    return { ok: false, reason: `${SUMMARIES_DB} unreadable (${errText(err)})` };
  } finally {
    if (db) db.close();
  }
}

/** Reads `length` bytes at `offset` as UTF-8. */
function readRange(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

class AgyTranscriptWatcher {
  /**
   * @param {(metrics: object) => void} onMetrics context metrics (estimated)
   * @param {{cwd?: string, conversationId?: string|null, onTools?: Function,
   *   intervalMs?: number, appDataDir?: string, log?: (msg: string) => void}} [opts]
   */
  constructor(onMetrics, opts = {}) {
    this.onMetrics = typeof onMetrics === 'function' ? onMetrics : () => {};
    this.onTools = typeof opts.onTools === 'function' ? opts.onTools : null;
    this.cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
    const id = typeof opts.conversationId === 'string' ? opts.conversationId.toLowerCase() : '';
    this.conversationId = UUID_RE.test(id) ? id : null;
    this.appDataDir = opts.appDataDir || AGY_APP_DATA_DIR;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.log = typeof opts.log === 'function' ? opts.log : defaultLog;
    this.logged = new Set();
    this.timer = null;
    this.startedAt = 0;
    /** transcript path -> mtime when the tab started: someone else's, unless it grows. */
    this.baseline = new Map();
    this.pinned = null;
    this.offset = 0;
    /** Bytes of the pinned file that were already there: history, not live activity. */
    this.historyUntil = 0;
    this.lastSize = -1;
    this.lastMtime = 0;
    /** Whether a reading of the pinned file went out yet (an empty conversation still shows 0 %). */
    this.emitted = false;
    this.state = new AgyTranscriptState({ cwd: this.cwd });
  }

  /** Logs a reason once per watcher, so a broken file does not flood the log every tick. */
  warnOnce(key, msg) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(msg);
  }

  start() {
    if (this.timer) return;
    this.snapshotBaseline();
    this.timer = setInterval(() => this.safeTick(), this.intervalMs);
    this.safeTick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pinned) claimedAgyTranscripts.delete(this.pinned);
    this.pinned = null;
  }

  snapshotBaseline() {
    this.startedAt = Date.now();
    this.baseline = new Map();
    try {
      for (const t of listAgyTranscripts(this.appDataDir)) this.baseline.set(t.full, t.mtimeMs);
    } catch (err) {
      this.warnOnce('baseline', `cannot list agy conversations in ${this.appDataDir}: ${errText(err)}`);
    }
  }

  /** One tick, and nothing it throws escapes into the main process. */
  safeTick() {
    try {
      this.tick();
    } catch (err) {
      this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
    }
  }

  /** Pins `full` for good. `resumed`: what it already holds is history. */
  pin(full, resumed) {
    this.pinned = full;
    claimedAgyTranscripts.add(full);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (err) {
      this.warnOnce('pin-stat', `cannot stat ${full}: ${errText(err)}`);
    }
    this.historyUntil = resumed ? size : 0;
    return full;
  }

  pickFile() {
    if (this.pinned) return this.pinned;
    if (this.conversationId) {
      const found = transcriptOf(this.appDataDir, this.conversationId);
      return found ? this.pin(found.full, true) : null;
    }
    const free = listAgyTranscripts(this.appDataDir).filter((t) => !claimedAgyTranscripts.has(t.full));
    const fresh = free.filter((t) => !this.baseline.has(t.full));
    const resumed = free.filter((t) => this.baseline.has(t.full) && t.mtimeMs > this.baseline.get(t.full));
    const pool = this.inThisFolder(fresh.length > 0 ? fresh : resumed);
    if (pool.length === 0) return null;
    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return this.pin(pool[0].full, this.baseline.has(pool[0].full));
  }

  /** Keeps the conversations agy records as running in this tab's folder. */
  inThisFolder(pool) {
    if (pool.length === 0 || !this.cwd) return pool;
    const ws = readConversationWorkspaces(this.appDataDir);
    if (!ws.ok) {
      // Without the database the folder cannot be checked; time and claims
      // still keep two tabs apart unless both start a conversation at once.
      this.warnOnce('workspaces', `${ws.reason}; matching agy conversations to this tab by time only`);
      return pool;
    }
    const folder = pathKey(this.cwd);
    // A conversation with no row yet is skipped now and picked up next tick.
    return pool.filter((t) => (ws.byId.get(t.id) || []).includes(folder));
  }

  tick() {
    const file = this.pickFile();
    if (!file) return;
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      this.warnOnce(`stat:${errText(err)}`, `cannot stat ${file}: ${errText(err)}`);
      return;
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return;
    const before = this.offset;
    const caughtUp = this.accumulate(file, st.size);
    // Only a complete read moves the marker, so a failed or partial read is retried.
    if (caughtUp) {
      this.lastSize = st.size;
      this.lastMtime = st.mtimeMs;
    }
    // A line still being written changes nothing: no repeat of the same reading.
    if (this.emitted && this.offset === before) return;
    this.emitted = true;
    this.onMetrics(agyContextMetrics(this.state.contextChars, { file, elapsedMs: Date.now() - this.startedAt }));
  }

  /**
   * Reads what was appended since the last tick (complete lines only) and
   * folds it into the state.
   * @returns {boolean} true when the read reached the end of the file
   */
  accumulate(file, size) {
    if (size < this.offset) {
      // Truncated or replaced: count again from the start.
      this.offset = 0;
      this.historyUntil = 0;
      this.state = new AgyTranscriptState({ cwd: this.cwd });
    }
    const length = Math.min(size - this.offset, MAX_CHUNK_BYTES);
    if (length <= 0) return true;
    const inHistory = this.offset < this.historyUntil;
    const text = readRange(file, this.offset, length);
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) {
      if (length < MAX_CHUNK_BYTES) return false; // a line still being written
      this.log(`skipped ${length} bytes of ${file}: no line end within ${MAX_CHUNK_BYTES} bytes`);
      this.offset += length;
      return false;
    }
    const complete = text.slice(0, lastNewline);
    this.offset += Buffer.byteLength(complete, 'utf8') + 1;
    const { steps, skipped } = parseSteps(complete);
    if (skipped.length > 0) {
      this.log(`skipped ${skipped.length} unreadable line(s) of ${file}; first: ${skipped[0].reason}`);
    }
    const events = this.state.apply(steps);
    if (inHistory) {
      // A resumed conversation's past is not live activity, and a call it
      // left open (a killed session) must not light anything now.
      if (this.offset >= this.historyUntil) this.state.forgetPending();
    } else if (events.length > 0 && this.onTools) {
      this.onTools(events);
    }
    return this.offset >= size;
  }
}

module.exports = {
  AGY_APP_DATA_DIR,
  TRANSCRIPT_FILES,
  AgyTranscriptWatcher,
  listAgyTranscripts,
  readConversationWorkspaces,
};
