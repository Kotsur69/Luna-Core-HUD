// ============================================================================
// LunaCore phone - cloud transport
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4a. Same rules as src/cloudsync.js on a PC:
//
//   pull   sync_units where scope = s and rev > cursor, pages of PAGE
//          -> cloudrows.applyRows -> the scope's mirror in IndexedDB
//   write  units via push_units (the server decides newest-wins), then
//          pull: the mirror only ever holds what the server holds, so a
//          write that lost to a newer one on another PC never shows as saved
//
// Login: GitHub through Supabase, PKCE, redirect back to this page. The
// session lives in supabase-js storage; logout also wipes the local mirror.
// Rows are untrusted: views validate them (todomodel.js) before rendering.
//
// snapshots(kind) reads every PC's `snapshots` row of a kind (phase 4c; the
// phone writes none) and keeps the last answer in IndexedDB for offline use.
//
// Offline (phase 4d): a write lands in the scope's outbox first (outbox.js),
// every pull pushes the outbox before it reads, and views get the mirror with
// the outbox laid over it. onChange() is the realtime feed: an event only
// says "pull again" - its payload is never read.
//
// google(body) calls the `google` server function (phase 5: calendar and
// mail) and keeps the last good read for offline use, like snapshots.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import rows from '../../src/cloudrows.js';
import * as idb from './idb.js';
import * as hostkey from './hostkey.js';
import * as outbox from './outbox.js';
import { PLACE_KEY } from './weather.js';

/** This device in sync_units.machine (missionledgersync MACHINE_RE). */
export const MACHINE = 'iPhone';
const PAGE = 1000;
/** The server's per-call cap (push_units rejects more than 500 units). */
const PUSH_MAX = 500;
/** A runaway pull (a bug, a hostile server) stops here instead of looping. */
const MAX_PAGES = 100;
const COLUMNS = 'key,value,u,deleted_at,rev,machine';
const SNAPSHOT_KINDS = new Set(['news', 'ledger', 'yazio', 'usage', 'repos', 'godmode', 'host']);
/** cloudsnapshots.js MAX_ROWS: more machines than Mati will ever own. */
const MAX_SNAPSHOTS = 16;
/** cloudsnapshots.js MAX_BYTES: a PC never puts more, so a longer row is junk (JSON length <= byte length). */
const MAX_SNAPSHOT_CHARS = 512 * 1024;
/** The to-do list picked on this device (views/todos.js); cleared on logout. */
export const PICK_KEY = 'lunacore.todos.list';
/** Scopes the phone writes to (and so keeps an outbox for). */
const WRITE_SCOPES = ['todos', 'life'];
/** Actions of the `google` server function (supabase/functions/google). */
const GOOGLE_ACTIONS = new Set(['events', 'create', 'mail']);

const emptyScope = () => ({ cursor: 0, pushed: {}, mirror: {} });

/** Build-time env -> {url, publishableKey}, or null when missing or malformed. */
export function cloudConfig(env = import.meta.env) {
  return rows.parseCloudConfig({ url: env.VITE_SUPABASE_URL, publishableKey: env.VITE_SUPABASE_ANON_KEY });
}

/**
 * @param {{url: string, publishableKey: string}} config
 * @param {{onPending?: (n: number) => void, onRejected?: () => void}} [hooks]
 *   onPending: units waiting to be sent changed; onRejected: the server refused queued units (dropped)
 */
export function createCloud(config, { onPending = () => {}, onRejected = () => {} } = {}) {
  const client = createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const pulling = new Map();
  /** Bumped on logout: a pull from before it never writes to IndexedDB again. */
  let generation = 0;

  async function user() {
    const { data } = await client.auth.getSession();
    return data.session ? data.session.user : null;
  }

  const stateKey = (uid, scope) => `scope:${uid}:${scope}`;
  const outKey = (uid, scope) => `out:${uid}:${scope}`;

  const waiting = new Map();
  function count(scope, box) {
    waiting.set(scope, Object.keys(box).length);
    onPending([...waiting.values()].reduce((a, b) => a + b, 0));
  }

  let outboxLock = Promise.resolve();
  /**
   * Outbox read-modify-write, one at a time across scopes. Only IndexedDB
   * runs under the lock, never the network, so a write offline never waits
   * for a hanging push.
   */
  function mutate(uid, scope, fn) {
    const gen = generation;
    const run = outboxLock.then(async () => {
      if (gen !== generation) throw new Error('logged-out');
      const box = (await idb.get(outKey(uid, scope))) || {};
      const next = fn(box);
      // Checked again: a logout between the read and the put must not bring the outbox back.
      if (gen !== generation) throw new Error('logged-out');
      if (next !== box) await idb.put(outKey(uid, scope), next);
      count(scope, next);
      return next;
    });
    outboxLock = run.catch(() => {});
    return run;
  }

  /** The scope as views see it: the server mirror with the outbox laid over it. */
  const shown = (s, box) => ({ ...s, mirror: outbox.overlay(s.mirror, box), pending: Object.keys(box).length });

  async function state(scope) {
    const u = await user();
    if (!u) return shown(emptyScope(), {});
    const s = (await idb.get(stateKey(u.id, scope))) || emptyScope();
    return shown(s, (await idb.get(outKey(u.id, scope))) || {});
  }

  /**
   * One push_units call. push_units is atomic, so when the server refuses a
   * batch it is split in halves until only the units refused on their own
   * are dropped. Network trouble throws and keeps everything queued.
   */
  async function send(uid, scope, batch) {
    const { error, status } = await client.rpc('push_units', { p_scope: scope, p_machine: MACHINE, p_units: batch });
    if (!error) return;
    if (!outbox.isRejected(status)) throw new Error('push-failed', { cause: error });
    if (batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await send(uid, scope, batch.slice(0, half));
      await send(uid, scope, batch.slice(half));
      return;
    }
    await mutate(uid, scope, (box) => outbox.without(box, batch));
    onRejected();
  }

  /** Sends the scope's outbox, PUSH_MAX units per call. */
  async function flush(uid, scope) {
    const queued = Object.values((await idb.get(outKey(uid, scope))) || {});
    for (let i = 0; i < queued.length; i += PUSH_MAX) await send(uid, scope, queued.slice(i, i + PUSH_MAX));
  }

  async function pullOnce(scope) {
    const gen = generation;
    const u = await user();
    if (!u) throw new Error('logged-out');
    if (WRITE_SCOPES.includes(scope)) {
      // A push that can't go out (offline, 5xx) must not stop the read: the
      // units stay queued and `pending` shows them.
      await flush(u.id, scope).catch((err) => {
        if (err.message !== 'push-failed') throw err;
      });
    }
    let s = (await idb.get(stateKey(u.id, scope))) || emptyScope();
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await client
        .from('sync_units')
        .select(COLUMNS)
        .eq('scope', scope)
        .gt('rev', s.cursor)
        .order('rev', { ascending: true })
        .limit(PAGE);
      if (error || !Array.isArray(data)) throw new Error('pull-failed', { cause: error });
      // Logged out while this page was on its way: never write it back.
      if (gen !== generation) throw new Error('logged-out');
      if (!data.length) break;
      s = rows.applyRows(s, data);
      await idb.put(stateKey(u.id, scope), s);
      if (data.length < PAGE) break;
    }
    if (!WRITE_SCOPES.includes(scope)) return shown(s, {});
    return shown(s, await mutate(u.id, scope, (box) => outbox.prune(box, s.mirror)));
  }

  /**
   * Pulls of a scope run one after another, and each one starts only after
   * the previous one ended. Sharing an in-flight pull instead would let a
   * write's pull return rows read before the write landed.
   */
  function pull(scope) {
    const prev = pulling.get(scope) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => pullOnce(scope));
    pulling.set(scope, next);
    next.then(
      () => pulling.get(scope) === next && pulling.delete(scope),
      () => pulling.get(scope) === next && pulling.delete(scope),
    );
    return next;
  }

  /**
   * One unit or a list (a budget op can change several rows). Queued first,
   * then sent by a pull; `queued` = something is still waiting to be sent
   * (or the read after the push failed, so it isn't confirmed yet).
   * Throws only when logged out or IndexedDB fails (then nothing was kept).
   */
  async function write(scope, units) {
    if (!WRITE_SCOPES.includes(scope)) throw new Error('bad-scope');
    const u = await user();
    if (!u) throw new Error('logged-out');
    await mutate(u.id, scope, (box) => outbox.enqueue(box, Array.isArray(units) ? units : [units]));
    try {
      const s = await pull(scope);
      return { ...s, queued: s.pending > 0 };
    } catch (err) {
      if (err.message === 'logged-out') throw err;
      return { ...(await state(scope)), queued: true };
    }
  }

  /** Units waiting to be sent, all scopes (also refreshes the onPending count). */
  async function pending() {
    const u = await user();
    if (!u) return 0;
    let n = 0;
    for (const scope of WRITE_SCOPES) {
      const box = (await idb.get(outKey(u.id, scope))) || {};
      count(scope, box);
      n += Object.keys(box).length;
    }
    return n;
  }

  /** Pulls every writable scope, which pushes its queue first (back online, back in the foreground). */
  async function flushAll() {
    for (const scope of WRITE_SCOPES) await pull(scope).catch(() => {});
  }

  /**
   * Realtime: `fn` runs on any change to this account's rows (RLS filters
   * the feed). The payload is ignored - pulls stay the single read path.
   * @returns {() => void} unsubscribe
   */
  function onChange(fn) {
    const channel = client
      .channel('lunacore-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_units' }, () => fn())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'snapshots' }, () => fn())
      .subscribe();
    return () => client.removeChannel(channel);
  }

  const snapKey = (uid, kind) => `snap:${uid}:${kind}`;

  /** Every machine's row of `kind`, newest first; raw and untrusted (snapmodel.js parses). */
  async function snapshots(kind) {
    if (!SNAPSHOT_KINDS.has(kind)) throw new Error('bad-kind');
    const gen = generation;
    const u = await user();
    if (!u) throw new Error('logged-out');
    const { data, error } = await client
      .from('snapshots')
      .select('machine,data,updated_at')
      .eq('kind', kind)
      .order('updated_at', { ascending: false })
      .limit(MAX_SNAPSHOTS);
    if (error || !Array.isArray(data)) throw new Error('snapshots-failed', { cause: error });
    if (gen !== generation) throw new Error('logged-out');
    const fit = data.filter((r) => r && JSON.stringify(r.data ?? null).length <= MAX_SNAPSHOT_CHARS);
    await idb.put(snapKey(u.id, kind), fit);
    return fit;
  }

  /** The last snapshots(kind) answer kept on this device, or []. */
  async function cachedSnapshots(kind) {
    const u = await user();
    return (u && (await idb.get(snapKey(u.id, kind)))) || [];
  }

  const googleKey = (uid, action) => `google:${uid}:${action}`;

  /**
   * One call to the `google` server function (phase 5). Throws an Error whose
   * message is the function's reason ('not-configured', 'google-auth', ...)
   * or 'offline'. A successful read is kept for cachedGoogle().
   * @param {{action: 'events'|'create'|'mail'}} body
   */
  async function google(body) {
    if (!body || !GOOGLE_ACTIONS.has(body.action)) throw new Error('bad-request');
    const gen = generation;
    const u = await user();
    if (!u) throw new Error('logged-out');
    const { data, error } = await client.functions.invoke('google', { body });
    if (gen !== generation) throw new Error('logged-out');
    if (error) {
      // A fetch error while online is the browser refusing the reply: this page's
      // origin is missing from the function's ALLOWED_ORIGINS (or the function is down).
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      let reason = error.name === 'FunctionsFetchError' ? (online ? 'unreachable' : 'offline') : 'google-failed';
      // Not deployed yet: the gateway's own 404 has no `error` field.
      if (error.context && error.context.status === 404) reason = 'not-configured';
      try {
        const reply = await error.context.json();
        if (reply && typeof reply.error === 'string' && reply.error.length <= 40) reason = reply.error;
      } catch {
        // No JSON body (offline, a gateway page): keep the generic reason.
      }
      throw new Error(reason);
    }
    // A full IndexedDB only loses the offline copy, never the fresh answer.
    if (body.action !== 'create') await idb.put(googleKey(u.id, body.action), { at: Date.now(), data }).catch(() => {});
    return data;
  }

  /** The last good google({action}) answer on this device: {at, data} or null. */
  async function cachedGoogle(action) {
    const u = await user();
    return (u && (await idb.get(googleKey(u.id, action)))) || null;
  }

  function login() {
    return client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: `${location.origin}${location.pathname}` },
    });
  }

  /** Wipes this device's copy even when the server call fails (offline). */
  async function logout() {
    generation++;
    try {
      await client.removeAllChannels().catch(() => {});
      await client.auth.signOut({ scope: 'local' });
    } finally {
      // An outbox write already under the lock finishes before the wipe.
      await outboxLock;
      // The host session key goes first: wipe() also drops it from memory.
      await hostkey.wipe().catch(() => {});
      await idb.clear();
      try {
        localStorage.removeItem(PICK_KEY);
        localStorage.removeItem(PLACE_KEY);
      } catch {
        // Private mode: nothing was kept.
      }
    }
  }

  const onAuth = (fn) => client.auth.onAuthStateChange((event, session) => fn(session ? session.user : null));

  return { user, state, pull, write, pending, flushAll, onChange, snapshots, cachedSnapshots, google, cachedGoogle, login, logout, onAuth };
}
