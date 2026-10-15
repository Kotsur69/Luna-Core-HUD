// ============================================================================
// LunaCore - machine-independent settings shared through the cloud (main)
// ----------------------------------------------------------------------------
// The cloud's `config` scope (docs/CLOUD_SYNC_PLAN.md, phase 2b). Same unit
// model and merge rules as src/lifesync.js - newest `u` wins per unit, a
// delete is a tombstone - but there is no folder transport: no cloud, no sync.
//
// Each kind of setting is a provider:
//   name                 'projects', ...
//   owns(k)              whether a unit key is its own (keys carry a prefix)
//   valid(k, v)          a cloud value -> clean value, or null (untrusted input)
//   read(now)            {units: [[k, v]], base, gone?} - base stamps the first
//                        sync (0 = this PC never wins), gone seeds tombstones;
//                        throws when the local file is unreadable
//   resolve?(merged, local)  the units to keep (default: the merge as is)
//   write(units, local)  store them
//
// State: config-sync.local.json = {v:1, providers: {<name>: {snap, u, gone}}}.
// A provider that fails to read or write is skipped this round; the others go on.
// ============================================================================

'use strict';

const fs = require('fs');
const { stamp, merge } = require('./lifesync');
const { writeAtomic } = require('./projectsync');
const { fingerprint } = require('./todosync');
const { MAX_KEY } = require('./cloudrows');
const { MAX_DOC_BYTES } = require('./docsync');

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_UNITS = 5000;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validStamp = (t, now) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= now + DAY_MS;
const validKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY && k !== '__proto__' && !Object.hasOwn(Object.prototype, k);
const emptyMeta = () => ({ snap: {}, u: {}, gone: {} });
/**
 * Whether the server would take the unit. One refused row fails its whole
 * push batch on every retry, so a too-long key or too-big value stays local.
 */
const pushable = (k, v) => k.length <= MAX_KEY && Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_DOC_BYTES;

function readMetas(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.v !== VERSION || !isPlainObject(data.providers)) return {};
    const out = {};
    for (const [name, m] of Object.entries(data.providers)) {
      if (isPlainObject(m) && [m.snap, m.u, m.gone].every(isPlainObject)) out[name] = m;
    }
    return out;
  } catch {
    return {};
  }
}

/** A raw cloud peer {units, gone} -> the part one provider owns, validated by it. */
function peerFor(provider, peer, now) {
  const units = [];
  const seen = new Set();
  for (const x of Array.isArray(peer && peer.units) ? peer.units.slice(0, MAX_UNITS) : []) {
    if (!x || !validKey(x.k) || seen.has(x.k) || !provider.owns(x.k) || !validStamp(x.u, now)) continue;
    const v = provider.valid(x.k, x.v);
    if (v === null || v === undefined) continue;
    seen.add(x.k);
    units.push({ k: x.k, v, u: x.u });
  }
  const gone = {};
  for (const [k, t] of Object.entries(isPlainObject(peer && peer.gone) ? peer.gone : {}).slice(0, MAX_UNITS)) {
    if (validKey(k) && provider.owns(k) && validStamp(t, now)) gone[k] = t;
  }
  return { units, gone };
}

const sameUnits = (a, b) => a.length === b.length && a.every(([k, v], i) => b[i][0] === k && fingerprint(b[i][1]) === fingerprint(v));

/**
 * @param {{providers: object[], metaFile: string, now?: () => number,
 *   extraPeers?: () => object[]|null, onPublish?: (doc: {units, gone}) => void}} deps
 *   extraPeers = the cloud's raw `config` peers, or null while it is off.
 */
function createConfigSync({ providers, metaFile, now = Date.now, extraPeers = () => null, onPublish = () => {} }) {
  /** One sync. @returns {string[]} names of the providers whose local data changed */
  function syncOnce() {
    const cloud = extraPeers();
    if (!cloud) return [];
    const t = now();
    const metas = readMetas(metaFile);
    const changed = [];
    const units = [];
    const gone = {};
    for (const provider of providers) {
      let local;
      try {
        local = provider.read(t);
      } catch (err) {
        console.error(`[configsync] ${provider.name}: local data unreadable, skipped:`, err && (err.code || err.message));
        continue;
      }
      const prev = metas[provider.name];
      const stamped = stamp(local.units, prev || { ...emptyMeta(), gone: local.gone || {} }, t, prev ? t : local.base);
      const merged = merge(local.units, stamped, cloud.map((p) => peerFor(provider, p, t)), t);
      const final = provider.resolve ? provider.resolve(merged.units, local) : merged.units;
      if (!sameUnits(final, local.units)) {
        // Write before publishing: a failed local write must not advertise the merge.
        try {
          provider.write(final, local);
        } catch (err) {
          console.error(`[configsync] ${provider.name}: write failed:`, err && (err.code || err.message));
          continue;
        }
        changed.push(provider.name);
      }
      const u = Object.fromEntries(final.map(([k]) => [k, merged.u[k] ?? t]));
      metas[provider.name] = { snap: Object.fromEntries(final.map(([k, v]) => [k, fingerprint(v)])), u, gone: merged.gone };
      for (const [k, v] of final) {
        if (pushable(k, v)) units.push({ k, v, u: u[k] });
        else console.error(`[configsync] ${provider.name}: ${k.slice(0, 60)} too big for the cloud, kept local`);
      }
      for (const [k, t] of Object.entries(merged.gone)) if (k.length <= MAX_KEY) gone[k] = t;
    }
    // Atomic: a torn meta file would read as a first sync and lose local deletions.
    writeAtomic(metaFile, JSON.stringify({ v: VERSION, providers: metas }) + '\n');
    onPublish({ units, gone });
    return changed;
  }

  return { syncOnce };
}

const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_DEBOUNCE_MS = 3000;
const FIRST_SYNC_MS = 5000;

/**
 * The real thing for main.js: a sync every minute, soon() after a local
 * change, and one soon after the cloud brings another PC's changes.
 * onChanged(names) gets the providers whose local data changed.
 * @param {{cloud: object, onChanged: (names: string[]) => void}} opts
 */
function startConfigSync({ cloud, onChanged }) {
  const paths = require('./paths');
  const { projectFiles } = require('./projects');
  const { createProjectsProvider } = require('./projectsync');
  const { docProviders } = require('./docsync');
  const { createNewsProvider, createMissionProjectsProvider } = require('./missionsync');
  paths.ensureUserDir();
  const sync = createConfigSync({
    providers: [
      createProjectsProvider(projectFiles()),
      ...docProviders((name) => paths.local(name)),
      createNewsProvider(paths.local('mission-news.local.json')),
      createMissionProjectsProvider(paths.local('mission-projects.local.json')),
    ],
    metaFile: paths.local('config-sync.local.json'),
    ...cloud.hooks('config'),
  });
  const run = () => {
    try {
      const names = sync.syncOnce();
      if (names.length) onChanged(names);
    } catch (err) {
      console.error('[configsync] sync failed:', err && err.message);
    }
  };
  let timer = setTimeout(run, FIRST_SYNC_MS);
  const interval = setInterval(run, SYNC_INTERVAL_MS);
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, SYNC_DEBOUNCE_MS);
  };
  cloud.onPulled((scope) => scope === 'config' && soon());
  return {
    /** Debounced sync, e.g. after a project was added or removed here. */
    soon,
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
  };
}

module.exports = { createConfigSync, startConfigSync };
