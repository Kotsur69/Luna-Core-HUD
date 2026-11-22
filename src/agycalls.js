// ============================================================================
// LunaCore - what one Antigravity (`agy`) tool call is (pure, no disk access)
// ----------------------------------------------------------------------------
// The per-call half of the agy transcript adapter (src/agytranscript.js folds
// steps; this module says what a single tool call means):
//   * its Skill Tracker tile (AGY_TOOL_TILES), file and diff stat;
//   * a short sanitized `detail` for the ticker (src/tooldetail.js);
//   * the MCP call it makes (call_mcp_tool / read_resource / list_resources),
//     in the shape observer.js' metrics:mcp events have;
//   * the child conversations a subagent / swarm / workflow call names in its
//     result, so the watcher can follow them.
//
// Checked against agy.exe 1.5.12 (2026-11-22): the tool names below are the
// ones in its tool registry, and live runs on this machine showed the CLI's
// file tools - read_file {Path}, edit_file {Path, Target, Replacement},
// write_file {Path, Content, Overwrite}, run_command {CommandLine},
// invoke_subagent {TypeName, Role, Prompt, Model} - and an edit_file result
// that states its own diff, "Made 1 replacement in <file> ... (+2/-2 lines).".
// edit_file's optional `Edits` list and call_mcp_tool's
// {ServerName, ToolName, Arguments} come from the schemas inside agy.exe.
// transcript.jsonl JSON-quotes every argument ("\"C:/x\""); the _full file
// keeps them plain. Both forms are read.
// ============================================================================

'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const { countLines, countStringDiff } = require('./filestat');
const { commandSummary, scrubSecrets, safeLabel } = require('./tooldetail');

/** A path longer than this is not a file path anyone typed. */
const MAX_PATH_CHARS = 4096;
/** An MCP server or tool name longer than this is not one. */
const MAX_MCP_NAME_CHARS = 128;
/** An MCP call input bigger than this (as JSON) is sent as a marker, not whole. */
const MAX_MCP_INPUT_CHARS = 32 * 1024;
/** Child conversations one result may name; a hostile result cannot flood the watcher. */
const MAX_CHILD_IDS_PER_RESULT = 32;
/** A diff count larger than this in a result is not one. */
const MAX_RESULT_LINES = 1000000;
/** Replace chunks of one call that are counted at all; a hostile list cannot run on. */
const MAX_EDIT_CHUNKS = 64;
/**
 * Lines of one call diffed exactly (a line LCS is an O(n*m) table, run in the
 * main process); a chunk that does not fit what is left counts whole.
 */
const DIFF_LINE_BUDGET = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PART = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** "conversationId": "<uuid>" (invoke_subagent's result), conversation_id=<uuid>, ... */
const CHILD_ID_KEY_RE = new RegExp(`["']?(?:conversationId|conversation_id|ConversationId|ConversationID)["']?\\s*[:=]\\s*["']?(${UUID_PART})`, 'g');
/** .../brain/<uuid>/... (the logAbsoluteUri next to it). */
const CHILD_BRAIN_RE = new RegExp(`brain[\\\\/](${UUID_PART})[\\\\/]`, 'g');
/** agy's own diff count in an edit result: "(+2/-2 lines)". */
const RESULT_DIFF_RE = /\(\+(\d{1,7})\/-(\d{1,7}) lines?\)/g;
const MCP_NAME_RE = /^[\w.:@/ -]+$/;

/**
 * agy tool name -> Skill Tracker tile. The tile names are the Claude path's
 * (observer.js TOOL_TILES keys), so the renderer needs no agy branch at all.
 * Task covers everything that starts, steers or waits on another agent:
 * subagents, swarms, workflows, the Orchestrator's plan hand-off
 * (exit_plan_mode / enter_plan_mode) and scheduled reviews. manage_task
 * manages the background shell tasks run_command started, so it is Shell.
 * Unknown tools map to no tile and emit no tool event, exactly like an MCP
 * call on the Claude path; MCP calls are reported by mcpCallOf() instead.
 */
const AGY_TOOL_TILES = Object.freeze({
  Read: Object.freeze(['view_file', 'read_file', 'view_file_outline', 'view_code_item', 'search_in_file']),
  Edit: Object.freeze(['replace_file_content', 'multi_replace_file_content', 'edit_file', 'notebook_edit']),
  Write: Object.freeze(['write_to_file', 'write_file', 'create_file']),
  Shell: Object.freeze(['run_command', 'send_command_input', 'command_status', 'read_terminal', 'manage_task']),
  Grep: Object.freeze(['grep_search', 'code_search']),
  Glob: Object.freeze(['find_by_name', 'list_dir']),
  Web: Object.freeze(['search_web', 'read_url_content', 'view_content_chunk']),
  Task: Object.freeze([
    'invoke_subagent', 'browser_subagent', 'define_subagent', 'manage_subagents', 'send_message',
    'swarm', 'manage_swarm', 'swarm_wait', 'read_board', 'post_message',
    'run_workflow', 'exit_plan_mode', 'enter_plan_mode', 'schedule',
  ]),
});

const TOOL_TO_TILE = new Map();
for (const [tile, names] of Object.entries(AGY_TOOL_TILES)) {
  for (const name of names) TOOL_TO_TILE.set(name, tile);
}

/** Only these tiles name a FILE (list_dir / grep_search name a folder). */
const FILE_TILES = new Set(['Read', 'Edit', 'Write']);

/** Calls whose result may name the child conversations they started. */
const CHILD_SPAWNING_TOOLS = new Set(['invoke_subagent', 'browser_subagent', 'swarm', 'manage_swarm', 'run_workflow']);

/** agy's MCP tools: the server and tool they call are arguments, not the name. */
const MCP_TOOLS = new Set(['call_mcp_tool', 'read_resource', 'list_resources']);

/**
 * Argument keys a file tool puts its path in: the CLI's Path, view_file
 * AbsolutePath, write_to_file / replace_file_content TargetFile.
 */
const PATH_ARG_KEYS = Object.freeze(['Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'File']);

const ZERO_STAT = Object.freeze({ added: 0, removed: 0 });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A network or device path: \\host\share, //host/share, \\?\..., \\.\...
 * Never accepted - the HUD stats every path it shows, and on Windows a stat
 * of \\host\share opens an SMB connection that sends NTLM credentials. The
 * paths here are written by a model, so a prompt injection could aim one.
 */
const isNetworkPath = (p) => /^[\\/]{2}/.test(p);

/**
 * agy JSON-quotes string arguments in transcript.jsonl ("\"C:/x\""). Returns
 * the plain string; anything that is not a string comes back unchanged. A
 * value that only LOOKS quoted (bad JSON inside) keeps its inner text, which
 * is what the swarm sidecar agy ships does with it too.
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
 * A structured argument (ReplacementChunks, Edits, Arguments) may arrive as
 * a JSON string.
 * @returns {unknown} the parsed value, or null when it is not JSON
 */
function structuredArg(value) {
  const v = unquoteArg(value);
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null; // not structured: the caller treats it as absent
  }
}

/** A string argument, unquoted; '' for anything else. */
function stringArg(value) {
  const v = unquoteArg(value);
  return typeof v === 'string' ? v : '';
}

/**
 * An agy path argument as an absolute, normalized, LOCAL path - the form
 * git's rows and the Claude path's file_path take, so one file is one row.
 * @param {unknown} raw
 * @param {string} cwd the tab's folder, for a relative path ('' = reject relative)
 * @returns {string} '' when it is not a usable local path
 */
function normalizeAgyPath(raw, cwd) {
  const value = unquoteArg(raw);
  if (typeof value !== 'string') return '';
  let p = value.trim();
  if (!p || p.length > MAX_PATH_CHARS || p.includes('\0') || isNetworkPath(p)) return '';
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return ''; // not a valid local file URL: no file identity
    }
    // Checked again after decoding: %00 and file://host/... only appear now.
    if (p.includes('\0') || isNetworkPath(p)) return '';
  }
  if (!path.isAbsolute(p)) {
    if (!cwd) return '';
    p = path.resolve(cwd, p);
  }
  p = path.normalize(p);
  return isNetworkPath(p) ? '' : p;
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
 * Lines one replace chunk adds and removes, or null when it is not one.
 * A chunk that fits the call's remaining `budget` (in lines) is diffed
 * exactly; otherwise the whole target counts as removed and the whole
 * replacement as added.
 * @returns {{added:number, removed:number, lines:number}|null} lines: what it cost
 */
function chunkStat(chunk, budget) {
  if (!isObj(chunk)) return null;
  const from = unquoteArg(chunk.TargetContent ?? chunk.Target);
  const rawTo = chunk.ReplacementContent ?? chunk.Replacement;
  // edit_file: an absent Replacement deletes the target.
  const to = rawTo === undefined && 'Target' in chunk ? '' : unquoteArg(rawTo);
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const fromLines = countLines(from);
  const toLines = countLines(to);
  const lines = fromLines + toLines;
  // An empty side is a pure insert or delete; countStringDiff would count
  // the empty string as one (empty) line.
  if (from === '' || to === '' || lines > budget) return { added: toLines, removed: fromLines, lines: 0 };
  return { ...countStringDiff(from, to), lines };
}

/**
 * Lines a write or an edit adds and removes, from the call's own arguments.
 * A replace is exact per chunk, in every form agy has: ReplacementChunks,
 * the single TargetContent / ReplacementContent, and the CLI's edit_file
 * Target / Replacement or its Edits list. A write counts every line as
 * added; when it overwrites a file, what it replaced is unknown and counts 0.
 * @returns {{added:number, removed:number}}
 */
function editStatOf(tile, args) {
  if (!isObj(args)) return { ...ZERO_STAT };
  if (tile === 'Write') {
    const text = unquoteArg(args.CodeContent ?? args.Content);
    return typeof text === 'string' ? { added: countLines(text), removed: 0 } : { ...ZERO_STAT };
  }
  if (tile !== 'Edit') return { ...ZERO_STAT };
  const chunks = structuredArg(args.ReplacementChunks) ?? structuredArg(args.Edits);
  const list = Array.isArray(chunks) ? chunks.slice(0, MAX_EDIT_CHUNKS) : [args];
  let added = 0;
  let removed = 0;
  let budget = DIFF_LINE_BUDGET;
  for (const chunk of list) {
    const diff = chunkStat(chunk, budget);
    if (!diff) continue;
    added += diff.added;
    removed += diff.removed;
    budget -= diff.lines;
  }
  return { added, removed };
}

/**
 * agy's own diff count from an edit result ("Made 1 replacement ... (+2/-2
 * lines)."), summed over every count it states, or null when it states none.
 * @param {unknown} content
 * @returns {{added:number, removed:number}|null}
 */
function resultEditStat(content) {
  if (typeof content !== 'string') return null;
  let found = false;
  let added = 0;
  let removed = 0;
  for (const m of content.matchAll(RESULT_DIFF_RE)) {
    found = true;
    added = Math.min(MAX_RESULT_LINES, added + Number(m[1]));
    removed = Math.min(MAX_RESULT_LINES, removed + Number(m[2]));
  }
  return found ? { added, removed } : null;
}

/** "<type>: <role>" of one subagent entry, sanitized. */
function subagentLabel(entry) {
  if (!isObj(entry)) return '';
  const type = stringArg(entry.TypeName) || stringArg(entry.Type) || stringArg(entry.Name);
  const role = stringArg(entry.Role) || stringArg(entry.Description);
  return safeLabel([type, role].filter(Boolean).join(': '));
}

/** The detail of a Task-tile call: which agent, swarm or workflow. */
function taskDetail(name, args) {
  if (name === 'invoke_subagent' || name === 'browser_subagent') {
    const list = structuredArg(args.Subagents);
    if (Array.isArray(list) && list.length > 0) {
      const first = subagentLabel(list[0]);
      return list.length > 1 ? safeLabel(`${first || name} +${list.length - 1}`) : first || name;
    }
    return subagentLabel(args) || name;
  }
  if (name === 'define_subagent') return safeLabel(stringArg(args.Name) || stringArg(args.TypeName)) || name;
  if (name === 'swarm' || name === 'manage_swarm') {
    return safeLabel(['swarm', stringArg(args.action) || stringArg(args.Action), stringArg(args.name) || stringArg(args.Name)].filter(Boolean).join(' '));
  }
  if (name === 'run_workflow') {
    return safeLabel(stringArg(args.Name) || stringArg(args.WorkflowName) || stringArg(args.Workflow)) || name;
  }
  return name; // a fixed name from AGY_TOOL_TILES: safe as it is
}

/**
 * A short sanitized line saying what a call does, for its start event: the
 * command's binary and plain arguments, the agent or workflow it starts, the
 * pattern it searches for. '' when there is nothing worth showing.
 * @param {string} name agy tool name
 * @param {string|null} tile
 * @param {object} args
 * @returns {string}
 */
function agyToolDetail(name, tile, args) {
  if (!tile || !isObj(args)) return '';
  if (tile === 'Shell') {
    if (name === 'run_command') return commandSummary(stringArg(args.CommandLine) || stringArg(args.Command));
    if (name === 'manage_task') return safeLabel(['task', stringArg(args.Action)].filter(Boolean).join(' '));
    return '';
  }
  if (tile === 'Grep') return scrubSecrets(stringArg(args.Query) || stringArg(args.Pattern) || stringArg(args.SearchPattern));
  if (tile === 'Glob') return name === 'find_by_name' ? scrubSecrets(stringArg(args.Pattern)) : '';
  if (tile === 'Task') return taskDetail(name, args);
  return '';
}

/** An MCP server or tool name, or '' when it is not a plausible one. */
function mcpName(value) {
  const s = stringArg(value).trim();
  return s && s.length <= MAX_MCP_NAME_CHARS && MCP_NAME_RE.test(s) ? s : '';
}

/** The call's MCP input, as an object; an oversized one becomes a marker. */
function mcpInput(name, args) {
  let input = {};
  if (name === 'call_mcp_tool') {
    const parsed = structuredArg(args.Arguments);
    input = isObj(parsed) ? parsed : {};
  } else if (name === 'read_resource') {
    const uri = stringArg(args.Uri) || stringArg(args.URI);
    input = uri ? { uri: scrubSecrets(uri) } : {};
  }
  try {
    return JSON.stringify(input).length > MAX_MCP_INPUT_CHARS ? { truncated: true } : input;
  } catch {
    return { truncated: true }; // a cycle cannot come from JSON, but an input must never throw
  }
}

/**
 * The MCP call an agy tool call makes, in observer.js' metrics:mcp start
 * shape ({server, tool, input}), or null when it is not an MCP call or names
 * no usable server. call_mcp_tool names its tool; read_resource and
 * list_resources are reported under their own names.
 * @param {string} name
 * @param {object} args
 * @returns {{server:string, tool:string, input:object}|null}
 */
function mcpCallOf(name, args) {
  if (!MCP_TOOLS.has(name) || !isObj(args)) return null;
  const server = mcpName(args.ServerName);
  const tool = name === 'call_mcp_tool' ? mcpName(args.ToolName) : name;
  if (!server || !tool) return null;
  return { server, tool, input: mcpInput(name, args) };
}

/**
 * The child conversations a subagent / swarm / workflow result names, from
 * its `conversationId` keys and brain/<id>/ paths (invoke_subagent's result
 * holds both). Lowercase, deduplicated, at most MAX_CHILD_IDS_PER_RESULT.
 * @param {string} name the tool that produced the result
 * @param {unknown} content the result step's content
 * @returns {string[]}
 */
function childIdsOf(name, content) {
  if (!CHILD_SPAWNING_TOOLS.has(name) || typeof content !== 'string') return [];
  const ids = new Set();
  for (const re of [CHILD_ID_KEY_RE, CHILD_BRAIN_RE]) {
    for (const m of content.matchAll(re)) {
      if (ids.size >= MAX_CHILD_IDS_PER_RESULT) break;
      const id = m[1].toLowerCase();
      if (UUID_RE.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

module.exports = {
  AGY_TOOL_TILES,
  TOOL_TO_TILE,
  FILE_TILES,
  CHILD_SPAWNING_TOOLS,
  UUID_RE,
  unquoteArg,
  structuredArg,
  normalizeAgyPath,
  filePathOf,
  editStatOf,
  resultEditStat,
  agyToolDetail,
  mcpCallOf,
  childIdsOf,
};
