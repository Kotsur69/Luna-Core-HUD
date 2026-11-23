// ============================================================================
// LunaCore - Antigravity (`agy`) transcript adapter (pure, no disk access)
// ----------------------------------------------------------------------------
// An agy tab writes no Claude transcript, so the Active files and Context
// widgets had nothing to read. agy keeps its own per-conversation log, and this
// module turns it into the SAME events the Claude path (src/observer.js) emits:
//   * tool start/end events {phase, id, tile, at, file, added, removed,
//     detail?, ...} for the Skill Tracker, the Active-Files Heatmap and git
//     attribution;
//   * MCP call start/end events in observer.js' metrics:mcp shape;
//   * context metrics in usageToMetrics' shape {tokens, limit, percent, model,
//     modelLabel}, plus `estimated: true` - see agyContextMetrics();
//   * the child conversations (subagents) a call started, for the watcher.
// src/agywatcher.js finds and tails the file; src/agycalls.js says what one
// tool call is; everything here is pure.
//
// Where agy keeps it (agy.exe 1.5.9 - 1.5.12):
//   <appData>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
//   <appData>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
//   <appData>/conversation_summaries.db   SQLite, one row per conversation
//                                          (conversation_id, workspace_uris,
//                                          parent_conversation_id, ...)
// with <appData> = ~/.gemini/antigravity-cli. transcript.jsonl truncates large
// fields (and lists them in `truncated_fields`); transcript_full.jsonl does not.
//
// One JSON object per line, one line per step:
//   {step_index, source, type, status, created_at, content, thinking,
//    tool_calls: [{name, args}], model?, input_tokens?, cache_read_tokens?,
//    output_tokens?, truncated_fields?, error?}
// `type` USER_INPUT is a prompt, PLANNER_RESPONSE the model's reply and its
// tool calls, GENERIC a tool result, SYSTEM_MESSAGE a harness note. Results
// follow their planner step in call order. A PLANNER_RESPONSE names the model
// that wrote it and its real token counts (input_tokens excludes cached
// input: agy's own accounting sums input + output + cache_read).
//
// Seen live (agy 1.5.12, 2026-11-22, an Orchestrator plan -> execute run with
// a subagent - see test/fixtures/agy-transcript.captured-*.jsonl): every step
// type above, tool calls and results, the planner -> executor hand-off
// (exit_plan_mode, "Plan mode is off.", a SYSTEM_MESSAGE, then planner steps
// on the execution model), and the subagent's own conversation.
//
// Steps are told apart by (step_index, type, created_at), not by step_index
// alone: a line repeating a known step is an update of it (agy logs a step
// again when its status moves on), while a step_index seen before with
// another type or time is a NEW step - the index was reset or reused, and
// dropping it would hide everything the session does from then on.
// ============================================================================

'use strict';

const path = require('path');
const { AGY_MODEL } = require('./claudeModels');
const { isClaudeCommand, isAgyCommand } = require('./launch');
const { estimateTokens } = require('./filestat');
const { pathKey } = require('./gitattribution');
const { isAgyTurnEndStep } = require('./ttsExtract');
const {
  AGY_TOOL_TILES, TOOL_TO_TILE, FILE_TILES, CHILD_SPAWNING_TOOLS, UUID_RE,
  unquoteArg, normalizeAgyPath, filePathOf, editStatOf, resultEditStat,
  agyToolDetail, mcpCallOf, childIdsOf,
} = require('./agycalls');

/**
 * Context window assumed for an agy tab. agy states no window, and its models
 * are Gemini ones, documented at 1,048,576 tokens. The round million matches
 * models.js' tiers (and the badge's "1M"); the 5 % difference is far inside
 * the error of the estimate itself.
 */
const AGY_CONTEXT_LIMIT = 1000000;

/** Tool names longer than this are garbage, not a tool. */
const MAX_TOOL_NAME_CHARS = 200;
/** Tool and MCP events one step may produce; a hostile line cannot flood the IPC. */
const MAX_EVENTS_PER_STEP = 128;
/** Tool calls one step may hold at all (their result slots included). */
const MAX_TOOL_CALLS_PER_STEP = 1024;
/** Step identities a restart carries forward as already reported. */
const MAX_QUIET_KEYS = 8192;
/** A model name longer than this is not one. */
const MAX_MODEL_CHARS = 80;
/** A token count above this is not one. */
const MAX_TOKENS = 1e9;
/** Steps remembered by index, for telling an update from a new step. */
const MAX_SEEN_STEPS = 4096;
/** MCP result text kept on an end event; the renderer shows a preview only. */
const MAX_MCP_CONTENT_CHARS = 16 * 1024;

/** The names a conversation's log is written under, full first (src/agywatcher.js reads them in this order). */
const AGY_TRANSCRIPT_FILES = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);

/** "The user changed setting `Model Selection` from None to Gemini 4 Argon (Medium)." */
const MODEL_SETTING_RE = /setting `Model Selection` from [^\n]*? to ([^\n]+?)\.(?:\s|$)/;
/** agy model ids: gemini-4-hydrogen-xhigh, gemini-3.8-flash-low, ... */
const GEMINI_ID_RE = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)(?:-(low|medium|high|xhigh))?$/;
const LEVEL_LABEL = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' });
/** agy's result header: "Created At: ...\nCompleted At: ...\n", repeated. */
const RESULT_HEADER_RE = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const cleanModelText = (s) => s.replace(/[\u0000-\u001f\u007f`]/g, '').trim();

/** Validated tool calls of one step, at most MAX_TOOL_CALLS_PER_STEP; anything malformed is left out. */
function toolCallsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const calls = [];
  for (const tc of raw) {
    if (calls.length >= MAX_TOOL_CALLS_PER_STEP) break;
    if (!isObj(tc) || typeof tc.name !== 'string') continue;
    const name = tc.name.trim();
    if (!name || name.length > MAX_TOOL_NAME_CHARS) continue;
    let args = tc.args;
    if (!isObj(args)) {
      try {
        args = typeof args === 'string' ? JSON.parse(unquoteArg(args)) : null;
      } catch {
        args = null; // not structured: the call keeps its place with no arguments
      }
    }
    calls.push({ name, args: isObj(args) ? args : {} });
  }
  return calls;
}

/**
 * The model a user step names, from the line agy adds when the model setting
 * changes (seen live: "...from None to Gemini 4 Argon (Medium)."), or ''.
 * @param {string} content
 * @returns {string}
 */
function modelFromUserInput(content) {
  const m = MODEL_SETTING_RE.exec(String(content || ''));
  if (!m) return '';
  const name = cleanModelText(m[1]);
  return name && name.length <= MAX_MODEL_CHARS ? name : '';
}

/**
 * A readable name for an agy model id ("gemini-4-hydrogen-xhigh" ->
 * "Gemini 4 Hydrogen (XHigh)"); any other id comes back as it is.
 * @param {string} id
 * @returns {string}
 */
function agyModelLabel(id) {
  const m = GEMINI_ID_RE.exec(String(id || ''));
  if (!m) return String(id || '');
  const family = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `Gemini ${m[1]} ${family}${m[3] ? ` (${LEVEL_LABEL[m[3]]})` : ''}`;
}

/** A model id a step names, sanitized, or ''. */
function stepModelOf(obj) {
  if (typeof obj.model !== 'string') return '';
  const name = cleanModelText(obj.model);
  return name.length <= MAX_MODEL_CHARS ? name : '';
}

const tokenCount = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS ? v : null);

/**
 * The real token counts a step logs (top-level on agy 1.5.12; a nested
 * `usage` object is read too), or null when it logs no prompt size: a line
 * with only output_tokens says nothing about the context window, and must
 * not read as an exact empty one.
 * @returns {{input:number, cacheRead:number, output:number}|null}
 */
function stepUsageOf(obj) {
  const src = isObj(obj.usage) ? obj.usage : obj;
  const input = tokenCount(src.input_tokens);
  const cacheRead = tokenCount(src.cache_read_tokens);
  const output = tokenCount(src.output_tokens);
  if (input === null && cacheRead === null) return null;
  return { input: input || 0, cacheRead: cacheRead || 0, output: output || 0 };
}

/**
 * Parses one transcript line. A reason never quotes the line: transcripts
 * hold the user's prompts, and reasons end up in the log.
 * @param {string} line
 * @returns {{step: object|null, reason: string|null}}
 */
function parseStepLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { step: null, reason: 'invalid JSON' };
  }
  if (!isObj(obj)) return { step: null, reason: 'not a JSON object' };
  if (typeof obj.type !== 'string' || !obj.type) return { step: null, reason: 'step has no type' };
  const content = typeof obj.content === 'string' ? obj.content : '';
  return {
    step: {
      index: Number.isInteger(obj.step_index) ? obj.step_index : null,
      // The enum's full name (CORTEX_STEP_TYPE_GENERIC / CORTEX_STEP_STATUS_DONE) is accepted too.
      type: obj.type.replace(/^CORTEX_STEP_TYPE_/, ''),
      status: typeof obj.status === 'string' ? obj.status.replace(/^CORTEX_STEP_STATUS_/, '') : '',
      at: typeof obj.created_at === 'string' ? Date.parse(obj.created_at) || null : null,
      content,
      error: typeof obj.error === 'string' ? obj.error : '',
      toolCalls: toolCallsOf(obj.tool_calls),
      model: stepModelOf(obj),
      usage: stepUsageOf(obj),
      // What this step put into the context window. Thinking is left out: the
      // model's reasoning is not sent back to it on the next call.
      chars: content.length + (Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls).length : 0),
    },
    reason: null,
  };
}

/**
 * Parses a fragment of whole lines. Never throws: every line it cannot use
 * is reported in `skipped` (1-based line number within the fragment).
 * @param {string} text
 * @returns {{steps: object[], skipped: {line:number, reason:string}[]}}
 */
function parseSteps(text) {
  const steps = [];
  const skipped = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const { step, reason } = parseStepLine(line);
    if (step) steps.push(step);
    else skipped.push({ line: i + 1, reason });
  }
  return { steps, skipped };
}

const MAX_TURN_END_CHARS = 65536;

/**
 * Serializes an agy assistant response into the compact JSONL line expected by
 * downstream turn-end handlers (findTurnEndMessage / markerFrom / lastWordsFrom).
 * Keeps the tail if oversized so end-of-message markers are preserved.
 * @param {string} content
 * @returns {string}
 */
function agyTurnEndLine(content) {
  const s = String(content || '');
  return JSON.stringify({
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: s.length > MAX_TURN_END_CHARS ? s.slice(-MAX_TURN_END_CHARS) : s,
  });
}

/** The identity of a step: index, type and creation time. */
const stepKey = (index, type, at) => `${index}|${type}|${at}`;

/** Whether a line is a known step logged again (same type; same time when both have one). */
function sameStep(rec, step) {
  return rec.type === step.type && (rec.at === null || step.at === null || rec.at === step.at);
}

/** An MCP result's text without agy's Created/Completed header, capped. */
function mcpContentOf(result) {
  const body = result.status === 'ERROR' && result.error ? result.error : result.content.replace(RESULT_HEADER_RE, '');
  return body.length > MAX_MCP_CONTENT_CHARS ? body.slice(0, MAX_MCP_CONTENT_CHARS) : body;
}

/**
 * The running state of one agy conversation: tool calls waiting for their
 * result, the characters in the context window, the model and its real token
 * counts. It spans fragments on purpose - a call routinely lands in one read
 * and its result in the next (the same reason observer.js keeps `openTools`
 * across ticks).
 *
 * Every call is `live` or quiet. A live call's start, end, MCP events and
 * children are reported; a quiet one (history after a restart, see
 * quietCallsOf()) only keeps its place in the result order, so the renderer
 * always gets balanced pairs.
 */
class AgyTranscriptState {
  /**
   * @param {{cwd?: string, idPrefix?: string, quietBefore?: number|null,
   *   quietKeys?: Iterable<[string, number]>}} [opts]
   *   cwd resolves relative paths; idPrefix keeps a child conversation's event
   *   ids apart from its parent's; quietBefore / quietKeys: after a restart,
   *   unseen steps created before that time are history, and a step already
   *   seen keeps as many of its calls quiet as quietKeys says.
   */
  constructor({ cwd = '', idPrefix = 'agy:', quietBefore = null, quietKeys = [] } = {}) {
    this.cwd = typeof cwd === 'string' ? cwd : '';
    this.idPrefix = typeof idPrefix === 'string' && idPrefix ? idPrefix : 'agy:';
    /** Calls of the newest planner step still waiting for a result, in call order. */
    this.pending = [];
    /** Characters in the context window since the conversation (or its last checkpoint) began. */
    this.contextChars = 0;
    /** The model last named: a planner step's id (as a label), else the user's setting line; '' until then. */
    this.model = '';
    /** Real token counts of the newest planner step that logged them, or null. */
    this.usage = null;
    /** Tiled calls that ended with no result step - a sign the format differs. */
    this.unresolved = 0;
    /** step_index -> {index, type, at, chars, calls, tiled, quietCalls} of the steps seen, oldest first. */
    this.seen = new Map();
    /** The record of the planner step whose calls are pending. */
    this.batch = null;
    /** Event ids are ours, so they never collide (agy's own are not logged). */
    this.callSeq = 0;
    /** Newest created_at seen, ms; a restart makes everything up to it history. */
    this.newestAt = null;
    /** A time (ms, or Infinity) up to which unseen steps are history; null = none. */
    this.quietBefore = typeof quietBefore === 'number' && !Number.isNaN(quietBefore) ? quietBefore : null;
    /** step key -> how many of its tool calls were already reported (or were history) before a restart. */
    this.quietKeys = new Map(quietKeys);
    /** Start timestamp of the current user-initiated turn, if known. */
    this.turnStartedAt = null;
    /** Turn start/end notifications of news steps, until takeTurns() drains them. */
    this.turnEvents = [];
  }

  /**
   * Folds parsed steps and returns the tool events they complete, in order.
   * Starts and ends always come in balanced pairs. fold() also returns the
   * MCP events and child conversation ids.
   * @param {object[]} steps parseSteps().steps
   * @returns {object[]}
   */
  apply(steps) {
    return this.fold(steps).tools;
  }

  /**
   * @param {object[]} steps parseSteps().steps
   * @returns {{tools: object[], mcp: object[], children: string[]}}
   */
  fold(steps) {
    const out = { tools: [], mcp: [], children: [] };
    for (const step of Array.isArray(steps) ? steps : []) {
      const known = step.index === null ? null : this.seen.get(step.index);
      if (known && sameStep(known, step)) this.update(known, step, out);
      else this.add(step, out);
    }
    return out;
  }

  /**
   * How many of a NEW step's tool calls are history rather than live: 0 for
   * a step that is news, Infinity for one that is not. After a restart a step
   * the old state saw keeps the calls it had quiet (they were reported, or
   * were history, before) and reports only the calls it gains now; while the
   * re-read is still inside what the file held at the restart (`quietBefore`
   * set), an unseen step is news only when it is no older than all seen.
   */
  quietCallsOf(step) {
    if (step.at !== null) {
      const known = this.quietKeys.get(stepKey(step.index, step.type, step.at));
      if (known !== undefined) return known;
    }
    if (this.quietBefore === null) return 0;
    return step.at !== null && step.at >= this.quietBefore ? 0 : Infinity;
  }

  /**
   * Whether a NEW step is news (not history replayed after a restart): only
   * news fires turn notifications.
   */
  isNews(step) {
    if (step.at !== null && this.quietKeys.has(stepKey(step.index, step.type, step.at))) return false;
    if (this.quietBefore === null) return true;
    return step.at !== null && step.at >= this.quietBefore;
  }

  /** The re-read after a restart got past what the file held then: unseen steps are live again. */
  endReplay() {
    this.quietBefore = null;
  }

  /** A step not seen before. */
  add(step, out) {
    const turnEnded = isAgyTurnEndStep(step);
    const rec = {
      index: step.index, type: step.type, at: step.at, chars: step.chars, calls: 0, tiled: 0,
      quietCalls: this.quietCallsOf(step), news: this.isNews(step), turnEnded,
    };
    // A checkpoint is agy compacting the conversation: its summary replaces
    // everything before it in the window.
    this.contextChars = step.type === 'CHECKPOINT' ? step.chars : this.contextChars + step.chars;
    this.noteModel(step);
    if (step.type === 'USER_INPUT' && rec.news) {
      this.turnStartedAt = step.at || Date.now();
      this.turnEvents.push({ type: 'start', at: this.turnStartedAt });
    }
    if (step.type === 'PLANNER_RESPONSE') this.openBatch(rec, step, out);
    else if (step.type === 'GENERIC' && this.pending.length > 0) this.endCall(this.pending.shift(), step, out);
    if (turnEnded && rec.news) this.recordTurnEnd(step);
    if (step.index !== null) this.remember(rec);
    if (step.at !== null && (this.newestAt === null || step.at > this.newestAt)) this.newestAt = step.at;
  }

  /** Records one finished turn so the watcher can fire onTurnEnd once. */
  recordTurnEnd(step) {
    const endedAt = step.at || Date.now();
    const startedAt = this.turnStartedAt || endedAt;
    this.turnStartedAt = null;
    this.turnEvents.push({ type: 'end', startedAt, endedAt, text: agyTurnEndLine(step.content) });
  }

  /** Drains and returns accumulated turn events since the previous drain. */
  takeTurns() {
    if (this.turnEvents.length === 0) return [];
    const out = this.turnEvents;
    this.turnEvents = [];
    return out;
  }

  /** Keeps a step's record, forgetting the oldest past MAX_SEEN_STEPS. */
  remember(rec) {
    this.seen.delete(rec.index); // re-inserted: the map's order stays oldest-first
    this.seen.set(rec.index, rec);
    if (this.seen.size > MAX_SEEN_STEPS) this.seen.delete(this.seen.keys().next().value);
  }

  /**
   * A known step, logged again. Only what its earlier versions could not do
   * is applied: its size replaces the old one, and a planner step that now
   * lists more tool calls opens the new ones. A result is never applied
   * twice - it would end a second call.
   */
  update(rec, step, out) {
    // Never below 0: the earlier version may predate a checkpoint that reset the count.
    this.contextChars = step.type === 'CHECKPOINT' ? step.chars : Math.max(0, this.contextChars - rec.chars + step.chars);
    rec.chars = step.chars;
    this.noteModel(step);
    if (step.type === 'PLANNER_RESPONSE' && step.toolCalls.length > rec.calls) this.openMore(rec, step, out);
    // A reply first logged while still streaming (no status) ends its turn when it is logged DONE.
    if (step.type === 'PLANNER_RESPONSE' && rec.calls === 0 && !rec.turnEnded && isAgyTurnEndStep(step)) {
      rec.turnEnded = true;
      if (rec.news) this.recordTurnEnd(step);
    }
  }

  /** The model and token counts a step names. */
  noteModel(step) {
    if (step.type === 'USER_INPUT') this.model = modelFromUserInput(step.content) || this.model;
    if (step.type !== 'PLANNER_RESPONSE') return;
    if (step.model) this.model = agyModelLabel(step.model);
    if (step.usage) this.usage = step.usage;
  }

  /** A planner step: the previous batch is over, this one's calls start. */
  openBatch(rec, step, out) {
    this.closePending(step.at, out);
    this.batch = rec;
    this.pending = this.startCalls(rec, step.toolCalls, step.at, out);
  }

  /**
   * A planner step logged again with more tool calls than before. While it
   * is still the newest batch the new calls join it, in call order; a batch
   * that is already over gets them as calls that ended with no result (they
   * must not take over the newer batch's results).
   */
  openMore(rec, step, out) {
    const added = this.startCalls(rec, step.toolCalls.slice(rec.calls), step.at, out);
    if (this.batch === rec) {
      for (const call of added) this.pending.push(call);
      return;
    }
    this.finishUnresolved(added, step.at, out);
  }

  /** Builds the calls of a batch (or its late additions), reporting the starts of live ones. */
  startCalls(rec, calls, at, out) {
    return calls.map((call) => {
      const position = rec.calls++;
      // Every call keeps its place in the result order, even past the cap.
      const tile = TOOL_TO_TILE.get(call.name) || null;
      const mcp = tile ? null : mcpCallOf(call.name, call.args);
      const shown = Boolean(tile || mcp) && rec.tiled < MAX_EVENTS_PER_STEP;
      if (shown) rec.tiled++;
      const live = position >= rec.quietCalls;
      const entry = {
        id: `${this.idPrefix}${++this.callSeq}`,
        name: call.name,
        live,
        at,
        tile: shown ? tile : null,
        mcp: shown ? mcp : null,
        file: shown && tile && FILE_TILES.has(tile) ? filePathOf(call.args, this.cwd) : '',
        // Diffed only when a live call ends without stating its own diff; history keeps no arguments.
        statArgs: live && shown && (tile === 'Edit' || tile === 'Write') ? call.args : null,
      };
      if (entry.live && entry.tile) out.tools.push(startEvent(entry, agyToolDetail(call.name, tile, call.args)));
      if (entry.live && entry.mcp) out.mcp.push({ phase: 'start', id: entry.id, server: mcp.server, tool: mcp.tool, input: mcp.input, at });
      return entry;
    });
  }

  /** A call's result: its end, its MCP end and the children it names. */
  endCall(call, result, out) {
    if (!call.live) return;
    if (call.tile) out.tools.push(endEvent(call, result));
    if (call.mcp) out.mcp.push(mcpEndEvent(call, result));
    if (CHILD_SPAWNING_TOOLS.has(call.name) && result.status !== 'ERROR') {
      for (const id of childIdsOf(call.name, result.content)) out.children.push(id);
    }
  }

  /**
   * Ends every call still waiting. A new planner step means the previous
   * batch is over: a call with no result (cancelled, killed) must not stay
   * lit, and the renderer only ever wants balanced pairs.
   */
  closePending(at, out) {
    const open = this.pending;
    this.pending = [];
    this.finishUnresolved(open, at, out);
  }

  /** Ends calls that got no result as changing nothing, counting them as unresolved. */
  finishUnresolved(calls, at, out) {
    const ended = endWithoutResult(calls, at);
    this.unresolved += ended.tools.length + ended.mcp.length;
    for (const ev of ended.tools) out.tools.push(ev);
    for (const ev of ended.mcp) out.mcp.push(ev);
  }

  /**
   * Ends every call still waiting, as changing nothing. For a reader that
   * loses its place (a skipped line, a rewritten file): what it lit must go
   * dark, or the tile and the tab's git activity stay on for good.
   * @param {number} at
   * @returns {{tools: object[], mcp: object[]}}
   */
  endOpen(at) {
    const ended = endWithoutResult(this.pending, at);
    this.pending = [];
    return ended;
  }

  /** Drops calls left open by history (a resumed conversation's past). */
  forgetPending() {
    this.pending = [];
  }

  /**
   * A fresh state for reading the same conversation again from the start
   * (its file was rewritten or replaced). Ids keep counting. Every step this
   * state saw (by index, type and time) keeps the calls it had quiet in the
   * new one, and until the reader calls endReplay() so is any unseen step
   * older than the newest one seen - so a re-read reports only what is really
   * new. What an earlier restart knew is carried forward: a second rewrite
   * during a re-read must not replay what the first state reported.
   * @returns {AgyTranscriptState}
   */
  restarted() {
    const quietKeys = new Map(this.quietKeys);
    for (const rec of this.seen.values()) {
      if (rec.at === null) continue;
      const key = stepKey(rec.index, rec.type, rec.at);
      quietKeys.delete(key); // re-inserted as the newest
      quietKeys.set(key, Math.max(rec.calls, quietKeys.get(key) || 0));
    }
    while (quietKeys.size > MAX_QUIET_KEYS) quietKeys.delete(quietKeys.keys().next().value);
    const times = [this.quietBefore, this.newestAt].filter((t) => t !== null);
    // Steps that logged no time at all: everything before the restart point is history.
    const quietBefore = times.length > 0 ? Math.max(...times) : (this.seen.size > 0 ? Infinity : null);
    const next = new AgyTranscriptState({ cwd: this.cwd, idPrefix: this.idPrefix, quietBefore, quietKeys });
    next.callSeq = this.callSeq; // new ids never repeat old ones
    next.model = this.model;
    next.usage = this.usage;
    next.turnStartedAt = this.turnStartedAt;
    return next;
  }
}

/** The start event of a live tiled call. */
function startEvent(call, detail) {
  const ev = { phase: 'start', id: call.id, tile: call.tile, at: call.at, file: call.file };
  return detail ? { ...ev, detail } : ev;
}

/** The end event of one call, given its result step. */
function endEvent(call, result) {
  const failed = result.status === 'ERROR';
  // A failed call changed nothing. An edit's own result states its diff
  // ("(+2/-2 lines)"), which beats counting from the arguments - and costs
  // no diff at all.
  const own = call.tile === 'Edit' && !failed ? resultEditStat(result.content) : null;
  const stat = failed || !call.statArgs ? { added: 0, removed: 0 } : own || editStatOf(call.tile, call.statArgs);
  // A Read's result is the text it put into the window.
  const contextChars = !failed && call.tile === 'Read' && call.file ? result.content.length : 0;
  return {
    phase: 'end',
    id: call.id,
    tile: call.tile,
    at: result.at,
    file: call.file,
    added: stat.added,
    removed: stat.removed,
    contextChars,
    contextTokens: estimateTokens(contextChars, call.file),
  };
}

/** The metrics:mcp end event of one call, given its result step. */
function mcpEndEvent(call, result) {
  return {
    phase: 'end',
    id: call.id,
    server: call.mcp.server,
    tool: call.mcp.tool,
    input: call.mcp.input,
    at: result.at,
    ms: result.at && call.at ? Math.max(0, result.at - call.at) : null,
    ok: result.status !== 'ERROR',
    content: mcpContentOf(result),
  };
}

/** End events (tool and MCP) for live calls that got no result. */
function endWithoutResult(calls, at) {
  const tools = [];
  const mcp = [];
  for (const call of calls) {
    if (!call.live) continue;
    if (call.tile) {
      tools.push({ phase: 'end', id: call.id, tile: call.tile, at, file: call.file, added: 0, removed: 0, contextChars: 0, contextTokens: 0 });
    }
    if (call.mcp) {
      mcp.push({ phase: 'end', id: call.id, server: call.mcp.server, tool: call.mcp.tool, input: call.mcp.input, at, ms: null, ok: false, content: '' });
    }
  }
  return { tools, mcp };
}

/**
 * Context metrics for an agy tab, in usageToMetrics' shape. `tokens` is the
 * newest planner step's real prompt size (input + cache_read, as the Claude
 * path counts input + cache reads + cache writes) when agy logged it, else an
 * estimate from the characters in the window (filestat.js' ratio; it leaves
 * out the system prompt and tool schemas, so it reads low). `estimated` stays
 * true either way: the window itself is assumed (AGY_CONTEXT_LIMIT), so the
 * renderer labels the percentage as approximate and never lets it drive
 * auto-compact. `tokensExact` says which of the two `tokens` is.
 * @param {number} contextChars
 * @param {{file?: string|null, elapsedMs?: number, model?: string,
 *   usage?: {input:number, cacheRead:number}|null}} [extra]
 */
function agyContextMetrics(contextChars, { file = null, elapsedMs = 0, model = '', usage = null } = {}) {
  const exact = isObj(usage) && Number.isFinite(usage.input) && Number.isFinite(usage.cacheRead);
  const tokens = exact
    ? Math.max(0, usage.input + usage.cacheRead)
    : estimateTokens(Math.max(0, Number(contextChars) || 0));
  const limit = AGY_CONTEXT_LIMIT;
  const name = typeof model === 'string' && model ? model : AGY_MODEL;
  return {
    tokens,
    limit,
    percent: Math.min(1, Math.max(0, tokens / limit)),
    model: name,
    modelLabel: name,
    estimated: true,
    tokensExact: exact,
    file,
    elapsedMs,
  };
}

/**
 * conversation id -> the workspace folders (pathKey form) it runs in, and
 * child -> parent conversation, from conversation_summaries rows. A row with
 * a parent_conversation_id is a subagent's conversation.
 * @param {unknown[]} rows {conversation_id, workspace_uris, parent_conversation_id?} rows
 * @returns {{byId: Map<string, string[]>, parents: Map<string, string>, skipped: number}}
 *   skipped = rows that did not validate
 */
function workspacesFromRows(rows) {
  const byId = new Map();
  const parents = new Map();
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObj(row) || typeof row.conversation_id !== 'string' || !UUID_RE.test(row.conversation_id)) {
      skipped++;
      continue;
    }
    let uris;
    try {
      uris = JSON.parse(String(row.workspace_uris || '[]'));
    } catch {
      uris = null;
    }
    if (!Array.isArray(uris)) {
      skipped++;
      continue;
    }
    const folders = [];
    for (const uri of uris) {
      // A file URL as agy writes it, or an absolute local path.
      const folder = normalizeAgyPath(uri, '');
      if (folder) folders.push(pathKey(folder));
    }
    const id = row.conversation_id.toLowerCase();
    byId.set(id, folders);
    const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.toLowerCase() : '';
    if (UUID_RE.test(parent)) parents.set(id, parent);
  }
  return { byId, parents, skipped };
}

/**
 * How a conversation's workspaces relate to a tab's folder: 'exact' (agy
 * runs in that very folder), 'contains' (the tab's folder lies inside one,
 * should agy widen its workspace to a repo root), or null.
 * @param {string[]|undefined} folders pathKey form
 * @param {string} cwd
 * @returns {'exact'|'contains'|null}
 */
function workspaceMatch(folders, cwd) {
  if (!Array.isArray(folders) || !cwd) return null;
  const key = pathKey(cwd);
  if (folders.includes(key)) return 'exact';
  return folders.some((f) => key.startsWith(f.endsWith(path.sep) ? f : f + path.sep)) ? 'contains' : null;
}

/**
 * Which transcript reader a tab's start command gets. 'claude' keeps the
 * exact rule main.js always had (a Claude command, or a bare shell where the
 * user may start claude by hand); 'agy' is the Antigravity CLI; null is any
 * other agent CLI (codex, gemini), which writes no transcript we can read.
 * @param {string|null|undefined} command
 * @returns {'claude'|'agy'|null}
 */
function transcriptKindFor(command) {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd || isClaudeCommand(cmd)) return 'claude';
  if (isAgyCommand(cmd)) return 'agy';
  return null;
}

/**
 * The conversation an agy command resumes (`--conversation=<id>` or
 * `--conversation <id>`), so the watcher can read it without guessing.
 * @param {string} command
 * @returns {string|null}
 */
function conversationIdFromCommand(command) {
  const m = /(?:^|\s)--conversation(?:=|\s+)["']?([0-9a-fA-F-]{36})["']?(?=\s|$)/.exec(String(command || ''));
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

/** Segments between <appData> and a transcript file: brain/<id>/.system_generated/logs/<file>. */
const AGY_TRANSCRIPT_DEPTH = 5;

/**
 * The conversation an agy transcript path belongs to, judged by its shape
 * alone: <appDataDir>/brain/<uuid>/.system_generated/logs/<one of
 * AGY_TRANSCRIPT_FILES>. The path must be absolute and already normalized, so
 * `..`, `.` and doubled separators are refused rather than resolved away.
 * Pure: whether the file exists or is a link is the caller's check.
 * @param {unknown} file
 * @param {unknown} appDataDir agy's app data folder (~/.gemini/antigravity-cli)
 * @returns {string|null} the lowercase conversation id, or null
 */
function agyTranscriptConversation(file, appDataDir) {
  if (typeof file !== 'string' || typeof appDataDir !== 'string' || !appDataDir) return null;
  if (file.includes('\0') || !path.isAbsolute(file) || !path.isAbsolute(appDataDir)) return null;
  if (path.normalize(file) !== file) return null;
  const rel = path.relative(path.resolve(appDataDir), file);
  if (!rel || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== AGY_TRANSCRIPT_DEPTH) return null;
  const [brain, id, generated, logs, name] = parts;
  if (brain !== 'brain' || generated !== '.system_generated' || logs !== 'logs') return null;
  if (!UUID_RE.test(id) || !AGY_TRANSCRIPT_FILES.includes(name)) return null;
  return id.toLowerCase();
}

module.exports = {
  AGY_TRANSCRIPT_FILES,
  agyTranscriptConversation,
  AGY_CONTEXT_LIMIT,
  AGY_TOOL_TILES,
  MAX_EVENTS_PER_STEP,
  MAX_SEEN_STEPS,
  UUID_RE,
  unquoteArg,
  normalizeAgyPath,
  editStatOf,
  modelFromUserInput,
  agyModelLabel,
  parseStepLine,
  parseSteps,
  isAgyTurnEndStep,
  agyTurnEndLine,
  AgyTranscriptState,
  agyContextMetrics,
  workspacesFromRows,
  workspaceMatch,
  transcriptKindFor,
  conversationIdFromCommand,
};
