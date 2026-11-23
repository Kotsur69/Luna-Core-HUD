// ============================================================================
// LunaCore - Work map activity bookkeeping (pure, no DOM)
// ----------------------------------------------------------------------------
// The per-tab history the Sessions map shows beside its counts (slice 2 of
// #agymap), kept apart from workmapmodel.js so the reducer stays small:
//
//   recent  the last MAX_RECENT calls, oldest first: tool, sanitized detail,
//           +/- lines, outcome. The map's live ticker reads it.
//   items   per station, the distinct things its calls touched - files on
//           Files, subagents on Agents, MCP servers on MCP / Network - least
//           recently touched first, capped at MAX_ITEMS_PER_STATION. The
//           map's satellites read it.
//
// This is where feed strings cross into renderer state, so every one is
// cleaned here: one line, no control / bidi / zero-width characters, capped.
// An MCP call's `input` is never kept: it is not sanitized upstream.
// Every function returns new objects and never mutates its arguments.
// ============================================================================

'use strict';

/** Calls each tab keeps for the ticker, newest last. */
export const MAX_RECENT = 48;
/** Distinct items (files, subagents, MCP servers) each station remembers; the least recent goes first. */
export const MAX_ITEMS_PER_STATION = 12;
/** Longest detail kept, in characters (main already caps a detail at 80, src/tooldetail.js). */
export const MAX_DETAIL_CHARS = 80;
/** Longest tool or MCP server name kept. */
const MAX_NAME_CHARS = 64;
/** A longer file path is not one a tool was given: it is dropped, never cut. */
const MAX_PATH_CHARS = 1024;
/** A +/- line count above this is not one. */
const MAX_LINE_COUNT = 10000000;
// Control, format (bidi overrides, zero-width) and line / paragraph separator
// characters: shown text is one line and must not reorder or hide what follows.
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const UNSAFE_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * @typedef {object} RecentCall one ticker line
 * @property {string} callId
 * @property {string} station one of STATIONS
 * @property {string} tool the tile ('Read', 'Shell', ...) or the MCP tool name
 * @property {string} detail sanitized: a command summary, pattern, agent type or MCP server
 * @property {string} file the file a file tool touched, '' otherwise
 * @property {number} added lines added (0 until the call ends)
 * @property {number} removed lines removed
 * @property {'running'|'ok'|'failed'|'dropped'} status dropped = ended with no result
 *   (turn end, tab reset, stale)
 * @property {number|null} at when it started
 */

/**
 * @typedef {object} StationItem a distinct thing a station's calls touched
 * @property {'file'|'agent'|'mcp'} kind
 * @property {string} key the file path, agent label or server name
 * @property {string} label what the satellite says (the view shortens a path)
 * @property {number} calls
 * @property {number} added
 * @property {number} removed
 * @property {number} failed
 * @property {number|null} firstAt
 * @property {number|null} lastAt last start or end, epoch ms
 */

/**
 * @typedef {object} CallInfo what a start event says about its call
 * @property {string} tool
 * @property {string} detail
 * @property {string} file
 * @property {{kind:string, key:string, label:string}|null} item
 */

// ---- Cleaning ------------------------------------------------------------------

/**
 * Feed text made safe to show on one line: control, format (bidi, zero-width)
 * and separator characters become spaces, runs of space collapse, capped.
 * @param {unknown} value
 * @param {number} [max=MAX_DETAIL_CHARS]
 * @returns {string} '' for anything that is not a non-empty string
 */
export function cleanText(value, max = MAX_DETAIL_CHARS) {
  if (typeof value !== 'string' || !value) return '';
  // Bounded before the regex runs: a huge string costs no more than a short one.
  return value.slice(0, max * 4).replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A file path as a tool gave it, or '' when it is not a plausible one (never cut or rewritten). */
function cleanPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS) return '';
  return UNSAFE_CHAR_RE.test(value) ? '' : value;
}

function lineCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_LINE_COUNT) : 0;
}

// ---- What the feeds say about a call --------------------------------------------

/**
 * A metrics:tools start: the tile (or tool name), its sanitized detail, and
 * the file or subagent it touches.
 * @param {object} ev
 * @param {string} station
 * @returns {CallInfo}
 */
export function toolCallInfo(ev, station) {
  // The tile when there is one; the Skill tool has none, so its name stands in.
  const tool = cleanText(typeof ev.name === 'string' && ev.name ? ev.name : ev.tile || ev.toolName, MAX_NAME_CHARS);
  const detail = cleanText(ev.detail);
  const file = cleanPath(ev.file);
  let item = null;
  if (file && station === 'files') item = { kind: 'file', key: file, label: file };
  else if (detail && station === 'agents') item = { kind: 'agent', key: detail, label: detail };
  return { tool, detail, file, item };
}

/**
 * A metrics:mcp start: the tool and its server. The call's `input` is never kept.
 * @param {object} ev
 * @param {string} station
 * @returns {CallInfo}
 */
export function mcpCallInfo(ev, station) {
  const server = cleanText(ev.server, MAX_NAME_CHARS);
  const tool = cleanText(ev.tool, MAX_NAME_CHARS);
  // The Memory station has its own per-tool counts; a satellite there would only repeat "lunacore".
  const item = server && station !== 'memory' ? { kind: 'mcp', key: server, label: server } : null;
  return { tool, detail: server, file: '', item };
}

/** What a metrics:tools end changed, in lines. */
export function toolCallLines(ev) {
  return { added: lineCount(ev.added), removed: lineCount(ev.removed) };
}

/** An MCP end changes no lines that the feed knows of. */
export const noCallLines = () => ({ added: 0, removed: 0 });

// ---- recent and items --------------------------------------------------------------

/** The newest `max` entries of a list kept oldest first. */
function capTail(list, max) {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * A started call's ticker line, appended (the oldest beyond MAX_RECENT goes).
 * @param {RecentCall[]} recent
 * @param {string} callId
 * @param {string} station
 * @param {CallInfo} info
 * @param {number|null} at
 * @returns {RecentCall[]}
 */
export function addRecent(recent, callId, station, info, at) {
  const entry = { callId, station, tool: info.tool, detail: info.detail, file: info.file, added: 0, removed: 0, status: 'running', at };
  return capTail([...recent, entry], MAX_RECENT);
}

/**
 * The ticker line of a call gets its outcome; one that scrolled out is left alone.
 * @param {RecentCall[]} recent
 * @param {string} callId
 * @param {'ok'|'failed'|'dropped'} status
 * @param {{added:number, removed:number}} lines
 * @param {string|null} [station] moves the line to this station (a hook refusal belongs to Hooks, not to the refused tool's)
 * @returns {RecentCall[]}
 */
export function settleRecent(recent, callId, status, lines, station = null) {
  const i = recent.findLastIndex((e) => e.callId === callId);
  if (i < 0) return recent;
  const next = recent.slice();
  next[i] = { ...recent[i], status, added: lines.added, removed: lines.removed, ...(station ? { station } : {}) };
  return next;
}

/** Every ticker line still running ends with no result (a turn end, a tab reset). */
export function dropRunning(recent) {
  return recent.some((e) => e.status === 'running') ? recent.map((e) => (e.status === 'running' ? { ...e, status: 'dropped' } : e)) : recent;
}

/**
 * One more call touching an item: it becomes the station's most recent one.
 * @param {Record<string, StationItem[]>} items
 * @param {string} station
 * @param {{kind:string, key:string, label:string}} spec
 * @param {number|null} at
 * @returns {Record<string, StationItem[]>}
 */
export function touchItem(items, station, spec, at) {
  const list = items[station] || [];
  const old = list.find((it) => it.key === spec.key) || null;
  const item = old
    ? { ...old, calls: old.calls + 1, lastAt: at }
    : { kind: spec.kind, key: spec.key, label: spec.label, calls: 1, added: 0, removed: 0, failed: 0, firstAt: at, lastAt: at };
  const rest = old ? list.filter((it) => it !== old) : list;
  return { ...items, [station]: capTail([...rest, item], MAX_ITEMS_PER_STATION) };
}

/**
 * A call on an item ended: its lines and failure are added, and it was
 * touched again (a long subagent stays fresh until it ends).
 * @param {Record<string, StationItem[]>} items
 * @param {string} station
 * @param {string} key
 * @param {{added:number, removed:number}} lines
 * @param {boolean} failed
 * @param {number|null} at
 * @returns {Record<string, StationItem[]>}
 */
export function endItem(items, station, key, lines, failed, at) {
  const list = items[station];
  const i = Array.isArray(list) ? list.findIndex((it) => it.key === key) : -1;
  if (i < 0) return items; // pushed out by newer items while the call ran
  const old = list[i];
  const lastAt = Number.isFinite(at) && !(old.lastAt > at) ? at : old.lastAt;
  const item = { ...old, added: old.added + lines.added, removed: old.removed + lines.removed, failed: old.failed + (failed ? 1 : 0), lastAt };
  const next = list.slice();
  next[i] = item;
  return { ...items, [station]: next };
}
