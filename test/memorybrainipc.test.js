// ============================================================================
// LunaCore - memory window IPC for all memories, the scan, conflicts and the
// archive (src/memorybrainipc.js), its preload bridge, renderer and wiring
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerMemoryBrainIpc } = require('../src/memorybrainipc.js');
const { registerMemoryIpc } = require('../src/memoryipc.js');
const { createScanner } = require('../src/memoryscan.js');
const { writeRecord, scan } = require('../src/memorystore.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const NOW = Date.parse('2026-11-13T12:00:00Z');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function setup(t, records, { run = async () => ({ ok: false, reason: 'no-claude' }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brainipc-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of records) writeRecord(dir, r);
  const handlers = {};
  let changed = 0;
  const ipcMain = { handle: (channel, fn) => (handlers[channel] = fn) };
  const scanner = createScanner({ dir: () => dir, run, now: () => NOW });
  registerMemoryBrainIpc({ ipcMain, dir: () => dir, scanner, enabled: () => [OTHER], onChanged: () => changed++, now: () => NOW });
  registerMemoryIpc({ ipcMain, dir: () => dir, now: () => NOW });
  return { dir, scanner, invoke: (channel, arg) => handlers[channel]({}, arg), changed: () => changed, stored: () => Object.fromEntries(scan(dir).records) };
}

test('memory:list shows one project, the most useful first, never scanned next, the archive last', (t) => {
  const s = setup(t, [
    rec('low', { usefulness: 10 }),
    rec('none'),
    rec('high', { usefulness: 90, usefulness_note: 'Saves a day.' }),
    rec('cold', { usefulness: 0, archived: '2026-10-01' }),
    rec('old'),
    rec('new', { supersedes: ['old'] }),
    rec('q', { project: OTHER }),
  ]);
  const res = s.invoke('memory:list', PROJECT);
  assert.equal(res.ok, true);
  assert.equal(res.project, PROJECT);
  assert.deepEqual(res.items.map((i) => i.id), ['high', 'low', 'new', 'none', 'cold']);
  assert.equal(res.items[0].usefulness_note, 'Saves a day.');
  assert.equal(res.items[4].archived, '2026-10-01');
  assert.equal(res.items.some((i) => i.id === 'old'), false, 'a superseded memory is history');
  // Projects with memory switched on come first.
  assert.deepEqual(res.projects.map((p) => [p.project, p.enabled]), [[OTHER, true], [PROJECT, false]]);
  assert.equal(res.scan.running, false);
});

test('memory:list picks the first project for an unknown or malformed one', (t) => {
  const s = setup(t, [rec('a'), rec('q', { project: OTHER })]);
  for (const bad of [undefined, 42, { project: PROJECT }, '../../etc', 'github.com/acme/nothing-here']) {
    assert.equal(s.invoke('memory:list', bad).project, OTHER, String(bad));
  }
});

test('memory:scan checks the project and allows one scan at a time', async (t) => {
  let release;
  const s = setup(t, [rec('a')], {
    run: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, answer: { scores: [{ id: 'a', score: 77, reason: 'Handy.' }] } });
    }),
  });
  assert.deepEqual(s.invoke('memory:scan', { project: PROJECT }), { ok: false, reason: 'bad-project' });
  assert.deepEqual(s.invoke('memory:scan', 'C:\\Windows'), { ok: false, reason: 'bad-project' });
  assert.deepEqual(s.invoke('memory:scan', PROJECT), { ok: true, total: 1 });
  assert.deepEqual(s.invoke('memory:scan', PROJECT), { ok: false, reason: 'busy' });
  assert.equal(s.invoke('memory:list', PROJECT).scan.running, true);
  release();
  await s.scanner.whenIdle();
  const after = s.invoke('memory:list', PROJECT);
  assert.equal(after.items[0].usefulness, 77);
  assert.equal(after.scan.scored, 1);
});

test('memory:conflict validates its payload and settles a listed pair', (t) => {
  const s = setup(t, [
    rec('no-junction', { title: 'Do not create node_modules junctions for worktrees' }),
    rec('junction', { title: 'Create node_modules junctions for worktrees' }),
  ]);
  const a = `${PROJECT}/no-junction`;
  const b = `${PROJECT}/junction`;
  assert.deepEqual(s.invoke('memory:conflict', null), { ok: false, reason: 'bad-request' });
  assert.deepEqual(s.invoke('memory:conflict', [a, b, 'a']), { ok: false, reason: 'bad-request' });
  assert.deepEqual(s.invoke('memory:conflict', { a: '../x', b, keep: 'a' }), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:conflict', { a: 'x'.repeat(500), b, keep: 'a' }), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:conflict', { a, b, keep: 'delete' }), { ok: false, reason: 'bad-keep' });
  assert.equal(s.changed(), 0);

  assert.equal(s.invoke('memory:inbox').conflicts.total, 1, 'the inbox lists the conflict');
  assert.equal(s.invoke('memory:conflict', { a, b, keep: 'a' }).ok, true);
  assert.equal(s.changed(), 1);
  assert.deepEqual(s.stored()[a].supersedes, ['junction']);
  assert.equal(s.invoke('memory:inbox').conflicts.total, 0);
});

test('memory:restore brings back only an archived memory', (t) => {
  const s = setup(t, [rec('cold', { usefulness: 0, archived: '2026-10-01' }), rec('warm')]);
  assert.deepEqual(s.invoke('memory:restore', 7), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:restore', `${PROJECT}/warm`), { ok: false, reason: 'not-archived' });
  assert.equal(s.changed(), 0);
  assert.deepEqual(s.invoke('memory:restore', `${PROJECT}/cold`), { ok: true, key: `${PROJECT}/cold` });
  assert.equal(s.stored()[`${PROJECT}/cold`].archived, undefined);
  assert.equal(s.changed(), 1);
});

test('a failing mirror is a refusal, never a throw to the renderer', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const handlers = {};
  registerMemoryBrainIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => {
      throw new Error('gone');
    },
    scanner: { start: () => ({ ok: true }), status: () => ({}) },
  });
  assert.deepEqual(handlers['memory:list']({}, PROJECT), { ok: false, reason: 'failed' });
  assert.deepEqual(handlers['memory:restore']({}, `${PROJECT}/a`), { ok: false, reason: 'failed' });
  assert.ok(quiet.mock.callCount() >= 2);
});

test('preload exposes each new channel as one narrow function, strings only', () => {
  const preload = read('src/preload.js');
  for (const [fn, channel] of [
    ['memoryList', 'memory:list'],
    ['memoryScan', 'memory:scan'],
    ['memoryConflictResolve', 'memory:conflict'],
    ['memoryRestore', 'memory:restore'],
  ]) {
    assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `${channel} is missing in preload`);
  }
  assert.doesNotMatch(preload, /invoke\(\s*channel/, 'no generic invoke');
});

test('the renderer uses only what preload exposes and never writes markup', () => {
  const preload = read('src/preload.js');
  const inbox = read('src/renderer/modules/memoryinbox.js');
  const brain = read('src/renderer/modules/memorybrain.js');
  assert.doesNotMatch(brain, /innerHTML|outerHTML|insertAdjacentHTML/);
  for (const fn of ['memoryList', 'memoryScan', 'memoryConflictResolve', 'memoryRestore']) {
    assert.ok(inbox.includes(`'${fn}'`), `${fn} is not used by the window`);
    assert.match(preload, new RegExp(`\\b${fn}:`));
  }
});

test('every new memory string exists in Polish and English, Polish without diacritics', () => {
  const i18n = read('src/renderer/i18n.js');
  const brain = read('src/renderer/modules/memorybrain.js');
  const keys = new Set([...brain.matchAll(/'(mem\.brain\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 20);
  for (const key of [...keys, 'mem.inbox.tab.all']) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
});

test('the new styles use theme tokens only', () => {
  const rules = read('src/renderer/styles.css')
    .split('\n')
    .filter((l) => l.includes('.mem-brain'));
  assert.ok(rules.length >= 5);
  for (const rule of rules) assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgb\(/, rule);
});

test('main wires the scan to Sonnet, the decay timer, references and God Mode briefs', () => {
  const main = read('src/main.js');
  assert.match(main, /registerMemoryBrainIpc\(/);
  assert.match(main, /model: MEMORY_SCAN_MODEL/);
  assert.match(main, /memoryDecay\.start\(\)/);
  assert.match(main, /memoryDecay\.stop\(\)/);
  assert.match(main, /memoryReferences\.fromEvent\(event\)/);
  assert.match(main, /projectMemory: \(repoPath, pkg\) => memoryInjector\(repoPath, pkg\)/);
  assert.match(main, /memoryConflictCount\(dir\)/);
  assert.match(read('src/orchestraWiring.js'), /projectMemory: \(repoPath, pkg\) =>/);
});

// ---- final score and memory health in the list of all memories -----------------------

const { projectHealth, HEALTH_WEIGHT_PCT, BACKLOG_DAYS } = require('../src/memorybrainipc.js');

test('projectHealth: fixed inputs give a fixed score, every part counted', () => {
  assert.equal(Object.values(HEALTH_WEIGHT_PCT).reduce((a, b) => a + b, 0), 100);
  const item = (key, usefulness, score, over = {}) => ({ key, usefulness, final: { score }, confidence: 'confirmed', created: '2026-11-01', archived: null, ...over });
  const items = [
    item('p/a', 80, 80),
    item('p/b', 60, 60),
    item('p/c', null, null),
    item('p/d', 40, 40, { confidence: 'observed' }), // waiting 13 days: backlog
    item('p/e', null, null, { confidence: 'observed', created: '2026-11-12' }), // waiting 2 days: not yet
    item('p/f', 0, 15, { created: '2026-01-01', archived: '2026-10-01' }),
  ];
  const review = [{ flags: [{ kind: 'stale' }] }, { flags: [{ kind: 'unopened' }] }];
  const conflicts = [{ a: 'p/a', b: 'p/b' }];

  const health = projectHealth(items, review, conflicts, { today: '2026-11-14' });

  // scored 3/5 -> 60, quality avg(80, 60, 40) = 60, conflicts 1 - 2/5 -> 60, review 1 - 1/5 -> 80,
  // backlog 1 - 1/5 -> 80, archived 1 - 1/6 -> 83.3: (25*60 + 30*60 + 15*60 + 15*80 + 10*80 + 5*83.3) / 100 = 66.2
  assert.deepEqual(health, {
    score: 66,
    parts: { total: 6, unscored: 2, average: 60, conflicts: 1, review: 1, backlog: 1, backlogDays: BACKLOG_DAYS, archived: 1 },
  });
});

test('projectHealth: a clean project scores 100, an empty one has no score, no date counts no backlog', () => {
  const clean = [1, 2, 3].map((n) => ({ key: `p/${n}`, usefulness: 100, final: { score: 100 }, confidence: 'confirmed', created: '2026-01-01', archived: null }));
  assert.equal(projectHealth(clean, [], [], { today: '2026-11-14' }).score, 100);
  assert.deepEqual(projectHealth([], [], []), { score: null, parts: null });
  assert.deepEqual(projectHealth(null, null, null), { score: null, parts: null });
  const old = [{ key: 'p/x', usefulness: 50, final: { score: 50 }, confidence: 'observed', created: '2026-01-01', archived: null }];
  assert.equal(projectHealth(old, [], []).parts.backlog, 0);
  assert.equal(projectHealth(old, [], [], { today: '2026-11-14' }).parts.backlog, 1);
  // Nothing rated: no average, and the score says so.
  const unrated = [{ key: 'p/y', usefulness: null, final: { score: null }, confidence: 'confirmed', created: '2026-11-01', archived: null }];
  assert.deepEqual(projectHealth(unrated, [], []), {
    score: 45,
    parts: { total: 1, unscored: 1, average: null, conflicts: 0, review: 0, backlog: 0, backlogDays: BACKLOG_DAYS, archived: 0 },
  });
});

test('memory:list sorts by final score with this PC reads, and carries the project health', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brainipc-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of [
    rec('high', { usefulness: 90 }),
    rec('reads', { usefulness: 70 }),
    rec('pending', { confidence: 'observed', usefulness: 40 }),
    rec('stale', { created: '2025-01-01', usefulness: 50 }),
    rec('always', { title: 'Always use npm ci in worktrees' }),
    rec('never', { title: 'Never use npm ci in worktrees' }),
  ]) {
    writeRecord(dir, r);
  }
  const events = Array.from({ length: 5 }, (_, i) => ({ at: NOW - i * 1000, ev: 'get', key: `${PROJECT}/reads` }));
  const handlers = {};
  registerMemoryBrainIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    scanner: createScanner({ dir: () => dir, run: async () => ({ ok: false }), now: () => NOW }),
    now: () => NOW,
    log: { add: () => true, read: () => events },
  });

  const res = handlers['memory:list']({}, PROJECT);

  // reads: 0.7 * 70 + 15 + 15 = 79 beats high: 0.7 * 90 + 15 = 78.
  assert.deepEqual(
    res.items.map((i) => [i.id, i.final.score]),
    [
      ['reads', 79],
      ['high', 78],
      ['stale', 50],
      ['pending', 36],
      ['always', null],
      ['never', null],
    ],
  );
  assert.deepEqual(res.items[0].final.parts, { usefulness: 70, confidence: 'confirmed', usage: 5 });
  assert.ok(Number.isInteger(res.health.score) && res.health.score >= 0 && res.health.score <= 100);
  assert.deepEqual(res.health.parts, { total: 6, unscored: 2, average: 61, conflicts: 1, review: 1, backlog: 1, backlogDays: BACKLOG_DAYS, archived: 0 });
});

test('a failing memory log or project folder list never hides the list of all memories', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brainipc-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  writeRecord(dir, rec('a', { usefulness: 60 }));
  const handlers = {};
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  registerMemoryBrainIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    scanner: createScanner({ dir: () => dir, run: async () => ({ ok: false }), now: () => NOW }),
    now: () => NOW,
    log: {
      add: () => true,
      read: () => {
        throw new Error('log broken');
      },
    },
    roots: () => {
      throw new Error('roots broken');
    },
  });

  const res = handlers['memory:list']({}, PROJECT);

  assert.equal(res.ok, true);
  assert.deepEqual(res.items.map((i) => [i.id, i.final.score]), [['a', 57]]);
  assert.equal(res.health.parts.total, 1);
  assert.ok(errors.some((e) => e.includes('log broken')) && errors.some((e) => e.includes('roots broken')), errors.join('\n'));
});

test('the score and health strings exist in Polish and English, and the inbox chip uses its own', () => {
  const i18n = read('src/renderer/i18n.js');
  for (const key of ['mem.inbox.score', 'mem.brain.score', 'mem.brain.scoreWhy', 'mem.brain.health', 'mem.brain.conf.confirmed', 'mem.brain.conf.observed', 'mem.brain.conf.inferred']) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
  assert.match(read('src/renderer/modules/memoryinbox.js'), /t\('mem\.inbox\.score'/);
  assert.match(read('src/renderer/modules/memorybrain.js'), /healthLine\(list\.health\)/);
  // The wiring hands the log reads and the project folders to the list of all memories.
  assert.match(read('src/main.js'), /registerMemoryBrainIpc\(\{[\s\S]*?read: \(\) => memoryLogOf\(\)\.read\(\)[\s\S]*?roots: memoryRoots,\s*\}\);/);
});

// ---- merge and the History expander (memory:merge, memory:provenance) ------------------

const { MAX_CHAIN_DEPTH, sourceOf } = require('../src/memoryprovenance.js');

function withLog(t, records, events = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brainipc-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of records) writeRecord(dir, r);
  const handlers = {};
  const added = [];
  let changed = 0;
  registerMemoryBrainIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    scanner: { start: () => ({ ok: true }), status: () => ({}) },
    onChanged: () => changed++,
    now: () => NOW,
    log: { add: (e) => added.push(e), read: () => events },
  });
  return { invoke: (channel, arg) => handlers[channel]({}, arg), added, changed: () => changed, stored: () => Object.fromEntries(scan(dir).records) };
}

const keyIn = (id) => `${PROJECT}/${id}`;

test('memory:merge validates its payload, then writes one memory superseding both', (t) => {
  const s = withLog(t, [rec('ci-first', { title: 'Run npm ci in package worktrees before the tests' }), rec('ci-before', { title: 'Run npm ci in package worktrees before tests' })]);
  const a = keyIn('ci-before');
  const b = keyIn('ci-first');
  assert.deepEqual(s.invoke('memory:merge', null), { ok: false, reason: 'bad-request' });
  assert.deepEqual(s.invoke('memory:merge', [a, b]), { ok: false, reason: 'bad-request' });
  assert.deepEqual(s.invoke('memory:merge', { a: '../x', b, title: 'T', body: 'B' }), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:merge', { a, b: 'x'.repeat(500), title: 'T', body: 'B' }), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:merge', { a, b, title: { x: 1 }, body: 'B' }), { ok: false, reason: 'bad-edits' });
  assert.deepEqual(s.invoke('memory:merge', { a, b, title: 'T', body: 'x'.repeat(20000) }), { ok: false, reason: 'bad-edits' });
  assert.equal(s.changed(), 0);

  const res = s.invoke('memory:merge', { a, b, title: 'Run npm ci first', body: 'Both, joined.' });
  assert.deepEqual(res, { ok: true, key: keyIn('run-npm-ci-first'), superseded: [a, b] });
  assert.equal(s.changed(), 1);
  assert.deepEqual(s.stored()[res.key].supersedes, ['ci-before', 'ci-first']);
  assert.ok(s.stored()[a] && s.stored()[b], 'the originals stay');
  assert.deepEqual(s.added.map((e) => e.ev), ['merged', 'superseded', 'superseded']);
});

test('memory:provenance: source, the chain both ways with its depth cap, links and this PC log', (t) => {
  // c0 supersedes c1, which supersedes c2 ... c7 supersedes a file that is gone.
  const chain = Array.from({ length: 8 }, (_, i) => rec(`c${i}`, { title: `Chain ${i}`, supersedes: [i < 7 ? `c${i + 1}` : 'gone-one'] }));
  const source = 'captured from session abcd1234 on WORKPC, read 2 outside source(s), suggested global';
  const s = withLog(
    t,
    [
      ...chain.slice(1),
      { ...chain[0], source, links: ['note', 'missing-link'], conflicts: ['note'], last_verified: '2026-11-02', last_used: '2026-11-10', usefulness: 70, usefulness_note: 'Saves a red run.' },
      rec('note', { title: 'A linked note' }),
      rec('newer', { title: 'Newer, waiting', confidence: 'observed', supersedes: ['c0'] }),
    ],
    [
      { at: NOW - 5000, ev: 'proposed', key: keyIn('c0'), type: 'gotcha' },
      { at: NOW - 4000, ev: 'approved', key: keyIn('c0'), type: 'gotcha' },
      { at: NOW - 3000, ev: 'search', project: PROJECT, hits: [keyIn('c0'), keyIn('note')] },
      { at: NOW - 2500, ev: 'get', key: keyIn('c0') },
      { at: NOW - 2000, ev: 'conflict', key: keyIn('note'), other: keyIn('c0'), note: 'They disagree.' },
      { at: NOW - 1000, ev: 'merged', key: keyIn('later'), type: 'gotcha', from: [keyIn('c0'), keyIn('note')] },
      { at: NOW - 500, ev: 'approved', key: keyIn('note'), type: 'gotcha' },
    ],
  );

  const p = s.invoke('memory:provenance', keyIn('c0'));

  assert.equal(p.ok, true);
  assert.equal(p.title, 'Chain 0');
  assert.deepEqual(p.source, { text: source, outside: 2, suggestedGlobal: true, autoAccepted: false, kind: 'session', ref: 'abcd1234', machine: 'WORKPC' });
  assert.equal(p.last_verified, '2026-11-02');
  assert.equal(p.last_used, '2026-11-10');
  assert.equal(p.usefulness_note, 'Saves a red run.');
  // Down: c1 ... c5, MAX_CHAIN_DEPTH levels, then cut.
  const depth = (nodes) => (nodes.length ? 1 + depth(nodes[0].children) : 0);
  assert.equal(MAX_CHAIN_DEPTH, 5);
  assert.equal(depth(p.supersedes.nodes), MAX_CHAIN_DEPTH);
  assert.equal(p.supersedes.nodes[0].title, 'Chain 1');
  assert.equal(p.supersedes.cut, true);
  // Up: the waiting memory that names it, marked as waiting.
  assert.deepEqual(p.supersededBy, { nodes: [{ key: keyIn('newer'), id: 'newer', title: 'Newer, waiting', confirmed: false, children: [] }], cut: false });
  assert.deepEqual(p.links, [
    { id: 'note', key: keyIn('note'), title: 'A linked note' },
    { id: 'missing-link', key: keyIn('missing-link'), title: null },
  ]);
  assert.deepEqual(p.conflicts.map((r) => r.title), ['A linked note']);
  assert.deepEqual(p.compatible, []);
  assert.deepEqual(
    p.timeline.events.map((e) => [e.ev, e.other || e.into || null]),
    [
      ['proposed', null],
      ['approved', null],
      ['conflict', keyIn('note')],
      ['merged', keyIn('later')],
    ],
  );
  assert.deepEqual(p.timeline.reads, { found: 1, opened: 1, last: NOW - 2500 });
  assert.equal(s.changed(), 0, 'read only');

  // From the middle of the chain: both directions at once, a missing file without a title.
  const mid = s.invoke('memory:provenance', keyIn('c6'));
  assert.deepEqual(mid.supersedes.nodes.map((n) => [n.id, n.title]), [['c7', 'Chain 7']]);
  assert.deepEqual(mid.supersedes.nodes[0].children.map((n) => [n.id, n.title, n.confirmed]), [['gone-one', null, null]]);
  assert.equal(mid.supersededBy.nodes[0].id, 'c5');
  assert.equal(depth(mid.supersededBy.nodes), MAX_CHAIN_DEPTH);
  assert.equal(mid.supersededBy.cut, true, 'c0 and newer are past the cap');
  assert.equal(mid.source.kind, null, 'no source: written by hand');
});

test('memory:provenance rejects bad keys and names an unknown memory', (t) => {
  const s = withLog(t, [rec('a')]);
  for (const bad of [undefined, 7, { key: keyIn('a') }, '../../etc/passwd', 'C:\\Windows', 'x'.repeat(500), `${PROJECT}/A B`]) {
    assert.deepEqual(s.invoke('memory:provenance', bad), { ok: false, reason: 'bad-key' }, String(bad));
  }
  assert.deepEqual(s.invoke('memory:provenance', keyIn('nothing')), { ok: false, reason: 'not-found' });
});

test('provenance reads other sources apart: God Mode runs, merges, auto-memory', () => {
  const run = sourceOf('captured from God Mode run gm-42 on HOME-PC, auto-accepted');
  assert.deepEqual([run.kind, run.ref, run.machine, run.autoAccepted], ['godmode', 'gm-42', 'HOME-PC', true]);
  assert.deepEqual([sourceOf('proposed in session s3 on LAPTOP').kind, sourceOf('proposed in session s3 on LAPTOP').machine], ['session', 'LAPTOP']);
  assert.equal(sourceOf('merged by hand from a and b').ref, 'a, b');
  assert.equal(sourceOf('claude auto-memory, session 1234').kind, 'auto-memory');
  assert.deepEqual([sourceOf('typed in by hand').kind, sourceOf('typed in by hand').text], ['other', 'typed in by hand']);
});

test('a merge keeps the outside-content note, and History reads it back', (t) => {
  const s = withLog(t, [
    rec('ci-first', { title: 'Run npm ci in package worktrees before the tests', source: 'captured from session abcd1234 on WORKPC, read 3 outside source(s)' }),
    rec('ci-before', { title: 'Run npm ci in package worktrees before tests' }),
  ]);
  const res = s.invoke('memory:merge', { a: keyIn('ci-before'), b: keyIn('ci-first'), title: 'Run npm ci first', body: 'Joined.' });
  assert.equal(s.stored()[res.key].source, 'merged by hand from ci-before and ci-first, read 3 outside source(s)');
  const p = s.invoke('memory:provenance', res.key);
  assert.deepEqual([p.source.kind, p.source.ref, p.source.outside], ['merged', 'ci-before, ci-first', 3]);
  // Both originals now name the merged memory as what superseded them.
  assert.deepEqual(s.invoke('memory:provenance', keyIn('ci-first')).supersededBy.nodes.map((n) => n.id), ['run-npm-ci-first']);
});

test('a memory two branches share is shown in both, and the chain is not called cut', (t) => {
  // top supersedes left and right; both supersede base (two merges of one old memory).
  const s = withLog(t, [
    rec('top', { supersedes: ['left', 'right'] }),
    rec('left', { supersedes: ['base'] }),
    rec('right', { supersedes: ['base'] }),
    rec('base'),
  ]);
  const p = s.invoke('memory:provenance', keyIn('top'));
  assert.deepEqual(p.supersedes.nodes.map((n) => [n.id, n.children.map((c) => c.id)]), [['left', ['base']], ['right', ['base']]]);
  assert.equal(p.supersedes.cut, false);
  assert.equal(s.invoke('memory:provenance', keyIn('base')).supersededBy.cut, false);
});

test('preload and the window wire merge and History through one narrow function each', () => {
  const preload = read('src/preload.js');
  for (const [fn, channel] of [
    ['memoryMerge', 'memory:merge'],
    ['memoryProvenance', 'memory:provenance'],
  ]) {
    assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `${channel} is missing in preload`);
  }
  assert.ok(read('src/renderer/modules/memoryinbox.js').includes("'memoryMerge'"));
  const history = read('src/renderer/modules/memoryhistory.js');
  assert.match(history, /window\.lunacore\.memoryProvenance\(key\)/);
  assert.doesNotMatch(history, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(read('src/renderer/modules/memorybrain.js'), /historyBlock\(item\.key\)/);
});

test('the memory window modules parse as ES modules', (t) => {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-brain-syntax-'));
  t.after(() => fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5 }));
  for (const name of ['memoryhistory', 'memorybrain', 'memoryinbox']) {
    const file = path.join(tmp, `${name}.mjs`);
    fs.writeFileSync(file, read(`src/renderer/modules/${name}.js`));
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${name}.js: ${res.stderr}`);
  }
});

test('every merge and History string exists in Polish and English, inside the mem.brain block', () => {
  const lines = read('src/renderer/i18n.js').split('\n');
  const files = ['memoryhistory.js', 'memorybrain.js'].map((f) => read(`src/renderer/modules/${f}`));
  const keys = new Set(files.flatMap((text) => [...text.matchAll(/'(mem\.brain\.(?:history|dup|merge)[\w.]*)'/g)].map((m) => m[1])));
  assert.ok(keys.size > 40, String(keys.size));
  for (const key of keys) {
    const at = lines.map((l, i) => (l.includes(`'${key}':`) ? i : -1)).filter((i) => i >= 0);
    assert.equal(at.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[at[0]], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
    // Next to the other mem.brain strings, not at the end of a language block.
    for (const i of at) assert.match(lines[i - 1] + lines[i + 1], /'mem\.brain\./, `${key} sits outside the mem.brain block`);
  }
});
