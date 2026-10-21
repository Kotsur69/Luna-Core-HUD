// ============================================================================
// LunaCore - weekly review IPC (main process, Life dashboard's Week tab)
// ----------------------------------------------------------------------------
// life:week          {week?} -> {ok, weeks, entry, model, models, current,
//                     generatable, busy, mailOn, gmail}  weeks = the history
//                     list (newest first); entry = the picked week's review
//                     (default: the newest)
// life:week-generate {week, overwrite} -> {ok, entry} | {ok:false, reason}
//                     'exists' until the renderer confirms an overwrite; only
//                     this week or last week can be generated
// life:week-email    {week} -> {ok} | {ok:false, reason}  the 'Email it' button
// life:week-model    {model} -> same as life:week
//
// The renderer names a week and a model from fixed lists - never a prompt,
// a recipient or a body. Generating spends tokens (one call) and sends no
// mail; only the scheduled review and 'Email it' send.
// ============================================================================

'use strict';

const { isWeek, isoWeek, ymd } = require('./lifedays');
const { generatable } = require('./weeklyreview');
const { MISSION_MODELS } = require('./missionrunner');
const { weeklyEmailOn } = require('./mailprefs');

/** 'Email it' sends a real mail: no bursts. */
const EMAIL_GAP_MS = 30 * 1000;

/**
 * @param {{ipcMain:object, review:{generate:Function, isBusy:Function}, store:object,
 *   mail:{sendNow:Function}, sender:{status:Function}, prefs:{loadPrefs:Function}, now?:()=>number}} deps
 */
function registerWeeklyIpc({ ipcMain, review, store, mail, sender, prefs, now = Date.now }) {
  let lastEmailAt = -Infinity;
  const weekOf = (req) => (req && typeof req === 'object' && isWeek(req.week) ? req.week : null);

  function view(week) {
    const s = store.load();
    const keys = Object.keys(s.weeks).sort().reverse();
    const picked = week && s.weeks[week] ? week : keys[0];
    const gmail = sender.status();
    return {
      ok: true,
      weeks: keys.map((k) => ({ week: k, at: s.weeks[k].at, ok: Boolean(s.weeks[k].review), costUsd: s.weeks[k].costUsd })),
      entry: picked ? s.weeks[picked] : null,
      model: s.model,
      models: MISSION_MODELS,
      current: isoWeek(ymd(now())),
      generatable: generatable(now()),
      busy: review.isBusy(),
      mailOn: weeklyEmailOn(prefs.loadPrefs(), gmail.connected),
      gmail: { connected: gmail.connected },
    };
  }

  const safeView = (week) => {
    try {
      return view(week);
    } catch (err) {
      console.error('[weekly] view failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  };

  ipcMain.handle('life:week', (_event, req) => safeView(weekOf(req)));

  ipcMain.handle('life:week-generate', async (_event, req) => {
    const week = weekOf(req);
    if (!week || !generatable(now()).includes(week)) return { ok: false, reason: 'bad-week' };
    const res = await review.generate(week, { overwrite: req.overwrite === true });
    return res.ok ? safeView(week) : res;
  });

  ipcMain.handle('life:week-email', async (_event, req) => {
    const week = weekOf(req);
    if (!week) return { ok: false, reason: 'bad-week' };
    const at = now();
    if (at - lastEmailAt < EMAIL_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastEmailAt = at;
    const res = await mail.sendNow(week);
    return res.ok ? safeView(week) : res;
  });

  ipcMain.handle('life:week-model', (_event, req) => {
    try {
      store.setModel(req && req.model);
      return safeView(weekOf(req));
    } catch {
      return { ok: false, reason: 'bad-value' };
    }
  });
}

/**
 * Composition root for main.js: the store, the collector over the real
 * readers, the mailer, the review and its IPC. main.js only calls this and
 * then review.start().
 * @param {{ipcMain:object, ledgerRange:Function, github:object|null, body:()=>Promise<object|null>,
 *   projectNames:()=>Map<string,string>, getEnv:()=>object, sender:object, prefs:object,
 *   onResume?:(fn:Function)=>void}} deps
 */
function setupWeeklyReview(deps) {
  const { createWeeklyStore, createWeeklyReview } = require('./weeklyreview');
  const { createWeeklyCollect } = require('./weeklycollect');
  const { createWeeklyMail } = require('./weeklymail');
  const { runJob } = require('./missionrunner');
  const store = createWeeklyStore();
  const collect = createWeeklyCollect({
    ledgerRange: deps.ledgerRange,
    listRepos: () => require('./gitstation').loadRepoList().repos,
    readTodoStore: () => require('./todo').readStore(),
    projectNames: deps.projectNames,
    github: deps.github,
    loadGoals: () => require('./lifegoals').loadGoals(),
    loadBudget: () => require('./lifebudget').loadBudget(),
    body: deps.body,
    loadCheckin: () => require('./lifecheckin').loadCheckin(),
    loadHabits: () => require('./lifehabits').loadHabits(),
    loadSeries: () => require('./lifeseries').loadSeries(),
  });
  const mail = createWeeklyMail({ sender: deps.sender, prefs: deps.prefs, store });
  const review = createWeeklyReview({ collect: collect.collect, run: runJob, getEnv: deps.getEnv, store, mailer: mail, onResume: deps.onResume });
  registerWeeklyIpc({ ipcMain: deps.ipcMain, review, store, mail, sender: deps.sender, prefs: deps.prefs });
  return review;
}

module.exports = { registerWeeklyIpc, setupWeeklyReview };
