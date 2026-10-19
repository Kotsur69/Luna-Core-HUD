// ============================================================================
// LunaCore phone - cloud transport
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4a. Same rules as src/cloudsync.js on a PC:
//
//   pull   sync_units where scope = s and rev > cursor, pages of PAGE
//          -> cloudrows.applyRows -> the scope's mirror in IndexedDB
//   write  one unit via push_units (the server decides newest-wins), then
//          pull: the mirror only ever holds what the server holds, so a
//          write that lost to a newer one on another PC never shows as saved
//
// Login: GitHub through Supabase, PKCE, redirect back to this page. The
// session lives in supabase-js storage; logout also wipes the local mirror.
// Rows are untrusted: views validate them (todomodel.js) before rendering.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import rows from '../../src/cloudrows.js';
import * as idb from './idb.js';

/** This device in sync_units.machine (missionledgersync MACHINE_RE). */
export const MACHINE = 'iPhone';
const PAGE = 1000;
/** A runaway pull (a bug, a hostile server) stops here instead of looping. */
const MAX_PAGES = 100;
const COLUMNS = 'key,value,u,deleted_at,rev,machine';
/** The to-do list picked on this device (views/todos.js); cleared on logout. */
export const PICK_KEY = 'lunacore.todos.list';

const emptyScope = () => ({ cursor: 0, pushed: {}, mirror: {} });

/** Build-time env -> {url, publishableKey}, or null when missing or malformed. */
export function cloudConfig(env = import.meta.env) {
  return rows.parseCloudConfig({ url: env.VITE_SUPABASE_URL, publishableKey: env.VITE_SUPABASE_ANON_KEY });
}

export function createCloud(config) {
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

  async function state(scope) {
    const u = await user();
    if (!u) return emptyScope();
    return (await idb.get(stateKey(u.id, scope))) || emptyScope();
  }

  async function pullOnce(scope) {
    const gen = generation;
    const u = await user();
    if (!u) throw new Error('logged-out');
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
    return s;
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

  async function write(scope, unit) {
    const { error } = await client.rpc('push_units', { p_scope: scope, p_machine: MACHINE, p_units: [unit] });
    if (error) throw new Error('push-failed', { cause: error });
    return pull(scope);
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
      await client.auth.signOut({ scope: 'local' });
    } finally {
      await idb.clear();
      try {
        localStorage.removeItem(PICK_KEY);
      } catch {
        // Private mode: nothing was kept.
      }
    }
  }

  const onAuth = (fn) => client.auth.onAuthStateChange((event, session) => fn(session ? session.user : null));

  return { user, state, pull, write, login, logout, onAuth };
}
