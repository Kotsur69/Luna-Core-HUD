// ============================================================================
// LunaCore - YAZIO client for the Life dashboard (src/lifeyazio.js)
// ----------------------------------------------------------------------------
// No network, no keychain, no real config folder: fetch, safeStorage and the
// credential paths are all injected.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createYazio, parseLegacy, pickSummary, ymd } = require('../src/lifeyazio');

const NOW = new Date(2026, 9, 14, 1, 30).getTime(); // 01:30 local - the UTC trap hour

function summary(over = {}) {
  return {
    goals: {
      'energy.energy': 2200,
      'nutrient.protein': 150,
      'nutrient.fat': 70,
      'nutrient.carb': 250,
      'activity.step': 10000,
      water: 2500,
      'bodyvalue.weight': 80,
    },
    meals: {
      breakfast: { nutrients: { 'energy.energy': 500.4, 'nutrient.protein': 30, 'nutrient.fat': 10, 'nutrient.carb': 60 } },
      lunch: { nutrients: { 'energy.energy': 800, 'nutrient.protein': 50.6, 'nutrient.fat': 25, 'nutrient.carb': 90 } },
      dinner: { nutrients: {} },
      snack: { nutrients: { 'energy.energy': 150 } },
    },
    steps: 7421,
    water_intake: 1500,
    activity_energy: 312.7,
    user: { current_weight: 84.2, start_weight: 90 },
    ...over,
  };
}

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function fakeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`#${s}`),
    decryptString: (b) => b.toString().slice(1),
  };
}

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-yazio-'));
  return { credPath: path.join(dir, 'yazio-cred.local.json'), legacyPath: path.join(dir, 'yazio.local.json') };
}

/** A fake YAZIO API; `calls` records every URL, `handlers` override by path prefix. */
function fakeApi(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const p = url.replace('https://yzapi.yazio.com/v15', '');
    for (const [prefix, fn] of Object.entries(handlers)) if (p.startsWith(prefix)) return fn(p, init);
    if (p === '/oauth/token') return res(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    if (p.startsWith('/user/widgets/daily-summary')) return res(200, summary());
    if (p.startsWith('/user/bodyvalues/weight/last')) return res(200, { value: 84.2, date: '2026-10-12 07:00:00' });
    return res(404, null);
  };
  return { calls, fetchImpl };
}

function client(api, extra = {}) {
  return createYazio({ fetchImpl: api.fetchImpl, safeStorage: fakeStorage(), now: () => NOW, ...tmpPaths(), ...extra });
}

const CREDS = { email: 'mati@example.com', password: 'hunter2 with spaces' };
const tokenCalls = (api) => api.calls.filter((c) => c.url.endsWith('/oauth/token')).length;

test('ymd is the local calendar day, not the UTC one', () => {
  assert.equal(ymd(new Date(NOW)), '2026-10-14');
});

test('parseLegacy reads JSON or "email password", rejects junk', () => {
  assert.deepEqual(parseLegacy('{"email":"a@b.pl","password":"x"}'), { email: 'a@b.pl', password: 'x' });
  assert.deepEqual(parseLegacy('  a@b.pl  pass word \n'), { email: 'a@b.pl', password: 'pass word' });
  assert.equal(parseLegacy('no-at-sign pass'), null);
  assert.equal(parseLegacy('a@b.pl'), null);
  assert.equal(parseLegacy(42), null);
});

test('pickSummary sums the meals and rounds every number', () => {
  const s = pickSummary(summary());
  assert.equal(s.kcal, 1450);
  assert.equal(s.kcalGoal, 2200);
  assert.equal(s.protein, 81);
  assert.equal(s.fat, 35);
  assert.equal(s.carb, 150);
  assert.equal(s.activityKcal, 313);
  assert.equal(s.steps, 7421);
  assert.equal(s.stepsGoal, 10000);
  assert.equal(s.water, 1500);
  assert.equal(s.weight, 84.2);
  assert.equal(s.startWeight, 90);
  assert.equal(s.weightGoal, 80);
});

test('pickSummary answers api-changed when the core shape is gone', () => {
  for (const bad of [null, {}, summary({ goals: null }), summary({ meals: 'x' }), summary({ goals: {} })]) {
    assert.throws(() => pickSummary(bad), (e) => e.reason === 'api-changed');
  }
});

test('not connected: status false, body throws not-connected, no network', async () => {
  const api = fakeApi();
  const y = client(api);
  assert.deepEqual(y.status(), { connected: false });
  await assert.rejects(y.body(), (e) => e.reason === 'not-connected');
  assert.equal(api.calls.length, 0);
});

test('connect logs in, stores the login encrypted, then body reads 7 days + weight', async () => {
  const api = fakeApi();
  const paths = tmpPaths();
  const y = client(api, paths);
  assert.deepEqual(await y.connect(CREDS), { persisted: true });

  const stored = fs.readFileSync(paths.credPath, 'utf8');
  assert.ok(!stored.includes(CREDS.password), 'the password is never on disk in plain text');
  assert.equal(JSON.parse(stored).v, 1);

  const b = await y.body();
  assert.equal(b.date, '2026-10-14');
  assert.equal(b.history.length, 7);
  assert.equal(b.history[0].date, '2026-10-08');
  assert.equal(b.today.kcal, 1450);
  assert.deepEqual(b.lastWeighIn, { value: 84.2, date: '2026-10-12' });
  // One login only: connect's token is reused by every parallel call.
  assert.equal(tokenCalls(api), 1);
});

test('a fresh client reads the stored login back', async () => {
  const paths = tmpPaths();
  await client(fakeApi(), paths).connect(CREDS);
  const again = client(fakeApi(), paths);
  assert.deepEqual(again.status(), { connected: true });
  assert.equal((await again.body()).today.steps, 7421);
});

test('body is cached for 5 minutes unless forced', async () => {
  const api = fakeApi();
  const y = client(api);
  await y.connect(CREDS);
  await y.body();
  const n = api.calls.length;
  await y.body();
  assert.equal(api.calls.length, n);
  await y.body({ force: true });
  assert.ok(api.calls.length > n);
});

test('a wrong password answers bad-login and stores nothing', async () => {
  const paths = tmpPaths();
  const y = client(fakeApi({ '/oauth/token': () => res(400, { error: 'invalid_grant' }) }), paths);
  await assert.rejects(y.connect(CREDS), (e) => e.reason === 'bad-login');
  assert.equal(fs.existsSync(paths.credPath), false);
  assert.deepEqual(y.status(), { connected: false });
});

test('invalid credentials are refused before any request', async () => {
  const api = fakeApi();
  const y = client(api);
  await assert.rejects(y.connect({ email: 'nope', password: 'x' }), (e) => e.reason === 'bad-login');
  await assert.rejects(y.connect({ email: 'a@b.pl', password: '' }), (e) => e.reason === 'bad-login');
  assert.equal(api.calls.length, 0);
});

test('network failure, rate limit and a changed API map to fixed reasons', async () => {
  const cases = [
    [() => Promise.reject(new Error('ECONNRESET')), 'network'],
    [() => res(429, null), 'rate-limited'],
    [() => res(503, null), 'network'],
    [() => res(200, { nope: true }), 'api-changed'],
  ];
  for (const [handler, reason] of cases) {
    const y = client(fakeApi({ '/user/widgets': handler }));
    await y.connect(CREDS);
    await assert.rejects(y.body({ force: true }), (e) => e.reason === reason, reason);
  }
});

test('a revoked token gets one fresh login and one retry', async () => {
  let first = true;
  const api = fakeApi({
    '/user/widgets': () => {
      if (!first) return res(200, summary());
      first = false;
      return res(401, null);
    },
  });
  const y = client(api);
  await y.connect(CREDS);
  assert.equal((await y.body()).today.kcal, 1450);
  assert.equal(tokenCalls(api), 2);
});

test('the plaintext legacy file is imported, encrypted, then deleted', async () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.legacyPath, `${CREDS.email} ${CREDS.password}`);
  const y = client(fakeApi(), paths);
  assert.deepEqual(y.status(), { connected: true });
  await y.body();
  assert.equal(fs.existsSync(paths.legacyPath), false);
  assert.ok(fs.existsSync(paths.credPath));
});

test('the legacy file is kept when encryption is unavailable', async () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.legacyPath, `${CREDS.email} ${CREDS.password}`);
  const storage = { ...fakeStorage(), isEncryptionAvailable: () => false };
  const y = client(fakeApi(), { ...paths, safeStorage: storage });
  await y.body();
  assert.ok(fs.existsSync(paths.legacyPath), 'nothing else holds the login');
  assert.equal(fs.existsSync(paths.credPath), false);
});

test('connect without safeStorage works for the session but is not persisted', async () => {
  const paths = tmpPaths();
  const storage = { ...fakeStorage(), isEncryptionAvailable: () => false };
  const y = client(fakeApi(), { ...paths, safeStorage: storage });
  assert.deepEqual(await y.connect(CREDS), { persisted: false });
  assert.deepEqual(y.status(), { connected: true });
  assert.equal(fs.existsSync(paths.credPath), false);
});

test('disconnect forgets the login and removes both files', async () => {
  const paths = tmpPaths();
  const y = client(fakeApi(), paths);
  await y.connect(CREDS);
  fs.writeFileSync(paths.legacyPath, 'x@y.pl z');
  y.disconnect();
  assert.deepEqual(y.status(), { connected: false });
  assert.equal(fs.existsSync(paths.credPath), false);
  assert.equal(fs.existsSync(paths.legacyPath), false);
});

test('a failed fetch is not retried within 15 s, even when forced', async () => {
  let t = NOW;
  const api = fakeApi({ '/user/widgets': () => res(503, null) });
  const y = client(api, { now: () => t });
  await y.connect(CREDS);
  await assert.rejects(y.body({ force: true }), (e) => e.reason === 'network');
  const n = api.calls.length;
  await assert.rejects(y.body({ force: true }), (e) => e.reason === 'network');
  assert.equal(api.calls.length, n, 'answered from the last error, no new requests');
  t += 16 * 1000;
  await assert.rejects(y.body({ force: true }), (e) => e.reason === 'network');
  assert.ok(api.calls.length > n);
});

test('a stored login that stops working is never retried until reconnect', async () => {
  const paths = tmpPaths();
  await client(fakeApi(), paths).connect(CREDS);
  let t = NOW;
  const api = fakeApi({ '/oauth/token': () => res(401, null) });
  const y = client(api, { ...paths, now: () => t });
  await assert.rejects(y.body(), (e) => e.reason === 'bad-login');
  t += 60 * 60 * 1000;
  await assert.rejects(y.body({ force: true }), (e) => e.reason === 'bad-login');
  assert.equal(tokenCalls(api), 1, 'one password attempt only - no account lockout');
});

test('parallel 401s share one fresh login', async () => {
  let revoked = true;
  const api = fakeApi({
    '/user/widgets': () => (revoked ? res(401, null) : res(200, summary())),
    '/oauth/token': () => {
      revoked = false;
      return res(200, { access_token: 'tok2', refresh_token: 'r', expires_in: 3600 });
    },
  });
  const y = client(api);
  await y.connect(CREDS);
  revoked = true;
  await y.body();
  assert.equal(tokenCalls(api), 2, 'connect + exactly one re-login');
});

test('a fetch that finishes after disconnect does not come back', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const api = fakeApi({ '/user/bodyvalues': async () => (await gate, res(200, null)) });
  const y = client(api);
  await y.connect(CREDS);
  const pending = y.body().catch(() => null);
  y.disconnect();
  release();
  await pending;
  await y.connect(CREDS);
  const n = api.calls.length;
  await y.body();
  assert.ok(api.calls.length > n, 'the new login fetched fresh, the old answer was dropped');
});

test('a weigh-in date that is not a date is dropped', async () => {
  const y = client(fakeApi({ '/user/bodyvalues': () => res(200, { value: 80, date: '<b>x</b>' }) }));
  await y.connect(CREDS);
  assert.equal((await y.body()).lastWeighIn, null);
});
