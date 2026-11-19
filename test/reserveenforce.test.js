// Tests for the reserve enforcer (src/reserveenforce.js).
//
// Why this file matters: an account's reserve cap (src/accountreserve.js) used
// to only grey the account out for NEW work. A tab or God Mode worker already
// running on it kept spending past the cap, because the limit handler only
// fires when the CLI itself hits the real wall. The enforcer is what makes a
// reached reserve stop running work the same way the real limit does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReserveEnforcer, ESC_ECHO_MS } = require('../src/reserveenforce');

const NOW = Date.parse('2026-11-19T10:00:00Z');
const RESET = NOW + 2 * 60 * 60 * 1000;

/** One account at 60% of its 5 h window with a 50% reserve, one without a cap. */
function fixture(overrides = {}) {
  const accounts = overrides.accounts || [
    { id: 'acc-a', reserve: { fiveHour: 50, weekly: null } },
    { id: 'acc-b', reserve: { fiveHour: null, weekly: null } },
  ];
  const readings = overrides.readings || new Map([
    ['acc-a', [{ window: '5h', percentUsed: 60, resetsAt: new Date(RESET).toISOString() }]],
    ['acc-b', [{ window: '5h', percentUsed: 99, resetsAt: new Date(RESET).toISOString() }]],
  ]);
  const sessions = overrides.sessions || [];
  const working = new Set(overrides.working || []);
  const hits = [];
  const enforcer = createReserveEnforcer({
    accounts: () => accounts,
    readings: () => readings,
    sessions: () => sessions,
    isWorking: (s) => working.has(s.id),
    onReserveHit: (session, until) => hits.push({ id: session.id, until }),
    now: () => NOW,
    log: () => {},
    ...(overrides.deps || {}),
  });
  return { enforcer, hits, sessions, working };
}

const tab = (id, accountId, extra = {}) => ({ id, accountId, alive: true, ownBackend: false, readOnly: false, ...extra });

test('a working tab on an account past its reserve is stopped like a real limit', () => {
  const { enforcer, hits } = fixture({ sessions: [tab('t1', 'acc-a')], working: ['t1'] });
  assert.equal(enforcer.sweep(), 1);
  assert.deepEqual(hits, [{ id: 't1', until: RESET }]);
});

test('an idle tab on a reserved account is left alone (no "continue" injected into it)', () => {
  const { enforcer, hits } = fixture({ sessions: [tab('t1', 'acc-a')], working: [] });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('an account without a cap is never stopped, even at 99%', () => {
  const { enforcer, hits } = fixture({ sessions: [tab('t2', 'acc-b')], working: ['t2'] });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('an account under its cap is not stopped', () => {
  const readings = new Map([['acc-a', [{ window: '5h', percentUsed: 49, resetsAt: new Date(RESET).toISOString() }]]]);
  const { enforcer, hits } = fixture({ readings, sessions: [tab('t1', 'acc-a')], working: ['t1'] });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('a reading whose window already reset no longer holds the account back', () => {
  const past = new Date(NOW - 1000).toISOString();
  const readings = new Map([['acc-a', [{ window: '5h', percentUsed: 80, resetsAt: past }]]]);
  const { enforcer, hits } = fixture({ readings, sessions: [tab('t1', 'acc-a')], working: ['t1'] });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('own-backend, read-only, dead and account-less tabs are skipped', () => {
  const sessions = [
    tab('own', 'acc-a', { ownBackend: true }),
    tab('ro', 'acc-a', { readOnly: true }),
    tab('dead', 'acc-a', { alive: false }),
    tab('none', null),
  ];
  const { enforcer, hits } = fixture({ sessions, working: sessions.map((s) => s.id) });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('only the sessions on the reserved account are stopped', () => {
  const sessions = [tab('t1', 'acc-a'), tab('t2', 'acc-b'), tab('t3', 'acc-a')];
  const { enforcer, hits } = fixture({ sessions, working: ['t1', 't2', 't3'] });
  assert.equal(enforcer.sweep(), 2);
  assert.deepEqual(hits.map((h) => h.id), ['t1', 't3']);
});

test('onTurnStart stops a turn that starts on a reserved account, without waiting for the next reading', () => {
  const s = tab('t1', 'acc-a');
  const { enforcer, hits } = fixture({ sessions: [s], working: [] });
  assert.equal(enforcer.onTurnStart(s), true);
  assert.deepEqual(hits, [{ id: 't1', until: RESET }]);
});

test('onTurnStart on a free account does nothing', () => {
  const s = tab('t2', 'acc-b');
  const { enforcer, hits } = fixture({ sessions: [s] });
  assert.equal(enforcer.onTurnStart(s), false);
  assert.deepEqual(hits, []);
});

test('no usage reading means no stop - an account is never blocked on data LunaCore does not have', () => {
  const { enforcer, hits } = fixture({ readings: new Map(), sessions: [tab('t1', 'acc-a')], working: ['t1'] });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
});

test('a throwing handler for one session does not stop the others, and is logged', () => {
  const lines = [];
  const sessions = [tab('t1', 'acc-a'), tab('t3', 'acc-a')];
  const seen = [];
  const { enforcer } = fixture({
    sessions,
    working: ['t1', 't3'],
    deps: {
      onReserveHit: (session) => {
        seen.push(session.id);
        if (session.id === 't1') throw new Error('boom');
      },
      log: (line) => lines.push(line),
    },
  });
  assert.equal(enforcer.sweep(), 1);
  assert.deepEqual(seen, ['t1', 't3']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /t1.*boom/);
});

test('the turn start right after an Esc stop is its interrupt echo - taken once, then gone', () => {
  const clock = { t: NOW };
  const { enforcer } = fixture({ deps: { now: () => clock.t } });
  assert.equal(enforcer.takeEscEcho('t1'), false, 'no stop, no echo');
  enforcer.noteEscStop('t1');
  clock.t += 200;
  assert.equal(enforcer.takeEscEcho('t1'), true, 'the interrupt entry is dropped');
  assert.equal(enforcer.takeEscEcho('t1'), false, 'the next turn start is a real one');
});

test('an echo window that ran out is not taken - a later real turn start is still checked', () => {
  const clock = { t: NOW };
  const { enforcer } = fixture({ deps: { now: () => clock.t } });
  enforcer.noteEscStop('t1');
  clock.t += ESC_ECHO_MS + 1;
  assert.equal(enforcer.takeEscEcho('t1'), false);
});

// ---- the real chain: store + reserve check + failover, wired like main.js ----

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaudeAccounts, ACCOUNT_ENV } = require('../src/claudeaccounts');
const { createTabFailover } = require('../src/claudefailover');
const { reserveLimits } = require('../src/accountreserve');
const { withAccountResume } = require('../src/launch');

const fakeToken = (ch) => ['sk', 'ant', 'oat01', ch.repeat(40)].join('-');
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

/**
 * Two accounts: "greg" at 74% of its 5 h window with a 70% reserve, "other"
 * at `otherPct`. The handler mirrors main's handleAccountLimit.
 */
function realChain(t, { otherPct = 10 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readings = new Map();
  const accounts = createClaudeAccounts({
    file: () => path.join(dir, 'claude-accounts.local.json'),
    safeStorage: fakeStorage,
    now: () => NOW,
    reserveLimits: (list, at) => reserveLimits(list, readings, at),
  });
  const greg = accounts.add('greg', fakeToken('g')).id;
  const other = accounts.add('other', fakeToken('o')).id;
  accounts.setReserve(greg, { fiveHour: 70 });
  const resetIso = new Date(RESET).toISOString();
  readings.set(greg, [{ window: '5h', percentUsed: 74, resetsAt: resetIso }]);
  readings.set(other, [{ window: '5h', percentUsed: otherPct, resetsAt: resetIso }]);

  const relaunches = [];
  const relaunch = (s) => {
    s.accountId = accounts.authLayer({ PATH: 'x' })[ACCOUNT_ENV] || null;
    relaunches.push(s.accountId);
  };
  const { failoverTab } = createTabFailover({
    accounts,
    getProfile: () => ({ command: 'claude', args: [] }),
    withAccountResume,
    restartSession: relaunch,
    send: () => {},
    now: () => NOW,
    defer: (fn) => fn(),
  });
  const stopped = [];
  // The session runs on greg (it started before the reading crossed 70%).
  const session = tab('w1', greg, { transcriptId: UUID, profileId: 'claude' });
  const enforcer = createReserveEnforcer({
    accounts: () => accounts.usageTargets(),
    readings: () => readings,
    sessions: () => [session],
    isWorking: () => true,
    onReserveHit: (s, until) => {
      if (failoverTab(s, until)) return;
      stopped.push({ id: s.id, until });
    },
    now: () => NOW,
  });
  return { accounts, greg, other, session, enforcer, relaunches, stopped };
}

test('greg at 74% with a 70% reserve: the running tab moves to the other account', (t) => {
  const c = realChain(t);
  assert.equal(c.enforcer.sweep(), 1);
  assert.deepEqual(c.relaunches, [c.other], 'restarted (--resume) on the other account');
  assert.equal(c.session.accountId, c.other);
  assert.deepEqual(c.stopped, []);
  // Now on the other account: the next reading pass leaves it alone.
  assert.equal(c.enforcer.sweep(), 0);
});

test('greg at 74% with a 70% reserve and no other account free: the tab is stopped until the reset', (t) => {
  const c = realChain(t, { otherPct: 100 });
  // "other" at 100% has no reserve, so only a real-limit cooldown marks it out.
  c.accounts.markLimited(c.other, RESET);
  assert.equal(c.enforcer.sweep(), 1);
  assert.deepEqual(c.relaunches, [], 'no account to move to');
  assert.deepEqual(c.stopped, [{ id: 'w1', until: RESET }]);
});

test('a broken account or readings source is logged and stops nothing, never throws', () => {
  const lines = [];
  const { enforcer, hits } = fixture({
    sessions: [tab('t1', 'acc-a')],
    working: ['t1'],
    deps: {
      accounts: () => { throw new Error('store unreadable'); },
      log: (line) => lines.push(line),
    },
  });
  assert.equal(enforcer.sweep(), 0);
  assert.deepEqual(hits, []);
  assert.match(lines[0], /store unreadable/);
});
