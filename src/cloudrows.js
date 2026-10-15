// ============================================================================
// LunaCore - cloud rows <-> sync peers (main, pure)
// ----------------------------------------------------------------------------
// The cloud (Supabase table sync_units, docs/CLOUD_SYNC_PLAN.md) holds one row
// per unit: {key, value, u, deleted_at, rev}. lifesync.js and todosync.js
// already merge peers of a fixed shape, so the cloud is just one more peer:
//
//   pulled rows -> mirror {key: {v, u, d}} -> lifePeer() / todoPeer()
//   published doc -> lifeUnits() / todoUnits() -> unpushed() -> push_units RPC
//
// A tombstone row is {v: null, u: d, d}: its `u` is the delete time, so the
// server's newest-wins check orders deletes and edits the same way the local
// merge does. No validation of values here - the peer goes through
// lifesync.validPeer() / todosync.validPeerProjects() like a peer file does.
// ============================================================================

'use strict';

/** The cloud column limit (sync_units.key check). */
const MAX_KEY = 200;
const URL_RE = /^https:\/\/[a-z0-9-]{1,63}\.supabase\.co\/?$/;
const PUBLISHABLE_KEY_RE = /^[A-Za-z0-9._-]{20,300}$/;
const AT_RE = /^[1-9][0-9]{0,15}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Keys a row may not use as an object key: '__proto__', 'constructor', 'toString'... */
const unsafeKey = (k) => k === '__proto__' || Object.hasOwn(Object.prototype, k);
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** A bigint column may arrive as a number or a numeric string. */
const toInt = (x) => {
  const n = typeof x === 'string' && /^\d{1,16}$/.test(x) ? Number(x) : x;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** config/cloud.local.json -> {url, publishableKey}, or null (cloud off). */
function parseCloudConfig(raw) {
  if (!isPlainObject(raw) || typeof raw.url !== 'string' || typeof raw.publishableKey !== 'string') return null;
  if (!URL_RE.test(raw.url) || !PUBLISHABLE_KEY_RE.test(raw.publishableKey)) return null;
  return { url: raw.url.replace(/\/$/, ''), publishableKey: raw.publishableKey };
}

/** '<projectKey>:<at>' -> [projectKey, at], or null. */
function splitTodoKey(k) {
  const i = typeof k === 'string' ? k.lastIndexOf(':') : -1;
  if (i < 1 || !AT_RE.test(k.slice(i + 1))) return null;
  return [k.slice(0, i), Number(k.slice(i + 1))];
}

/**
 * Folds pulled rows into a scope's state.
 * @param {{cursor:number, mirror:object, pushed:object}} state
 * @param {{key, value, u, deleted_at, rev}[]} rows untrusted (another machine wrote them)
 * @returns {{cursor:number, mirror:object, pushed:object}} new state, input untouched
 */
function applyRows(state, rows, now = Date.now()) {
  const mirror = { ...state.mirror };
  const pushed = { ...state.pushed };
  let cursor = state.cursor;
  for (const r of rows) {
    const rev = toInt(r && r.rev);
    if (rev !== null) cursor = Math.max(cursor, rev);
    const u = toInt(r && r.u);
    if (!r || typeof r.key !== 'string' || !r.key || r.key.length > MAX_KEY || unsafeKey(r.key)) continue;
    // A far-future stamp would win every merge and block our pushes of the key forever.
    if (u === null || u > now + DAY_MS) continue;
    const d = r.deleted_at == null ? null : toInt(r.deleted_at);
    mirror[r.key] = { v: d === null ? (r.value ?? null) : null, u, d };
    // The cloud holds this version already: pushing it back would be an echo.
    pushed[r.key] = Math.max(pushed[r.key] || 0, u);
  }
  return { cursor, mirror, pushed };
}

/** Mirror -> a life peer body {units, gone} (still unvalidated). */
function lifePeer(mirror) {
  const units = [];
  const gone = {};
  for (const [k, row] of Object.entries(mirror)) {
    if (row.d !== null) gone[k] = row.d;
    else units.push({ k, v: row.v, u: row.u });
  }
  return { units, gone };
}

/** Mirror -> a to-do peer {<projectKey>: {items, gone}} (still unvalidated). */
function todoPeer(mirror) {
  const out = {};
  for (const [k, row] of Object.entries(mirror)) {
    const split = splitTodoKey(k);
    if (!split) continue;
    const [key, at] = split;
    if (unsafeKey(key)) continue;
    const proj = Object.hasOwn(out, key) ? out[key] : (out[key] = { items: [], gone: {} });
    if (row.d !== null) proj.gone[at] = row.d;
    else if (isPlainObject(row.v)) proj.items.push({ ...row.v, at, u: row.u });
  }
  return out;
}

// sync_units.u is bigint: an old first-sync stamp (a file mtimeMs) can carry a fraction.
const whole = (t) => Math.floor(t);
const tombstone = (k, t) => ({ k, v: null, u: whole(t), d: whole(t) });

/** lifesync's published body -> cloud units. */
function lifeUnits(doc) {
  const live = doc.units.map(({ k, v, u }) => ({ k, v, u: whole(u), d: null }));
  const keys = new Set(live.map((x) => x.k));
  const dead = Object.entries(doc.gone)
    .filter(([k]) => !keys.has(k))
    .map(([k, t]) => tombstone(k, t));
  return [...live, ...dead];
}

/** todosync's published projects -> cloud units. */
function todoUnits(projects) {
  const out = [];
  for (const [key, proj] of Object.entries(projects)) {
    if (key.length + 17 > MAX_KEY) continue; // ':' + up to 16 digits
    const ats = new Set();
    for (const { u, ...item } of proj.items) {
      ats.add(String(item.at));
      out.push({ k: `${key}:${item.at}`, v: item, u: whole(u), d: null });
    }
    for (const [at, t] of Object.entries(proj.gone)) if (!ats.has(at)) out.push(tombstone(`${key}:${at}`, t));
  }
  return out;
}

/** Units the cloud does not have yet: newer than `pushed`, one per key (newest). */
function unpushed(units, pushed) {
  const best = new Map();
  for (const x of units) {
    if (pushed[x.k] >= x.u) continue;
    const cur = best.get(x.k);
    if (!cur || x.u > cur.u) best.set(x.k, x);
  }
  return [...best.values()];
}

module.exports = { parseCloudConfig, splitTodoKey, applyRows, lifePeer, todoPeer, lifeUnits, todoUnits, unpushed, MAX_KEY };
