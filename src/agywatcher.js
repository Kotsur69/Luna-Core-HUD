// ============================================================================
// LunaCore - Antigravity (`agy`) transcript watcher (read-only)
// ----------------------------------------------------------------------------
// The agy counterpart of observer.js' TranscriptWatcher, for one tab: finds
// the agy conversation that tab runs, tails its transcript (src/agytail.js)
// and emits the same tool events, MCP events and context metrics
// (src/agytranscript.js does the parsing).
//
// Picking the conversation, like TranscriptWatcher.pickFile() does without a
// session id, plus a workspace check agy makes possible:
//   1. a resumed id from the start command (`--conversation=<id>`) is read
//      directly - nothing to guess;
//   2. otherwise a conversation created after the tab started (a new one),
//      else one that existed and grew since (`--continue`);
//   3. only if agy's conversation_summaries.db says it runs in THIS tab's
//      folder (or, failing an exact match, in a folder containing it) - agy's
//      brain/ folder is shared by every workspace - and is not a subagent's
//      conversation (its row names a parent_conversation_id): a subagent works
//      in its parent's folder, and picking it would show only its few calls;
//   4. never one another agy tab has already claimed; newest wins.
// The pick is permanent. Known limit: a new conversation started inside the
// same agy process (its /clear) is not followed.
//
// Subagents. An Orchestrator session does most of its reading and editing in
// subagent conversations (invoke_subagent, swarm, run_workflow), each with
// its own transcript. Their tool and MCP events are attributed to this tab:
//   * a subagent call's result names the child ("conversationId": "<id>");
//   * while such a call runs, and for a minute after, the summaries database
//     is also asked for conversations whose parent is one this tab follows
//     (at most every CHILD_SCAN_INTERVAL_MS);
//   * at most MAX_CHILD_CONVERSATIONS are followed, each claimed like the
//     tab's own conversation, read-only, lstat-guarded like it; a child that
//     existed before the tab started counts its past as history;
//   * a child that has not grown for CHILD_IDLE_MS is let go - what it lit
//     ends, its claim is released - and taken up again where it was, should
//     it grow later;
//   * every conversation named as a subagent is remembered process-wide, so
//     no tab picks one as its own even without the database's parent column.
//
// Without a readable database (agy never wrote one, this Node has no
// node:sqlite, or the file is broken) the folder cannot be checked and the
// pick goes by time and claims alone. A database agy holds locked right now
// is read again next tick instead.
//
// Tokens. Every reading carries `byModel` ({<model id>: {input, output,
// cacheRead, cacheWrite}}, observer.js' shape): the real counts agy logs on
// each planner step (src/agytokens.js), summed over the tab's conversation
// and every subagent conversation it followed - a subagent's spend is the
// tab's. A child let go keeps its totals here; taken up again, its new reader
// books it from the start and counts no lower than them meanwhile. While the
// tab's own conversation is still being read as history (a resumed one,
// caught up over several ticks) no `byModel` is sent: a part-way total would
// drop below an earlier tab's reading and be counted twice. The window stays
// assumed, so the reading stays `estimated`; no cost is ever put on it.
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
  UUID_RE, AgyTranscriptState, agyContextMetrics, workspacesFromRows, workspaceMatch, AGY_TRANSCRIPT_FILES,
} = require('./agytranscript');
const { AgyTail } = require('./agytail');
const { sumAgyByModel, maxAgyByModel } = require('./agytokens');

/** agy CLI's app data folder (the IDE and Antigravity 2.0 use sibling folders). */
const AGY_APP_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SUMMARIES_DB = 'conversation_summaries.db';
/** Full first: transcript.jsonl truncates large fields, which would undercount. */
const TRANSCRIPT_FILES = AGY_TRANSCRIPT_FILES;
const DEFAULT_INTERVAL_MS = 1500;
/** At most this much is read per tick; a long history is caught up over several. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** How long a read waits for agy's lock on the summaries database (blocks the main process). */
const DB_BUSY_TIMEOUT_MS = 100;
/** SQLite result codes that pass on their own: SQLITE_BUSY, SQLITE_LOCKED (low byte of an extended code). */
const TRANSIENT_SQLITE_CODES = new Set([5, 6]);
/** Subagent conversations one tab follows at most. */
const MAX_CHILD_CONVERSATIONS = 32;
/** Named children whose transcript is not there yet, waited for at most. */
const MAX_CHILDREN_WAITING = 64;
/** How long a named child may take to write its first step. */
const CHILD_WAIT_MS = 2 * 60 * 1000;
/** Least time between two summaries-database lookups for children. */
const CHILD_SCAN_INTERVAL_MS = 5000;
/** How long after an agent call the database is still asked for children. */
const CHILD_SCAN_WINDOW_MS = 60 * 1000;
/** A followed child whose transcript has not grown for this long is let go (its claim too). */
const CHILD_IDLE_MS = 10 * 60 * 1000;
/** Let-go children remembered with how far they were read, so a revived one is not replayed. */
const MAX_RETIRED_CHILDREN = 256;
/**
 * Let-go children whose token totals one tab keeps. They outlive `retired`
 * (MAX_RETIRED_CHILDREN): a child taken up again counts no lower than them.
 * Past this many the oldest is folded into one sum, and that child, should
 * it come back, is counted again from the start.
 */
const MAX_RETIRED_USAGE = 4096;
/** Subagent conversations named anywhere, so no tab picks one as its own. */
const MAX_KNOWN_SUBAGENTS = 1024;

const ROWS_SQL = 'select conversation_id, workspace_uris, parent_conversation_id from conversation_summaries';
/** agy before parent_conversation_id existed. */
const ROWS_SQL_NO_PARENT = 'select conversation_id, workspace_uris from conversation_summaries';

/** Conversations claimed by live agy watchers, one owner each (cf. claimedTranscripts). */
const claimedAgyConversations = new Set();
/**
 * Conversations some watcher learned are subagents (a result named them, or
 * the database linked them to a parent), oldest first. Shared because a
 * subagent works in its parent's folder: without the database's parent
 * column (or without a cwd to check) another tab would take it for its own.
 */
const knownSubagentConversations = new Set();

function noteSubagent(id) {
  knownSubagentConversations.delete(id);
  knownSubagentConversations.add(id);
  if (knownSubagentConversations.size > MAX_KNOWN_SUBAGENTS) {
    knownSubagentConversations.delete(knownSubagentConversations.keys().next().value);
  }
}

/** A followed child's token totals: what its reader booked, never below what was counted before. */
const childUsage = (child) => maxAgyByModel(child.floor, child.tail.state.usageByModel());

const defaultLog = (msg) => console.warn(`[agy-transcript] ${msg}`);
const errText = (err) => (err && (err.code || err.message)) || String(err);

/** The logs folder of one conversation. */
function logsDirOf(appDataDir, dirName) {
  return path.join(appDataDir, 'brain', dirName, '.system_generated', 'logs');
}

/**
 * The transcript of one conversation: {id, full, mtimeMs, size}, or null
 * when it has none yet (a conversation writes its file with its first step).
 * @param {string} dirName the folder name as it is on disk; `id` is its lowercase form
 */
function transcriptOf(appDataDir, dirName) {
  for (const name of TRANSCRIPT_FILES) {
    const full = path.join(logsDirOf(appDataDir, dirName), name);
    try {
      // lstat: a symlink is not followed, it could point anywhere on the disk.
      const st = fs.lstatSync(full);
      if (st.isFile()) return { id: dirName.toLowerCase(), full, mtimeMs: st.mtimeMs, size: st.size };
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
 * @returns {{id:string, full:string, mtimeMs:number, size:number}[]}
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

/** Every summaries row; an agy without the parent column is read without it. */
function readRows(db) {
  try {
    return db.prepare(ROWS_SQL).all();
  } catch (err) {
    if (!/no such column/i.test(String(err && err.message))) throw err;
    return db.prepare(ROWS_SQL_NO_PARENT).all();
  }
}

/**
 * conversation id -> workspace folders and child -> parent, read from agy's
 * summaries database. `retry` says the failure passes on its own (agy holds
 * the database locked); anything else - no database, no node:sqlite, a broken
 * file or a schema this code does not know - will not.
 * @returns {{ok:true, byId:Map<string,string[]>, parents:Map<string,string>, skipped:number}
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
    const { byId, parents, skipped } = workspacesFromRows(readRows(db));
    return { ok: true, byId, parents, skipped };
  } catch (err) {
    const retry = Number.isInteger(err && err.errcode) && TRANSIENT_SQLITE_CODES.has(err.errcode & 0xff);
    const why = (err && err.message) || errText(err);
    return { ok: false, retry, reason: `${SUMMARIES_DB} ${retry ? 'busy' : 'unreadable'} (${why})` };
  } finally {
    if (db) db.close();
  }
}

class AgyTranscriptWatcher {
  /**
   * @param {(metrics: object) => void} onMetrics context metrics (estimated)
   * @param {{cwd?: string, conversationId?: string|null, onTools?: Function,
   *   onMcp?: Function, onTurnStart?: Function, onTurnEnd?: Function,
   *   intervalMs?: number, appDataDir?: string,
   *   log?: (msg: string) => void, chunkBytes?: number, now?: () => number}} [opts]
   *   chunkBytes: read size per tick (tests); onTurnStart / onTurnEnd fire for
   *   the tab's own conversation only, never for a subagent's
   */
  constructor(onMetrics, opts = {}) {
    this.onMetrics = typeof onMetrics === 'function' ? onMetrics : () => {};
    this.onTools = typeof opts.onTools === 'function' ? opts.onTools : null;
    this.onMcp = typeof opts.onMcp === 'function' ? opts.onMcp : null;
    this.onTurnStart = typeof opts.onTurnStart === 'function' ? opts.onTurnStart : null;
    this.onTurnEnd = typeof opts.onTurnEnd === 'function' ? opts.onTurnEnd : null;
    this.cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
    const id = typeof opts.conversationId === 'string' ? opts.conversationId.toLowerCase() : '';
    this.conversationId = UUID_RE.test(id) ? id : null;
    this.appDataDir = opts.appDataDir || AGY_APP_DATA_DIR;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.chunkBytes = Number.isInteger(opts.chunkBytes) && opts.chunkBytes > 0 ? opts.chunkBytes : MAX_CHUNK_BYTES;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.log = typeof opts.log === 'function' ? opts.log : defaultLog;
    this.logged = new Set();
    this.timer = null;
    this.startedAt = 0;
    /** conversation id -> transcript mtime when the tab started: someone else's, unless it grows. */
    this.baseline = new Map();
    /** conversation claim keys already owned by other live tabs when this watcher started. */
    this.claimedAtStart = new Set();
    /** {id, key, full} of the conversation this tab reads, once picked. */
    this.pinned = null;
    /** Its tail reader, once picked. */
    this.main = null;
    /** The state shown before a conversation is picked. */
    this.idleState = new AgyTranscriptState({ cwd: this.cwd });
    /** Whether a reading of the pinned file went out yet (an empty conversation still shows 0 %). */
    this.emitted = false;
    /** child id -> {key, floor, tail, movedAt} of the subagent conversations followed. */
    this.children = new Map();
    /** child id -> bytes read, for children let go after going idle (oldest first). */
    this.retired = new Map();
    /** child id -> its token totals per model when it was let go (outlives `retired`, see MAX_RETIRED_USAGE). */
    this.retiredUsage = new Map();
    /** Token totals of let-go children that fell out of `retiredUsage`. */
    this.droppedUsage = {};
    /** The last byModel sent, as JSON: a child's reading re-sends only when it changed. */
    this.lastUsageKey = '';
    /** child id -> when it was first named, for children whose transcript is not there yet. */
    this.childrenWaiting = new Map();
    /** Until when the summaries database is asked for children (after an agent call). */
    this.childScanUntil = 0;
    this.lastChildScan = 0;
    this.warnOnce = this.warnOnce.bind(this);
  }

  /** The tab's own conversation state (an empty one until a conversation is picked). */
  get state() {
    return this.main ? this.main.state : this.idleState;
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
    for (const child of this.children.values()) claimedAgyConversations.delete(child.key);
    this.children.clear();
    this.childrenWaiting.clear();
    this.retired.clear();
    this.retiredUsage.clear();
    this.droppedUsage = {};
    this.pinned = null;
    this.main = null;
  }

  snapshotBaseline() {
    this.startedAt = this.now();
    this.baseline = new Map();
    // Snapshot conversations owned right now so a dying replaced tab releasing its
    // claim moments later cannot be adopted as a resumed conversation by this new tab.
    this.claimedAtStart = new Set(claimedAgyConversations);
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

  /** A tail reader for one conversation's transcript. */
  tailFor(transcript, { historyUntil, idPrefix }) {
    return new AgyTail({
      file: transcript.full,
      state: new AgyTranscriptState({ cwd: this.cwd, idPrefix }),
      historyUntil,
      chunkBytes: this.chunkBytes,
      warnOnce: this.warnOnce,
      log: this.log,
    });
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
    this.pinned = { id: transcript.id, key, full: transcript.full };
    this.main = this.tailFor(transcript, { historyUntil: resumed ? size : 0, idPrefix: 'agy:' });
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
    const free = this.list().filter((t) => {
      const key = this.keyOf(t.id);
      return !claimedAgyConversations.has(key) && !this.claimedAtStart.has(key) && !knownSubagentConversations.has(t.id);
    });
    const fresh = free.filter((t) => !this.baseline.has(t.id));
    const resumed = free.filter((t) => this.baseline.has(t.id) && t.mtimeMs > this.baseline.get(t.id));
    const pool = this.inThisFolder([...fresh, ...resumed]);
    if (pool.length === 0) return null;
    // A new conversation beats a resumed one; newest first within each.
    pool.sort((a, b) => (this.baseline.has(a.id) - this.baseline.has(b.id)) || (b.mtimeMs - a.mtimeMs));
    return this.pin(pool[0], this.baseline.has(pool[0].id));
  }

  /** Keeps the conversations agy records as running in this tab's folder, subagents left out. */
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
    const own = pool.filter((t) => !ws.parents.has(t.id));
    const matchOf = (t) => workspaceMatch(ws.byId.get(t.id), this.cwd);
    const exact = own.filter((t) => matchOf(t) === 'exact');
    if (exact.length > 0) return exact;
    const containing = own.filter((t) => matchOf(t) === 'contains');
    if (containing.length > 0) return containing;
    // A conversation with no row yet is skipped now and picked up next tick.
    this.warnOnce('no-match', `${pool.length} active agy conversation(s), none recorded for ${this.cwd} yet; checking again`);
    return [];
  }

  tick() {
    const file = this.pickFile();
    if (!file) return;
    const now = this.now();
    const res = this.pollTail(this.main, now);
    if (res) this.emitTurns(res.turns);
    if (this.main.state.unresolved > 0) {
      this.warnOnce('unresolved', `an agy tool call in ${file} got no result step (cancelled, or a transcript format LunaCore does not know)`);
    }
    const childMoved = this.tickChildren(now);
    // A line still being written changes nothing: no repeat of the same reading.
    const mainRead = Boolean(res) && res.status === 'read' && (!this.emitted || res.moved);
    // A subagent alone never sends the first reading: the tab's own window is unread yet.
    if (!mainRead && (!childMoved || !this.emitted)) return;
    // Still inside the history it was pinned with: its totals are part-way.
    const byModel = this.main.historyUntil > 0 ? null : this.usageByModel();
    const usageKey = byModel ? JSON.stringify(byModel) : '';
    // A subagent that moved without booking tokens changes nothing the tab shows.
    if (!mainRead && (!byModel || usageKey === this.lastUsageKey)) return;
    if (byModel) this.lastUsageKey = usageKey;
    if (mainRead) this.emitted = true;
    const state = this.main.state;
    const metrics = agyContextMetrics(state.contextChars, {
      file, elapsedMs: now - this.startedAt, model: state.model, usage: state.usage,
    });
    this.onMetrics(byModel ? { ...metrics, byModel } : metrics);
  }

  /**
   * The tab's real token totals per model: its own conversation plus every
   * subagent conversation it followed, live or let go.
   * @returns {Record<string, {input:number, output:number, cacheRead:number, cacheWrite:number}>}
   */
  usageByModel() {
    return sumAgyByModel([
      this.state.usageByModel(),
      ...[...this.children.values()].map((child) => childUsage(child)),
      ...this.retiredUsage.values(),
      this.droppedUsage,
    ]);
  }

  /**
   * Polls one tail and sends what it read. A tail that cannot be read, or a
   * listener that throws, is logged and stays that tail's problem: the
   * metrics and every other tail still get their turn this tick.
   * @returns {object|null} the poll's result, or null when it failed
   */
  pollTail(tail, now) {
    let res;
    try {
      res = tail.poll();
    } catch (err) {
      this.warnOnce(`poll:${tail.file}:${errText(err)}`, `cannot read ${tail.file}: ${errText(err)}`);
      return null;
    }
    try {
      this.deliver(res, now);
    } catch (err) {
      this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
    }
    return res;
  }

  /** Notes the children one poll named, then sends its events; one listener throwing does not cost the other. */
  deliver(res, now) {
    for (const id of res.children) this.nameChild(id, now);
    if (res.tools.some((ev) => ev.tile === 'Task')) this.childScanUntil = now + CHILD_SCAN_WINDOW_MS;
    this.notify(this.onMcp, res.mcp);
    this.notify(this.onTools, res.tools);
  }

  /** Fires the tab's own turn starts and ends (a subagent's turns are not the tab's). */
  emitTurns(turns) {
    for (const turn of turns || []) {
      try {
        if (turn.type === 'start' && this.onTurnStart) this.onTurnStart({ at: turn.at });
        else if (turn.type === 'end' && this.onTurnEnd) {
          this.onTurnEnd({ startedAt: turn.startedAt, endedAt: turn.endedAt, text: turn.text });
        }
      } catch (err) {
        this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
      }
    }
  }

  /** Calls one listener with a non-empty batch, logging (once per reason) what it throws. */
  notify(listener, events) {
    if (!listener || events.length === 0) return;
    try {
      listener(events);
    } catch (err) {
      this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
    }
  }

  // ---- Subagent conversations ---------------------------------------------

  /** A child named by a result or the database: followed soon, or waited for. */
  nameChild(rawId, now) {
    const id = String(rawId || '').toLowerCase();
    if (!UUID_RE.test(id) || id === (this.pinned && this.pinned.id)) return;
    noteSubagent(id);
    if (this.children.has(id)) return;
    if (this.childrenWaiting.has(id)) return;
    if (this.childrenWaiting.size >= MAX_CHILDREN_WAITING) {
      this.warnOnce('children-waiting-cap', `more than ${MAX_CHILDREN_WAITING} agy subagent conversations pending; ignoring the rest`);
      return;
    }
    this.childrenWaiting.set(id, now);
  }

  /** Follows the children whose transcript is there, drops the ones waited for too long. */
  adoptWaitingChildren(now) {
    for (const [id, since] of this.childrenWaiting) {
      if (this.adoptChild(id) || now - since > CHILD_WAIT_MS) this.childrenWaiting.delete(id);
    }
  }

  /**
   * Starts following one child conversation.
   * @returns {boolean} true when it is settled: followed now, or never will be
   *   (claimed elsewhere, over the cap, unchanged since the tab started)
   */
  adoptChild(id) {
    if (this.children.size >= MAX_CHILD_CONVERSATIONS) {
      this.warnOnce('children-cap', `following at most ${MAX_CHILD_CONVERSATIONS} agy subagent conversations per tab; ignoring the rest`);
      return true;
    }
    const key = this.keyOf(id);
    if (claimedAgyConversations.has(key)) {
      this.warnOnce(`child-claimed:${id}`, `agy subagent conversation ${id} is already shown by another tab; not reading it here`);
      return true;
    }
    let found;
    try {
      found = transcriptOf(this.appDataDir, id);
    } catch (err) {
      this.warnOnce(`child:${id}:${errText(err)}`, `cannot read agy subagent conversation ${id}: ${errText(err)}`);
      return false;
    }
    if (!found) return false;
    const historyUntil = this.childHistory(id, found);
    if (historyUntil === null) return true;
    claimedAgyConversations.add(key);
    this.retired.delete(id);
    // Its new reader starts at byte 0 and books every step again; until it
    // has caught up, what was counted before is the floor.
    const floor = this.retiredUsage.get(id) || {};
    this.retiredUsage.delete(id);
    this.children.set(id, {
      key,
      floor,
      tail: this.tailFor(found, { historyUntil, idPrefix: `agy:${id}:` }),
      movedAt: this.now(),
    });
    this.log(`following agy subagent conversation ${id}`);
    return true;
  }

  /**
   * Bytes of a child's transcript that are history when it is (re)adopted,
   * or null when there is nothing new to follow. A child let go after going
   * idle resumes where it was read up to; one that was there before the tab
   * started counts its past as history. Either one that has not grown since
   * is left alone (a later scan names it again if it does).
   */
  childHistory(id, found) {
    if (this.retired.has(id)) {
      const readUpTo = this.retired.get(id);
      if (found.size === readUpTo) return null;
      // Shorter than what was read: rewritten. What it holds now is history.
      return found.size > readUpTo ? readUpTo : found.size;
    }
    if (!this.baseline.has(id)) return 0;
    return found.mtimeMs > this.baseline.get(id) ? found.size : null;
  }

  /** Lets an idle child go: what it lit ends, its claim is released, its place remembered. */
  retireChild(id, child, now) {
    const ended = child.tail.state.endOpen(now);
    claimedAgyConversations.delete(child.key);
    this.children.delete(id);
    this.retired.set(id, child.tail.offset);
    this.retiredUsage.delete(id); // re-inserted: the map's order stays oldest-first
    this.retiredUsage.set(id, childUsage(child));
    if (this.retired.size > MAX_RETIRED_CHILDREN) this.retired.delete(this.retired.keys().next().value);
    if (this.retiredUsage.size > MAX_RETIRED_USAGE) this.foldOldestRetiredUsage();
    try {
      this.deliver({ ...ended, children: [] }, now);
    } catch (err) {
      this.warnOnce(`tick:${errText(err)}`, `tick failed: ${errText(err)}`);
    }
  }

  /** Folds the oldest let-go child's totals into droppedUsage: they still count. */
  foldOldestRetiredUsage() {
    const [id, usage] = this.retiredUsage.entries().next().value;
    this.droppedUsage = sumAgyByModel([this.droppedUsage, usage]);
    this.retiredUsage.delete(id);
  }

  /** Asks the summaries database for children of the conversations followed. */
  scanChildren(now) {
    this.lastChildScan = now;
    const ws = readConversationWorkspaces(this.appDataDir);
    // The children results name still work; a busy database is asked again later.
    if (!ws.ok) return;
    const parents = new Set([this.pinned.id, ...this.children.keys()]);
    for (const [child, parent] of ws.parents) {
      if (parents.has(parent)) this.nameChild(child, now);
    }
  }

  /** Whether an agent call of this tab (or of a child) is running now. */
  hasOpenTask() {
    if (this.main && this.main.hasOpenTask()) return true;
    return [...this.children.values()].some((child) => child.tail.hasOpenTask());
  }

  /** @returns {boolean} whether any followed child read something new */
  tickChildren(now) {
    const scanDue = now - this.lastChildScan >= CHILD_SCAN_INTERVAL_MS;
    if (scanDue && (now < this.childScanUntil || this.hasOpenTask())) this.scanChildren(now);
    if (this.childrenWaiting.size > 0) this.adoptWaitingChildren(now);
    let moved = false;
    for (const [id, child] of this.children) {
      const res = this.pollTail(child.tail, now);
      if (res && res.moved) {
        child.movedAt = now;
        moved = true;
      } else if (now - child.movedAt > CHILD_IDLE_MS) this.retireChild(id, child, now);
    }
    return moved;
  }
}

module.exports = {
  AGY_APP_DATA_DIR,
  TRANSCRIPT_FILES,
  MAX_CHILD_CONVERSATIONS,
  AgyTranscriptWatcher,
  listAgyTranscripts,
  readConversationWorkspaces,
};
