// ============================================================================
// LunaCore - the phone's signed memory inbox commands (main, HUD host mode)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, post-phase-4 item 5. Handlers for
// src/hostcommands.js, which runs one only after src/hostauth.js verified the
// grant and the Face ID signature. Live only when host mode runs INSIDE the
// full HUD (src/hostswitch.js): only the HUD syncs the memory mirror
// (src/memorysync.js), so a decision made here reaches the other PC. A
// headless `--host` answers every memory.* kind with needsHudMemoryHandlers().
//
//   memory.inbox    {}            the waiting entries (src/memoryinbox.js
//                                 listInbox), trimmed to fit a command result
//   memory.approve  {project, id} memoryinbox.approve()
//   memory.reject   {project, id} memoryinbox.reject()
//
// Approve and Reject call the same inbox functions as the HUD's inbox panel
// (src/memoryipc.js) with the same memory-log line (memorylog.decisionEvent),
// so the approval rate and the auto-accept numbers count a phone decision like
// one made on the PC, and onChanged syncs it soon. Edit and Make global stay
// PC-only.
//
// The payload is untrusted even when signed: no other field may be present,
// the project and id must have the record format, the project must hold
// memories on this PC, and the entry must be waiting right now - a confirmed
// memory is never touched from here. Results carry keys, texts and counts,
// never paths; a refusal is a short code the phone translates.
// ============================================================================

'use strict';

const { listInbox, approve, reject } = require('./memoryinbox');
const { validProject, splitKey } = require('./memoryrecord');
const { scan } = require('./memorystore');
const { decisionEvent } = require('./memorylog');

const KINDS = ['memory.inbox', 'memory.approve', 'memory.reject'];
/** src/memoryrecord.js ID_RE: no '/', so `${project}/${id}` splits back the same way. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** Entries one memory.inbox answer carries; `total` says how many wait in all. */
const MAX_PHONE_ITEMS = 30;
/** A longer body is cut (the item says `clipped`); the full text is on the PC. */
const MAX_PHONE_BODY = 2500;
/** Titles of the memories an approval would replace, per entry. */
const MAX_SUPERSEDES = 5;
/** hostcommands.js refuses a result over 128 KB: stop adding entries well before. */
const RESULT_BUDGET_BYTES = 100 * 1024;
const DECISION_FIELDS = new Set(['project', 'id']);
/** memoryinbox reasons -> the codes the phone knows. */
const REASONS = { 'bad-key': 'badId', 'not-found': 'notFound', 'not-pending': 'notWaiting' };

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const refused = (error) => ({ status: 'refused', error });
const errText = (err) => String(err instanceof Error ? err.message : err).slice(0, 300);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** What a headless `--host` answers every memory.* kind with. */
function needsHudMemoryHandlers() {
  return Object.fromEntries(KINDS.map((kind) => [kind, async () => refused('needsHud')]));
}

/** One listInbox item -> what the phone gets: no folded-duplicate keys, a capped body. */
function phoneItem(item) {
  const clipped = item.body.length > MAX_PHONE_BODY;
  return {
    key: item.key,
    project: item.project,
    id: item.id,
    type: item.type,
    area: item.area || null,
    title: item.title,
    body: clipped ? item.body.slice(0, MAX_PHONE_BODY) : item.body,
    clipped,
    created: item.created,
    source: item.source,
    usefulness: item.usefulness,
    suggestedGlobal: item.suggestedGlobal === true,
    outside: item.outside || 0,
    duplicates: item.duplicates,
    supersedes: item.supersedes.slice(0, MAX_SUPERSEDES).map((s) => s.title),
    similar: item.similar ? item.similar.title : null,
  };
}

/** Items in listing order until the budget is spent; a result never outgrows the column. */
function fitItems(items) {
  const out = [];
  let bytes = 0;
  for (const item of items.slice(0, MAX_PHONE_ITEMS)) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (bytes + size > RESULT_BUDGET_BYTES) break;
    bytes += size;
    out.push(item);
  }
  return out;
}

/**
 * A decision payload -> the entry's key, or a refusal code. Shape and format
 * only; whether the entry waits is checked against the mirror afterwards.
 * @returns {{key: string, project: string}|{error: string}}
 */
function decisionTarget(payload) {
  if (!isObject(payload) || Object.keys(payload).some((k) => !DECISION_FIELDS.has(k))) return { error: 'badPayload' };
  const { project, id } = payload;
  if (typeof project !== 'string' || !validProject(project)) return { error: 'badProject' };
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: 'badId' };
  const key = `${project}/${id}`;
  const split = splitKey(key);
  if (!split || split.project !== project || split.id !== id) return { error: 'badId' };
  return { key, project };
}

/**
 * @param {{
 *   dir: () => string,                     the memory mirror (memoryPaths().dir)
 *   log?: {add: (event: object) => void}|null,   the memory log (src/memorylog.js)
 *   onChanged?: () => void,               a decision is on disk: sync soon, repaint
 *   now?: () => number,
 *   logLine?: (line: string) => void,
 * }} deps
 */
function createHostMemory(deps) {
  const logLine = deps.logLine || ((line) => console.error(line));
  const onChanged = deps.onChanged || (() => {});
  const now = deps.now || Date.now;
  const memoryLog = deps.log || null;

  /** The same log line the HUD's inbox panel writes (src/memoryipc.js). */
  const decided = (ev, record) => {
    if (memoryLog) memoryLog.add(decisionEvent(ev, record));
  };

  async function inbox(payload) {
    if (!isObject(payload) || Object.keys(payload).length) return refused('badPayload');
    const { items, total } = listInbox(deps.dir());
    const shown = fitItems(items.map(phoneItem));
    return { status: 'listed', items: shown, total };
  }

  /** The checks every decision passes, then `act(dir, key)` - approve or reject. */
  function decide(act) {
    return async (payload) => {
      const target = decisionTarget(payload);
      if (target.error) return refused(target.error);
      const dir = deps.dir();
      if (!scan(dir).records.some(([, r]) => r.project === target.project)) return refused('unknownProject');
      const res = act(dir, target.key);
      if (!res || !res.ok) return refused(REASONS[res && res.reason] || 'failed');
      onChanged();
      return { status: 'decided', key: res.key, removed: res.removed.length };
    };
  }

  /**
   * A throw (an unreadable mirror, a failed write) is logged here and answered
   * as a plain refusal: hostcommands.js would otherwise put the raw message -
   * possibly holding a local path - into the row's result.
   */
  const safe = (kind, fn) => async (payload) => {
    try {
      return await fn(payload);
    } catch (err) {
      logLine(`[hostmemory] ${kind} failed: ${errText(err)}`);
      return refused('failed');
    }
  };

  const handlers = {
    'memory.inbox': safe('memory.inbox', inbox),
    'memory.approve': safe('memory.approve', decide((dir, key) => approve(dir, key, isoDate(now()), decided))),
    'memory.reject': safe('memory.reject', decide((dir, key) => reject(dir, key, decided))),
  };

  return { handlers };
}

module.exports = { createHostMemory, needsHudMemoryHandlers, decisionTarget, KINDS, MAX_PHONE_ITEMS, MAX_PHONE_BODY };
