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
// The digest is capped. When a session is longer, its start and its end are
// kept and the middle is cut: the task is stated at the start, the outcome at
// the end.
// ============================================================================

'use strict';

/** Tools whose failure text comes from this machine and may be quoted. */
const LOCAL_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']);
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
 * @returns {{text: string, userTurns: number, assistantTurns: number}}
 *   userTurns = messages the user typed (not tool results)
 */
function digestTranscript(jsonl) {
  const blocks = [];
  /** tool_use id -> {index of its line in blocks, name}: a failure is noted on the call's own line. */
  const calls = new Map();
  let userTurns = 0;
  let assistantTurns = 0;

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
        blocks.push(toolLine(part));
      } else if (part.type === 'tool_result' && part.is_error === true) {
        const call = calls.get(part.tool_use_id);
        if (!call) continue;
        const why = LOCAL_TOOLS.has(call.name) ? cut(oneLine(resultText(part.content)), MAX_ERROR_CHARS) : '';
        blocks[call.at] += why ? ` -> failed: ${why}` : ' -> failed';
      }
    }
  }
  return { text: fit(blocks), userTurns, assistantTurns };
}

module.exports = { digestTranscript, MAX_DIGEST_CHARS, LOCAL_TOOLS };
