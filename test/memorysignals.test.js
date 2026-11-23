// ============================================================================
// LunaCore - review signals between PCs (src/memorysignals.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validSignals,
  collectSignals,
  publishSignals,
  createSignalsProvider,
  readPeers,
  setPeerSource,
  peerSignals,
  notWantedTitles,
  allDisputes,
  mergeReads,
  MAX_SIGNAL_BYTES,
  MAX_REJECTED,
  MAX_SIGNAL_TITLE,
  MIN_PUBLISH_MS,
  READS_PUBLISH_MS,
  REFRESH_MS,
} = require('../src/memorysignals.js');
const { recentUsage } = require('../src/memoryuse.js');
const { DAY_MS } = require('../src/memorylog.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/other';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const key = (id, project = PROJECT) => `${project}/${id}`;
// Built at run time so no secret-shaped literal sits in the repository.
const FAKE_KEY = ['sk', 'a'.repeat(24)].join('-');
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-signals-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path.join(dir, 'memory-signals.local.json');
}

const rejected = (id, title, at, project = PROJECT) => ({ ev: 'rejected', key: key(id, project), type: 'gotcha', title, at });

// ---- serialization ------------------------------------------------------------

test('collects rejections, open disputes, recent reads and settles from the log', () => {
  const events = [
    rejected('a', 'Old rejection', NOW - 5000),
    rejected('b', 'Newer rejection', NOW - 4000),
    rejected('c', 'Newer rejection', NOW - 3000), // same project and title: one entry
    { ev: 'disputed', key: key('wrong'), by: 'tool', note: 'the flag is gone', at: NOW - 2000 },
    { ev: 'disputed', key: key('settled'), by: 'tool', note: 'x', at: NOW - 2500 },
    { ev: 'verified', key: key('settled'), by: 'user', missing: [], at: NOW - 1500 },
    { ev: 'search', hits: [key('r1'), key('r2')], at: NOW - 1000 },
    { ev: 'get', key: key('r1'), at: NOW - 900 },
    // Older than the read window: not counted.
    { ev: 'get', key: key('r3'), at: NOW - 40 * DAY_MS },
  ];

  const s = collectSignals(events, NOW);

  assert.deepEqual(s, {
    at: NOW,
    rejected: [
      { project: PROJECT, title: 'Newer rejection', at: NOW - 3000 },
      { project: PROJECT, title: 'Old rejection', at: NOW - 5000 },
    ],
    disputes: [{ key: key('wrong'), note: 'the flag is gone', at: NOW - 2000 }],
    reads: { [key('r1')]: 2, [key('r2')]: 1 },
    settled: { [key('settled')]: NOW - 1500 },
  });
  // What goes out comes back unchanged through the peer validation.
  assert.deepEqual(validSignals(JSON.parse(JSON.stringify(s))), s);
});

test('keeps the last MAX_REJECTED rejections and cuts long titles', () => {
  const events = Array.from({ length: MAX_REJECTED + 10 }, (_, i) => rejected(`m${i}`, `Title ${i}`, NOW - 100000 + i));
  events.push(rejected('long', 'x'.repeat(500), NOW));
  const s = collectSignals(events, NOW);
  assert.ok(s.rejected.length <= MAX_REJECTED);
  assert.equal(s.rejected[0].title.length, MAX_SIGNAL_TITLE);
  assert.equal(s.rejected[1].title, `Title ${MAX_REJECTED + 9}`);
});

// ---- the 6 KB cap ---------------------------------------------------------------

test('a unit stays under MAX_SIGNAL_BYTES: low reads and old rejections go first, disputes stay', () => {
  const events = [];
  for (let i = 0; i < 60; i++) events.push(rejected(`r${i}`, `A rejected memory title number ${i} ${'y'.repeat(80)}`, NOW - 100000 + i));
  for (let i = 0; i < 5; i++) events.push({ ev: 'disputed', key: key(`d${i}`), by: 'tool', note: 'n'.repeat(150), at: NOW - 50000 + i });
  for (let i = 0; i < 150; i++) {
    for (let n = 0; n <= i % 7; n++) events.push({ ev: 'get', key: key(`read-memory-with-a-long-id-${i}`), at: NOW - 1000 });
  }

  const s = collectSignals(events, NOW);

  assert.ok(bytes(s) <= MAX_SIGNAL_BYTES, `${bytes(s)} bytes`);
  assert.equal(s.disputes.length, 5);
  assert.ok(s.rejected.length > 0 && s.rejected.length < 60);
  // The newest rejection survives, the oldest went.
  assert.match(s.rejected[0].title, /number 59/);
  const counts = Object.values(s.reads);
  assert.ok(counts.length > 0);
  // Every kept read count is at least as high as any dropped one would be: the highest (7) are kept.
  assert.equal(Math.max(...counts), 7);
  assert.ok(counts.every((n, i) => i === 0 || n <= counts[i - 1]));
});

test('a peer unit over the cap is trimmed on arrival, not taken whole', () => {
  const reads = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [key(`a-very-long-memory-identifier-${i}`), i + 1]));
  const rejectedList = Array.from({ length: 50 }, (_, i) => ({ project: PROJECT, title: `t${i} ${'z'.repeat(100)}`, at: NOW - i }));
  const s = validSignals({ at: NOW, rejected: rejectedList, disputes: [], reads, settled: {} });
  assert.ok(bytes(s) <= MAX_SIGNAL_BYTES);
  assert.equal(s.reads[key('a-very-long-memory-identifier-99')], 100);
});

// ---- secret scrubbing -----------------------------------------------------------

test('titles and notes are secret-scrubbed when published and when a peer sends them', () => {
  const events = [rejected('leak', `Use ${FAKE_KEY} here`, NOW - 10), { ev: 'disputed', key: key('w'), by: 'tool', note: `key ${FAKE_KEY}`, at: NOW - 5 }];
  const own = collectSignals(events, NOW);
  assert.ok(!JSON.stringify(own).includes(FAKE_KEY));
  assert.match(own.rejected[0].title, /^Use .+ here$/);

  const peer = validSignals({ at: NOW, rejected: [{ project: PROJECT, title: `t ${FAKE_KEY}`, at: 1 }], disputes: [{ key: key('w'), note: FAKE_KEY, at: 2 }] });
  assert.ok(!JSON.stringify(peer).includes(FAKE_KEY));
  assert.equal(peer.rejected.length, 1);
  assert.equal(peer.disputes.length, 1);
});

// ---- malformed peer payloads ----------------------------------------------------

test('a unit without a valid at is dropped whole, without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, [], { at: -1 }, { at: 1.5 }, { at: '1' }, { rejected: [] }]) {
    assert.equal(validSignals(bad), null, JSON.stringify(bad));
  }
});

test('malformed entries are dropped one by one, the rest is kept', () => {
  const s = validSignals({
    at: NOW,
    rejected: [
      { project: PROJECT, title: 'Good', at: 1 },
      { project: '../etc', title: 'bad project', at: 1 },
      { project: PROJECT, title: '', at: 1 },
      { project: PROJECT, title: 'x'.repeat(MAX_SIGNAL_TITLE + 1), at: 1 },
      { project: PROJECT, title: 42, at: 1 },
      { project: PROJECT, title: 'no at' },
      'not an object',
      null,
    ],
    disputes: [
      { key: key('ok'), note: 'fine', at: 2 },
      { key: 'no-slash', note: 'x', at: 2 },
      { key: key('bad-note'), note: { evil: true }, at: 2 },
      { key: key('neg'), note: 'x', at: -5 },
    ],
    // JSON.parse makes __proto__ an own key, as a cloud row would.
    reads: Object.assign(JSON.parse('{"__proto__": 5}'), { [key('ok')]: 3, 'not a key': 1, [key('zero')]: 0, [key('nan')]: Number.NaN, [key('frac')]: 1.5, [key('big')]: 1e9 }),
    settled: { [key('ok')]: 5, [key('neg')]: -1 },
    extra: 'ignored',
  });
  assert.deepEqual(s, {
    at: NOW,
    rejected: [{ project: PROJECT, title: 'Good', at: 1 }],
    disputes: [{ key: key('ok'), note: 'fine', at: 2 }],
    reads: { [key('ok')]: 3 },
    settled: { [key('ok')]: 5 },
  });
});

test('the provider takes only _signals/<machine> keys and validates their values', () => {
  const provider = createSignalsProvider('unused.json');
  assert.equal(provider.owns('_signals/pc-b'), true);
  assert.equal(provider.owns('_signals/../x'), false);
  assert.equal(provider.owns('_health/pc-b'), false);
  assert.equal(provider.valid('_signals/pc-b', { at: 'never' }), null);
  assert.deepEqual(provider.valid('_signals/pc-b', { at: 7 }), { at: 7, rejected: [], disputes: [], reads: {}, settled: {} });
});

test('a broken peer entry in the file is skipped; the file round-trips through the provider', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ machines: { 'pc-b': { at: 5, reads: { [key('x')]: 2 } }, 'bad name!': { at: 1 }, 'pc-c': 'garbage' } }));
  assert.deepEqual(readPeers(file, 'pc-a'), [{ machine: 'pc-b', at: 5, rejected: [], disputes: [], reads: { [key('x')]: 2 }, settled: {} }]);

  const provider = createSignalsProvider(file);
  const local = provider.read();
  assert.deepEqual(
    local.units.map(([k]) => k),
    ['_signals/pc-b'],
  );
  provider.write([['_signals/pc-d', validSignals({ at: 9 })]]);
  assert.deepEqual(
    readPeers(file, 'pc-a').map((p) => p.machine),
    ['pc-d'],
  );
});

// ---- multi-machine merge --------------------------------------------------------

const peer = (machine, over = {}) => ({ machine, at: NOW, rejected: [], disputes: [], reads: {}, settled: {}, ...over });

test('notWantedTitles merges this PC and the peers, newest first, for the project and global only', () => {
  const events = [rejected('a', 'Local old', NOW - 300), rejected('g', 'Global one', NOW - 100, 'global'), rejected('o', 'Other project', NOW - 50, OTHER)];
  const peers = [
    peer('pc-b', { rejected: [{ project: PROJECT, title: 'Peer newest', at: NOW - 10 }, { project: PROJECT, title: 'Local old', at: NOW - 5 }] }),
    peer('pc-c', { rejected: [{ project: OTHER, title: 'Peer other project', at: NOW }, { project: PROJECT, title: 'Peer middle', at: NOW - 200 }] }),
  ];

  assert.deepEqual(notWantedTitles(events, PROJECT, peers), ['Local old', 'Peer newest', 'Global one', 'Peer middle']);
  assert.deepEqual(notWantedTitles(events, PROJECT, peers, 2), ['Local old', 'Peer newest']);
  // No peers: this PC's titles alone, newest first (memorylog.rejectedTitles' order).
  assert.deepEqual(notWantedTitles(events, PROJECT, []), ['Global one', 'Local old']);
});

test('mergeReads adds every peer reads; a peer silent for longer than the window counts no more', () => {
  const local = new Map([[key('a'), 2]]);
  const peers = [peer('pc-b', { reads: { [key('a')]: 3, [key('b')]: 1 } }), peer('pc-c', { at: NOW - 31 * DAY_MS, reads: { [key('a')]: 50 } })];
  const merged = mergeReads(local, peers, { now: NOW });
  assert.deepEqual([...merged], [
    [key('a'), 5],
    [key('b'), 1],
  ]);
  // The input map is not changed.
  assert.equal(local.get(key('a')), 2);
});

test('allDisputes joins this PC and the peers; a user "still true" newer than a report settles it anywhere', () => {
  const events = [
    { ev: 'disputed', key: key('local'), by: 'tool', note: 'here', at: NOW - 100 },
    { ev: 'verified', key: key('peer-settled-here'), by: 'user', missing: [], at: NOW - 10 },
  ];
  const peers = [
    peer('pc-b', {
      disputes: [
        { key: key('remote'), note: 'there', at: NOW - 50 },
        { key: key('peer-settled-here'), note: 'old', at: NOW - 20 },
        { key: key('local'), note: 'older report', at: NOW - 200 },
        { key: key('settled-by-c'), note: 'x', at: NOW - 30 },
      ],
    }),
    peer('pc-c', { settled: { [key('settled-by-c')]: NOW - 25, [key('local')]: NOW - 500 } }),
  ];

  const open = allDisputes(events, peers);

  assert.deepEqual([...open.keys()].sort(), [key('local'), key('remote')]);
  assert.deepEqual(open.get(key('remote')), { at: NOW - 50, note: 'there', by: 'peer', machine: 'pc-b' });
  // This PC's own newer report wins over the peer's older one.
  assert.equal(open.get(key('local')).note, 'here');
});

// ---- the throttle ---------------------------------------------------------------

test('publishSignals writes when due: decisions after MIN_PUBLISH_MS, reads alone after READS_PUBLISH_MS, a refresh after REFRESH_MS', (t) => {
  const file = tmpFile(t);
  let events = [rejected('a', 'First', NOW - 10)];
  let collected = 0;
  const collect = (now) => () => {
    collected++;
    return collectSignals(events, now);
  };
  const at = () => readPeers(file, 'nobody').find((p) => p.machine === 'pc-a').at;

  assert.equal(publishSignals(file, 'pc-a', collect(NOW), NOW), true);
  // Too soon: the log is not even read.
  events = [...events, rejected('b', 'Second', NOW + 1)];
  assert.equal(publishSignals(file, 'pc-a', collect(NOW + 60_000), NOW + 60_000), false);
  assert.equal(collected, 1);
  // A new rejection after MIN_PUBLISH_MS goes out.
  const t1 = NOW + MIN_PUBLISH_MS;
  assert.equal(publishSignals(file, 'pc-a', collect(t1), t1), true);
  assert.equal(at(), t1);
  // Reads alone wait for READS_PUBLISH_MS.
  events = [...events, { ev: 'get', key: key('a'), at: t1 }];
  const t2 = t1 + 2 * MIN_PUBLISH_MS;
  assert.equal(publishSignals(file, 'pc-a', collect(t2), t2), false);
  const t3 = t1 + READS_PUBLISH_MS;
  assert.equal(publishSignals(file, 'pc-a', collect(t3), t3), true);
  // Nothing changed: silent until REFRESH_MS.
  assert.equal(publishSignals(file, 'pc-a', collect(t3 + MIN_PUBLISH_MS), t3 + MIN_PUBLISH_MS), false);
  assert.equal(publishSignals(file, 'pc-a', collect(t3 + REFRESH_MS), t3 + REFRESH_MS), true);
  // A bad machine name never writes.
  assert.equal(publishSignals(file, 'bad name', collect(NOW), NOW), false);
});

test('publishing keeps the other machines in the file', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ machines: { 'pc-b': { at: 3, rejected: [{ project: PROJECT, title: 'Theirs', at: 2 }] } } }));
  publishSignals(file, 'pc-a', () => collectSignals([rejected('m', 'Mine', NOW)], NOW), NOW);
  assert.deepEqual(
    readPeers(file, 'pc-a').map((p) => p.rejected[0].title),
    ['Theirs'],
  );
  assert.deepEqual(
    readPeers(file, 'pc-b').map((p) => p.rejected[0].title),
    ['Mine'],
  );
});

// ---- the registered source --------------------------------------------------------

test('peerSignals reads the registered source; a failing one yields none; recentUsage counts peer reads', (t) => {
  t.after(() => setPeerSource(null));
  assert.deepEqual(peerSignals(), []);

  setPeerSource(() => [peer('pc-b', { reads: { [key('a')]: 4 } })]);
  const events = [{ ev: 'get', key: key('a'), at: NOW - 1000 }];
  assert.equal(recentUsage(events, NOW).reads.get(key('a')), 5);
  // An explicit list wins over the source.
  assert.equal(recentUsage(events, NOW, []).reads.get(key('a')), 1);

  t.mock.method(console, 'error', () => {});
  setPeerSource(() => {
    throw new Error('disk gone');
  });
  assert.deepEqual(peerSignals(), []);
  assert.equal(recentUsage(events, NOW).reads.get(key('a')), 1);
});

// ---- after review: old settles, peer clocks, top reads, a broken file ---------------

test('a "still true" older than the window is still published while a peer holds that dispute open', () => {
  const old = NOW - 90 * DAY_MS;
  const events = [
    { ev: 'verified', key: key('kept'), by: 'user', missing: [], at: old },
    { ev: 'verified', key: key('dropped'), by: 'user', missing: [], at: old },
  ];
  const peers = [peer('pc-b', { disputes: [{ key: key('kept'), note: 'x', at: old - 1000 }, { key: key('dropped'), note: 'newer report', at: old + 1000 }] })];
  assert.deepEqual(collectSignals(events, NOW, peers).settled, { [key('kept')]: old });
  assert.deepEqual(collectSignals(events, NOW).settled, {});
});

test('readPeers drops units and entries stamped more than a day ahead of this clock', (t) => {
  const file = tmpFile(t);
  const ahead = NOW + 2 * DAY_MS;
  fs.writeFileSync(
    file,
    JSON.stringify({
      machines: {
        'pc-b': {
          at: NOW,
          rejected: [{ project: PROJECT, title: 'Future', at: ahead }, { project: PROJECT, title: 'Now', at: NOW }],
          disputes: [{ key: key('f'), note: '', at: ahead }],
          settled: { [key('f')]: ahead, [key('ok')]: NOW - 1 },
        },
        'pc-c': { at: ahead },
      },
    }),
  );
  const peers = readPeers(file, 'pc-a', NOW);
  assert.deepEqual(peers, [{ machine: 'pc-b', at: NOW, rejected: [{ project: PROJECT, title: 'Now', at: NOW }], disputes: [], reads: {}, settled: { [key('ok')]: NOW - 1 } }]);
});

test('the top reads are kept even when more than MAX_READS keys were read and the busiest come last', () => {
  const events = [];
  for (let i = 0; i < 250; i++) events.push({ ev: 'get', key: key(`k${i}`), at: NOW - 1000 });
  for (let n = 0; n < 3; n++) events.push({ ev: 'get', key: key('busy'), at: NOW - 500 });
  const s = collectSignals(events, NOW);
  assert.equal(Object.keys(s.reads)[0], key('busy'));
  assert.equal(s.reads[key('busy')], 3);
});

test('a signals file that does not parse is moved aside on the next publish', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{"machines": ');
  t.mock.method(console, 'error', () => {});
  assert.equal(publishSignals(file, 'pc-a', () => collectSignals([], NOW), NOW), true);
  assert.equal(fs.readFileSync(`${file}.broken`, 'utf8'), '{"machines": ');
  assert.deepEqual(
    readPeers(file, 'nobody').map((p) => p.machine),
    ['pc-a'],
  );
});

test('clearPeerSource removes only the source it was given', (t) => {
  const { clearPeerSource } = require('../src/memorysignals.js');
  t.after(() => setPeerSource(null));
  const first = () => [peer('pc-b')];
  const second = () => [peer('pc-c')];
  setPeerSource(first);
  setPeerSource(second);
  clearPeerSource(first);
  assert.deepEqual(
    peerSignals().map((p) => p.machine),
    ['pc-c'],
  );
  clearPeerSource(second);
  assert.deepEqual(peerSignals(), []);
});
