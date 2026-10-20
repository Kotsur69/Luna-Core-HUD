// ============================================================================
// LunaCore - Life dashboard IPC (main process)
// ----------------------------------------------------------------------------
// life:budget     {month?} -> {ok, summary, budget}  summary = lifebudgetcalc's
//                    view of the payday period starting in `month` ('YYYY-MM',
//                    default the current one); budget = the editable rows
//                    (income, categories, bills, goals) for the edit forms
// life:budget-do  {op, data, month?} -> same answer after the change, plus
//                    `created` (the new row id) for addExpense / addDeposit
// life:body        {force?} -> {ok, connected, body?}  YAZIO numbers (today +
//                    7 days); body is absent while not connected
// life:body-connect {email, password} -> {ok, persisted} | {ok:false, reason}
// life:body-disconnect -> {ok}  forgets the stored YAZIO login
// life:checkin* / life:habits* / life:goals* / life:score* - the daily
//                    side (check-in, habits, weekly goals, productivity
//                    score); see registerDailyIpc() below
//
// The renderer is untrusted: it names an op and sends a payload, and
// src/lifebudget.js's fixed op table validates all of it. Failures come back
// as fixed reason codes, never raw error text. The budget is shared with the
// other PCs through the cloud (src/lifesync.js: a read pulls their
// changes first, a write publishes soon after); only life:body* talk to the
// network (YAZIO, via src/lifeyazio.js). No model call. Lives outside main.js (past
// the file-size guideline); main.js only calls registerLifeIpc() once.
// ============================================================================

'use strict';

const store = require('./lifebudget');
const { budgetSummary } = require('./lifebudgetcalc');
const { createYazio, MAX_EMAIL: MAX_EMAIL_LEN, MAX_PASSWORD: MAX_PASSWORD_LEN } = require('./lifeyazio');
const { yazioSnapshot, newestYazioPeer } = require('./lifeyaziopeers');
const checkinStore = require('./lifecheckin');
const habitStore = require('./lifehabits');
const goalStore = require('./lifegoals');
const scorePrefs = require('./lifescoreprefs');
const { habitStatus } = require('./lifehabitcalc');
const { scoreReport } = require('./lifescore');
const { dayInputs, autoDays, goalsByWeek, nowStrip } = require('./lifescoreinputs');
const { ymd, addDays } = require('./lifedays');

/** How long the Body tab waits for another PC's copy before showing the login form. */
const PEER_TIMEOUT_MS = 4000;

// lifebudget.js error message -> reason code the renderer localizes.
const REASONS = {
  'bad op': 'bad-op',
  'bad payload': 'bad-payload',
  'bad amount': 'bad-amount',
  'bad day': 'bad-day',
  'bad date': 'bad-date',
  'bad month': 'bad-month',
  'bad text': 'bad-text',
  'bad id': 'bad-id',
  'bad value': 'bad-value',
  'bad category': 'bad-category',
  'bad week': 'bad-week',
  'not found': 'not-found',
  'too many': 'too-many',
  unreadable: 'unreadable',
};

// Every write is a full read + rewrite of the file: a renderer stuck in a
// loop must not turn that into a disk-thrashing storm. No person clicks
// twice within this gap.
const MIN_WRITE_GAP_MS = 100;
// Ops that append one row (lifebudget.js always appends at the end).
const CREATES = { addExpense: 'expenses', addDeposit: 'deposits' };
// A forced YAZIO refresh is 8 requests: a looping renderer must not hammer
// an unofficial API with Mati's account. Unforced reads come from the cache.
const MIN_FORCE_GAP_MS = 15 * 1000;
const MIN_CONNECT_GAP_MS = 3 * 1000;
// Background YAZIO refresh while logged in, so the phone and the other PCs
// get today's numbers without anyone opening the Body tab. One fetch is
// 8 requests: every 30 minutes stays far from hammering an unofficial API.
const BODY_EVERY_MS = 30 * 60 * 1000;
// The score polls while the dashboard is open; `gh` is a network call, so
// its answer (my open PRs) is reused for this long, a failure included.
const GITHUB_TTL_MS = 10 * 60 * 1000;
// A habits / score answer is reused this long (cleared by any daily write).
const READ_REUSE_MS = 1000;
const YAZIO_REASONS = new Set(['not-connected', 'bad-login', 'network', 'rate-limited', 'api-changed']);

function reasonOf(err) {
  // fs errors carry a code (EISDIR, EACCES, ENOSPC...): the save failed.
  if (err && typeof err.code === 'string') return 'write-failed';
  return (err && REASONS[err.message]) || 'failed';
}

// The viewed period: a valid month at most this far from today, else the
// current one. Anything malformed silently falls back - it is only a view.
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const VIEW_WINDOW_MONTHS = 36;

function viewMonth(req, nowMs) {
  const m = req && typeof req === 'object' && typeof req.month === 'string' ? MONTH_RE.exec(req.month) : null;
  if (!m) return undefined;
  const now = new Date(nowMs);
  const offset = (Number(m[1]) - now.getFullYear()) * 12 + (Number(m[2]) - 1 - now.getMonth());
  return Math.abs(offset) <= VIEW_WINDOW_MONTHS ? req.month : undefined;
}

function view(budget, nowMs, month) {
  const { income, categories, bills, goals } = budget;
  return { ok: true, summary: budgetSummary(budget, nowMs, month), budget: { income, categories, bills, goals } };
}

function yazioReason(err) {
  const reason = err && err.reason;
  if (YAZIO_REASONS.has(reason)) return reason;
  console.error('[life] yazio failed:', (err && (err.code || err.name)) || 'error');
  return 'failed';
}

/**
 * @param {{ipcMain: {handle: Function}, file?: string, now?: () => number,
 *   yazio?: object, sync?: {fresh: Function, soon: Function} | null}} deps
 *   file/now/yazio are injectable for tests; the real store path and a real
 *   YAZIO client are the defaults. sync = startLifeSync() in the app, none in tests.
 *   bodyEveryMs = background refresh period; 0 turns it off.
 * @returns {{stop: () => void}} stops the background refresh
 */
function registerLifeIpc({
  ipcMain,
  file,
  now = Date.now,
  yazio = createYazio(),
  sync = null,
  cloud = () => null,
  peerTimeoutMs = PEER_TIMEOUT_MS,
  bodyEveryMs = BODY_EVERY_MS,
  files = {},
  ledger = null,
  github = null,
  readTodoStore = () => require('./todo').readStore(),
}) {
  /** Shares the Body data with the other PCs and the phone; never waits, never throws. */
  const putYazio = (body) => {
    const log = (err) => console.error('[life] yazio cloud snapshot failed:', err && err.message);
    try {
      const live = cloud();
      const snap = yazioSnapshot(body, now());
      // Data that fails our own check must not replace a good row in the cloud.
      if (live && snap.body) Promise.resolve().then(() => live.put('yazio', snap)).catch(log);
    } catch (err) {
      log(err);
    }
  };

  /** Another PC's copy, or null when there is none or the cloud is slow. */
  const peerBody = async () => {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), peerTimeoutMs);
    });
    try {
      return await Promise.race([newestYazioPeer(cloud, now()), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  let lastWriteAt = -Infinity;
  let lastForceAt = -Infinity;
  let lastConnectAt = -Infinity;

  ipcMain.handle('life:budget', (_event, req) => {
    try {
      if (sync) sync.fresh();
      const at = now();
      return view(store.loadBudget(file), at, viewMonth(req, at));
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });

  ipcMain.handle('life:budget-do', (_event, req) => {
    if (!req || typeof req !== 'object' || typeof req.op !== 'string') return { ok: false, reason: 'bad-op' };
    const at = now();
    if (at - lastWriteAt < MIN_WRITE_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastWriteAt = at;
    try {
      const next = store.apply(req.op, req.data, file, at);
      if (sync) sync.soon();
      // A create answers its new row id, so the renderer can offer Undo.
      const rows = Object.hasOwn(CREATES, req.op) ? next[CREATES[req.op]] : null;
      const created = rows && rows.length ? rows[rows.length - 1].id : undefined;
      return { ...view(next, at, viewMonth(req, at)), created };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  });

  ipcMain.handle('life:body', async (_event, req) => {
    if (!yazio.status().connected) {
      // Not logged in here: show another PC's copy (read-only) when there is one.
      const peer = await peerBody();
      return peer ? { ok: true, connected: false, body: peer.body, from: { machine: peer.machine } } : { ok: true, connected: false };
    }
    let force = Boolean(req && typeof req === 'object' && req.force === true);
    if (force) {
      const at = now();
      // Too soon: answer from the cache instead of refusing outright.
      if (at - lastForceAt < MIN_FORCE_GAP_MS) force = false;
      else lastForceAt = at;
    }
    try {
      const body = await yazio.body({ force });
      // cloudsnapshots skips the upload while the content is unchanged.
      putYazio(body);
      return { ok: true, connected: true, body };
    } catch (err) {
      return { ok: false, connected: true, reason: yazioReason(err) };
    }
  });

  ipcMain.handle('life:body-connect', async (_event, req) => {
    // Lengths are bounded before any string work (validCreds re-checks after the trim).
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.email !== 'string' ||
      typeof req.password !== 'string' ||
      req.email.length > MAX_EMAIL_LEN ||
      req.password.length > MAX_PASSWORD_LEN
    ) {
      return { ok: false, reason: 'bad-login' };
    }
    const at = now();
    if (at - lastConnectAt < MIN_CONNECT_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastConnectAt = at;
    try {
      const { persisted } = await yazio.connect({ email: req.email.trim(), password: req.password });
      return { ok: true, persisted };
    } catch (err) {
      return { ok: false, reason: yazioReason(err) };
    }
  });

  ipcMain.handle('life:body-disconnect', () => {
    yazio.disconnect();
    return { ok: true };
  });

  registerDailyIpc({ ipcMain, files, now, ledger, github, readTodoStore, bodyForDaily: () => bodyForDaily(yazio, peerBody) });

  /** One background fetch + upload; never throws. A bad login stays blocked in lifeyazio (no network). */
  const refreshBody = async () => {
    if (!yazio.status().connected) return;
    try {
      putYazio(await yazio.body({ force: false }));
    } catch (err) {
      console.error('[life] yazio background refresh failed:', yazioReason(err));
    }
  };

  let timer = null;
  if (bodyEveryMs > 0) {
    timer = setInterval(refreshBody, bodyEveryMs);
    // Never keeps the process (or a test run) alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  }
  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// --- daily: check-in, habits, weekly goals, productivity score -------------------

/** Today's YAZIO numbers for habits / score: this PC's cache or another PC's copy; null on any failure. */
async function bodyForDaily(yazio, peerBody) {
  try {
    if (yazio.status().connected) return await yazio.body({ force: false });
    const peer = await peerBody();
    return peer ? peer.body : null;
  } catch {
    // No YAZIO numbers: the steps habit is just not auto-ticked, health is scored without them.
    return null;
  }
}

/**
 * life:checkin            -> {ok, today, entry, days}  entry null = not asked today
 * life:checkin-set        {date, sleep, energy} (both null = skipped) -> same
 * life:habits             -> {ok, today, yesterday, steps, habits: [{...habit, status}]}
 * life:habits-do          {op, data} -> same  (add/edit/remove/restore/tick)
 * life:goals              -> {ok, week, goals, lastWeek, last, isMonday}
 * life:goals-set          {op, data} -> same  (set/status)
 * life:score              -> {ok, score, now, prefs}  never fails on a source
 * life:score-prefs        {weights, focusTargetH} -> {ok, prefs}
 * Every store validates its whole payload and throws a fixed message; it
 * crosses back as a reason code. Each store has its own write rate limit.
 */
function registerDailyIpc({ ipcMain, files, now, ledger, github, readTodoStore, bodyForDaily: getBody }) {
  const lastWrite = new Map();
  /** Runs one write unless the same store was written within MIN_WRITE_GAP_MS. */
  const write = (key, fn) => {
    const at = now();
    if (at - (lastWrite.get(key) || -Infinity) < MIN_WRITE_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastWrite.set(key, at);
    // Any write can move the score: the next read computes it afresh.
    readCache.clear();
    try {
      return fn(at);
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  };
  const isReq = (req) => Boolean(req) && typeof req === 'object';

  // Reads that do real work (habits: YAZIO / cloud; score: the ledger scan +
  // every store) are shared while in flight and reused for READ_REUSE_MS, so
  // a looping renderer cannot turn them into a disk / network storm. A bug
  // inside answers a fixed reason code, never raw error text.
  const readCache = new Map();
  const read = (key, fn) => async () => {
    const hit = readCache.get(key);
    if (hit && (hit.pending || now() - hit.at < READ_REUSE_MS)) return hit.pending || hit.answer;
    const pending = Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error(`[life] ${key} failed:`, err && err.message);
        return { ok: false, reason: 'failed' };
      });
    readCache.set(key, { pending });
    const answer = await pending;
    if (readCache.get(key) && readCache.get(key).pending === pending) readCache.set(key, { at: now(), answer });
    return answer;
  };

  const checkinAnswer = (s, at) => ({ ok: true, ...checkinStore.checkinView(s, at) });
  ipcMain.handle('life:checkin', () => {
    const at = now();
    return checkinAnswer(checkinStore.loadCheckin(files.checkin), at);
  });
  ipcMain.handle('life:checkin-set', (_event, req) => {
    if (!isReq(req) || typeof req.date !== 'string') return { ok: false, reason: 'bad-date' };
    return write('checkin', (at) => checkinAnswer(checkinStore.setCheckin(req.date, { sleep: req.sleep, energy: req.energy }, files.checkin, at), at));
  });

  const habitsAnswer = async (s, at) => {
    const body = await getBody();
    const auto = autoDays(body);
    const today = ymd(at);
    return { ok: true, today, yesterday: addDays(today, -1), steps: Boolean(body), habits: s.habits.map((h) => ({ ...h, status: habitStatus(h, today, auto) })) };
  };
  ipcMain.handle('life:habits', read('habits', () => habitsAnswer(habitStore.loadHabits(files.habits), now())));
  ipcMain.handle('life:habits-do', async (_event, req) => {
    if (!isReq(req) || typeof req.op !== 'string') return { ok: false, reason: 'bad-op' };
    const res = write('habits', (at) => ({ ok: true, store: habitStore.applyHabits(req.op, req.data, files.habits, at), at }));
    if (!res.ok) return res;
    try {
      return await habitsAnswer(res.store, res.at);
    } catch (err) {
      console.error('[life] habits view failed:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
  });

  const goalsAnswer = (s, at) => ({ ok: true, ...goalStore.goalsView(s, at) });
  ipcMain.handle('life:goals', () => goalsAnswer(goalStore.loadGoals(files.goals), now()));
  ipcMain.handle('life:goals-set', (_event, req) => {
    if (!isReq(req) || typeof req.op !== 'string') return { ok: false, reason: 'bad-op' };
    return write('goals', (at) => goalsAnswer(goalStore.applyGoals(req.op, req.data, files.goals, at), at));
  });

  // My open PRs, cached; a failure is cached too (null = no shipping-PR data).
  let gh = { at: -Infinity, data: null, pending: null };
  const githubData = async () => {
    if (!github) return null;
    if (now() - gh.at < GITHUB_TTL_MS) return gh.data;
    if (!gh.pending) {
      gh.pending = Promise.resolve()
        .then(() => github.fetch())
        .catch((err) => {
          console.error('[life] github for score failed:', (err && err.reason) || 'error');
          return null;
        })
        .then((data) => {
          gh = { at: now(), data, pending: null };
          return data;
        });
    }
    return gh.pending;
  };
  const ledgerReport = async () => {
    if (!ledger) return null;
    try {
      const r = await ledger.report({});
      return r && r.ok ? r : null;
    } catch (err) {
      console.error('[life] ledger for score failed:', err && err.message);
      return null;
    }
  };
  const safeTodos = () => {
    try {
      return readTodoStore();
    } catch {
      // Unreadable to-dos: that sub-part simply has no data.
      return {};
    }
  };

  ipcMain.handle('life:score', read('score', async () => {
    const at = now();
    const today = ymd(at);
    const prefs = scorePrefs.loadScorePrefs(files.score);
    const [report, gh, body] = await Promise.all([ledgerReport(), githubData(), getBody()]);
    const days = dayInputs({
      today,
      report,
      github: gh,
      todoStore: safeTodos(),
      body,
      checkin: checkinStore.loadCheckin(files.checkin),
      habits: habitStore.loadHabits(files.habits).habits,
    });
    const score = scoreReport({ days, today, goalsByWeek: goalsByWeek(goalStore.loadGoals(files.goals)), weights: prefs.weights, focusTargetH: prefs.focusTargetH });
    return { ok: true, score, now: nowStrip(report, today, at), prefs };
  }));

  ipcMain.handle('life:score-prefs', (_event, req) => {
    if (!isReq(req)) return { ok: false, reason: 'bad-value' };
    return write('score', () => ({ ok: true, prefs: scorePrefs.setScorePrefs({ weights: req.weights, focusTargetH: req.focusTargetH }, files.score) }));
  });
}

module.exports = { registerLifeIpc };
