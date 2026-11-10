// Crash resume (src/tabResume.js): which tabs are remembered, what survives a
// second crash, and that a broken store never breaks a start.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createTabResume, tabRecord, cleanTabs, FILE_NAME, MAX_TABS } = require('../src/tabResume');
const { withPlainResume } = require('../src/launch');
const { resumableCount, resumeLabel } = require('../src/renderer/modules/tabresume.js');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const DIR = path.join('X:', 'userdir');
const FILE = path.join(DIR, FILE_NAME);

/** In-memory fs holding the store file. */
function fakeFs(initial) {
  const files = new Map(initial === undefined ? [] : [[FILE, initial]]);
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync(p, body) {
      files.set(p, body);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

const session = (transcriptId, extra = {}) => ({ profileId: 'claude', projectId: 'p1', cwd: 'C:\\repo', transcriptId, ...extra });
const stored = (fsImpl) => JSON.parse(fsImpl.files.get(FILE));
const ids = (tabs) => tabs.map((t) => t.transcriptId);

test('tabRecord keeps only the user\'s own claude conversations', () => {
  assert.deepEqual(tabRecord(session(ID_A)), { profileId: 'claude', projectId: 'p1', cwd: 'C:\\repo', transcriptId: ID_A });
  assert.equal(tabRecord(session(null)), null, 'bare shell: no conversation id');
  assert.equal(tabRecord(session(ID_A, { task: { briefPath: 'b.md' } })), null, 'God Mode worker, first launch');
  assert.equal(tabRecord(session(ID_A, { launchTask: { briefPath: 'b.md' } })), null, 'God Mode worker, after launch');
  assert.equal(tabRecord(session(ID_A, { commandOverride: 'claude setup-token' })), null);
  assert.equal(tabRecord(session('not-a-uuid')), null);
  // /clear moved the tab to a new conversation: the watcher's id wins.
  assert.equal(tabRecord(session(ID_A, { watcher: { sessionUuid: ID_B } })).transcriptId, ID_B);
});

test('cleanTabs drops junk and duplicates, and is capped', () => {
  assert.deepEqual(ids(cleanTabs([session(ID_A), null, 7, { cwd: 'x' }, session(ID_A), session(ID_B)])), [ID_A, ID_B]);
  assert.deepEqual(cleanTabs('nope'), []);
  const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => session(`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`));
  assert.equal(cleanTabs(many).length, MAX_TABS);
});

test('the tabs open at a crash are offered on the next start, then taken once', () => {
  const fsImpl = fakeFs();
  const first = createTabResume({ dir: () => DIR, fsImpl });
  assert.equal(first.load(), 0);
  first.save([session(ID_A), session(ID_B), session(null)]);
  assert.deepEqual(ids(stored(fsImpl).current), [ID_A, ID_B]);

  // Crash: no clean-up ran. Next start:
  const second = createTabResume({ dir: () => DIR, fsImpl });
  assert.equal(second.load(), 2);
  assert.deepEqual(ids(second.pending()), [ID_A, ID_B]);
  assert.deepEqual(ids(second.take()), [ID_A, ID_B]);
  assert.deepEqual(second.pending(), []);
});

test('a second crash before Resume was pressed loses nothing', () => {
  const fsImpl = fakeFs(JSON.stringify({ current: [session(ID_A)], previous: [] }));
  const second = createTabResume({ dir: () => DIR, fsImpl });
  second.load();
  second.save([session(ID_C)]); // the fresh tab of this run
  assert.deepEqual(ids(stored(fsImpl).previous), [ID_A]);

  const third = createTabResume({ dir: () => DIR, fsImpl });
  third.load();
  assert.deepEqual(ids(third.pending()), [ID_A, ID_C]);
});

test('a resumed tab stops being "last run"; a dismissed list stays gone', () => {
  const fsImpl = fakeFs(JSON.stringify({ current: [session(ID_A), session(ID_B)], previous: [] }));
  const store = createTabResume({ dir: () => DIR, fsImpl });
  store.load();
  store.save([session(ID_A)]); // ID_A is live again
  assert.deepEqual(ids(store.pending()), [ID_B]);
  store.take();
  store.save([session(ID_A)]);
  assert.deepEqual(stored(fsImpl).previous, []);
});

test('only conversations that exist on disk are offered', () => {
  const fsImpl = fakeFs(JSON.stringify({ current: [session(ID_A), session(ID_B)], previous: [] }));
  const store = createTabResume({ dir: () => DIR, fsImpl, hasTranscript: (tab) => tab.transcriptId === ID_B });
  store.load();
  assert.deepEqual(ids(store.pending()), [ID_B]);
  const throwing = createTabResume({
    dir: () => DIR,
    fsImpl: fakeFs(JSON.stringify({ current: [session(ID_A)] })),
    hasTranscript: () => {
      throw new Error('disk');
    },
  });
  throwing.load();
  assert.deepEqual(throwing.pending(), []);
});

test('a broken store, or no user dir, is an empty list - never a crash', () => {
  const lines = [];
  const broken = createTabResume({ dir: () => DIR, fsImpl: fakeFs('{not json'), log: (l) => lines.push(l) });
  assert.equal(broken.load(), 0);
  assert.equal(lines.length, 1);
  const noDir = createTabResume({ dir: () => null, fsImpl: fakeFs() });
  assert.equal(noDir.load(), 0);
  noDir.save([session(ID_A)]);
  assert.deepEqual(noDir.pending(), []);
  const readOnly = {
    ...fakeFs(),
    writeFileSync() {
      throw new Error('EPERM');
    },
  };
  const store = createTabResume({ dir: () => DIR, fsImpl: readOnly, log: (l) => lines.push(l) });
  store.load();
  assert.doesNotThrow(() => store.save([session(ID_A)]));
});

test('withPlainResume reopens a claude conversation and sends nothing', () => {
  assert.equal(withPlainResume('claude --model opus', ID_A), `claude --model opus --resume ${ID_A}`);
  assert.equal(withPlainResume('codex', ID_A), null);
  assert.equal(withPlainResume('', ID_A), null);
  assert.equal(withPlainResume('claude --continue', ID_A), null);
  assert.equal(withPlainResume('claude', `${ID_A}; echo injected`), null, 'only a uuid ever reaches the command line');
});

test('Resume button helpers', () => {
  assert.equal(resumableCount({ count: 3 }), 3);
  assert.equal(resumableCount({ count: -1 }), 0);
  assert.equal(resumableCount({ count: '3' }), 0);
  assert.equal(resumableCount(null), 0);
  assert.equal(resumeLabel(2, (key, vars) => `${key}:${vars.n}`), 'tabs.resume:2');
});
