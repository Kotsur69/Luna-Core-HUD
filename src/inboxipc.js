// ============================================================================
// LunaCore - God Mode run summary IPC (main)
// ----------------------------------------------------------------------------
//   inbox:run {machine, id} -> {ok, run} | {ok:false, reason}
//                            one God Mode run for the summary window
//                            (renderer godmodesummary.js, opened from a hub
//                            item's openRunSummary action); opening it marks
//                            it seen in this PC's own `godmode` row
//   inbox:open-pr {machine, id, pkg}  opens that package's PR link in the
//                            browser (github.com only), never a renderer URL
//
// The channel names are the old attention inbox's: N8
// (docs/tbc_docs/NOTIFICATION_HUB_PLAN.md) folded its '!' chip and its list
// (inbox:list) into the notification hub and kept these two validated handlers.
//
// Sources: this PC's run history file (snapshotputs.js godmode.read()) and the
// other PCs' `godmode` rows (cloudsnapshots list(), untrusted - parsed by
// godmodesnapshot.js parseGodmodePeer()). The renderer names a run only by
// machine + id; both are validated here.
// ============================================================================

'use strict';

const { parseGodmodePeer, RUN_ID_RE, prUrlOf } = require('./godmodesnapshot');

const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * This PC's own snapshot (read back from disk) and the other PCs' rows, each
 * parsed and validated. A broken own file or row is just left out.
 * @returns {Array<{machine:string, runs:object[]}>}
 */
function peersOf(own, rows, machine, now) {
  const mine = isObject(own) && MACHINE_RE.test(machine) ? parseGodmodePeer({ machine, data: own }, now) : null;
  const others = (Array.isArray(rows) ? rows : []).map((r) => parseGodmodePeer(r, now));
  return [mine, ...others].filter(Boolean);
}

/** Every machine's runs tagged with the machine, newest first. */
const collectRuns = (peers) => peers.flatMap((p) => p.runs.map((r) => ({ ...r, machine: p.machine }))).sort((a, b) => b.finishedAt - a.finishedAt);

/** One run by machine + id, or null. */
const findRun = (runs, machine, id) => runs.find((r) => r.machine === machine && r.id === id) || null;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** A local read that must never break the summary: null on any failure. */
function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[inbox] ${label} failed:`, errText(err));
    return null;
  }
}

/**
 * @param {{ipcMain:object, snapshots:()=>({list:Function}|null), godmode:{read:Function, markSeen:Function},
 *   machine:string, openExternal?:(url:string)=>Promise<void>, now?:()=>number}} deps
 */
function registerInboxIpc({ ipcMain, snapshots, godmode, machine, openExternal = null, now = Date.now }) {
  async function peerRows() {
    const s = snapshots();
    if (!s) return [];
    try {
      return await s.list('godmode');
    } catch (err) {
      console.error('[inbox] godmode rows failed:', errText(err));
      return [];
    }
  }

  async function allPeers(at) {
    return peersOf(safe('history', () => godmode.read()), await peerRows(), machine, at);
  }

  ipcMain.handle('inbox:run', async (_event, req) => {
    const ok = req && typeof req === 'object' && typeof req.machine === 'string' && typeof req.id === 'string';
    if (!ok || !MACHINE_RE.test(req.machine) || !RUN_ID_RE.test(req.id)) return { ok: false, reason: 'bad-run' };
    try {
      const run = findRun(collectRuns(await allPeers(now())), req.machine, req.id);
      if (!run) return { ok: false, reason: 'not-found' };
      // Fire and forget: a failed put only logs, the summary still opens.
      Promise.resolve(godmode.markSeen(run.id)).catch(() => {});
      return { ok: true, run };
    } catch (err) {
      console.error('[inbox] run failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });

  // Only machine + run id + package id cross; the URL comes from the
  // validated row and must still be an https://github.com/ link.
  ipcMain.on('inbox:open-pr', async (_event, req) => {
    try {
      const ok = req && typeof req === 'object' && typeof req.machine === 'string' && typeof req.id === 'string' && typeof req.pkg === 'string';
      if (!ok || !MACHINE_RE.test(req.machine) || !RUN_ID_RE.test(req.id) || !openExternal) return;
      const run = findRun(collectRuns(await allPeers(now())), req.machine, req.id);
      const pkg = run ? run.packages.find((p) => p.id === req.pkg) : null;
      const url = pkg ? prUrlOf(pkg.prUrl) : null;
      if (url) await openExternal(url);
    } catch (err) {
      console.error('[inbox] open PR failed:', errText(err));
    }
  });
}

module.exports = { registerInboxIpc, peersOf, collectRuns, findRun };
