// ============================================================================
// LunaCore phone - Life budget model (pure)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4b. Like the to-dos, the phone has no budget
// file: the pulled `life` mirror IS its state. budgetOf() turns it into the
// budget a PC would merge (same validPeer + normalize), and opUnits() runs a
// PC's own op table (lifebudgetrows.applyOp) on it, then sends only the units
// that op changed - never the whole budget - so a phone write merges per row
// exactly like a write on another PC.
// ============================================================================

import rows from '../../src/cloudrows.js';
import units from '../../src/lifebudgetunits.js';
import budgetRows from '../../src/lifebudgetrows.js';

const { lifePeer } = rows;
const { toUnits, fromUnits, validPeer, sameValue } = units;
const { applyOp } = budgetRows;

/**
 * The mirror -> a validated budget. `ready` = a PC has published one: every
 * PC sync includes the income unit, so without it the mirror is not a budget
 * yet and the phone must not write (its default categories would go out).
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror untrusted
 * @returns {{budget: object, ready: boolean}}
 */
export function budgetOf(mirror, now = Date.now()) {
  const peer = validPeer(lifePeer(mirror), now);
  return { budget: fromUnits(peer.units.map((x) => [x.k, x.v])), ready: peer.units.some((x) => x.k === 'income') };
}

/** A stamp newer than the one it replaces, even with a phone clock a little behind. */
const stampAfter = (prev, now) => Math.max(Math.floor(now), (prev || 0) + 1);

/**
 * One budget op -> the cloud units it changes: edited / new rows, and a
 * tombstone for each row it removed (deleteGoal also takes its deposits).
 * Throws on a bad op or payload, like lifebudget.apply() on a PC.
 * @returns {{k: string, v: object|null, u: number, d: number|null}[]}
 */
export function opUnits(mirror, op, data, now = Date.now()) {
  const { budget, ready } = budgetOf(mirror, now);
  if (!ready) throw new Error('not-ready');
  const before = new Map(toUnits(budget));
  const after = toUnits(applyOp(budget, op, data, now));
  const prevU = (k) => (Object.hasOwn(mirror, k) ? mirror[k].u : 0);
  const out = after.filter(([k, v]) => !before.has(k) || !sameValue(before.get(k), v)).map(([k, v]) => ({ k, v, u: stampAfter(prevU(k), now), d: null }));
  const kept = new Set(after.map(([k]) => k));
  for (const k of before.keys()) {
    if (kept.has(k)) continue;
    const t = stampAfter(prevU(k), now);
    out.push({ k, v: null, u: t, d: t });
  }
  return out;
}
