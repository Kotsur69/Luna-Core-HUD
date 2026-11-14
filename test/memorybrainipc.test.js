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
