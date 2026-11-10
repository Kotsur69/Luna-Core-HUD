// ============================================================================
// LunaCore - Claude usage limits over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/done_docs/DONE_REMOTE_HOST_PLAN.md, slice U1. A PC puts its last Claude usage read
// (5 h + weekly window) as its `usage` snapshot; the phone shows the newest
// one. The top-level fiveHour/sevenDay is the main ~/.claude login's read
// (or, when that read failed, the active account's), so a reader that knows
// nothing about accounts still shows "the" account as before.
//
// PER-ACCOUNT ROWS (optional `accounts`): with several Claude accounts
// (src/claudeaccountusage.js) a snapshot also carries one {label, active,
// fiveHour, sevenDay} per account with a healthy read. Same `v` - an old
// reader ignores the field; a bad account entry drops only that entry.
//
// A row is written by another machine: untrusted. Only the known fields
// survive, each checked for type and range; anything off drops the row.
// No strings travel besides the machine name and account labels (both
// checked by the reader).
// ============================================================================

'use strict';

const VERSION = 1;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A reset lies at most a week after the read (weekly window) - plus slack. */
const MAX_RESET_AHEAD_MS = 8 * DAY_MS;
/** Same caps as the account store (src/claudeaccounts.js). */
const MAX_ACCOUNTS = 8;
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,60}$/;

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

/** The two windows of a limits[] list ({fiveHour, sevenDay}), or null when neither is there. */
function windowsOf(limits, at) {
  const list = Array.isArray(limits) ? limits : [];
  const fiveHour = fromLimit(list.find((l) => l && l.window === '5h'), at);
  const sevenDay = fromLimit(list.find((l) => l && l.window === 'weekly'), at);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/** A label another machine sent: printable, 1..MAX_LABEL chars. */
const isLabel = (v) => typeof v === 'string' && LABEL_RE.test(v);

/** Per-account rows from the watcher's `accounts` entries (healthy reads only). */
function accountRows(accounts, at) {
  const rows = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!isObject(a) || a.status !== 'ok' || !isLabel(a.label)) continue;
    const w = windowsOf(a.limits, at);
    if (w) rows.push({ label: a.label, active: a.active === true, ...w });
  }
  return rows.slice(0, MAX_ACCOUNTS);
}

/**
 * This PC's `usage` snapshot from a usage.js read, or null when there is no
 * healthy Claude read at all (another provider, an error, a fallback, and no
 * account read either).
 */
function usageSnapshot(usage, now = Date.now()) {
  if (!isObject(usage)) return null;
  const at = isTime(usage.updatedAt) ? Math.min(usage.updatedAt, now) : now;
  const mainOk = usage.providerId === 'claude' && usage.status === 'ok' && !usage.isFallback;
  const rows = accountRows(usage.accounts, at);
  // The main read when it is healthy, else the active (or first) account's.
  const top = (mainOk && windowsOf(usage.limits, at)) || rows.find((r) => r.active) || rows[0] || null;
  if (!top) return null;
  const snap = { v: VERSION, at, fiveHour: top.fiveHour, sevenDay: top.sevenDay };
  return rows.length > 0 ? { ...snap, accounts: rows } : snap;
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
  const base = { machine: row.machine, at, fiveHour, sevenDay };
  const accounts = parseAccountRows(d.accounts, at);
  return accounts.length > 0 ? { ...base, accounts } : base;
}

/** A peer's per-account rows; a malformed entry is dropped on its own. */
function parseAccountRows(list, at) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ACCOUNTS)) {
    if (!isObject(a) || !isLabel(a.label)) continue;
    const fiveHour = a.fiveHour === undefined ? null : cleanWindow(a.fiveHour, at);
    const sevenDay = a.sevenDay === undefined ? null : cleanWindow(a.sevenDay, at);
    if (fiveHour === undefined || sevenDay === undefined || (!fiveHour && !sevenDay)) continue;
    out.push({ label: a.label, active: a.active === true, fiveHour, sevenDay });
  }
  return out;
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
