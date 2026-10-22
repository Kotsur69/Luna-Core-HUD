// ============================================================================
// LunaCore - cloud snapshots (main)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md, phase 2c. The `snapshots` table holds one row per
// (kind, machine), written only by that machine: the Claude ledger, the last
// news briefing, the YAZIO body data. No merging - a reader takes every other
// machine's row as it is and validates it like a peer file.
//
//   put(kind, data)  upsert this PC's row; skipped while the content is the
//                    same as the last successful put; puts of one kind run
//                    one at a time, so an older one never lands last
//   list(kind)       the other machines' rows, newest first, cached for
//                    TTL_MS; a failed read keeps the last good answer
//   machines()       every machine with rows and its last update (Settings)
//   forget(machine)  delete all rows of another machine (a retired PC);
//                    never this PC's own key or its legacy key
//   migrate()        move this PC's rows from its legacy key (before the
//                    collision-free key, missionledgersync.js) to the current
//                    one: copy, then delete; a no-op once done
//
// reset() (logout, account switch) bumps a generation: a call still in
// flight from before it never writes the cache or `lastPut` afterwards.
// Rows from the cloud are untrusted input: the caller validates `data`.
// ============================================================================

'use strict';

const KINDS = new Set(['ledger', 'news', 'yazio', 'usage', 'repos', 'godmode', 'host']);
/** The column check is pg_column_size(data) < 1 MiB; JSON text this size stays well under. */
const MAX_BYTES = 512 * 1024;
const TTL_MS = 60 * 1000;
/** More machines than Mati will ever own; a flood stops here. */
const MAX_ROWS = 16;
/** Every kind of every machine fits in this many rows. */
const MAX_ALL_ROWS = KINDS.size * MAX_ROWS;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Whether `data` fits a snapshot row (callers shrink to this before put). */
const fits = (data) => Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_BYTES;

/** A body copied to a new key: its own `machine` claim moves with it. */
const rekey = (data, from, to) => (data.machine === from ? { ...data, machine: to } : data);

/**
 * @param {{client: object, machine: string, legacyMachine?: string, loggedIn: () => boolean, now?: () => number}} deps
 *   legacyMachine = this PC's key before the collision-free one; its rows are
 *   this PC's own, never a peer's.
 */
function createSnapshots({ client, machine, legacyMachine = machine, loggedIn, now = Date.now }) {
  const ownKeys = new Set([machine.toLowerCase(), String(legacyMachine).toLowerCase()]);
  const isOwn = (m) => ownKeys.has(m.toLowerCase());
  let gen = 0;
  let lastPut = {}; // kind -> JSON of the last successful put
  let cache = {}; // kind -> {at, rows}
  let queue = {}; // kind -> tail of the put chain
  const warned = new Set(); // kinds already logged as too big

  async function upsert(kind, data, json, mine) {
    if (lastPut[kind] === json) return true;
    const row = { kind, machine, data, updated_at: new Date(now()).toISOString() };
    const { error } = await client.from('snapshots').upsert(row, { onConflict: 'user_id,kind,machine' });
    if (mine !== gen) return false;
    if (error) {
      console.error(`[cloudsnapshots] put ${kind} failed:`, error.code || 'error', error.message || '');
      return false;
    }
    lastPut = { ...lastPut, [kind]: json };
    return true;
  }

  return {
    /** @returns {Promise<boolean>} whether the cloud now holds `data` */
    put(kind, data) {
      if (!KINDS.has(kind) || !isPlainObject(data) || !loggedIn()) return Promise.resolve(false);
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
        if (!warned.has(kind)) console.error(`[cloudsnapshots] ${kind} snapshot too big, not sent`);
        warned.add(kind);
        return Promise.resolve(false);
      }
      const mine = gen;
      const next = (queue[kind] || Promise.resolve()).then(() => (mine === gen ? upsert(kind, data, json, mine) : false));
      queue = { ...queue, [kind]: next.catch(() => false) };
      return next;
    },

    /** @returns {Promise<Array<{machine: string, data: object, updatedAt: number}>>} */
    async list(kind) {
      if (!KINDS.has(kind) || !loggedIn()) return [];
      const hit = cache[kind];
      if (hit && now() - hit.at <= TTL_MS) return hit.rows;
      const mine = gen;
      const { data, error } = await client
        .from('snapshots')
        .select('machine,data,updated_at')
        .eq('kind', kind)
        .neq('machine', machine)
        .order('updated_at', { ascending: false })
        .limit(MAX_ROWS);
      if (mine !== gen) return [];
      if (error || !Array.isArray(data)) {
        console.error(`[cloudsnapshots] list ${kind} failed:`, (error && error.code) || 'error');
        return hit ? hit.rows : [];
      }
      const at = now();
      const rows = data
        .filter((r) => r && typeof r.machine === 'string' && MACHINE_RE.test(r.machine) && !isOwn(r.machine))
        .filter((r) => isPlainObject(r.data))
        .map((r) => {
          const t = Date.parse(r.updated_at);
          // A far-future clock must not win every "newer copy" comparison.
          return { machine: r.machine, data: r.data, updatedAt: Number.isFinite(t) ? Math.min(t, at) : 0 };
        });
      cache = { ...cache, [kind]: { at, rows } };
      return rows;
    },

    /** @returns {Promise<Array<{machine: string, updatedAt: number, self: boolean}>|null>} newest first; null when the read failed */
    async machines() {
      if (!loggedIn()) return null;
      const mine = gen;
      const { data, error } = await client
        .from('snapshots')
        .select('machine,updated_at')
        .order('updated_at', { ascending: false })
        .limit(MAX_ALL_ROWS);
      if (mine !== gen) return null;
      if (error || !Array.isArray(data)) {
        console.error('[cloudsnapshots] machines failed:', (error && error.code) || 'error');
        return null;
      }
      const at = now();
      const latest = new Map();
      for (const r of data) {
        if (!r || typeof r.machine !== 'string' || !MACHINE_RE.test(r.machine)) continue;
        const t = Date.parse(r.updated_at);
        const when = Number.isFinite(t) ? Math.min(t, at) : 0;
        if (!latest.has(r.machine) || latest.get(r.machine) < when) latest.set(r.machine, when);
      }
      return [...latest]
        .map(([m, updatedAt]) => ({ machine: m, updatedAt, self: isOwn(m) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** @returns {Promise<{ok: true, removed: number}|{ok: false, reason: string}>} */
    async forget(target) {
      if (typeof target !== 'string' || !MACHINE_RE.test(target)) return { ok: false, reason: 'bad-machine' };
      if (isOwn(target)) return { ok: false, reason: 'own-machine' };
      if (!loggedIn()) return { ok: false, reason: 'logged-out' };
      const mine = gen;
      const { data, error } = await client.from('snapshots').delete().eq('machine', target).select('kind');
      if (mine !== gen) return { ok: false, reason: 'failed' };
      if (error) {
        console.error('[cloudsnapshots] forget failed:', error.code || 'error');
        return { ok: false, reason: 'failed' };
      }
      cache = {};
      return { ok: true, removed: Array.isArray(data) ? data.length : 0 };
    },

    /** @returns {Promise<boolean>} whether no legacy rows are left */
    async migrate() {
      if (legacyMachine === machine) return true;
      if (!loggedIn()) return false;
      const mine = gen;
      const { data, error } = await client
        .from('snapshots')
        .select('kind,data,updated_at')
        .eq('machine', legacyMachine)
        .limit(MAX_ALL_ROWS);
      if (mine !== gen) return false;
      if (error || !Array.isArray(data)) {
        console.error('[cloudsnapshots] migrate read failed:', (error && error.code) || 'error');
        return false;
      }
      const copies = data
        .filter((r) => r && KINDS.has(r.kind) && isPlainObject(r.data))
        .map((r) => ({ kind: r.kind, machine, data: rekey(r.data, legacyMachine, machine), updated_at: r.updated_at }));
      if (!copies.length) return true;
      // Logout or another account since the read: never write into it.
      const stillMine = () => mine === gen && loggedIn();
      if (!stillMine()) return false;
      // A row already under the new key is newer than the legacy copy: keep it.
      const { error: copyErr } = await client
        .from('snapshots')
        .upsert(copies, { onConflict: 'user_id,kind,machine', ignoreDuplicates: true });
      if (copyErr) {
        console.error('[cloudsnapshots] migrate copy failed:', copyErr.code || 'error');
        return false;
      }
      if (!stillMine()) return false;
      // Only what was copied goes: a row this version cannot read stays put.
      const { error: delErr } = await client
        .from('snapshots')
        .delete()
        .eq('machine', legacyMachine)
        .in('kind', copies.map((c) => c.kind));
      if (delErr) {
        console.error('[cloudsnapshots] migrate delete failed:', delErr.code || 'error');
        return false;
      }
      cache = {};
      return true;
    },

    /** Logout or another account: nothing cached belongs to the next user. */
    reset() {
      gen++;
      lastPut = {};
      cache = {};
      queue = {};
      warned.clear();
    },
  };
}

/** What callers get while the cloud is off or logged out. */
const SNAPSHOTS_OFF = {
  put: async () => false,
  list: async () => [],
  machines: async () => null,
  forget: async () => ({ ok: false, reason: 'logged-out' }),
  migrate: async () => false,
  reset: () => {},
};

module.exports = { createSnapshots, SNAPSHOTS_OFF, fits, KINDS, MAX_BYTES, TTL_MS, MACHINE_RE };
