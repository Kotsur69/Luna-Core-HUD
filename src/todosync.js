// ============================================================================
// LunaCore - to-do lists shared between PCs (main)
// ----------------------------------------------------------------------------
// Mati adds different to-dos on different PCs. Through the cloud
// (src/cloudsync.js, scope 'todos') every PC publishes its lists and merges
// the others', so additions ADD UP and never overwrite each other. What a PC
// publishes:
//
//   {"<project key>": {items: [todo + u], gone: {"<at>": deletedAt}}}
//
// - Identity is the item's `at` (creation ms) - the id the widget, the merge
//   in the renderer and the luna_todo_* tools already use.
// - `u` = when this item last changed. Not stored in todo.local.json: each
//   sync diffs the lists against a snapshot from the previous sync
//   (todo-sync.local.json), so every writer counts - the widget, main, and
//   Claude's MCP tools in their own process - without touching todo.js.
// - Merge per item: newest `u` wins (edits, ticks). A delete is a tombstone
//   that beats every version older than it; an edit made after it wins.
// - Project key = normalised git remote (missionrepokey.js), so the same repo
//   cloned at different paths matches. Non-repo buckets ("other") stay local.
//
// Peer data is untrusted (another machine): key, stamp and every item are
// checked; anything off is dropped, never thrown.
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { normalizeTodo, MAX_ITEMS } = require('./todo');
const { validKey, MACHINE_RE } = require('./missionledgersync');

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tombstones older than this are forgotten (a PC offline longer may resurrect an item). */
const GONE_TTL_MS = 90 * DAY_MS;
const MAX_PROJECTS = 200;
const MAX_PEER_ITEMS = MAX_ITEMS + 50;
const MAX_GONE = 2000;
const AT_RE = /^[1-9][0-9]{0,15}$/;

const validAt = (at) => Number.isSafeInteger(at) && at > 0;
const validStamp = (t, now) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= now + DAY_MS;

/** A stable digest of one item's content (key order independent). */
function fingerprint(item) {
  const sorted = Object.keys(item)
    .sort()
    .map((k) => [k, item[k]]);
  return crypto.createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/**
 * Records what changed locally since the last sync: new / edited items get
 * `base` (normally `now`) as their stamp, items missing from the list get a
 * tombstone. A project's first sync on a PC passes base 0: an old copy of an
 * item lying on this PC must not beat a newer version from the other PCs.
 * @returns {{snap:object, u:object, gone:object}} a new meta, input untouched
 */
function stamp(list, meta, now, base = now) {
  const snap = {};
  const u = {};
  const gone = { ...meta.gone };
  for (const item of list) {
    if (!validAt(item.at)) continue;
    const fp = fingerprint(item);
    snap[item.at] = fp;
    u[item.at] = meta.snap[item.at] === fp && validStamp(meta.u[item.at], now) ? meta.u[item.at] : base;
  }
  for (const at of Object.keys(meta.snap)) {
    if (!(at in snap)) gone[at] = Math.max(gone[at] || 0, now);
  }
  return { snap, u, gone };
}

/**
 * Merges this PC's list with the peers' versions of the same project.
 * @param {object[]} local this PC's list (already stamped into `meta`)
 * @param {{snap, u, gone}} meta from stamp()
 * @param {{items: object[], gone: object}[]} peers
 * @returns {{list: object[], meta: {snap, u, gone}, changed: boolean}}
 */
function merge(local, meta, peers, now) {
  const best = new Map();
  for (const item of local) if (validAt(item.at)) best.set(item.at, { item, u: meta.u[item.at] || 0 });
  const gone = { ...meta.gone };
  for (const peer of peers) {
    for (const { u, ...item } of peer.items) {
      const cur = best.get(item.at);
      if (!cur || u > cur.u) best.set(item.at, { item, u });
    }
    for (const [at, t] of Object.entries(peer.gone)) gone[at] = Math.max(gone[at] || 0, t);
  }
  const alive = (at) => best.has(at) && !(gone[at] >= best.get(at).u);
  const localAts = new Set(local.map((x) => x.at));
  // This PC's order first, then arrivals oldest first.
  const order = [
    ...local.filter((x) => validAt(x.at)).map((x) => x.at),
    ...[...best.keys()].filter((at) => !localAts.has(at)).sort((a, b) => a - b),
  ];
  const list = [
    ...local.filter((x) => !validAt(x.at)), // legacy items without an id stay, unsynced
    ...order.filter(alive).map((at) => best.get(at).item),
  ].slice(0, MAX_ITEMS);
  for (const at of Object.keys(gone)) if (gone[at] < now - GONE_TTL_MS) delete gone[at];
  const next = stamp(list, { snap: {}, u: {}, gone }, now);
  for (const item of list) if (best.has(item.at)) next.u[item.at] = best.get(item.at).u;
  const changed = list.length !== local.length || list.some((x, i) => fingerprint(x) !== fingerprint(local[i]));
  return { list, meta: { snap: next.snap, u: next.u, gone }, changed };
}

/** A peer's `projects` map -> only valid keys, items and tombstones. */
function validPeerProjects(raw, now) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, proj] of Object.entries(raw).slice(0, MAX_PROJECTS)) {
    if (!validKey(key) || key === 'other' || !proj || typeof proj !== 'object') continue;
    const items = [];
    for (const rawItem of Array.isArray(proj.items) ? proj.items.slice(0, MAX_PEER_ITEMS) : []) {
      const todo = normalizeTodo(rawItem);
      if (!todo || !validAt(todo.at) || !validStamp(rawItem.u, now)) continue;
      items.push({ ...todo, u: rawItem.u });
    }
    const gone = {};
    const rawGone = proj.gone && typeof proj.gone === 'object' ? proj.gone : {};
    for (const [at, t] of Object.entries(rawGone).slice(0, MAX_GONE)) {
      if (AT_RE.test(at) && validStamp(t, now)) gone[at] = t;
    }
    out[key] = { items, gone };
  }
  return out;
}

function readMeta(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.v === VERSION && data.projects && typeof data.projects === 'object' ? data.projects : {};
  } catch {
    return {};
  }
}

const emptyMeta = () => ({ snap: {}, u: {}, gone: {} });

/**
 * @param {{machine:string, projects:()=>{id:string,path:string}[],
 *   resolveKey:(path:string)=>string, readTodos:(id)=>object[], writeTodos:(id, list)=>boolean,
 *   metaFile:string, now?:()=>number, extraPeers?:()=>object[]|null,
 *   onPublish?:(projects:object)=>void}} deps  extraPeers = the cloud
 *   (src/cloudsync.js): raw `projects` maps, validated here, or null while
 *   the cloud is off (no sync then). onPublish gets what this PC publishes.
 */
function createTodoSync({ machine, projects, resolveKey, readTodos, writeTodos, metaFile, now = Date.now, extraPeers = () => null, onPublish = () => {} }) {
  if (!MACHINE_RE.test(machine)) throw new Error('bad machine name');

  /** Syncs every project; returns the ids whose local list changed. */
  function syncAll() {
    const cloud = extraPeers();
    if (!cloud) return [];
    const t = now();
    const peers = cloud.map((p) => validPeerProjects(p, t));
    const metas = readMeta(metaFile);
    const published = {};
    const changed = [];
    for (const { id, path: projectPath } of projects()) {
      const key = resolveKey(projectPath || '', id);
      if (!validKey(key) || key === 'other' || published[key]) continue;
      // A repo key here may be "local:<id>" on a PC without the folder (and the
      // other way round): read and publish under both so they always meet.
      const alias = syncKey(null, id);
      const keysFor = alias && alias !== key ? [key, alias] : [key];
      const local = readTodos(id);
      const prev = metas[key];
      const stamped = stamp(local, prev || emptyMeta(), t, prev ? t : 0);
      const theirs = peers.flatMap((p) => keysFor.map((k) => p[k]).filter(Boolean));
      const out = merge(local, stamped, theirs, t);
      // Write before publishing: a failed local write must not advertise the merge.
      if (out.changed && !writeTodos(id, out.list)) continue;
      if (out.changed) changed.push(id);
      metas[key] = out.meta;
      const mine = {
        items: out.list.filter((x) => validAt(x.at)).map((x) => ({ ...x, u: out.meta.u[x.at] })),
        gone: out.meta.gone,
      };
      for (const k of keysFor) published[k] = mine;
    }
    fs.writeFileSync(metaFile, JSON.stringify({ v: VERSION, projects: metas }) + '\n', 'utf8');
    onPublish(published);
    return changed;
  }

  return { syncAll };
}

/**
 * The repo key when the folder is a repo here; otherwise the LunaCore project
 * id, which is the same on every PC - a project whose folder is missing on
 * this PC (or is not a git repo) must still meet its list on the others.
 */
function syncKey(repoKey, projectId) {
  if (validKey(repoKey) && repoKey !== 'other') return repoKey;
  const key = `local:${projectId}`;
  return typeof projectId === 'string' && projectId && validKey(key) ? key : null;
}

const SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_DEBOUNCE_MS = 3000;
const FIRST_SYNC_MS = 5000;

/**
 * The real thing for main.js: project keys exactly as the Claude ledger uses
 * them, a sync every minute, and soon() after any read or write of a list.
 * onChanged(ids) gets the project ids whose list changed.
 * cloud = startCloud() (src/cloudsync.js): the other PCs' lists, and a sync
 * soon after it brings their changes. Without it every sync is a no-op.
 * @param {{getProjects:()=>{id:string,path:string}[], onChanged:(ids:string[])=>void, cloud?:object}} opts
 */
function startTodoSync({ getProjects, onChanged, cloud = null }) {
  const os = require('os');
  const paths = require('./paths');
  const { readTodos, writeTodos } = require('./todo');
  const { machineName } = require('./missionledgersync');
  const projectStore = require('./missionprojects');
  const { createRepoKeys } = require('./missionrepokey');
  const keys = createRepoKeys({ aliases: () => projectStore.pinnedAliases(projectStore.aliasEntries(projectStore.loadProjects())) });
  const sync = createTodoSync({
    machine: machineName(os.hostname()),
    projects: () => (getProjects() || []).map((p) => ({ id: p.id, path: p.path })),
    resolveKey: (p, id) => syncKey(keys.resolve(p).key, id),
    readTodos,
    writeTodos,
    metaFile: paths.local('todo-sync.local.json'),
    ...(cloud ? cloud.hooks('todos') : {}),
  });
  const run = () => {
    try {
      const ids = sync.syncAll();
      if (ids.length) onChanged(ids);
    } catch (err) {
      console.error('[todosync] sync failed:', err && err.message);
    }
  };
  let timer = setTimeout(run, FIRST_SYNC_MS);
  const interval = setInterval(run, SYNC_INTERVAL_MS);
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, SYNC_DEBOUNCE_MS);
  };
  if (cloud) cloud.onPulled((scope) => scope === 'todos' && soon());
  return {
    /** Debounced sync, e.g. after a write: a burst of edits publishes once. */
    soon,
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
    },
  };
}

module.exports = { createTodoSync, startTodoSync, syncKey, stamp, merge, fingerprint, validPeerProjects, GONE_TTL_MS };
