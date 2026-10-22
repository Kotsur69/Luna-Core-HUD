// ============================================================================
// LunaCore - cloud snapshots (main)
// ----------------------------------------------------------------------------
// docs/DONE_CLOUD_SYNC_PLAN.md, phase 2c. The `snapshots` table holds one row per
// (kind, machine), written only by that machine: the Claude ledger, the last
// news briefing, the YAZIO body data. No merging - a reader takes every other
// machine's row as it is and validates it like a peer file.
//
//   put(kind, data)  upsert this PC's row; skipped while the content is the
//                    same as the last successful put; puts of one kind run
//                    one at a time, so an older one never lands last
//   list(kind)       the other machines' rows, newest first, cached for
//                    TTL_MS; a failed read keeps the last good answer
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
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Whether `data` fits a snapshot row (callers shrink to this before put). */
const fits = (data) => Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_BYTES;

/**
 * @param {{client: object, machine: string, loggedIn: () => boolean, now?: () => number}} deps
 */
function createSnapshots({ client, machine, loggedIn, now = Date.now }) {
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
      const own = machine.toLowerCase();
      const at = now();
      const rows = data
        .filter((r) => r && typeof r.machine === 'string' && MACHINE_RE.test(r.machine) && r.machine.toLowerCase() !== own)
        .filter((r) => isPlainObject(r.data))
        .map((r) => {
          const t = Date.parse(r.updated_at);
          // A far-future clock must not win every "newer copy" comparison.
          return { machine: r.machine, data: r.data, updatedAt: Number.isFinite(t) ? Math.min(t, at) : 0 };
        });
      cache = { ...cache, [kind]: { at, rows } };
      return rows;
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
const SNAPSHOTS_OFF = { put: async () => false, list: async () => [], reset: () => {} };

module.exports = { createSnapshots, SNAPSHOTS_OFF, fits, KINDS, MAX_BYTES, TTL_MS };
