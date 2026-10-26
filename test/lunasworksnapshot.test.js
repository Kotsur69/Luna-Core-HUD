// ============================================================================
// Luna's Work phone snapshot (LW 2.17b, src/lunasworksnapshot.js): its shape,
// local paths scrubbed, the size cap, the reader over `godmode` rows and the
// throttled publishing on phase changes.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const snap = require('../src/lunasworksnapshot.js');

const NOW = 1_800_000_000_000;
const REPO = 'C:\\Users\\mati\\code\\shop';
const THUMB = `data:image/jpeg;base64,${'A'.repeat(400)}`;

const status = (extra = {}) => ({
  active: true,
  runId: 'lwabc123',
  phase: 'playtesting',
  role: 'playtester',
  iteration: 4,
  milestone: 'Skeleton',
  verdict: null,
  wheel: 'running',
  startedAt: NOW - 3600_000,
  evidenceDir: `${REPO}\\.luna\\evidence`,
  scores: { Skeleton: [{ n: 1, score: 40 }, { n: 2, score: 55.4 }], '': [{ n: 3, score: 61 }] },
  pendingDecisions: [{ id: 7, kind: 'dependency', question: `Add lodash to ${REPO}\\package.json?`, options: ['approve', 'reject'] }],
  feedback: {
    runId: 'lwabc123',
    items: [
      { id: 1, text: 'Logo too big', status: 'planned' },
      { id: 2, text: 'see /home/mati/notes/todo.txt', status: 'new' },
    ],
  },
  ...extra,
});

const run = (extra = {}) => ({
  id: 'lwabc123',
  repoPath: REPO,
  usage: {
    total: { calls: 5, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.234 },
    byRole: {
      director: { calls: 2, inputTokens: 300, outputTokens: 100, costUsd: 0.4 },
      critic: { calls: 3, inputTokens: 700, outputTokens: 400, costUsd: 0.834 },
    },
  },
  laps: [
    { n: 1, cardsOpened: 3, cardsClosed: ['a', 'b'] },
    { n: 2, cardsOpened: 1, cardsClosed: ['c'] },
  ],
  ...extra,
});

const build = (extra = {}) =>
  snap.buildSnapshot({
    status: status(),
    run: run(),
    eta: { iterations: 3, hours: 2.5, low: 2, high: 4 },
    shots: [{ name: 'home', n: 2, src: THUMB }],
    now: NOW,
    ...extra,
  });

test('buildSnapshot: versioned shape with run status, scores, tokens, cards, decisions, feedback, eta, shots', () => {
  const s = build();
  assert.equal(s.v, snap.VERSION);
  assert.equal(s.at, NOW);
  assert.equal(s.runId, 'lwabc123');
  assert.equal(s.repoName, 'shop');
  assert.equal(s.active, true);
  assert.equal(s.phase, 'playtesting');
  assert.equal(s.role, 'playtester');
  assert.equal(s.iteration, 4);
  assert.equal(s.wheel, 'running');
  assert.deepEqual(s.scores, [
    { milestone: 'Skeleton', points: [{ n: 1, score: 40 }, { n: 2, score: 55 }] },
    { milestone: '', points: [{ n: 3, score: 61 }] },
  ]);
  assert.deepEqual(s.tokens, [
    { role: 'critic', tokens: 1100, costUsd: 0.83 },
    { role: 'director', tokens: 400, costUsd: 0.4 },
  ]);
  assert.deepEqual(s.total, { tokens: 1500, costUsd: 1.23 });
  assert.deepEqual(s.cards, { opened: 4, closed: 3 });
  assert.equal(s.decisions.length, 1);
  assert.equal(s.decisions[0].id, 7);
  assert.deepEqual(s.feedback.map((f) => f.status), ['planned', 'new']);
  assert.deepEqual(s.eta, { iterations: 3, hours: 2.5, low: 2, high: 4 });
  assert.deepEqual(s.shots, [{ name: 'home', n: 2, src: THUMB }]);
});

test('buildSnapshot: null without a run', () => {
  assert.equal(snap.buildSnapshot({ status: { active: false, runId: null }, run: null }), null);
  assert.equal(snap.buildSnapshot({ status: status(), run: null }), null);
  assert.equal(snap.buildSnapshot(), null);
});

test('buildSnapshot: local paths are scrubbed out of every string', () => {
  const s = build();
  const json = JSON.stringify(s);
  assert.ok(!json.includes('Users'), json);
  assert.ok(!json.includes('/home/mati'), json);
  assert.equal(s.decisions[0].question, 'Add lodash to package.json?');
  assert.equal(s.feedback[1].text, 'see todo.txt');
  // The reader scrubs too: a row written by another machine is not trusted.
  const read = snap.cleanSnapshot({ ...s, milestone: 'D:\\secret\\plan.md' }, NOW);
  assert.equal(read.milestone, 'plan.md');
});

test('cleanSnapshot: only small base64 image data URLs survive as thumbnails, at most 3', () => {
  const shots = [
    { name: 'a', n: 1, src: THUMB },
    { name: 'b', n: 1, src: 'https://evil.example/x.png' },
    { name: 'c', n: 1, src: 'data:text/html;base64,PHNjcmlwdD4=' },
    { name: 'd', n: 1, src: `data:image/png;base64,${'B'.repeat(30 * 1024)}` },
    { name: 'e', n: 1, src: THUMB },
    { name: 'f', n: 1, src: THUMB },
    { name: 'g', n: 1, src: THUMB },
  ];
  const s = build({ shots });
  assert.deepEqual(s.shots.map((x) => x.name), ['a', 'e', 'f']);
});

test('cleanSnapshot: refuses a wrong version or run id; bad fields fall back', () => {
  assert.equal(snap.cleanSnapshot({ v: 2, runId: 'lw1' }, NOW), null);
  assert.equal(snap.cleanSnapshot({ v: 1, runId: '../x' }, NOW), null);
  assert.equal(snap.cleanSnapshot('nope', NOW), null);
  const s = snap.cleanSnapshot(
    { v: 1, runId: 'lw1', at: NOW + 1e9, phase: '<b>', verdict: 'win', wheel: 'x', iteration: -3, eta: { iterations: 'many' } },
    NOW,
  );
  assert.equal(s.at, NOW);
  assert.equal(s.phase, null);
  assert.equal(s.verdict, null);
  assert.equal(s.wheel, 'running');
  assert.equal(s.iteration, 0);
  assert.equal(s.eta, null);
  assert.deepEqual(s.shots, []);
});

test('size cap: an oversized snapshot stays under MAX_BYTES with every list capped', () => {
  const big = `data:image/jpeg;base64,${'C'.repeat(23 * 1024)}`;
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, text: `item ${i} ${'x'.repeat(200)}`, status: 'new' }));
  const scores = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`M${i} ${'y'.repeat(200)}`, Array.from({ length: 20 }, (__, n) => ({ n: n + 1, score: 50 }))]),
  );
  const s = snap.buildSnapshot({
    status: status({ feedback: { runId: 'lwabc123', items }, scores }),
    run: run(),
    shots: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, n: 1, src: big })),
    now: NOW,
  });
  const bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
  assert.ok(bytes <= snap.MAX_BYTES, `${bytes}`);
  assert.ok(s.shots.length <= snap.MAX_SHOTS);
  assert.ok(s.feedback.length <= 20);
  assert.ok(s.scores.length <= 6);
  assert.ok(s.scores.every((m) => m.points.length <= 8));
});

test('size cap: thumbnails go first, the feedback stays when that is enough', () => {
  const fat = `data:image/jpeg;base64,${'E'.repeat(24 * 1024 - 30)}`;
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, text: 'w'.repeat(80), status: 'new' }));
  // Four fat thumbnails would be ~96 KB alone; only three are kept, and those
  // three plus the rest must be cut down to fit.
  const s = snap.buildSnapshot({
    status: status({ feedback: { runId: 'lwabc123', items } }),
    run: run(),
    shots: [1, 2, 3, 4].map((n) => ({ name: `s${n}`, n, src: fat })),
    now: NOW,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= snap.MAX_BYTES);
  assert.equal(s.feedback.length, 20);
  assert.ok(s.shots.length >= 1 && s.shots.length <= 3);
});

test('lunasworkFrom: the newest PC section, tagged with its machine; stale after STALE_MS', () => {
  const older = build({ now: NOW - 1000 });
  const newer = { ...build(), runId: 'lwnew' };
  const rows = [
    { machine: 'PC-A', data: { v: 1, lunaswork: older } },
    { machine: 'PC-B', data: { v: 1, lunaswork: newer } },
    { machine: 'bad machine!', data: { lunaswork: newer } },
    { machine: 'PC-C', data: { v: 1 } },
  ];
  const got = snap.lunasworkFrom(rows, NOW);
  assert.equal(got.machine, 'PC-B');
  assert.equal(got.runId, 'lwnew');
  assert.equal(got.stale, false);
  assert.equal(snap.lunasworkFrom(rows, NOW + snap.STALE_MS + 1).stale, true);
  assert.equal(snap.lunasworkFrom([], NOW), null);
  assert.equal(snap.lunasworkFrom(null, NOW), null);
});

/** Fake clock and timers for the throttle. */
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.done = true;
    },
    advance(ms) {
      t += ms;
      for (const timer of timers.filter((x) => !x.done && x.at <= t)) {
        timer.done = true;
        timer.fn();
      }
    },
    armed: () => timers.filter((x) => !x.done).length,
  };
}

test('throttle: the first phase change goes out at once, later ones as one trailing put', () => {
  const clock = fakeClock();
  const sent = [];
  let builds = 0;
  const th = snap.createSnapshotThrottle({
    publish: (s) => sent.push(s),
    minMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const at = (phase) => () => {
    builds += 1;
    return { v: 1, at: clock.now(), phase };
  };
  th.poke(at('directing'));
  assert.deepEqual(sent.map((s) => s.phase), ['directing']);
  clock.advance(100);
  th.poke(at('building'));
  th.poke(at('launching'));
  assert.equal(sent.length, 1);
  assert.equal(clock.armed(), 1);
  // Only the newest state is built - a skipped one never made thumbnails.
  clock.advance(900);
  assert.deepEqual(sent.map((s) => s.phase), ['directing', 'launching']);
  assert.equal(builds, 2);
  clock.advance(5000);
  th.poke(at('playtesting'));
  assert.deepEqual(sent.map((s) => s.phase), ['directing', 'launching', 'playtesting']);
});

test('throttle: identical content (only `at` moved) is not put again; errors only log', async () => {
  const clock = fakeClock();
  const sent = [];
  const logs = [];
  const th = snap.createSnapshotThrottle({
    publish: (s) => sent.push(s),
    minMs: 10,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (l) => logs.push(l),
  });
  th.poke(() => ({ v: 1, at: 1, phase: 'building' }));
  clock.advance(20);
  th.poke(() => ({ v: 1, at: 2, phase: 'building' }));
  assert.equal(sent.length, 1);
  clock.advance(20);
  th.poke(() => {
    throw new Error('boom');
  });
  assert.equal(logs.length, 1);
  const failing = snap.createSnapshotThrottle({ publish: () => Promise.reject(new Error('offline')), log: (l) => logs.push(l) });
  failing.poke(() => ({ v: 1, phase: 'x' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 2);
  th.poke('not a function');
});
