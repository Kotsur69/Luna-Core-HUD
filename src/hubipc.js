// ============================================================================
// LunaCore - notification hub IPC (main process)
// ----------------------------------------------------------------------------
// hub:list         -> {ok, items, done, needs}   items already cleaned, capped
//                     and sorted by src/hub.js; done = recently marked done
// hub:done(id)     -> {ok} | {ok:false, reason:'bad-id'|'rate-limited'|'failed'}
// hub:seen()       -> {ok, unseen}  the drawer is showing: every open Needs-you
//                     item counts as seen (no payload - main knows the list)
// hub:changed      push (main -> renderer) with the same {items, done, needs, unseen}
//
// The renderer is untrusted: hub:done takes one id string, checked against
// ID_RE before anything else; nothing else crosses. Actions on an item are
// whitelisted names the renderer maps to IPC it already has - there is no
// generic "run action" channel. Lives outside main.js (past the file-size
// guideline); main.js only calls registerHubIpc() once.
//
// Sources are read here and handed to the pure collectors (hubcollect.js):
// this PC's run reports and the Life files from disk (slow, at most every
// 60 s), the power countdowns and the plan wait from the orchestra object and
// the update state from the getter main passes in (every tick), and the other
// PCs' `godmode` cloud rows (src/hubpeers.js, fetched in the background at
// most every 60 s; untrusted).
//
// Done and seen marks are synced (src/hubdone.js), and so are the hub's
// Settings (src/hubprefsync.js, N7): registerHubIpc() returns the hub with
// `doneProvider`, `seenProvider` and `prefsProvider`, which main hands to the
// config sync, and calls onDone() after a local mark so the sync runs soon.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { createHub, isHubId } = require('./hub');
const { COLLECTORS, GODMODE_WINDOW_MS, MAX_RUNS } = require('./hubcollect');
const { createDoneStore, createSeenStore, createHubDoneProvider, createHubSeenProvider, DONE_FILE, SEEN_FILE } = require('./hubdone');
const { createHubPrefsProvider } = require('./hubprefsync');
const { collectPeers, createHubPeers } = require('./hubpeers');
const { isCollectorOn } = require('./hubsources');
const checkinStore = require('./lifecheckin');
const goalStore = require('./lifegoals');
const budgetStore = require('./lifebudget');
const { budgetSummary } = require('./lifebudgetcalc');

const RUN_FILE_RE = /^[a-z0-9]{1,40}\.md$/;
const MAX_REPORT_BYTES = 256 * 1024;
const MIN_DONE_GAP_MS = 200;

/**
 * This PC's newest run reports: {id, mtime, text}, at most MAX_RUNS from the
 * last 14 days. Never throws; an unreadable file is skipped.
 */
function readRunReports(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => RUN_FILE_RE.test(n));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile() && st.size <= MAX_REPORT_BYTES && st.mtimeMs >= now - GODMODE_WINDOW_MS) files.push({ name, mtime: Math.floor(st.mtimeMs) });
    } catch {
      // Gone meanwhile.
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const runs = [];
  for (const f of files.slice(0, MAX_RUNS)) {
    try {
      runs.push({ id: f.name.slice(0, -3), mtime: f.mtime, text: fs.readFileSync(path.join(dir, f.name), 'utf8') });
    } catch {
      // Skipped.
    }
  }
  return runs;
}

/** ui.local.json through src/uiprefs.js (required on use: tests inject their own). */
function defaultPrefs() {
  const { readUiPrefs, writeUiPrefs } = require('./uiprefs');
  return { readPrefs: readUiPrefs, writePrefs: writeUiPrefs, file: () => paths.local('ui.local.json') };
}

/** A getter that must never break the hub: null on any failure. */
const safeGet = (fn) => () => {
  try {
    return typeof fn === 'function' ? fn() : null;
  } catch {
    return null;
  }
};

/**
 * Host mode in this HUD: {on, state} (hostsetup.js decideSetup()), or null
 * while host mode is off - the pairing file is only read when it is on.
 * @param {{hostOn?:()=>boolean, cloud?:()=>object|null}} acc
 */
function hostState(acc) {
  if (safeGet(acc.hostOn)() !== true) return null;
  const { decideSetup } = require('./hostsetup');
  const { hasPairedPhone } = require('./hostpairing');
  const s = safeGet(acc.cloud)() || {};
  return {
    on: true,
    state: decideSetup({ configured: s.configured !== false, loggedIn: s.loggedIn === true, paired: hasPairedPhone(paths.local('host-keys.local.json')) }),
  };
}

/**
 * Source name -> {collect, read, slow}. Every reader is injectable for tests.
 * @param {{runsDir:()=>string|null,
 *   orchestra:{views?:()=>Array<{projectId, view}>, planWaits?:()=>Array<{projectId, wait}>,
 *     view?:Function, planWait?:Function}|null,
 *   update:()=>object|null, now:()=>number, readers?:object}} deps
 */
function hubSources({ runsDir, orchestra, update, now, machine = null, peers = null, accounts = {}, readers = {} }) {
  const o = orchestra || {};
  const acc = accounts || {};
  const r = {
    godmode: () => {
      const dir = runsDir();
      // machine: this PC's name, so a run item can open its summary (N8).
      return { runs: dir ? readRunReports(dir, now()) : [], machine };
    },
    // The countdowns live in each project's plan view (orchestraPower view());
    // no plan, no countdown. One God Mode run per project: every run counts.
    power: () => {
      if (typeof o.views === 'function') {
        const views = safeGet(o.views)();
        return { powers: (Array.isArray(views) ? views : []).map((v) => ({ projectId: v && v.projectId, power: v && v.view ? v.view.power || null : null })) };
      }
      const view = safeGet(o.view)();
      return { power: view && typeof view === 'object' ? view.power || null : null };
    },
    planwait: () => {
      if (typeof o.planWaits === 'function') {
        const waits = safeGet(o.planWaits)();
        return { waits: Array.isArray(waits) ? waits : [] };
      }
      return { wait: safeGet(o.planWait)() };
    },
    checkin: () => ({ checkin: checkinStore.checkinView(checkinStore.loadCheckin(), now()) }),
    goals: () => ({ goals: goalStore.goalsView(goalStore.loadGoals(), now()) }),
    bills: () => ({ summary: budgetSummary(budgetStore.loadBudget(), now()) }),
    update: () => ({ update: safeGet(update)() }),
    // In memory: hubpeers fetches in the background and only hands back its last list.
    peers: () => ({ rows: peers ? peers.rows() : [] }),
    // N5. In memory (cheap, every tick): the last mail scan, cloud / Google status.
    mail: () => ({ mail: safeGet(acc.mail)() }),
    cloud: () => ({ cloud: safeGet(acc.cloud)() }),
    google: () => ({ google: safeGet(acc.google)() }),
    // N8: the report-email Gmail grant (gmailsend.js status(), local token only).
    gmail: () => ({ gmail: safeGet(acc.gmail)() }),
    // Files (slow): the host's pairing keys, every to-do list, the weekly reviews.
    host: () => ({ host: hostState(acc) }),
    todo: () => ({ store: require('./todo').readStore() }),
    weekly: () => ({ weekly: require('./weeklyreview').createWeeklyStore().load() }),
    approval: () => ({ views: typeof o.views === 'function' ? safeGet(o.views)() || [] : [] }),
    ...readers,
  };
  const collectors = { ...COLLECTORS, peers: collectPeers };
  const slow = new Set(['godmode', 'checkin', 'goals', 'bills', 'gmail', 'host', 'todo', 'weekly']);
  return Object.fromEntries(Object.keys(collectors).map((name) => [name, { collect: collectors[name], read: r[name], slow: slow.has(name) }]));
}

/**
 * @param {{
 *   ipcMain: {handle: Function},
 *   send: (channel:string, payload:object) => void,
 *   runsDir?: () => string|null,
 *   orchestra?: {view:()=>object|null, planWait:()=>object|null}, update?: () => object|null,
 *   doneFile?: () => string|null, seenFile?: () => string|null, now?: () => number, readers?: object,
 *   snapshots?: () => ({list: Function}|null), onDone?: () => void,
 *   accounts?: {mail?:()=>({needsCall:number, at:number}|null), cloud?:()=>object|null,
 *     google?:()=>object|null, gmail?:()=>({configured:boolean, connected:boolean}|null), hostOn?:()=>boolean},
 *   machine?: string  this PC's name (the run summary of a local God Mode run),
 *   prefs?: {readPrefs:()=>object, writePrefs:(partial:object)=>object|null, file:()=>string|null}
 *     the ui.local.json access the synced Settings use (default: src/uiprefs.js),
 *   sourcePrefs?: () => object  the stored hubSources ({group: false}, src/hubsources.js),
 *   timers?: {setTimer?:Function, clearTimer?:Function}, autoStart?: boolean,
 * }} deps
 * @returns {ReturnType<typeof createHub> & {doneProvider: object, seenProvider: object, prefsProvider: object}}
 */
function registerHubIpc({
  ipcMain,
  send,
  runsDir = () => null,
  orchestra = null,
  update = () => null,
  doneFile = () => paths.local(DONE_FILE),
  seenFile = () => paths.local(SEEN_FILE),
  snapshots = () => null,
  accounts = {},
  machine = null,
  prefs = null,
  sourcePrefs = () => ({}),
  onDone = () => {},
  now = Date.now,
  readers,
  timers = {},
  autoStart = true,
}) {
  const log = (line) => console.error(line);
  const doneStore = createDoneStore({ file: doneFile, now, log, onMark: () => onDone() });
  const seenStore = createSeenStore({ file: seenFile, now, log, onMark: () => onDone() });
  let hub = null;
  // A fetch that brought other rows re-collects at once instead of on the next tick.
  const peers = createHubPeers({ snapshots, now, log, onChange: () => hub && hub.refresh(false) });
  hub = createHub({
    sources: hubSources({ runsDir, orchestra, update, now, machine, peers, accounts, readers }),
    doneStore,
    seenStore,
    // Settings -> Notification hub -> sources: the stored hubSources, read once per refresh.
    sourceFilter: () => {
      const off = sourcePrefs();
      return (name) => isCollectorOn(name, off);
    },
    now,
    log,
    ...timers,
  });
  hub.on('hub:changed', (view) => {
    try {
      send('hub:changed', view);
    } catch (err) {
      log(`[hub] push failed: ${err && err.message}`);
    }
  });

  ipcMain.handle('hub:list', () => {
    try {
      return { ok: true, ...hub.refresh(false) };
    } catch (err) {
      log(`[hub] list failed: ${err && err.message}`);
      return { ok: false, reason: 'failed' };
    }
  });

  let lastDone = 0;
  ipcMain.handle('hub:done', (_event, id) => {
    if (!isHubId(id)) return { ok: false, reason: 'bad-id' };
    const at = now();
    // A looping renderer must not hammer the disk.
    if (at - lastDone < MIN_DONE_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastDone = at;
    try {
      return hub.markDone(id);
    } catch (err) {
      log(`[hub] done failed: ${err && err.message}`);
      return { ok: false, reason: 'failed' };
    }
  });

  let lastSeen = 0;
  ipcMain.handle('hub:seen', () => {
    const at = now();
    if (at - lastSeen < MIN_DONE_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastSeen = at;
    try {
      return hub.markSeen();
    } catch (err) {
      log(`[hub] seen failed: ${err && err.message}`);
      return { ok: false, reason: 'failed' };
    }
  });

  if (autoStart) hub.start();
  return {
    ...hub,
    doneProvider: createHubDoneProvider(doneStore, { now }),
    seenProvider: createHubSeenProvider(seenStore, { now }),
    prefsProvider: createHubPrefsProvider(prefs || defaultPrefs()),
  };
}

module.exports = { registerHubIpc, hubSources, readRunReports };
