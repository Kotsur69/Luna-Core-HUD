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
