// ============================================================================
// LunaCore - notification hub: one pure collector per source (main process)
// ----------------------------------------------------------------------------
// docs/NOTIFICATION_HUB_PLAN.md "Sources -> items". Each collector is
// (state) -> HubItem[] and does no I/O: src/hubipc.js reads the files and
// in-memory views and hands them in. A broken or missing state yields [];
// runCollector() also turns a throw into [] so one bad source never takes the
// hub down. src/hub.js cleans, caps, dedupes and sorts what comes out.
//
// v1 sources: godmode (this PC's run reports), power countdowns, plan wait,
// life check-in, weekly goals, bills, update available. Usage % is dropped
// (the usage meter already shows it - plan Answer 2).
//
// Titles carry an English fallback plus an i18n key + vars, so the renderer
// shows them in pl or en. Report lines are model / test output: they stay
// plain text and src/hub.js strips control characters and caps them.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { reportLines } = require('./godmodesnapshot');
const { SLEEP_COUNTDOWN_MS, SHUTDOWN_DELAY_S } = require('./orchestraPower');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Local run reports older than this give no items (plan Risks: stale items). */
const GODMODE_WINDOW_MS = 14 * DAY_MS;
const MAX_RUNS = 10;
/** Per run, per section: a long report must not flood the drawer. */
const MAX_LINES_PER_RUN = 10;
/** The same window the Life dashboard uses for "due soon" (lifebudgetcalc SOON_DAYS). */
const BILL_STATUSES = new Set(['overdue', 'soon']);
const BILL_KINDS = new Set(['bill', 'subscription']);
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const KEY_PART_RE = /[^A-Za-z0-9._-]+/g;
const REPO_LINE_RE = /^- Repo: `([^`\n]*)`/m;
const RESULT_LINE_RE = /^- Result: (.+)$/m;
const UPDATE_STATES = new Set(['available', 'downloading', 'downloaded']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
/** A free-form key part (bill id, version) squeezed into the hub id charset. */
const keyPart = (v) => String(v == null ? '' : v).replace(KEY_PART_RE, '-').slice(0, 60);

/** Local midnight of 'YYYY-MM-DD' as epoch ms, or 0. */
function dayStart(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return 0;
  const ms = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Monday of an ISO week key '2026-W43' as local midnight, or 0. */
function weekStart(week) {
  if (typeof week !== 'string' || !WEEK_RE.test(week)) return 0;
  const [year, w] = [Number(week.slice(0, 4)), Number(week.slice(6))];
  // ISO week 1 holds January 4th; its Monday is the start of week 1.
  const jan4 = new Date(year, 0, 4);
  const monday1 = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
  return new Date(monday1.getFullYear(), monday1.getMonth(), monday1.getDate() + (w - 1) * 7).getTime();
}

/** Short stable key of a report line (fits the hub id charset). */
const lineKey = (line) => crypto.createHash('sha1').update(String(line)).digest('hex').slice(0, 10);

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

/** The '## Manual actions' bullet lines of a run report, as hub lines ([] for 'None.' or no section). */
const manualFromReport = (text) => reportLines(text).manualActionLines;

/**
 * Hub items for one God Mode run - shared by this PC's reports (here) and
 * the other PCs' snapshot rows (hubpeers.js), so a run and each of its lines
 * get the same id on every PC and a synced done mark clears them everywhere.
 * @param {{id:string, at:number, repo:string, result:string, needsYou:string[],
 *   manualActionLines:string[], runKind?:'needs'|'info', linesKind?:'needs'|'info',
 *   detail?:string, detailKey?:string, extraVars?:object, primary?:object, machine?:string}} run
 */
function runItems(run) {
  const common = {
    source: 'godmode',
    at: run.at,
    ...(run.primary ? { primary: run.primary } : {}),
    ...(run.machine ? { machine: run.machine } : {}),
  };
  const items = [{
    ...common,
    id: `godmode:${run.id}`,
    kind: run.runKind || 'info',
    title: run.result ? `God Mode: ${run.repo} - ${run.result}` : `God Mode: ${run.repo}`,
    key: 'hub.item.gmRun',
    vars: { repo: run.repo, result: run.result, ...(run.extraVars || {}) },
    ...(run.detail ? { detail: run.detail } : {}),
    ...(run.detailKey ? { detailKey: run.detailKey } : {}),
  }];
  // Keyed by the line's text, not its index: a changed line is a new item,
  // so an old done mark never hides it.
  const line = (section) => (text) => ({
    ...common,
    id: `godmode:${run.id}:${section}:${lineKey(text)}`,
    kind: run.linesKind || 'needs',
    title: text,
    detail: `God Mode: ${run.repo}`,
    detailKey: section === 'manual' ? 'hub.item.gmManualFrom' : 'hub.item.gmNeedsFrom',
    vars: { repo: run.repo },
  });
  items.push(...list(run.needsYou).map(line('needs')), ...list(run.manualActionLines).map(line('manual')));
  return items;
}

/**
 * This PC's God Mode run reports -> one info item per run, plus one needs
 * item per Needs-you line and per manual action (those carry the badge).
 * @param {{runs:Array<{id:string, mtime:number, text:string}>, now:number}} state
 */
function collectGodmode(state) {
  if (!isObject(state) || !isTime(state.now)) return [];
  const runs = list(state.runs)
    .filter((r) => isObject(r) && RUN_ID_RE.test(r.id) && isTime(r.mtime) && typeof r.text === 'string')
    .filter((r) => r.mtime >= state.now - GODMODE_WINDOW_MS)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_RUNS);
  return runs.flatMap((run) => {
    const repoMatch = REPO_LINE_RE.exec(run.text);
    const resultMatch = RESULT_LINE_RE.exec(run.text);
    const repoPath = repoMatch ? repoMatch[1] : '';
    const { needsYou, manualActionLines } = reportLines(run.text, repoPath ? [repoPath] : []);
    return runItems({
      id: run.id,
      at: run.mtime,
      repo: baseName(repoPath) || run.id,
      result: resultMatch ? resultMatch[1].trim() : '',
      needsYou: needsYou.slice(0, MAX_LINES_PER_RUN),
      manualActionLines: manualActionLines.slice(0, MAX_LINES_PER_RUN),
      primary: { action: 'openReport', arg: run.id },
    });
  });
}

/**
 * The God Mode project a local action belongs to (one run per project): the
 * drawer passes it to the scoped orchestra IPC. src/hub.js re-checks it.
 */
const projectRef = (projectId) => (typeof projectId === 'string' && projectId ? { project: projectId } : {});

/**
 * The sleep / shutdown countdowns of every project's run ({powers:
 * [{projectId, power}]}) or of one run ({power}, orchestraPower view()).
 */
function collectPower(state) {
  if (!isObject(state)) return [];
  if (!Array.isArray(state.powers)) return powerItems(state);
  return state.powers.filter(isObject).flatMap((p) => powerItems({ power: p.power, projectId: p.projectId, now: state.now }));
}

/** One run's countdowns while they run. */
function powerItems(state) {
  if (!isObject(state) || !isObject(state.power) || !isTime(state.now)) return [];
  const items = [];
  const { sleep, shutdown } = state.power;
  if (isObject(sleep) && sleep.phase === 'countdown' && isTime(sleep.at) && sleep.at > state.now) {
    items.push({
      id: `power:sleep:${sleep.at}`,
      kind: 'needs',
      source: 'power',
      title: 'The PC sleeps soon (usage limit)',
      key: 'hub.item.sleep',
      at: sleep.at - SLEEP_COUNTDOWN_MS,
      expiresAt: sleep.at,
      local: true,
      ...projectRef(state.projectId),
      primary: { action: 'cancelPower', arg: 'sleep' },
    });
  }
  if (isObject(shutdown) && shutdown.phase === 'countdown' && isTime(shutdown.at) && shutdown.at > state.now) {
    items.push({
      id: `power:shutdown:${shutdown.at}`,
      kind: 'needs',
      source: 'power',
      title: 'The PC shuts down soon (run finished)',
      key: 'hub.item.shutdown',
      at: shutdown.at - SHUTDOWN_DELAY_S * 1000,
      expiresAt: shutdown.at,
      local: true,
      ...projectRef(state.projectId),
      primary: { action: 'cancelPower', arg: 'shutdown' },
    });
  }
  return items;
}

/**
 * Planning that waits for the Claude limit reset (orchestraPlanWait view()).
 * @param {{wait:object|null, now:number}} state
 */
function planWaitItems(state) {
  if (!isObject(state) || !isObject(state.wait) || !isTime(state.now)) return [];
  const { wait } = state;
  if (wait.state !== 'waiting' || !isTime(wait.resumeAt)) return [];
  const d = new Date(wait.resumeAt);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return [{
    id: `planwait:${wait.resumeAt}`,
    kind: 'info',
    source: 'planwait',
    title: `Planning resumes at ${time}`,
    key: 'hub.item.planWait',
    vars: { time },
    at: wait.resumeAt,
    local: true,
    ...projectRef(state.projectId),
    primary: { action: 'cancelPlanWait' },
  }];
}

/**
 * Planning waits of every project's run ({waits: [{projectId, wait}]}, one
 * God Mode run per project) or of one run ({wait}).
 */
function collectPlanWait(state) {
  if (!isObject(state)) return [];
  if (!Array.isArray(state.waits)) return planWaitItems(state);
  return state.waits.filter(isObject).flatMap((w) => planWaitItems({ wait: w.wait, projectId: w.projectId, now: state.now }));
}

/**
 * Today's check-in when it was neither answered nor skipped (lifecheckin checkinView()).
 * @param {{checkin:{today:string, entry:object|null}|null}} state
 */
function collectCheckin(state) {
  const c = isObject(state) && isObject(state.checkin) ? state.checkin : null;
  if (!c || !DAY_RE.test(String(c.today)) || c.entry !== null) return [];
  return [{
    id: `life:checkin:${c.today}`,
    kind: 'needs',
    source: 'life',
    title: 'Daily check-in',
    key: 'hub.item.checkin',
    at: dayStart(c.today),
    primary: { action: 'openLife', arg: 'health' },
  }];
}

/**
 * This ISO week's goals not set yet - null means "not asked", [] means skipped
 * (lifegoals goalsView(); the same rule as the inbox and the Life dashboard).
 * @param {{goals:{week:string, goals:Array|null}|null}} state
 */
function collectGoals(state) {
  const g = isObject(state) && isObject(state.goals) ? state.goals : null;
  if (!g || !WEEK_RE.test(String(g.week)) || g.goals !== null) return [];
  return [{
    id: `life:goals:${g.week}`,
    kind: 'needs',
    source: 'life',
    title: "Set this week's 3 goals",
    key: 'hub.item.goals',
    at: weekStart(g.week),
    primary: { action: 'openLife', arg: 'week' },
  }];
}

/**
 * Bills due within 3 days or overdue and not paid (lifebudgetcalc
 * budgetSummary(): its rows already carry the status). Savings transfers are
 * not bills to chase.
 * @param {{summary:{currency:string, bills:object[]}|null}} state
 */
function collectBills(state) {
  const s = isObject(state) && isObject(state.summary) ? state.summary : null;
  if (!s) return [];
  const currency = typeof s.currency === 'string' ? s.currency.slice(0, 8) : '';
  return list(s.bills)
    .filter((b) => isObject(b) && BILL_STATUSES.has(b.status) && BILL_KINDS.has(b.kind))
    .filter((b) => typeof b.name === 'string' && b.name && DAY_RE.test(String(b.dueDate)) && keyPart(b.id))
    .map((b) => {
      const amount = typeof b.expected === 'number' && Number.isFinite(b.expected) ? `${b.expected} ${currency}`.trim() : '';
      const overdue = b.status === 'overdue';
      return {
        id: `bills:${keyPart(b.id)}:${keyPart(b.month || b.dueDate)}`,
        kind: 'needs',
        source: 'bills',
        title: `${b.name}${amount ? ` ${amount}` : ''} ${overdue ? 'overdue since' : 'due'} ${b.dueDate}`,
        key: overdue ? 'hub.item.billOverdue' : 'hub.item.billDue',
        vars: { name: b.name, amount, due: b.dueDate },
        at: dayStart(b.dueDate),
        primary: { action: 'openLife', arg: 'bills' },
      };
    });
}

/**
 * A newer LunaCore (main's update state: available / downloading / downloaded).
 * @param {{update:{state:string, info:{version:string, releaseDate?:string}|null}|null, now:number}} state
 */
function collectUpdate(state) {
  const u = isObject(state) && isObject(state.update) ? state.update : null;
  if (!u || !UPDATE_STATES.has(u.state) || !isObject(u.info) || typeof u.info.version !== 'string') return [];
  const version = u.info.version.trim().slice(0, 40);
  if (!keyPart(version)) return [];
  const released = typeof u.info.releaseDate === 'string' ? Date.parse(u.info.releaseDate) : NaN;
  const today = isTime(state.now) ? new Date(state.now).setHours(0, 0, 0, 0) : 0;
  return [{
    id: `update:${keyPart(version)}`,
    kind: 'info',
    source: 'update',
    title: `LunaCore ${version} is ready`,
    key: 'hub.item.update',
    vars: { version },
    at: Number.isFinite(released) && released > 0 ? released : today,
    primary: { action: 'installUpdate' },
  }];
}

// --- N5: the remaining sources ------------------------------------------------

/** A cloud sync error only counts once it has lasted this long (one failed poll is noise). */
const CLOUD_ERROR_GRACE_MS = 10 * 60 * 1000;
/** A weekly review is "ready" for this long after it was written. */
const WEEKLY_READY_MS = 7 * DAY_MS;
const SETTINGS_SETUP = 'setup-center';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_APPROVALS = 20;
const HOST_PENDING = new Set(['no-cloud', 'login', 'pair']);

/** Local midnight of the day holding `now`: a stable `at` for a standing condition. */
const midnight = (now) => new Date(now).setHours(0, 0, 0, 0);

/**
 * 'YYYY-MM-DD' (local) of `now`. A standing per-PC condition (logged out,
 * disconnected, host setup) carries it in its id: done marks sync to every
 * PC and live 30 days, so a constant id would hide the condition everywhere
 * for a month. With the day in it, "Mark done" snoozes it until tomorrow.
 */
const dayKey = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Mission Control's last mail scan: threads the model put in "needs your
 * call" (missioncontrolipc.js lastPreview). One item per scan; it clears when
 * the scan is applied and none are left.
 * @param {{mail:{needsCall:number, at:number}|null}} state
 */
function collectMail(state) {
  const m = isObject(state) && isObject(state.mail) ? state.mail : null;
  if (!m || !Number.isSafeInteger(m.needsCall) || m.needsCall < 1 || !isTime(m.at)) return [];
  const count = Math.min(m.needsCall, 999);
  return [{
    id: `mail:needscall:${m.at}`,
    kind: 'needs',
    source: 'mail',
    title: `${count} mails need your call`,
    key: 'hub.item.mailNeedsCall',
    vars: { count },
    at: m.at,
    primary: { action: 'openMission' },
  }];
}

/**
 * Cloud sync (cloudsync.js status()): configured but logged out, or an error
 * that has lasted CLOUD_ERROR_GRACE_MS. No cloud configured = nothing (a
 * friend without Supabase is not nagged). The error text never travels.
 * @param {{cloud:{configured?:boolean, loggedIn?:boolean, error?:string|null, lastSync?:number|null}|null, now:number}} state
 */
function collectCloud(state) {
  const c = isObject(state) && isObject(state.cloud) ? state.cloud : null;
  if (!c || c.configured === false || !isTime(state.now)) return [];
  const primary = { action: 'openSettings', arg: SETTINGS_SETUP };
  if (c.loggedIn !== true) {
    return [{ id: `cloud:loggedout:${dayKey(state.now)}`, kind: 'needs', source: 'cloud', title: 'Cloud sync is off: log in', key: 'hub.item.cloudLoggedOut', at: midnight(state.now), primary }];
  }
  // Without a last good sync there is no telling how long it has failed (an
  // offline launch): the Setup Center shows that case, the hub waits.
  if (!c.error || !isTime(c.lastSync) || state.now - c.lastSync < CLOUD_ERROR_GRACE_MS) return [];
  return [{ id: `cloud:error:${c.lastSync}`, kind: 'needs', source: 'cloud', title: 'Cloud sync keeps failing', key: 'hub.item.cloudError', at: c.lastSync, primary }];
}

/**
 * Google Calendar (gcal.js status()): a client was set up, the grant is gone.
 * Not set up at all = nothing.
 * @param {{google:{configured:boolean, connected:boolean}|null, now:number}} state
 */
function collectGoogle(state) {
  const g = isObject(state) && isObject(state.google) ? state.google : null;
  if (!g || g.configured !== true || g.connected !== false || !isTime(state.now)) return [];
  return [{ id: `google:disconnected:${dayKey(state.now)}`, kind: 'needs', source: 'google', title: 'Google disconnected: reconnect', key: 'hub.item.googleOff', at: midnight(state.now), primary: { action: 'openSettings', arg: SETTINGS_SETUP } }];
}

/**
 * Host mode is on in this HUD but not ready (hostsetup.js decideSetup():
 * 'no-cloud' | 'login' | 'pair' | 'ready'). Host mode off = nothing.
 * @param {{host:{on:boolean, state:string}|null, now:number}} state
 */
function collectHost(state) {
  const h = isObject(state) && isObject(state.host) ? state.host : null;
  if (!h || h.on !== true || !HOST_PENDING.has(h.state) || !isTime(state.now)) return [];
  return [{ id: `host:setup:${h.state}:${dayKey(state.now)}`, kind: 'needs', source: 'host', title: 'Luna host on this PC needs setup', key: 'hub.item.hostSetup', at: midnight(state.now), local: true, primary: { action: 'openSettings', arg: SETTINGS_SETUP } }];
}

/**
 * Open to-do items flagged `manual` (the [Mati] cards God Mode leaves to the
 * user) across every project list (todo.js readStore()): one info count.
 * Keyed by the count, so a new manual card brings a dismissed count back.
 * @param {{store:Object<string, Array<{done?:boolean, manual?:boolean}>>|null, now:number}} state
 */
function collectTodo(state) {
  const store = isObject(state) && isObject(state.store) ? state.store : null;
  if (!store || !isTime(state.now)) return [];
  const count = Object.values(store).reduce((n, items) => n + list(items).filter((i) => isObject(i) && i.manual === true && i.done !== true).length, 0);
  if (!count) return [];
  return [{ id: `todo:manual:${count}`, kind: 'info', source: 'todo', title: `${count} manual to-dos`, key: 'hub.item.todoManual', vars: { count }, at: midnight(state.now) }];
}

/**
 * The newest weekly review (weeklyreview.js store load()), while it is fresh:
 * a 'brief' that opens Life -> Week. A failed review is not "ready".
 * @param {{weekly:{weeks:Object<string, {at:number, review:object|null}>}|null, now:number}} state
 */
function collectWeekly(state) {
  const w = isObject(state) && isObject(state.weekly) && isObject(state.weekly.weeks) ? state.weekly.weeks : null;
  if (!w || !isTime(state.now)) return [];
  const week = Object.keys(w).filter((k) => WEEK_RE.test(k)).sort().pop();
  const entry = week ? w[week] : null;
  if (!isObject(entry) || !entry.review || !isTime(entry.at)) return [];
  if (entry.at > state.now || state.now - entry.at > WEEKLY_READY_MS) return [];
  return [{ id: `life:weekly:${week}`, kind: 'brief', source: 'life', title: 'Weekly review is ready', key: 'hub.item.weeklyReady', at: entry.at, primary: { action: 'openLife', arg: 'week' } }];
}

/**
 * God Mode workers sitting on a permission prompt (orchestra view() packages
 * stalled with 'needsApproval'), for every project's run. The primary action
 * jumps to the worker's tab. Clears when the prompt is answered.
 * @param {{views:Array<{projectId:string, view:{id:string, packages:object[]}|null}>, now:number}} state
 */
function collectApproval(state) {
  if (!isObject(state) || !isTime(state.now)) return [];
  const items = [];
  for (const v of list(state.views)) {
    const view = isObject(v) && isObject(v.view) ? v.view : null;
    if (!view || !RUN_ID_RE.test(String(view.id))) continue;
    for (const p of list(view.packages)) {
      if (!isObject(p) || p.state !== 'stalled' || p.error !== 'needsApproval') continue;
      if (typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId) || !keyPart(p.id)) continue;
      const name = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 80) : String(p.id);
      items.push({
        id: `approval:${view.id}:${keyPart(p.id)}`,
        kind: 'needs',
        source: 'approval',
        title: `${name} waits for an approval`,
        key: 'hub.item.approval',
        vars: { name },
        at: isTime(p.startedAt) ? p.startedAt : midnight(state.now),
        local: true,
        primary: { action: 'openTab', arg: p.sessionId },
      });
    }
  }
  return items.slice(0, MAX_APPROVALS);
}

/** Source name -> collector. src/hubipc.js builds one state per name. */
const COLLECTORS = {
  godmode: collectGodmode,
  power: collectPower,
  planwait: collectPlanWait,
  checkin: collectCheckin,
  goals: collectGoals,
  bills: collectBills,
  update: collectUpdate,
  mail: collectMail,
  cloud: collectCloud,
  google: collectGoogle,
  host: collectHost,
  todo: collectTodo,
  weekly: collectWeekly,
  approval: collectApproval,
};

/** Runs one collector; a throw or a non-array answer becomes []. */
function runCollector(fn, state) {
  try {
    const out = fn(state);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

module.exports = {
  COLLECTORS,
  runCollector,
  collectGodmode,
  collectPower,
  collectPlanWait,
  collectCheckin,
  collectGoals,
  collectBills,
  collectUpdate,
  collectMail,
  collectCloud,
  collectGoogle,
  collectHost,
  collectTodo,
  collectWeekly,
  collectApproval,
  CLOUD_ERROR_GRACE_MS,
  WEEKLY_READY_MS,
  manualFromReport,
  runItems,
  lineKey,
  weekStart,
  dayStart,
  GODMODE_WINDOW_MS,
  MAX_RUNS,
  MAX_LINES_PER_RUN,
};
