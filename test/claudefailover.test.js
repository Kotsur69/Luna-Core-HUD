// Tests for per-tab Claude account failover (src/claudefailover.js), run on the
// real account store (src/claudeaccounts.js) and the real resume command
// (src/launch.js withAccountResume).
//
// Why this file matters: failoverTab is what moves a limited tab to another
// subscription. A bug here either leaves every tab waiting out a limit while
// another account is free, sends a provider profile's traffic to Anthropic on
// a subscription token, or restarts a tab in a loop.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTabFailover, accountSwitchNotice, TAB_FAILOVER_MIN_GAP_MS } = require('../src/claudefailover');
const { createClaudeAccounts, failoverEligible, ACCOUNT_ENV } = require('../src/claudeaccounts');
const { withAccountResume } = require('../src/launch');

/** A fake setup-token, assembled at runtime so no secret-shaped literal sits in the source. */
const fakeToken = (ch) => ['sk', 'ant', 'oat01', ch.repeat(40)].join('-');
const TOKEN_A = fakeToken('a');
const TOKEN_B = fakeToken('b');
const UUID_1 = '123e4567-e89b-12d3-a456-426614174000';
const UUID_2 = '223e4567-e89b-12d3-a456-426614174000';

const PROFILES = {
  claude: { id: 'claude', command: 'claude', args: ['--model', 'opus'] },
  zai: { id: 'zai', command: 'claude', args: [], env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' } },
  owntoken: { id: 'owntoken', command: 'claude', args: [], env: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('c') } },
};

/** A reversible stand-in for Electron's safeStorage. */
const fakeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

/**
 * The real store plus failoverTab wired the way src/main.js wires it. The fake
 * restartSession does what launchSession does with accounts: builds the env
 * through the store's account layer, records the account and whether the tab
 * may fail over, and builds the resume command.
 */
function makeHarness({ lang = 'en' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-failover-'));
  const file = path.join(dir, 'claude-accounts.local.json');
  const clock = { now: 1_000_000 };
  const accounts = createClaudeAccounts({ file: () => file, safeStorage: fakeStorage, now: () => clock.now });
  const sessions = new Map();
  const launches = [];
  const sent = [];

  function launch(session) {
    const profile = PROFILES[session.profileId];
    const base = { PATH: 'x', ...(profile.env || {}) };
    const env = { ...base, ...accounts.authLayer(base) };
    session.accountId = env[ACCOUNT_ENV] || null;
    session.ownBackend = !failoverEligible(env);
    const baseCommand = [profile.command, ...(profile.args || [])].join(' ');
    const command = session.resumeId ? withAccountResume(baseCommand, session.resumeId, null) : baseCommand;
    if (session.resumeId) session.transcriptId = session.resumeId;
    launches.push({ sessionId: session.id, accountId: session.accountId, token: env.CLAUDE_CODE_OAUTH_TOKEN, command });
  }

  function openTab(id, profileId, transcriptId) {
    const session = { id, profileId, transcriptId: null, resumeId: null };
    launch(session);
    session.transcriptId = transcriptId;
    sessions.set(id, session);
    return session;
  }

  const { failoverTab } = createTabFailover({
    accounts,
    getProfile: (profileId) => PROFILES[profileId] || null,
    withAccountResume,
    restartSession: launch,
    send: (channel, payload) => sent.push({ channel, payload }),
    isCurrent: (session) => sessions.get(session.id) === session,
    lang: () => lang,
    now: () => clock.now,
    defer: (fn) => fn(),
  });

  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { accounts, clock, sessions, launches, sent, openTab, failoverTab, cleanup };
}

test('failoverTab: the tab moves to the free account and resumes the same conversation', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  const a = h.accounts.add('A', TOKEN_A).id;
  const b = h.accounts.add('B', TOKEN_B).id;
  const tab = h.openTab('s1', 'claude', UUID_1);
  assert.equal(tab.accountId, a);

  assert.equal(h.failoverTab(tab, h.clock.now + 5000), true);

  const relaunch = h.launches.at(-1);
  assert.equal(relaunch.sessionId, 's1');
  assert.equal(relaunch.accountId, b);
  assert.equal(relaunch.token, TOKEN_B);
  assert.ok(relaunch.command.endsWith(`--resume ${UUID_1}`), relaunch.command);
  assert.ok(relaunch.command.includes('--model opus'), 'the profile flags survive the switch');
  assert.equal(tab.accountId, b);
  assert.equal(tab.transcriptId, UUID_1, 'the conversation id is kept');
  assert.equal(tab.lastFailoverFrom, a);
  assert.equal(h.accounts.list().accounts[0].limitedUntil, h.clock.now + 5000);
  assert.deepEqual(h.sent, [{ channel: 'pty:data', payload: { sessionId: 's1', data: accountSwitchNotice('A', 'B', 'en') } }]);
});

test('failoverTab: a second worker on the same account moves too', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.accounts.add('A', TOKEN_A);
  const b = h.accounts.add('B', TOKEN_B).id;
  const one = h.openTab('s1', 'claude', UUID_1);
  const two = h.openTab('s2', 'claude', UUID_2);
  assert.equal(one.accountId, two.accountId);

  assert.equal(h.failoverTab(one, h.clock.now + 5000), true);
  // The second worker reports the same limit a moment later.
  h.clock.now += 1000;
  assert.equal(h.failoverTab(two, h.clock.now + 4000), true);

  assert.equal(one.accountId, b);
  assert.equal(two.accountId, b);
  assert.ok(h.launches.at(-1).command.endsWith(`--resume ${UUID_2}`));
});

test('failoverTab: every account limited returns false and leaves the tab alone', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  const a = h.accounts.add('A', TOKEN_A).id;
  const b = h.accounts.add('B', TOKEN_B).id;
  h.accounts.markLimited(a, h.clock.now + 9000);
  const tab = h.openTab('s1', 'claude', UUID_1);
  assert.equal(tab.accountId, b);
  const launchesBefore = h.launches.length;

  assert.equal(h.failoverTab(tab, h.clock.now + 5000), false);

  assert.equal(h.launches.length, launchesBefore, 'no restart');
  assert.equal(h.sent.length, 0);
  assert.equal(tab.resumeId, null);
  assert.equal(tab.lastFailoverAt, undefined);
  assert.equal(h.accounts.freeAccount(), null, 'B is cooling down now too');
});

test('failoverTab: provider-profile and explicit-token tabs stay put', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.accounts.add('A', TOKEN_A);
  h.accounts.add('B', TOKEN_B);
  const zai = h.openTab('s1', 'zai', UUID_1);
  const own = h.openTab('s2', 'owntoken', UUID_2);
  assert.equal(zai.ownBackend, true);
  assert.equal(own.ownBackend, true);
  const launchesBefore = h.launches.length;

  assert.equal(h.failoverTab(zai, h.clock.now + 5000), false);
  assert.equal(h.failoverTab(own, h.clock.now + 5000), false);

  assert.equal(h.launches.length, launchesBefore, 'no restart');
  assert.equal(h.sent.length, 0);
  assert.ok(h.accounts.list().accounts.every((acc) => acc.limitedUntil === null), 'no account was marked limited');
});

test('failoverTab: the same account failing twice within the gap returns false', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  const a = h.accounts.add('A', TOKEN_A).id;
  h.accounts.add('B', TOKEN_B);
  const tab = h.openTab('s1', 'claude', UUID_1);
  assert.equal(h.failoverTab(tab, h.clock.now + 5000), true);
  // The switch did not take: the tab is still reported on A (e.g. the resumed
  // process came back on the old account) and hits the limit again.
  tab.accountId = a;
  const launchesBefore = h.launches.length;

  h.clock.now += TAB_FAILOVER_MIN_GAP_MS - 1;
  assert.equal(h.failoverTab(tab, h.clock.now + 5000), false);
  assert.equal(h.launches.length, launchesBefore, 'no restart loop');

  // Once the gap has passed, a fresh failover is allowed again.
  h.clock.now += 1;
  assert.equal(h.failoverTab(tab, h.clock.now + 5000), true);
});

test('failoverTab: a tab started before accounts existed moves to the free account', (t) => {
  const h = makeHarness({ lang: 'pl' });
  t.after(h.cleanup);
  const tab = h.openTab('s1', 'claude', UUID_1);
  assert.equal(tab.accountId, null);
  const a = h.accounts.add('A', TOKEN_A).id;

  assert.equal(h.failoverTab(tab, null), true);

  assert.equal(tab.accountId, a);
  assert.equal(h.sent[0].payload.data, accountSwitchNotice('default login', 'A', 'pl'));
});

test('failoverTab: a tab closed before the deferred restart is not restarted', () => {
  const restarted = [];
  const deferred = [];
  const { failoverTab } = createTabFailover({
    accounts: { markLimited: () => ({ from: { label: 'A' }, switchTo: { id: 'b', label: 'B' } }) },
    getProfile: () => PROFILES.claude,
    withAccountResume,
    restartSession: (s) => restarted.push(s.id),
    send: () => restarted.push('send'),
    isCurrent: () => false,
    now: () => 1,
    defer: (fn) => deferred.push(fn),
  });
  const tab = { id: 's1', profileId: 'claude', accountId: 'a', transcriptId: UUID_1 };
  assert.equal(failoverTab(tab, null), true);
  assert.equal(restarted.length, 0, 'the restart waits for the deferred tick');
  deferred.forEach((fn) => fn());
  assert.deepEqual(restarted, []);
});

test('failoverTab: read-only, unpinned and non-resumable tabs stay put', (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  h.accounts.add('A', TOKEN_A);
  h.accounts.add('B', TOKEN_B);
  const phone = { ...h.openTab('s1', 'claude', UUID_1), readOnly: true };
  const unpinned = h.openTab('s2', 'claude', null);
  const unknownProfile = { ...h.openTab('s3', 'claude', UUID_2), profileId: 'gone' };
  assert.equal(h.failoverTab(phone, null), false);
  assert.equal(h.failoverTab(unpinned, null), false);
  assert.equal(h.failoverTab(unknownProfile, null), false);
  assert.equal(h.sent.length, 0);
});
