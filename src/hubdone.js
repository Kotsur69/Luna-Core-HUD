// ============================================================================
// LunaCore - notification hub: done marks, synced across PCs (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N4. "Mark done" on one PC clears the item on
// every PC: each mark is the cloud unit `hub:done:<itemId>` = {at} in the
// `config` scope (src/configsync.js - newest `u` wins per unit, a delete is a
// tombstone), so no new table and no migration on the server.
//
// Local state: <config>/hub-done.local.json = {v:2, done:{<itemId>: epochMs}}.
// The N1 file ({v:1, done}) has the same map: it is read as is and rewritten
// as v2 on first load, and its marks go to the cloud on the first sync.
//
// Marks older than DONE_KEEP_MS (30 days) are pruned on every load. A pruned
// mark simply leaves the provider's units, so configsync turns it into a
// tombstone and the other PCs drop it too; a cloud value older than that is
// refused, so a PC that was off for a month cannot bring old marks back.
// Cloud values are untrusted: the key must hold a valid hub id and the value
// must be {at: epochMs} within the window - nothing else is kept.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { isHubId } = require('./hub');

const VERSION = 2;
const KEY_PREFIX = 'hub:done:';
const SEEN_KEY_PREFIX = 'hub:seen:';
const DAY_MS = 24 * 60 * 60 * 1000;
const DONE_KEEP_MS = 30 * DAY_MS;
/** A clock skew allowance for marks from another PC. */
const FUTURE_SLACK_MS = DAY_MS;
const MAX_DONE_KEPT = 500;
const MAX_DONE_FILE_BYTES = 512 * 1024;
const DONE_FILE = 'hub-done.local.json';
const SEEN_FILE = 'hub-seen.local.json';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * {id: epochMs} from a parsed file: valid ids only, pruned, a time ahead of
 * `now` (another PC's clock) clamped to now, newest MAX_DONE_KEPT. Ids in
 * `prefer` (marks this PC already had) are kept first, so a flood of synced
 * marks cannot push the existing ones out of the cap.
 * @param {object} raw {done: {id: epochMs}}
 * @param {number} now
 * @param {Set<string>} [prefer]
 */
function normalizeDone(raw, now, prefer = new Set()) {
  const src = isObject(raw) && isObject(raw.done) ? raw.done : {};
  const entries = Object.entries(src)
    .filter(([id, at]) => isHubId(id) && isTime(at) && at >= now - DONE_KEEP_MS && at <= now + FUTURE_SLACK_MS)
    .map(([id, at]) => [id, Math.min(at, now)])
    .sort((a, b) => Number(prefer.has(b[0])) - Number(prefer.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_DONE_KEPT);
  return new Map(entries);
}

/** Write-then-rename: a crash mid-write must not resurface every done item. */
function saveFile(f, map) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: VERSION, done: Object.fromEntries(map) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * Done state on disk. A missing or broken file reads as "nothing done"; a
 * failed write keeps the in-memory state and logs.
 * @param {{file:()=>string|null, now?:()=>number, log?:Function, onMark?:(id:string)=>void}} deps
 *   onMark runs after a local mark (main: a config sync soon, so it travels).
 */
function createDoneStore({ file, now = Date.now, log = () => {}, onMark = () => {} }) {
  let cache = null;

  function persist(map) {
    const f = file();
    if (!f) return true;
    try {
      saveFile(f, map);
      return true;
    } catch (err) {
      log(`[hub] could not save ${DONE_FILE}: ${err && err.message}`);
      return false;
    }
  }

  function load() {
    if (cache) return cache;
    const f = file();
    let raw = null;
    try {
      // A runaway file reads as "nothing done" rather than stalling main on parse.
      if (f && fs.statSync(f).size <= MAX_DONE_FILE_BYTES) raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      raw = null;
    }
    cache = normalizeDone(raw, now());
    // The N1 layout: same map, older version tag - rewrite it once as v2.
    if (isObject(raw) && raw.v === 1) persist(cache);
    return cache;
  }

  /** Marks every new id among `ids` with one write; returns how many were new. */
  function markAll(ids) {
    const current = load();
    const fresh = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => isHubId(id) && !current.has(id));
    if (!fresh.length) return 0;
    const at = now();
    cache = normalizeDone({ done: { ...Object.fromEntries(current), ...Object.fromEntries(fresh.map((id) => [id, at])) } }, at);
    persist(cache);
    try {
      onMark(fresh);
    } catch (err) {
      log(`[hub] onMark failed: ${err && err.message}`);
    }
    return fresh.length;
  }

  function mark(id) {
    if (!isHubId(id)) return false;
    markAll([id]);
    return true;
  }

  /** Replaces every mark (the config sync's merge result). Throws when the file cannot be written. */
  function replace(entries) {
    const next = normalizeDone({ done: Object.fromEntries(entries) }, now(), new Set(load().keys()));
    const f = file();
    if (f) saveFile(f, next);
    cache = next;
  }

  /** The marks with the ones past the window dropped (memory only; the file follows on the next write). */
  function prune() {
    cache = normalizeDone({ done: Object.fromEntries(load()) }, now());
    return cache;
  }

  return { load, mark, markAll, replace, prune };
}

/**
 * Which Needs-you items have already been shown in the drawer (the launch
 * auto-open rule): <config>/hub-seen.local.json, the same layout, window and
 * cap as the done file. N7: synced as `hub:seen:<id>` units, so an item seen
 * on one PC does not auto-open the drawer on the next; onMark (main: a config
 * sync soon) is passed through like the done store's.
 */
const createSeenStore = (deps) => createDoneStore({ onMark: () => {}, ...deps });

/** A cloud unit's value -> {at}, or null when it is not a usable mark. */
function validMark(k, v, now, prefix = KEY_PREFIX) {
  if (typeof k !== 'string' || !k.startsWith(prefix) || !isHubId(k.slice(prefix.length))) return null;
  if (!isObject(v) || !isTime(v.at) || v.at < now - DONE_KEEP_MS || v.at > now + FUTURE_SLACK_MS) return null;
  return { at: Math.min(v.at, now) };
}

/**
 * The configsync.js provider for one marks store: `<prefix><itemId>` = {at}.
 * @param {ReturnType<typeof createDoneStore>} store
 * @param {{name:string, prefix:string, now?:()=>number}} opts
 */
function createHubMarksProvider(store, { name, prefix, now = Date.now }) {
  return {
    name,
    owns: (k) => typeof k === 'string' && k.startsWith(prefix),
    valid: (k, v) => validMark(k, v, now(), prefix),
    read() {
      // Pruned: a mark past the window leaves the units -> a tombstone.
      const units = [...store.prune()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, at]) => [`${prefix}${id}`, { at }]);
      return { units, base: now() };
    },
    write(units) {
      store.replace(units.filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v && v.at]));
    },
  };
}

/** The `hub:done:*` units ("Mark done" clears an item on every PC). */
const createHubDoneProvider = (store, { now = Date.now } = {}) => createHubMarksProvider(store, { name: 'hubdone', prefix: KEY_PREFIX, now });

/** The `hub:seen:*` units (N7: the launch auto-open counts what any PC showed). */
const createHubSeenProvider = (store, { now = Date.now } = {}) => createHubMarksProvider(store, { name: 'hubseen', prefix: SEEN_KEY_PREFIX, now });

module.exports = {
  createDoneStore,
  createSeenStore,
  createHubDoneProvider,
  createHubSeenProvider,
  normalizeDone,
  validMark,
  DONE_FILE,
  SEEN_FILE,
  DONE_KEEP_MS,
  KEY_PREFIX,
  SEEN_KEY_PREFIX,
  MAX_DONE_KEPT,
  VERSION,
};
