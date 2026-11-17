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
//   2. otherwise a conversation created after the tab started (a new one),
//      else one that existed and grew since (`--continue`);
//   3. only if agy's conversation_summaries.db says it runs in THIS tab's
//      folder (or, failing an exact match, in a folder containing it) - agy's
//      brain/ folder is shared by every workspace;
//   4. never one another agy tab has already claimed; newest wins.
// The pick is permanent. Known limit: a new conversation started inside the
// same agy process (its /clear) is not followed.
//
// Without a readable database (agy never wrote one, this Node has no
// node:sqlite, or the file is broken) the folder cannot be checked and the
// pick goes by time and claims alone. A database agy holds locked right now
// is read again next tick instead.
//
// Nothing here writes to agy's files, and a symlinked transcript is ignored.
// Every read is validated; whatever cannot be read is logged with its reason
// and skipped, never thrown.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathKey } = require('./gitattribution');
const {
  UUID_RE, parseSteps, AgyTranscriptState, agyContextMetrics, workspacesFromRows, workspaceMatch,
} = require('./agytranscript');

/** agy CLI's app data folder (the IDE and Antigravity 2.0 use sibling folders). */
const AGY_APP_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SUMMARIES_DB = 'conversation_summaries.db';
/** Full first: transcript.jsonl truncates large fields, which would undercount. */
const TRANSCRIPT_FILES = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);
const DEFAULT_INTERVAL_MS = 1500;
/** At most this much is read per tick; a long history is caught up over several. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** How long a read waits for agy's lock on the summaries database (blocks the main process). */
const DB_BUSY_TIMEOUT_MS = 100;
/** SQLite result codes that pass on their own: SQLITE_BUSY, SQLITE_LOCKED (low byte of an extended code). */
const TRANSIENT_SQLITE_CODES = new Set([5, 6]);
const NEWLINE = 0x0a;

/** Conversations claimed by live agy watchers, one owner each (cf. claimedTranscripts). */
const claimedAgyConversations = new Set();

const defaultLog = (msg) => console.warn(`[agy-transcript] ${msg}`);
const errText = (err) => (err && (err.code || err.message)) || String(err);

/** The logs folder of one conversation. */
function logsDirOf(appDataDir, dirName) {
  return path.join(appDataDir, 'brain', dirName, '.system_generated', 'logs');
}

/**
 * The transcript of one conversation: {id, full, mtimeMs}, or null when it
 * has none yet (a conversation writes its file with its first step).
 * @param {string} dirName the folder name as it is on disk; `id` is its lowercase form
 */
function transcriptOf(appDataDir, dirName) {
  for (const name of TRANSCRIPT_FILES) {
    const full = path.join(logsDirOf(appDataDir, dirName), name);
    try {
      // lstat: a symlink is not followed, it could point anywhere on the disk.
      const st = fs.lstatSync(full);
      if (st.isFile()) return { id: dirName.toLowerCase(), full, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
  }
  return null;
}

/**
 * Every conversation transcript under <appData>/brain. A missing brain folder
 * (agy never ran) is an empty list. A conversation that cannot be read goes
 * to `onSkip` and is left out; without `onSkip` that failure throws.
 * @param {string} appDataDir
 * @param {(dirName: string, err: Error) => void} [onSkip]
 * @returns {{id:string, full:string, mtimeMs:number}[]}
 */
function listAgyTranscripts(appDataDir, onSkip) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(appDataDir, 'brain'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    // A Dirent does not follow links: a symlinked conversation folder is skipped.
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      const found = transcriptOf(appDataDir, entry.name);
      if (found) out.push(found);
    } catch (err) {
      if (!onSkip) throw err;
      onSkip(entry.name, err);
    }
  }
  return out;
}

/**
 * conversation id -> workspace folders, read from agy's summaries database.
 * `retry` says the failure passes on its own (agy holds the database
 * locked); anything else - no database, no node:sqlite, a broken file or a
 * schema this code does not know - will not.
 * @returns {{ok:true, byId:Map<string,string[]>, skipped:number}
 *   | {ok:false, retry:boolean, reason:string}}
 */
function readConversationWorkspaces(appDataDir) {
  const file = path.join(appDataDir, SUMMARIES_DB);
  if (!fs.existsSync(file)) return { ok: false, retry: false, reason: `${SUMMARIES_DB} not found` };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    return { ok: false, retry: false, reason: `node:sqlite unavailable (${errText(err)})` };
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: DB_BUSY_TIMEOUT_MS });
    const rows = db.prepare('select conversation_id, workspace_uris from conversation_summaries').all();
    const { byId, skipped } = workspacesFromRows(rows);
    return { ok: true, byId, skipped };
  } catch (err) {
    const retry = Number.isInteger(err && err.errcode) && TRANSIENT_SQLITE_CODES.has(err.errcode & 0xff);
    const why = (err && err.message) || errText(err);
    return { ok: false, retry, reason: `${SUMMARIES_DB} ${retry ? 'busy' : 'unreadable'} (${why})` };
  } finally {
    if (db) db.close();
  }
}

/** Reads up to `length` bytes at `offset`; the Buffer holds what was actually read. */
function readRange(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

class AgyTranscriptWatcher {
  /**
   * @param {(metrics: object) => void} onMetrics context metrics (estimated)
   * @param {{cwd?: string, conversationId?: string|null, onTools?: Function,
   *   intervalMs?: number, appDataDir?: string, log?: (msg: string) => void,
   *   chunkBytes?: number}} [opts] chunkBytes: read size per tick (tests)
   */
  constructor(onMetrics, opts = {}) {
    this.onMetrics = typeof onMetrics === 'function' ? onMetrics : () => {};
    this.onTools = typeof opts.onTools === 'function' ? opts.onTools : null;
    this.cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
    const id = typeof opts.conversationId === 'string' ? opts.conversationId.toLowerCase() : '';
    this.conversationId = UUID_RE.test(id) ? id : null;
    this.appDataDir = opts.appDataDir || AGY_APP_DATA_DIR;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.chunkBytes = Number.isInteger(opts.chunkBytes) && opts.chunkBytes > 0 ? opts.chunkBytes : MAX_CHUNK_BYTES;
    this.log = typeof opts.log === 'function' ? opts.log : defaultLog;
    this.logged = new Set();
    this.timer = null;
    this.startedAt = 0;
    /** conversation id -> transcript mtime when the tab started: someone else's, unless it grows. */
    this.baseline = new Map();
    /** {key, full} of the conversation this tab reads, once picked. */
    this.pinned = null;
    this.offset = 0;
    /** Bytes of the pinned file that were already there: history, not live activity. 0 = none (left). */
    this.historyUntil = 0;
    /** Inside a line longer than chunkBytes, which is dropped up to its end. */
    this.skipping = false;
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

  /** The claim key of a conversation: the same id under another appData is another conversation. */
  keyOf(id) {
    return pathKey(path.join(this.appDataDir, 'brain', id));
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
    if (this.pinned) claimedAgyConversations.delete(this.pinned.key);
    this.pinned = null;
  }

  snapshotBaseline() {
    this.startedAt = Date.now();
    this.baseline = new Map();
    try {
      for (const t of this.list()) this.baseline.set(t.id, t.mtimeMs);
    } catch (err) {
      this.warnOnce('baseline', `cannot list agy conversations in ${this.appDataDir}: ${errText(err)}`);
    }
  }

  /** Every transcript; one that cannot be read is logged once and left out. */
  list() {
    return listAgyTranscripts(this.appDataDir, (dirName, err) => {
      this.warnOnce(`list:${dirName}`, `cannot read agy conversation ${dirName}: ${errText(err)}`);
    });
  }

  /** One tick, and nothing it throws escapes into the main process. */
  safeTick() {
    try {
      this.tick();
    } catch (err) {
      this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
    }
  }

  /**
   * Pins a transcript for good. `resumed`: what it already holds is history.
   * @returns {string|null} its path, or null when it cannot be read yet
   */
  pin(transcript, resumed) {
    let size;
    try {
      size = fs.lstatSync(transcript.full).size;
    } catch (err) {
      this.warnOnce(`pin:${errText(err)}`, `cannot stat ${transcript.full}: ${errText(err)}; trying again`);
      return null;
    }
    const key = this.keyOf(transcript.id);
    claimedAgyConversations.add(key);
    this.pinned = { key, full: transcript.full };
    this.historyUntil = resumed ? size : 0;
    return transcript.full;
  }

  pickFile() {
    if (this.pinned) return this.pinned.full;
    if (this.conversationId) {
      if (claimedAgyConversations.has(this.keyOf(this.conversationId))) {
        this.warnOnce('id-claimed', `agy conversation ${this.conversationId} is already shown by another tab; not reading it here`);
        return null;
      }
      const found = transcriptOf(this.appDataDir, this.conversationId);
      return found ? this.pin(found, true) : null;
    }
    const free = this.list().filter((t) => !claimedAgyConversations.has(this.keyOf(t.id)));
    const fresh = free.filter((t) => !this.baseline.has(t.id));
    const resumed = free.filter((t) => this.baseline.has(t.id) && t.mtimeMs > this.baseline.get(t.id));
    const pool = this.inThisFolder([...fresh, ...resumed]);
    if (pool.length === 0) return null;
    // A new conversation beats a resumed one; newest first within each.
    pool.sort((a, b) => (this.baseline.has(a.id) - this.baseline.has(b.id)) || (b.mtimeMs - a.mtimeMs));
    return this.pin(pool[0], this.baseline.has(pool[0].id));
  }

  /** Keeps the conversations agy records as running in this tab's folder. */
  inThisFolder(pool) {
    if (pool.length === 0 || !this.cwd) return pool;
    const ws = readConversationWorkspaces(this.appDataDir);
    if (!ws.ok && ws.retry) {
      this.warnOnce('workspaces-busy', `${ws.reason}; trying again`);
      return [];
    }
    if (!ws.ok) {
      // The folder cannot be checked; time and claims still keep two tabs
      // apart unless both start a conversation at once.
      this.warnOnce('workspaces-unchecked', `${ws.reason}; matching agy conversations to this tab by time only`);
      return pool;
    }
    if (ws.skipped > 0) {
      this.warnOnce('workspaces-skipped', `${SUMMARIES_DB}: ignored ${ws.skipped} row(s) that did not validate`);
    }
    const matchOf = (t) => workspaceMatch(ws.byId.get(t.id), this.cwd);
    const exact = pool.filter((t) => matchOf(t) === 'exact');
    if (exact.length > 0) return exact;
    const containing = pool.filter((t) => matchOf(t) === 'contains');
    if (containing.length > 0) return containing;
    // A conversation with no row yet is skipped now and picked up next tick.
    this.warnOnce('no-match', `${pool.length} active agy conversation(s), none recorded for ${this.cwd} yet; checking again`);
    return [];
  }

  tick() {
    const file = this.pickFile();
    if (!file) return;
    let st;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      this.warnOnce(`stat:${errText(err)}`, `cannot stat ${file}: ${errText(err)}`);
      return;
    }
    if (!st.isFile()) {
      this.warnOnce('not-file', `${file} is no longer a regular file; not reading it`);
      return;
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return;
    const before = this.offset;
    // Unless there is more to read right away, wait for the file to change.
    if (this.accumulate(file, st.size) !== 'more') {
      this.lastSize = st.size;
      this.lastMtime = st.mtimeMs;
    }
    if (this.state.unresolved > 0) {
      this.warnOnce('unresolved', `an agy tool call in ${file} got no result step (cancelled, or a transcript format LunaCore does not know)`);
    }
    // A line still being written changes nothing: no repeat of the same reading.
    if (this.emitted && this.offset === before) return;
    this.emitted = true;
    this.onMetrics(agyContextMetrics(this.state.contextChars, {
      file, elapsedMs: Date.now() - this.startedAt, model: this.state.model,
    }));
  }

  /** The file shrank (rewritten or replaced): count again from the start. */
  restart(file, size) {
    this.warnOnce('restart', `${file} got shorter; reading it again from the start`);
    // Calls lit live end here (history lit none), or they would stay lit.
    const ends = this.state.endOpen(Date.now());
    const live = this.historyUntil === 0;
    const next = new AgyTranscriptState({ cwd: this.cwd });
    next.callSeq = this.state.callSeq; // new ids never repeat old ones
    next.model = this.state.model;
    this.state = next;
    this.offset = 0;
    // Its content is not news: what is there now counts as history.
    this.historyUntil = size;
    this.skipping = false;
    if (live) this.emitTools(ends);
  }

  /**
   * Enters a line longer than a read, dropped up to its end. Which step it
   * held is unknown, so the open batch ends here: a result on that line
   * would otherwise shift every later result onto the wrong call.
   */
  skipLongLine(file) {
    this.skipping = true;
    this.warnOnce('long-line', `skipping a line of ${file} longer than ${this.chunkBytes} bytes; tool calls open at that point end without a result`);
    const ends = this.state.endOpen(Date.now());
    if (this.historyUntil === 0) this.emitTools(ends);
  }

  emitTools(events) {
    if (events.length > 0 && this.onTools) this.onTools(events);
  }

  /**
   * Reads what was appended since the last tick, at most chunkBytes, and
   * folds its complete lines into the state. Offsets are bytes; a read only
   * ever ends at a newline byte, so no UTF-8 character is cut in two.
   * @returns {'eof'|'more'|'partial'} 'more': read again now; 'partial': a
   *   line is still being written, wait for the file to grow
   */
  accumulate(file, size) {
    if (size < this.offset) this.restart(file, size);
    const want = Math.min(size - this.offset, this.chunkBytes);
    if (want <= 0) return 'eof';
    const buf = readRange(file, this.offset, want);
    if (buf.length === 0) return 'eof';
    let start = 0;
    if (this.skipping) {
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) {
        this.offset += buf.length;
        return this.offset >= size ? 'partial' : 'more';
      }
      start = nl + 1;
      this.skipping = false;
    }
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl < start) {
      // A whole chunk with no line end, and the file goes on past it: the
      // line is longer than a read, not a step anyone can use.
      if (start === 0 && buf.length >= this.chunkBytes && this.offset + buf.length < size) {
        this.offset += buf.length;
        this.skipLongLine(file);
        return 'more';
      }
      this.offset += start;
      return this.offset + (buf.length - start) >= size ? 'partial' : 'more';
    }
    const events = this.foldLines(file, buf, start, lastNl + 1);
    // The place moves on before anyone hears of it: a listener that throws
    // must not make the next tick fold the same lines again.
    this.offset += lastNl + 1;
    this.emitTools(events);
    return this.offset >= size ? 'eof' : 'more';
  }

  /**
   * Folds the complete lines buf[start, end) and returns their live tool
   * events. Lines that were in the file when it was pinned are history: they
   * count toward the context window but light no tool, and what they left
   * open is dropped where history ends.
   */
  foldLines(file, buf, start, end) {
    let liveFrom = start;
    if (this.historyUntil > 0) {
      // The newline closing the last line that ends within history.
      const boundary = this.historyUntil - this.offset;
      const lastHistoryNl = boundary > start ? buf.lastIndexOf(NEWLINE, Math.min(boundary, end) - 1) : -1;
      if (lastHistoryNl >= start) {
        this.applyLines(file, buf.toString('utf8', start, lastHistoryNl + 1));
        liveFrom = lastHistoryNl + 1;
      }
      if (this.offset + end < this.historyUntil) return [];
      // A call the past left open (a killed session) must not light anything now.
      this.state.forgetPending();
      this.historyUntil = 0;
    }
    return liveFrom < end ? this.applyLines(file, buf.toString('utf8', liveFrom, end)) : [];
  }

  /** Parses whole lines, logs the ones it cannot use, returns the tool events. */
  applyLines(file, text) {
    const { steps, skipped } = parseSteps(text);
    if (skipped.length > 0) {
      this.log(`skipped ${skipped.length} unreadable line(s) of ${file}; first: ${skipped[0].reason}`);
    }
    return this.state.apply(steps);
  }
}

module.exports = {
  AGY_APP_DATA_DIR,
  TRANSCRIPT_FILES,
  AgyTranscriptWatcher,
  listAgyTranscripts,
  readConversationWorkspaces,
};
