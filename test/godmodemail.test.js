// ============================================================================
// LunaCore - God Mode run email tests (src/godmodemail.js + finalize hook)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRunEmail, createGodModeMailer, resultKey } = require('../src/godmodemail.js');
const { createMailPrefs, godmodeEmailOn } = require('../src/mailprefs.js');

const REPORT = [
  '# God Mode run abc123',
  '',
  '- Finished: 2026-10-20 22:00',
  '- Repo: `C:\\Users\\Mati\\source\\repos\\Luna-Core-HUD` (base `main`)',
  '- Result: 1 of 2 packages pushed',
  '',
].join('\n');

const summary = (over = {}) => ({
  id: 'abc123',
  repoName: 'Luna-Core-HUD',
  pushed: 1,
  total: 2,
  integrationState: 'done',
  integrationError: null,
  packages: [
    { id: 'p1', title: 'One', state: 'pushed', prUrl: 'https://github.com/o/r/pull/7', reason: '' },
    { id: 'p2', title: 'Two\u0007', state: 'stalled', prUrl: null, reason: 'verifyFailed - 2 tests\r\nfailing' },
  ],
  approvalSuggestions: ['Bash(npm run *)'],
  ...over,
});

test('subject: repo name and N of M pushed, or integration failed', () => {
  assert.equal(buildRunEmail(REPORT, summary()).subject, 'God Mode: Luna-Core-HUD - 1 of 2 pushed - needs you');
  assert.equal(
    buildRunEmail(REPORT, summary({ integrationState: 'failed' })).subject,
    'God Mode: Luna-Core-HUD - integration failed - needs you',
  );
  assert.equal(buildRunEmail(REPORT, summary(), { updated: true }).subject, 'God Mode: Luna-Core-HUD - 1 of 2 pushed - needs you (updated)');
});

// The morning report (orchestraReport.buildReport) of a merge-mode run.
const { buildReport } = require('../src/orchestraReport.js');
const mergeView = (over = {}) => ({
  id: 'abc123',
  repoPath: 'C:\\Users\\Mati\\source\\repos\\Luna-Core-HUD',
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'merge',
  integration: { state: 'done', skipped: [] },
  overlaps: [],
  packages: [
    { id: 'p1', title: 'One', state: 'pushed', merged: true },
    { id: 'p2', title: 'Two', state: 'pushed', merged: true },
  ],
  ...over,
});
const mergeSummary = (over = {}) =>
  summary({ integrationMode: 'merge', pushed: 2, merged: 2, total: 2, approvalSuggestions: [], packages: [], ...over });

test("subject: 'N of M merged' in merge mode, ' - needs you' only when Needs you is not empty", () => {
  const clean = buildReport(mergeView(), { now: 1, suggestions: [] });
  const mail = buildRunEmail(clean, mergeSummary());
  assert.equal(mail.subject, 'God Mode: Luna-Core-HUD - 2 of 2 merged');
  assert.match(mail.text, /^NEEDS YOU\n- nothing\n/);

  const skipped = mergeView({
    integration: { state: 'done', partial: true, skipped: [{ id: 'p2', stage: 'conflict', detail: 'x\u001b[2J', files: ['a.js'] }] },
    packages: [
      { id: 'p1', title: 'One', state: 'pushed', merged: true },
      { id: 'p2', title: 'Two', state: 'pushed', merged: false },
    ],
  });
  const red = buildRunEmail(buildReport(skipped, { now: 1, suggestions: [] }), mergeSummary({ merged: 1 }));
  assert.equal(red.subject, 'God Mode: Luna-Core-HUD - 1 of 2 merged - needs you');
});

test("the email's Needs you block is the report's section, plain text", () => {
  const view = mergeView({
    integration: {
      state: 'done',
      skipped: [],
      manualActions: [{ kind: 'migration', what: '001.sql', from: 'abcdef1' }],
      selfCheck: { tests: 'failed', syntax: 'ok', smoke: 'skipped', fixups: 1, tail: 'not ok 1\u0007 boom', pushedIntegrationBranch: 'luna/abc123-integration' },
    },
    packages: [
      { id: 'p1', title: 'One', state: 'pushed', merged: false },
      { id: 'p2', title: 'Two', state: 'pending', blockedBy: 'p9' },
    ],
  });
  const { text, subject } = buildRunEmail(buildReport(view, { now: 1, suggestions: [] }), mergeSummary({ merged: 0 }));
  assert.match(subject, / - needs you$/);
  const needs = text.slice(0, text.indexOf('FULL REPORT'));
  assert.match(needs, /- p2 Two - blocked by p9/);
  assert.match(needs, /1 manual action to apply live/);
  assert.match(needs, /Self-check red: tests\. Pushed luna\/abc123-integration instead of main\./);
  assert.match(needs, /\n {4}not ok 1 +boom\n/, 'the tail stays indented under its line');
  assert.doesNotMatch(needs, /`/, 'markdown code marks are stripped');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f]/);
});

test('body: Needs you first, then PR links, then the report - no path, no control chars', () => {
  const { text } = buildRunEmail(REPORT, summary({ integrationState: 'failed', integrationError: 'ghFailed: auth' }));
  const needs = text.indexOf('NEEDS YOU');
  const prs = text.indexOf('PULL REQUESTS');
  const full = text.indexOf('FULL REPORT');
  assert.ok(needs === 0 && needs < prs && prs < full);
  assert.match(text, /- p2 Two: stalled - verifyFailed - 2 tests failing/);
  assert.match(text, /Approval prompt stalled a worker: Bash\(npm run \*\)/);
  assert.match(text, /Integration failed: ghFailed: auth/);
  assert.match(text, /- p1: https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /- Repo: Luna-Core-HUD \(base `main`\)/);
  assert.doesNotMatch(text, /Users\\\\Mati|C:\\/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f]/);
});

test('resultKey is (pushed, integration state)', () => {
  assert.equal(resultKey(summary()), '1|done');
  assert.equal(resultKey(summary({ integrationState: 'x;y' })), '1|idle');
});

test('godmodeEmailOn: default ON once connected, off without Gmail', () => {
  assert.equal(godmodeEmailOn({ godmodeEmail: null }, true), true);
  assert.equal(godmodeEmailOn({ godmodeEmail: false }, true), false);
  assert.equal(godmodeEmailOn({ godmodeEmail: true }, false), false);
});

function setup({ connected = true, failSend = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmmail-test-'));
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.local.json'), statePath: path.join(dir, 'mail-state.local.json') });
  const sent = [];
  const sender = {
    status: () => ({ connected }),
    send: async (m) => {
      if (failSend) throw Object.assign(new Error('x'), { reason: failSend });
      sent.push(m);
    },
  };
  return { prefs, sent, mailer: createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn }) };
}

test('dedupe: same result sends once, a changed result sends one "updated" email', async () => {
  const { mailer, sent, prefs } = setup();
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary()), { sent: true });
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary()), { sent: false, skipped: 'duplicate' });
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary({ pushed: 2 })), { sent: true });
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary({ pushed: 2 })), { sent: false, skipped: 'duplicate' });
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /\(updated\)$/);
  // Persisted: a fresh mailer (restart) still dedupes.
  const again = createGodModeMailer({ sender: { status: () => ({ connected: true }), send: async () => sent.push('x') }, prefs, enabled: godmodeEmailOn });
  assert.equal((await again.onReport('abc123', REPORT, summary({ pushed: 2 }))).skipped, 'duplicate');
});

test('off or not connected: nothing sent; a send failure comes back as a reason', async () => {
  const off = setup({ connected: false });
  assert.equal((await off.mailer.onReport('abc123', REPORT, summary())).skipped, 'not-connected');
  // Switched off on purpose: no "connect Gmail" nag, connected or not.
  off.prefs.savePrefs({ godmodeEmail: false });
  assert.equal((await off.mailer.onReport('abc123', REPORT, summary())).skipped, 'off');
  const failing = setup({ failSend: 'gmail-network' });
  assert.deepEqual(await failing.mailer.onReport('abc123', REPORT, summary()), { sent: false, error: 'gmail-network' });
  // A failed send is not recorded: the next finalize tries again.
  assert.equal(failing.prefs.loadState().godmode.abc123, undefined);
});

test('finalize hands the report to onReport and shows an email failure on the board', async () => {
  const { createFinalizer } = require('../src/orchestraFinalize.js');
  const plan = {
    id: 'abc123',
    repoPath: 'C:\\repos\\Luna-Core-HUD',
    integrationMode: 'branches',
    integration: { state: 'idle' },
    approvalLog: [],
    packages: [{ id: 'p1', title: 'One', state: 'pushed', deps: [] }],
  };
  const reports = [];
  let onReportArgs = null;
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: () => {},
    commit: () => {},
    view: () => ({ id: plan.id, packages: plan.packages, integration: plan.integration, workerModel: 'opus', permissionMode: 'x', overlaps: [] }),
    onRunEvent: () => {},
    now: () => 1760990000000,
    writeReport: (id, text) => reports.push(text),
    onReport: async (...args) => {
      onReportArgs = args;
      return { sent: false, error: 'gmail-auth' };
    },
  });
  assert.equal(await fin.finalize(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(onReportArgs[0], 'abc123');
  assert.match(onReportArgs[1], /^# God Mode run abc123/);
  assert.equal(onReportArgs[2].repoName, 'Luna-Core-HUD');
  assert.equal(onReportArgs[2].pushed, 1);
  assert.equal(plan.integration.emailError, 'gmail-auth');
  assert.match(reports[reports.length - 1], /- Email failed: gmail-auth/);
});

test('finalize shows "Gmail not connected" on the board instead of skipping silently', async () => {
  const { createFinalizer } = require('../src/orchestraFinalize.js');
  const plan = { id: 'r2', repoPath: 'C:\\r', integrationMode: 'branches', integration: { state: 'idle' }, approvalLog: [], packages: [] };
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: () => {},
    commit: () => {},
    view: () => ({ id: plan.id, packages: [], integration: plan.integration, overlaps: [] }),
    onRunEvent: () => {},
    now: () => 1,
    onReport: async () => ({ sent: false, skipped: 'not-connected' }),
  });
  assert.equal(await fin.finalize(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(plan.integration.emailError, 'gmail-not-connected');
});

test('finalize: a switched-off or duplicate email is not shown as an error', async () => {
  const { createFinalizer } = require('../src/orchestraFinalize.js');
  for (const skipped of ['off', 'duplicate']) {
    const plan = { id: 'r3', repoPath: 'C:\\r', integrationMode: 'branches', integration: { state: 'idle' }, approvalLog: [], packages: [] };
    const fin = createFinalizer({
      getPlan: () => plan,
      patch: () => {},
      commit: () => {},
      view: () => ({ id: plan.id, packages: [], integration: plan.integration, overlaps: [] }),
      onRunEvent: () => {},
      now: () => 1,
      onReport: async () => ({ sent: false, skipped }),
    });
    await fin.finalize();
    await new Promise((r) => setImmediate(r));
    assert.equal(plan.integration.emailError, null, skipped);
  }
});

test('a throwing onReport never breaks finalize', async () => {
  const { createFinalizer } = require('../src/orchestraFinalize.js');
  const plan = { id: 'r1', repoPath: 'C:\\r', integrationMode: 'branches', integration: { state: 'idle' }, approvalLog: [], packages: [] };
  const events = [];
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: () => {},
    commit: () => {},
    view: () => ({ id: plan.id, packages: [], integration: plan.integration, overlaps: [] }),
    onRunEvent: (kind) => events.push(kind),
    now: () => 1,
    onReport: () => {
      throw new Error('boom');
    },
  });
  assert.equal(await fin.finalize(), true);
  assert.ok(events.includes('finalized'));
  assert.equal(plan.integration.emailError, 'failed');
});

test('the run email attaches the HTML report when there is one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmmail-test-'));
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.local.json'), statePath: path.join(dir, 'mail-state.local.json') });
  const sent = [];
  const sender = { status: () => ({ connected: true }), send: async (m) => sent.push(m) };
  const asked = [];
  const readHtml = (id) => {
    asked.push(id);
    return id === 'abc123' ? '<!doctype html><title>r</title>' : null;
  };
  const mailer = createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn, readHtml });
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary()), { sent: true });
  assert.deepEqual(sent[0].attachments, [{ filename: 'godmode-run-abc123.html', mimeType: 'text/html', content: '<!doctype html><title>r</title>' }]);
  assert.deepEqual(await mailer.onReport('zzz999', REPORT, summary()), { sent: true });
  assert.equal(sent[1].attachments, undefined);
  assert.deepEqual(asked, ['abc123', 'zzz999']);
});

test('a throwing readHtml still sends the text email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmmail-test-'));
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.local.json'), statePath: path.join(dir, 'mail-state.local.json') });
  const sent = [];
  const sender = { status: () => ({ connected: true }), send: async (m) => sent.push(m) };
  const readHtml = () => {
    throw new Error('EACCES');
  };
  const mailer = createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn, readHtml });
  assert.deepEqual(await mailer.onReport('abc123', REPORT, summary()), { sent: true });
  assert.equal(sent[0].attachments, undefined);
});

test('readRunHtml: reads <runsDir>/<id>.html, null for a bad id or a missing file', () => {
  const { readRunHtml } = require('../src/reportmail.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmmail-html-'));
  fs.writeFileSync(path.join(dir, 'abc123.html'), '<p>ok</p>');
  assert.equal(readRunHtml(dir, 'abc123'), '<p>ok</p>');
  assert.equal(readRunHtml(dir, 'nope99'), null);
  assert.equal(readRunHtml(dir, '../abc123'), null);
  assert.equal(readRunHtml('', 'abc123'), null);
});
