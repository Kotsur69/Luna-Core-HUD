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
