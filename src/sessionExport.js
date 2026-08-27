// ============================================================================
// LunaCore - session transcript -> Markdown export
// ----------------------------------------------------------------------------
// Turns a Claude Code JSONL transcript into a clean, readable .md file: user
// prompts and Luna's replies as sections, each tool call folded into a
// <details> block with a truncated result, and a YAML frontmatter header
// carrying the session's models / token totals / estimated cost.
//
// PASSIVE OBSERVER: pure string work over a transcript that is ALREADY on
// disk. No PTY writes, no model calls, no watcher of its own - main.js hands
// this function the same text it tails for metrics. The only write is the .md
// the user explicitly asked for, to a path they picked in a save dialog.
//
// Structural template is ttsExtract.js: a pure text -> text core with a
// sibling test file; the disk read and the save dialog live in main.js.
// ============================================================================

'use strict';

const { sumUsageByModel, estimateSessionCost } = require('./observer');
const { formatUsd } = require('./rates');

// Per tool-result body inside a <details> block. A result can be a whole file
// echoed back; 40 lines is enough to see WHAT it returned without pasting the
// file into the export. Honest marker when it bites - activefiles.js's rule.
const MAX_RESULT_LINES = 40;
const MAX_RESULT_CHARS = 2000;

// Whole-document ceiling. A multi-hour session with big Reads can run to
// megabytes; past this we stop and say so rather than hand back a file no
// editor wants to open.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Entry `type`s that carry no conversation - CLI bookkeeping, snapshots, mode
// flips. Everything not in here is still checked by classifyEntry() proper.
const SKIP_TYPES = new Set([
  'system',
  'summary',
  'file-history-snapshot',
  'file-history-delta',
  'mode',
  'permission-mode',
  'queue-operation',
  'last-prompt',
  'atis-latch',
  'bridge-session',
  'attachment',
]);

// ---- small helpers ---------------------------------------------------------

/** Whole-line JSON.parse, tolerating a truncated trailing line (observer.js's rule). */
function parseLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* incomplete / corrupt line - skip */
    }
  }
  return out;
}

/** ISO timestamp -> "YYYY-MM-DD HH:MM:SS" in local time (the rest of the HUD shows local). */
function fmtTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Last two path segments, for a compact tool-call hint. */
function shortPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** First line of `s`, clipped to `n` chars with an ellipsis. */
function firstLine(s, n) {
  const line = String(s || '').split('\n')[0].trim();
  return line.length > n ? `${line.slice(0, n)}…` : line;
}

function basename(p) {
  return String(p || '').split(/[\\/]+/).filter(Boolean).pop() || '';
}

/** First truthy value of `key` across entries (cwd / gitBranch / sessionId). */
function firstDefined(entries, key) {
  for (const e of entries) {
    if (e && typeof e[key] === 'string' && e[key]) return e[key];
  }
  return '';
}

/** Drop harness-injected blocks that are neither Mati's words nor Luna's. */
function stripInjectedNoise(str) {
  return String(str || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A `role:user` string that is actually a slash-command invocation -> "/name args", or null. */
function slashCommand(str) {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(str);
  if (!name || !name[1].trim()) return null;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(str);
  const cmd = name[1].trim().replace(/^\/+/, '');
  const tail = args && args[1] && args[1].trim() ? ` ${args[1].trim()}` : '';
  return `/${cmd}${tail}`;
}

/** Concatenate the `text` blocks of a content array (or return a plain string as-is). */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

/** A tool_result's `content` (string | block[] | object) -> plain text. */
function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b && b.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Caps a tool-result body at MAX_RESULT_LINES / MAX_RESULT_CHARS.
 * @returns {{ text: string, truncated: boolean, omittedLines: number }}
 */
function truncateResult(text) {
  const str = stringifyResult(text) || '';
  let cut = str;
  const lines = str.split('\n');
  if (lines.length > MAX_RESULT_LINES) cut = lines.slice(0, MAX_RESULT_LINES).join('\n');
  if (cut.length > MAX_RESULT_CHARS) cut = cut.slice(0, MAX_RESULT_CHARS);
  const truncated = cut.length < str.length;
  const omittedLines = truncated ? lines.length - cut.split('\n').length : 0;
  return { text: cut, truncated, omittedLines };
}

/** Pretty-print a tool's `input`, truncated; '' for empty / unserialisable. */
function safeJson(obj) {
  if (obj == null) return '';
  let s;
  try {
    s = JSON.stringify(obj, null, 2);
  } catch {
    return '';
  }
  if (s === '{}' || s === '[]' || s === 'null') return '';
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : s;
}

/** One-line summary text for a tool call: the most identifying input value. */
function toolHint(block) {
  const inp = (block && block.input) || {};
  if (typeof inp.file_path === 'string') return shortPath(inp.file_path);
  if (typeof inp.path === 'string') return shortPath(inp.path);
  if (typeof inp.command === 'string') return firstLine(inp.command, 80);
  if (typeof inp.pattern === 'string') return firstLine(inp.pattern, 60);
  if (typeof inp.url === 'string') return firstLine(inp.url, 80);
  if (typeof inp.description === 'string') return firstLine(inp.description, 80);
  if (typeof inp.prompt === 'string') return firstLine(inp.prompt, 80);
  return '';
}

/** Keep a <summary> on one line and out of HTML's way. */
function escapeInline(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- classification ------------------------------------------------------

/**
 * Sorts one transcript entry into a render bucket.
 * Pure and exported so the routing is unit-testable without building Markdown.
 * @param {object} e a parsed JSONL entry
 * @returns {{kind:'skip'}
 *   | {kind:'prompt', sidechain:boolean, text:string, at?:string}
 *   | {kind:'command', sidechain:boolean, command:string, at?:string}
 *   | {kind:'assistant', sidechain:boolean, message:object, at?:string}
 *   | {kind:'error', sidechain:boolean, status:string, at?:string}}
 */
function classifyEntry(e) {
  if (!e || typeof e !== 'object') return { kind: 'skip' };
  if (e.isMeta) return { kind: 'skip' };
  if (SKIP_TYPES.has(e.type)) return { kind: 'skip' };

  const sidechain = e.isSidechain === true;
  const msg = e.message;
  const at = typeof e.timestamp === 'string' ? e.timestamp : undefined;

  if (e.type === 'assistant') {
    if (e.isApiErrorMessage) {
      return { kind: 'error', sidechain, status: e.apiErrorStatus || '', at };
    }
    return { kind: 'assistant', sidechain, message: msg || {}, at };
  }

  if (e.type === 'user') {
    const content = msg && msg.content;

    if (typeof content === 'string') {
      const cmd = slashCommand(content);
      if (cmd) return { kind: 'command', sidechain, command: cmd, at };
      const clean = stripInjectedNoise(content);
      return clean ? { kind: 'prompt', sidechain, text: clean, at } : { kind: 'skip' };
    }

    if (Array.isArray(content)) {
      // A user entry that is ONLY tool_result blocks is the CLI re-injecting a
      // finished tool's output - not Mati talking. It gets folded into the
      // assistant's <details> instead.
      const hasReal = content.some((b) => b && b.type && b.type !== 'tool_result');
      if (!hasReal) return { kind: 'skip' };
      const text = stripInjectedNoise(textFromContent(content));
      const imgs = content.filter((b) => b && b.type === 'image').length;
      const body = [text, imgs ? `_[${imgs} image${imgs > 1 ? 's' : ''}]_` : ''].filter(Boolean).join('\n\n');
      return body ? { kind: 'prompt', sidechain, text: body, at } : { kind: 'skip' };
    }
  }

  return { kind: 'skip' };
}

// ---- rendering ---------------------------------------------------------

/** id -> { body, isError } for every tool_result in the transcript. */
function indexToolResults(entries) {
  const byId = new Map();
  for (const e of entries) {
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      let body = stringifyResult(b.content);
      // Block content can be empty while the entry's top-level toolUseResult
      // still holds the text (denied calls do exactly this - see observer.js).
      if (!body && typeof e.toolUseResult === 'string') body = e.toolUseResult;
      byId.set(b.tool_use_id, { body, isError: b.is_error === true });
    }
  }
  return byId;
}

/** One tool_use block + its matched result -> a collapsed <details> block. */
function renderToolUse(block, results) {
  const name = block.name || 'tool';
  const hint = toolHint(block);
  const res = results.get(block.id);
  const flag = res && res.isError ? '⚠️ ' : '🔧 ';
  const lines = [`<details><summary>${escapeInline(`${flag}${name}${hint ? ` · ${hint}` : ''}`)}</summary>`, ''];

  const input = safeJson(block.input);
  if (input) lines.push('input:', '```json', input, '```', '');

  if (res) {
    const { text, truncated, omittedLines } = truncateResult(res.body);
    if (text.trim()) {
      lines.push(res.isError ? 'error:' : 'result:', '```', text, '```');
      if (truncated) lines.push(omittedLines > 0 ? `…(+${omittedLines} more lines)` : '…(truncated)');
      lines.push('');
    } else {
      lines.push('_(no result captured)_', '');
    }
  }

  lines.push('</details>');
  return lines.join('\n');
}

/** An assistant message's content -> Markdown (text kept, tool_use folded, thinking dropped). */
function renderAssistant(message, results) {
  const content = message && message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text.trim());
    else if (b.type === 'tool_use') parts.push(renderToolUse(b, results));
    // thinking / redacted_thinking -> deliberately dropped
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---- frontmatter -----------------------------------------------------------

/** Session-level facts shared by the frontmatter and the H1. */
function deriveMeta(entries, meta = {}) {
  const msgs = entries.filter(
    (e) => e && (e.type === 'user' || e.type === 'assistant') && e.message && e.timestamp,
  );
  const cwd = meta.cwd || firstDefined(entries, 'cwd');
  return {
    sessionId: meta.sessionId || firstDefined(entries, 'sessionId'),
    cwd,
    project: meta.project || basename(cwd),
    branch: firstDefined(entries, 'gitBranch'),
    first: msgs[0] || null,
    last: msgs[msgs.length - 1] || null,
  };
}

function sumTotals(byModel) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of byModel.values()) {
    t.input += m.input;
    t.output += m.output;
    t.cacheRead += m.cacheRead;
    t.cacheWrite += m.cacheWrite;
  }
  return t;
}

/**
 * Builds the YAML frontmatter block (no trailing newline).
 * @param {string} jsonlText the raw transcript (for sumUsageByModel)
 * @param {object[]} entries parsed entries
 * @param {object} [meta] { cwd, sessionId, project } overrides
 * @returns {string}
 */
function buildFrontmatter(jsonlText, entries, meta = {}) {
  const m = deriveMeta(entries, meta);
  // `<synthetic>` and other <...> placeholders are the CLI's own injected
  // assistant messages, not a model Mati ran - keep only real model ids.
  const models = [
    ...new Set(
      entries
        .filter((e) => e && e.type === 'assistant' && e.message && typeof e.message.model === 'string')
        .map((e) => e.message.model)
        .filter((id) => id && !/^<.*>$/.test(id)),
    ),
  ];
  const prompts = entries.filter((e) => {
    const c = classifyEntry(e);
    return c.kind === 'prompt' && !c.sidechain;
  }).length;

  const byModel = sumUsageByModel(jsonlText);
  const totals = sumTotals(byModel);
  const cost = estimateSessionCost(byModel);
  const n = (x) => Number(x || 0).toLocaleString('en-US');

  const rows = [
    '---',
    `session: ${m.sessionId || 'unknown'}`,
    `project: ${m.project || 'unknown'}`,
    m.cwd ? `cwd: ${m.cwd}` : null,
    m.branch ? `branch: ${m.branch}` : null,
    models.length ? `model: ${models.join(', ')}` : null,
    m.first ? `started: ${fmtTs(m.first.timestamp)}` : null,
    m.last ? `ended: ${fmtTs(m.last.timestamp)}` : null,
    `prompts: ${prompts}`,
    `tokens_in: ${n(totals.input)}`,
    `tokens_out: ${n(totals.output)}`,
    `cache_read: ${n(totals.cacheRead)}`,
    `cache_write: ${n(totals.cacheWrite)}`,
    cost ? `est_cost: ${formatUsd(cost.usd)}${cost.partial ? ' (partial)' : ''}` : null,
    `exported: ${fmtTs(new Date().toISOString())} by LunaCore`,
    '---',
  ];
  return rows.filter((r) => r != null).join('\n');
}

// ---- entry point ---------------------------------------------------------

/**
 * Renders a whole JSONL transcript to a Markdown document.
 * @param {string} jsonlText raw transcript file contents
 * @param {{cwd?:string, sessionId?:string, project?:string}} [meta]
 * @returns {string} Markdown, always ending in a single newline
 */
function transcriptToMarkdown(jsonlText, meta = {}) {
  const entries = parseLines(jsonlText);
  const results = indexToolResults(entries);
  const m = deriveMeta(entries, meta);

  const out = [buildFrontmatter(jsonlText, entries, meta)];
  const day = m.first ? fmtTs(m.first.timestamp).slice(0, 10) : '';
  out.push(`# Session — ${m.project || 'Claude Code'}${day ? ` — ${day}` : ''}`);

  let inSidechain = false;
  // A single agentic turn is many assistant entries (tool_use, then text, then
  // more) split only by tool_result-only user entries that classify as 'skip'.
  // Coalescing that run under one "Luna" header keeps a 10-tool turn from
  // printing 10 headers. Reset by anything that is genuinely a new speaker.
  let openAssistant = false;

  for (const e of entries) {
    const c = classifyEntry(e);
    if (c.kind === 'skip') continue;

    if (c.sidechain && !inSidechain) {
      out.push('---\n\n### ⤷ Sub-agent');
      inSidechain = true;
      openAssistant = false;
    } else if (!c.sidechain && inSidechain) {
      out.push('### ⤷ End sub-agent\n\n---');
      inSidechain = false;
      openAssistant = false;
    }

    const stamp = c.at ? ` · ${fmtTs(c.at).slice(11)}` : '';

    if (c.kind === 'prompt') {
      out.push(`## ${c.sidechain ? '↳ Sub-agent prompt' : '🧑 Mati'}${stamp}\n\n${c.text}`);
      openAssistant = false;
    } else if (c.kind === 'command') {
      out.push(`> ⚡ \`${c.command}\``);
      openAssistant = false;
    } else if (c.kind === 'error') {
      out.push(`> ⚠️ API error${c.status ? ` (${c.status})` : ''}`);
      openAssistant = false;
    } else if (c.kind === 'assistant') {
      const body = renderAssistant(c.message, results);
      if (!body) continue;
      if (openAssistant) {
        out[out.length - 1] += `\n\n${body}`;
      } else {
        out.push(`## ${c.sidechain ? '🌙 Sub-agent' : '🌙 Luna'}${stamp}\n\n${body}`);
        openAssistant = true;
      }
    }
  }
  if (inSidechain) out.push('### ⤷ End sub-agent\n\n---');

  let md = `${out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  if (Buffer.byteLength(md, 'utf8') > MAX_OUTPUT_BYTES) {
    md = `${md.slice(0, MAX_OUTPUT_BYTES)}\n\n> _Export truncated at ${Math.round(MAX_OUTPUT_BYTES / 1024)} KB._\n`;
  }
  return md;
}

module.exports = {
  transcriptToMarkdown,
  classifyEntry,
  truncateResult,
  stripInjectedNoise,
  slashCommand,
  buildFrontmatter,
  MAX_RESULT_LINES,
  MAX_RESULT_CHARS,
  MAX_OUTPUT_BYTES,
};
