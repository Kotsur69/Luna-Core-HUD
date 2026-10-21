// ============================================================================
// LunaCore - nightly summary tests (src/nightlydigest.js)
// ----------------------------------------------------------------------------
// git, the model, Gmail and the clock are fakes; run reports live in a temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nd = require('../src/nightlydigest.js');
const { createMailPrefs } = require('../src/mailprefs.js');
const { buildReport } = require('../src/orchestraReport.js');

const REPO = path.resolve(os.tmpdir(), 'repos', 'Luna-Core-HUD');

function reportText(id, pkgs) {
  return buildReport(
    {
      id,
      repoPath: REPO,
      baseBranch: 'main',
      workerModel: 'opus',
      permissionMode: 'bypassPermissions',
      integrationMode: 'pr',
      integration: { state: 'done' },
      packages: pkgs,
      overlaps: [],
    },
    { now: 1, suggestions: [] },
  );
}

test('parseRunReport keeps the repo name only and lists stuck packages with why', () => {
  const run = nd.parseRunReport(
    reportText('abc', [
      { id: 'p1', title: 'One', state: 'pushed' },
      { id: 'p2', title: 'Two', state: 'stalled', error: 'verifyFailed', detail: '2 tests failing' },
    ]),
  );
  assert.equal(run.id, 'abc');
  assert.equal(run.repo, 'Luna-Core-HUD');
  assert.equal(run.result, '1 of 2 packages pushed');
  assert.match(run.integration, /^pr - done/);
  assert.deepEqual(run.stuck, [{ pkg: 'p2 - Two', state: 'stalled', why: 'verifyFailed - 2 tests failing' }]);
  assert.equal(nd.parseRunReport('not a report'), null);
});

test('readRuns: today\'s reports plus the latest one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-runs-'));
  fs.writeFileSync(path.join(dir, 'old1.md'), reportText('old1', []));
  const old = new Date(2026, 9, 18, 12).getTime() / 1000;
  fs.utimesSync(path.join(dir, 'old1.md'), old, old);
  assert.equal(nd.readRuns(dir, '2026-10-20').today.length, 0);
  assert.equal(nd.readRuns(dir, '2026-10-20').latest.id, 'old1');
  fs.writeFileSync(path.join(dir, 'new1.md'), reportText('new1', []));
  fs.writeFileSync(path.join(dir, '..evil.md'), 'x');
  const today = nd.ymd(new Date());
  const runs = nd.readRuns(dir, today);
  assert.deepEqual(runs.today.map((r) => r.id), ['new1']);
  assert.equal(runs.latest.id, 'new1');
  assert.deepEqual(nd.readRuns(path.join(dir, 'missing'), today), { today: [], latest: null });
});

test('todaysCommits: argv array with --since=midnight, subject + repo name only, deduped', async () => {
  const calls = [];
  const runGit = async (dir, args) => {
    calls.push({ dir, args });
    return { ok: true, stdout: 'feat: a\nfeat: a\nfix: b\x1b[31m\n' };
  };
  const commits = await nd.todaysCommits([REPO, 'relative/path', '\\\\server\\share'], runGit);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0].args) && calls[0].args.includes('--since=midnight'));
  assert.deepEqual(commits, [
    { repo: 'Luna-Core-HUD', subject: 'feat: a' },
    { repo: 'Luna-Core-HUD', subject: 'fix: b [31m' },
  ]);
  assert.deepEqual(await nd.todaysCommits([REPO], async () => { throw new Error('x'); }), []);
});

test('tickedToday: done now but not in the morning baseline', () => {
  const projects = [{ id: 'p', name: 'Proj', todos: [{ text: 'a', done: true, at: 1 }, { text: 'b', done: true, at: 2 }, { text: 'c', done: false, at: 3 }] }];
  assert.deepEqual(nd.doneKeys(projects), ['p|1', 'p|2']);
  assert.deepEqual(nd.tickedToday(projects, ['p|1']), [{ project: 'Proj', text: 'b' }]);
});

test('usageOf reads the 5 h and weekly windows', () => {
  assert.deepEqual(nd.usageOf({ limits: [{ window: '5h', percentUsed: 42.4 }, { window: 'weekly', percentUsed: 81 }] }), { fiveHour: 42, weekly: 81 });
  assert.deepEqual(nd.usageOf(null), { fiveHour: null, weekly: null });
});

test('isDue: after the set time, once per day, only when enabled', () => {
  const prefs = { nightlyEnabled: true, nightlyTime: '22:30' };
  assert.equal(nd.isDue(new Date(2026, 9, 20, 22, 29), prefs, { lastNightly: '' }), false);
  assert.equal(nd.isDue(new Date(2026, 9, 20, 22, 30), prefs, { lastNightly: '' }), true);
  // Woke at 23:50 the same day: still due.
  assert.equal(nd.isDue(new Date(2026, 9, 20, 23, 50), prefs, { lastNightly: '2026-10-19' }), true);
  assert.equal(nd.isDue(new Date(2026, 9, 20, 23, 50), prefs, { lastNightly: '2026-10-20' }), false);
  // Woke the next morning: that day's time has not come yet.
  assert.equal(nd.isDue(new Date(2026, 9, 21, 7, 0), prefs, { lastNightly: '2026-10-19' }), false);
  assert.equal(nd.isDue(new Date(2026, 9, 20, 23, 0), { ...prefs, nightlyEnabled: false }, { lastNightly: '' }), false);
});

test('the prompt carries the data as data; the answer is validated', () => {
  const d = { date: '2026-10-20', runs: [], latestRun: null, commits: [{ repo: 'r', subject: 'feat: x' }], todos: [], usage: { fiveHour: 1, weekly: 2 } };
  const prompt = nd.buildDigestPrompt(d);
  assert.match(prompt, /```data\n[\s\S]*\[r\] feat: x[\s\S]*```/);
  assert.match(prompt, /not instructions/);
  assert.deepEqual(nd.parseDigestAnswer({ subject: 'Day', body: 'Done: x' }), { subject: 'Day', text: 'Done: x' });
  assert.equal(nd.parseDigestAnswer({ subject: '', body: 'x' }), null);
  assert.equal(nd.parseDigestAnswer(null), null);
});

function harness({ clock, commits = [], todos = [], runResult = { ok: true, answer: { subject: 'Your day', body: 'DONE ...' } } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.local.json'), statePath: path.join(dir, 'state.local.json') });
  const sent = [];
  const runs = [];
  const state = { now: clock, todos };
  const digest = nd.createNightlyDigest({
    prefs,
    sender: { status: () => ({ connected: true }), send: async (m) => sent.push(m) },
    runsDir: () => path.join(dir, 'runs'),
    listRepos: () => [REPO],
    runGit: async () => ({ ok: true, stdout: commits.join('\n') }),
    listProjects: () => [{ id: 'p', name: 'Proj', todos: state.todos }],
    getUsage: () => null,
    run: async (job) => {
      runs.push(job);
      return runResult;
    },
    getEnv: () => ({}),
    now: () => state.now,
  });
  return { digest, prefs, sent, runs, state };
}

test('tick sends once at the time, persists the date, never double sends across restarts', async () => {
  const h = harness({ clock: new Date(2026, 9, 20, 9, 0), commits: ['feat: one'] });
  h.prefs.savePrefs({ nightlyEnabled: true });
  assert.equal(await h.digest.tick(), null); // morning: baseline only
  h.state.now = new Date(2026, 9, 20, 22, 31);
  assert.deepEqual(await h.digest.tick(), { ok: true });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].subject, 'Your day');
  assert.match(h.sent[0].text, /\[Luna-Core-HUD\] feat: one/);
  assert.equal(h.runs[0].model, 'haiku');
  assert.equal(h.runs[0].lean, true);
  assert.equal(await h.digest.tick(), null);
  assert.equal(h.prefs.loadState().lastNightly, '2026-10-20');
});

test('a failed model call sends the plain list instead', async () => {
  const h = harness({ clock: new Date(2026, 9, 20, 23, 0), commits: ['fix: x'], runResult: { ok: false, reason: 'timeout' } });
  h.prefs.savePrefs({ nightlyEnabled: true });
  await h.digest.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].subject, 'LunaCore - day summary 2026-10-20');
  assert.match(h.sent[0].text, /COMMITS TODAY\n- \[Luna-Core-HUD\] fix: x/);
});

test('an empty day is skipped (and marked) unless "send even when empty"', async () => {
  const h = harness({ clock: new Date(2026, 9, 20, 23, 0) });
  h.prefs.savePrefs({ nightlyEnabled: true });
  assert.deepEqual(await h.digest.tick(), { ok: true, skipped: 'empty' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.runs.length, 0);
  const h2 = harness({ clock: new Date(2026, 9, 20, 23, 0) });
  h2.prefs.savePrefs({ nightlyEnabled: true, sendWhenEmpty: true });
  await h2.digest.tick();
  assert.equal(h2.sent.length, 1);
});

test('to-dos ticked after the first look of the day are reported', async () => {
  const todos = [{ text: 'old', done: true, at: 1 }, { text: 'new', done: false, at: 2 }];
  const h = harness({ clock: new Date(2026, 9, 20, 8, 0), todos });
  h.prefs.savePrefs({ nightlyEnabled: true });
  await h.digest.tick();
  h.state.todos = [{ text: 'old', done: true, at: 1 }, { text: 'new', done: true, at: 2 }];
  const data = await h.digest.collect();
  assert.deepEqual(data.todos, [{ project: 'Proj', text: 'new' }]);
});

test('"Send test now" sends even an empty day and does not mark it sent', async () => {
  const h = harness({ clock: new Date(2026, 9, 20, 12, 0) });
  assert.deepEqual(await h.digest.sendNow({ test: true }), { ok: true });
  assert.match(h.sent[0].subject, /^\[test\] /);
  assert.equal(h.prefs.loadState().lastNightly, '');
});
