// ============================================================================
// LunaCore - weekly review: the week's numbers as plain JSON (main process)
// ----------------------------------------------------------------------------
// collect('2026-W43') gathers one local Mon-Sun week from sources that
// already exist, with no model call:
//   claude    W1 cost + share per project, split work / fun / other
//             (missionledgerservice.range, every synced PC)
//   hours     W2 focus hours per project, same split
//   repos     per repo in config/repos.local.json: own commits (author email
//             = the repo's user.email, as missioncommits.js decides), feat:
//             subjects, fix: count, +/- lines
//   todos     open to-dos per project (src/todo.js)
//   github    telemetry flags (this week vs the 4-week average, quiet days)
//             and my open PRs / issues (missiongithub.js)
//   goals     the week's W4 goals (src/lifegoals.js)
//   budget    spending per category, this week vs the week before - totals
//             only, never single expenses (src/lifebudgettrend.js)
//   body      YAZIO week averages; checkin averages; habit streaks
//   correlations the top 3 from src/lifecorrelate.js
// Output rules: no file paths (a repo is its folder NAME), every list capped,
// every string capped. A failing source becomes {error: '<code>'} and the
// rest of the week still comes back.
//
// git runs with execFile (argv array, no shell), cwd = the repo, a minimal
// environment, `-c core.fsmonitor=false` (a repo's config cannot start a
// hook program), a 15 s timeout, and `--` closing the options.
// ============================================================================

'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { ymd, parseDay, addDays, weekMonday, isWeek } = require('./lifedays');
const { habitStatus } = require('./lifehabitcalc');
const { autoDays } = require('./lifescoreinputs');
const { kcalHit, proteinHit } = require('./lifescore');
const { expensesIn } = require('./lifebudgettrend');
const { categoryOf } = require('./lifebudgetdates');
const { topCorrelations, phrase } = require('./lifecorrelate');

const GIT_TIMEOUT_MS = 15000;
const SAFE_GIT = ['-c', 'core.fsmonitor=false'];
const MAX_REPOS = 50;
const MAX_OUT_REPOS = 20;
const MAX_FEAT = 8;
const MAX_PROJECTS = 15;
const MAX_TODO_ITEMS = 5;
const MAX_LIST = 5;
const MAX_HABITS = 30;
const MAX_CATEGORIES = 30;
const MAX_TEXT = 140;
const MAX_NAME = 80;
const MAX_EMAIL = 254;
const AVG_WEEKS = 4;
const QUIET_DAYS = 3;
const LOW_PACE = 0.5;
const HOUR_MS = 60 * 60 * 1000;
const CLASSES = ['work', 'fun', 'other'];
const KIND_RE = /^(feat|fix)(\([^)]*\))?!?:/i;
const RECORD = '\x1e';

// eslint-disable-next-line no-control-regex
const clean = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const usableRepo = (dir) => typeof dir === 'string' && path.isAbsolute(dir) && !/^[\\/]{2}/.test(dir);
const repoName = (dir) => clean(path.basename(dir), MAX_NAME);

/** The local Mon-Sun week of an ISO week key: days + [sinceMs, untilMs). null for a bad key. */
function weekBounds(week) {
  if (!isWeek(week)) return null;
  const monday = weekMonday(week);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { week, monday, sunday: days[6], days, sinceMs: parseDay(monday).getTime(), untilMs: parseDay(addDays(monday, 7)).getTime() };
}

/** Only what git needs to run: no tokens, no proxies, no GIT_* overrides from the parent. */
function minimalEnv(src = process.env) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'LANG'];
  const env = {};
  for (const k of keep) if (typeof src[k] === 'string') env[k] = src[k];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/** git in `dir` with an argv array; resolves {ok, stdout}, never rejects. */
function runGitDefault(dir, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, env: minimalEnv(), timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout || '' })
    );
  });
}

/** git log args for own-commit stats in [sinceMs, untilMs). */
const logArgs = (sinceMs, untilMs) => [
  ...SAFE_GIT,
  'log',
  '--all',
  '--no-merges',
  `--since=${new Date(sinceMs).toISOString()}`,
  `--until=${new Date(untilMs).toISOString()}`,
  '--numstat',
  '--format=%x1e%at%x09%ae%x09%s',
  '--',
];

/**
 * `git log --numstat --format=%x1e%at%x09%ae%x09%s` -> this author's commits
 * inside the window as {ms, subject, kind, added, removed}.
 */
function parseNumstat(stdout, email, sinceMs, untilMs) {
  const me = String(email).trim().toLowerCase();
  const out = [];
  for (const rec of String(stdout).split(RECORD)) {
    const lines = rec.split(/\r?\n/);
    const m = /^(\d{1,12})\t([^\t]+)\t?(.*)$/.exec(lines[0] || '');
    if (!m || m[2].trim().toLowerCase() !== me) continue;
    const ms = Number(m[1]) * 1000;
    if (ms < sinceMs || ms >= untilMs) continue;
    let added = 0;
    let removed = 0;
    for (const line of lines.slice(1)) {
      const n = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!n) continue;
      added += n[1] === '-' ? 0 : Number(n[1]);
      removed += n[2] === '-' ? 0 : Number(n[2]);
    }
    const kind = KIND_RE.exec(m[3] || '');
    out.push({ ms, subject: clean(m[3]), kind: kind ? kind[1].toLowerCase() : '', added, removed });
  }
  return out;
}

/**
 * Own-commit stats per repo for [sinceMs, untilMs). Repos with no own
 * commits are left out; a repo whose git failed is counted in `failed`.
 * @returns {Promise<{repos:Array, failed:number}>}
 */
async function repoStats({ listRepos, runGit = runGitDefault, sinceMs, untilMs }) {
  const dirs = [...new Set((listRepos() || []).filter(usableRepo))].slice(0, MAX_REPOS);
  const repos = [];
  let failed = 0;
  // One repo at a time: nobody waits on the exact second, and the PC stays responsive.
  for (const dir of dirs) {
    try {
      const cfg = await runGit(dir, [...SAFE_GIT, 'config', 'user.email'], GIT_TIMEOUT_MS);
      const email = cfg && cfg.ok ? cfg.stdout.trim() : '';
      if (!email || email.length > MAX_EMAIL) continue;
      const log = await runGit(dir, logArgs(sinceMs, untilMs), GIT_TIMEOUT_MS);
      if (!log || !log.ok) {
        failed += 1;
        continue;
      }
      const commits = parseNumstat(log.stdout, email, sinceMs, untilMs);
      if (!commits.length) continue;
      repos.push({
        repo: repoName(dir),
        commits: commits.length,
        feat: commits.filter((c) => c.kind === 'feat').map((c) => c.subject).slice(0, MAX_FEAT),
        fix: commits.filter((c) => c.kind === 'fix').length,
        added: commits.reduce((s, c) => s + c.added, 0),
        removed: commits.reduce((s, c) => s + c.removed, 0),
      });
    } catch {
      failed += 1;
    }
  }
  repos.sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo));
  return { repos: repos.slice(0, MAX_OUT_REPOS), failed };
}

const classOf = (cls) => (CLASSES.includes(cls) ? cls : 'unassigned');

/** Claude cost and focus hours from one ledger range answer. */
function ledgerParts(report) {
  const usd = { work: 0, fun: 0, other: 0, unassigned: 0 };
  for (const p of report.projects) usd[classOf(p.cls)] += p.usd;
  const total = report.totalUsd;
  const share = (v) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 0);
  const claude = {
    totalUsd: r2(total),
    byClass: Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, { usd: r2(v), pct: share(v) }])),
    projects: report.projects.slice(0, MAX_PROJECTS).map((p) => ({ name: clean(p.name, MAX_NAME), usd: r2(p.usd), pct: share(p.usd), cls: classOf(p.cls) })),
  };
  const hoursBy = { work: 0, fun: 0, other: 0, unassigned: 0 };
  for (const p of report.hours) hoursBy[classOf(p.cls)] += p.ms;
  const hours = {
    totalH: r1(report.hours.reduce((s, p) => s + p.ms, 0) / HOUR_MS),
    byClass: Object.fromEntries(Object.entries(hoursBy).map(([k, v]) => [k, r1(v / HOUR_MS)])),
    projects: report.hours.slice(0, MAX_PROJECTS).map((p) => ({ name: clean(p.name, MAX_NAME), hours: r1(p.ms / HOUR_MS), cls: classOf(p.cls) })),
  };
  return { claude, hours };
}

/** Open to-dos per project, the busiest first. `names` maps a project id to its label. */
function openTodos(store, names) {
  const projects = [];
  let totalOpen = 0;
  for (const [id, list] of Object.entries(store && typeof store === 'object' ? store : {})) {
    const open = (Array.isArray(list) ? list : []).filter((t) => t && !t.done && typeof t.text === 'string');
    if (!open.length) continue;
    totalOpen += open.length;
    projects.push({ project: clean(names.get(id) || id, MAX_NAME), open: open.length, items: open.slice(0, MAX_TODO_ITEMS).map((t) => clean(t.text)) });
  }
  projects.sort((a, b) => b.open - a.open || a.project.localeCompare(b.project));
  return { totalOpen, projects: projects.slice(0, MAX_PROJECTS) };
}

/** GitHub telemetry for the week: contributions vs the 4 weeks before, quiet days, open work. */
function githubWeek(gh, b) {
  const counts = new Map((Array.isArray(gh.days) ? gh.days : []).map((d) => [d.date, d.count]));
  const sumWeek = (monday) => Array.from({ length: 7 }, (_, i) => counts.get(addDays(monday, i)) || 0).reduce((s, x) => s + x, 0);
  const thisWeek = sumWeek(b.monday);
  const prior = Array.from({ length: AVG_WEEKS }, (_, i) => addDays(b.monday, -7 * (i + 1))).filter((m) => counts.has(m));
  const avgWeek = prior.length ? r1(avg(prior.map(sumWeek))) : null;
  let quietDays = 0;
  for (let i = 6; i >= 0 && counts.get(b.days[i]) === 0; i--) quietDays += 1;
  const flags = [];
  if (avgWeek !== null && avgWeek > 0 && thisWeek < avgWeek * LOW_PACE) flags.push('lowOutput');
  if (quietDays >= QUIET_DAYS) flags.push('quiet');
  const list = (kind) => (gh.lists && gh.lists[kind]) || { count: 0, items: [] };
  const items = (kind) => list(kind).items.slice(0, MAX_LIST).map((it) => ({ repo: clean(it.repo, MAX_NAME), title: clean(it.title), draft: it.draft === true }));
  return {
    contributions: thisWeek,
    avgWeek,
    quietDays,
    flags,
    openPrs: list('prs').count,
    prs: items('prs'),
    reviewRequests: list('reviews').count,
    openIssues: list('issues').count,
    issues: items('issues'),
  };
}

/** Spending per category, this week vs the week before; totals only. */
function budgetWeek(budget, b) {
  const catOf = categoryOf(budget);
  const names = new Map(budget.categories.map((c) => [c.id, c.name || c.id]));
  const total = (list, id) => r2(list.filter((e) => catOf(e) === id).reduce((s, e) => s + e.amount, 0));
  const week = expensesIn(budget, { start: b.monday, end: b.sunday });
  const prev = expensesIn(budget, { start: addDays(b.monday, -7), end: addDays(b.monday, -1) });
  const ids = [...new Set([...budget.categories.map((c) => c.id), 'other'])];
  const categories = ids
    .map((id) => ({ name: clean(names.get(id) || id, MAX_NAME), amount: total(week, id), prev: total(prev, id) }))
    .filter((c) => c.amount > 0 || c.prev > 0)
    .sort((a, b2) => b2.amount - a.amount)
    .slice(0, MAX_CATEGORIES);
  return { total: r2(week.reduce((s, e) => s + e.amount, 0)), prevTotal: r2(prev.reduce((s, e) => s + e.amount, 0)), categories };
}

/** YAZIO averages over the days of the week it has history for. */
function bodyWeek(body, b) {
  const inWeek = new Set(b.days);
  const hist = (Array.isArray(body.history) ? body.history : []).filter((h) => h && inWeek.has(h.date));
  if (!hist.length) return { days: 0 };
  const proteinGoal = body.today ? body.today.proteinGoal : 0;
  const nums = (k) => hist.map((h) => h[k]).filter((v) => typeof v === 'number' && v > 0);
  const hits = (fn) => hist.filter((h) => fn(h) === true).length;
  const a = (k) => (nums(k).length ? Math.round(avg(nums(k))) : null);
  return {
    days: hist.length,
    avgKcal: a('kcal'),
    kcalGoal: body.today && body.today.kcalGoal ? Math.round(body.today.kcalGoal) : null,
    kcalHitDays: hits((h) => kcalHit(h.kcal, h.kcalGoal)),
    avgProtein: a('protein'),
    proteinHitDays: hits((h) => proteinHit(h.protein, proteinGoal)),
    avgSteps: a('steps'),
    weight: body.today && typeof body.today.weight === 'number' ? r1(body.today.weight) : null,
  };
}

function checkinWeek(checkin, b) {
  const entries = b.days.map((d) => checkin.days[d]).filter(Boolean);
  const sleeps = entries.map((e) => e.sleep).filter((v) => typeof v === 'number');
  const energies = entries.map((e) => e.energy).filter((v) => typeof v === 'number');
  return { answered: entries.length, avgSleep: sleeps.length ? r1(avg(sleeps)) : null, avgEnergy: energies.length ? r1(avg(energies)) : null };
}

/** Streaks as of the week's last day (or today, inside the current week). */
function habitsWeek(habits, b, today, body) {
  const asOf = today < b.sunday ? today : b.sunday;
  const auto = autoDays(body);
  return habits.slice(0, MAX_HABITS).map((h) => {
    const st = habitStatus(h, asOf, auto);
    // A built-in suggestion has no name of its own (the renderer localizes it); its id reads fine.
    return { name: clean(h.name || h.id, MAX_NAME), every: h.every, perWeek: h.perWeek, weekCount: st.weekCount, streak: st.streak };
  });
}

/** A source's failure as a fixed code, never raw error text. */
function errorCode(err) {
  const r = err && typeof err.reason === 'string' ? err.reason : '';
  return /^[a-z0-9-]{1,40}$/.test(r) ? r : 'failed';
}

/**
 * @param {{ledgerRange:(req:{sinceMs:number,untilMs:number})=>Promise<object>,
 *   listRepos:()=>string[], runGit?:Function, readTodoStore:()=>object,
 *   projectNames:()=>Map<string,string>, github:{fetch:Function}|null,
 *   loadGoals:()=>object, loadBudget:()=>object, body:()=>Promise<object|null>,
 *   loadCheckin:()=>object, loadHabits:()=>object, loadSeries:()=>object, now?:()=>number}} deps
 *   Every source is injected: tests run on fakes, the app passes the real stores.
 */
function createWeeklyCollect(deps) {
  const now = deps.now || Date.now;

  /** Runs one source; a throw or a {ok:false} answer becomes {error}. */
  async function source(name, fn) {
    try {
      const v = await fn();
      if (v && v.ok === false) return { error: errorCode(v) };
      return v;
    } catch (err) {
      console.error(`[weekly] ${name} failed:`, errorCode(err), err && err.message);
      return { error: errorCode(err) };
    }
  }

  /**
   * @param {string} week ISO week key, e.g. '2026-W43'
   * @returns {Promise<object|null>} null for a malformed week
   */
  async function collect(week) {
    const b = weekBounds(week);
    if (!b) return null;
    const today = ymd(now());
    const untilMs = Math.min(b.untilMs, Math.max(b.sinceMs + 1, now()));
    const body = await deps.body().catch(() => null);
    const [ledger, repos, github] = await Promise.all([
      source('ledger', async () => {
        const r = await deps.ledgerRange({ sinceMs: b.sinceMs, untilMs: b.untilMs });
        return r && r.ok ? ledgerParts(r) : r;
      }),
      source('repos', () => repoStats({ listRepos: deps.listRepos, runGit: deps.runGit, sinceMs: b.sinceMs, untilMs })),
      source('github', async () => (deps.github ? githubWeek(await deps.github.fetch(), b) : { error: 'off' })),
    ]);
    const split = (k) => (ledger && ledger.error ? ledger : ledger[k]);
    return {
      week,
      from: b.monday,
      to: b.sunday,
      partial: today <= b.sunday,
      claude: split('claude'),
      hours: split('hours'),
      repos,
      todos: await source('todos', () => openTodos(deps.readTodoStore(), deps.projectNames())),
      github,
      goals: await source('goals', () => (deps.loadGoals().weeks[week] || []).map((g) => ({ text: g.text, status: g.status }))),
      budget: await source('budget', () => budgetWeek(deps.loadBudget(), b)),
      body: body ? bodyWeek(body, b) : { error: 'no-data' },
      checkin: await source('checkin', () => checkinWeek(deps.loadCheckin(), b)),
      habits: await source('habits', () => habitsWeek(deps.loadHabits().habits, b, today, body)),
      correlations: await source('correlations', () => topCorrelations(deps.loadSeries().days).map((c) => ({ ...c, text: phrase(c) }))),
    };
  }

  return { collect };
}

/** Names the model may mention as a project: every project / repo the data names. */
function knownProjects(data) {
  const names = new Set();
  const add = (list, k) => {
    if (Array.isArray(list)) for (const x of list) if (x && typeof x[k] === 'string') names.add(x[k]);
  };
  if (data) {
    add(data.claude && data.claude.projects, 'name');
    add(data.hours && data.hours.projects, 'name');
    add(data.repos && data.repos.repos, 'repo');
    add(data.todos && data.todos.projects, 'project');
  }
  return names;
}

module.exports = {
  createWeeklyCollect,
  weekBounds,
  repoStats,
  parseNumstat,
  logArgs,
  minimalEnv,
  runGitDefault,
  ledgerParts,
  openTodos,
  githubWeek,
  budgetWeek,
  bodyWeek,
  checkinWeek,
  habitsWeek,
  knownProjects,
};
