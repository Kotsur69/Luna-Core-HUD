// ============================================================================
// LunaCore - Work map side panel: session switcher, live ticker, inspector
// ----------------------------------------------------------------------------
// The HTML around the Sessions map's SVG (workmap.js), slice 2 of #agymap:
//
//  - Session switcher: a <select> in the head. "Active tab" follows the tab
//    being looked at (the map's old behaviour, and the default); any other
//    entry pins the map to that session until it closes. Built from the tab
//    list main.js pushes (sessions:update), nothing new over IPC.
//  - Live ticker: the shown session's last TICKER_ROWS calls, newest first:
//    tool, sanitized detail, +/- lines, outcome in words. Text only, a fixed
//    set of reused rows.
//  - Inspector: clicking a station or a satellite opens a small read-only
//    panel (counts, last details). It repaints with the map while open.
//    Esc (through the tab's onKey) or its close button closes it.
//
// Every string reaches the DOM through textContent; nothing here writes.
// The top half is pure, for test/workmappanel.test.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { truncate } from './liveMapHelpers.js';
import { baseName, formatLines } from './workmapSatellites.js';

/** Calls the ticker shows. */
export const TICKER_ROWS = 10;
/** Calls of one station the inspector lists. */
export const INSPECT_RECENT = 6;
const TICKER_DETAIL_CHARS = 44;
const INSPECT_DETAIL_CHARS = 60;
const STATUSES = new Set(['running', 'ok', 'failed', 'dropped']);
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

// ---- pure helpers (tested) -----------------------------------------------------

/**
 * The session the map shows: the pinned one while it is still open, else the active tab.
 * @param {string|null} pinned the switcher's choice ('' / null = follow)
 * @param {string|null} activeId
 * @param {{has: (id: string) => boolean}} openIds the sessions in the last pushed tab list
 * @returns {string|null}
 */
export function resolveViewed(pinned, activeId, openIds) {
  if (typeof pinned === 'string' && pinned && openIds && openIds.has(pinned)) return pinned;
  return typeof activeId === 'string' && activeId ? activeId : null;
}

/**
 * One ticker line out of a RecentCall: a file tool with no detail shows its
 * file's name. Junk entries are skipped by the callers.
 * @param {object} e
 * @param {number} detailChars
 */
function lineOf(e, detailChars) {
  const detail = e.detail || (e.file ? baseName(e.file) : '');
  return {
    key: typeof e.callId === 'string' ? e.callId : '',
    station: typeof e.station === 'string' ? e.station : 'other',
    tool: e.tool || '?',
    detail: truncate(detail, detailChars),
    fullDetail: e.file || detail,
    lines: formatLines(e.added, e.removed),
    status: STATUSES.has(e.status) ? e.status : 'running',
  };
}

/**
 * The ticker's rows, newest first.
 * @param {unknown} recent TabState.recent (oldest first)
 * @param {number} [n=TICKER_ROWS]
 * @returns {Array<{key:string, station:string, tool:string, detail:string, fullDetail:string, lines:string, status:string}>}
 */
export function tickerRows(recent, n = TICKER_ROWS) {
  if (!Array.isArray(recent)) return [];
  const out = [];
  for (let i = recent.length - 1; i >= 0 && out.length < n; i -= 1) {
    const e = recent[i];
    if (e && typeof e === 'object') out.push(lineOf(e, TICKER_DETAIL_CHARS));
  }
  return out;
}

/**
 * One station's last calls, newest first (the inspector's list).
 * @param {unknown} recent TabState.recent
 * @param {string} station
 * @param {number} [n=INSPECT_RECENT]
 */
export function stationRecent(recent, station, n = INSPECT_RECENT) {
  if (!Array.isArray(recent)) return [];
  const out = [];
  for (let i = recent.length - 1; i >= 0 && out.length < n; i -= 1) {
    const e = recent[i];
    if (e && typeof e === 'object' && e.station === station) out.push(lineOf(e, INSPECT_DETAIL_CHARS));
  }
  return out;
}

/** How long ago, coarse: '12 s', '3 min', '2 h'; '' for junk or a time in the future. */
export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)} s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  return `${Math.floor(ms / HOUR_MS)} h`;
}

// ---- DOM -----------------------------------------------------------------------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

/** Whether focus can go back to a node: still in the page and rendered (display:none has no boxes). */
function canFocus(node) {
  if (!node || !node.isConnected || typeof node.focus !== 'function') return false;
  return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
}

/** "Edit · workmap.js · +12 -3 · ok" - one call as one line of text. */
function lineText(row) {
  return [row.tool, row.detail, row.lines, t(`lm.wm.status.${row.status}`)].filter(Boolean).join(' · ');
}

function buildTicker() {
  const root = el('section', 'wm-ticker');
  const title = el('h3', 'wm-ticker__title');
  const list = el('ol', 'wm-ticker__list');
  const rows = [];
  for (let i = 0; i < TICKER_ROWS; i += 1) {
    const li = el('li', 'wm-tick');
    const tool = el('span', 'wm-tick__tool');
    const detail = el('span', 'wm-tick__detail');
    const lines = el('span', 'wm-tick__lines');
    const status = el('span', 'wm-tick__status');
    li.append(tool, detail, lines, status);
    li.hidden = true;
    list.append(li);
    rows.push({ li, tool, detail, lines, status });
  }
  const empty = el('p', 'wm-ticker__empty');
  root.append(title, list, empty);
  return { root, title, list, rows, empty };
}

function paintTicker(ticker, rows) {
  setText(ticker.title, t('lm.wm.tickerTitle'));
  ticker.list.setAttribute('aria-label', t('lm.wm.tickerTitle'));
  ticker.rows.forEach((r, i) => {
    const row = rows[i];
    r.li.hidden = !row;
    if (!row) return;
    setText(r.tool, row.tool);
    setText(r.detail, row.detail);
    setText(r.lines, row.lines);
    setText(r.status, t(`lm.wm.status.${row.status}`));
    const cls = `wm-tick is-${row.status} at-${row.station}`;
    if (r.li.className !== cls) r.li.className = cls;
    if (r.li.title !== row.fullDetail) r.li.title = row.fullDetail;
  });
  setText(ticker.empty, rows.length ? '' : t('lm.wm.tickerEmpty'));
  ticker.empty.hidden = rows.length > 0;
}

function buildInspector(onClose) {
  const root = el('section', 'wm-inspect');
  root.hidden = true;
  root.setAttribute('role', 'region');
  const head = el('div', 'wm-inspect__head');
  const title = el('h3', 'wm-inspect__title');
  const close = el('button', 'wm-inspect__close', '×');
  close.type = 'button';
  close.addEventListener('click', onClose);
  head.append(title, close);
  const kind = el('p', 'wm-inspect__kind');
  const lines = el('ul', 'wm-inspect__lines');
  const sub = el('h4', 'wm-inspect__sub');
  const list = el('ol', 'wm-inspect__list');
  root.append(head, kind, lines, sub, list);
  return { root, title, close, kind, lines, sub, list, sig: '' };
}

/** Replaces a list's items (paintInspector() calls it only when the view changed). */
function fillList(node, texts) {
  node.replaceChildren(...texts.map((text) => el('li', '', text)));
  node.hidden = texts.length === 0;
}

/**
 * @typedef {object} InspectorView what the inspector shows
 * @property {string} title
 * @property {string} kind
 * @property {string[]} lines
 * @property {string} sub heading of the list ('' = none)
 * @property {string[]} list
 */

/**
 * The inspector's view of a station: its counts, extras and its last calls.
 * @param {string} name the station's localized name
 * @param {{total:number, inFlight:number, errors:number, lastError:{message:string}|null}} st
 * @param {string[]} extras e.g. the Memory station's per-tool counts
 * @param {unknown} recent TabState.recent
 * @param {string} stationId
 * @param {object[]} satellites what the station shows as satellites
 * @returns {InspectorView}
 */
export function stationView(name, st, extras, recent, stationId, satellites) {
  const lines = [t('lm.wm.summary', { calls: st.total, running: st.inFlight, failed: st.errors }), ...extras];
  if (st.lastError && st.lastError.message) lines.push(t('lm.wm.lastError', { msg: truncate(st.lastError.message, INSPECT_DETAIL_CHARS * 2) }));
  const sats = satellites.map((it) => (it.kind === 'file' ? baseName(it.label) : it.label));
  if (sats.length) lines.push(t('lm.wm.inspect.sats', { list: sats.join(', ') }));
  const calls = stationRecent(recent, stationId).map(lineText);
  return { title: name, kind: t('lm.wm.inspect.station'), lines, sub: t('lm.wm.inspect.recent'), list: calls.length ? calls : [t('lm.wm.inspect.none')] };
}

/**
 * The inspector's view of a satellite; null item = it is no longer remembered.
 * @param {object|null} item a StationItem or a mergeProcs() entry
 * @param {number} now epoch ms
 * @returns {InspectorView}
 */
export function satelliteView(item, now) {
  if (!item) return { title: t('lm.wm.inspect.gone'), kind: '', lines: [], sub: '', list: [] };
  const lines = [];
  if (item.kind === 'process' || item.kind === 'port') {
    lines.push(item.kind === 'port' ? `${item.name} (pid ${item.pid})` : `${item.label} (pid ${item.pid})`);
    if (item.kind === 'process' && item.ports.length) lines.push(t('lm.wm.sat.ports', { list: item.ports.join(', ') }));
    lines.push(t(item.alive ? 'lm.wm.sat.alive' : 'lm.wm.sat.gone'));
  } else {
    if (item.kind === 'file') lines.push(item.label);
    lines.push([t('lm.wm.sat.calls', { n: item.calls }), formatLines(item.added, item.removed), item.failed ? t('lm.wm.failed', { n: item.failed }) : ''].filter(Boolean).join(' · '));
  }
  const ago = item.alive ? '' : agoText(now - item.lastAt);
  if (ago) lines.push(t('lm.wm.inspect.seen', { ago }));
  const title = item.kind === 'file' ? baseName(item.label) : item.label;
  return { title, kind: t(`lm.wm.sat.${item.kind}`), lines, sub: '', list: [] };
}

function paintInspector(ins, view) {
  const sig = JSON.stringify(view);
  ins.close.setAttribute('aria-label', t('lm.wm.inspect.close'));
  ins.close.title = t('lm.wm.inspect.close');
  ins.root.setAttribute('aria-label', view.title);
  if (sig === ins.sig) return;
  ins.sig = sig;
  setText(ins.title, view.title);
  setText(ins.kind, view.kind);
  ins.kind.hidden = !view.kind;
  fillList(ins.lines, view.lines);
  setText(ins.sub, view.sub);
  ins.sub.hidden = !view.sub;
  fillList(ins.list, view.list);
}

/**
 * The side column and the head's session switcher.
 * @param {{onSelect: (sessionId: string) => void}} deps the switcher changed ('' = follow the active tab)
 * @returns {object} see the returned members
 */
export function createWorkmapPanel({ onSelect }) {
  const switcher = el('label', 'wm-switch');
  const switchText = el('span', 'wm-switch__label');
  const select = el('select', 'wm-switch__select');
  switcher.append(switchText, select);
  select.addEventListener('change', () => onSelect(select.value));
  let optionsSig = '';

  const side = el('div', 'wm-side');
  let target = null;
  let opener = null;
  /**
   * Closes the inspector; false when it was not open. Focus goes back to what
   * opened it - or to the switcher when that is gone or hidden (a satellite
   * that left its slot) - unless `keepFocus` (the session changed under it).
   * @param {{keepFocus?: boolean}|Event} [opts]
   */
  const close = (opts) => {
    if (!target) return false;
    target = null;
    inspector.root.hidden = true;
    inspector.sig = '';
    const back = opener;
    opener = null;
    if (!(opts && opts.keepFocus === true)) (canFocus(back) ? back : select).focus({ preventScroll: true });
    return true;
  };
  const inspector = buildInspector(close);
  const ticker = buildTicker();
  side.append(inspector.root, ticker.root);

  return {
    switcher,
    side,
    /** Fills the switcher; rebuilt only when the options changed. */
    paintSwitcher(options, selected) {
      setText(switchText, t('lm.wm.switchLabel'));
      const sig = JSON.stringify(options);
      if (sig !== optionsSig) {
        optionsSig = sig;
        select.replaceChildren(...options.map((o) => {
          const opt = el('option', '', o.label);
          opt.value = o.value;
          return opt;
        }));
      }
      if (select.value !== selected) select.value = selected;
    },
    paintTicker(rows) {
      paintTicker(ticker, rows);
    },
    /** What is being inspected: {type:'station', station} | {type:'satellite', station, key} | null. */
    target: () => target,
    /** Opens (or retargets) the inspector; focus moves to it and returns, on close, to what first opened it. */
    inspect(next, from) {
      if (!target) opener = from || null;
      target = next;
      inspector.root.hidden = false;
      inspector.close.focus({ preventScroll: true });
    },
    paintInspector(view) {
      if (target) paintInspector(inspector, view);
    },
    /** Closes the inspector; false when it was not open. */
    close,
  };
}
