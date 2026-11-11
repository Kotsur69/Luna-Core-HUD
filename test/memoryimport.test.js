// ============================================================================
// LunaCore - Claude Code auto-memory -> memory mirror (src/memoryimport.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { importAutoMemory, autoMemoryDir } = require('../src/memoryimport.js');
const { scan, fileFor } = require('../src/memorystore.js');

const PROJECT = 'github.com/acme/demo';

const auto = (name, type, body) =>
  ['---', `name: ${name}`, `description: About ${name}`, 'metadata:', `  type: ${type}`, '  modified: 2026-11-05T08:15:10.487Z', '---', '', body].join('\n');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-import-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const from = path.join(root, 'auto');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'MEMORY.md'), '- [One](one.md) - the index is not a memory\n');
  fs.writeFileSync(path.join(from, 'one.md'), auto('one', 'project', 'First fact. See [[two]].'));
  fs.writeFileSync(path.join(from, 'two.md'), auto('two', 'feedback', 'Second fact.'));
  return { from, dir: path.join(root, 'memory') };
}

test('imports every auto-memory file except the index', (t) => {
  const { from, dir } = setup(t);

  const res = importAutoMemory({ from, dir, project: PROJECT });

  assert.deepEqual(res, { imported: [`${PROJECT}/one`, `${PROJECT}/two`], kept: [], failed: [] });
  const records = Object.fromEntries(scan(dir).records);
  assert.equal(records[`${PROJECT}/one`].confidence, 'confirmed');
  assert.deepEqual(records[`${PROJECT}/one`].links, ['two']);
  assert.equal(records[`${PROJECT}/two`].type, 'preference');
});

test('a second import keeps what the mirror already holds', (t) => {
  const { from, dir } = setup(t);
  importAutoMemory({ from, dir, project: PROJECT });
  const file = fileFor(dir, `${PROJECT}/one`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First fact.', 'Edited in the mirror.'));

  const res = importAutoMemory({ from, dir, project: PROJECT });

  assert.deepEqual(res.imported, []);
  assert.deepEqual(res.kept, [`${PROJECT}/one`, `${PROJECT}/two`]);
  assert.match(fs.readFileSync(file, 'utf8'), /Edited in the mirror\./);
});

test('force overwrites the mirror copy', (t) => {
  const { from, dir } = setup(t);
  importAutoMemory({ from, dir, project: PROJECT });
  const file = fileFor(dir, `${PROJECT}/one`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First fact.', 'Edited in the mirror.'));

  const res = importAutoMemory({ from, dir, project: PROJECT, force: true });

  assert.equal(res.imported.length, 2);
  assert.match(fs.readFileSync(file, 'utf8'), /First fact\./);
});

test('one bad file is reported and does not stop the rest', (t) => {
  const { from, dir } = setup(t);
  fs.writeFileSync(path.join(from, 'broken.md'), 'no frontmatter');
  fs.writeFileSync(path.join(from, 'huge.md'), auto('huge', 'project', 'x'.repeat(6000)));

  const res = importAutoMemory({ from, dir, project: PROJECT });

  assert.equal(res.imported.length, 2);
  assert.deepEqual(res.failed, [
    { file: 'broken.md', error: 'no-frontmatter' },
    { file: 'huge.md', error: 'body-too-long' },
  ]);
});

test('finds the auto-memory folder Claude Code uses for a working directory', () => {
  const cwd = path.resolve('some repo', 'Luna-Core_HUD');

  const dir = autoMemoryDir(cwd, path.resolve('home'));

  assert.equal(path.basename(dir), 'memory');
  assert.equal(path.basename(path.dirname(dir)), cwd.replace(/[^A-Za-z0-9]/g, '-'));
  assert.equal(path.dirname(path.dirname(dir)), path.join(path.resolve('home'), '.claude', 'projects'));
});
