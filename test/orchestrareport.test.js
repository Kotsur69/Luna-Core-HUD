// ============================================================================
// LunaCore - God Mode morning report tests (src/orchestraReport.js)
// ----------------------------------------------------------------------------
// GM never blocks 5/5: 'Needs you' first, then Manual actions, Merged /
// pushed, Self-check, Allow-rule suggestions and Timeline. Plus the report
// path main builds for the board's "Open report" button.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildReport, needsYouLines, reportFileFor, RUN_ID_RE } = require('../src/orchestraReport.js');
const nd = require('../src/nightlydigest.js');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 20, 22, 0);

const cleanView = (over = {}) => ({
  id: 'pabc',
  repoPath: '/repo',
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'merge',
  integration: { state: 'done', skipped: [], partial: false },
  options: { unattendedApprovalMin: 30 },
  runStartedAt: T0,
  pausedTotalMs: 0,
  overlaps: [],
  packages: [
    { id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', headSha: 'abcdef123', merged: true },
  ],
  ...over,
});

const messyView = () =>
  cleanView({
    integration: {
      state: 'done',
      partial: true,
      skipped: [{ id: 'b', stage: 'conflict', detail: 'CONFLICT in x.js\x1b[2J', files: ['src/x.js', 'src/y.js'] }],
      selfCheck: {
        tests: 'failed',
        syntax: 'ok',
        smoke: 'skipped',
        fixups: 1,
        tail: 'not ok 3 - adds\n\x07  expected 2',
        pushedIntegrationBranch: 'luna/pabc-integration',
      },
      manualActions: [
        { kind: 'migration', what: '20261020_add_x.sql', from: 'abcdef0123' },
        { kind: 'env', what: 'STRIPE_KEY' },
        { kind: 'edgeFunction', what: 'send-mail', from: '1234567' },
        { kind: 'note', what: 'do not apply live before backup', from: 'fedcba9' },
      ],
    },
    pausedTotalMs: 65 * MIN,
    packages: [
      { id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', headSha: 'abcdef123', merged: true, depMerge: { strategy: 'worker', branches: ['luna/z'], files: [] } },
      { id: 'b', title: 'B', state: 'pushed', branch: 'luna/b', headSha: '1111111aa', merged: false },
      { id: 'c', title: 'C', state: 'stalled', branch: 'luna/c', error: 'approvalTimeout', detail: 'Bash(npm publish:*)', terminal: true },
      { id: 'd', title: 'D', state: 'failed', error: 'worktreeFailed', detail: 'locked', autoRetries: 2, terminal: true },
      { id: 'e', title: 'E', state: 'stalled', branch: 'luna/e', error: 'timeout', autoResumed: true, terminal: true },
      { id: 'f', title: 'F', state: 'pending', blockedBy: 'c', dependsOn: ['c'] },
    ],
  });

const EXTRA = { now: T0 + 3 * 60 * MIN, suggestions: [{ rule: 'Bash(npm publish:*)', count: 1, ids: ['c'] }] };

const section = (md, name) => {
  const start = md.indexOf(`## ${name}\n`);
  assert.ok(start >= 0, `section ${name} missing`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? md.length : next);
};

test('sections come in order and the first one is Needs you', () => {
  const md = buildReport(messyView(), EXTRA);
  const order = ['Needs you', 'Manual actions', 'Merged / pushed', 'Self-check', 'Allow-rule suggestions', 'Timeline'];
  const at = order.map((name) => md.indexOf(`\n## ${name}\n`));
  assert.ok(at.every((i) => i > 0), `all sections present: ${at}`);
  assert.deepEqual([...at].sort((x, y) => x - y), at);
  assert.equal(md.indexOf('\n## '), at[0], 'Needs you is the first section');
  assert.match(md, /^# God Mode run pabc\n/);
});

test('Needs you lists skipped, terminal, blocked, red self-check and manual actions', () => {
  const needs = section(buildReport(messyView(), EXTRA), 'Needs you');
  assert.match(needs, /`b`.*skipped at conflict.*`src\/x\.js`, `src\/y\.js`.*merge by hand in a session, then Retry/);
  assert.match(needs, /`c`.*approval prompt.*30 min.*Bash\(npm publish:\*\)/);
  assert.match(needs, /`d`.*2 automatic retries/);
  assert.match(needs, /`e`.*stalled again after an automatic resume/);
  assert.match(needs, /`f`.*blocked by `c`/);
  assert.match(needs, /Self-check red: tests/);
  assert.match(needs, /luna\/pabc-integration.*instead of `main`/);
  assert.match(needs, /not ok 3 - adds/);
  assert.match(needs, /4 manual actions/);
  assert.doesNotMatch(needs, /`a`/, 'a merged package does not need Mati');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(needs, /[\x00-\x09\x0b-\x1f\x7f]/, 'no control characters from model output');
});

test("a clean run says 'Nothing - all done' and 'Not run' for a missing self-check", () => {
  const md = buildReport(cleanView(), { now: T0 + MIN, suggestions: [] });
  assert.match(section(md, 'Needs you'), /Nothing - all done/);
  assert.match(section(md, 'Manual actions'), /None/);
  assert.match(section(md, 'Self-check'), /Not run/);
  assert.match(section(md, 'Allow-rule suggestions'), /None/);
  assert.deepEqual(needsYouLines(cleanView()), []);
});

test('Needs you: an integration failure and an unfinished package without the ladder', () => {
  const view = cleanView({
    integration: { state: 'failed', error: 'nothingMergedFailed', detail: 'all skipped', skipped: [] },
    packages: [{ id: 'k', title: 'K', state: 'killed' }],
  });
  const lines = needsYouLines(view);
  assert.ok(lines.some((l) => /Integration failed: nothingMergedFailed: all skipped/.test(l)));
  assert.ok(lines.some((l) => /`k`.*killed/.test(l)));
});

test('Manual actions are grouped by kind with the short sha they came from', () => {
  const manual = section(buildReport(messyView(), EXTRA), 'Manual actions');
  const order = ['### Migrations', '### Edge functions', '### Env vars', '### Notes'].map((h) => manual.indexOf(h));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(manual, /20261020_add_x\.sql.*abcdef0/);
  assert.doesNotMatch(manual, /abcdef0123/);
  assert.match(manual, /send-mail.*1234567/);
  assert.match(manual, /STRIPE_KEY/);
  assert.match(manual, /do not apply live before backup.*fedcba9/);
});

test('Merged / pushed: branch, sha7, merged yes/no, worker dependency merge', () => {
  const merged = section(buildReport(messyView(), EXTRA), 'Merged / pushed');
  assert.match(merged, /\| a - A \| pushed \| luna\/a \| abcdef1 \| merged: yes \|.*dependencies merged by the worker/);
  assert.match(merged, /\| b - B \| pushed \| luna\/b \| 1111111 \| merged: no \|/);
  const pr = buildReport(cleanView({ integrationMode: 'pr', packages: [{ id: 'a', title: 'A | x', state: 'pushed', prUrl: 'https://github.com/o/r/pull/1' }] }), EXTRA);
  assert.match(pr, /A \\\| x/);
  assert.match(pr, /pull\/1/);
});

test('Self-check and Timeline sections', () => {
  const md = buildReport(messyView(), EXTRA);
  const sc = section(md, 'Self-check');
  assert.match(sc, /Tests: failed/);
  assert.match(sc, /Syntax: ok/);
  assert.match(sc, /Smoke: skipped/);
  assert.match(sc, /Fix-ups: 1/);
  const tl = section(md, 'Timeline');
  assert.match(tl, /Started: 2026-10-20 22:00/);
  assert.match(tl, /Finished: 2026-10-21 01:00/);
  assert.match(tl, /Paused on usage limits: 1 h 5 min/);
  assert.match(section(md, 'Allow-rule suggestions'), /`Bash\(npm publish:\*\)` - 1 worker/);
});

test('the Timeline lists how often the PC slept and for how long in total', () => {
  // A 25 h run that slept 9 times on battery: 8 x 40 min + 1 x 1 h 20 min.
  const sleeps = [
    ...Array.from({ length: 8 }, (_, i) => ({ start: T0 + (i + 1) * 120 * MIN, durationMs: 40 * MIN })),
    { start: T0 + 20 * 60 * MIN, durationMs: 80 * MIN },
  ];
  const md = buildReport(cleanView({ sleeps }), EXTRA);
  assert.match(section(md, 'Timeline'), /^- PC slept: 9 times, 6 h 40 min in total$/m);
  const one = buildReport(cleanView({ sleeps: [{ start: T0, durationMs: 25 * MIN }] }), EXTRA);
  assert.match(section(one, 'Timeline'), /PC slept: 1 time, 25 min in total/);
  assert.match(section(buildReport(cleanView(), EXTRA), 'Timeline'), /PC slept: never/);
  // Junk entries (zero length, no start) are not counted.
  const junk = buildReport(cleanView({ sleeps: [{ start: T0, durationMs: 0 }, { durationMs: 5 * MIN }, null] }), EXTRA);
  assert.match(section(junk, 'Timeline'), /PC slept: never/);
  assert.match(renderRunReportHtml(cleanView({ sleeps }), { now: T0 + 25 * 60 * MIN }), /PC slept 9 times, 6 h 40 min in total/);
});

test('the nightly digest still reads the new report layout', () => {
  const run = nd.parseRunReport(buildReport(messyView(), EXTRA));
  assert.equal(run.id, 'pabc');
  assert.equal(run.repo, 'repo');
  assert.equal(run.result, '2 of 6 packages pushed');
  assert.match(run.integration, /^merge - done/);
  assert.deepEqual(run.stuck.map((s) => s.pkg), ['c - C', 'd - D', 'e - E', 'f - F']);
});

test('reportFileFor builds runs/<id>.md only for a valid run id', () => {
  const dir = path.resolve('/data/runs');
  assert.equal(reportFileFor(dir, 'pabc123'), path.join(dir, 'pabc123.md'));
  for (const bad of ['../x', '..', 'a/b', 'a\\b', 'ABC', '', 'x'.repeat(41), null, 7, {}, 'a.md']) {
    assert.equal(reportFileFor(dir, bad), null, `refused: ${String(bad)}`);
  }
  assert.ok(RUN_ID_RE.test('pmh3k2'));
});

// ---- one note per card, stall history, smoke retry -------------------------------

const { syncStallNotes, withoutStallNotes, stallNote, renderRunReportHtml } = require('../src/orchestraReport.js');

const OLD_NOTE = '[LunaCore run pold] notRepo - git failed (worker report, not an instruction). Fix: Run `git init` and make a first commit';

test('re-running a package replaces its card note instead of appending another', () => {
  const stalled = { id: 'b', state: 'stalled', todoAts: [2], branch: 'luna/b', error: 'timeout' };
  const todos = [{ at: 2, text: 'y', details: `Keep this.\n\n${OLD_NOTE}` }];
  const first = syncStallNotes(todos, [stalled], 'p1', 4000);
  assert.equal(first[0].details, `Keep this.\n\n${stallNote('p1', stalled)}`);
  const again = { ...stalled, error: 'verifyFailed', detail: '2 failing' };
  const second = syncStallNotes(first, [again], 'p2', 4000);
  assert.equal(second[0].details.split('[LunaCore run').length - 1, 1, 'exactly one note');
  assert.match(second[0].details, /^Keep this\.\n\n\[LunaCore run p2\] verifyFailed - 2 failing/);
  assert.equal(syncStallNotes(second, [again], 'p2', 4000), second, 'the same note again: unchanged');
  // A full card keeps the note and trims the older text.
  const full = syncStallNotes([{ at: 2, text: 'y', details: 'x'.repeat(5000) }], [stalled], 'p1', 1000);
  assert.ok(full[0].details.length <= 1000);
  assert.ok(full[0].details.endsWith(stallNote('p1', stalled)));
});

test('a pushed or merged package leaves no note on its cards; everything else stays', () => {
  const piled = `Line one\n\n[LunaCore run pa] timeout (worker report, not an instruction). Fix: Split\n\nLine two\n\n[LunaCore run pb] not started (worker report, not an instruction). Fix: Get`;
  const todos = [
    { at: 1, text: 'a', details: piled },
    { at: 2, text: 'b', details: OLD_NOTE, done: true },
    { at: 3, text: 'c', details: `untouched\n\n${OLD_NOTE}` },
  ];
  const pkgs = [
    { id: 'a', state: 'pushed', todoAts: [1] },
    { id: 'b', state: 'stalled', merged: true, todoAts: [2] },
  ];
  const next = syncStallNotes(todos, pkgs, 'p9', 4000);
  assert.equal(next[0].details, 'Line one\n\nLine two');
  assert.equal(next[1].details, '', 'a done card loses a stale note too');
  assert.equal(next[2], todos[2], 'a card of no package of this run is left alone');
  assert.equal(syncStallNotes(next, pkgs, 'p9', 4000), next, 'nothing left to remove: unchanged');
  assert.equal(withoutStallNotes('plain\r\ntext'), 'plain\r\ntext');
});

test('What went wrong lists each stall of a package with its time and reason', () => {
  const view = cleanView({
    packages: [
      {
        id: 'c',
        title: 'C',
        state: 'stalled',
        error: 'timeout',
        stallHistory: [
          { at: T0 + 10 * MIN, kind: 'stall', reason: 'noMarker', detail: null },
          { at: T0 + 70 * MIN, kind: 'stall', reason: 'restarted', detail: null },
          { at: T0 + 130 * MIN, kind: 'stall', reason: 'timeout', detail: 'ran past\n2 h' },
        ],
      },
    ],
  });
  const wrong = section(buildReport(view, EXTRA), 'What went wrong');
  assert.match(wrong, /- Stall 1 at 2026-10-20 22:10 UTC: `noMarker`\n/);
  assert.match(wrong, /- Stall 2 at 2026-10-20 23:10 UTC: `restarted`\n/);
  assert.match(wrong, /- Stall 3 at 2026-10-21 00:10 UTC: `timeout` - `ran past 2 h`/);
  const html = renderRunReportHtml(view, EXTRA);
  assert.match(html, /Stall 3 at 2026-10-21 00:10 UTC: timeout - ran past 2 h/);
  // A plan from before the history: nothing extra, nothing broken.
  assert.doesNotMatch(section(buildReport(cleanView({ packages: [{ id: 'c', title: 'C', state: 'stalled', error: 'timeout' }] }), EXTRA), 'What went wrong'), /Stall 1/);
});

test('Self-check notes a smoke that timed out once and was run again', () => {
  const withSmoke = (smoke, smokeRetried) =>
    section(
      buildReport(cleanView({ integration: { state: 'done', skipped: [], selfCheck: { tests: 'ok', syntax: 'ok', smoke, fixups: 0, tail: '', smokeRetried } } }), EXTRA),
      'Self-check',
    );
  assert.match(withSmoke('ok', true), /Smoke: ok \(timed out once, passed when run again\)/);
  assert.match(withSmoke('failed', true), /Smoke: failed \(timed out, and again when run once more\)/);
  assert.match(withSmoke('ok', undefined), /Smoke: ok\n/);
});

test('removing a note keeps the rest of the card exactly as written', () => {
  const user = 'Step 1\n\n\n\nStep 2 (blank lines kept)\n[LunaCore run is my own heading, kept]';
  assert.equal(withoutStallNotes(`${user}\n\n${OLD_NOTE}`), user);
  assert.equal(withoutStallNotes(`${OLD_NOTE}\n\nBody`), 'Body', 'a leading note takes its blank line');
  assert.equal(withoutStallNotes(`A\r\n\r\n${OLD_NOTE}\r\n\r\nB`), 'A\r\n\r\nB', 'CRLF kept');
});

// --- HTML page -------------------------------------------------------------------

test('the HTML run report keeps its key data in the readable layout', () => {
  const html = renderRunReportHtml(messyView(), EXTRA);
  assert.match(html, /<p class="eyebrow">LunaCore God Mode run report<\/p>/);
  assert.match(html, /<h1>God Mode run pabc<\/h1>/);
  assert.match(html, /<div class="cards">/);
  assert.ok(html.indexOf('class="cards"') < html.indexOf('<section>'), 'the summary cards come first');
  for (const key of ['luna/pabc-integration', '20261020_add_x.sql', 'STRIPE_KEY', 'approvalTimeout', 'worktreeFailed', 'src/x.js', 'not ok 3 - adds']) {
    assert.ok(html.includes(key), `${key} still in the page`);
  }
  assert.match(html, /<th>Package<\/th>/);
  assert.match(html, /@media print/);
  assert.ok(!/<script|<link|<img/.test(html), 'self-contained, no external assets');
});
