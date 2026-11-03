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
const { needsFromReport } = require('./godmodeneeds');
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

/** The '## Manual actions' bullet lines of a run report ([] for 'None.' or no section). */
function manualFromReport(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.indexOf('## Manual actions');
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2).replace(/`/g, '').trim();
    if (body) out.push(body);
  }
  return out;
}

/** True for the Needs-you line that only points at the Manual actions section. */
const isManualPointer = (line) => /manual actions? to apply live/i.test(line);

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
  const items = [];
  for (const run of runs) {
    const repoMatch = REPO_LINE_RE.exec(run.text);
    const resultMatch = RESULT_LINE_RE.exec(run.text);
    const repo = baseName(repoMatch ? repoMatch[1] : '') || run.id;
    const result = resultMatch ? resultMatch[1].trim() : '';
    const open = { action: 'openReport', arg: run.id };
    const needs = (needsFromReport(run.text) || [])
      .filter((l) => !/^\s/.test(l) && !isManualPointer(l))
      .map((l) => l.replace(/^- /, ''))
      .filter(Boolean)
      .slice(0, MAX_LINES_PER_RUN);
    const manual = manualFromReport(run.text).slice(0, MAX_LINES_PER_RUN);
    items.push({
      id: `godmode:${run.id}`,
      kind: 'info',
      source: 'godmode',
      title: result ? `God Mode: ${repo} - ${result}` : `God Mode: ${repo}`,
      key: 'hub.item.gmRun',
      vars: { repo, result },
      at: run.mtime,
      primary: open,
    });
    // Keyed by the line's text, not its index: a changed line is a new item,
    // so an old done mark never hides it.
    const line = (section) => (text) => ({
      id: `godmode:${run.id}:${section}:${lineKey(text)}`,
      kind: 'needs',
      source: 'godmode',
      title: text,
      detail: `God Mode: ${repo}`,
      detailKey: section === 'manual' ? 'hub.item.gmManualFrom' : 'hub.item.gmNeedsFrom',
      vars: { repo },
      at: run.mtime,
      primary: open,
    });
    items.push(...needs.map(line('needs')), ...manual.map(line('manual')));
  }
  return items;
}

/**
 * The sleep / shutdown countdowns (orchestraPower view()) while they run.
 * @param {{power:object|null, now:number}} state
 */
function collectPower(state) {
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
      primary: { action: 'cancelPower', arg: 'shutdown' },
    });
  }
  return items;
}

/**
 * Planning that waits for the Claude limit reset (orchestraPlanWait view()).
 * @param {{wait:object|null, now:number}} state
 */
function collectPlanWait(state) {
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
    primary: { action: 'cancelPlanWait' },
  }];
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

/** Source name -> collector. src/hubipc.js builds one state per name. */
const COLLECTORS = {
  godmode: collectGodmode,
  power: collectPower,
  planwait: collectPlanWait,
  checkin: collectCheckin,
  goals: collectGoals,
  bills: collectBills,
  update: collectUpdate,
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
  manualFromReport,
  lineKey,
  weekStart,
  dayStart,
  GODMODE_WINDOW_MS,
  MAX_RUNS,
  MAX_LINES_PER_RUN,
};
