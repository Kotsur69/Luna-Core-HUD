// ============================================================================
// LunaCore - attention inbox: what needs Mati, on every PC (main, pure)
// ----------------------------------------------------------------------------
// The '!' chip lists three kinds of items:
//   godmode  a finalized God Mode run from ANY PC in the last 7 days that
//            no PC has opened yet (the `seen` lists of every machine's
//            `godmode` snapshot row, unioned)
//   checkin  today's sleep/energy check-in not answered and not skipped
//   goals    this ISO week's goals not set yet - the same condition the Life
//            dashboard's weekly prompt uses (lifedailyview.js needsGoals)
//
// No I/O here: inboxipc.js reads the files and the cloud rows and hands them
// in. Rows from other machines are untrusted - they go through
// godmodesnapshot.js parseGodmodePeer() before anything here reads them.
// The items are plain data; the renderer builds them with textContent.
// ============================================================================

'use strict';

const { parseGodmodePeer, RUN_ID_RE } = require('./godmodesnapshot');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * This PC's own snapshot (read back from disk) and the other PCs' rows, each
 * parsed and validated. A broken own file or row is just left out.
 * @returns {Array<{machine:string, runs:object[], seen:string[]}>}
 */
function peersOf(own, rows, machine, now) {
  const mine = isObject(own) && MACHINE_RE.test(machine) ? parseGodmodePeer({ machine, data: own }, now) : null;
  const others = (Array.isArray(rows) ? rows : []).map((r) => parseGodmodePeer(r, now));
  return [mine, ...others].filter(Boolean);
}

/** Every machine's runs tagged with the machine, newest first; a run id seen twice keeps the newest. */
function collectRuns(peers) {
  const runs = peers.flatMap((p) => p.runs.map((r) => ({ ...r, machine: p.machine }))).sort((a, b) => b.finishedAt - a.finishedAt);
  return runs.filter((r, i) => runs.findIndex((o) => o.id === r.id) === i);
}

/** The run ids any machine has marked seen. */
const seenUnion = (peers) => new Set(peers.flatMap((p) => p.seen));

/** A run as an inbox row: only what the list shows. */
const runItem = (r) => ({
  kind: 'godmode',
  id: r.id,
  machine: r.machine,
  repoName: r.repoName,
  finishedAt: r.finishedAt,
  integrationState: r.integrationState,
  needs: r.needs.length,
});

/**
 * The inbox, newest God Mode runs first, then the check-in, then the goals.
 * @param {{runs:object[], seen:Set<string>, checkin?:{today:string, entry:object|null}|null,
 *   goals?:{week:string, goals:Array|null}|null, now:number}} input
 * @returns {object[]}
 */
function buildInbox({ runs, seen, checkin, goals, now }) {
  const items = (Array.isArray(runs) ? runs : [])
    .filter((r) => RUN_ID_RE.test(r.id) && !seen.has(r.id) && r.finishedAt >= now - WINDOW_MS)
    .map(runItem);
  if (isObject(checkin) && typeof checkin.today === 'string' && checkin.entry === null) items.push({ kind: 'checkin', date: checkin.today });
  if (isObject(goals) && typeof goals.week === 'string' && goals.goals === null) items.push({ kind: 'goals', week: goals.week });
  return items;
}

/** One run by machine + id from collectRuns() output, or null. */
const findRun = (runs, machine, id) => runs.find((r) => r.machine === machine && r.id === id) || null;

module.exports = { peersOf, collectRuns, seenUnion, buildInbox, findRun, WINDOW_MS, MACHINE_RE };
