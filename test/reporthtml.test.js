// ============================================================================
// LunaCore - standalone HTML reports (src/reportHtml.js and the renderers in
// src/orchestraReport.js / src/weeklyreview.js)
// ----------------------------------------------------------------------------
// One escaper for every interpolated value (titles, error text, file names
// come from git and models), charts for empty / single / many inputs, and
// byte-identical output for the same input.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../src/reportHtml.js');
const { renderRunReportHtml, repoPathOf, buildReport } = require('../src/orchestraReport.js');
const { renderWeeklyReportHtml } = require('../src/weeklyreview.js');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 20, 22, 0);
const EVIL = '<img src=x onerror=alert(1)>"\'&</td><script>x</script>';

/** No markup from data survived: the payload's tags never appear raw. */
function assertInert(html) {
  assert.ok(!html.includes('<img'), 'raw <img from data');
  assert.ok(!html.includes('<script'), 'raw <script from data');
  assert.ok(!html.includes('</td><script'), 'raw closing tag from data');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'payload shown escaped');
}

const pkg = (id, over = {}) => ({
  id,
  title: `Title ${id}`,
  state: 'pushed',
  branch: `luna/${id}`,
  headSha: 'abcdef1234567',
  startedAt: T0 + 5 * MIN,
  finishedAt: T0 + 35 * MIN,
  ...over,
});

const view = (packages, over = {}) => ({
  id: 'pabc',
  repoPath: '/home/me/repo-name',
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'pr',
  integration: { state: 'done', skipped: [], selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped', fixups: 0 } },
  runStartedAt: T0,
  pausedTotalMs: 0,
  packages,
  ...over,
});

// --- escapeHtml ---------------------------------------------------------------

test('escapeHtml escapes the five HTML specials and stringifies anything', () => {
  assert.equal(h.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(h.escapeHtml(null), '');
  assert.equal(h.escapeHtml(undefined), '');
  assert.equal(h.escapeHtml(42), '42');
  assert.equal(h.escapeHtml('&amp;'), '&amp;amp;');
});

test('page escapes title and subtitle and is a standalone document with no script or remote link', () => {
  const html = h.page({ title: EVIL, subtitle: EVIL, body: '', footer: EVIL });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<style>[\s\S]*prefers-color-scheme:dark/);
  assert.ok(!/<script|<link|https?:\/\//.test(html));
  assertInert(html);
});

// --- charts -----------------------------------------------------------------

test('charts with no data say so instead of drawing an empty svg', () => {
  for (const out of [h.barChart([]), h.donutChart([]), h.ganttChart([]), h.columnChart([]), h.barChart(null)]) {
    assert.match(out, /class="empty"/);
    assert.ok(!out.includes('<svg'));
  }
  assert.match(h.columnChart([{ label: 'Mon', value: 0 }]), /class="empty"/);
  assert.match(h.donutChart([{ label: 'a', value: 0 }], { emptyText: 'Nothing' }), /Nothing/);
});

test('a single value draws one full-width bar, one full ring, one column and one timeline bar', () => {
  const bar = h.barChart([{ label: 'only', value: 5, tone: 'ok' }]);
  assert.equal((bar.match(/<rect class="ok"/g) || []).length, 1);
  assert.match(bar, /<rect class="ok" x="190" y="4" width="640"/); // the whole bar track
  const donut = h.donutChart([{ label: 'pushed', value: 3, tone: 'ok' }]);
  assert.equal((donut.match(/<circle class="ok"/g) || []).length, 1);
  const col = h.columnChart([{ label: 'Mon', value: 2, tone: 'ok' }]);
  assert.equal((col.match(/<rect class="ok"/g) || []).length, 1);
  const gantt = h.ganttChart([{ label: 'a', start: 0, end: 10, tone: 'ok' }]);
  assert.equal((gantt.match(/<rect class="ok"/g) || []).length, 1);
});

test('many values draw one mark each, capped at 50 rows', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ label: `p${i}`, value: i + 1, tone: 'info', start: i, end: i + 5 }));
  assert.equal((h.barChart(rows).match(/<rect class="info"/g) || []).length, 50);
  assert.equal((h.ganttChart(rows).match(/<rect class="info"/g) || []).length, 50);
  assert.equal((h.donutChart(rows).match(/<circle class="info"/g) || []).length, 50);
  assert.equal((h.columnChart(rows.slice(0, 7)).match(/<rect class="info"/g) || []).length, 7);
});

test('chart labels are escaped and tones from data are whitelisted', () => {
  const out = h.barChart([{ label: EVIL, value: 1, tone: '" onload="x', text: EVIL }]) + h.donutChart([{ label: EVIL, value: 1, tone: 'ok' }]);
  assert.ok(!out.includes('onload="x'));
  assert.match(out, /class="muted"/);
  assert.ok(!out.includes('<img') && !out.includes('<script'));
});

// --- run report -------------------------------------------------------------

test('run report HTML escapes every value that comes from git or a model', () => {
  const v = view(
    [
      pkg(EVIL, { title: EVIL, branch: EVIL, state: 'failed', error: EVIL, detail: EVIL, prUrl: `javascript:${EVIL}` }),
      pkg('b', { state: 'stalled', error: 'verifyFailed', detail: EVIL }),
    ],
    {
      baseBranch: EVIL,
      workerModel: EVIL,
      integration: {
        state: 'failed',
        error: EVIL,
        detail: EVIL,
        skipped: [{ id: 'b', stage: EVIL, detail: EVIL, files: [EVIL] }],
        manualActions: [{ kind: 'migration', what: EVIL }],
        selfCheck: { tests: 'failed', syntax: EVIL, smoke: 'ok', tail: `${EVIL}\nline 2` },
      },
    },
  );
  const html = renderRunReportHtml(v, { now: T0 + 60 * MIN, suggestions: [{ rule: EVIL, count: 2, ids: [EVIL] }], repoPath: `/x/${EVIL}` });
  assertInert(html);
  assert.ok(!html.includes('href="javascript'), 'only https links become hrefs');
});

test('run report HTML has cards, charts and the package table', () => {
  const html = renderRunReportHtml(
    view([
      pkg('a'),
      pkg('b', { state: 'failed', finishedAt: T0 + 20 * MIN }),
      pkg('c', { state: 'killed' }),
      pkg('d', { state: 'pending', startedAt: null, finishedAt: null, headSha: null }),
    ]),
    { now: T0 + 60 * MIN },
  );
  assert.match(html, /<title>God Mode run pabc<\/title>/);
  assert.match(html, /repo-name/);
  assert.ok(!html.includes('/home/me'), 'only the repo name shows');
  assert.match(html, /<div class="v">1 \/ 4<\/div><div class="k">Pushed/);
  assert.match(html, /<div class="v">1<\/div><div class="k">Failed/);
  assert.match(html, /<div class="v">1<\/div><div class="k">Killed/);
  assert.match(html, /<div class="v">1 h 0 min<\/div><div class="k">Duration/);
  assert.match(html, /<div class="v">3<\/div><div class="k">Commits/);
  assert.match(html, /<div class="v">ok<\/div><div class="k">Tests/);
  assert.match(html, /aria-label="donut chart"/);
  assert.match(html, /aria-label="bar chart"/);
  assert.match(html, /aria-label="timeline"/);
  assert.match(html, /<th>Package<\/th>/);
  assert.match(html, /30 min/); // a's time per package
});

test('run report HTML: empty run and single package render without throwing', () => {
  const none = renderRunReportHtml(view([]), { now: T0 });
  assert.match(none, /No packages/);
  assert.match(none, /Nothing - all done/);
  const one = renderRunReportHtml(view([pkg('a')]), { now: T0 + 40 * MIN });
  assert.match(one, /<div class="v">1 \/ 1<\/div>/);
  assert.ok(renderRunReportHtml(null, {}).startsWith('<!doctype html>'));
});

test('run report HTML is deterministic for the same input', () => {
  const v = view([pkg('a'), pkg('b', { state: 'stalled' })]);
  const extra = { now: T0 + 50 * MIN, suggestions: [] };
  assert.equal(renderRunReportHtml(v, extra), renderRunReportHtml(v, extra));
});

test('repoPathOf reads the Repo line of the markdown report; the markdown is unchanged by the HTML path', () => {
  const v = view([pkg('a')]);
  const md = buildReport(v, { now: T0 + 40 * MIN, suggestions: [] });
  assert.equal(repoPathOf(md), '/home/me/repo-name');
  assert.equal(repoPathOf('no repo line'), '');
  renderRunReportHtml(v, { now: T0 + 40 * MIN });
  assert.equal(buildReport(v, { now: T0 + 40 * MIN, suggestions: [] }), md);
});

// --- weekly report ------------------------------------------------------------

const weekEntry = (over = {}) => ({
  week: '2026-W43',
  at: Date.UTC(2026, 9, 25, 19, 0),
  model: 'haiku',
  costUsd: 0.012,
  failure: null,
  review: {
    headline: 'A solid week',
    fun: { summary: 'Some fun', projects: ['Game'] },
    work: [{ project: 'LunaCore', status: 'Shipped reports', openTodos: ['Polish'] }],
    claudeTable: [],
    goals: [{ goal: 'Ship it', verdict: 'done', evidence: ['12 commits'] }],
    suggestions: ['Rest'],
    doMore: ['Tests'],
    doLess: ['Meetings'],
  },
  data: {
    week: '2026-W43',
    from: '2026-10-19',
    to: '2026-10-25',
    partial: false,
    hours: { totalH: 20, byClass: { work: 15, fun: 3, other: 2, unassigned: 0 }, projects: [{ name: 'LunaCore', hours: 15, cls: 'work' }] },
    claude: { totalUsd: 12.5, byClass: {}, projects: [{ name: 'LunaCore', usd: 12.5, pct: 100, cls: 'work' }] },
    repos: { repos: [{ repo: 'Luna-Core-HUD', commits: 12, feat: [], fix: 2, added: 100, removed: 10 }], failed: 0, perDay: [1, 2, 0, 4, 5, 0, 0] },
    github: { contributions: 14, perDay: [2, 2, 1, 4, 5, 0, 0] },
    todos: { totalOpen: 7, projects: [] },
  },
  ...over,
});

test('weekly HTML has cards and per-day activity columns labelled with the dates', () => {
  const html = renderWeeklyReportHtml(weekEntry());
  assert.match(html, /<title>Weekly review - 2026-W43<\/title>/);
  assert.match(html, /<div class="v">12<\/div><div class="k">Commits/);
  assert.match(html, /<div class="v">\$12\.50<\/div><div class="k">Claude/);
  assert.match(html, /<div class="v">1 \/ 1<\/div><div class="k">Goals done/);
  assert.match(html, /Mon 19/);
  assert.match(html, /Sun 25/);
  assert.equal((html.match(/aria-label="column chart"/g) || []).length, 2);
});

test('weekly HTML: no review and no per-day data (an older entry) still renders', () => {
  const data = { ...weekEntry().data, repos: { repos: [], failed: 0 }, github: { error: 'off' }, hours: { error: 'x' } };
  const html = renderWeeklyReportHtml(weekEntry({ review: null, data }));
  assert.match(html, /No per-day commit data/);
  assert.match(html, /No per-day contribution data/);
  assert.match(html, /model answer was not usable/);
  assert.ok(renderWeeklyReportHtml(null).startsWith('<!doctype html>'));
});

test('weekly HTML escapes project names, repo names, to-dos and model text', () => {
  const e = weekEntry();
  const review = {
    ...e.review,
    headline: EVIL,
    fun: { summary: EVIL, projects: [EVIL] },
    work: [{ project: EVIL, status: EVIL, openTodos: [EVIL] }],
    goals: [{ goal: EVIL, verdict: 'partly', evidence: [EVIL] }],
    suggestions: [EVIL],
    doMore: [EVIL],
    doLess: [EVIL],
  };
  const data = {
    ...e.data,
    from: EVIL,
    hours: { ...e.data.hours, projects: [{ name: EVIL, hours: 1, cls: EVIL }] },
    claude: { ...e.data.claude, projects: [{ name: EVIL, usd: 1, cls: 'work' }] },
    repos: { ...e.data.repos, repos: [{ repo: EVIL, commits: 1 }] },
  };
  assertInert(renderWeeklyReportHtml({ ...e, model: EVIL, review, data }));
});

test('weekly HTML is deterministic for the same entry', () => {
  assert.equal(renderWeeklyReportHtml(weekEntry()), renderWeeklyReportHtml(weekEntry()));
});
