// ============================================================================
// Luna's Work "Run Playtester pass" (src/lunasworkPlaytestOnce.js): one
// explore pass outside a run. Fake adapter / playtest / dialog: the app is
// always stopped, a usage limit retries once on another Claude account, and
// the guards (busy, active run, project, profile) refuse before any app starts.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const settingsStore = require('../src/lunasworkSettings');
const {
  CHANNEL,
  RESULT_FILE,
  ACCOUNT_SWITCH_RETRY_MS,
  profileSummary,
  createConfirmDialog,
  publicResult,
  createPlaytestOnce,
  registerPlaytestOnceIpc,
} = require('../src/lunasworkPlaytestOnce');

const ROOT = path.join(os.tmpdir(), 'lw-pt-fake');
const REPO = path.join(ROOT, 'repo');
const RUNS = path.join(ROOT, 'runs');
const PROFILE = { adapter: 'web', startCommand: 'npm start', url: 'http://localhost:5173' };
const RESETS_AT = Date.UTC(2026, 10, 8, 18, 0);
const EVIDENCE = path.join(RUNS, 'lunaswork-pt1', 'iter-1');
const VIEW = { makeThumb: () => 'data:image/jpeg;base64,AA', log: () => {}, evidenceDir: EVIDENCE };
// A Windows path built from its parts (no escaped backslashes in the source).
const winPath = (...parts) => parts.join(path.win32.sep);

function settingsWith(profile = PROFILE) {
  return profile ? settingsStore.withProject({}, 'game', { profile }).settings : settingsStore.normalizeSettings({});
}

const okReport = () => ({
  ok: true,
  mode: 'explore',
  model: 'opus',
  costUsd: 0.42,
  durationMs: 90_000,
  usage: { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42 },
  report: {
    findings: [{
      kind: 'bug',
      severity: 'high',
      title: 'Cart total is wrong',
      steps: ['open cart', 'add item'],
      screenshot: path.join(RUNS, 'lunaswork-pt1', 'iter-1', 'f1.png'),
      files: [path.join(RUNS, 'lunaswork-pt1', 'iter-1', 'invoice.pdf')],
      consoleErrors: ['TypeError: x is undefined'],
    }],
    scores: [{ milestone: 'M1', criterion: 'checkout', score: 3 }],
    journeys: [{ name: 'buy', passed: false }],
    warnings: [{ code: 'staleEvidence', file: 'old.png' }],
  },
});

/** A fake tester adapter recording start / stop. */
function fakeAdapter(runId, { startThrows = false, message = 'port in use' } = {}) {
  const calls = [];
  return {
    calls,
    evidenceDir: path.join(RUNS, `lunaswork-${runId}`, 'iter-1'),
    start: async (profile) => {
      calls.push(['start', profile]);
      if (startThrows) throw new Error(message);
      return { url: 'http://localhost:5173/' };
    },
    stop: async () => {
      calls.push(['stop']);
    },
  };
}

function setup(over = {}) {
  const adapters = [];
  const played = [];
  const written = [];
  const slept = [];
  const failovers = [];
  const logs = [];
  const answers = Array.isArray(over.answers) ? [...over.answers] : null;
  let active = over.activeOn || null;
  const deps = {
    projects: () => over.projects || [{ id: 'game', label: 'Game', path: REPO }],
    controller: { isActiveOn: (id) => id === active },
    confirm: over.confirm || (async () => true),
    createAdapter: (name, opts) => {
      const adapter = fakeAdapter(opts.runId, over.adapter || {});
      adapters.push({ name, opts, adapter });
      return adapter;
    },
    playtest: over.playtest || (async (opts) => {
      played.push(opts);
      if (answers) return answers.shift();
      return okReport();
    }),
    limitResumeAt: over.limitResumeAt || (() => null),
    accountFailover: over.accountFailover === undefined
      ? (resetsAt) => (failovers.push(resetsAt), false)
      : (resetsAt) => (failovers.push(resetsAt), over.accountFailover(resetsAt)),
    readSettings: () => (over.settings === undefined ? settingsWith() : over.settings),
    resolveDir: over.resolveDir || ((p) => p),
    writeResult: (file, record) => written.push({ file, record }),
    makeThumb: over.makeThumb || ((file) => `data:image/jpeg;base64,${Buffer.from(path.basename(file)).toString('base64')}`),
    newRunId: () => 'pt1',
    now: () => 1_000_000,
    sleep: async (ms) => slept.push(ms),
    log: (line) => logs.push(line),
  };
  const service = createPlaytestOnce(deps);
  return {
    service, adapters, played, written, slept, failovers, logs,
    setActive: (id) => (active = id),
    stops: () => adapters.reduce((n, a) => n + a.adapter.calls.filter((c) => c[0] === 'stop').length, 0),
  };
}

// ---- the pass ---------------------------------------------------------------------

test('a pass starts the app, plays one explore pass, stops it and writes result.json next to iter-1', async () => {
  const s = setup();
  const stages = [];
  const res = await s.service.run('game', { onProgress: (stage) => stages.push(stage) });

  assert.equal(res.ok, true);
  assert.deepEqual(stages, ['starting', 'playing', 'stopping', 'done']);
  assert.equal(s.adapters.length, 1);
  assert.deepEqual(s.adapters[0].opts, { projectDir: REPO, runId: 'pt1', iteration: 1 });
  assert.equal(s.adapters[0].name, 'web');
  assert.deepEqual(s.adapters[0].adapter.calls.map((c) => c[0]), ['start', 'stop']);
  assert.equal(s.played.length, 1);
  assert.equal(s.played[0].mode, 'explore');
  assert.equal(s.played[0].projectDir, REPO);
  assert.equal(s.played[0].url, 'http://localhost:5173/');
  assert.equal(s.played[0].adapter, s.adapters[0].adapter);
  assert.equal(s.written.length, 1);
  assert.equal(s.written[0].file, path.join(RUNS, 'lunaswork-pt1', RESULT_FILE));
  assert.equal(s.written[0].record.outcome, 'ok');
  assert.equal(s.written[0].record.projectId, 'game');
  assert.equal(s.service.lastEvidence().evidenceDir, path.join(RUNS, 'lunaswork-pt1', 'iter-1'));
  assert.equal(s.service.lastEvidence().runId, 'pt1');
});

test('the app is stopped when the Playtester throws', async () => {
  const s = setup({ playtest: async () => { throw new Error('boom'); } });
  const res = await s.service.run('game');
  assert.equal(s.stops(), 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'playtest-failed');
  assert.equal(res.error, 'crashed');
  assert.equal(s.written[0].record.outcome, 'failed');
});

test('the app is stopped when it fails to start, and the Playtester never plays', async () => {
  const s = setup({ adapter: { startThrows: true } });
  const res = await s.service.run('game');
  assert.equal(s.stops(), 1);
  assert.equal(s.played.length, 0);
  assert.deepEqual(res, { ok: false, reason: 'app-failed', detail: 'port in use', evidence: true });
});

test('the app is stopped on a usage limit without failover, and the reset time is reported', async () => {
  const s = setup({ answers: [{ ok: false, error: 'limit', resumeAt: RESETS_AT }] });
  const res = await s.service.run('game');
  assert.equal(s.stops(), 1);
  assert.equal(s.played.length, 1);
  assert.deepEqual(s.failovers, [RESETS_AT]);
  assert.deepEqual(s.slept, []);
  assert.deepEqual(res, { ok: false, reason: 'limit', resetsAt: RESETS_AT, evidence: true });
});

test('a usage limit with failover retries exactly once on the still running app', async () => {
  const s = setup({
    answers: [{ ok: false, error: 'limit', resumeAt: RESETS_AT }, okReport()],
    accountFailover: () => true,
  });
  const res = await s.service.run('game');
  assert.equal(res.ok, true);
  assert.equal(res.result.retried, true);
  assert.equal(s.played.length, 2);
  assert.deepEqual(s.slept, [ACCOUNT_SWITCH_RETRY_MS]);
  assert.deepEqual(s.adapters[0].adapter.calls.map((c) => c[0]), ['start', 'stop']);
});

test('a second usage limit after the failover retry is reported, not retried again', async () => {
  const s = setup({
    answers: [{ ok: false, error: 'limit', detail: 'x' }, { ok: false, error: 'limit', detail: 'x' }, okReport()],
    accountFailover: () => true,
    limitResumeAt: () => RESETS_AT,
  });
  const res = await s.service.run('game');
  assert.equal(s.played.length, 2);
  assert.equal(s.failovers.length, 1);
  assert.equal(s.stops(), 1);
  assert.deepEqual(res, { ok: false, reason: 'limit', resetsAt: RESETS_AT, evidence: true });
});

test('accountFailover gets the usage-limit table time, or null when the reset is unknown', async () => {
  const known = setup({ answers: [{ ok: false, error: 'limit', detail: '5-hour' }], limitResumeAt: () => RESETS_AT });
  await known.service.run('game');
  assert.deepEqual(known.failovers, [RESETS_AT]);
  const unknown = setup({ answers: [{ ok: false, error: 'limit' }] });
  const res = await unknown.service.run('game');
  assert.deepEqual(unknown.failovers, [null]);
  assert.equal(res.resetsAt, null);
});

// ---- guards -----------------------------------------------------------------------

test('one pass at a time: a second call while one runs is refused as busy', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const s = setup({ playtest: async () => (await gate, okReport()) });
  const first = s.service.run('game');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.service.busy(), true);
  assert.deepEqual(await s.service.run('game'), { ok: false, reason: 'busy' });
  release();
  assert.equal((await first).ok, true);
  assert.equal(s.service.busy(), false);
  assert.equal(s.adapters.length, 1);
});

test('refused while a Luna\'s Work run is active on the same project, before any dialog or app', async () => {
  let asked = 0;
  const s = setup({ activeOn: 'game', confirm: async () => (asked += 1, true) });
  assert.deepEqual(await s.service.run('game'), { ok: false, reason: 'run-active' });
  assert.equal(asked, 0);
  assert.equal(s.adapters.length, 0);
});

test('a run on another project does not block the pass', async () => {
  const s = setup({ activeOn: 'other' });
  assert.equal((await s.service.run('game')).ok, true);
});

test('a run that started while the dialog stood open still blocks the pass', async () => {
  let s;
  s = setup({ confirm: async () => (s.setActive('game'), true) });
  assert.deepEqual(await s.service.run('game'), { ok: false, reason: 'run-active' });
  assert.equal(s.adapters.length, 0);
});

test('a missing profile, an unknown project or a missing folder is refused before the dialog', async () => {
  let asked = 0;
  const confirm = async () => (asked += 1, true);
  assert.deepEqual(await setup({ settings: settingsWith(null), confirm }).service.run('game'), { ok: false, reason: 'no-profile' });
  assert.deepEqual(await setup({ confirm }).service.run('nope'), { ok: false, reason: 'bad-project' });
  assert.deepEqual(await setup({ confirm, resolveDir: () => null }).service.run('game'), { ok: false, reason: 'no-folder' });
  assert.deepEqual(await setup({ confirm, resolveDir: () => 'relative/dir' }).service.run('game'), { ok: false, reason: 'no-folder' });
  assert.equal(asked, 0);
});

test('a declined dialog starts nothing; the dialog sees the saved profile', async () => {
  let seen = null;
  const s = setup({ confirm: async (ctx) => ((seen = ctx), false) });
  assert.deepEqual(await s.service.run('game'), { ok: false, reason: 'declined' });
  assert.equal(s.adapters.length, 0);
  assert.equal(seen.repoPath, REPO);
  assert.equal(seen.profile.startCommand, 'npm start');
  assert.equal(s.service.busy(), false);
});

// ---- what leaves main --------------------------------------------------------------

test('publicResult carries no file path and caps every list', () => {
  const res = publicResult({ runId: 'pt1', projectId: 'game', playtest: okReport() }, VIEW);
  // JSON escapes Windows backslashes: look for the escaped form too.
  const json = JSON.stringify(res);
  assert.equal(json.includes(RUNS) || json.includes(JSON.stringify(RUNS).slice(1, -1)), false);
  assert.equal(json.includes('iter-1'), false);
  assert.deepEqual(res.findings[0].files, ['invoice.pdf']);
  assert.equal(res.findings[0].thumb, 'data:image/jpeg;base64,AA');
  assert.deepEqual(res.journeys, [{ name: 'buy', passed: false }]);
  assert.deepEqual(res.consoleErrors, ['TypeError: x is undefined']);
  assert.deepEqual(res.warnings, [{ code: 'staleEvidence', text: 'old.png' }]);
  assert.equal(res.costUsd, 0.42);

  const many = okReport();
  many.report.findings = Array.from({ length: 40 }, (_, i) => ({ ...many.report.findings[0], title: 'x'.repeat(1000), screenshot: `f${i}.png` }));
  const capped = publicResult({ playtest: many }, VIEW);
  assert.equal(capped.findings[0].title.length, 300);
  assert.equal(capped.findings.filter((f) => f.thumb).length, 24);
});

test('a thumbnail that fails or is not an image data URL is dropped', () => {
  const logs = [];
  const res = publicResult({ playtest: okReport() }, { ...VIEW, makeThumb: () => { throw new Error('bad png'); }, log: (l) => logs.push(l) });
  assert.equal(res.findings[0].thumb, null);
  assert.equal(logs.length, 1);
  const other = publicResult({ playtest: okReport() }, { ...VIEW, makeThumb: () => 'file:///C:/secret.png' });
  assert.equal(other.findings[0].thumb, null);
});

test('a screenshot outside the pass folder never gets a thumbnail (main reads no other image)', () => {
  const read = [];
  const view = { ...VIEW, makeThumb: (file) => (read.push(file), 'data:image/jpeg;base64,AA') };
  const outside = okReport();
  outside.report.findings = [
    { ...outside.report.findings[0], screenshot: path.join(ROOT, 'repo', 'secret.png') },
    { ...outside.report.findings[0], screenshot: '../../other/x.png' },
    { ...outside.report.findings[0], screenshot: path.join(RUNS, 'lunaswork-pt1', 'iter-10', 'x.png') },
  ];
  assert.deepEqual(publicResult({ playtest: outside }, view).findings.map((f) => f.thumb), [null, null, null]);
  assert.deepEqual(publicResult({ playtest: okReport() }, { ...view, evidenceDir: undefined }).findings[0].thumb, null);
  assert.deepEqual(read, []);
});

test('error texts reach the renderer without absolute paths', () => {
  const report = okReport();
  report.report.warnings = [
    { code: 'win', detail: `app did not start, see ${winPath('C:', 'Users', 'a b', 'runs', 'server.log')} now` },
    { code: 'quoted', detail: `ENOENT: open '${winPath('C:', 'Users', 'x', 'file.json')}'` },
    { code: 'posix', file: '/home/u/x.png' },
    { code: 'unc', detail: `cannot read ${path.win32.sep}${winPath('', 'srv', 'share', 'f.txt')}` },
    { code: 'url', detail: 'GET http://localhost:5173/a/b failed' },
  ];
  const texts = publicResult({ playtest: report }, VIEW).warnings.map((w) => w.text);
  assert.deepEqual(texts.slice(1), ["ENOENT: open 'file.json'", 'x.png', 'cannot read f.txt', 'GET http://localhost:5173/a/b failed']);
  // A path with a space is cut at the space: the folder names before it are gone.
  assert.equal(texts[0].includes('Users'), false);
  assert.ok(texts[0].endsWith('server.log now'));
});

test('a failed app start answers with its error text minus the evidence path; result.json keeps it', async () => {
  const message = `app did not start, see ${path.join(EVIDENCE, 'server.log')}`;
  const s = setup({ adapter: { startThrows: true, message } });
  const res = await s.service.run('game');
  assert.deepEqual(res, { ok: false, reason: 'app-failed', detail: 'app did not start, see server.log', evidence: true });
  assert.equal(s.written[0].record.detail, message);
});

test('the tokens of the limited call and the retry are both reported', async () => {
  const limited = { ok: false, error: 'limit', resumeAt: RESETS_AT, usage: { calls: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
  const s = setup({ answers: [limited, okReport()], accountFailover: () => true });
  const res = await s.service.run('game');
  assert.equal(res.result.usage.calls, 2);
  assert.equal(res.result.usage.inputTokens, 110);
  assert.equal(res.result.usage.outputTokens, 50);
});

test('an adapter without an evidence folder answers evidence:false and forgets the previous pass', async () => {
  const s = setup({ answers: [okReport(), { ok: false, error: 'limit', resumeAt: RESETS_AT }] });
  await s.service.run('game');
  assert.ok(s.service.lastEvidence());
  const bare = createPlaytestOnce({
    projects: () => [{ id: 'game', path: REPO }],
    controller: { isActiveOn: () => false },
    confirm: async () => true,
    createAdapter: () => ({ start: async () => ({ url: 'http://localhost:1/' }), stop: async () => {} }),
    playtest: async () => ({ ok: false, error: 'limit', resumeAt: RESETS_AT }),
    readSettings: () => settingsWith(),
    resolveDir: (p) => p,
    writeResult: () => assert.fail('no folder, no result.json'),
    sleep: async () => {},
  });
  assert.deepEqual(await bare.run('game'), { ok: false, reason: 'limit', resetsAt: RESETS_AT, evidence: false });
  assert.equal(bare.lastEvidence(), null);
});

test('profileSummary lists every command the pass runs', () => {
  const rows = profileSummary({ ...PROFILE, seedCommand: 'npm run seed' });
  assert.ok(rows.includes('Start command: npm start'));
  assert.ok(rows.includes('Seed command: npm run seed'));
  assert.ok(rows.includes('App URL: http://localhost:5173'));
});

test('the confirm dialog answers yes only for its first button, and no without a window', async () => {
  let shown = null;
  const win = { isDestroyed: () => false };
  const dialog = { showMessageBox: async (w, opts) => ((shown = opts), { response: 0 }) };
  assert.equal(await createConfirmDialog({ dialog, getWindow: () => win })({ repoPath: REPO, profile: PROFILE }), true);
  assert.ok(shown.detail.includes('Start command: npm start'));
  const no = { showMessageBox: async () => ({ response: 1 }) };
  assert.equal(await createConfirmDialog({ dialog: no, getWindow: () => win })({ repoPath: REPO, profile: PROFILE }), false);
  assert.equal(await createConfirmDialog({ dialog, getWindow: () => null })({ repoPath: REPO, profile: PROFILE }), false);
});

// ---- IPC --------------------------------------------------------------------------

function fakeIpc() {
  const handlers = {};
  return { handle: (ch, fn) => (handlers[ch] = fn), invoke: (ch, arg) => handlers[ch]({}, arg) };
}

test('lunaswork:playtestOnce takes exactly {projectId} and pushes progress on lunaswork:event', async () => {
  const ipc = fakeIpc();
  const sent = [];
  const ran = [];
  const service = {
    run: async (projectId, { onProgress }) => {
      ran.push(projectId);
      onProgress('starting');
      return { ok: true, result: {} };
    },
  };
  registerPlaytestOnceIpc({ ipcMain: ipc, service, send: (ch, payload) => sent.push({ ch, payload }) });
  for (const bad of [undefined, null, 'game', [], {}, { projectId: '' }, { projectId: 7 }, { projectId: 'game', dir: 'C:/' }, { projectId: '__proto__' }]) {
    assert.deepEqual(await ipc.invoke(CHANNEL, bad), { ok: false, reason: 'bad-project' }, JSON.stringify(bad));
  }
  assert.deepEqual(ran, []);
  assert.deepEqual(await ipc.invoke(CHANNEL, { projectId: 'game' }), { ok: true, result: {} });
  assert.deepEqual(ran, ['game']);
  assert.deepEqual(sent, [{ ch: 'lunaswork:event', payload: { type: 'playtestOnce', stage: 'starting', projectId: 'game' } }]);
});

test('lunaswork:playtestOnce turns a thrown service error into a plain failure', async () => {
  const ipc = fakeIpc();
  const original = console.error;
  console.error = () => {};
  try {
    registerPlaytestOnceIpc({ ipcMain: ipc, service: { run: async () => { throw new Error('x'); } } });
    assert.deepEqual(await ipc.invoke(CHANNEL, { projectId: 'game' }), { ok: false, reason: 'failed' });
  } finally {
    console.error = original;
  }
});
