// ============================================================================
// LunaCore - Work map model (pure, no DOM)
// ----------------------------------------------------------------------------
// First slice of the live work map (docs/untouched_docs/rag-stylememory.md,
// "Bonus ... a live work map in LunaCore"). This module only folds the feeds
// the renderer already receives through src/preload.js into a per-tab picture
// of "what is this session doing right now". A later package draws the SVG on
// top of it; nothing here touches the DOM, starts a timer or calls IPC.
//
// Feeds consumed (all already sent by main.js; sessions.js is the other
// subscriber):
//   metrics:tools   { sessionId, events: [{phase, id, tile, at, ...}] }
//                   (a legacy `tiles` blink from the stdout scan is ignored:
//                   it has no end signal and would double-count)
//   metrics:mcp     { sessionId, events: [{phase, id, server, tool, at, ok?, content?}] }
//   metrics:context { sessionId, metrics: {tokens, limit, percent, model?, modelLabel?} }
//   metrics:turnend { sessionId, turn: {startedAt, endedAt, text} }
// plus three renderer-side events the view dispatches itself:
//   tab:active { sessionId }   the tab being looked at changed
//   tab:closed { sessionId }   forget that tab
//   tab:reset  { sessionId }   the session restarted; drop what was in flight
//
// Reducer contract: applyEvent(state, event) never mutates `state`. It returns
// a NEW state object when anything changed and the SAME reference when the
// event was ignored, so a subscriber can skip a repaint with `===`. Malformed
// input of any shape is ignored, never thrown on.
//
// What the feeds cannot tell us (recorded so the view does not pretend):
//   - The Skill tool has no Skill Tracker tile, so observer.js drops it before
//     it reaches metrics:tools. The Skills station is mapped (by tool name) but
//     stays dark until the observer forwards that name.
//   - A built-in tool's end event carries no error flag, so only MCP calls can
//     be marked failed today. `ok === false` / `isError === true` on a tool end
//     event is honoured for when the observer starts sending it.
//   - Hook refusals (PreToolUse deny) are not visible either, for the same
//     reason; there is no Hooks station. See the doc section named above.
// ============================================================================

'use strict';

/** Station ids, in the order the map lays them out around the model. */
export const STATIONS = Object.freeze(['files', 'shell', 'network', 'memory', 'agents', 'skills', 'mcp', 'other']);

/** Upper bound on tracked in-flight calls per tab; a runaway feed cannot grow state without limit. */
export const MAX_PULSES = 64;
/** How many recently finished call ids each tab remembers, so a re-delivered start cannot re-open a call. */
export const MAX_ENDED_IDS = 256;
/** Longest an error message is kept, in characters. */
export const MAX_ERROR_CHARS = 200;
/** Suggested watchdog for pruneStale(): a call with no end is dropped after this long. */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

const TOOL_NAME_TO_STATION = new Map([
  ['Read', 'files'],
  ['Edit', 'files'],
  ['MultiEdit', 'files'],
  ['Write', 'files'],
  ['Glob', 'files'],
  ['Grep', 'files'],
  ['NotebookEdit', 'files'],
  ['Bash', 'shell'],
  ['BashOutput', 'shell'],
  ['KillShell', 'shell'],
  ['PowerShell', 'shell'],
  ['WebFetch', 'network'],
  ['WebSearch', 'network'],
  ['Agent', 'agents'],
  ['Task', 'agents'],
  ['Skill', 'skills'],
]);

// Skill Tracker tile labels, as observer.js's TOOL_TILES sends them on
// metrics:tools (the event carries the tile, not the tool name).
const TILE_TO_STATION = new Map([
  ['Read', 'files'],
  ['Edit', 'files'],
  ['Write', 'files'],
  ['Grep', 'files'],
  ['Glob', 'files'],
  ['Shell', 'shell'],
  ['Web', 'network'],
  ['Task', 'agents'],
]);

// MCP server-name tokens that mean "this server talks to the network". The
// feed does not say which transport a server uses, so this is a name
// heuristic over tokens split on - _ . and spaces.
const NETWORK_MCP_TOKENS = new Set([
  'fetch', 'http', 'https', 'web', 'webfetch', 'websearch', 'browser', 'brave', 'exa',
  'tavily', 'firecrawl', 'playwright', 'puppeteer', 'devtools', 'perplexity',
]);

// Same non-greedy split as observer.js's MCP_NAME_RE.
const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;
const MEMORY_SERVER = 'lunacore';
const MEMORY_TOOL_PREFIX = 'memory_';
/** The Luna Core Memory tools counted one by one on the Memory station, by MCP tool name. */
const MEMORY_CALL_OF_TOOL = new Map([
  ['memory_search', 'search'],
  ['memory_get', 'get'],
  ['memory_verify', 'verify'],
  ['memory_propose', 'propose'],
]);
/** The keys of TabState.memoryCalls, in display order. */
export const MEMORY_CALLS = Object.freeze(['search', 'get', 'verify', 'propose']);

// ---- Station mapping -------------------------------------------------------

/**
 * Station for an MCP call, from its server and tool names.
 * @param {unknown} server e.g. 'lunacore'
 * @param {unknown} tool e.g. 'memory_search'
 * @returns {string} one of STATIONS ('other' when the server name is missing)
 */
export function stationForMcp(server, tool) {
  const srv = typeof server === 'string' ? server : '';
  const name = typeof tool === 'string' ? tool : '';
  if (!srv) return 'other';
  if (srv === MEMORY_SERVER && name.startsWith(MEMORY_TOOL_PREFIX)) return 'memory';
  const tokens = srv.toLowerCase().split(/[-_.\s]+/);
  if (tokens.some((tok) => NETWORK_MCP_TOKENS.has(tok))) return 'network';
  return 'mcp';
}

/**
 * Station for a tool by its Claude Code name ('Read', 'Bash', 'mcp__srv__tool', ...).
 * Unknown or non-string names map to 'other'.
 * @param {unknown} name
 * @returns {string} one of STATIONS
 */
export function stationForTool(name) {
  if (typeof name !== 'string' || !name) return 'other';
  const known = TOOL_NAME_TO_STATION.get(name);
  if (known) return known;
  const m = MCP_NAME_RE.exec(name);
  if (m) return stationForMcp(m[1], m[2]);
  return 'other';
}

/**
 * Which Luna Core Memory tool an MCP call is ('search', 'get', 'verify',
 * 'propose'), or null for any other call.
 * @param {unknown} server
 * @param {unknown} tool
 * @returns {string|null} one of MEMORY_CALLS, or null
 */
export function memoryCallOf(server, tool) {
  if (server !== MEMORY_SERVER || typeof tool !== 'string') return null;
  return MEMORY_CALL_OF_TOOL.get(tool) || null;
}

/**
 * Station for a Skill Tracker tile label ('Shell', 'Web', ...), the field a
 * metrics:tools event actually carries. Unknown tiles map to 'other'.
 * @param {unknown} tile
 * @returns {string} one of STATIONS
 */
export function stationForTile(tile) {
  if (typeof tile !== 'string') return 'other';
  return TILE_TO_STATION.get(tile) || 'other';
}

// ---- State shapes ----------------------------------------------------------

/**
 * @typedef {object} StationState
 * @property {number} inFlight calls started and not yet ended
 * @property {number} total calls ever started on this station (this tab)
 * @property {number} errors calls that ended with an error
 * @property {{callId:string, at:number|null, message:string}|null} lastError
 */

/**
 * @typedef {object} Pulse
 * @property {string} callId the tool_use id
 * @property {string} station one of STATIONS
 * @property {number|null} startedAt epoch ms from the transcript, else the event's `now`
 */

/**
 * @typedef {object} TabState
 * @property {Record<string, StationState>} stations keyed by every id in STATIONS
 * @property {Pulse[]} pulses calls in flight, oldest first
 * @property {number|null} contextPercent 0..100, null until a context sample arrives
 * @property {number|null} contextTokens
 * @property {number|null} contextLimit
 * @property {string} model raw model id, '' if unknown
 * @property {string} modelLabel display label, '' if unknown
 * @property {number} turns completed turns seen
 * @property {number|null} lastTurnEndedAt
 * @property {{search:number, get:number, verify:number, propose:number}} memoryCalls
 *   Luna Core Memory tool calls started in this tab, one count per tool (MEMORY_CALLS)
 * @property {string[]} endedIds internal: recently finished call ids, oldest
 *   first, capped at MAX_ENDED_IDS. A view should not need it.
 */

/**
 * @typedef {object} WorkMapState
 * @property {string|null} activeTab session id of the tab being looked at
 * @property {Map<string, TabState>} tabs per-tab state, keyed by session id
 */

/**
 * @typedef {object} WorkMapEvent
 * @property {'metrics:tools'|'metrics:mcp'|'metrics:context'|'metrics:turnend'|'tab:active'|'tab:closed'|'tab:reset'} channel
 * @property {object} payload the IPC payload as preload.js delivers it (always carries `sessionId`)
 * @property {number} [now] epoch ms, used as a start time when an event has no `at`
 */

function emptyStation() {
  return { inFlight: 0, total: 0, errors: 0, lastError: null };
}

/** @returns {TabState} a fresh, idle tab */
export function createTabState() {
  const stations = {};
  for (const id of STATIONS) stations[id] = emptyStation();
  return {
    stations,
    pulses: [],
    contextPercent: null,
    contextTokens: null,
    contextLimit: null,
    model: '',
    modelLabel: '',
    turns: 0,
    lastTurnEndedAt: null,
    memoryCalls: { search: 0, get: 0, verify: 0, propose: 0 },
    endedIds: [],
  };
}

/** @returns {WorkMapState} the initial state: no tabs, none active */
export function createState() {
  return { activeTab: null, tabs: new Map() };
}

/**
 * The tab being looked at, or null when none is active or it has no data yet.
 * @param {WorkMapState} state
 * @returns {TabState|null}
 */
export function activeTabState(state) {
  if (!isState(state) || state.activeTab === null) return null;
  return state.tabs.get(state.activeTab) || null;
}

// ---- Helpers ---------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isState(v) {
  return isObject(v) && v.tabs instanceof Map;
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Session ids are strings in main.js; a finite number is accepted and stringified. */
function sessionKey(payload) {
  if (!isObject(payload)) return null;
  const id = payload.sessionId;
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

/** Short readable text out of an MCP result's `content` (string or [{type:'text', text}]). */
function errorText(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((part) => isObject(part) && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return text.trim().slice(0, MAX_ERROR_CHARS);
}

function withTab(state, key, tab) {
  const tabs = new Map(state.tabs);
  tabs.set(key, tab);
  return { ...state, tabs };
}

function withStation(tab, id, patch) {
  return { ...tab, stations: { ...tab.stations, [id]: { ...tab.stations[id], ...patch } } };
}

// ---- Call lifecycle (shared by metrics:tools and metrics:mcp) ---------------

/** Remembers finished ids (bounded), so a re-delivered start is recognised. */
function withEnded(endedIds, ids) {
  const merged = [...endedIds, ...ids];
  return merged.length > MAX_ENDED_IDS ? merged.slice(merged.length - MAX_ENDED_IDS) : merged;
}

function startCall(tab, callId, station, startedAt) {
  // A re-read of the same line: either still in flight, or already finished
  // (a re-scan after a watcher restart can deliver the start again).
  if (tab.pulses.some((p) => p.callId === callId)) return tab;
  if (tab.endedIds.includes(callId)) return tab;
  if (tab.pulses.length >= MAX_PULSES) return tab;
  const st = tab.stations[station];
  const next = withStation(tab, station, { inFlight: st.inFlight + 1, total: st.total + 1 });
  return { ...next, pulses: [...tab.pulses, { callId, station, startedAt }] };
}

function endCall(tab, callId, failure) {
  const pulse = tab.pulses.find((p) => p.callId === callId);
  if (!pulse) return tab; // orphan: started before we attached, or never mapped
  const st = tab.stations[pulse.station];
  const patch = { inFlight: Math.max(0, st.inFlight - 1) };
  if (failure) {
    patch.errors = st.errors + 1;
    patch.lastError = { callId, at: failure.at, message: failure.message };
  }
  const next = withStation(tab, pulse.station, patch);
  return {
    ...next,
    pulses: tab.pulses.filter((p) => p !== pulse),
    endedIds: withEnded(tab.endedIds, [callId]),
  };
}

/** One more call of a memory tool; `kind` null leaves the tab as it is. */
function countMemoryCall(tab, kind) {
  if (!kind) return tab;
  return { ...tab, memoryCalls: { ...tab.memoryCalls, [kind]: tab.memoryCalls[kind] + 1 } };
}

/**
 * Folds a list of lifecycle events into one tab.
 * @param {TabState} tab
 * @param {unknown[]} events
 * @param {(ev: object) => string} stationOf
 * @param {(ev: object) => ({message:string}|null)} failureOf
 * @param {number|null} now
 * @param {(ev: object) => (string|null)} memoryKindOf which memory tool a start is, if any
 * @returns {TabState}
 */
function foldCalls(tab, events, stationOf, failureOf, now, memoryKindOf) {
  let next = tab;
  for (const ev of events) {
    if (!isObject(ev) || typeof ev.id !== 'string' || !ev.id) continue;
    const at = finiteOrNull(ev.at);
    if (ev.phase === 'start') {
      const started = startCall(next, ev.id, stationOf(ev), at !== null ? at : now);
      // Counted only when the start was new: a re-delivered one changes nothing.
      next = started === next ? next : countMemoryCall(started, memoryKindOf(ev));
    } else if (ev.phase === 'end') {
      const failure = failureOf(ev);
      next = endCall(next, ev.id, failure ? { at, message: failure.message } : null);
    }
  }
  return next;
}

function toolStation(ev) {
  // A future observer may send the real tool name; it is more precise than the tile.
  if (typeof ev.name === 'string' && ev.name) return stationForTool(ev.name);
  return stationForTile(ev.tile);
}

function toolFailure(ev) {
  if (ev.ok === false || ev.isError === true) {
    return { message: typeof ev.error === 'string' ? ev.error.slice(0, MAX_ERROR_CHARS) : '' };
  }
  return null;
}

function mcpStation(ev) {
  return stationForMcp(ev.server, ev.tool);
}

function mcpFailure(ev) {
  return ev.ok === false ? { message: errorText(ev.content) } : null;
}

function mcpMemoryKind(ev) {
  return memoryCallOf(ev.server, ev.tool);
}

/** Memory tools are MCP calls: metrics:tools never carries one, so it never counts one. */
const noMemoryKind = () => null;

// ---- Per-channel reducers ----------------------------------------------------

function reduceCalls(tab, payload, stationOf, failureOf, now, memoryKindOf) {
  if (!Array.isArray(payload.events) || payload.events.length === 0) return tab;
  return foldCalls(tab, payload.events, stationOf, failureOf, now, memoryKindOf);
}

function reduceContext(tab, payload) {
  const m = payload.metrics;
  if (!isObject(m)) return tab;
  // Each field is taken only when the sample carries a valid value; anything
  // missing keeps the last known one. A sample with nothing usable is ignored.
  const patch = {};
  const percent = finiteOrNull(m.percent);
  if (percent !== null) patch.contextPercent = Math.min(100, Math.max(0, percent));
  const tokens = finiteOrNull(m.tokens);
  if (tokens !== null) patch.contextTokens = tokens;
  const limit = finiteOrNull(m.limit);
  if (limit !== null) patch.contextLimit = limit;
  if (typeof m.model === 'string' && m.model) patch.model = m.model;
  if (typeof m.modelLabel === 'string' && m.modelLabel) patch.modelLabel = m.modelLabel;
  return Object.keys(patch).length === 0 ? tab : { ...tab, ...patch };
}

/** In-flight counts drop to zero; totals and errors are history and stay. */
function settleAll(tab) {
  if (tab.pulses.length === 0) return tab;
  const stations = {};
  for (const id of STATIONS) stations[id] = { ...tab.stations[id], inFlight: 0 };
  // Cleared ids count as finished: a late re-delivered start must not re-open them.
  const endedIds = withEnded(tab.endedIds, tab.pulses.map((p) => p.callId));
  return { ...tab, stations, pulses: [], endedIds };
}

function reduceTurnEnd(tab, payload) {
  const turn = payload.turn;
  if (!isObject(turn)) return tab;
  // A finished turn means nothing is still running; this also clears a call
  // whose result never arrived (an interrupted tool).
  const settled = settleAll(tab);
  return { ...settled, turns: tab.turns + 1, lastTurnEndedAt: finiteOrNull(turn.endedAt) };
}

const TAB_REDUCERS = new Map([
  ['metrics:tools', (tab, payload, now) => reduceCalls(tab, payload, toolStation, toolFailure, now, noMemoryKind)],
  ['metrics:mcp', (tab, payload, now) => reduceCalls(tab, payload, mcpStation, mcpFailure, now, mcpMemoryKind)],
  ['metrics:context', (tab, payload) => reduceContext(tab, payload)],
  ['metrics:turnend', (tab, payload) => reduceTurnEnd(tab, payload)],
  ['tab:reset', (tab) => settleAll(tab)],
]);

function closeTab(state, key) {
  if (!state.tabs.has(key) && state.activeTab !== key) return state;
  const tabs = new Map(state.tabs);
  tabs.delete(key);
  return { ...state, tabs, activeTab: state.activeTab === key ? null : state.activeTab };
}

/**
 * Folds one feed event into the state.
 *
 * Never mutates `state`; returns a new state when something changed and the
 * same reference when the event was ignored (unknown channel, missing
 * sessionId, malformed payload, orphan end, duplicate start). Never throws on
 * malformed input.
 *
 * @param {WorkMapState} state
 * @param {WorkMapEvent} event
 * @returns {WorkMapState}
 */
export function applyEvent(state, event) {
  if (!isState(state)) return state;
  if (!isObject(event) || typeof event.channel !== 'string') return state;
  const key = sessionKey(event.payload);
  if (key === null) return state;

  if (event.channel === 'tab:active') {
    return state.activeTab === key ? state : { ...state, activeTab: key };
  }
  if (event.channel === 'tab:closed') return closeTab(state, key);

  const reducer = TAB_REDUCERS.get(event.channel);
  if (!reducer) return state;
  const tab = state.tabs.get(key) || createTabState();
  const next = reducer(tab, event.payload, finiteOrNull(event.now));
  // Nothing changed - also covers a malformed event for a tab we never saw,
  // which must not create an empty tab.
  if (next === tab) return state;
  return withTab(state, key, next);
}

/**
 * Drops calls in flight longer than `maxAgeMs` in every tab: a killed session
 * leaves a tool_use with no result. Pure; the caller decides when to run it
 * (e.g. on its own repaint), this module keeps no timer. A call with no known
 * start time (`startedAt: null`) cannot be aged and is left for the next turn
 * end; subscribe() always stamps `now`, so that only happens to a caller that
 * uses applyEvent() directly without `now`.
 * @param {WorkMapState} state
 * @param {number} now epoch ms
 * @param {number} [maxAgeMs=DEFAULT_STALE_MS]
 * @returns {WorkMapState} same reference when nothing was stale
 */
export function pruneStale(state, now, maxAgeMs = DEFAULT_STALE_MS) {
  if (!isState(state) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs)) return state;
  let tabs = null;
  for (const [key, tab] of state.tabs) {
    const stale = tab.pulses.filter((p) => p.startedAt !== null && now - p.startedAt > maxAgeMs);
    if (stale.length === 0) continue;
    let next = tab;
    for (const p of stale) next = endCall(next, p.callId, null);
    if (!tabs) tabs = new Map(state.tabs);
    tabs.set(key, next);
  }
  return tabs ? { ...state, tabs } : state;
}

// ---- Optional wiring -------------------------------------------------------

const BRIDGE_CHANNELS = [
  ['onTools', 'metrics:tools'],
  ['onMcp', 'metrics:mcp'],
  ['onContext', 'metrics:context'],
  ['onTurnEnd', 'metrics:turnend'],
];

/**
 * Wires the model to the preload bridge (`window.lunacore`): the same four
 * listeners sessions.js registers. preload.js offers no way to remove an
 * ipcRenderer listener, so `stop()` turns this subscription's listeners into
 * no-ops instead. Subscribe once per app, not once per widget mount.
 *
 * The bridge carries only the four metrics:* feeds. tab:closed and tab:reset
 * have no IPC of their own: the view dispatches them (a tab that is never
 * closed is kept). A metrics event arriving after tab:closed starts that tab
 * afresh, which is what a reused session id should do.
 *
 * @param {object} bridge object with onTools/onMcp/onContext/onTurnEnd(cb)
 * @param {(state: WorkMapState) => void} onChange called after each change
 * @param {{getActiveSessionId?: () => (string|null), now?: () => number}} [opts]
 *   getActiveSessionId: read before every event so `activeTab` follows tab
 *   switches without a separate feed. now: clock for events without `at`.
 * @returns {{getState: () => WorkMapState, dispatch: (event: WorkMapEvent) => void,
 *   prune: (maxAgeMs?: number) => void, stop: () => void}}
 *   The state handed out is read-only by contract: states share unchanged
 *   sub-objects, so mutating one corrupts earlier and later states.
 */
export function subscribe(bridge, onChange, opts = {}) {
  const getActive = typeof opts.getActiveSessionId === 'function' ? opts.getActiveSessionId : null;
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  let state = createState();
  let stopped = false;

  const dispatch = (event) => {
    if (stopped) return;
    let next = state;
    if (getActive) {
      const active = getActive();
      if (typeof active === 'string' && active) {
        next = applyEvent(next, { channel: 'tab:active', payload: { sessionId: active } });
      }
    }
    const stamped = isObject(event) && event.now === undefined ? { ...event, now: clock() } : event;
    next = applyEvent(next, stamped);
    if (next === state) return;
    state = next;
    if (typeof onChange === 'function') onChange(state);
  };

  if (isObject(bridge)) {
    for (const [method, channel] of BRIDGE_CHANNELS) {
      if (typeof bridge[method] === 'function') bridge[method]((payload) => dispatch({ channel, payload }));
    }
  }

  /** Runs pruneStale() on this subscription's state; the view calls it on its own repaint. */
  const prune = (maxAgeMs = DEFAULT_STALE_MS) => {
    if (stopped) return;
    const next = pruneStale(state, clock(), maxAgeMs);
    if (next === state) return;
    state = next;
    if (typeof onChange === 'function') onChange(state);
  };

  return {
    getState: () => state,
    dispatch,
    prune,
    stop: () => {
      stopped = true;
    },
  };
}
