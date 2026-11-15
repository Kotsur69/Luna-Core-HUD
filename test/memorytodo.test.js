// ============================================================================
// LunaCore - "Make a to-do": a memory becomes a To-do card, then leaves
// (src/memorytodo.js, its IPC in src/memoryipc.js, preload and the renderer)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { draftFromMemory, cleanDraft, todoProjectFor, moveToTodo, TODO_TAG, MOVED_REASON } = require('../src/memorytodo.js');
const { registerMemoryIpc } = require('../src/memoryipc.js');
const { writeRecord, scan, fileFor } = require('../src/memorystore.js');
const { createLog, logPath } = require('../src/memorylog.js');
const { graveyardPath, readGraveyard, restoreEntry } = require('../src/memorygraveyard.js');
const { MAX_TEXT_CHARS, MAX_DETAILS_CHARS, MAX_ITEMS, DEFAULT_KEY } = require('../src/todo.js');

const PROJECT = 'github.com/acme/hud';
const KEY = `${PROJECT}/paste-cut`;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const PROJECT_ID = 'p-hud';
const FOLDER = path.join(os.tmpdir(), 'acme-hud');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: 'To-do text is cut at about 4000 characters when pasting a lot',
  created: '2026-11-10',
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: 'Pasting a long prompt into the to-do box keeps only the first 4000 characters.',
  ...over,
});

/** An in-memory To-do store with the src/todo.js read / write shape. */
function todoStore({ failWrite = false, initial = {} } = {}) {
  const lists = { ...initial };
  const calls = [];
  return {
    lists,
    calls,
    read: (id) => lists[id] || [],
    write: (id, list) => {
      calls.push(id);
      if (failWrite) return false;
      lists[id] = list;
      return true;
    },
    changed: (id) => calls.push(`changed:${id}`),
  };
}

/** The memory IPC with the to-do deps, on a temp mirror. */
function setup(t, records = [rec('paste-cut')], { todos = todoStore(), projects = [{ id: PROJECT_ID, path: FOLDER }], graveyard = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memtodo-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  for (const r of records) writeRecord(dir, r);
  const handlers = {};
  let changed = 0;
  const log = createLog(logPath(base), { now: () => NOW });
  const graveFile = graveyardPath(base);
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => changed++,
    now: () => NOW,
    log,
    graveyardFile: () => (graveyard ? graveFile : null),
    todoProjects: () => projects,
    memoryProjectOf: (folder) => (folder === FOLDER ? PROJECT : null),
    todos,
  });
  const invoke = (channel, ...args) => handlers[channel]({}, ...args);
  const logged = () => log.read().map(({ at, ...event }) => event);
  const stored = () => Object.fromEntries(scan(dir).records);
  return { base, dir, todos, log, logged, invoke, stored, graveFile, changed: () => changed };
}

const DRAFT = { text: 'Fix: paste cut', details: 'Keep the whole paste.', size: 'S' };

// ---- the draft -------------------------------------------------------------------

test('the draft is "Fix: <title>" and the body with the memory it came from', () => {
  const draft = draftFromMemory(rec('paste-cut'));
  assert.equal(draft.text, 'Fix: To-do text is cut at about 4000 characters when pasting a lot');
  assert.equal(
    draft.details,
    'Pasting a long prompt into the to-do box keeps only the first 4000 characters.\n\nFrom memory github.com/acme/hud/paste-cut (gotcha, created 2026-11-10)',
  );
});

test('the draft keeps to the card caps, and the provenance line survives a long body', () => {
  const draft = draftFromMemory(rec('long', { title: 't'.repeat(MAX_TEXT_CHARS + 50), body: 'b'.repeat(MAX_DETAILS_CHARS + 500) }));
  assert.equal(draft.text.length, MAX_TEXT_CHARS);
  assert.ok(draft.text.startsWith('Fix: '));
  assert.ok(draft.details.length <= MAX_DETAILS_CHARS);
  assert.ok(draft.details.endsWith(`From memory ${PROJECT}/long (gotcha, created 2026-11-10)`));
});

test('memory:todo-draft drafts from the full memory; a global one or one without a list is refused', (t) => {
  const s = setup(t, [rec('paste-cut'), rec('everywhere', { project: 'global', title: 'Global rule about something' })]);
  const res = s.invoke('memory:todo-draft', KEY);
  assert.equal(res.ok, true);
  assert.equal(res.key, KEY);
  assert.equal(res.text, draftFromMemory(rec('paste-cut')).text);
  assert.deepEqual(s.invoke('memory:todo-draft', 'global/everywhere'), { ok: false, reason: 'global' });
  assert.deepEqual(s.invoke('memory:todo-draft', '../../etc/passwd'), { ok: false, reason: 'bad-key' });
  assert.deepEqual(s.invoke('memory:todo-draft', `${PROJECT}/gone`), { ok: false, reason: 'not-found' });

  const lonely = setup(t, [rec('paste-cut')], { projects: [] });
  assert.deepEqual(lonely.invoke('memory:todo-draft', KEY), { ok: false, reason: 'no-todo-list' });
});

// ---- write, then remove ------------------------------------------------------------

test('the card is written before the memory is removed, tagged "memory", with the edited text', (t) => {
  const s = setup(t);
  let presentAtWrite = null;
  const write = s.todos.write;
  s.todos.write = (id, list) => {
    presentAtWrite = Boolean(s.stored()[KEY]);
    return write(id, list);
  };

  const res = s.invoke('memory:to-todo', KEY, DRAFT);

  assert.equal(res.ok, true);
  assert.equal(res.projectId, PROJECT_ID);
  assert.equal(presentAtWrite, true, 'the memory must still exist while the card is written');
  assert.equal(s.stored()[KEY], undefined, 'the memory leaves after the card exists');
  const [card] = s.todos.lists[PROJECT_ID];
  assert.deepEqual(card, { text: 'Fix: paste cut', done: false, at: res.at, details: 'Keep the whole paste.', size: 'S', tags: [TODO_TAG] });
  assert.equal(res.at, NOW);
  assert.deepEqual(s.todos.calls, [PROJECT_ID, `changed:${PROJECT_ID}`]);
  assert.equal(s.changed(), 1);
});

test('the card goes after the list and gets an `at` no other card has', (t) => {
  const todos = todoStore({ initial: { [PROJECT_ID]: [{ text: 'older', done: false, at: NOW + 5 }] } });
  const s = setup(t, undefined, { todos });
  const res = s.invoke('memory:to-todo', KEY, { text: 'Fix it' });
  assert.equal(res.ok, true);
  assert.equal(res.at, NOW + 6);
  assert.deepEqual(todos.lists[PROJECT_ID].map((c) => c.text), ['older', 'Fix it']);
  assert.equal(todos.lists[PROJECT_ID][1].size, undefined);
});

test('a failed to-do write deletes nothing and logs nothing', (t) => {
  const s = setup(t, undefined, { todos: todoStore({ failWrite: true }) });
  const before = fs.readFileSync(fileFor(s.dir, KEY), 'utf8');

  assert.deepEqual(s.invoke('memory:to-todo', KEY, DRAFT), { ok: false, reason: 'todo-failed' });

  assert.equal(fs.readFileSync(fileFor(s.dir, KEY), 'utf8'), before);
  assert.deepEqual(readGraveyard(s.graveFile, NOW), []);
  assert.deepEqual(s.logged(), []);
  assert.equal(s.changed(), 0);
});

test('a waiting memory goes to the graveyard with its reason, and can be restored from there', (t) => {
  const s = setup(t);
  assert.equal(s.invoke('memory:to-todo', KEY, DRAFT).ok, true);

  const [entry] = readGraveyard(s.graveFile, NOW);
  assert.equal(entry.reason, MOVED_REASON);
  assert.equal(entry.record.title, rec('paste-cut').title);
  const back = restoreEntry({ file: s.graveFile, dir: s.dir, id: entry.id, now: NOW });
  assert.equal(back.ok, true);
  assert.equal(s.stored()[back.key].confidence, 'observed');
});

test('the near-duplicates folded into a waiting entry leave with it, into the graveyard', (t) => {
  const s = setup(t, [rec('paste-cut'), rec('paste-cut-2', { created: '2026-11-12' })]);
  assert.equal(s.invoke('memory:to-todo', KEY, DRAFT).ok, true);
  assert.deepEqual(Object.keys(s.stored()), []);
  assert.equal(readGraveyard(s.graveFile, NOW).length, 2);
});

test('a confirmed memory is retired: deleted, a `retired` line, no graveyard entry', (t) => {
  const s = setup(t, [rec('paste-cut', { confidence: 'confirmed', last_verified: '2026-11-11' })]);
  const res = s.invoke('memory:to-todo', KEY, DRAFT);
  assert.equal(res.ok, true);
  assert.equal(s.stored()[KEY], undefined);
  assert.deepEqual(readGraveyard(s.graveFile, NOW), []);
  assert.ok(s.logged().some((e) => e.ev === 'retired' && e.key === KEY));
});

test('`to-todo` is logged with the key and the card; never a `rejected` decision', (t) => {
  const s = setup(t, [rec('paste-cut'), rec('fixed', { confidence: 'confirmed', title: 'Another confirmed one' })]);
  const a = s.invoke('memory:to-todo', KEY, DRAFT);
  const b = s.invoke('memory:to-todo', `${PROJECT}/fixed`, DRAFT);

  const events = s.logged();
  assert.deepEqual(
    events.filter((e) => e.ev === 'to-todo'),
    [
      { ev: 'to-todo', key: KEY, card: a.at, type: 'gotcha', title: rec('paste-cut').title },
      { ev: 'to-todo', key: `${PROJECT}/fixed`, card: b.at, type: 'gotcha', title: 'Another confirmed one' },
    ],
  );
  assert.equal(events.filter((e) => e.ev === 'rejected').length, 0, 'a rejected title would teach the extractor not to capture this');
});

test('the card written but the memory not removable: the memory stays and the reason says so', (t) => {
  const s = setup(t, undefined, { graveyard: false });
  const res = s.invoke('memory:to-todo', KEY, DRAFT);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'remove-failed');
  assert.equal(res.at, NOW);
  assert.equal(s.todos.lists[PROJECT_ID].length, 1);
  assert.ok(s.stored()[KEY], 'nothing is deleted that is not kept somewhere');
  assert.equal(s.logged().filter((e) => e.ev === 'to-todo').length, 0);
});

// ---- refusals ---------------------------------------------------------------------

test('bad payloads are refused before anything is written', (t) => {
  const s = setup(t);
  const cases = [
    [[42, DRAFT], 'bad-key'],
    [['../../etc/passwd', DRAFT], 'bad-key'],
    [['C:\\Windows\\x', DRAFT], 'bad-key'],
    [[`${PROJECT}/${'x'.repeat(300)}`, DRAFT], 'bad-key'],
    [[KEY, null], 'bad-draft'],
    [[KEY, [DRAFT]], 'bad-draft'],
    [[KEY, { text: '   ' }], 'bad-draft'],
    [[KEY, { text: 7 }], 'bad-draft'],
    [[KEY, { text: 'x'.repeat(MAX_TEXT_CHARS + 1) }], 'bad-draft'],
    [[KEY, { text: 'ok', details: 'd'.repeat(MAX_DETAILS_CHARS + 1) }], 'bad-draft'],
    [[KEY, { text: 'ok', details: { html: '<b>' } }], 'bad-draft'],
    [[KEY, { text: 'ok', size: 'XL' }], 'bad-draft'],
  ];
  for (const [args, reason] of cases) assert.deepEqual(s.invoke('memory:to-todo', ...args), { ok: false, reason }, JSON.stringify(args).slice(0, 80));
  assert.deepEqual(s.todos.calls, []);
  assert.ok(s.stored()[KEY]);
});

test('cleanDraft keeps only text, details and size', () => {
  assert.deepEqual(cleanDraft({ text: '  Fix  ', details: '', size: '', tags: ['steer'], done: true, at: 1 }), { text: 'Fix' });
  assert.deepEqual(cleanDraft({ text: 'Fix', details: ' d ', size: 'L' }), { text: 'Fix', details: 'd', size: 'L' });
});

test('a project with no To-do list on this PC is refused, never the _default bucket', (t) => {
  const s = setup(t, undefined, { projects: [{ id: DEFAULT_KEY, path: FOLDER }, { id: 'other', path: path.join(FOLDER, 'elsewhere') }] });
  assert.deepEqual(s.invoke('memory:to-todo', KEY, DRAFT), { ok: false, reason: 'no-todo-list' });
  assert.deepEqual(s.todos.calls, []);
  assert.ok(s.stored()[KEY]);

  const g = setup(t, [rec('rule', { project: 'global', title: 'A global rule' })]);
  assert.deepEqual(g.invoke('memory:to-todo', 'global/rule', DRAFT), { ok: false, reason: 'global' });
  assert.deepEqual(g.todos.calls, []);
});

test('a full list is refused instead of losing the card to the cap', (t) => {
  const full = Array.from({ length: MAX_ITEMS }, (_v, i) => ({ text: `c${i}`, done: false, at: i + 1 }));
  const s = setup(t, undefined, { todos: todoStore({ initial: { [PROJECT_ID]: full } }) });
  assert.deepEqual(s.invoke('memory:to-todo', KEY, DRAFT), { ok: false, reason: 'list-full' });
  assert.ok(s.stored()[KEY]);
});

test('todoProjectFor maps a memory project to the first LunaCore project whose folder is it', () => {
  const projectOf = (folder) => ({ '/a': PROJECT, '/b': PROJECT, '/c': 'github.com/acme/other' })[folder] || null;
  const projects = [null, { id: '', path: '/a' }, { id: 'x', path: 42 }, { id: DEFAULT_KEY, path: '/a' }, { id: 'c', path: '/c' }, { id: 'b', path: '/b' }, { id: 'a2', path: '/a' }];
  assert.equal(todoProjectFor(PROJECT, projects, projectOf), 'b');
  assert.equal(todoProjectFor('global', projects, projectOf), null);
  assert.equal(todoProjectFor('github.com/acme/none', projects, projectOf), null);
  assert.equal(todoProjectFor(PROJECT, 'not a list', projectOf), null);
});

test('moveToTodo refuses an unknown key without touching the list', (t) => {
  const s = setup(t);
  const res = moveToTodo({ dir: s.dir, key: `${PROJECT}/nope`, draft: DRAFT, now: NOW, projectIdFor: () => PROJECT_ID, todos: s.todos, graveyardFile: () => s.graveFile });
  assert.deepEqual(res, { ok: false, reason: 'not-found' });
  assert.deepEqual(s.todos.calls, []);
});

// ---- the log ----------------------------------------------------------------------

test('the memory log keeps a `to-todo` line only with a key and a card time', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memtodo-log-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const log = createLog(logPath(base), { now: () => NOW });
  assert.equal(log.add({ ev: 'to-todo', key: KEY, card: NOW, type: 'gotcha', title: 'line\nbreak' }), true);
  assert.equal(log.add({ ev: 'to-todo', key: KEY }), false);
  assert.equal(log.add({ ev: 'to-todo', key: '../x', card: NOW }), false);
  assert.deepEqual(log.read(), [{ at: NOW, ev: 'to-todo', key: KEY, card: NOW, type: 'gotcha', title: 'line break' }]);
});

// ---- preload and the renderer --------------------------------------------------------

test('preload exposes the two channels with typeof guards, beside the other memory methods', () => {
  const preload = read('src/preload.js');
  assert.match(preload, /memoryTodoDraft: \(key\) => ipcRenderer\.invoke\('memory:todo-draft', typeof key === 'string' \? key : ''\)/);
  assert.match(preload, /memoryToTodo: \(key, draft\) =>\s*ipcRenderer\.invoke\('memory:to-todo', typeof key === 'string' \? key : ''/);
  for (const field of ['text', 'details', 'size']) assert.match(preload, new RegExp(`typeof draft\\.${field} === 'string'`));
  assert.ok(preload.indexOf('memoryToTodo:') > preload.indexOf('memoryReviewRetire:'));
  assert.ok(preload.indexOf('memoryToTodo:') < preload.indexOf('memoryAutoSet:'));
});

test('main wires the to-do deps into registerMemoryIpc', () => {
  const main = read('src/main.js');
  const call = main.slice(main.indexOf('registerMemoryIpc({'), main.indexOf('registerMemoryBrainIpc({'));
  for (const dep of ['todoProjects: () => projects', 'memoryProjectOf:', 'read: readTodos', 'write: writeTodos', "send('todo:changed'"]) {
    assert.ok(call.includes(dep), `${dep} is not passed`);
  }
});

test('the button is on inbox, review and all-memories entries, through channels preload exposes', () => {
  const inbox = read('src/renderer/modules/memoryinbox.js');
  const brain = read('src/renderer/modules/memorybrain.js');
  const form = read('src/renderer/modules/memorytodoform.js');
  const preload = read('src/preload.js');
  for (const fn of ['memoryTodoDraft', 'memoryToTodo']) {
    assert.ok(form.includes(`'${fn}'`), `${fn} is not called`);
    assert.match(preload, new RegExp(`\\b${fn}:`));
  }
  // entry() and reviewEntry() both offer it; the All memories list gets it through memoriesPanel.
  assert.equal((inbox.match(/todoButton\(\{ global: isGlobal\(item\)/g) || []).length, 2);
  assert.match(inbox, /onTodo: \(key\) => todo\.open\(key\)/);
  assert.match(brain, /todoButton\(\{ global, off: off\(item\.key\)/);
  for (const src of [inbox, brain, form]) assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('every "Make a to-do" string exists in Polish and English, Polish without diacritics', () => {
  const i18n = read('src/renderer/i18n.js');
  const sources = ['memorytodoform.js', 'memoryinbox.js', 'memoryinboxlines.js'].map((f) => read(`src/renderer/modules/${f}`)).join('\n');
  const keys = new Set([...sources.matchAll(/'(mem\.(?:todo|inbox|grave)\.[\w.]+)'/g)].map((m) => m[1]));
  for (const key of ['mem.todo.make', 'mem.todo.err.noList', 'mem.grave.moved', 'mem.inbox.search.meaning']) assert.ok(keys.has(key), key);
  for (const key of keys) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
});

test('the renderer maps the refusals to words and sends only the three fields', async () => {
  const { todoReasonKey, todoPayload, REMOVE_FAILED } = await import('../src/renderer/modules/memorytodoform.js');
  assert.equal(todoReasonKey('no-todo-list'), 'mem.todo.err.noList');
  assert.equal(todoReasonKey('global'), 'mem.todo.err.global');
  assert.equal(todoReasonKey(REMOVE_FAILED), 'mem.todo.err.remove');
  assert.equal(todoReasonKey('not-found'), null);
  assert.equal(todoReasonKey('constructor'), null);
  assert.deepEqual(todoPayload('  Fix  ', ' d ', 'M'), { text: 'Fix', details: 'd', size: 'M' });
  assert.deepEqual(todoPayload('Fix', '', 'XL'), { text: 'Fix', details: '', size: '' });
});
