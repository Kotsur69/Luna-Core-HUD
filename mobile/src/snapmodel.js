// ============================================================================
// LunaCore phone - snapshot readers (pure)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4c. Each PC writes its own `snapshots` row per
// kind (news, ledger, yazio, usage, repos, godmode); the phone writes none and reads them all. Every
// row is untrusted and goes through the same parser a PC uses for another
// PC's row - never rendered as it came.
// ============================================================================

import newsRows from '../../src/missionnewsrows.js';
import ledgerSync from '../../src/missionledgersync.js';
import ledgerCalc from '../../src/missionledgercalc.js';
import yazio from '../../src/lifeyaziopeers.js';
import usage from '../../src/usagesnapshot.js';
import reposSnap from '../../src/repossnapshot.js';
import godmodeSnap from '../../src/godmodesnapshot.js';

const { parseNewsPeer } = newsRows;
const { parsePeer, MAX_PEERS } = ledgerSync;
const { summarize, weekWindow } = ledgerCalc;
const { parseYazioPeer } = yazio;
const { newestUsage, windowNow } = usage;
const { reposFrom: mergeReposRows } = reposSnap;
const { runsFrom, liveFrom, tabsFrom, liveCounts } = godmodeSnap;

/** Projects listed on the phone; the rest only count in the total. */
export const MAX_PROJECTS = 20;

/**
 * Raw `snapshots` rows ({machine, data, updated_at}) -> {machine, data, updatedAt}.
 * A far-future clock is clamped so it can't win every "newest" comparison.
 */
export function snapRows(raw, now) {
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => r && typeof r.machine === 'string' && r.data && typeof r.data === 'object' && !Array.isArray(r.data))
    .map((r) => {
      const t = Date.parse(r.updated_at);
      return { machine: r.machine, data: r.data, updatedAt: Number.isFinite(t) ? Math.min(t, now) : 0 };
    });
}

/**
 * The newest briefing across machines, links resolved to their checked URL,
 * or null. `at` is the briefing's own time (clamped to now).
 * @returns {{machine: string, at: number, briefing: string[], sections: object[]}|null}
 */
export function newsFrom(rows, now) {
  let best = null;
  for (const r of rows) {
    const parsed = parseNewsPeer(r, now, 'm');
    if (!parsed || (best && parsed.report.at <= best.at)) continue;
    const { report, urls } = parsed;
    best = {
      machine: report.machine,
      at: report.at,
      briefing: report.briefing,
      sections: report.sections.map((s) => ({
        label: s.label,
        platform: s.platform,
        summary: s.summary,
        entries: s.entries.map((e) => ({ title: e.title, published: e.published, url: urls.get(e.key), pick: s.picks.includes(e.key) })),
      })),
    };
  }
  return best;
}

/**
 * Every PC's ledger snapshot, combined and priced for this week (Monday
 * 00:00 local - the phone has no provider reset time). One copy per machine
 * name (case-insensitive), the newer one wins, at most MAX_PEERS.
 */
export function ledgerFrom(rows, now, rates) {
  const byMachine = new Map();
  for (const r of rows) {
    const p = parsePeer(r.data, r.machine, now);
    if (!p) continue;
    const id = r.machine.toLowerCase();
    const prev = byMachine.get(id);
    if (!prev || r.updatedAt > prev.updatedAt) byMachine.set(id, { ...p, updatedAt: r.updatedAt });
  }
  const peers = [...byMachine.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PEERS);
  const win = weekWindow(null, now);
  const sum = summarize(
    peers.flatMap((p) => p.rows),
    { sinceMs: win.sinceMs, untilMs: now + 1, rates },
  );
  return {
    sinceMs: win.sinceMs,
    totalUsd: sum.totalUsd,
    unpricedTokens: sum.unpricedTokens,
    projects: sum.projects.slice(0, MAX_PROJECTS),
    moreProjects: Math.max(0, sum.projects.length - MAX_PROJECTS),
    machines: peers.map((p) => ({ machine: p.machine, updatedAt: p.updatedAt })),
  };
}

/** The most recently fetched valid YAZIO copy, as {machine, body}, or null. */
export function bodyFrom(rows, now) {
  let best = null;
  for (const r of rows) {
    const p = parseYazioPeer(r, now);
    if (p && (!best || p.body.fetchedAt > best.body.fetchedAt)) best = p;
  }
  return best;
}

/**
 * The newest usage read across machines as it stands at `now` (a window whose
 * reset passed shows empty), or null.
 * @returns {{machine: string, at: number, fiveHour: object|null, sevenDay: object|null}|null}
 */
export function usageFrom(rows, now) {
  const u = newestUsage(rows, now);
  return u && { machine: u.machine, at: u.at, fiveHour: windowNow(u.fiveHour, now), sevenDay: windowNow(u.sevenDay, now) };
}

/** Every PC's `repos` row, validated and merged into one entry per repo (repossnapshot.js). */
export function reposFrom(rows, now) {
  return mergeReposRows(rows, now);
}

/** Every PC's recent God Mode runs, newest first, each tagged with its machine. */
export function godmodeRunsFrom(rows, now) {
  return runsFrom(rows, now);
}

/** The newest live God Mode run over every PC (with `machine`, `at`, `stale`), or null. */
export function godmodeLiveFrom(rows, now) {
  return liveFrom(rows, now);
}

/** Every PC's terminal tab lights, newest first. */
export function godmodeTabsFrom(rows, now) {
  return tabsFrom(rows, now);
}

/** {pushed, working, waiting, pending, failed} of a live run. */
export function godmodeLiveCounts(live) {
  return liveCounts(live);
}
