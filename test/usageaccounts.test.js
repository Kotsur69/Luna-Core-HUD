// ============================================================================
// Per-account Claude usage (src/usageaccounts.js, docs/CLAUDE_ACCOUNTS_PLAN.md
// Phase 2): the P0 probe and its 403 fallback to the rate-limit headers, the
// grouping and ordering the meter shows, the cooldown sync that lets a limit
// clear on its own, the UsageWatcher hook, and the renderer's view handling.
// The network is a fake - nothing here talks to Anthropic, and every token
// is synthetic.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAccountUsage,
  parseUsageBody,
  parseUnifiedHeaders,
  cooldownAction,
  groupAccountUsage,
  accountUsageView,
  withActiveAccount,
  constants,
} = require('../src/usageaccounts');
const { UsageWatcher } = require('../src/usage');
const { createClaudeAccounts } = require('../src/claudeaccounts');
const { createOrchestraRegistry } = require('../src/orchestraRegistry');
const { accountViewOf, accountMeterText } = require('../src/renderer/modules/usage.js');

const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A /api/oauth/usage body (utilization is a percent there). */
const usageBody = (five, week, fiveReset = T0 + 2 * H, weekReset = T0 + 3 * D) =>
  JSON.stringify({
    five_hour: { utilization: five, resets_at: iso(fiveReset) },
    seven_day: { utilization: week, resets_at: iso(weekReset) },
  });

/** anthropic-ratelimit-unified-* headers (utilization a 0..1 fraction, resets in epoch seconds). */
const unified = (five, week, extra = {}) => ({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': String(five),
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T0 + 2 * H) / 1000)),
  'anthropic-ratelimit-unified-7d-utilization': String(week),
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor((T0 + 3 * D) / 1000)),
  ...extra,
});

/** A fake api.anthropic.com: one handler per path, every call recorded. */
function fakeApi(handlers) {
  const calls = [];
  const request = async (req) => {
    calls.push({ method: req.method, path: req.path, token: req.token, body: req.body });
    const handler = handlers[req.path];
    const res = typeof handler === 'function' ? handler(req) : handler;
    return { status: 200, headers: {}, body: '', ...(res || {}) };
  };
  return { request, calls };
}

/** matitrampolin (preferred, limited by the CLI an hour ago) and onet (active). */
const twoAccounts = () => [
  { id: 'mati', label: 'matitrampolin', active: false, limitedUntil: T0 + H },
  { id: 'onet', label: 'onet', active: true, limitedUntil: null },
];

function setup(handlers, accounts = twoAccounts()) {
  let clock = T0;
  let list = accounts;
  const api = fakeApi(handlers);
  const events = { limits: [], clears: [], logs: [] };
  const usage = createAccountUsage({
    credentials: () => list.map((a) => ({ id: a.id, label: a.label, token: `tok-${a.id}` })),
    accounts: () => list,
    onLimit: (id, until) => events.limits.push([id, until]),
    onClear: (id) => events.clears.push(id),
    request: api.request,
    now: () => clock,
    log: (line) => events.logs.push(line),
  });
  return {
    usage,
    api,
    events,
    advance: (ms) => {
      clock += ms;
    },
    setAccounts: (next) => {
      list = next;
    },
  };
}

const PRIMARY = { providerId: 'claude', displayName: 'Claude', status: 'ok', limits: [], isFallback: false, updatedAt: T0 - MIN };

// ---- parsing -------------------------------------------------------------------------

test('parseUsageBody: percent windows with ISO resets; the wall is the UNROUNDED 100; junk is null', () => {
  const r = parseUsageBody(usageBody(34.4, 21));
  assert.deepEqual(r.windows['5h'], { pct: 34, resetsAt: iso(T0 + 2 * H), wall: false });
  assert.deepEqual(r.windows.weekly, { pct: 21, resetsAt: iso(T0 + 3 * D), wall: false });
  assert.deepEqual(r.extra, []);
  const almost = parseUsageBody(usageBody(99.6, 10));
  assert.deepEqual([almost.windows['5h'].pct, almost.windows['5h'].wall], [100, false], '99.6 % shows as 100 but is still usable');
  assert.equal(parseUsageBody(usageBody(100, 10)).windows['5h'].wall, true);
  assert.equal(parseUsageBody('not json'), null);
  assert.equal(parseUsageBody(JSON.stringify({ five_hour: null })), null);
  const opus = parseUsageBody(JSON.stringify({ five_hour: { utilization: 10 }, seven_day_opus: { utilization: 100, resets_at: iso(T0 + D) } }));
  assert.deepEqual(opus.extra, [{ pct: 100, resetsAt: iso(T0 + D), wall: true }], 'a wall outside the shown windows still counts');
});

test('parseUnifiedHeaders: fractions become percents, epoch-second resets become ISO, only "rejected" is the wall', () => {
  const r = parseUnifiedHeaders(unified(0.34, 0.58));
  assert.deepEqual(r.windows['5h'], { pct: 34, resetsAt: iso(T0 + 2 * H), wall: false });
  assert.deepEqual(r.windows.weekly, { pct: 58, resetsAt: iso(T0 + 3 * D), wall: false });
  assert.deepEqual(r.extra, []);
  const rejected = parseUnifiedHeaders(unified(0.97, 0.4, { 'anthropic-ratelimit-unified-5h-status': 'rejected' }));
  assert.deepEqual([rejected.windows['5h'].pct, rejected.windows['5h'].wall], [100, true]);
  const ambiguous = parseUnifiedHeaders(unified(1, 0.4));
  assert.equal(ambiguous.windows['5h'].wall, false, 'a bare "1" (fraction or percent?) is never the wall');
  const statusOnly = parseUnifiedHeaders({ 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-status': 'allowed_warning' });
  assert.equal(statusOnly.windows['5h'], null, 'no utilization and not rejected: no window to count as "under 90 %"');
  const overall = parseUnifiedHeaders({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(Math.floor((T0 + 4 * H) / 1000)),
  });
  assert.deepEqual(overall.extra, [{ pct: 100, resetsAt: iso(T0 + 4 * H), wall: true }]);
  assert.equal(parseUnifiedHeaders({ 'content-type': 'application/json' }), null);
  assert.equal(parseUnifiedHeaders(null), null);
});

// ---- decisions -------------------------------------------------------------------------

test('cooldownAction: a wall sets the REAL reset but never shortens a long cooldown; only its own cooldown is cleared', () => {
  const win = (pct, resetsAt) => ({ pct, resetsAt, wall: pct >= 100 });
  const reading = (five, week, fiveReset = iso(T0 + 2 * H)) => ({
    windows: { '5h': win(five, fiveReset), weekly: win(week, iso(T0 + 3 * D)) },
    extra: [],
  });
  assert.deepEqual(cooldownAction(reading(100, 40), T0 + H, T0), { type: 'limit', until: T0 + 2 * H });
  assert.deepEqual(cooldownAction(reading(100, 100), null, T0), { type: 'limit', until: T0 + 3 * D }, 'the weekly wall outlasts the 5 h one');
  assert.deepEqual(cooldownAction(reading(100, 40, iso(T0 + 25 * MIN)), T0 + H, T0), { type: 'limit', until: T0 + 25 * MIN }, "the CLI's one-hour guess may be shortened");
  assert.equal(cooldownAction(reading(100, 40), T0 + 3 * D, T0), null, 'a weekly cooldown is never cut to a 5 h reset');
  assert.deepEqual(cooldownAction(reading(100, 40), T0 + 2 * H + 20 * 1000, T0), { type: 'adopt', until: T0 + 2 * H + 20 * 1000 }, 'already that reset');
  assert.equal(cooldownAction(reading(100, 40, null), T0 + H, T0), null, 'no reset to go by: the CLI cooldown stands');

  assert.deepEqual(cooldownAction(reading(40, 30), T0 + H, T0, T0 + H), { type: 'clear' }, 'the cooldown this meter set: the window reset early');
  assert.equal(cooldownAction(reading(40, 30), T0 + H, T0), null, "the CLI's cooldown (a wall the meter may not see) runs to its own time");
  assert.equal(cooldownAction(reading(40, 30), T0 + 2 * H, T0, T0 + H), null, 'changed since the meter set it: not ours any more');
  assert.equal(cooldownAction(reading(92, 30), T0 + H, T0, T0 + H), null, 'still near the wall');
  assert.equal(cooldownAction(reading(40, 30), null, T0, T0 + H), null, 'nothing to clear');
  assert.equal(cooldownAction(reading(40, 30), T0 - MIN, T0, T0 - MIN), null, 'an expired cooldown is no cooldown');
});

test('groupAccountUsage: a 5-hour then a Weekly group; the active account first, then preference order', () => {
  const accounts = [
    { id: 'a', label: 'first', active: false, limitedUntil: T0 + H },
    { id: 'b', label: 'second', active: true, limitedUntil: null },
    { id: 'c', label: 'third', active: false, limitedUntil: null },
  ];
  const readings = {
    a: { windows: { '5h': { pct: 100, resetsAt: iso(T0 + H), wall: true }, weekly: { pct: 58, resetsAt: iso(T0 + 2 * D), wall: false } }, at: T0 },
    b: { windows: { '5h': { pct: 34, resetsAt: iso(T0 + 2 * H), wall: false }, weekly: { pct: 21, resetsAt: iso(T0 + 4 * D), wall: false } }, at: T0 },
  };
  const groups = groupAccountUsage(accounts, readings, T0);
  assert.deepEqual(groups.map((g) => g.window), ['5h', 'weekly']);
  assert.deepEqual(groups[0].rows.map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(groups[0].rows[0], { id: 'b', label: 'second', active: true, pct: 34, resetsAt: iso(T0 + 2 * H), limited: false });
  assert.equal(groups[0].rows[1].limited, true, 'at the wall: the reset shows in full colour');
  assert.equal(groups[1].rows[1].limited, false, 'its weekly window is not what limits it');
  assert.deepEqual(groups[0].rows[2], { id: 'c', label: 'third', active: false, pct: null, resetsAt: null, limited: false }, 'no reading yet: still a row');
  assert.equal(accountUsageView(accounts, {}, 'usage', T0), null, 'no reading at all: the meter as today');
  assert.equal(accountUsageView([], readings, 'usage', T0), null);
});

test('withActiveAccount: alerts and the phone follow the active account; stale or non-Claude reads stay as they were', () => {
  const accounts = twoAccounts();
  const readings = { onet: { windows: { '5h': { pct: 81, resetsAt: iso(T0 + H) }, weekly: null }, at: T0 } };
  const out = withActiveAccount({ ...PRIMARY, others: [] }, accounts, readings, T0 + MIN);
  assert.equal(out.limits.length, 1);
  assert.equal(out.limits[0].window, '5h');
  assert.equal(out.limits[0].percentUsed, 81);
  assert.equal(out.accountId, 'onet');
  assert.deepEqual(out.others, [], 'the rest of the payload is kept');
  assert.equal(withActiveAccount(PRIMARY, accounts, readings, T0 + constants.STALE_MS + MIN), PRIMARY);
  const glm = { providerId: 'glm', status: 'ok', limits: [] };
  assert.equal(withActiveAccount(glm, accounts, readings, T0), glm);
  assert.equal(withActiveAccount(PRIMARY, accounts.map((a) => ({ ...a, active: false })), readings, T0), PRIMARY);
});

// ---- the poller: probe, 'usage' mode, 403 fallback ---------------------------------------

test("probe 200: 'usage' mode - the active account's token probes, every account is polled, the wall corrects the cooldown", async () => {
  const s = setup({
    '/api/oauth/usage': (req) => (req.token === 'tok-onet'
      ? { body: usageBody(34, 21) }
      : { body: usageBody(100, 58, T0 + 65 * MIN) }),
  });
  assert.equal(await s.usage.tick(), true);
  assert.equal(s.usage.mode(), 'usage');
  assert.deepEqual(s.api.calls.map((c) => [c.method, c.path, c.token]), [
    ['GET', '/api/oauth/usage', 'tok-onet'],
    ['GET', '/api/oauth/usage', 'tok-mati'],
  ]);
  assert.deepEqual(s.events.limits, [['mati', T0 + 65 * MIN]], 'the guessed hour becomes the real reset');
  const out = s.usage.applyTo({ ...PRIMARY, others: [] });
  assert.equal(out.accounts.mode, 'usage');
  assert.deepEqual(out.accounts.groups[0].rows.map((r) => [r.label, r.pct, r.active, r.limited]), [
    ['onet', 34, true, false],
    ['matitrampolin', 100, false, true],
  ]);
  assert.equal(out.limits[0].percentUsed, 34, "the alerts read onet's numbers");
  assert.equal(JSON.stringify(out).includes('tok-'), false, 'no token in the payload');

  // Nothing is due yet: no request. After the interval, both again.
  await s.usage.tick();
  assert.equal(s.api.calls.length, 2);
  s.advance(constants.USAGE_EVERY_MS);
  await s.usage.tick();
  assert.equal(s.api.calls.length, 4);
});

test('probe 403: the rate-limit headers - free count_tokens first, no paid call when it carries them', async () => {
  const s = setup({
    '/api/oauth/usage': { status: 403 },
    '/v1/messages/count_tokens': (req) => ({
      headers: req.token === 'tok-mati'
        ? unified(1, 0.58, { 'anthropic-ratelimit-unified-5h-status': 'rejected' })
        : unified(0.34, 0.21),
    }),
  });
  await s.usage.tick();
  assert.equal(s.usage.mode(), 'headers');
  assert.ok(s.events.logs.some((l) => /refused a setup-token/.test(l)));
  assert.deepEqual(s.api.calls.map((c) => [c.path, c.token]), [
    ['/api/oauth/usage', 'tok-onet'],
    ['/api/oauth/usage', 'tok-mati'],
    ['/v1/messages/count_tokens', 'tok-mati'],
    ['/v1/messages/count_tokens', 'tok-onet'],
  ], 'two accounts refused before the mode is decided');
  assert.match(s.api.calls[2].body.system, /Claude Code/);
  assert.deepEqual(s.events.limits, [['mati', T0 + 2 * H]]);
  const rows = s.usage.applyTo(PRIMARY).accounts.groups[0].rows;
  assert.deepEqual(rows.map((r) => [r.id, r.pct]), [['onet', 34], ['mati', 100]]);
});

test('count_tokens without the headers: a 1-token Haiku call every 15 min, for the non-active account only', async () => {
  let messageAnswer = { headers: unified(0.5, 0.2) };
  const s = setup({
    '/api/oauth/usage': { status: 401 },
    '/v1/messages/count_tokens': { status: 200, headers: {} },
    '/v1/messages': () => messageAnswer,
  });
  await s.usage.tick();
  assert.deepEqual(s.api.calls.map((c) => [c.path, c.token]), [
    ['/api/oauth/usage', 'tok-onet'],
    ['/api/oauth/usage', 'tok-mati'],
    ['/v1/messages/count_tokens', 'tok-mati'],
    ['/v1/messages', 'tok-mati'],
  ], 'the active onet is never spent on a probe; count_tokens is not tried again after a clean 200');
  const body = s.api.calls[3].body;
  assert.equal(body.model, constants.PROBE_MODEL);
  assert.equal(body.max_tokens, 1);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(s.events.clears, [], "50 %, but the cooldown is the CLI's: it runs to its own time");

  s.advance(constants.HEADERS_EVERY_MS);
  await s.usage.tick();
  assert.equal(s.api.calls.length, 4, 'not before 15 min');

  // At the wall the answer is a 429 - with the headers, which is the reading.
  messageAnswer = {
    status: 429,
    headers: unified(1, 0.3, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected' }),
  };
  s.advance(constants.MESSAGE_EVERY_MS - constants.HEADERS_EVERY_MS);
  await s.usage.tick();
  assert.equal(s.api.calls.length, 5);
  assert.deepEqual(s.events.limits, [['mati', T0 + 2 * H]]);
});

test('probe: the active token refused but another answers -> usage mode; the refused one goes through headers', async () => {
  const s = setup({
    '/api/oauth/usage': (req) => (req.token === 'tok-onet' ? { status: 401 } : { body: usageBody(20, 10) }),
    '/v1/messages/count_tokens': { headers: unified(0.3, 0.1) },
  });
  await s.usage.tick();
  assert.equal(s.usage.mode(), 'usage', 'one revoked token does not decide for every account');
  assert.deepEqual(s.api.calls.map((c) => [c.path, c.token]), [
    ['/api/oauth/usage', 'tok-onet'],
    ['/api/oauth/usage', 'tok-mati'],
    ['/v1/messages/count_tokens', 'tok-onet'],
  ]);
});

test("'usage' mode: an account the endpoint refuses is read through its headers from then on", async () => {
  const s = setup({
    '/api/oauth/usage': (req) => (req.token === 'tok-onet' ? { body: usageBody(34, 21) } : { status: 403 }),
    '/v1/messages/count_tokens': { headers: unified(0.6, 0.4) },
  });
  await s.usage.tick();
  assert.equal(s.usage.mode(), 'usage');
  assert.deepEqual(s.api.calls.map((c) => [c.path, c.token]), [
    ['/api/oauth/usage', 'tok-onet'],
    ['/api/oauth/usage', 'tok-mati'],
    ['/v1/messages/count_tokens', 'tok-mati'],
  ]);
  assert.ok(s.events.logs.some((l) => /"matitrampolin": \/api\/oauth\/usage refused/.test(l)));
  s.advance(constants.HEADERS_EVERY_MS);
  await s.usage.tick();
  // Preference order: mati (headers now, no GET) before onet (still the usage endpoint).
  assert.deepEqual(s.api.calls.slice(3).map((c) => [c.path, c.token]), [
    ['/v1/messages/count_tokens', 'tok-mati'],
    ['/api/oauth/usage', 'tok-onet'],
  ]);
});

test('probe without a clear answer (network, 429, 5xx): tried again after its backoff, nothing else is read meanwhile', async () => {
  let answer = { status: 0 };
  const s = setup({ '/api/oauth/usage': () => answer });
  await s.usage.tick();
  assert.equal(s.usage.mode(), null);
  assert.equal(s.api.calls.length, 1);
  await s.usage.tick();
  assert.equal(s.api.calls.length, 1, 'a 15 s watcher heartbeat does not re-probe');
  answer = { status: 429, headers: { 'retry-after': '600' } };
  s.advance(constants.USAGE_EVERY_MS);
  await s.usage.tick();
  assert.equal(s.usage.mode(), null);
  assert.equal(s.api.calls.length, 2, 'the probe goes again, not the other accounts');
  s.advance(constants.USAGE_EVERY_MS);
  await s.usage.tick();
  assert.equal(s.api.calls.length, 2, 'Retry-After is honoured');
  assert.equal(s.usage.applyTo(PRIMARY).accounts, null, 'no reading: the meter stays as today');
  answer = { status: 200, body: usageBody(10, 10) };
  s.advance(10 * MIN);
  await s.usage.tick();
  assert.equal(s.usage.mode(), 'usage');
});

test('a 429 waits Retry-After; a removed account loses its row; no accounts keep the payload as it was', async () => {
  const s = setup({
    '/api/oauth/usage': (req) => (req.token === 'tok-mati'
      ? { status: 429, headers: { 'retry-after': '600' } }
      : { body: usageBody(34, 21) }),
  });
  await s.usage.tick();
  s.advance(constants.USAGE_EVERY_MS);
  await s.usage.tick();
  assert.deepEqual(s.api.calls.slice(2).map((c) => c.token), ['tok-onet'], 'mati waits its 10 minutes');
  assert.ok(s.events.logs.some((l) => /"matitrampolin": usage read failed \(status 429\)/.test(l)));

  s.setAccounts([{ id: 'onet', label: 'onet', active: true, limitedUntil: null }]);
  s.advance(constants.USAGE_EVERY_MS);
  await s.usage.tick();
  assert.deepEqual(s.usage.applyTo(PRIMARY).accounts.groups[0].rows.map((r) => r.id), ['onet']);

  s.setAccounts([]);
  await s.usage.tick();
  assert.deepEqual(s.usage.applyTo(PRIMARY), { ...PRIMARY, accounts: null });
});

test('refresh: every account is due again; a throwing source is logged, never thrown', async () => {
  const s = setup({ '/api/oauth/usage': { body: usageBody(20, 10) } });
  await s.usage.tick();
  await s.usage.refresh();
  assert.equal(s.api.calls.length, 4);
  const logs = [];
  const broken = createAccountUsage({
    credentials: () => {
      throw new Error('store locked');
    },
    accounts: () => [],
    onLimit: () => {},
    onClear: () => {},
    request: async () => ({ status: 200, headers: {}, body: '' }),
    log: (line) => logs.push(line),
  });
  assert.equal(await broken.tick(), false);
  assert.deepEqual(logs, ['accounts unreadable: store locked']);
});

// ---- cooldown sync, end to end: claudeAccounts + the God Mode registry -----------------------

const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};
const TOKEN_A = `sk-ant-oat01-${'a'.repeat(40)}`;
const TOKEN_B = `sk-ant-oat01-${'b'.repeat(40)}`;

test('cooldown sync: the meter moves the failover off a full account and back once its window reset', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-usage-accounts-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let clock = T0;
  let registry = null;
  const store = createClaudeAccounts({
    file: () => path.join(dir, 'claude-accounts.local.json'),
    safeStorage: () => fakeStorage,
    now: () => clock,
    extraLimits: () => registry.limitedAccounts(),
    onLimitCleared: (id) => registry.clearAccountLimit(id),
  });
  registry = createOrchestraRegistry({
    makeController: () => {
      throw new Error('no run in this test');
    },
    now: () => clock,
  });
  assert.equal(store.add('matitrampolin', TOKEN_A).ok, true);
  assert.equal(store.add('onet', TOKEN_B).ok, true);
  const [mati, onet] = store.list().accounts;

  // The CLI hit the wall without a reset: claudeaccounts + the registry guess an hour.
  store.markLimited(mati.id, null);
  registry.noteAccountLimit(mati.id, null);
  assert.equal(store.active().id, onet.id);

  let matiPct = 100;
  const usage = createAccountUsage({
    credentials: () => store.usageCredentials(),
    accounts: () => store.list().accounts,
    onLimit: (id, until) => {
      store.setLimit(id, until);
      registry.setAccountLimit(id, until);
    },
    onClear: (id) => store.clearLimit(id),
    request: async (req) => ({
      status: 200,
      headers: {},
      body: req.token === TOKEN_A ? usageBody(matiPct, 50, T0 + 25 * MIN) : usageBody(30, 20),
    }),
    now: () => clock,
  });
  await usage.tick();
  const real = T0 + 25 * MIN;
  assert.equal(store.list().accounts[0].limitedUntil, real, 'the guessed hour is now the real reset');
  assert.equal(registry.limitedAccounts()[mati.id], real, "God Mode's memory follows");
  assert.equal(store.active().id, onet.id);

  // The window reset: the next reading clears both, and work goes back to the preferred account.
  matiPct = 3;
  clock += constants.USAGE_EVERY_MS;
  await usage.tick();
  assert.equal(store.list().accounts[0].limitedUntil, null);
  assert.deepEqual(registry.limitedAccounts(), {});
  assert.equal(store.active().id, mati.id);
  assert.equal(JSON.stringify(store.list()).includes('sk-ant-'), false, 'the public list never carries a token');
});

test('claudeAccounts.setLimit: unknown account or a past time is refused; usageCredentials keeps preference order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-usage-accounts-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = createClaudeAccounts({ file: () => path.join(dir, 'claude-accounts.local.json'), safeStorage: () => fakeStorage, now: () => T0 });
  store.add('one', TOKEN_A);
  store.add('two', TOKEN_B);
  const [one] = store.list().accounts;
  assert.deepEqual(store.setLimit('nobody', T0 + H), { ok: false, error: 'notFound' });
  assert.deepEqual(store.setLimit(one.id, T0 - 1), { ok: false, error: 'badTime' });
  assert.deepEqual(store.setLimit(one.id, T0 + H), { ok: true });
  assert.equal(store.list().accounts[0].limitedUntil, T0 + H);
  assert.deepEqual(store.usageCredentials().map((c) => [c.label, c.token]), [['one', TOKEN_A], ['two', TOKEN_B]]);
});

// ---- the watcher hook ---------------------------------------------------------------------

test('UsageWatcher: with the hook every payload carries `accounts` and the refresh button re-reads them; without it nothing changes', async () => {
  const emitted = [];
  const watcher = new UsageWatcher((u) => emitted.push(u));
  watcher.fetchPrimary = async () => ({ ...PRIMARY });
  watcher.readOthers = async () => [];
  const seen = [];
  watcher.accountUsage = {
    tick: async () => seen.push('tick'),
    refresh: async () => seen.push('refresh'),
    applyTo: (u) => ({ ...u, accounts: null }),
  };
  await watcher.tick();
  await watcher.refresh();
  assert.deepEqual(seen, ['tick', 'refresh']);
  assert.ok(emitted.length >= 2);
  assert.ok(emitted.every((u) => Object.prototype.hasOwnProperty.call(u, 'accounts')));

  watcher.accountUsage.tick = async () => {
    throw new Error('network down');
  };
  await watcher.tick();
  assert.equal(emitted[emitted.length - 1].status, 'ok', 'a failing account pass never breaks the primary read');

  watcher.accountUsage = null;
  await watcher.refresh();
  assert.equal(Object.prototype.hasOwnProperty.call(emitted[emitted.length - 1], 'accounts'), false);
});

test('UsageWatcher: a hung account pass never freezes the meter - the primary read is emitted after the cap', async () => {
  const emitted = [];
  const watcher = new UsageWatcher((u) => emitted.push(u));
  watcher.fetchPrimary = async () => ({ ...PRIMARY });
  watcher.readOthers = async () => [];
  watcher.accountsWaitMs = 20;
  watcher.accountUsage = {
    tick: () => new Promise(() => {}), // never settles
    refresh: () => new Promise(() => {}),
    applyTo: (u) => ({ ...u, accounts: null }),
  };
  await watcher.tick();
  assert.equal(emitted.length, 1);
  assert.equal(watcher.busy, false, 'the next tick can run');
  await watcher.tick();
  assert.equal(emitted.length, 2);
});

// ---- the renderer's view handling --------------------------------------------------------

test('renderer accountViewOf: a payload without the field keeps the last view; null or junk means the meter as today', () => {
  const view = { mode: 'usage', updatedAt: T0, groups: [{ window: '5h', rows: [] }] };
  assert.equal(accountViewOf({ status: 'ok' }, view), view, "the refresh button's direct read");
  assert.deepEqual(accountViewOf({ accounts: view }, null), view);
  assert.equal(accountViewOf({ accounts: null }, view), null, 'accounts removed in Settings');
  assert.equal(accountViewOf({ accounts: { groups: 'x' } }, view), null);
  assert.equal(accountViewOf({ accounts: { groups: [{ window: 5 }] } }, view), null);
  assert.equal(accountViewOf(null, view), view);
});

test('renderer accountMeterText: percent, limited and the reset for screen readers', () => {
  const translate = (key, vars) => (key === 'usage.resetIn' ? `resets in ${vars.when}` : key);
  assert.equal(accountMeterText({ pct: 34, limited: false }, '2h 10m', translate), '34%, resets in 2h 10m');
  assert.equal(accountMeterText({ pct: 100, limited: true }, '1h 5m', translate), '100%, usage.accounts.limited, resets in 1h 5m');
  assert.equal(accountMeterText({ pct: null }, null, translate), 'usage.accounts.noData');
});
