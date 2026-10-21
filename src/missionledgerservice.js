// ============================================================================
// LunaCore - Mission Control: "which project ate my weekly limit" (main)
// ----------------------------------------------------------------------------
// Glue for mission:ledger: scan this PC's transcripts (missionledger.js),
// put our aggregates in the `ledger` cloud snapshot and read the other PCs'
// (validated by missionledgersync.js), then price everything inside the Claude weekly
// window and attach each project's class (missionprojects.js).
// Focus (W2): this PC's reply + commit moments become blocks
// (missionfocus.js), go up next to the rows, and are unioned with the
// other PCs' blocks into report.focus for the local Mon-Sun week.
// For the Life dashboard's score (src/lifescoreinputs.js) the report also
// carries focus.prevDays (last week), commitDays (this PC's commits per day
// with feat/fix counts) and now (the project of a reply under 10 min old).
//
// range({sinceMs, untilMs}) prices and clips the same data to any window up
// to 8 days (the weekly review's Mon-Sun week, the brief's weekend).
//
// Window: the provider's own 7-day window (weekly resetsAt - 7 d) when the
// renderer's usage poll knows the reset; otherwise Monday 00:00 local.
// The renderer only sends a number; anything implausible falls back.
// ============================================================================

'use strict';

const { eventsToBlocks, focusWeek, mergeBlocks, GAP_MS } = require('./missionfocus');
const { fits } = require('./cloudsnapshots');
const { MAX_PEERS } = require('./missionledgersync');
const { weekWindow } = require('./missionledgercalc');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Projects sent to the renderer; the rest are only counted (peer data is untrusted). */
const MAX_PROJECTS = 50;
/** Days of own commits counted for the Life score (this week + last week). */
const COMMIT_DAYS = 14;
/** A reply older than this is not "now" any more (the Life dashboard's Now strip). */
const NOW_MS = 10 * 60 * 1000;

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

/**
 * Focus for the local Mon-Sun week over every PC's blocks, capped like the
 * ledger. prevDays = last week's day totals (the Life score's week arrow).
 */
function focusReport(blocks, at, classes) {
  const week = focusWeek(blocks, { now: at });
  const prev = focusWeek(blocks, { now: week.weekStart - 1 });
  return {
    ...week,
    prevDays: prev.days.map(({ start, totalMs }) => ({ start, totalMs })),
    projects: week.projects.slice(0, MAX_PROJECTS).map((p) => ({ ...p, cls: classes[p.key] || null })),
    moreProjects: Math.max(0, week.projects.length - MAX_PROJECTS),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * This PC's own commits per local day for the last COMMIT_DAYS days (oldest
 * first): {date, commits, feat, fix}. null when the commit reader cannot tell
 * kinds apart or failed - "no data" is not the same as "no commits".
 */
async function commitDays(commits, at) {
  if (typeof commits.shipped !== 'function') return null;
  let list;
  try {
    list = await commits.shipped();
  } catch (err) {
    console.error('[focus] commit kinds failed:', err && err.message);
    return null;
  }
  const today = new Date(at);
  // Calendar days built from the date, never -24 h, so DST cannot skip one.
  const days = Array.from({ length: COMMIT_DAYS }, (_, i) => localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (COMMIT_DAYS - 1 - i))));
  const byDay = new Map(days.map((date) => [date, { date, commits: 0, feat: 0, fix: 0 }]));
  for (const c of Array.isArray(list) ? list : []) {
    const row = c && Number.isFinite(c.ms) ? byDay.get(localDay(new Date(c.ms))) : null;
    if (!row) continue;
    row.commits += 1;
    if (c.kind === 'feat') row.feat += 1;
    if (c.kind === 'fix') row.fix += 1;
  }
  return [...byDay.values()];
}

/**
 * What Mati is on right now: the project of the latest Claude reply when it
 * is under NOW_MS old, with the start of the block it belongs to (replies
 * less than GAP_MS apart). null when nothing is that fresh.
 */
function nowProject(events, at) {
  let last = null;
  for (const e of events) if (e && Number.isFinite(e.ms) && e.ms <= at && (!last || e.ms > last.ms)) last = e;
  if (!last || at - last.ms >= NOW_MS) return null;
  const times = events.filter((e) => e && e.key === last.key && Number.isFinite(e.ms) && e.ms <= last.ms).map((e) => e.ms).sort((a, b) => b - a);
  let since = last.ms;
  for (const ms of times) {
    if (since - ms >= GAP_MS) break;
    since = ms;
  }
  return { key: last.key, name: last.name, sinceMs: since, lastMs: last.ms };
}

/** The cloud snapshot needs the weekly window (<= 7 days) and the Mon-Sun focus week only. */
const CLOUD_KEEP_MS = 8 * DAY_MS;
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

/** Other PCs' `ledger` snapshots, validated; a failing cloud is no peers. */
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

/** Longest range range() accepts: a Mon-Sun week plus slack for a DST day. */
const MAX_RANGE_MS = 8 * DAY_MS;

/** ms per project key inside [sinceMs, untilMs), from blocks of any number of PCs. */
function hoursIn(blocks, sinceMs, untilMs) {
  const byKey = new Map();
  for (const [start, end, key, name] of mergeBlocks(blocks)) {
    const ms = Math.min(end, untilMs) - Math.max(start, sinceMs);
    if (ms <= 0) continue;
    const p = byKey.get(key) || { key, name, ms: 0 };
    p.ms += ms;
    byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => b.ms - a.ms || a.key.localeCompare(b.key));
}

/** One peer per machine (case-insensitive): the newer copy wins. */
function onePerMachine(peers) {
  const byMachine = new Map();
  for (const p of peers) {
    const id = p.machine.toLowerCase();
    const seen = byMachine.get(id);
    if (!seen || p.updatedAt > seen.updatedAt) byMachine.set(id, p);
  }
  return [...byMachine.values()].slice(0, MAX_PEERS);
}

/**
 * @param {{ledger:{scan:Function,rows:Function,events:Function}, store:{loadProjects:Function},
 *          sync:{parsePeer:Function}, loadRates:Function,
 *          commits?:{events:()=>Promise<Array>}, summarize?:Function, machine:string, now?:()=>number,
 *          cloud?:object|(()=>object|null)|null}} deps
 *   cloud = cloudsnapshots.js {put, list} (or a getter for it; null while the
 *   cloud is off): our snapshot goes up and the other PCs' come down. With the
 *   cloud off the report covers this PC only.
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
  return {
    /**
     * Claude cost and focus hours per project inside an arbitrary window of at
     * most MAX_RANGE_MS (the weekly review's Mon-Sun week, the brief's
     * weekend). Every PC's rows and blocks; nothing is uploaded from here.
     * @param {{sinceMs:number, untilMs:number}} req
     */
    async range(req) {
      const sinceMs = req && Number.isFinite(req.sinceMs) ? req.sinceMs : NaN;
      const untilMs = req && Number.isFinite(req.untilMs) ? req.untilMs : NaN;
      if (!(untilMs > sinceMs) || untilMs - sinceMs > MAX_RANGE_MS) return { ok: false, reason: 'bad-range' };
      await ledger.scan();
      const blocks = await ownBlocks(ledger, commits);
      const at = now();
      const { classes } = store.loadProjects();
      const live = typeof cloud === 'function' ? cloud() : cloud;
      const peers = live ? onePerMachine(await cloudPeers(live, sync.parsePeer, machine, at)) : [];
      const rows = peers.reduce((all, p) => all.concat(p.rows), ledger.rows());
      const allBlocks = peers.reduce((all, p) => all.concat(p.blocks || []), blocks);
      const sum = summarize(rows, { sinceMs, untilMs, rates: loadRates() });
      const cls = (p) => ({ ...p, cls: classes[p.key] || null });
      return {
        ok: true,
        sinceMs,
        untilMs,
        totalUsd: sum.totalUsd,
        unpricedTokens: sum.unpricedTokens,
        projects: sum.projects.slice(0, MAX_PROJECTS).map(cls),
        hours: hoursIn(allBlocks, sinceMs, Math.min(untilMs, at)).slice(0, MAX_PROJECTS).map(cls),
      };
    },

    async report(req) {
      await ledger.scan();
      const blocks = await ownBlocks(ledger, commits);
      const at = now();
      const own = ledger.rows();
      const { classes, pinned = [] } = store.loadProjects();
      const live = typeof cloud === 'function' ? cloud() : cloud;
      if (live) putSnapshot(live, machine, own, blocks, at);
      const peers = live ? onePerMachine(await cloudPeers(live, sync.parsePeer, machine, at)) : [];
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
        commitDays: await commitDays(commits, at),
        now: nowProject(ledger.events(), at),
      };
    },
  };
}

module.exports = { createLedgerService, weekWindow, hoursIn, MAX_PROJECTS };
