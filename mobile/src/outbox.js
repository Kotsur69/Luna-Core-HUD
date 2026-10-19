// ============================================================================
// LunaCore phone - offline write queue (pure)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4d. A write goes into the scope's outbox
// ({key: unit}) before it is pushed, so it survives no network and an app
// kill. The pulled mirror stays the server's copy; views see it with the
// outbox laid over it. A unit leaves the outbox once a pull shows the server
// holds that key at the same or a newer stamp: either the push landed, or a
// newer change from another machine won (newest-wins, push_units). Pushing a
// unit twice is harmless: the server ignores a stamp that isn't newer.
// ============================================================================

/** Keys that would reach Object.prototype through a plain object. */
const unsafeKey = (k) => k === '__proto__' || Object.hasOwn(Object.prototype, k);

/** sync_units.key limit (cloudrows MAX_KEY). */
const MAX_KEY = 200;
/** cloudrows.applyRows drops a stamp further ahead than this, so such a unit could never be confirmed. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** PostgREST answers with these when the server refuses the data itself: retrying can't help. */
const REJECTED = new Set([400, 409, 413]);

/** A failed push_units call: true = drop the batch, false = keep it for the next try (offline, 401, 5xx). */
export const isRejected = (status) => REJECTED.has(status);

/**
 * Adds units to an outbox, keeping the newest per key. A unit a pull could
 * never confirm (key too long, stamp far ahead) is refused, or it would be
 * pushed again on every pull forever.
 * @param {Record<string, {k: string, v: unknown, u: number, d: number|null}>} box
 * @param {{k: string, v: unknown, u: number, d: number|null}[]} units
 * @returns {object} a new outbox
 */
export function enqueue(box, units, now = Date.now()) {
  const out = { ...box };
  for (const { k, v, u, d } of units) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY || unsafeKey(k)) continue;
    if (!Number.isSafeInteger(u) || u < 0 || u > now + DAY_MS) continue;
    if (!Object.hasOwn(out, k) || u > out[k].u) out[k] = { k, v, u, d: d ?? null };
  }
  return out;
}

/**
 * The mirror as the phone should show it: each queued unit newer than the
 * server's copy replaces it, in the mirror's own {v, u, d} shape.
 * @returns {object} a new mirror; the input is untouched
 */
export function overlay(mirror, box) {
  const out = { ...mirror };
  for (const x of Object.values(box)) {
    if (Object.hasOwn(out, x.k) && out[x.k].u >= x.u) continue;
    out[x.k] = { v: x.d === null ? x.v : null, u: x.u, d: x.d };
  }
  return out;
}

/** Drops the units the server already holds (same or newer stamp). Returns `box` itself when nothing changed. */
export function prune(box, mirror) {
  const left = Object.entries(box).filter(([k, x]) => !(Object.hasOwn(mirror, k) && mirror[k].u >= x.u));
  return left.length === Object.keys(box).length ? box : Object.fromEntries(left);
}

/** Drops `sent` units still queued at the same stamp (a newer edit queued since stays). Returns `box` when nothing changed. */
export function without(box, sent) {
  const gone = new Set(sent.filter((x) => Object.hasOwn(box, x.k) && box[x.k].u === x.u).map((x) => x.k));
  return gone.size ? Object.fromEntries(Object.entries(box).filter(([k]) => !gone.has(k))) : box;
}
