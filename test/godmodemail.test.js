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
  assert.equal(buildRunEmail(REPORT, summary()).subject, 'God Mode: Luna-Core-HUD - 1 of 2 pushed');
  assert.equal(buildRunEmail(REPORT, summary({ integrationState: 'failed' })).subject, 'God Mode: Luna-Core-HUD - integration failed');
  assert.equal(buildRunEmail(REPORT, summary(), { updated: true }).subject, 'God Mode: Luna-Core-HUD - 1 of 2 pushed (updated)');
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
