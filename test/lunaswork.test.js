// ============================================================================
// Luna's Work and the account reserve (src/accountreserve.js): a headless step
// that would start on an account past its reserve answers a usage limit whose
// resumeAt is the reserve window's reset. These tests follow that resumeAt
// from the gated runner (src/lunasworkWiring.js createHeadlessRunner) through
// the role wrappers (Director, Critic) into the run controller's limited()
// (src/lunaswork.js), so the wait ends at the real reset and the account
// failover is asked with it - not with a guessed +1 h.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLunasWork, FALLBACK_WAIT_MS } = require('../src/lunaswork');
const { createHeadlessRunner } = require('../src/lunasworkWiring');
const { runDirector } = require('../src/lunasworkDirector');
const { runCritic } = require('../src/lunasworkCritic');
const { accountReserveUntil } = require('../src/lunasworkReserveGate');
const { ACCOUNT_ENV } = require('../src/claudeaccounts');
const Pack = require('../src/lunasworkPack');
const { removeDir } = require('../test-support/under-load');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const RESERVE_RESET = NOW + 3 * HOUR;
const HELD = 'acct-held';
const RUN_TAG = 'run:lwreserve1';

const heldEnv = () => ({ PATH: 'x', [ACCOUNT_ENV]: HELD });

/** A fake execClaude that records anything it would have spawned. */
function noSpawn() {
  const calls = [];
  const exec = async (call) => {
    calls.push(call);
    return { stdout: '{}' };
  };
  return { calls, exec };
}

const gatedRunner = (exec) => createHeadlessRunner({
  exec,
  reserveUntil: (id) => (id === HELD ? RESERVE_RESET : null),
  now: () => NOW,
});

function packRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-reserve-'));
  assert.equal(Pack.scaffoldPack(dir).ok, true);
  return dir;
}

const card = (at) => ({ at, text: `card ${at}`, done: false, tags: [RUN_TAG, 'kind:feel', 'sev:medium'], size: 'S' });

// ---- accountReserveUntil: the dep main builds -----------------------------------

test('accountReserveUntil: the reserve reset for a held account, null for one without a reached cap', () => {
  const accounts = [
    { id: HELD, reserve: { fiveHour: 70 } },
    { id: 'acct-free', reserve: { fiveHour: 70 } },
    { id: 'acct-nocap' },
  ];
  const resetIso = new Date(RESERVE_RESET).toISOString();
  const readings = new Map([
    [HELD, [{ window: '5h', percentUsed: 72, resetsAt: resetIso }]],
    ['acct-free', [{ window: '5h', percentUsed: 40, resetsAt: resetIso }]],
    ['acct-nocap', [{ window: '5h', percentUsed: 99, resetsAt: resetIso }]],
  ]);
  assert.equal(accountReserveUntil(HELD, accounts, readings, NOW), RESERVE_RESET);
  assert.equal(accountReserveUntil('acct-free', accounts, readings, NOW), null);
  assert.equal(accountReserveUntil('acct-nocap', accounts, readings, NOW), null);
  assert.equal(accountReserveUntil('acct-unknown', accounts, readings, NOW), null);
  // The window already reset: its old reading no longer holds the account.
  assert.equal(accountReserveUntil(HELD, accounts, readings, RESERVE_RESET + 1), null);
});

// ---- role wrappers keep resumeAt -------------------------------------------------

test('the Director over the gated runner answers the limit with the reserve resumeAt', async () => {
  const fake = noSpawn();
  const repoDir = packRepo();
  try {
    const list = [card(1)];
    const res = await runDirector({
      repoDir, runId: 'lwreserve1', iteration: 2, env: heldEnv(), runClaude: gatedRunner(fake.exec), log: () => {},
      todoStore: { read: () => list, write: () => assert.fail('the Director must not write') },
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(res.error, 'limit');
    assert.equal(res.resumeAt, RESERVE_RESET);
  } finally {
    await removeDir(repoDir);
  }
});

test('the Critic over the gated runner answers the limit with the reserve resumeAt', async () => {
  const fake = noSpawn();
  const repoDir = packRepo();
  try {
    const list = [];
    const res = await runCritic({
      repoDir, runId: 'lwreserve1', iteration: 3, env: heldEnv(), runClaude: gatedRunner(fake.exec),
      report: { findings: [], scores: [], journeys: [], screens: [] },
      history: [], gitLog: '', log: () => {}, now: () => NOW,
      todoStore: { read: () => list, write: () => true },
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'limit');
    assert.equal(res.resumeAt, RESERVE_RESET);
  } finally {
    await removeDir(repoDir);
  }
});

// ---- the controller: resumeAt reaches limited() -----------------------------------

/** The run controller with in-memory deps; the Director is the real one over the gated runner. */
function controllerOn(repoDir, exec) {
  const asked = [];
  let stored = null;
  let todos = [card(1), card(2)];
  const runClaude = gatedRunner(exec);
  const deps = {
    store: { load: () => stored, save: (data) => { stored = data; return true; } },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'game' ? { id, repoPath: repoDir } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    confirmStart: async () => true,
    todoStore: () => ({ read: () => todos, write: (list) => { todos = list; return true; } }),
    director: (o) => runDirector({ ...o, env: heldEnv(), runClaude, log: () => {} }),
    build: async () => assert.fail('nothing is built while the Director waits'),
    createAdapter: () => assert.fail('no app is started'),
    playtest: async () => assert.fail('no playtest'),
    shipGate: () => ({ allPassed: false }),
    critic: async () => assert.fail('no critic'),
    gitLog: async () => '',
    syncCheckout: async () => ({ ok: true }),
    // A guessed reset: limited() must not use it when the answer names its own.
    limitResumeAt: () => NOW + HOUR,
    accountFailover: (resetsAt) => {
      asked.push(resetsAt);
      return false;
    },
    awake: { hold: () => {}, release: () => {} },
    newRunId: () => 'lwreserve1',
    now: () => NOW,
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  };
  return { ctl: createLunasWork(deps), asked };
}

test('a reserve-held Director step makes the run wait until the reserve reset, and failover is asked with it', async () => {
  const fake = noSpawn();
  const repoDir = packRepo();
  try {
    const h = controllerOn(repoDir, fake.exec);
    await h.ctl.start({ projectId: 'game' });
    for (let i = 0; i < 5; i += 1) await h.ctl.idle();
    assert.equal(fake.calls.length, 0, 'no claude -p was spawned on the held account');
    assert.deepEqual(h.asked, [RESERVE_RESET]);
    const status = h.ctl.status();
    assert.equal(status.waitReason, 'limit');
    assert.equal(status.waitUntil, RESERVE_RESET);
    assert.notEqual(status.waitUntil, NOW + FALLBACK_WAIT_MS);
  } finally {
    await removeDir(repoDir);
  }
});
