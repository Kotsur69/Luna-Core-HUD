// ============================================================================
// LunaCore - notification hub: God Mode runs from the other PCs (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N4, same pattern as src/missionnewspeers.js.
// Every PC puts its last runs in its `godmode` cloud snapshot
// (godmodesnapshot.js); this reads the OTHER machines' rows
// (cloudsnapshots list() leaves this PC's own row out - its runs come from the
// local reports) and turns every run into hub items with `machine` set.
//
// Rows are written by another machine: untrusted. Each row goes through
// parseGodmodePeer() (version, caps, control characters), every hub line is
// re-cleaned with hubLine() (paths scrubbed again, capped), the run id must
// match RUN_ID_RE, and src/hub.js cleans every item once more at the boundary.
// A remote item carries one action only (N8): openRunSummary, which opens the
// run summary window through the validated inbox:run handler (main looks the
// run up again by machine + id - nothing from the row is executed). Besides
// that, "Mark done" (synced, src/hubdone.js).
//
// Rules (plan Answers 5 + Risks):
//   - every run shows; one with Needs-you / manual lines gets one 'needs' item
//     per line (the badge) plus an 'info' run item, a clean run is 'info'
//     (Recent, no badge);
//   - a v1 run (no lines in the row) shows counts only, "details in your
//     email" - 'needs' when the counts are not zero;
//   - a run older than STALE_MS (14 days) drops to Recent ('info'), and one
//     older than DROP_MS (30 days, the done-mark window) is left out.
//
// Item ids are the same as on the PC that ran it (hubcollect.runItems), so a
// done mark made anywhere clears the item everywhere.
// ============================================================================

'use strict';

const { parseGodmodePeer, hubLine, RUN_ID_RE, HUB_MAX_LINES } = require('./godmodesnapshot');
const { runItems, summaryAction } = require('./hubcollect');

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 14 * DAY_MS;
const DROP_MS = 30 * DAY_MS;
/** More machines than Mati will ever own; a flood stops here. */
const MAX_ROWS = 16;
/** Clock skew between PCs a run's finish time may show; later is a forged row. */
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const REFRESH_MS = 60 * 1000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const list = (v) => (Array.isArray(v) ? v : []);

/** Re-cleaned hub lines of one run, or null when the row had none (v1). */
function linesOf(arr) {
  if (!Array.isArray(arr)) return null;
  return [...new Set(arr.slice(0, HUB_MAX_LINES).map((l) => hubLine(l)).filter(Boolean))];
}

/** "5 of 6 merged" / "2 of 3 pushed" from the run's counts. */
function resultOf(run) {
  if (!run.total) return '';
  return run.merged > 0 ? `${run.merged} of ${run.total} merged` : `${run.pushed} of ${run.total} pushed`;
}

/** One parsed run of machine `machine` -> hub items ([] when unusable or too old). */
function peerRunItems(run, machine, now) {
  if (!isObject(run) || typeof run.id !== 'string' || !RUN_ID_RE.test(run.id) || !isTime(run.finishedAt)) return [];
  const age = now - run.finishedAt;
  if (age > DROP_MS) return [];
  const stale = age > STALE_MS;
  const needsYou = linesOf(run.needsYou);
  const manualActionLines = linesOf(run.manualActionLines);
  const base = {
    id: run.id,
    at: Math.floor(run.finishedAt),
    repo: hubLine(run.repoName).slice(0, 100) || run.id,
    result: resultOf(run),
    machine,
    primary: summaryAction(machine, run.id),
  };
  if (needsYou || manualActionLines) {
    return runItems({
      ...base,
      needsYou: needsYou || [],
      manualActionLines: manualActionLines || [],
      linesKind: stale ? 'info' : 'needs',
      detail: `Full report: in your email or on ${machine}`,
      detailKey: 'hub.item.gmPeerReport',
      extraVars: { machine },
    });
  }
  // v1: counts only.
  const needs = list(run.needs).length;
  const manual = Number.isSafeInteger(run.manualActions) && run.manualActions > 0 ? run.manualActions : 0;
  const waiting = needs + manual > 0;
  return runItems({
    ...base,
    runKind: waiting && !stale ? 'needs' : 'info',
    ...(waiting
      ? { detail: `${needs} need you, ${manual} manual actions - details in your email`, detailKey: 'hub.item.gmPeerCounts', extraVars: { needs, manual } }
      : { detail: `Full report: in your email or on ${machine}`, detailKey: 'hub.item.gmPeerReport', extraVars: { machine } }),
  });
}

/**
 * The hub collector for the other PCs' rows: {rows, now} -> HubItem[].
 * A broken row is left out; a run id seen on two machines keeps the newer.
 * @param {{rows: Array<{machine:string, data:object}>, now:number}} state
 */
function collectPeers(state) {
  if (!isObject(state) || !isTime(state.now)) return [];
  const items = [];
  for (const row of list(state.rows).slice(0, MAX_ROWS)) {
    const peer = parseGodmodePeer(row, state.now);
    if (!peer) continue;
    const future = futureRunIds(row, state.now);
    for (const run of peer.runs) if (!future.has(run.id)) items.push(...peerRunItems(run, peer.machine, state.now));
  }
  return items;
}

/**
 * Ids of a raw row's runs that claim to finish in the future. parseGodmodePeer
 * clamps such a time to now, which would pin the run at the top forever (never
 * stale, a fresh `at` every tick): they are left out instead.
 */
function futureRunIds(row, now) {
  try {
    const runs = isObject(row) && isObject(row.data) && Array.isArray(row.data.runs) ? row.data.runs.slice(0, 4 * MAX_ROWS) : [];
    return new Set(runs.filter((r) => isObject(r) && typeof r.finishedAt === 'number' && r.finishedAt > now + FUTURE_SLACK_MS).map((r) => r.id));
  } catch {
    return new Set();
  }
}

/**
 * The cloud side: the last `godmode` rows of the other PCs, fetched at most
 * every refreshMs in the background. rows() never waits and never throws -
 * it returns the last good list and starts a fetch when that one is stale;
 * onChange() runs when a fetch brought different rows.
 * @param {{snapshots: () => ({list: Function}|null), now?: () => number,
 *   refreshMs?: number, onChange?: () => void, log?: Function}} deps
 *   snapshots = cloudsnapshots.js getter; null while the cloud is off.
 */
function createHubPeers({ snapshots, now = Date.now, refreshMs = REFRESH_MS, onChange = () => {}, log = () => {} }) {
  let rows = [];
  let signature = '[]';
  let fetchedAt = 0;
  let inFlight = null;

  async function fetchRows() {
    const s = snapshots();
    if (!s) return [];
    const got = await s.list('godmode');
    return list(got).slice(0, MAX_ROWS);
  }

  /** Fetches now (unless one is running); resolves true when the rows changed. */
  function refresh() {
    if (inFlight) return inFlight;
    fetchedAt = now();
    inFlight = fetchRows()
      .then((next) => {
        const sig = JSON.stringify(next);
        if (sig === signature) return false;
        rows = next;
        signature = sig;
        try {
          onChange();
        } catch (err) {
          log(`[hub] peers onChange failed: ${err && err.message}`);
        }
        return true;
      })
      .catch((err) => {
        log(`[hub] godmode rows from other PCs unreadable: ${err && err.message}`);
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    rows() {
      if (!inFlight && now() - fetchedAt >= refreshMs) refresh();
      return rows;
    },
    refresh,
  };
}

module.exports = { collectPeers, createHubPeers, peerRunItems, STALE_MS, DROP_MS };
