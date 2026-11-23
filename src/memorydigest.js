// ============================================================================
// LunaCore - a session transcript cut down to what a memory can come from (pure)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4 (section 7). The extractor
// (src/memoryextract.js) does not read Claude Code's JSONL transcript as it
// is: that file is megabytes of tool output. It reads this digest:
//
//   User: <what was typed>
//   Assistant: <what was answered>
//     tool Bash: npm test            -> failed: <first lines of the error>
//     tool Edit: src/main.js
//
// WHAT IS LEFT OUT, AND WHY
// A memory is replayed into every later session, so text written by someone
// else must not reach it (section 7, "sources that are never captured"):
//   - tool RESULTS are never copied. A web page, a mail body or an MCP answer
//     is exactly such text;
//   - the one exception is the first lines of a FAILED call of a local tool
//     (a shell, a file read or edit): an error string is what a gotcha is
//     made of, and it comes from this machine;
//   - subagent turns, thinking, injected reminders and compaction summaries.
//
// It also counts the calls that brought outside text into the session (a web
// fetch or search, a subagent, an MCP tool other than LunaCore's own): their
// results are left out, but what the assistant wrote after reading them may
// still echo them. Capture notes the count in a memory's `source`, and the
// inbox asks Mati to check the text (security review of 2026-11-11).
//
// The digest is capped. When a session is longer, its start and its end are
// kept and the middle is cut: the task is stated at the start, the outcome at
// the end.
//
// ANTIGRAVITY (agy)
// An agy tab writes its own log, one step per line (src/agytranscript.js).
// digestAgyTranscript() reads it under the same rules and gives the same
// shape: the prompt of a USER_INPUT step (without the metadata agy wraps
// around it), a PLANNER_RESPONSE's text and tool calls, and the first lines
// of a FAILED local call (read, edit, write, shell, search). Results, thinking,
// system messages and checkpoint summaries are left out. Outside content is a
// web call (search_web, read_url_content, ...), a browser, a subagent, swarm
// or workflow, and an MCP server other than LunaCore's own.
// ============================================================================

'use strict';

const { parseSteps } = require('./agytranscript');
const { TOOL_TO_TILE, mcpCallOf, unquoteArg } = require('./agycalls');

/** Tools whose failure text comes from this machine and may be quoted. */
const LOCAL_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']);
/** Tools whose results are outside content: the web, or another agent's answer. */
const OUTSIDE_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task']);
const MCP_PREFIX = 'mcp__';
/** LunaCore's own MCP server answers from this machine: to-dos and memories. */
const OWN_MCP_PREFIX = 'mcp__lunacore__';

/** Whether a tool call brings outside text into the session. */
const readsOutside = (name) =>
  typeof name === 'string' && (OUTSIDE_TOOLS.has(name) || (name.startsWith(MCP_PREFIX) && !name.startsWith(OWN_MCP_PREFIX)));

/** The input field that says what a tool call was about. */
const TOOL_SUBJECT = ['command', 'file_path', 'pattern', 'path', 'skill', 'description', 'query', 'url'];

const MAX_USER_CHARS = 2000;
const MAX_ASSISTANT_CHARS = 1500;
const MAX_SUBJECT_CHARS = 200;
const MAX_ERROR_CHARS = 300;
/** About 15,000 tokens for the small model. */
const MAX_DIGEST_CHARS = 60000;
/** Of a session that does not fit, this much of its start is kept. */
const HEAD_CHARS = 10000;
/** Room for the "left out" line. */
const CUT_NOTE_CHARS = 80;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max).trimEnd()} ...` : s);

/** Blocks the harness adds to a user message: not something the user said. */
const INJECTED_RE =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-args|task-notification)>[\s\S]*?<\/\1>/g;

function userText(text) {
  return text
    .replace(INJECTED_RE, '')
    .replace(/<\/?command-name>/g, '')
    .trim();
}

/** Plain text of a tool result's content (a string, or a list of text parts). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => isObject(p) && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function toolLine(part) {
  const name = typeof part.name === 'string' ? part.name.slice(0, 80) : 'tool';
  const input = isObject(part.input) ? part.input : {};
  const field = TOOL_SUBJECT.find((k) => typeof input[k] === 'string' && input[k].trim());
  return field ? `  tool ${name}: ${cut(oneLine(input[field]), MAX_SUBJECT_CHARS)}` : `  tool ${name}`;
}

/** The parts of one transcript entry's message, or null when the entry is not a turn. */
function partsOf(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // a half-written last line, or not JSON at all
  }
  if (!isObject(entry) || (entry.type !== 'user' && entry.type !== 'assistant')) return null;
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
  const content = isObject(entry.message) ? entry.message.content : null;
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isObject) : [];
  return { role: entry.type, parts };
}

/** Keeps the start and the end of a list of blocks within MAX_DIGEST_CHARS. */
function fit(blocks) {
  const total = blocks.reduce((n, b) => n + b.length + 1, 0);
  if (total <= MAX_DIGEST_CHARS) return blocks.join('\n');
  const head = [];
  let used = 0;
  let i = 0;
  for (; i < blocks.length && used + blocks[i].length + 1 <= HEAD_CHARS; i++) {
    head.push(blocks[i]);
    used += blocks[i].length + 1;
  }
  const tail = [];
  let j = blocks.length - 1;
  for (; j >= i && used + blocks[j].length + 1 <= MAX_DIGEST_CHARS - CUT_NOTE_CHARS; j--) {
    tail.unshift(blocks[j]);
    used += blocks[j].length + 1;
  }
  return [...head, `[... ${j - i + 1} lines of the middle of the session left out ...]`, ...tail].join('\n');
}

/**
 * @param {string} jsonl a Claude Code transcript, or the part of one appended since the last capture
 * @returns {{text: string, userTurns: number, assistantTurns: number, outside: number}}
 *   userTurns = messages the user typed (not tool results);
 *   outside = tool calls that read outside content (web, subagent, a foreign MCP server)
 */
function digestTranscript(jsonl) {
  const blocks = [];
  /** tool_use id -> {index of its line in blocks, name}: a failure is noted on the call's own line. */
  const calls = new Map();
  let userTurns = 0;
  let assistantTurns = 0;
  let outside = 0;

  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    const turn = partsOf(line);
    if (!turn) continue;
    for (const part of turn.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        const text = turn.role === 'user' ? userText(part.text) : part.text.trim();
        if (!text) continue;
        if (turn.role === 'user') {
          userTurns++;
          blocks.push(`User: ${cut(text, MAX_USER_CHARS)}`);
        } else {
          assistantTurns++;
          blocks.push(`Assistant: ${cut(text, MAX_ASSISTANT_CHARS)}`);
        }
      } else if (part.type === 'tool_use' && turn.role === 'assistant') {
        if (typeof part.id === 'string') calls.set(part.id, { at: blocks.length, name: part.name });
        if (readsOutside(part.name)) outside++;
        blocks.push(toolLine(part));
      } else if (part.type === 'tool_result' && part.is_error === true) {
        const call = calls.get(part.tool_use_id);
        if (!call) continue;
        const why = LOCAL_TOOLS.has(call.name) ? cut(oneLine(resultText(part.content)), MAX_ERROR_CHARS) : '';
        blocks[call.at] += why ? ` -> failed: ${why}` : ' -> failed';
      }
    }
  }
  return { text: fit(blocks), userTurns, assistantTurns, outside };
}

// ---- Antigravity (agy) -----------------------------------------------------

/** agy tiles (src/agycalls.js AGY_TOOL_TILES) whose failure text comes from this machine. */
const AGY_LOCAL_TILES = new Set(['Read', 'Edit', 'Write', 'Shell', 'Grep', 'Glob']);
/** agy tools that bring another agent's answer into the session. */
const AGY_AGENT_TOOLS = new Set([
  'invoke_subagent', 'browser_subagent', 'manage_subagents', 'send_message',
  'swarm', 'manage_swarm', 'swarm_wait', 'read_board', 'run_workflow',
]);
/** agy's MCP tools: the server they call is an argument (src/agycalls.js mcpCallOf). */
const AGY_MCP_TOOLS = new Set(['call_mcp_tool', 'read_resource', 'list_resources']);
/** LunaCore's own server in agy: `lunacore`, or a tab's `lunacore-<tab id>` (src/agyintake.js). */
const OWN_AGY_MCP_RE = /^lunacore(?:-[A-Za-z0-9_-]{1,64})?$/;
/** The prompt itself, when agy wraps it with metadata. */
const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
/** Blocks agy adds to a prompt: not something the user said. */
const AGY_INJECTED_RE = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/g;
/** agy's result header: "Created At: ...\nCompleted At: ...\n", repeated. */
const AGY_RESULT_HEADER_RE = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
/** The argument that says what an agy call was about (CLI and IDE tool names). */
const AGY_SUBJECT = [
  'CommandLine', 'Command', 'Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'File',
  'Query', 'Pattern', 'SearchPattern', 'Url', 'URL', 'TypeName', 'Role',
];

/**
 * Whether an agy call brings outside text into the session. An MCP call that
 * names no usable server may still have reached one, so it counts.
 * @param {string} name
 * @param {object} args
 */
function readsOutsideAgy(name, args) {
  if (typeof name !== 'string') return false;
  if (TOOL_TO_TILE.get(name) === 'Web' || AGY_AGENT_TOOLS.has(name) || name.startsWith('browser')) return true;
  if (!AGY_MCP_TOOLS.has(name)) return false;
  const call = mcpCallOf(name, args);
  return !call || !OWN_AGY_MCP_RE.test(call.server);
}

function agyUserText(content) {
  const wrapped = USER_REQUEST_RE.exec(content);
  return (wrapped ? wrapped[1] : content).replace(AGY_INJECTED_RE, '').trim();
}

/** A string argument as agy wrote it (transcript.jsonl JSON-quotes them), or ''. */
function agyArg(args, key) {
  const v = unquoteArg(args[key]);
  return typeof v === 'string' ? v.trim() : '';
}

function agyToolLine({ name, args }) {
  const shown = name.slice(0, 80);
  const mcp = AGY_MCP_TOOLS.has(name) ? mcpCallOf(name, args) : null;
  const key = AGY_SUBJECT.find((k) => agyArg(args, k));
  const subject = mcp ? `${mcp.server} ${mcp.tool}` : key ? agyArg(args, key) : '';
  return subject ? `  tool ${shown}: ${cut(oneLine(subject), MAX_SUBJECT_CHARS)}` : `  tool ${shown}`;
}

/**
 * Each step once, in the place it first appeared, as its newest version: agy
 * logs a step again when its status moves on (src/agytranscript.js).
 */
function latestSteps(steps) {
  const order = [];
  const slot = new Map();
  for (const step of steps) {
    const key = step.index === null ? null : `${step.index}|${step.type}|${step.at}`;
    if (key !== null && slot.has(key)) {
      order[slot.get(key)] = step;
      continue;
    }
    if (key !== null) slot.set(key, order.length);
    order.push(step);
  }
  return order;
}

/** The text a failed agy result gives: its error, else its content without the header. */
const agyErrorText = (result) => result.error || result.content.replace(AGY_RESULT_HEADER_RE, '');

/**
 * @param {string} jsonl an agy transcript, or the part of one appended since the last capture
 * @returns {{text: string, userTurns: number, assistantTurns: number, outside: number}}
 *   the same shape and meaning as digestTranscript()
 */
function digestAgyTranscript(jsonl) {
  const blocks = [];
  /** Calls of the newest planner step still waiting for their result, in call order. */
  let pending = [];
  let userTurns = 0;
  let assistantTurns = 0;
  let outside = 0;

  for (const step of latestSteps(parseSteps(jsonl).steps)) {
    if (step.type === 'USER_INPUT') {
      const text = agyUserText(step.content);
      if (!text) continue;
      userTurns++;
      blocks.push(`User: ${cut(text, MAX_USER_CHARS)}`);
    } else if (step.type === 'PLANNER_RESPONSE') {
      const text = step.content.trim();
      if (text) {
        assistantTurns++;
        blocks.push(`Assistant: ${cut(text, MAX_ASSISTANT_CHARS)}`);
      }
      // A new planner step ends the previous batch: its results are all in.
      pending = step.toolCalls.map((call) => {
        if (readsOutsideAgy(call.name, call.args)) outside++;
        blocks.push(agyToolLine(call));
        return { at: blocks.length - 1, local: AGY_LOCAL_TILES.has(TOOL_TO_TILE.get(call.name)) };
      });
    } else if (step.type === 'GENERIC' && pending.length > 0) {
      const call = pending.shift();
      if (step.status !== 'ERROR') continue;
      const why = call.local ? cut(oneLine(agyErrorText(step)), MAX_ERROR_CHARS) : '';
      blocks[call.at] += why ? ` -> failed: ${why}` : ' -> failed';
    }
  }
  return { text: fit(blocks), userTurns, assistantTurns, outside };
}

/** Transcript kinds capture knows: Claude Code's JSONL, and agy's step log. */
const DIGESTS = Object.freeze({ claude: digestTranscript, agy: digestAgyTranscript });

/**
 * The digest of a transcript of the given kind.
 * @param {string} jsonl
 * @param {'claude'|'agy'} kind
 * @returns {{text: string, userTurns: number, assistantTurns: number, outside: number}}
 */
function digestOf(jsonl, kind) {
  const digest = Object.hasOwn(DIGESTS, kind) ? DIGESTS[kind] : null;
  if (!digest) throw new Error(`unknown transcript kind: ${String(kind).slice(0, 20)}`);
  return digest(jsonl);
}

module.exports = { digestTranscript, digestAgyTranscript, digestOf, readsOutside, readsOutsideAgy, MAX_DIGEST_CHARS, LOCAL_TOOLS };
