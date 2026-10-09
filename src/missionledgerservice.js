// ============================================================================
// LunaCore - Mission Control: "which project ate my weekly limit" (main)
// ----------------------------------------------------------------------------
// Glue for mission:ledger: scan this PC's transcripts (missionledger.js),
// publish our aggregates to the shared folder and read the other PCs'
// (missionledgersync.js), then price everything inside the Claude weekly
// window and attach each project's class (missionprojects.js).
//
// Window: the provider's own 7-day window (weekly resetsAt - 7 d) when the
// renderer's usage poll knows the reset; otherwise Monday 00:00 local.
// The renderer only sends a number; anything implausible falls back.
// ============================================================================

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Projects sent to the renderer; the rest are only counted (peer files are untrusted). */
const MAX_PROJECTS = 50;

/** {sinceMs, untilMs, source} for the current weekly window. */
function weekWindow(resetsAt, now) {
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > now && resetsAt <= now + WEEK_MS) {
    return { sinceMs: resetsAt - WEEK_MS, untilMs: now, source: 'reset' };
  }
  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return { sinceMs: monday.getTime(), untilMs: now, source: 'monday' };
}

/**
 * Pinned projects first (in pin order, at zero when idle this week), then up
 * to MAX_PROJECTS of the rest by cost. Every entry carries `pinned`.
 */
function withPinned(projects, pinned) {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const pins = pinned.map((pin) => ({
    ...(byKey.get(pin.key) || { key: pin.key, name: pin.name, usd: 0, tokens: 0, unpricedTokens: 0, share: 0 }),
    pinned: true,
  }));
  const pinnedKeys = new Set(pinned.map((p) => p.key));
  const rest = projects.filter((p) => !pinnedKeys.has(p.key)).slice(0, MAX_PROJECTS).map((p) => ({ ...p, pinned: false }));
  return [...pins, ...rest];
}

/**
 * @param {{ledger:{scan:Function,rows:Function}, store:{loadProjects:Function},
 *          sync:{writeOwn:Function,readPeers:Function}, loadRates:Function,
 *          summarize?:Function, machine:string, now?:()=>number}} deps
 */
function createLedgerService({ ledger, store, sync, loadRates, summarize = require('./missionledger').summarize, machine, now = Date.now }) {
  let lastWritten = null;

  /** Writes our file when the rows or the folder changed; returns an error code or null. */
  function publish(dir, rows, at) {
    const sig = `${dir}\u0000${JSON.stringify(rows)}`;
    if (sig === lastWritten) return null;
    try {
      sync.writeOwn(dir, machine, rows, at);
      lastWritten = sig;
      return null;
    } catch (err) {
      console.error('[ledger] shared folder write failed:', err && err.code);
      return (err && err.code) || 'write-failed';
    }
  }

  return {
    async report(req) {
      await ledger.scan();
      const at = now();
      const own = ledger.rows();
      const { classes, sharedDir, pinned = [] } = store.loadProjects();
      const syncError = sharedDir ? publish(sharedDir, own, at) : null;
      const peers = sharedDir ? sync.readPeers(sharedDir, machine, at) : [];

      const win = weekWindow(req && req.resetsAt, at);
      const rows = peers.reduce((all, p) => all.concat(p.rows), own);
      const sum = summarize(rows, { sinceMs: win.sinceMs, untilMs: win.untilMs + 1, rates: loadRates() });
      return {
        ok: true,
        sinceMs: win.sinceMs,
        windowSource: win.source,
        totalUsd: sum.totalUsd,
        unpricedTokens: sum.unpricedTokens,
        projects: withPinned(sum.projects, pinned).map((p) => ({ ...p, cls: classes[p.key] || null })),
        moreProjects: Math.max(0, sum.projects.filter((p) => !pinned.some((x) => x.key === p.key)).length - MAX_PROJECTS),
        machines: [{ machine, updatedAt: at, self: true }, ...peers.map((p) => ({ machine: p.machine, updatedAt: p.updatedAt, self: false }))],
        sharedDir,
        syncError,
      };
    },
  };
}

module.exports = { createLedgerService, weekWindow, MAX_PROJECTS };
