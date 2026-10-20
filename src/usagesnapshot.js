// ============================================================================
// LunaCore - Claude usage limits over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, slice U1. A PC puts its last Claude usage read
// (5 h + weekly window) as its `usage` snapshot; the phone shows the newest
// one. All PCs share one account, so the newest row is the account's state.
//
// A row is written by another machine: untrusted. Only the known fields
// survive, each checked for type and range; anything off drops the row.
// No strings travel besides the machine name (checked by the reader).
// ============================================================================

'use strict';

const VERSION = 1;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A reset lies at most a week after the read (weekly window) - plus slack. */
const MAX_RESET_AHEAD_MS = 8 * DAY_MS;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Whether a reset time is one the reader accepts for a read taken at `at`. */
const isSaneReset = (t, at) => isTime(t) && t >= at - DAY_MS && t <= at + MAX_RESET_AHEAD_MS;

/**
 * usage.js limit entry -> {pct, resetsAt (ms|null)} or null. An odd reset
 * time is dropped here rather than making every reader drop the whole row.
 */
function fromLimit(limit, at) {
  if (!isObject(limit) || typeof limit.percentUsed !== 'number' || !Number.isFinite(limit.percentUsed)) return null;
  const t = typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : NaN;
  return { pct: Math.max(0, Math.min(100, Math.round(limit.percentUsed))), resetsAt: isSaneReset(t, at) ? t : null };
}

/**
 * This PC's `usage` snapshot from a usage.js read, or null when the read is
 * not a healthy Claude account read (another provider, an error, a fallback).
 */
function usageSnapshot(usage, now = Date.now()) {
  if (!isObject(usage) || usage.providerId !== 'claude' || usage.status !== 'ok' || !Array.isArray(usage.limits)) return null;
  const at = isTime(usage.updatedAt) ? Math.min(usage.updatedAt, now) : now;
  const fiveHour = fromLimit(usage.limits.find((l) => l && l.window === '5h'), at);
  const sevenDay = fromLimit(usage.limits.find((l) => l && l.window === 'weekly'), at);
  if (!fiveHour && !sevenDay) return null;
  return { v: VERSION, at, fiveHour, sevenDay };
}

/** One window from a peer row; undefined when malformed (drops the row), null when absent. */
function cleanWindow(w, at) {
  if (w === null) return null;
  if (!isObject(w) || typeof w.pct !== 'number' || !Number.isFinite(w.pct)) return undefined;
  let resetsAt = null;
  if (w.resetsAt !== null) {
    if (!isSaneReset(w.resetsAt, at)) return undefined;
    resetsAt = w.resetsAt;
  }
  return { pct: Math.max(0, Math.min(100, Math.round(w.pct))), resetsAt };
}

/** A `usage` row ({machine, data}) -> {machine, at, fiveHour, sevenDay} or null. */
function parseUsagePeer(row, now) {
  if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
  const d = row.data;
  if (!isObject(d) || d.v !== VERSION || !isTime(d.at)) return null;
  // A far-future clock must not make a copy look fresh forever.
  const at = Math.min(d.at, now);
  const fiveHour = cleanWindow(d.fiveHour, at);
  const sevenDay = cleanWindow(d.sevenDay, at);
  if (fiveHour === undefined || sevenDay === undefined || (!fiveHour && !sevenDay)) return null;
  return { machine: row.machine, at, fiveHour, sevenDay };
}

/** The newest valid copy across machines, or null. */
function newestUsage(rows, now) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = parseUsagePeer(r, now);
    if (p && (!best || p.at > best.at)) best = p;
  }
  return best;
}

/**
 * What a window shows at `now`: a window whose reset has passed is empty
 * again, even though no PC has read it since.
 * @returns {{pct: number, resetsAt: number|null, isReset: boolean}|null}
 */
function windowNow(w, now) {
  if (!w) return null;
  const isReset = w.resetsAt !== null && w.resetsAt <= now;
  return { pct: isReset ? 0 : w.pct, resetsAt: isReset ? null : w.resetsAt, isReset };
}

module.exports = { usageSnapshot, parseUsagePeer, newestUsage, windowNow, VERSION };
