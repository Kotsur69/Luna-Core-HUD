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
//   memory.reject   {project, id, reason?} memoryinbox.reject(); the optional
//                                 reason (a short phrase, max 80 chars) goes into the memory log line
//   memory.search   {query, project?, limit?}  memoryReader.search over the mirror: key,
//                                 project, type, title, trust label, source and, for a
//                                 confirmed memory only, a snippet. No new table: the answer
//                                 travels in the command row's result like memory.inbox.
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
const { scrubDeep } = require('./hostscrub');
const { sourceOf } = require('./memoryprovenance');
const { createMemoryReader, trustOf } = require('./memorytools');

const KINDS = ['memory.inbox', 'memory.approve', 'memory.reject', 'memory.search'];
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
const REJECT_FIELDS = new Set(['project', 'id', 'reason']);
const SEARCH_FIELDS = new Set(['query', 'project', 'limit']);
/** A rejection reason is a short slug or phrase ("too-vague", "duplicate"). */
const MAX_REASON_CHARS = 80;
const MAX_QUERY_CHARS = 200;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 15;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SNIPPET_CHARS = 300;
/** Control and invisible characters (Cc, Cf) and the Unicode line separators. */
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
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

/** The session id inside a source line ("captured from session s12 on ..."), or null. */
function originSessionOf(source) {
  const { kind, ref } = sourceOf(source);
  return (kind === 'session' || kind === 'auto-memory') && ref ? ref : null;
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
    // The session that proposed or captured it, read apart from `source`; null when it has none.
    originSessionId: originSessionOf(item.source),
    usefulness: item.usefulness,
    suggestedGlobal: item.suggestedGlobal === true,
    outside: item.outside || 0,
    duplicates: item.duplicates,
    supersedes: item.supersedes.slice(0, MAX_SUPERSEDES).map((s) => s.title),
    similar: item.similar ? item.similar.title : null,
  };
}

/**
 * Items in listing order until the budget is spent; a result never outgrows
 * the column. Each item is measured AFTER the secret scrub hostcommands.js
 * applies on the way out: a mask can be longer than what it replaces.
 */
function fitItems(items, max = MAX_PHONE_ITEMS) {
  const out = [];
  let bytes = 0;
  // A wrapper, not .map(scrubDeep): map's index would land in scrubDeep's depth argument.
  for (const item of items.slice(0, max).map((i) => scrubDeep(i))) {
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
function decisionTarget(payload, allowed = DECISION_FIELDS) {
  if (!isObject(payload) || Object.keys(payload).some((k) => !allowed.has(k))) return { error: 'badPayload' };
  const { project, id } = payload;
  if (typeof project !== 'string' || !validProject(project)) return { error: 'badProject' };
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: 'badId' };
  const key = `${project}/${id}`;
  const split = splitKey(key);
  if (!split || split.project !== project || split.id !== id) return { error: 'badId' };
  return { key, project };
}

/**
 * An optional rejection reason -> a clean one-line string, null (none given) or a refusal.
 * @returns {{reason: string|null}|{error: string}}
 */
function rejectReason(value) {
  if (value === undefined) return { reason: null };
  if (typeof value !== 'string') return { error: 'badReason' };
  const reason = value.trim();
  if (!reason || reason.length > MAX_REASON_CHARS || UNSAFE_TEXT_RE.test(reason)) return { error: 'badReason' };
  return { reason };
}

/**
 * A memory.search payload -> {query, project, limit} or a refusal code. Strict:
 * only the three fields, a bounded one-line query, a valid project, limit 1-15.
 */
function searchArgs(payload) {
  if (!isObject(payload) || Object.keys(payload).some((k) => !SEARCH_FIELDS.has(k))) return { error: 'badPayload' };
  const { query, project, limit } = payload;
  if (typeof query !== 'string') return { error: 'badQuery' };
  const text = query.trim();
  if (!text || text.length > MAX_QUERY_CHARS || UNSAFE_TEXT_RE.test(text)) return { error: 'badQuery' };
  if (project !== undefined && (typeof project !== 'string' || !validProject(project))) return { error: 'badProject' };
  if (limit !== undefined && (!Number.isInteger(limit) || limit < MIN_SEARCH_LIMIT || limit > MAX_SEARCH_LIMIT)) return { error: 'badLimit' };
  return { query: text, project: project ?? null, limit: limit ?? DEFAULT_SEARCH_LIMIT };
}

/** One search hit -> what the phone shows. Only a confirmed memory's text leaves the PC. */
function phoneHit(hit) {
  return {
    key: hit.key,
    project: hit.project,
    type: hit.type,
    title: hit.title,
    trust: trustOf(hit),
    source: hit.source,
    ...(hit.confidence === 'confirmed' ? { snippet: String(hit.snippet || '').slice(0, MAX_SNIPPET_CHARS) } : { unreviewed: true }),
  };
}

/**
 * @param {{
 *   dir: () => string,                     the memory mirror (memoryPaths().dir)
 *   log?: {add: (event: object) => void}|null,   the memory log (src/memorylog.js)
 *   onChanged?: () => void,               a decision is on disk: sync soon, repaint
 *   search?: Function,                     memoryReader.search; default: a keyword reader over `dir`
 *   now?: () => number,
 *   logLine?: (line: string) => void,
 * }} deps
 */
function createHostMemory(deps) {
  const logLine = deps.logLine || ((line) => console.error(line));
  const onChanged = deps.onChanged || (() => {});
  const now = deps.now || Date.now;
  const memoryLog = deps.log || null;
  let ownReader = null;
  /** The injected search, else a keyword reader made on first use (the HUD may inject its hybrid one). */
  const searcher = () => {
    if (deps.search) return deps.search;
    if (!ownReader) ownReader = createMemoryReader(deps.dir(), { now });
    return ownReader.search;
  };

  /** The same log line the HUD's inbox panel writes (src/memoryipc.js); `reason` is the phone's rejection chip. */
  const decided = (ev, record, reason = null) => {
    if (memoryLog) memoryLog.add({ ...decisionEvent(ev, record), ...(reason ? { reason } : {}) });
  };

  async function inbox(payload) {
    if (!isObject(payload) || Object.keys(payload).length) return refused('badPayload');
    const { items, total } = listInbox(deps.dir());
    const shown = fitItems(items.map(phoneItem));
    return { status: 'listed', items: shown, total };
  }

  async function search(payload) {
    const args = searchArgs(payload);
    if (args.error) return refused(args.error);
    const hits = await searcher()(args.query, { project: args.project, only: args.project, limit: args.limit });
    return { status: 'found', results: fitItems(hits.map(phoneHit), args.limit) };
  }

  /** The checks every decision passes, then `act(dir, key, reason)` - approve or reject. */
  function decide(act, allowed = DECISION_FIELDS) {
    return async (payload) => {
      const target = decisionTarget(payload, allowed);
      if (target.error) return refused(target.error);
      const why = allowed.has('reason') ? rejectReason(payload.reason) : { reason: null };
      if (why.error) return refused(why.error);
      const dir = deps.dir();
      if (!scan(dir).records.some(([, r]) => r.project === target.project)) return refused('unknownProject');
      let res;
      try {
        res = act(dir, target.key, why.reason);
      } catch (err) {
        // The decision may be on disk already (a later delete or the log line
        // threw): sync anyway, a sync with nothing new costs nothing.
        onChanged();
        throw err;
      }
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
    'memory.reject': safe('memory.reject', decide((dir, key, reason) => reject(dir, key, (ev, record) => decided(ev, record, reason)), REJECT_FIELDS)),
    'memory.search': safe('memory.search', search),
  };

  return { handlers };
}

module.exports = { createHostMemory, needsHudMemoryHandlers, decisionTarget, searchArgs, rejectReason, KINDS, MAX_SEARCH_LIMIT, MAX_REASON_CHARS, RESULT_BUDGET_BYTES, MAX_PHONE_ITEMS, MAX_PHONE_BODY };
