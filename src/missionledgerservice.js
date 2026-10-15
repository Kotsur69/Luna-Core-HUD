// ============================================================================
// LunaCore - Mission Control: "which project ate my weekly limit" (main)
// ----------------------------------------------------------------------------
// Glue for mission:ledger: scan this PC's transcripts (missionledger.js),
// publish our aggregates to the shared folder and read the other PCs'
// (missionledgersync.js), then price everything inside the Claude weekly
// window and attach each project's class (missionprojects.js).
// Focus (W2): this PC's reply + commit moments become blocks
// (missionfocus.js), are published next to the rows, and are unioned with the
// other PCs' blocks into report.focus for the local Mon-Sun week.
//
// Window: the provider's own 7-day window (weekly resetsAt - 7 d) when the
// renderer's usage poll knows the reset; otherwise Monday 00:00 local.
// The renderer only sends a number; anything implausible falls back.
// ============================================================================

'use strict';

const { eventsToBlocks, focusWeek } = require('./missionfocus');
const { fits } = require('./cloudsnapshots');

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

/** This PC's focus blocks: Claude replies + own commits; a failing git reader is not fatal. */
async function ownBlocks(ledger, commits) {
  let commitEvents = [];
  try {
    commitEvents = await commits.events();
  } catch (err) {
    console.error('[focus] commit moments failed:', err && err.message);
  }
  return eventsToBlocks([...ledger.events(), ...commitEvents]);
}

/** Focus for the local Mon-Sun week over every PC's blocks, capped like the ledger. */
function focusReport(blocks, at, classes) {
  const week = focusWeek(blocks, { now: at });
  return {
    ...week,
    projects: week.projects.slice(0, MAX_PROJECTS).map((p) => ({ ...p, cls: classes[p.key] || null })),
    moreProjects: Math.max(0, week.projects.length - MAX_PROJECTS),
  };
}

/** The cloud snapshot needs the weekly window (<= 7 days) and the Mon-Sun focus week only. */
const CLOUD_KEEP_MS = 8 * DAY_MS;
/** Same cap as missionledgersync.js MAX_PEERS. */
const MAX_PEERS = 8;

/** Shorter windows tried when 8 days of a heavy week don't fit one snapshot row. */
const SHRINK_DAYS = [3, 1];

/** This PC's `ledger` snapshot body for the last `keepMs`. */
function snapshotBody(machine, rows, blocks, at, keepMs) {
  const since = at - keepMs;
  return { v: 1, machine, rows: rows.filter((r) => r[0] >= since), blocks: blocks.filter((b) => b[1] >= since) };
}

/** Sends this PC's rows + blocks as its `ledger` snapshot; never waits, never throws. */
function putSnapshot(cloud, machine, rows, blocks, at) {
  let data = snapshotBody(machine, rows, blocks, at, CLOUD_KEEP_MS);
  // Too big for a row: the newest days matter most. Still too big -> put() refuses and logs once.
  for (const days of SHRINK_DAYS) if (!fits(data)) data = snapshotBody(machine, rows, blocks, at, days * DAY_MS);
  Promise.resolve()
    .then(() => cloud.put('ledger', data))
    .catch((err) => console.error('[ledger] cloud snapshot failed:', err && err.message));
}

/** Other PCs' `ledger` snapshots, validated like peer files; a failing cloud is no peers. */
async function cloudPeers(cloud, parsePeer, machine, at) {
  let rows = [];
  try {
    rows = await cloud.list('ledger');
  } catch (err) {
    console.error('[ledger] cloud snapshots unreadable:', err && err.message);
  }
  const own = machine.toLowerCase();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.machine === 'string' && r.machine.toLowerCase() !== own)
    .map((r) => parsePeer({ ...r.data, updatedAt: r.updatedAt }, r.machine, at))
    // A retired PC's row stays in the cloud; once nothing of it is in range it is not a PC to list.
    .filter((p) => p && (p.rows.length || p.blocks.length));
}

/** Folder and cloud peers, one per machine (case-insensitive): the newer copy wins. */
function mergePeers(a, b) {
  const byMachine = new Map();
  for (const p of [...a, ...b]) {
    const id = p.machine.toLowerCase();
    const seen = byMachine.get(id);
    if (!seen || p.updatedAt > seen.updatedAt) byMachine.set(id, p);
  }
  return [...byMachine.values()].slice(0, MAX_PEERS);
}

/**
 * @param {{ledger:{scan:Function,rows:Function,events:Function}, store:{loadProjects:Function},
 *          sync:{writeOwn:Function,readPeers:Function,parsePeer?:Function}, loadRates:Function,
 *          commits?:{events:()=>Promise<Array>}, summarize?:Function, machine:string, now?:()=>number,
 *          cloud?:object|(()=>object|null)|null}} deps
 *   cloud = cloudsnapshots.js {put, list} (or a getter for it; null while the
 *   cloud is off): our snapshot goes up and the other PCs' come down, with or
 *   without a shared folder.
 */
function createLedgerService({
  ledger,
  store,
  sync,
  loadRates,
  commits = { events: async () => [] },
  summarize = require('./missionledger').summarize,
  machine,
  now = Date.now,
  cloud = null,
}) {
  let lastWritten = null;

  /** Writes our file when the rows, blocks or folder changed; returns an error code or null. */
  function publish(dir, rows, blocks, at) {
    const sig = `${dir}\u0000${JSON.stringify(rows)}\u0000${JSON.stringify(blocks)}`;
    if (sig === lastWritten) return null;
    try {
      sync.writeOwn(dir, machine, rows, at, blocks);
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
      const blocks = await ownBlocks(ledger, commits);
      const at = now();
      const own = ledger.rows();
      const { classes, sharedDir, pinned = [] } = store.loadProjects();
      const syncError = sharedDir ? publish(sharedDir, own, blocks, at) : null;
      const folderPeers = sharedDir ? sync.readPeers(sharedDir, machine, at) : [];
      const live = typeof cloud === 'function' ? cloud() : cloud;
      if (live) putSnapshot(live, machine, own, blocks, at);
      const peers = live ? mergePeers(folderPeers, await cloudPeers(live, sync.parsePeer, machine, at)) : folderPeers;
      const allBlocks = peers.reduce((all, p) => all.concat(p.blocks || []), blocks);

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
        focus: focusReport(allBlocks, at, classes),
        sharedDir,
        syncError,
      };
    },
  };
}

module.exports = { createLedgerService, weekWindow, MAX_PROJECTS };
