// ============================================================================
// LunaCore - pending God Mode run emails + "Resend report email"
//   - src/godmodePending.js: a transient failure (Gmail not connected,
//     rate-limited, busy) marks the run pending; flush() sends the pending
//     ones once - oldest first, at most 3, each run at most once - then
//     clears them; resend() goes past the dedupe.
//   - src/godmodemail.js force, src/orchestraFinalize.js emailPending,
//     src/mailipc.js onConnected, src/orchestraFinishIpc.js id checks,
//     src/reportmail.js readRunText.
// Every mail send is a fake; nothing touches Gmail or the network.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPendingRunMail, normalizePending, failureOf, MAX_PER_FLUSH } = require('../src/godmodePending.js');
const { normalizeState } = require('../src/mailprefs.js');
const { createGodModeMailer } = require('../src/godmodemail.js');
const { createFinalizer } = require('../src/orchestraFinalize.js');
const { registerMailIpc } = require('../src/mailipc.js');
const finishIpc = require('../src/orchestraFinishIpc.js');
const { readRunText } = require('../src/reportmail.js');

const summary = (over = {}) => ({
  repoName: 'Luna-Core-HUD',
  integrationMode: 'merge',
  integrationState: 'done',
  integrationError: null,
  pushed: 2,
  merged: 2,
  total: 2,
  packages: [{ id: 'core', title: 'Core', state: 'pushed', reason: null, prUrl: null }],
  approvalSuggestions: [],
  ...over,
});

/** mail-state.local.json in memory, through the real normalizer. */
function memoryPrefs(initial = {}) {
  let state = normalizeState(initial);
  return {
    loadState: () => state,
    updateState: (fn) => {
      state = normalizeState(fn(state));
      return state;
    },
    loadPrefs: () => ({ godmodeEmail: null }),
  };
}

function pendingHarness({ connected = true, send, reports = {} } = {}) {
  const prefs = memoryPrefs();
  const sends = [];
  const results = [];
  let clock = 100;
  let isConnected = connected;
  const runMail = createPendingRunMail({
    prefs,
    send: async (id, text, sum, opts) => {
      sends.push({ id, text, sum, opts });
      return send ? send(id, opts) : { sent: true };
    },
    readReport: (id) => (id in reports ? reports[id] : `# report ${id}`),
    connected: () => isConnected,
    onResult: (id, res) => results.push({ id, ...res }),
    now: () => (clock += 1),
  });
  return { runMail, prefs, sends, results, connect: () => (isConnected = true) };
}

// ---------------------------------------------------------------------------
// The pending list
// ---------------------------------------------------------------------------

test('normalizePending keeps valid entries only, one per run, oldest first', () => {
  const list = normalizePending([
    { id: 'pb', at: 20, reason: 'rate-limited', summary: summary() },
    { id: 'pa', at: 10, reason: 'gmail-not-connected', summary: summary() },
    { id: '../evil', at: 5, reason: 'busy', summary: summary() },
    { id: 'pc', at: 'x', reason: 'busy', summary: summary() },
    { id: 'pd', at: 1, reason: 'busy', summary: null },
    { id: 'pb', at: 30, reason: 'weird', summary: summary() },
    'junk',
  ]);
  assert.deepEqual(list.map((e) => [e.id, e.at, e.reason]), [['pa', 10, 'gmail-not-connected'], ['pb', 30, 'gmail-failed']]);
  assert.deepEqual(normalizePending('nope'), []);
});

test('mail-state keeps godmodePending through its own normalizer', () => {
  const state = normalizeState({ godmodePending: [{ id: 'pa', at: 1, reason: 'busy', summary: summary() }, { id: 'X/Y', at: 2 }] });
  assert.deepEqual(state.godmodePending.map((e) => e.id), ['pa']);
  assert.deepEqual(normalizeState({}).godmodePending, []);
});

test('failureOf: errors and not-connected are failures; sent, duplicate and off are not', () => {
  assert.equal(failureOf({ sent: false, error: 'rate-limited' }), 'rate-limited');
  assert.equal(failureOf({ sent: false, skipped: 'not-connected' }), 'gmail-not-connected');
  assert.equal(failureOf({ sent: false, skipped: 'duplicate' }), null);
  assert.equal(failureOf({ sent: false, skipped: 'off' }), null);
  assert.equal(failureOf({ sent: true }), null);
  assert.equal(failureOf({ sent: false, error: 'Bad Reason!' }), 'gmail-failed');
});

// ---------------------------------------------------------------------------
// First try -> pending
// ---------------------------------------------------------------------------

test('Gmail not connected at the end of a run: the email is marked pending', async () => {
  const h = pendingHarness({ send: () => ({ sent: false, skipped: 'not-connected' }) });
  const res = await h.runMail.report('pa', '# report', summary());
  assert.equal(res.pending, true);
  assert.deepEqual(h.runMail.list().map((e) => [e.id, e.reason]), [['pa', 'gmail-not-connected']]);
});

test('rate-limited and busy are transient (pending); a scope error is not', async () => {
  for (const error of ['rate-limited', 'busy']) {
    const h = pendingHarness({ send: () => ({ sent: false, error }) });
    assert.equal((await h.runMail.report('pa', '# r', summary())).pending, true, error);
  }
  const scope = pendingHarness({ send: () => ({ sent: false, error: 'gmail-scope' }) });
  const res = await scope.runMail.report('pa', '# r', summary());
  assert.equal(res.pending, undefined);
  assert.deepEqual(scope.runMail.list(), []);
});

test('a send that throws never rejects the first try', async () => {
  const h = pendingHarness({
    send: () => {
      throw Object.assign(new Error('boom'), { reason: 'gmail-network' });
    },
  });
  const res = await h.runMail.report('pa', '# r', summary());
  assert.equal(res.error, 'gmail-network');
  assert.equal(res.pending, true);
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

test('flush while Gmail is still not connected sends nothing and keeps the list', async () => {
  const h = pendingHarness({ connected: false });
  h.runMail.mark('pa', summary(), 'gmail-not-connected');
  assert.deepEqual(await h.runMail.flush(), []);
  assert.equal(h.sends.length, 0);
  assert.equal(h.runMail.list().length, 1);
});

test('after Gmail connects: oldest first, at most 3, each run once, then the flag is cleared', async () => {
  const h = pendingHarness({ connected: false });
  for (const id of ['pa', 'pb', 'pc', 'pd', 'pe']) h.runMail.mark(id, summary(), 'gmail-not-connected');
  h.connect();

  const first = await h.runMail.flush();
  assert.equal(MAX_PER_FLUSH, 3);
  assert.deepEqual(first.map((r) => [r.id, r.sent]), [['pa', true], ['pb', true], ['pc', true]]);
  assert.deepEqual(h.sends.map((s) => s.id), ['pa', 'pb', 'pc']);
  assert.equal(h.sends[0].text, '# report pa');
  assert.equal(h.sends[0].sum.repoName, 'Luna-Core-HUD');
  assert.deepEqual(h.runMail.list().map((e) => e.id), ['pd', 'pe']);
  assert.deepEqual(h.results.map((r) => r.id), ['pa', 'pb', 'pc']);

  await h.runMail.flush();
  await h.runMail.flush();
  // Every run went out exactly once.
  assert.deepEqual(h.sends.map((s) => s.id), ['pa', 'pb', 'pc', 'pd', 'pe']);
  assert.deepEqual(h.runMail.list(), []);
});

test('a flush send that fails is not retried and not re-added', async () => {
  const h = pendingHarness({ send: () => ({ sent: false, error: 'rate-limited' }) });
  h.runMail.mark('pa', summary(), 'gmail-not-connected');
  const res = await h.runMail.flush();
  assert.deepEqual(res, [{ id: 'pa', sent: false, reason: 'rate-limited' }]);
  assert.deepEqual(h.runMail.list(), []);
  await h.runMail.flush();
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.results, [{ id: 'pa', sent: false, reason: 'rate-limited' }]);
});

test('a duplicate (already sent by Resend) counts as sent; a missing report is not sent', async () => {
  const h = pendingHarness({ send: () => ({ sent: false, skipped: 'duplicate' }), reports: { pb: null } });
  h.runMail.mark('pa', summary(), 'busy');
  h.runMail.mark('pb', summary(), 'busy');
  const res = await h.runMail.flush();
  assert.deepEqual(res, [{ id: 'pa', sent: true, reason: null }, { id: 'pb', sent: false, reason: 'no-report' }]);
  assert.equal(h.sends.length, 1);
});

// ---------------------------------------------------------------------------
// resend
// ---------------------------------------------------------------------------

test('resend sends now with force, from the current summary, and clears a pending flag', async () => {
  const h = pendingHarness();
  h.runMail.mark('pa', summary({ repoName: 'old' }), 'rate-limited');
  const res = await h.runMail.resend('pa', summary({ repoName: 'current' }));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(h.sends[0].opts, { force: true });
  assert.equal(h.sends[0].sum.repoName, 'current');
  assert.deepEqual(h.runMail.list(), []);
  assert.deepEqual(h.results, [{ id: 'pa', sent: true, reason: null }]);
});

test('resend falls back to the pending summary; refuses unknown runs, bad ids, no Gmail', async () => {
  const h = pendingHarness();
  h.runMail.mark('pa', summary({ repoName: 'stored' }), 'busy');
  assert.deepEqual(await h.runMail.resend('pa', null), { ok: true });
  assert.equal(h.sends[0].sum.repoName, 'stored');
  assert.deepEqual(await h.runMail.resend('pz', null), { ok: false, reason: 'unknownRun' });
  assert.deepEqual(await h.runMail.resend('../x', summary()), { ok: false, reason: 'badId' });

  const off = pendingHarness({ connected: false });
  assert.deepEqual(await off.runMail.resend('pa', summary()), { ok: false, reason: 'gmail-not-connected' });
  assert.equal(off.sends.length, 0);
});

// ---------------------------------------------------------------------------
// godmodemail force
// ---------------------------------------------------------------------------

test('godmodemail: force goes past the dedupe and the off switch, never past "not connected"', async () => {
  const sent = [];
  let connected = true;
  const prefs = {
    ...memoryPrefs(),
    loadPrefs: () => ({ godmodeEmail: false }),
  };
  const mailer = createGodModeMailer({
    sender: { status: () => ({ connected }), send: async (m) => sent.push(m) },
    prefs,
    enabled: (p, c) => c && p.godmodeEmail !== false,
  });
  assert.deepEqual(await mailer.onReport('pa', '# r', summary()), { sent: false, skipped: 'off' });
  assert.deepEqual(await mailer.onReport('pa', '# r', summary(), { force: true }), { sent: true });
  assert.deepEqual(await mailer.onReport('pa', '# r', summary(), { force: true }), { sent: true });
  assert.equal(sent.length, 2);
  connected = false;
  assert.deepEqual(await mailer.onReport('pa', '# r', summary(), { force: true }), { sent: false, skipped: 'not-connected' });
});

// ---------------------------------------------------------------------------
// The finalizer's email state
// ---------------------------------------------------------------------------

function finalizerFor(plan, onReport) {
  let commits = 0;
  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => Object.assign(plan.packages.find((p) => p.id === id), fields),
    commit: () => (commits += 1),
    view: () => ({ ...plan, packages: plan.packages.map((p) => ({ ...p })), integration: { ...plan.integration } }),
    onRunEvent: () => {},
    now: () => 1000,
    writeReport: (id) => `/runs/${id}.md`,
    onReport,
    sleep: async () => {},
  });
  return { finalizer, commits: () => commits };
}

const branchesPlan = () => ({
  id: 'pabc123',
  projectId: 'proj1',
  repoPath: '/repo/Luna-Core-HUD',
  baseBranch: 'main',
  integrationMode: 'branches',
  approvalLog: [],
  options: {},
  integration: { state: 'idle', error: null, detail: null, at: null },
  packages: [{ id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core-ab12c', dependsOn: [] }],
});

const settle = () => new Promise((r) => setImmediate(r));

test('finalize marks the run "email pending" when the first try came back pending', async () => {
  const plan = branchesPlan();
  const { finalizer } = finalizerFor(plan, async () => ({ sent: false, skipped: 'not-connected', pending: true }));
  await finalizer.finalize();
  await settle();
  assert.equal(plan.integration.emailError, 'gmail-not-connected');
  assert.equal(plan.integration.emailPending, true);
});

test('a later send clears the board line; emailSummary serves the current run only', async () => {
  const plan = branchesPlan();
  const { finalizer } = finalizerFor(plan, async () => ({ sent: false, error: 'rate-limited', pending: true }));
  await finalizer.finalize();
  await settle();
  assert.equal(plan.integration.emailPending, true);

  const sum = finalizer.emailSummary('pabc123');
  assert.equal(sum.repoName, 'Luna-Core-HUD');
  assert.equal(sum.total, 1);
  assert.equal(finalizer.emailSummary('pother'), null);

  assert.equal(finalizer.emailResult('pother', { sent: true }), false);
  assert.equal(finalizer.emailResult('pabc123', { sent: true, reason: null }), true);
  assert.equal(plan.integration.emailError, null);
  assert.equal(plan.integration.emailPending, false);
});

// ---------------------------------------------------------------------------
// mail:connect -> flush
// ---------------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map();
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ...args) => handlers.get(ch)({}, ...args), handlers };
}

test('mail:connect calls onConnected after a successful connect only', async () => {
  let flushed = 0;
  let fail = false;
  const ipcMain = fakeIpcMain();
  registerMailIpc({
    ipcMain,
    sender: {
      status: () => ({ configured: true, connected: !fail, email: 'm@x.com' }),
      connect: async () => {
        if (fail) throw Object.assign(new Error('denied'), { reason: 'gmail-denied' });
      },
    },
    prefs: { loadPrefs: () => ({ godmodeEmail: null, weeklyEmail: null, replyRead: false, replyClients: {} }) },
    nightly: { sendNow: async () => ({ ok: true }) },
    onConnected: () => (flushed += 1),
  });
  await ipcMain.call('mail:connect');
  await settle();
  assert.equal(flushed, 1);
  fail = true;
  await ipcMain.call('mail:connect');
  await settle();
  assert.equal(flushed, 1);
});

// ---------------------------------------------------------------------------
// orchestra:resend-email - the id is never trusted
// ---------------------------------------------------------------------------

function tempRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-runs-'));
  fs.writeFileSync(path.join(dir, 'pabc123.md'), '# report');
  return dir;
}

test('resend IPC refuses ids that are not a report in the runs folder', async () => {
  const dir = tempRuns();
  try {
    const asked = [];
    const ipcMain = fakeIpcMain();
    finishIpc.register(ipcMain, { runsDir: () => dir, resendRunEmail: async (id) => (asked.push(id), { ok: true }) });
    for (const bad of [null, 42, {}, '', '../pabc123', 'pabc123/..', 'p\\abc', 'PABC123', 'pabc123.md', 'pnothere', 'a'.repeat(41)]) {
      assert.deepEqual(await ipcMain.call('orchestra:resend-email', bad), { ok: false, reason: 'badId' }, String(bad));
    }
    assert.deepEqual(asked, []);
    assert.deepEqual(await ipcMain.call('orchestra:resend-email', 'pabc123'), { ok: true });
    assert.deepEqual(asked, ['pabc123']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resend IPC: one at a time, a gap between sends, unknown reasons read as failed', async () => {
  const dir = tempRuns();
  try {
    let clock = 0;
    let release;
    const ipcMain = fakeIpcMain();
    finishIpc.register(ipcMain, {
      runsDir: () => dir,
      now: () => clock,
      resendRunEmail: () => new Promise((r) => (release = r)),
    });
    const first = ipcMain.call('orchestra:resend-email', 'pabc123');
    assert.deepEqual(await ipcMain.call('orchestra:resend-email', 'pabc123'), { ok: false, reason: 'busy' });
    release({ ok: false, reason: 'something odd' });
    assert.deepEqual(await first, { ok: false, reason: 'failed' });
    clock += 1000;
    assert.deepEqual(await ipcMain.call('orchestra:resend-email', 'pabc123'), { ok: false, reason: 'rate-limited' });
    clock += finishIpc.RESEND_GAP_MS;
    const again = ipcMain.call('orchestra:resend-email', 'pabc123');
    release({ ok: false, reason: 'gmail-not-connected' });
    assert.deepEqual(await again, { ok: false, reason: 'gmail-not-connected' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunText cuts the "Email failed" line a failed first try appended', () => {
  const dir = tempRuns();
  try {
    fs.writeFileSync(path.join(dir, 'pabc123.md'), '# report\n- Result: ok\n\n- Email failed: gmail-not-connected\n');
    assert.equal(readRunText(dir, 'pabc123'), '# report\n- Result: ok\n\n');
    assert.equal(readRunText(dir, '../pabc123'), null);
    assert.equal(readRunText(dir, 'pmissing'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
