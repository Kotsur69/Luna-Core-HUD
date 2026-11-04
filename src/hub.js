// ============================================================================
// LunaCore - notification hub core (main process)
// ----------------------------------------------------------------------------
// docs/NOTIFICATION_HUB_PLAN.md slice N1. Merges what the collectors
// (src/hubcollect.js) produce into one list:
//   - every item cleaned at the boundary: id must match ID_RE, text is plain
//     one-line text (control characters out, capped), the primary action is
//     a name from ACTIONS or dropped - never a URL or a command;
//   - expired items (countdowns past their end) dropped;
//   - deduped by id (the newest `at` wins);
//   - items marked done moved out of the list into `done` (the drawer's
//     Recent section shows the ones from the last 7 days);
//   - sorted: needs first, then briefs, then info; newest first inside each.
//
// createHub() polls its sources (no new file watchers): cheap in-memory
// sources every tick, file-backed ones at most every 60 s. It emits
// 'hub:changed' with the new view only when the list really changed.
//
// Done state (synced across PCs) and the seen state (which Needs-you items
// this PC already showed, for the launch auto-open) live in src/hubdone.js;
// createHub() gets both stores injected. The view carries `unseen`: open
// Needs-you items this PC has not shown yet.
// ============================================================================

'use strict';

const { EventEmitter } = require('events');
const { runCollector } = require('./hubcollect');

const ID_RE = /^[a-z]+:[A-Za-z0-9:._-]{1,120}$/;
/** Names the renderer resolves to an IPC it already has. Nothing else crosses. */
const ACTIONS = new Set([
  'openReport',
  'cancelPower',
  'cancelPlanWait',
  'openTab',
  'openLife',
  'openMission',
  'openSettings',
  'installUpdate',
]);
const KINDS = ['needs', 'brief', 'info'];
const KIND_RANK = { needs: 0, brief: 1, info: 2 };
const SOURCE_RE = /^[a-z]{1,20}$/;
const ARG_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const I18N_KEY_RE = /^hub\.item\.[A-Za-z]{1,40}$/;
const VAR_NAME_RE = /^[A-Za-z]{1,20}$/;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const MAX_TITLE = 200;
const MAX_DETAIL = 300;
const MAX_VAR = 160;
const MAX_VARS = 6;
const MAX_ITEMS = 200;
const MAX_DONE_SHOWN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 7 * DAY_MS;
const TICK_MS = 5000;
const SLOW_MS = 60 * 1000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
// Control, line-separator, bidi-override and zero-width characters: model-written
// report lines must not spoof how a title reads.
// Every control / format (zero-width, bidi, soft hyphen, tags) / line or
// paragraph separator character.
const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** Absolute paths (Windows drive, UNC share, POSIX home, ~/) and token-like strings never reach the renderer. */
const PATH_RES = [
  /\b[A-Za-z]:[\\/][^\s'"`]*/g,
  /\\\\[^\s\\'"`]+\\[^\s'"`]*/g,
  /(?:^|(?<=[\s(]))(?:\/(?:home|Users|root|mnt|var)\/|~[\\/])[^\s'"`]*/g,
];
// Linear on purpose (no per-position lookahead): long runs are matched once,
// then kept unless they mix letters and digits like a key or token.
const LONG_RUN_RE = /[A-Za-z0-9_-]{32,}/g;
const redactToken = (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '\u2026' : run);
const redact = (s) => PATH_RES.reduce((acc, re) => acc.replace(re, '\u2026'), s).replace(LONG_RUN_RE, redactToken);
// Inputs are capped before the regexes run, so a huge report line costs nothing.
const MAX_RAW = 4096;
const text = (v, max) => redact(String(v == null ? '' : v).slice(0, MAX_RAW).replace(UNSAFE_CHARS_RE, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);

/** True for an id hub:done may carry. */
const isHubId = (id) => typeof id === 'string' && ID_RE.test(id);

function cleanVars(raw) {
  if (!isObject(raw)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_VARS)) {
    if (!VAR_NAME_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = text(v, MAX_VAR);
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanPrimary(raw) {
  if (!isObject(raw) || !ACTIONS.has(raw.action)) return undefined;
  const primary = { action: raw.action };
  if (raw.arg !== undefined) {
    if (typeof raw.arg !== 'string' || !ARG_RE.test(raw.arg)) return undefined;
    primary.arg = raw.arg;
  }
  return primary;
}

/** One collector item -> a clean HubItem, or null when it is unusable. */
function cleanItem(raw) {
  if (!isObject(raw) || !isHubId(raw.id) || !KINDS.includes(raw.kind) || !isTime(raw.at)) return null;
  const title = text(raw.title, MAX_TITLE);
  if (!title) return null;
  const item = { id: raw.id, kind: raw.kind, source: SOURCE_RE.test(raw.source) ? raw.source : 'other', title, at: raw.at };
  const detail = text(raw.detail, MAX_DETAIL);
  if (detail) item.detail = detail;
  if (typeof raw.key === 'string' && I18N_KEY_RE.test(raw.key)) item.key = raw.key;
  if (typeof raw.detailKey === 'string' && I18N_KEY_RE.test(raw.detailKey)) item.detailKey = raw.detailKey;
  const vars = cleanVars(raw.vars);
  if (vars) item.vars = vars;
  if (typeof raw.machine === 'string' && MACHINE_RE.test(raw.machine)) item.machine = raw.machine;
  const primary = cleanPrimary(raw.primary);
  if (primary) item.primary = primary;
  if (raw.local === true) item.local = true;
  // The God Mode project a local action is scoped to; main validates it again on the call.
  if (item.local && typeof raw.project === 'string' && ARG_RE.test(raw.project)) item.project = raw.project;
  if (isTime(raw.expiresAt)) item.expiresAt = raw.expiresAt;
  return item;
}

const byRank = (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at || a.id.localeCompare(b.id);

/**
 * Lists of collector items -> {items, done}: cleaned, unexpired, deduped by id
 * (newest `at` wins), done ones split off, both sorted.
 * @param {Array<Array<object>>} lists
 * @param {{done?:Map<string,number>|Object<string,number>, now:number}} opts
 */
function mergeItems(lists, { done = new Map(), now }) {
  const doneMap = done instanceof Map ? done : new Map(Object.entries(isObject(done) ? done : {}));
  const byId = new Map();
  for (const raw of (Array.isArray(lists) ? lists : []).flat()) {
    const item = cleanItem(raw);
    if (!item || (item.expiresAt && item.expiresAt <= now)) continue;
    const prev = byId.get(item.id);
    // A run shares its ids across PCs (so a done mark syncs): this PC's own
    // item always beats another PC's copy, whatever `at` the row claims.
    const localWins = prev && !prev.machine && item.machine;
    const remoteLoses = prev && prev.machine && !item.machine;
    if (!prev || remoteLoses || (!localWins && item.at > prev.at)) byId.set(item.id, item);
  }
  const all = [...byId.values()];
  const open = all.filter((i) => !doneMap.has(i.id)).sort(byRank).slice(0, MAX_ITEMS);
  const closed = all
    .filter((i) => doneMap.has(i.id) && doneMap.get(i.id) >= now - RECENT_MS)
    .map((i) => ({ ...i, doneAt: doneMap.get(i.id) }))
    .sort((a, b) => b.doneAt - a.doneAt)
    .slice(0, MAX_DONE_SHOWN);
  return { items: open, done: closed };
}

/** Badge number: open 'needs' items. */
const needsCount = (items) => (Array.isArray(items) ? items.filter((i) => i.kind === 'needs').length : 0);

/** Open Needs-you items this PC has not shown yet (`seen` = id -> epochMs). */
const unseenCount = (items, seen) => (Array.isArray(items) ? items.filter((i) => i.kind === 'needs' && !seen.has(i.id)).length : 0);

/** A store stand-in that remembers nothing (tests, or no seen store given). */
const NO_MARKS = { load: () => new Map(), markAll: () => 0 };

/**
 * @param {{
 *   sources: Object<string, {collect:Function, read:() => object, slow?:boolean}>,
 *   doneStore: {load:() => Map<string,number>, mark:(id:string) => boolean},
 *   seenStore?: {load:() => Map<string,number>, markAll:(ids:string[]) => number},
 *   now?: () => number, setTimer?: Function, clearTimer?: Function,
 *   tickMs?: number, slowMs?: number, log?: Function,
 * }} deps
 *   sources: name -> collector + a reader of its state. A slow source (files)
 *   is re-read at most every slowMs; a reader that throws gives [].
 */
function createHub({ sources, doneStore, seenStore = NO_MARKS, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, tickMs = TICK_MS, slowMs = SLOW_MS, log = () => {} }) {
  const events = new EventEmitter();
  const cache = new Map(); // source name -> {at, items}
  let view = { items: [], done: [], needs: 0, unseen: 0 };
  let signature = '';
  let timer = null;

  function collectOne(name, src, force) {
    const at = now();
    const hit = cache.get(name);
    if (!force && hit && src.slow && at - hit.at < slowMs) return hit.items;
    let items = [];
    try {
      items = runCollector(src.collect, { ...src.read(), now: at });
    } catch (err) {
      log(`[hub] source ${name} failed: ${err && err.message}`);
    }
    cache.set(name, { at, items });
    return items;
  }

  /** Re-collects (slow sources only when stale, or when forced) and emits on change. */
  function refresh(force = false) {
    const lists = Object.entries(sources || {}).map(([name, src]) => collectOne(name, src, force));
    const merged = mergeItems(lists, { done: doneStore.load(), now: now() });
    const next = { ...merged, needs: needsCount(merged.items), unseen: unseenCount(merged.items, seenStore.load()) };
    const sig = JSON.stringify(next);
    view = next;
    if (sig !== signature) {
      signature = sig;
      events.emit('hub:changed', view);
    }
    return view;
  }

  function markDone(id) {
    if (!isHubId(id)) return { ok: false, reason: 'bad-id' };
    // Only an item the hub shows (or one already marked) can be marked: a
    // looping renderer must not fill the done file with made-up ids and push
    // real marks out of its cap.
    if (doneStore.load().has(id)) return { ok: true };
    if (!view.items.some((i) => i.id === id)) return { ok: false, reason: 'unknown' };
    if (!doneStore.mark(id)) return { ok: false, reason: 'failed' };
    refresh(false);
    return { ok: true };
  }

  /**
   * The drawer is showing: every open Needs-you item counts as seen. Takes no
   * ids from the renderer - only what the hub itself lists can be marked.
   */
  function markSeen() {
    const ids = view.items.filter((i) => i.kind === 'needs').map((i) => i.id);
    if (seenStore.markAll(ids) > 0) refresh(false);
    return { ok: true, unseen: view.unseen };
  }

  function start() {
    if (timer) return;
    refresh(true);
    timer = setTimer(() => refresh(false), tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    list: () => view,
    refresh,
    markDone,
    markSeen,
    start,
    stop,
    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),
  };
}

module.exports = {
  createHub,
  mergeItems,
  cleanItem,
  needsCount,
  unseenCount,
  isHubId,
  ID_RE,
  ACTIONS,
  RECENT_MS,
};
