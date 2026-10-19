// ============================================================================
// LunaCore - Life budget shared between PCs (main)
// ----------------------------------------------------------------------------
// The budget lives in config/life-budget.local.json on each PC. Through the
// cloud (src/cloudsync.js, scope 'life') every PC publishes its budget and
// merges the others', so expenses added on two PCs ADD UP and never overwrite
// each other. What a PC publishes:
//
//   {units: [{k, v, u}], gone: {"<k>": deletedAt}}
//
// - A unit is one independently mergeable piece of the budget:
//     'income'                 the income row
//     'c:<id>' 'e:<id>' 'b:<id>' 'g:<id>' 'd:<id>'
//                              a category / expense / bill / goal / deposit
//     'p:<YYYY-MM>:<billId>'   one bill payment
// - `u` = when this unit last changed. lifebudget.js stays unaware of it:
//   each sync diffs the budget against a snapshot from the previous sync
//   (life-sync.local.json), the same trick as src/todosync.js.
// - Merge per unit: newest `u` wins (edits). A delete is a tombstone that beats
//   every version older than it; an edit made after it wins.
// - First sync on a PC: its units are stamped with the budget file's mtime,
//   or 0 when there is no file - a fresh PC's default categories (plan 0)
//   can never beat the real budget on another PC.
// - A missing local file is never read as "everything was deleted": the PC
//   starts over as fresh and gets the budget back from its peers. An
//   unreadable one (AV / sync lock) aborts the sync before anything is written.
//
// Peer data is untrusted (another machine): every unit goes through
// lifebudget.normalize() and is dropped unless it survives unchanged.
// ============================================================================

'use strict';

const fs = require('fs');
const store = require('./lifebudget');
const { toUnits, fromUnits, validPeer } = require('./lifebudgetunits');
const { fingerprint } = require('./todosync');
const { MACHINE_RE } = require('./missionledgersync');

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tombstones older than this are forgotten (a PC offline longer may resurrect a row). */
const GONE_TTL_MS = 90 * DAY_MS;
const validStamp = (t, now) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= now + DAY_MS;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const emptyMeta = () => ({ snap: {}, u: {}, gone: {} });

function sameUnits(a, b) {
  return a.length === b.length && a.every(([k, v], i) => b[i][0] === k && fingerprint(b[i][1]) === fingerprint(v));
}

/**
 * Records what changed locally since the last sync: new / edited units get
 * `base` (normally the sync time) as their stamp, missing ones a tombstone.
 * @returns {{snap:object, u:object, gone:object}} a new meta, input untouched
 */
function stamp(units, meta, now, base = now) {
  const snap = {};
  const u = {};
  const gone = { ...meta.gone };
  for (const [k, v] of units) {
    const fp = fingerprint(v);
    snap[k] = fp;
    u[k] = meta.snap[k] === fp && validStamp(meta.u[k], now) ? meta.u[k] : base;
  }
  for (const k of Object.keys(meta.snap)) {
    if (!(k in snap)) gone[k] = Math.max(gone[k] || 0, now);
  }
  return { snap, u, gone };
}

/**
 * Merges this PC's units with the peers'. Order: this PC's first, then
 * arrivals in the order the peers list them.
 * @param {[string, object][]} local
 * @param {{u:object, gone:object}} meta from stamp()
 * @param {{units:{k,v,u}[], gone:object}[]} peers
 * @returns {{units: [string, object][], u: object, gone: object}}
 */
function merge(local, meta, peers, now) {
  const best = new Map(local.map(([k, v]) => [k, { v, u: meta.u[k] || 0 }]));
  const gone = { ...meta.gone };
  const arrivals = [];
  for (const peer of peers) {
    for (const { k, v, u } of peer.units) {
      const cur = best.get(k);
      if (!cur) arrivals.push(k);
      if (!cur || u > cur.u) best.set(k, { v, u });
    }
    for (const [k, t] of Object.entries(peer.gone)) gone[k] = Math.max(gone[k] || 0, t);
  }
  const order = [...local.map(([k]) => k), ...arrivals].filter((k) => !(gone[k] >= best.get(k).u));
  return {
    units: order.map((k) => [k, best.get(k).v]),
    u: Object.fromEntries(order.map((k) => [k, best.get(k).u])),
    gone: Object.fromEntries(Object.entries(gone).filter(([, t]) => t >= now - GONE_TTL_MS)),
  };
}

/** The previous sync's snapshot, or null on a first sync. */
function readMeta(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.v !== VERSION || ![data.snap, data.u, data.gone].every(isPlainObject)) return null;
    return { snap: data.snap, u: data.u, gone: data.gone };
  } catch {
    return null;
  }
}

/**
 * @param {{machine:string, metaFile:string, budgetFile?:string,
 *   now?:()=>number, extraPeers?:()=>object[]|null,
 *   onPublish?:(doc:{units, gone})=>void}} deps  budgetFile defaults to the
 *   store's own file. extraPeers = the cloud (src/cloudsync.js): raw peer
 *   bodies, validated here, or null while the cloud is off (no sync then).
 *   onPublish gets what this PC publishes, so the cloud can push it.
 */
function createLifeSync({ machine, metaFile, budgetFile, now = Date.now, extraPeers = () => null, onPublish = () => {} }) {
  if (!MACHINE_RE.test(machine)) throw new Error('bad machine name');

  /**
   * One sync. Throws when the local budget is unreadable (nothing written).
   * @returns {boolean} whether the local budget changed
   */
  function syncOnce() {
    const cloud = extraPeers();
    if (!cloud) return false;
    const t = now();
    const local = store.readForSync(budgetFile);
    // Rows a damaged file lost would go out as deletions to every PC. Wait for
    // the next real write, which keeps a .bak and rewrites the file whole.
    if (local.suspect) throw new Error('suspect local budget');
    const saved = local.exists ? readMeta(metaFile) : null;
    const base = !local.exists ? 0 : saved ? t : Math.floor(Math.min(local.mtimeMs, t));
    const localUnits = toUnits(local.budget);
    const stamped = stamp(localUnits, saved || emptyMeta(), t, base);
    // The cloud rows include this PC's own, so they restore a lost file too.
    const peers = cloud.map((p) => validPeer(p, t));
    const merged = merge(localUnits, stamped, peers, t);
    // normalize() may still drop a unit (a deposit whose pot another PC deleted).
    const budget = fromUnits(merged.units);
    const finalUnits = toUnits(budget);
    const changed = !sameUnits(finalUnits, localUnits);
    // Write before publishing: a failed local write must not advertise the merge.
    if (changed) store.replaceBudget(budget, budgetFile);
    const u = Object.fromEntries(finalUnits.map(([k]) => [k, merged.u[k] ?? t]));
    const snap = Object.fromEntries(finalUnits.map(([k, v]) => [k, fingerprint(v)]));
    fs.writeFileSync(metaFile, JSON.stringify({ v: VERSION, snap, u, gone: merged.gone }) + '\n', 'utf8');
    const units = finalUnits.map(([k, v]) => ({ k, v, u: u[k] }));
    onPublish({ units, gone: merged.gone });
    return changed;
  }

  return { syncOnce };
}

const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_DEBOUNCE_MS = 3000;
const FIRST_SYNC_MS = 5000;
/** fresh() before a read syncs at most this often (the panel reloads per tab / month). */
const FRESH_GAP_MS = 10 * 1000;

/**
 * The real thing for main.js: a sync every minute, soon() after a write,
 * fresh() before a read. cloud = startCloud() (src/cloudsync.js): the other
 * PCs' budgets, and a sync soon after it brings their changes. Without it
 * (no cloud config) every sync is a no-op.
 */
function startLifeSync({ cloud = null } = {}) {
  const os = require('os');
  const paths = require('./paths');
  const { machineName } = require('./missionledgersync');
  const sync = createLifeSync({
    machine: machineName(os.hostname()),
    metaFile: paths.local('life-sync.local.json'),
    ...(cloud ? cloud.hooks('life') : {}),
  });
  let lastRun = -Infinity;
  const run = () => {
    lastRun = Date.now();
    try {
      sync.syncOnce();
    } catch (err) {
      console.error('[lifesync] sync failed:', err && err.message);
    }
  };
  let timer = setTimeout(run, FIRST_SYNC_MS);
  const interval = setInterval(run, SYNC_INTERVAL_MS);
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, SYNC_DEBOUNCE_MS);
  };
  if (cloud) cloud.onPulled((scope) => scope === 'life' && soon());
  return {
    /** Debounced sync, e.g. after a write: a burst of edits publishes once. */
    soon,
    /** Pulls the other PCs' changes now, unless a sync just ran. */
    fresh() {
      if (Date.now() - lastRun >= FRESH_GAP_MS) run();
    },
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
  };
}

module.exports = { createLifeSync, startLifeSync, toUnits, fromUnits, stamp, merge, validPeer, GONE_TTL_MS };
