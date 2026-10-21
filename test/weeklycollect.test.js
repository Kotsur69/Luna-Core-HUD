// ============================================================================
// LunaCore - weekly review collector (src/weeklycollect.js)
// ----------------------------------------------------------------------------
// Every source is a fake: git, the ledger, GitHub, the stores. Pins the
// output rules: no paths, own commits only, capped lists, a failing source
// becomes {error}.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createWeeklyCollect, weekBounds, parseNumstat, repoStats, minimalEnv, githubWeek, openTodos } = require('../src/weeklycollect.js');

const H = 60 * 60 * 1000;
const WEEK = '2026-W43'; // Mon 2026-10-19 .. Sun 2026-10-25
const B = weekBounds(WEEK);
const MID = new Date(2026, 9, 21, 12).getTime();
const REPO = path.resolve('/work/secret-client/repo-a');

const log = (rows) =>
  rows
    .map(([sec, email, subject, stats = []]) => `\x1e${sec}\t${email}\t${subject}\n\n${stats.map(([a, d, f]) => `${a}\t${d}\t${f}`).join('\n')}`)
    .join('\n');

test('weekBounds: local Mon-Sun and [sinceMs, untilMs)', () => {
  assert.equal(B.monday, '2026-10-19');
  assert.equal(B.sunday, '2026-10-25');
  assert.equal(B.sinceMs, new Date(2026, 9, 19).getTime());
  assert.equal(B.untilMs, new Date(2026, 9, 26).getTime());
  assert.equal(weekBounds('2026-W99'), null);
});

test('parseNumstat keeps own commits in the window with kinds and line counts', () => {
  const s = MID / 1000;
  const out = parseNumstat(
    log([
      [s, 'Me@X.com', 'feat(life): week tab', [['10', '2', 'a.js'], ['-', '-', 'img.png']]],
      [s, 'other@x.com', 'feat: not mine'],
      [s, 'me@x.com', 'fix: bug', [['1', '1', 'b.js']]],
      [B.untilMs / 1000, 'me@x.com', 'feat: next week'],
    ]),
    'me@x.com',
    B.sinceMs,
    B.untilMs
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.kind), ['feat', 'fix']);
  assert.equal(out[0].added, 10);
  assert.equal(out[0].removed, 2);
});

test('repoStats: safe argv, repo NAME only, skips repos without user.email', async () => {
  const calls = [];
  const runGit = async (dir, args) => {
    calls.push({ dir, args });
    if (args.includes('config')) return { ok: true, stdout: dir === REPO ? 'me@x.com\n' : '' };
    return { ok: true, stdout: log([[MID / 1000, 'me@x.com', 'feat: one', [['5', '1', 'x']]]]) };
  };
  const res = await repoStats({ listRepos: () => [REPO, path.resolve('/work/other'), '\\\\server\\share', 'relative'], runGit, sinceMs: B.sinceMs, untilMs: B.untilMs });
  assert.deepEqual(res.repos, [{ repo: 'repo-a', commits: 1, feat: ['feat: one'], fix: 0, added: 5, removed: 1 }]);
  assert.equal(JSON.stringify(res).includes('secret-client'), false);
  const logCall = calls.find((c) => c.args.includes('log'));
  assert.deepEqual(logCall.args.slice(0, 2), ['-c', 'core.fsmonitor=false']);
  assert.equal(logCall.args[logCall.args.length - 1], '--');
  // UNC and relative paths never reach git.
  assert.ok(calls.every((c) => c.dir !== 'relative' && !c.dir.startsWith('\\\\')));
});

test('a failing git is counted, not thrown', async () => {
  const runGit = async (_d, args) => (args.includes('config') ? { ok: true, stdout: 'me@x.com' } : { ok: false, stdout: '' });
  const res = await repoStats({ listRepos: () => [REPO], runGit, sinceMs: B.sinceMs, untilMs: B.untilMs });
  assert.deepEqual(res, { repos: [], failed: 1 });
});

test('minimalEnv keeps PATH and drops tokens and GIT_* overrides', () => {
  const env = minimalEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', GIT_DIR: '/evil' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('githubWeek: low output vs the 4-week average and quiet days', () => {
  const days = [];
  for (let i = -28; i < 7; i++) {
    const d = new Date(2026, 9, 19 + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date, count: i < 0 ? 4 : i < 2 ? 1 : 0 });
  }
  const gh = githubWeek({ days, lists: { prs: { count: 2, items: [{ repo: 'a/b', title: 'PR', draft: false, url: 'https://x' }] } } }, B);
  assert.equal(gh.contributions, 2);
  assert.equal(gh.avgWeek, 28);
  assert.equal(gh.quietDays, 5);
  assert.deepEqual(gh.flags, ['lowOutput', 'quiet']);
  assert.equal(gh.openPrs, 2);
  assert.equal(JSON.stringify(gh).includes('https'), false);
});

test('openTodos: open only, capped items, project label instead of id', () => {
  const store = { p1: Array.from({ length: 8 }, (_, i) => ({ text: `t${i}`, done: i === 0, at: i })), p2: [{ text: 'x', done: true, at: 1 }] };
  const out = openTodos(store, new Map([['p1', 'LunaCore']]));
  assert.equal(out.totalOpen, 7);
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].project, 'LunaCore');
  assert.equal(out.projects[0].items.length, 5);
});

function deps(over = {}) {
  return {
    now: () => MID,
    ledgerRange: async () => ({
      ok: true,
      totalUsd: 10,
      projects: [{ key: 'k1', name: 'LunaCore', usd: 6, cls: 'fun' }, { key: 'k2', name: 'Client', usd: 4, cls: 'work' }],
      hours: [{ key: 'k1', name: 'LunaCore', ms: 5 * H, cls: 'fun' }, { key: 'k2', name: 'Client', ms: 10 * H, cls: 'work' }],
    }),
    listRepos: () => [],
    runGit: async () => ({ ok: true, stdout: '' }),
    readTodoStore: () => ({}),
    projectNames: () => new Map(),
    github: { fetch: async () => ({ days: [], lists: {} }) },
    loadGoals: () => ({ weeks: { [WEEK]: [{ text: 'Ship week tab', status: 'partly' }] } }),
    loadBudget: () => ({ categories: [{ id: 'food', name: '', kind: 'planned' }], expenses: [{ date: '2026-10-20', amount: 50, category: 'food' }, { date: '2026-10-13', amount: 20, category: 'food' }] }),
    body: async () => null,
    loadCheckin: () => ({ days: { '2026-10-19': { sleep: 7, energy: 4 }, '2026-10-20': { sleep: 8, energy: null } } }),
    loadHabits: () => ({ habits: [{ id: 'gym', name: '', every: 'week', perWeek: 3, auto: '', done: ['2026-10-19'] }] }),
    loadSeries: () => ({ days: {} }),
    ...over,
  };
}

test('collect: the whole week as plain JSON', async () => {
  const data = await createWeeklyCollect(deps()).collect(WEEK);
  assert.equal(data.week, WEEK);
  assert.equal(data.partial, true);
  assert.equal(data.claude.totalUsd, 10);
  assert.deepEqual(data.claude.byClass.fun, { usd: 6, pct: 60 });
  assert.equal(data.hours.totalH, 15);
  assert.equal(data.hours.byClass.work, 10);
  assert.deepEqual(data.goals, [{ text: 'Ship week tab', status: 'partly' }]);
  assert.deepEqual(data.budget, { total: 50, prevTotal: 20, categories: [{ name: 'food', amount: 50, prev: 20 }] });
  assert.deepEqual(data.checkin, { answered: 2, avgSleep: 7.5, avgEnergy: 4 });
  assert.equal(data.habits[0].name, 'gym');
  assert.equal(data.habits[0].weekCount, 1);
  assert.deepEqual(data.body, { error: 'no-data' });
  assert.deepEqual(data.correlations, []);
});

test('collect: a failing source becomes {error} and the rest still comes back', async () => {
  const data = await createWeeklyCollect(
    deps({
      ledgerRange: async () => ({ ok: false, reason: 'bad-range' }),
      github: { fetch: async () => { throw Object.assign(new Error('x'), { reason: 'gh-auth' }); } },
      loadBudget: () => { throw new Error('C:\\Users\\secret path'); },
    })
  ).collect(WEEK);
  assert.deepEqual(data.claude, { error: 'bad-range' });
  assert.deepEqual(data.hours, { error: 'bad-range' });
  assert.deepEqual(data.github, { error: 'gh-auth' });
  assert.deepEqual(data.budget, { error: 'failed' });
  assert.equal(data.goals.length, 1);
});

test('collect: a malformed week is null', async () => {
  assert.equal(await createWeeklyCollect(deps()).collect('nope'), null);
});

test('perDay: own commits per local day when the days are named, GitHub counts Mon..Sun', async () => {
  const runGit = async (dir, args) =>
    args.includes('config') ? { ok: true, stdout: 'me@x.com\n' } : { ok: true, stdout: log([[MID / 1000, 'me@x.com', 'feat: one'], [MID / 1000 + 60, 'me@x.com', 'fix: two']]) };
  const res = await repoStats({ listRepos: () => [REPO], runGit, sinceMs: B.sinceMs, untilMs: B.untilMs, days: B.days });
  assert.deepEqual(res.perDay, [0, 0, 2, 0, 0, 0, 0]);
  const plain = await repoStats({ listRepos: () => [REPO], runGit, sinceMs: B.sinceMs, untilMs: B.untilMs });
  assert.equal(plain.perDay, undefined);
  const gh = githubWeek({ days: [{ date: B.days[0], count: 3 }, { date: B.days[6], count: 1 }] }, B);
  assert.deepEqual(gh.perDay, [3, 0, 0, 0, 0, 0, 1]);
});
