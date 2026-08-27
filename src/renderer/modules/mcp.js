// ============================================================================
// LunaCore - MCP server health panel
// ----------------------------------------------------------------------------
// Rows for every configured MCP server, sorted by how neglected it is, with a
// per-server "test" button that runs a real handshake (src/mcphealth.js).
//
// The scan is LAZY and manual. It streams every session transcript on this
// machine, which takes about a second - cheap enough to ask for, far too much
// to put on a timer for a number that changes maybe once a day. So the first
// mount loads it once, the refresh button reloads it, and nothing else does.
//
// A2: the loaded rows and the probe results live at module scope, so a remount
// (layout switch, panel fold) repaints instantly instead of re-scanning. `els`
// belongs to the mount and is null while unmounted, same rule as ports.js.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange, onSessionRestarted, registerSessionView } from './bus.js';
import { defineWidget } from './registry.js';
import { closeWithExit, cancelExit } from './motion.js';

// null = never scanned, so the static "scanning..." hint stays put.
let rows = null;
let scanning = false;

// name -> { state: 'running'|'done', ok, reason, tools, ms }
const probes = new Map();

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// CONCEPT_MCP_DEBUGGER.md, safe half: live flow + JSON-RPC inspector.
//
// PASSIVE OBSERVER, same as the health scan above it: rides the transcript's
// tool_use/tool_result lifecycle (observer.js's mcpEventsFromLines()/
// foldMcpEvents(), the MCP-specific sibling of the Skill Tracker's B8
// machinery) instead of intercepting live stdio traffic. That's the
// architecture tradeoff the concept doc's other two pieces (failure
// injection, restart) needed and this deliberately does not attempt: no
// process interception, no ~/.claude.json rewrite - see the "safe half"
// scope decision, 2026-08-26.
//
// Active tab only: only the focused tab's events render live; a background
// tab's events are folded onto its own bucket (registerSessionView below,
// same split activefiles.js/sessiontimeline.js already use) so switching
// back to it shows what happened there, without ever mixing two tabs'
// calls into one view.
// ============================================================================

/** Oldest calls dropped past this - a long session should not grow this list
 *  or the payload memory it carries without bound. */
const MAX_CALLS = 30;

/** Honest truncation (sessiontimeline.js's rule, applied to a request/result
 *  payload instead of turn text): ~2KB per call, per Mati's call (2026-08-26)
 *  - big enough to read a real payload, small enough that one huge Read
 *    result flowing through an MCP tool cannot bloat the inspector or freeze
 *    a render. */
const MAX_PAYLOAD_CHARS = 2000;

/**
 * Caps text at maxChars, flagging whether anything was cut. Pure, mirrors
 * sessiontimeline.js's truncateText().
 * @param {string} text
 * @param {number} maxChars
 * @returns {{text:string, truncated:boolean}}
 */
function truncateAt(text, maxChars) {
  const str = typeof text === 'string' ? text : '';
  if (str.length <= maxChars) return { text: str, truncated: false };
  return { text: str.slice(0, maxChars), truncated: true };
}

/**
 * Formats an MCP call's input/output for the inspector: pretty-printed JSON
 * when possible, capped and flagged when too long. Pure and exported so the
 * formatting is unit-testable without a DOM.
 *
 * Tool results often arrive as a JSON-stringified STRING (the CLI's own
 * transport shape - verified against a real transcript line, 2026-08-26),
 * not a parsed object - reparsing before pretty-printing is what turns that
 * into something readable instead of one long escaped line. A value that
 * is not JSON at all (plain text, or already an object) still formats fine
 * via the fallback paths below.
 * @param {*} value
 * @param {number} [maxChars]
 * @returns {{text:string, truncated:boolean}}
 */
export function formatPayload(value, maxChars = MAX_PAYLOAD_CHARS) {
  let text;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else if (value === undefined) {
    text = '';
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return truncateAt(text, maxChars);
}

/** Fresh per-tab MCP state: `live` tracks in-flight calls (id -> server, for
 *  the flow pulse), `calls` is the completed-call history (newest first). */
export function createMcpState() {
  return { live: new Map(), calls: [] };
}

/**
 * Folds one mcpEventsFromLines()/foldMcpEvents() event into MCP state. Pure
 * and exported for the same reason activefiles.js's applyFileEvent is -
 * unit-testable without mocking window.lunacore or the DOM.
 *
 * A `start` only marks the call live - nothing is added to history until the
 * matching `end`, which already carries server/tool/input (observer.js's
 * foldMcpEvents() resolved that pairing in the main process), so this needs
 * no id->info map of its own beyond `live`.
 * @param {object} state mutated in place (see createMcpState)
 * @param {object} ev one event from onMcp's payload
 * @param {number} [maxChars] overridable for tests
 * @param {number} [maxCalls] overridable for tests
 * @returns {object} the same state, for chaining
 */
export function applyMcpEvent(state, ev, maxChars = MAX_PAYLOAD_CHARS, maxCalls = MAX_CALLS) {
  if (!ev || !state) return state;
  if (ev.phase === 'start') {
    state.live.set(ev.id, ev.server);
    return state;
  }
  state.live.delete(ev.id);
  const input = formatPayload(ev.input, maxChars);
  const output = formatPayload(ev.content, maxChars);
  state.calls.unshift({
    id: ev.id,
    server: ev.server || '',
    tool: ev.tool || '',
    at: ev.at || Date.now(),
    ms: typeof ev.ms === 'number' ? ev.ms : null,
    ok: ev.ok !== false,
    input: input.text,
    inputTruncated: input.truncated,
    output: output.text,
    outputTruncated: output.truncated,
  });
  if (state.calls.length > maxCalls) state.calls.length = maxCalls;
  return state;
}

/** The set of server names with at least one call currently in flight. Pure,
 *  recomputed per render rather than kept as a running count - `live` is
 *  small (concurrent MCP calls are rare) so a scan costs nothing. */
export function liveServers(state) {
  return new Set(state.live.values());
}

/** This tab's MCP state. App state, not view state - survives unmount/remount
 *  and tab backgrounding, same placement rule as mcphealth's `rows` above. */
let mcpState = createMcpState();

/** Modal elements - top-level markup (like sessiontimeline's), not part of
 *  this widget's own template, so the inspector can escape a narrow rail. */
let callModal = null;
let callModalOpen = false;

function formatTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return '';
  }
}

/** "never" or a rounded day count - the panel never needs more precision. */
function idleLabel(server) {
  if (!server.lastUsed) return t('mcp.never');
  const days = Math.floor((Date.now() - server.lastUsed) / DAY_MS);
  return days <= 0 ? t('mcp.today') : t('mcp.daysAgo', { n: days });
}

/** One-line verdict for a finished probe. */
function probeLabel(p) {
  if (!p) return '';
  if (p.state === 'running') return t('mcp.probe.running');
  if (p.reason === 'remote') return t('mcp.probe.remote');
  if (!p.ok) return t('mcp.probe.fail', { reason: p.reason || '?' });
  const tools = p.tools === null ? '?' : p.tools;
  return t('mcp.probe.ok', { tools, ms: p.ms });
}

function makeRow(s, live) {
  const li = document.createElement('li');
  li.className = `mcp-item mcp-item--${s.status}`;
  if (!s.enabled) li.classList.add('mcp-item--off');
  // Live Connection Flow Mapping (CONCEPT_MCP_DEBUGGER.md §2.1): a call to
  // this server is in flight right now.
  if (live.has(s.name)) li.classList.add('mcp-item--live');

  const head = document.createElement('span');
  head.className = 'mcp-item__head';

  const dot = document.createElement('span');
  dot.className = 'mcp-item__dot';
  dot.title = t(`mcp.status.${s.status}`);

  const name = document.createElement('span');
  name.className = 'mcp-item__name';
  name.textContent = s.name;

  const scope = document.createElement('span');
  scope.className = 'mcp-item__scope';
  scope.textContent = t(`mcp.scope.${s.scope}`);
  if (s.scopeLabel) scope.title = s.scopeLabel;

  head.append(dot, name, scope);

  // Only stdio servers can be handshaken from here; the rest say so rather
  // than offering a button that would report something it did not measure.
  if (s.transport === 'stdio' && s.command) {
    const test = document.createElement('button');
    test.className = 'mcp-test';
    test.textContent = '⟳';
    test.title = t('mcp.probe.title');
    test.dataset.probe = s.name;
    head.appendChild(test);
  }

  const meta = document.createElement('span');
  meta.className = 'mcp-item__meta';
  const calls = s.calls ? t('mcp.calls', { n: s.calls }) : t('mcp.noCalls');
  meta.textContent = `${idleLabel(s)} · ${calls}`;
  if (!s.enabled) meta.textContent += ` · ${t('mcp.disabled')}`;

  li.append(head, meta);

  const p = probes.get(s.name);
  if (p) {
    const verdict = document.createElement('span');
    verdict.className = p.ok ? 'mcp-item__probe is-ok' : 'mcp-item__probe is-bad';
    verdict.textContent = probeLabel(p);
    li.appendChild(verdict);
  }
  return li;
}

function render() {
  if (!els) return;

  const live = liveServers(mcpState);

  if (!rows) {
    els.empty.textContent = scanning ? t('mcp.scanning') : t('mcp.idle');
    els.empty.style.display = '';
    els.list.innerHTML = '';
    els.summary.textContent = '';
  } else {
    els.list.innerHTML = '';
    for (const s of rows) els.list.appendChild(makeRow(s, live));

    // The summary is the whole reason to open this panel: how much of the
    // context window is being spent on servers nothing has called.
    const dead = rows.filter((s) => s.status === 'never' || s.status === 'stale').length;
    els.summary.textContent = rows.length
      ? t('mcp.summary', { total: rows.length, dead })
      : '';
    els.empty.textContent = rows.length ? '' : t('mcp.empty');
    els.empty.style.display = rows.length ? 'none' : '';
  }

  renderCalls();
}

/** One row in the "recent calls" inspector list - a compact line, the full
 *  payload only appears in the modal (sessiontimeline's marker/modal split,
 *  applied to a list instead of a horizontal strip - a narrow rail cannot
 *  fit the JSON-RPC Inspector's payload inline either). */
function buildCallRow(call, idx) {
  const li = document.createElement('li');
  li.className = call.ok ? 'mcpcall-item' : 'mcpcall-item is-bad';

  const head = document.createElement('span');
  head.className = 'mcpcall-item__head';

  const name = document.createElement('span');
  name.className = 'mcpcall-item__name';
  name.textContent = `${call.server} · ${call.tool}`;
  head.appendChild(name);

  const badge = document.createElement('span');
  badge.className = call.ok ? 'mcpcall-item__badge is-ok' : 'mcpcall-item__badge is-bad';
  badge.textContent = call.ok ? t('mcp.call.ok') : t('mcp.call.fail');
  head.appendChild(badge);

  li.appendChild(head);

  const meta = document.createElement('span');
  meta.className = 'mcpcall-item__meta';
  const ms = call.ms != null ? t('mcp.call.ms', { ms: call.ms }) : '';
  meta.textContent = [formatTime(call.at), ms].filter(Boolean).join(' · ');
  li.appendChild(meta);

  li.addEventListener('click', () => openCallModal(idx));
  return li;
}

function renderCalls() {
  if (!els || !els.callsList) return;

  els.callsList.innerHTML = '';
  if (!mcpState.calls.length) {
    els.callsEmpty.style.display = '';
    return;
  }
  els.callsEmpty.style.display = 'none';
  mcpState.calls.forEach((call, idx) => els.callsList.appendChild(buildCallRow(call, idx)));
}

function openCallModal(idx) {
  const call = mcpState.calls[idx];
  if (!call || !callModal) return;
  callModal.title.textContent = `${call.server} · ${call.tool}`;
  callModal.badge.textContent = call.ok ? t('mcp.call.ok') : t('mcp.call.fail');
  callModal.badge.className = call.ok ? 'mcpcall-modal__badge is-ok' : 'mcpcall-modal__badge is-bad';
  callModal.time.textContent = [formatTime(call.at), call.ms != null ? t('mcp.call.ms', { ms: call.ms }) : '']
    .filter(Boolean)
    .join(' · ');
  callModal.input.textContent = call.input;
  callModal.inputTruncated.hidden = !call.inputTruncated;
  callModal.output.textContent = call.output;
  callModal.outputTruncated.hidden = !call.outputTruncated;
  cancelExit(callModal.el);
  callModal.el.hidden = false;
  callModalOpen = true;
}

function closeCallModal() {
  if (!callModalOpen || !callModal) return;
  callModalOpen = false;
  closeWithExit(callModal.el);
}

/** Looked up once - the modal markup is static top-level HTML, not part of
 *  this widget's own template (sessiontimeline.js's ensureModal() rule). */
function ensureCallModal() {
  if (callModal) return;
  const el = document.getElementById('mcpcall-modal');
  if (!el) return;
  callModal = {
    el,
    title: document.getElementById('mcpcall-modal-title'),
    badge: document.getElementById('mcpcall-modal-badge'),
    time: document.getElementById('mcpcall-modal-time'),
    input: document.getElementById('mcpcall-modal-input'),
    inputTruncated: document.getElementById('mcpcall-modal-input-truncated'),
    output: document.getElementById('mcpcall-modal-output'),
    outputTruncated: document.getElementById('mcpcall-modal-output-truncated'),
  };
  el.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-mcpcall-close')) closeCallModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && callModalOpen) closeCallModal();
  });
}

/** Apply live MCP events to the tab you are looking at. */
export function applyMcpEvents(events) {
  if (!Array.isArray(events)) return;
  for (const ev of events) applyMcpEvent(mcpState, ev);
  render();
}

/** The same fold for a tab running in the background - keeps its history
 *  accurate so switching to it shows what happened THERE. Mirrors
 *  activefiles.js's trackBucketFiles() / sessiontimeline.js's trackBucketTurn(). */
export function trackBucketMcp(bucket, events) {
  if (!bucket.mcpState) bucket.mcpState = createMcpState();
  if (!Array.isArray(events)) return;
  for (const ev of events) applyMcpEvent(bucket.mcpState, ev);
}

async function load() {
  if (scanning) return;
  scanning = true;
  render();
  try {
    const data = await window.lunacore.getMcpHealth();
    rows = Array.isArray(data && data.servers) ? data.servers : [];
  } catch {
    rows = [];
  } finally {
    scanning = false;
    render();
  }
}

defineWidget({
  id: 'mcp',
  titleKey: 'mcp.title',
  template: 'w-mcp',
  mount(root) {
    els = {
      list: root.querySelector('#mcp-list'),
      empty: root.querySelector('#mcp-empty'),
      summary: root.querySelector('#mcp-summary'),
      refresh: root.querySelector('#mcp-refresh'),
      callsList: root.querySelector('#mcp-calls-list'),
      callsEmpty: root.querySelector('#mcp-calls-empty'),
    };
    ensureCallModal();

    const offLang = onLangChange(render);

    els.refresh.addEventListener('click', () => {
      pulse(els.refresh);
      load();
    });

    els.list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.mcp-test');
      if (!btn) return;
      const name = btn.dataset.probe;
      const server = (rows || []).find((s) => s.name === name);
      if (!server || probes.get(name)?.state === 'running') return;

      probes.set(name, { state: 'running' });
      render();
      const result = await window.lunacore.probeMcpServer(name);
      probes.set(name, { state: 'done', ...result });
      render();
    });

    // First mount pays for the scan; every later one repaints what is already
    // in memory.
    render();
    if (!rows) load();

    return () => {
      offLang();
      closeCallModal();
      els = null;
    };
  },
});

registerSessionView({
  save(bucket) {
    bucket.mcpState = mcpState;
  },
  load(bucket) {
    mcpState = bucket.mcpState || createMcpState();
    render();
  },
  clear(bucket) {
    bucket.mcpState = createMcpState();
  },
});

// Restart = a new process: whatever was tracked belonged to the one that died.
onSessionRestarted(() => {
  mcpState = createMcpState();
  closeCallModal();
  render();
});
