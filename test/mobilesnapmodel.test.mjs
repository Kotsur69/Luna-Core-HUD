// Phone snapshot readers (mobile/src/snapmodel.js, phase 4c): what the phone
// shows from the PCs' `snapshots` rows must be exactly what a PC's own
// parsers accept, and nothing they would drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { snapRows, newsFrom, ledgerFrom, bodyFrom, usageFrom, MAX_PROJECTS } from '../mobile/src/snapmodel.js';

const require = createRequire(import.meta.url);
const { newsSnapshot } = require('../src/missionnews');
const { summarize } = require('../src/missionledgercalc');
const { mergeRates } = require('../src/ratecalc');
const { yazioSnapshot } = require('../src/lifeyaziopeers');
const { usageSnapshot } = require('../src/usagesnapshot');

const HOUR = 60 * 60 * 1000;
// A Wednesday noon, so Monday 00:00 local is two and a half days back.
const NOW = new Date(2026, 9, 21, 12).getTime();
const MONDAY = new Date(2026, 9, 19).getTime();
const RATES = mergeRates({ rates: [{ id: 'claude-opus-5-5', input: 4, output: 20 }] }, null);

const row = (machine, data, updatedAt = NOW - HOUR) => ({ machine, data, updatedAt });

const newsData = (at, url = 'https://example.com/a') =>
  newsSnapshot({
    at,
    lang: 'pl',
    briefing: ['Point one'],
    sections: [{ id: 's1', ok: true, label: 'Tech', platform: 'web', kind: 'topic', entries: [{ key: 'k1', title: 'A', published: null, url }, { key: 'k2', title: 'B', published: null, url: 'https://example.org/b' }] }],
    summaries: new Map([['s1', { summary: 'Sum', picks: ['k1'] }]]),
  });

test('snapRows clamps a far-future updated_at and drops rows without an object body', () => {
  const rows = snapRows(
    [
      { machine: 'PC-1', data: { v: 1 }, updated_at: new Date(NOW + 365 * 24 * HOUR).toISOString() },
      { machine: 'PC-2', data: [1], updated_at: new Date(NOW).toISOString() },
      { machine: 'PC-3', data: null, updated_at: 'x' },
    ],
    NOW,
  );
  assert.deepEqual(rows, [{ machine: 'PC-1', data: { v: 1 }, updatedAt: NOW }]);
});

test('newsFrom shows the newest briefing with its checked links and picks', () => {
  const r = newsFrom([row('PC-1', newsData(NOW - 5 * HOUR)), row('LAPTOP', newsData(NOW - HOUR))], NOW);
  assert.equal(r.machine, 'LAPTOP');
  assert.equal(r.at, NOW - HOUR);
  assert.deepEqual(r.briefing, ['Point one']);
  assert.deepEqual(r.sections[0].entries, [
    { title: 'A', published: null, url: 'https://example.com/a', pick: true },
    { title: 'B', published: null, url: 'https://example.org/b', pick: false },
  ]);
});

test('newsFrom drops links into the LAN and rows of another version', () => {
  const lan = newsData(NOW - HOUR, 'http://192.168.1.1/admin');
  assert.deepEqual(
    newsFrom([row('PC-1', lan)], NOW).sections[0].entries.map((e) => e.url),
    ['https://example.org/b'],
  );
  assert.equal(newsFrom([row('PC-1', { ...newsData(NOW), v: 2 })], NOW), null);
  assert.equal(newsFrom([], NOW), null);
});

const ledgerRow = (hour, key, tokens) => [hour, key, key.slice(4), 'claude-opus-5-5', tokens, 0, 0, 0];

test('ledgerFrom prices every PC this week with the PC maths, keeping the newer copy per machine', () => {
  const pc1 = { v: 1, machine: 'PC-1', rows: [ledgerRow(NOW - 2 * HOUR, 'git:x/a', 1e6), ledgerRow(MONDAY - 2 * HOUR, 'git:x/a', 9e6)] };
  const old = { v: 1, machine: 'pc-1', rows: [ledgerRow(NOW - 3 * HOUR, 'git:x/z', 5e6)] };
  const lap = { v: 1, machine: 'LAP', rows: [ledgerRow(NOW - HOUR, 'git:x/b', 3e6)] };
  const l = ledgerFrom([row('PC-1', pc1, NOW - HOUR), row('pc-1', old, NOW - 5 * HOUR), row('LAP', lap)], NOW, RATES);
  const expected = summarize([...pc1.rows, ...lap.rows], { sinceMs: MONDAY, untilMs: NOW + 1, rates: RATES });
  assert.equal(l.sinceMs, MONDAY);
  assert.equal(l.totalUsd, expected.totalUsd);
  assert.equal(l.totalUsd, 16);
  assert.deepEqual(l.projects.map((p) => p.key), ['git:x/b', 'git:x/a']);
  assert.deepEqual(l.machines.map((m) => m.machine).sort(), ['LAP', 'PC-1']);
});

test('ledgerFrom drops a body that claims another machine, and caps the project list', () => {
  const liar = { v: 1, machine: 'OTHER', rows: [ledgerRow(NOW - HOUR, 'git:x/a', 1e6)] };
  assert.equal(ledgerFrom([row('PC-1', liar)], NOW, RATES).machines.length, 0);
  const many = { v: 1, machine: 'PC-1', rows: Array.from({ length: MAX_PROJECTS + 3 }, (_, i) => ledgerRow(NOW - HOUR, `git:x/p${i}`, 1e3)) };
  const l = ledgerFrom([row('PC-1', many)], NOW, RATES);
  assert.equal(l.projects.length, MAX_PROJECTS);
  assert.equal(l.moreProjects, 3);
});

const body = (fetchedAt, kcal = 1500) => ({
  date: '2026-10-21',
  fetchedAt,
  today: { kcal, kcalGoal: 2200, activityKcal: 300, protein: 90, proteinGoal: 140, fat: 50, fatGoal: 70, carb: 150, carbGoal: 250, steps: 8000, stepsGoal: 10000, water: 1500, waterGoal: 2500, weight: 82.4, startWeight: 90, weightGoal: 78 },
  history: [{ date: '2026-10-20', kcal: 2100, kcalGoal: 2200, protein: 120, steps: 9000 }],
  lastWeighIn: { value: 82.4, date: '2026-10-20' },
});

test('bodyFrom takes the most recently fetched valid copy and drops broken ones', () => {
  const rows = [row('PC-1', yazioSnapshot(body(NOW - 3 * HOUR, 1000), NOW)), row('LAP', yazioSnapshot(body(NOW - HOUR, 1800), NOW)), row('BAD', { v: 1, body: { ...body(NOW), today: { kcal: -5 } } })];
  const b = bodyFrom(rows, NOW);
  assert.equal(b.machine, 'LAP');
  assert.equal(b.body.today.kcal, 1800);
  assert.equal(bodyFrom([rows[2]], NOW), null);
});

test('mergeRates: the override wins by id, bad entries are skipped', () => {
  const r = mergeRates({ rates: [{ id: 'a', input: 1, output: 2 }, { id: 'b', input: -1, output: 2 }], cacheReadMultiplier: 0.2 }, { rates: [{ id: 'a', input: 3, output: 4 }] });
  assert.deepEqual(r, { rates: [{ id: 'a', input: 3, output: 4 }], cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.25 });
});

test('isPublicHost refuses trailing-dot local names, CGNAT, multicast and v4-in-v6 forms', () => {
  const { isPublicHost } = require('../src/missionnewsrows');
  for (const url of ['http://localhost./x', 'http://nas.local./', 'http://100.100.1.1/', 'http://224.0.0.1/', 'http://198.18.0.1/', 'http://[::127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://[64:ff9b::a00:1]/']) {
    assert.equal(isPublicHost(url), false, url);
  }
  for (const url of ['https://example.com/', 'https://100.200.1.1/', 'https://[2606:4700::1111]/']) {
    assert.equal(isPublicHost(url), true, url);
  }
});

test('usageFrom shows the newest PC read, a passed reset as empty', () => {
  const read = (updatedAt, resetIn) => ({
    providerId: 'claude',
    status: 'ok',
    updatedAt,
    limits: [
      { window: '5h', percentUsed: 70, resetsAt: new Date(NOW + resetIn).toISOString() },
      { window: 'weekly', percentUsed: 30, resetsAt: new Date(NOW + 48 * HOUR).toISOString() },
    ],
  });
  const u = usageFrom([row('OLD', usageSnapshot(read(NOW - 2 * HOUR, HOUR), NOW)), row('NEW', usageSnapshot(read(NOW - HOUR, -1), NOW))], NOW);
  assert.equal(u.machine, 'NEW');
  assert.deepEqual(u.fiveHour, { pct: 0, resetsAt: null, isReset: true });
  assert.equal(u.sevenDay.pct, 30);
  assert.equal(usageFrom([], NOW), null);
});
