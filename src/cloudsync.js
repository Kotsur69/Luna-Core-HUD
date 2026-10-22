// ============================================================================
// LunaCore - cloud sync transport (main)
// ----------------------------------------------------------------------------
// Supabase (docs/DONE_CLOUD_SYNC_PLAN.md, phase 2a) as one more peer for
// lifesync.js and todosync.js. Those stay synchronous and keep their merge
// rules; this file only moves rows:
//
//   pull   sync_units where scope = s and rev > cursor, pages of PAGE
//          -> mirror (cloudrows.applyRows) -> peers(s) for the next local sync
//   push   what a local sync published (published(s, doc)), minus what the
//          cloud already has (`pushed`), via push_units in batches of BATCH
//
// The server decides newest-wins (push_units), so a push never needs a lock.
// The cursor and `pushed` move only after the call worked: offline just means
// the next run sends what is still missing. Rows written by this machine do
// not count as news, so our own push does not trigger a local re-sync.
//
// State: cloud-sync.local.json = {v:1, user, scopes: {<scope>: {cursor, pushed, mirror}}}.
// It belongs to one user: a different user id starts from scratch, and
// reset() (logout) deletes it and cancels a run that is still in flight.
// ============================================================================

'use strict';

const fs = require('fs');
const rows = require('./cloudrows');
const { createSnapshots, SNAPSHOTS_OFF } = require('./cloudsnapshots');

const VERSION = 1;
const SCOPES = ['life', 'todos', 'config'];
const PAGE = 1000;
/** push_units refuses more than 500 units per call. */
const BATCH = 500;
/** A runaway pull (a bug, a hostile server) stops here instead of looping. */
const MAX_PAGES = 100;
const COLUMNS = 'key,value,u,deleted_at,rev,machine';

// configsync.js publishes the same {units, gone} body as lifesync.js.
const PEER_OF = { life: rows.lifePeer, todos: rows.todoPeer, config: rows.lifePeer };
const UNITS_OF = { life: rows.lifeUnits, todos: rows.todoUnits, config: rows.lifeUnits };

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const emptyScope = () => ({ cursor: 0, pushed: {}, mirror: {} });
const emptyState = () => Object.fromEntries(SCOPES.map((s) => [s, emptyScope()]));

function validScope(x) {
  return isPlainObject(x) && Number.isSafeInteger(x.cursor) && x.cursor >= 0 && isPlainObject(x.pushed) && isPlainObject(x.mirror);
}

/** @returns {{user: string|null, scopes: object}} */
function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.v === VERSION && isPlainObject(data.scopes)) {
      return {
        user: typeof data.user === 'string' ? data.user : null,
        scopes: Object.fromEntries(SCOPES.map((s) => [s, validScope(data.scopes[s]) ? data.scopes[s] : emptyScope()])),
      };
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[cloudsync] state unreadable, starting over:', err.code || err.name);
  }
  return { user: null, scopes: emptyState() };
}

/** Thrown inside a run that a reset() overtook: it must not write anything. */
class Cancelled extends Error {}

/**
 * @param {{client: object, machine: string, stateFile: string, userId?: () => string|null,
 *   onPulled?: (scope: string) => void, now?: () => number}} deps
 *   client = a logged-in supabase-js client (or a fake with the same calls).
 *   userId() = the logged-in user's id; the state is kept only for that user.
 *   onPulled(scope) fires after a pull brought rows from another machine.
 */
function createCloudSync({ client, machine, stateFile, userId = () => null, onPulled = () => {}, now = Date.now }) {
  const saved = readState(stateFile);
  let owner = saved.user;
  let state = saved.scopes;
  let gen = 0; // bumped by reset(): a run from an older generation stops writing
  // This session's first successful pull: before it, peers() is null so a
  // fresh PC cannot publish its default budget over the real one blind.
  let ready = false;
  let units = {}; // scope -> latest published units
  let lastSync = null;
  let error = null;
  let queue = Promise.resolve();

  function save() {
    const tmp = stateFile.replace(/(\.local)?\.json$/, '.tmp.local.json');
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, user: owner, scopes: state }) + '\n', 'utf8');
    fs.renameSync(tmp, stateFile);
  }

  /** @returns {Promise<boolean>} whether another machine's rows arrived */
  async function pull(scope, alive) {
    let foreign = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error: err } = await client
        .from('sync_units')
        .select(COLUMNS)
        .eq('scope', scope)
        .gt('rev', state[scope].cursor)
        .order('rev', { ascending: true })
        .limit(PAGE);
      alive();
      if (err || !Array.isArray(data)) throw new Error('pull-failed', { cause: err });
      if (!data.length) break;
      foreign ||= data.some((r) => typeof r.machine !== 'string' || r.machine.toLowerCase() !== machine.toLowerCase());
      state = { ...state, [scope]: rows.applyRows(state[scope], data, now()) };
      save();
      if (data.length < PAGE) break;
    }
    return foreign;
  }

  async function push(scope, alive) {
    const todo = rows.unpushed(units[scope] || [], state[scope].pushed);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const { error: err } = await client.rpc('push_units', { p_scope: scope, p_machine: machine, p_units: batch });
      alive();
      if (err) throw new Error('push-failed', { cause: err });
      const pushed = { ...state[scope].pushed };
      for (const x of batch) pushed[x.k] = Math.max(pushed[x.k] || 0, x.u);
      state = { ...state, [scope]: { ...state[scope], pushed } };
      save();
    }
  }

  /** @param {number} mine the generation syncNow() was called in */
  async function run(mine) {
    const alive = () => {
      if (mine !== gen) throw new Cancelled();
    };
    try {
      alive();
      const uid = userId();
      if (uid !== owner) {
        // Another account (or the first login): nothing of the old state applies.
        owner = uid;
        state = emptyState();
        units = {};
        ready = false;
      }
      const news = [];
      for (const scope of SCOPES) if (await pull(scope, alive)) news.push(scope);
      ready = true;
      for (const scope of SCOPES) await push(scope, alive);
      lastSync = now();
      error = null;
      news.forEach((scope) => onPulled(scope));
      return { ok: true };
    } catch (err) {
      if (err instanceof Cancelled) return { ok: false, reason: 'logged-out' };
      error = err && /^(pull|push)-failed$/.test(err.message) ? err.message : 'failed';
      // PostgREST's code + message (e.g. 22P02 invalid input syntax): no token, no row data.
      const cause = (err && err.cause) || err;
      console.error(`[cloudsync] ${error}:`, (cause && (cause.code || cause.name)) || 'error', (cause && cause.message) || '');
      return { ok: false, reason: error };
    }
  }

  return {
    /** One pull + push. Calls queue up: never two runs at once. */
    syncNow() {
      const mine = gen;
      const next = queue.then(() => run(mine));
      queue = next;
      return next;
    },
    /** Raw peer bodies for lifesync / todosync, or null before the first pull. */
    peers(scope) {
      return ready ? [PEER_OF[scope](state[scope].mirror)] : null;
    },
    /** What a local sync published; pushed by the next syncNow(). */
    published(scope, doc) {
      units = { ...units, [scope]: UNITS_OF[scope](doc) };
    },
    status() {
      const pending = SCOPES.reduce((n, s) => n + rows.unpushed(units[s] || [], state[s].pushed).length, 0);
      return { ready, lastSync, pending, error };
    },
    /** Logout: the state belongs to the user that is gone. */
    reset() {
      gen++;
      owner = null;
      state = emptyState();
      units = {};
      ready = false;
      lastSync = null;
      error = null;
      fs.rmSync(stateFile, { force: true });
    },
  };
}

const POLL_MS = 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;
const LIVE_DEBOUNCE_MS = 1500;

/** What the rest of the app sees while config/cloud.local.json is missing or bad. */
const CLOUD_OFF = {
  hooks: () => ({ extraPeers: () => null, onPublish: () => {} }),
  onPulled: () => {},
  status: () => ({ configured: false, loggedIn: false }),
  login: async () => ({ ok: false, reason: 'not-configured' }),
  logout: async () => {},
  syncNow: async () => ({ ok: false, reason: 'not-configured' }),
  snapshots: SNAPSHOTS_OFF,
  client: null,
};

/**
 * The real thing for main.js: login (cloudauth.js), the transport above, a
 * live subscription that only triggers a pull, a fallback poll, and the
 * hooks lifesync / todosync take. No cloud.local.json -> CLOUD_OFF, and the
 * folder sync carries on exactly as before.
 * @param {{machine: string}} opts
 */
function startCloud({ machine }) {
  const paths = require('./paths');
  const { createCloudAuth } = require('./cloudauth');
  let config = null;
  try {
    config = rows.parseCloudConfig(JSON.parse(fs.readFileSync(paths.local('cloud.local.json'), 'utf8')));
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[cloudsync] cloud.local.json unreadable:', err.code || err.name);
  }
  if (!config) return CLOUD_OFF;

  paths.ensureUserDir();
  const auth = createCloudAuth({ config, sessionFile: paths.local('cloud-session.local.json') });
  const pulledListeners = [];
  const notify = (scope) => pulledListeners.forEach((cb) => cb(scope));
  const core = createCloudSync({
    client: auth.client,
    machine,
    stateFile: paths.local('cloud-sync.local.json'),
    userId: () => auth.userId(),
    onPulled: notify,
  });
  const snapshots = createSnapshots({ client: auth.client, machine, loggedIn: () => auth.status().loggedIn });
  let channel = null;
  let pushTimer = null;
  let liveTimer = null;

  async function syncNow() {
    if (!auth.status().loggedIn) return { ok: false, reason: 'logged-out' };
    const wasReady = core.status().ready;
    const res = await core.syncNow();
    // The session's first pull: let both local syncs run now, so they merge
    // the cloud and publish this PC's units (the first upload on a new PC).
    if (!wasReady && core.status().ready) SCOPES.forEach(notify);
    return res;
  }
  const later = (timer, ms) => {
    clearTimeout(timer);
    return setTimeout(() => syncNow(), ms);
  };

  function subscribe() {
    if (channel) return;
    channel = auth.client
      .channel('lunacore-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_units' }, () => {
        liveTimer = later(liveTimer, LIVE_DEBOUNCE_MS);
      })
      .subscribe();
  }
  function unsubscribe() {
    if (channel) auth.client.removeChannel(channel);
    channel = null;
  }

  auth.onChange((loggedIn) => {
    // Outside supabase-js's auth callback: it must not await other auth calls.
    setTimeout(() => {
      // Any auth change (logout, another account) starts the snapshot cache over.
      snapshots.reset();
      if (loggedIn) {
        subscribe();
        syncNow();
      } else {
        unsubscribe();
        core.reset();
      }
    }, 0);
  });
  auth.init().then(() => {
    if (auth.status().loggedIn) {
      subscribe();
      syncNow();
    }
  });
  setInterval(() => syncNow(), POLL_MS).unref();

  return {
    /** extraPeers / onPublish for createLifeSync ('life') or createTodoSync ('todos'). */
    hooks: (scope) => ({
      extraPeers: () => (auth.status().loggedIn ? core.peers(scope) : null),
      onPublish: (doc) => {
        core.published(scope, doc);
        pushTimer = later(pushTimer, PUSH_DEBOUNCE_MS);
      },
    }),
    /** cb(scope) when the cloud brought another machine's changes. */
    onPulled: (cb) => pulledListeners.push(cb),
    status: () => ({ ...auth.status(), ...core.status() }),
    login: () => auth.login(),
    logout: () => auth.logout(),
    syncNow,
    /** One row per machine for the ledger / news / YAZIO (cloudsnapshots.js). */
    snapshots,
    /** The logged-in client, for the host's command loop (src/hostcommands.js). */
    client: auth.client,
  };
}

module.exports = { createCloudSync, startCloud, SCOPES, PAGE, BATCH };
