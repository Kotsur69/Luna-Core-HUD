// ============================================================================
// LunaCore - Antigravity (`agy`) transcript adapter (pure, no disk access)
// ----------------------------------------------------------------------------
// An agy tab writes no Claude transcript, so the Active files and Context
// widgets had nothing to read. agy keeps its own per-conversation log, and this
// module turns it into the SAME events the Claude path (src/observer.js) emits:
//   * tool start/end events {phase, id, tile, at, file, added, removed, ...}
//     for the Skill Tracker, the Active-Files Heatmap and git attribution;
//   * context metrics in usageToMetrics' shape {tokens, limit, percent, model,
//     modelLabel}, plus `estimated: true` - see agyContextMetrics().
// src/agywatcher.js finds and tails the file; everything here is pure.
//
// Where agy keeps it (agy.exe 1.5.9, checked on 2026-11-17 against the strings
// and the docs built into agy.exe, and the swarm_board sidecar agy ships in
// ~/.gemini/antigravity-cli/builtin/plugins/swarm/sidecars/swarm_board/main.mjs,
// which parses these very files):
//   <appData>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
//   <appData>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
//   <appData>/conversation_summaries.db   SQLite, one row per conversation
//                                          (conversation_id, workspace_uris, ...)
// with <appData> = ~/.gemini/antigravity-cli. transcript.jsonl truncates large
// fields (and lists them in `truncated_fields`); transcript_full.jsonl does not.
//
// One JSON object per line, one line per step:
//   {step_index, source, type, status, created_at, content, thinking,
//    tool_calls: [{name, args}], truncated_fields?, error?}
// `type` USER_INPUT is a prompt, PLANNER_RESPONSE the model's reply and its
// tool calls, GENERIC a tool result. Results follow their planner step in call
// order. String args are often JSON-quoted ("\"C:/x\""). There are NO token
// counts and no model name in it, hence the estimate.
//
// NOT verified against a live session: no agy conversation on this machine
// had a single step, and `agy --help` hangs (see src/launch.js). The field
// names above are agy's own documentation; the file-tool names and argument
// keys come from the tool examples and allow-lists inside agy.exe.
// ============================================================================

'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const { AGY_MODEL } = require('./claudeModels');
const { isClaudeCommand, isAgyCommand } = require('./launch');
const { countLines, countStringDiff, estimateTokens } = require('./filestat');
const { pathKey } = require('./gitattribution');

/**
 * Context window assumed for an agy tab. agy names no model per conversation
 * and its default models are Gemini ones, documented at 1,048,576 tokens. The
 * round million matches models.js' tiers (and the badge's "1M"); the 5 %
 * difference is far inside the error of the estimate itself.
 */
const AGY_CONTEXT_LIMIT = 1000000;

/** A path longer than this is not a file path anyone typed. */
const MAX_PATH_CHARS = 4096;
/** Tool names longer than this are garbage, not a tool. */
const MAX_TOOL_NAME_CHARS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * agy tool name -> Skill Tracker tile. The tile names are the Claude path's
 * (observer.js TOOL_TILES keys), so the renderer needs no agy branch at all.
 * Unknown tools (MCP, browser, swarm) map to no tile and emit nothing, exactly
 * like an MCP call on the Claude path.
 */
const AGY_TOOL_TILES = Object.freeze({
  Read: Object.freeze(['view_file', 'read_file', 'view_file_outline', 'view_code_item', 'search_in_file']),
  Edit: Object.freeze(['replace_file_content', 'multi_replace_file_content', 'edit_file']),
  Write: Object.freeze(['write_to_file', 'write_file', 'create_file']),
  Shell: Object.freeze(['run_command', 'send_command_input', 'command_status', 'read_terminal']),
  Grep: Object.freeze(['grep_search', 'code_search']),
  Glob: Object.freeze(['find_by_name', 'list_dir']),
  Web: Object.freeze(['search_web', 'read_url_content', 'view_content_chunk']),
  Task: Object.freeze(['invoke_subagent']),
});

const TOOL_TO_TILE = new Map();
for (const [tile, names] of Object.entries(AGY_TOOL_TILES)) {
  for (const name of names) TOOL_TO_TILE.set(name, tile);
}

/** Only these tiles name a FILE (list_dir / grep_search name a folder). */
const FILE_TILES = new Set(['Read', 'Edit', 'Write']);

/**
 * Argument keys a file tool puts its path in: view_file AbsolutePath,
 * write_to_file / replace_file_content TargetFile, the swarm sidecar's Path.
 */
const PATH_ARG_KEYS = Object.freeze(['AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'File']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * agy JSON-quotes string arguments ("\"C:/x\""). Returns the plain string;
 * anything that is not a string comes back unchanged. A value that only LOOKS
 * quoted (bad JSON inside) keeps its inner text, which is what the sidecar
 * agy ships does with it too.
 * @param {unknown} value
 * @returns {unknown}
 */
function unquoteArg(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return value;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'string' ? parsed : s;
  } catch {
    return s.slice(1, -1);
  }
}

/**
 * A structured argument (ReplacementChunks) may arrive as a JSON string.
 * @returns {unknown} the parsed value, or null when it is not JSON
 */
function structuredArg(value) {
  const v = unquoteArg(value);
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null; // not structured: the caller treats it as "no chunks"
  }
}

/**
 * An agy path argument as an absolute, normalized path - the form git's
 * rows and the Claude path's file_path take, so one file is one row.
 * @param {unknown} raw
 * @param {string} cwd the tab's folder, for a relative path
 * @returns {string} '' when it is not a usable path
 */
function normalizeAgyPath(raw, cwd) {
  const value = unquoteArg(raw);
  if (typeof value !== 'string') return '';
  let p = value.trim();
  if (!p || p.length > MAX_PATH_CHARS || p.includes('\0')) return '';
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return ''; // a file URL for another host or a bad one: no file identity
    }
  }
  if (!path.isAbsolute(p)) {
    if (!cwd) return '';
    p = path.resolve(cwd, p);
  }
  return path.normalize(p);
}

/** The file a call works on, or ''. */
function filePathOf(args, cwd) {
  for (const key of PATH_ARG_KEYS) {
    const file = normalizeAgyPath(args[key], cwd);
    if (file) return file;
  }
  return '';
}

/**
 * Lines a write or an edit adds and removes, from the call's own arguments
 * (agy logs no diff). A replace is exact per chunk. A write counts every line
 * as added; when it overwrites a file, what it replaced is unknown and counts 0.
 * @returns {{added:number, removed:number}}
 */
function editStatOf(tile, args) {
  if (tile === 'Write') {
    const text = unquoteArg(args.CodeContent ?? args.Content);
    return typeof text === 'string' ? { added: countLines(text), removed: 0 } : { added: 0, removed: 0 };
  }
  if (tile !== 'Edit') return { added: 0, removed: 0 };
  const chunks = structuredArg(args.ReplacementChunks);
  // The single-chunk form carries TargetContent / ReplacementContent itself.
  const list = Array.isArray(chunks) ? chunks : [args];
  let added = 0;
  let removed = 0;
  for (const chunk of list) {
    if (!isObj(chunk)) continue;
    const from = unquoteArg(chunk.TargetContent);
    const to = unquoteArg(chunk.ReplacementContent);
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    // An empty side is a pure insert or delete; countStringDiff would count
    // the empty string as one (empty) line.
    const diff =
      from === '' ? { added: countLines(to), removed: 0 }
        : to === '' ? { added: 0, removed: countLines(from) }
          : countStringDiff(from, to);
    added += diff.added;
    removed += diff.removed;
  }
  return { added, removed };
}

/** Validated tool calls of one step; anything malformed is left out. */
function toolCallsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const calls = [];
  for (const tc of raw) {
    if (!isObj(tc) || typeof tc.name !== 'string') continue;
    const name = tc.name.trim();
    if (!name || name.length > MAX_TOOL_NAME_CHARS) continue;
    const args = isObj(tc.args) ? tc.args : structuredArg(tc.args);
    calls.push({
      id: typeof tc.id === 'string' && tc.id ? tc.id : '',
      name,
      args: isObj(args) ? args : {},
    });
  }
  return calls;
}

/**
 * Parses one transcript line.
 * @param {string} line
 * @returns {{step: object|null, reason: string|null}}
 */
function parseStepLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    return { step: null, reason: `invalid JSON (${err.message})` };
  }
  if (!isObj(obj)) return { step: null, reason: 'not a JSON object' };
  if (typeof obj.type !== 'string' || !obj.type) return { step: null, reason: 'step has no type' };
  const content = typeof obj.content === 'string' ? obj.content : '';
  const toolCalls = toolCallsOf(obj.tool_calls);
  return {
    step: {
      index: Number.isInteger(obj.step_index) ? obj.step_index : null,
      // The enum's full name (CORTEX_STEP_TYPE_GENERIC) is accepted too.
      type: obj.type.replace(/^CORTEX_STEP_TYPE_/, ''),
      status: typeof obj.status === 'string' ? obj.status : '',
      at: typeof obj.created_at === 'string' ? Date.parse(obj.created_at) || null : null,
      content,
      toolCalls,
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

/**
 * The running state of one agy conversation: tool calls waiting for their
 * result, and the characters currently in the context window. It spans
 * fragments on purpose - a call routinely lands in one read and its result in
 * the next (the same reason observer.js keeps `openTools` across ticks).
 */
class AgyTranscriptState {
  /** @param {{cwd?: string}} [opts] cwd resolves relative paths */
  constructor({ cwd = '' } = {}) {
    this.cwd = typeof cwd === 'string' ? cwd : '';
    /** Calls of the newest planner step still waiting for a result, in call order. */
    this.pending = [];
    /** Characters in the context window since the conversation (or its last checkpoint) began. */
    this.contextChars = 0;
  }

  /**
   * Folds parsed steps and returns the tool events they complete, in order.
   * Starts and ends always come in balanced pairs.
   * @param {object[]} steps parseSteps().steps
   * @returns {object[]}
   */
  apply(steps) {
    const events = [];
    for (const step of Array.isArray(steps) ? steps : []) {
      // A checkpoint is agy compacting the conversation: its summary replaces
      // everything before it in the window.
      this.contextChars = step.type === 'CHECKPOINT' ? step.chars : this.contextChars + step.chars;
      if (step.type === 'PLANNER_RESPONSE') {
        events.push(...this.closePending(step.at));
        this.pending = step.toolCalls.map((call, i) => this.openCall(call, step, i));
        for (const call of this.pending) {
          if (call.tile) events.push({ phase: 'start', id: call.id, tile: call.tile, at: step.at, file: call.file });
        }
      } else if (step.type === 'GENERIC' && this.pending.length > 0) {
        const call = this.pending.shift();
        if (call.tile) events.push(endEvent(call, step));
      }
    }
    return events;
  }

  /**
   * Ends every call still waiting. A new planner step means the previous
   * batch is over: a call with no result (cancelled, killed) must not stay
   * lit, and the renderer only ever wants balanced pairs.
   */
  closePending(at) {
    const events = this.pending
      .filter((call) => call.tile)
      .map((call) => ({ phase: 'end', id: call.id, tile: call.tile, at, file: call.file, added: 0, removed: 0, contextChars: 0, contextTokens: 0 }));
    this.pending = [];
    return events;
  }

  /** Drops calls left open by history (a resumed conversation's past). */
  forgetPending() {
    this.pending = [];
  }

  openCall(call, step, i) {
    const tile = TOOL_TO_TILE.get(call.name) || null;
    return {
      // agy's own id when it logs one, else one that is unique per conversation.
      id: call.id || `agy:${step.index ?? 'x'}:${i}`,
      tile,
      file: tile && FILE_TILES.has(tile) ? filePathOf(call.args, this.cwd) : '',
      stat: tile ? editStatOf(tile, call.args) : { added: 0, removed: 0 },
    };
  }
}

/** The end event of one call, given its result step. */
function endEvent(call, result) {
  const failed = result.status === 'ERROR';
  // A failed call changed nothing; a Read's result is the text it put into the window.
  const stat = failed ? { added: 0, removed: 0 } : call.stat;
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

/**
 * Context metrics for an agy tab, in usageToMetrics' shape. agy writes no
 * token counts, so `tokens` is an estimate from the characters in the window
 * (filestat.js' ratio). It leaves out the system prompt and tool schemas, so
 * it reads low. `estimated: true` makes the renderer label it as approximate,
 * and keeps it from driving auto-compact.
 * @param {number} contextChars
 * @param {{file?: string|null, elapsedMs?: number}} [extra]
 */
function agyContextMetrics(contextChars, { file = null, elapsedMs = 0 } = {}) {
  const tokens = estimateTokens(Math.max(0, Number(contextChars) || 0));
  const limit = AGY_CONTEXT_LIMIT;
  return {
    tokens,
    limit,
    percent: Math.min(1, Math.max(0, tokens / limit)),
    model: AGY_MODEL,
    modelLabel: AGY_MODEL,
    estimated: true,
    file,
    elapsedMs,
  };
}

/**
 * conversation id -> the workspace folders (pathKey form) it runs in, from
 * conversation_summaries rows. Rows that do not validate are left out.
 * @param {unknown[]} rows {conversation_id, workspace_uris} rows
 * @returns {Map<string, string[]>}
 */
function workspacesFromRows(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObj(row) || typeof row.conversation_id !== 'string' || !UUID_RE.test(row.conversation_id)) continue;
    let uris;
    try {
      uris = JSON.parse(String(row.workspace_uris || '[]'));
    } catch {
      continue; // a row agy wrote half-way: it is read again on the next tick
    }
    if (!Array.isArray(uris)) continue;
    const folders = [];
    for (const uri of uris) {
      const folder = typeof uri === 'string' && /^file:\/\//i.test(uri) ? normalizeAgyPath(uri, '') : '';
      if (folder) folders.push(pathKey(folder));
    }
    byId.set(row.conversation_id.toLowerCase(), folders);
  }
  return byId;
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

module.exports = {
  AGY_CONTEXT_LIMIT,
  AGY_TOOL_TILES,
  UUID_RE,
  unquoteArg,
  normalizeAgyPath,
  editStatOf,
  parseStepLine,
  parseSteps,
  AgyTranscriptState,
  agyContextMetrics,
  workspacesFromRows,
  transcriptKindFor,
  conversationIdFromCommand,
};
