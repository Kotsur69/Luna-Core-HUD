// ============================================================================
// LunaCore - the memory mirror and its sync provider (src/memorystore.js)
// ----------------------------------------------------------------------------
// The two-PC tests run the real configsync.js engine over two temp folders:
// what one PC publishes is handed to the other as the cloud peer.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fileFor, scan, writeRecord, removeRecord, createMemoryProvider } = require('../src/memorystore.js');
const { createConfigSync } = require('../src/configsync.js');

const PROJECT = 'github.com/acme/demo';
const record = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memory-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** One PC: a mirror folder plus the sync engine; `cloud` is what the others published. */
function pc(root, name, clock) {
  const dir = path.join(root, name, 'memory');
  let published = null;
  let cloud = [];
  const invalid = [];
  const sync = createConfigSync({
    providers: [createMemoryProvider(dir, { onInvalid: (list) => invalid.splice(0, invalid.length, ...list) })],
    metaFile: path.join(root, name, 'memory-sync.local.json'),
    now: () => clock.t,
    extraPeers: () => cloud,
    onPublish: (doc) => {
      published = doc;
    },
  });
  fs.mkdirSync(path.join(root, name), { recursive: true });
  return {
    dir,
    invalid,
    /** Syncs against what the other PCs last published. */
    sync(...others) {
      cloud = others.map((o) => o.published()).filter(Boolean);
      return sync.syncOnce();
    },
    published: () => published,
    ids: () => scan(dir).records.map(([, r]) => r.id),
  };
}

test('stores a project memory and a global one where a person would look', (t) => {
  const dir = tmpDir(t);

  const file = writeRecord(dir, record('worktree-junction'));
  writeRecord(dir, record('english-comments', { project: 'global', type: 'preference' }));

  assert.equal(file, path.join(dir, 'projects', 'github.com', 'acme', 'demo', 'worktree-junction.md'));
  assert.ok(fs.existsSync(path.join(dir, 'global', 'english-comments.md')));
  const { exists, records, invalid } = scan(dir);
  assert.equal(exists, true);
  assert.deepEqual(invalid, []);
  assert.deepEqual(
    records.map(([k]) => k),
    [`${PROJECT}/worktree-junction`, 'global/english-comments'],
  );
});

test('a missing mirror folder is empty, not an error', (t) => {
  const dir = path.join(tmpDir(t), 'never-created');

  assert.deepEqual(scan(dir), { exists: false, records: [], invalid: [], ignored: [], mtimes: {} });
});

test('refuses a key that would leave the mirror folder', (t) => {
  const dir = tmpDir(t);

  assert.throws(() => fileFor(dir, 'github.com/../../x/evil'), /bad memory key/);
  assert.throws(() => writeRecord(dir, record('ok', { project: '../../x' })), /invalid memory record/);
});

test('a memory file that does not parse is reported; a file that never was a memory is only listed', (t) => {
  const dir = tmpDir(t);
  writeRecord(dir, record('good'));
  const project = path.join(dir, 'projects', 'github.com', 'acme', 'demo');
  fs.writeFileSync(path.join(project, 'broken.md'), 'no frontmatter here');
  fs.writeFileSync(path.join(project, 'README.md'), '# Notes about this folder');
  fs.writeFileSync(path.join(dir, 'projects', 'stray.md'), 'x');
  fs.mkdirSync(path.join(dir, 'global', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'global', 'drafts', 'idea.md'), 'x');

  const { records, invalid, ignored } = scan(dir);

  assert.equal(records.length, 1);
  assert.deepEqual(
    invalid.map((x) => [path.basename(x.file), x.error]),
    [['broken.md', 'no-frontmatter']],
  );
  assert.deepEqual(ignored.map((f) => path.basename(f)).sort(), ['README.md', 'idea.md', 'stray.md']);
});

test('a stray README does not pause the sync', (t) => {
  const root = tmpDir(t);
  const a = pc(root, 'a', { t: 1000 });
  writeRecord(a.dir, record('good'));
  fs.writeFileSync(path.join(a.dir, 'README.md'), 'about');
  fs.writeFileSync(path.join(a.dir, 'projects', 'github.com', 'acme', 'demo', 'Notes.md'), 'scratch');

  a.sync();

  assert.deepEqual(a.invalid, []);
  assert.equal(a.published().units.length, 1);
});

test('first sync on both PCs: the copy written later wins, whichever PC syncs first', (t) => {
  const root = tmpDir(t);
  const clock = { t: Date.now() + 60_000 };
  const a = pc(root, 'a', clock);
  const b = pc(root, 'b', clock);
  const older = new Date(Date.now() - 3_600_000);
  fs.utimesSync(writeRecord(a.dir, record('same', { body: 'Old copy on A.' })), older, older);
  writeRecord(b.dir, record('same', { body: 'Newer copy on B.' }));

  a.sync();
  b.sync(a);
  a.sync(b);

  assert.equal(scan(a.dir).records[0][1].body, 'Newer copy on B.');
  assert.equal(scan(b.dir).records[0][1].body, 'Newer copy on B.');
});

test('a key shaped like a file inside another memory folder is refused', (t) => {
  const provider = createMemoryProvider(tmpDir(t));
  const hostile = { ...record('y'), project: 'github.com/acme/demo/x.md' };

  assert.equal(provider.owns('github.com/acme/demo/x.md/y'), false);
  assert.equal(provider.valid('github.com/acme/demo/x.md/y', hostile), null);
  assert.equal(provider.owns('github.com/acme/demo.tmp/y'), false);
  assert.equal(provider.owns('github.com/acme/demo./y'), false);
});

test('a broken file stops the sync so it cannot travel as a delete', (t) => {
  const root = tmpDir(t);
  const clock = { t: 1000 };
  const a = pc(root, 'a', clock);
  writeRecord(a.dir, record('good'));
  a.sync();
  fs.writeFileSync(fileFor(a.dir, `${PROJECT}/good`), 'frontmatter lost while editing');
  clock.t = 2000;

  a.sync();

  assert.equal(a.invalid.length, 1);
  // Nothing is published this round, least of all a tombstone for `good`.
  assert.deepEqual(a.published(), { units: [], gone: {} });

  // Repaired: the sync carries on and the memory is still there.
  writeRecord(a.dir, record('good', { body: 'Repaired.' }));
  clock.t = 3000;
  a.sync();

  assert.deepEqual(a.invalid, []);
  assert.deepEqual(a.published().gone, {});
  assert.equal(a.published().units[0].v.body, 'Repaired.');
});

test('a memory written on one PC arrives on the other as the same file', (t) => {
  const root = tmpDir(t);
  const clock = { t: 1000 };
  const a = pc(root, 'a', clock);
  const b = pc(root, 'b', clock);
  writeRecord(a.dir, record('worktree-junction'));

  a.sync();
  const changed = b.sync(a);

  assert.deepEqual(changed, ['memory']);
  assert.equal(
    fs.readFileSync(fileFor(b.dir, `${PROJECT}/worktree-junction`), 'utf8'),
    fs.readFileSync(fileFor(a.dir, `${PROJECT}/worktree-junction`), 'utf8'),
  );
});

test('an edit made in an editor wins over the older copy', (t) => {
  const root = tmpDir(t);
  const clock = { t: 1000 };
  const a = pc(root, 'a', clock);
  const b = pc(root, 'b', clock);
  writeRecord(a.dir, record('note'));
  a.sync();
  b.sync(a);
  const file = fileFor(b.dir, `${PROJECT}/note`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Body of note.', 'Edited by hand on B.'));
  clock.t = 5000;

  b.sync(a);
  a.sync(b);

  assert.equal(scan(a.dir).records[0][1].body, 'Edited by hand on B.');
});

test('deleting the file deletes the memory on the other PC', (t) => {
  const root = tmpDir(t);
  const clock = { t: 1000 };
  const a = pc(root, 'a', clock);
  const b = pc(root, 'b', clock);
  writeRecord(a.dir, record('keep'));
  writeRecord(a.dir, record('drop'));
  a.sync();
  b.sync(a);
  removeRecord(a.dir, `${PROJECT}/drop`);
  clock.t = 5000;

  a.sync(b);
  b.sync(a);

  assert.deepEqual(b.ids(), ['keep']);
});

test('a PC whose mirror folder vanished gets the memories back', (t) => {
  const root = tmpDir(t);
  const clock = { t: 1000 };
  const a = pc(root, 'a', clock);
  const b = pc(root, 'b', clock);
  writeRecord(a.dir, record('keep'));
  a.sync();
  b.sync(a);
  fs.rmSync(b.dir, { recursive: true, force: true });
  clock.t = 5000;

  b.sync(a);
  a.sync(b);

  assert.deepEqual(b.ids(), ['keep']);
  assert.deepEqual(a.ids(), ['keep']);
});

test('ignores a peer unit whose value does not belong to its key', (t) => {
  const provider = createMemoryProvider(tmpDir(t));

  assert.equal(provider.valid(`${PROJECT}/other-id`, record('note')), null);
  assert.equal(provider.valid(`${PROJECT}/note`, { ...record('note'), type: 'nonsense' }), null);
  assert.equal(provider.valid(`${PROJECT}/note`, record('note')).id, 'note');
  assert.equal(provider.owns('_health/work-pc'), false);
});
