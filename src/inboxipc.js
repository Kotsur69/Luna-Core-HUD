// ============================================================================
// LunaCore - attention inbox IPC (main)
// ----------------------------------------------------------------------------
//   inbox:list            -> {ok, items}  src/inbox.js buildInbox()
//   inbox:run {machine, id} -> {ok, run} | {ok:false, reason}
//                            one God Mode run for the summary window; opening
//                            it marks it seen in this PC's own `godmode` row
//   inbox:open-pr {machine, id, pkg}  opens that package's PR link in the
//                            browser (github.com only), never a renderer URL
//
// Sources: this PC's run history file (snapshotputs.js godmode.read()), the
// other PCs' `godmode` rows (cloudsnapshots list(), untrusted - parsed by
// godmodesnapshot.js), today's check-in and this week's goals (local files),
// and the report-email Gmail sender's status (no network, local token only).
// The renderer names a run only by machine + id; both are validated here.
// ============================================================================

'use strict';

const { peersOf, collectRuns, seenUnion, buildInbox, findRun, MACHINE_RE } = require('./inbox');
const { RUN_ID_RE, prUrlOf } = require('./godmodesnapshot');
const checkinStore = require('./lifecheckin');
const goalStore = require('./lifegoals');

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** A local read that must never break the inbox: null on any failure. */
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
 *   machine:string, openExternal?:(url:string)=>Promise<void>, now?:()=>number, checkin?:(at:number)=>object|null, goals?:(at:number)=>object|null,
 *   gmail?:()=>({configured:boolean, connected:boolean}|null)}} deps
 */
function registerInboxIpc({
  ipcMain,
  snapshots,
  godmode,
  machine,
  openExternal = null,
  now = Date.now,
  checkin = (at) => checkinStore.checkinView(checkinStore.loadCheckin(), at),
  goals = (at) => goalStore.goalsView(goalStore.loadGoals(), at),
  gmail = () => null,
}) {
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

  ipcMain.handle('inbox:list', async () => {
    try {
      const at = now();
      const peers = await allPeers(at);
      const items = buildInbox({
        runs: collectRuns(peers),
        seen: seenUnion(peers),
        checkin: safe('checkin', () => checkin(at)),
        goals: safe('goals', () => goals(at)),
        gmail: safe('gmail', () => gmail()),
        now: at,
      });
      return { ok: true, items };
    } catch (err) {
      console.error('[inbox] list failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });

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

module.exports = { registerInboxIpc };
