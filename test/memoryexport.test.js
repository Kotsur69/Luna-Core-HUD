'use strict';

// exportAll(): "Export all" and `luna memory export` (src/memoryexport.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportAll, targetRefusal, MANIFEST_FILE, MANIFEST_KIND } = require('../src/memoryexport');
const { writeRecord, fileFor } = require('../src/memorystore');
const { writeNote, noteFile } = require('../src/memorynote');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const PROJECT = 'github.com/acme/hud';
// A secret-shaped string assembled at runtime: the full shape never appears in the source.
const FAKE_KEY = ['g', 'hp_'].join('') + 'Z'.repeat(36);

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

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A memory mirror with two project memories, one global, a note, a secret memory and a broken file. */
function mirror(t) {
  const dir = tmp(t, 'luna-export-mem-');
  writeRecord(dir, rec('alpha'));
  writeRecord(dir, rec('beta', { type: 'decision' }));
  writeRecord(dir, rec('gamma', { project: 'global' }));
  writeNote(dir, { project: PROJECT, text: 'Release cut, nothing in progress.', date: '2026-11-22', session: 'abc12345' });
  // A memory holding a secret: written as a valid file, then the body gets the key.
  writeRecord(dir, rec('leaky'));
  const leaky = fileFor(dir, `${PROJECT}/leaky`);
  fs.writeFileSync(leaky, fs.readFileSync(leaky, 'utf8').replace('Body of leaky.', `Body with ${FAKE_KEY} inside.`));
  // A memory file that does not parse.
  fs.writeFileSync(path.join(dir, 'projects', 'github.com', 'acme', 'hud', 'broken.md'), 'no frontmatter at all');
  return dir;
}

test('the backup keeps the global/ and projects/ layout, notes included, byte for byte', (t) => {
  const dir = mirror(t);
  const dest = tmp(t, 'luna-export-dest-');
  const res = exportAll({ dir, destDir: dest, now: NOW });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.name, 'lunacore-memory-backup-2026-11-23');
  assert.equal(res.folder, path.join(dest, res.name));
  assert.equal(res.memories, 3);
  assert.equal(res.notes, 1);
  assert.equal(res.files, 4);
  assert.equal(res.projects, 1);
  const out = res.folder;
  for (const rel of ['global/gamma.md', 'projects/github.com/acme/hud/alpha.md', 'projects/github.com/acme/hud/beta.md', 'projects/github.com/acme/hud/_where-we-stopped.md']) {
    assert.ok(fs.existsSync(path.join(out, ...rel.split('/'))), rel);
  }
  assert.equal(
    fs.readFileSync(path.join(out, 'projects', 'github.com', 'acme', 'hud', 'alpha.md'), 'utf8'),
    fs.readFileSync(fileFor(dir, `${PROJECT}/alpha`), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(out, 'projects', 'github.com', 'acme', 'hud', '_where-we-stopped.md'), 'utf8'),
    fs.readFileSync(noteFile(dir, PROJECT), 'utf8'),
  );
});

test('the manifest has the counts, the date and the skipped files; a secret is never copied', (t) => {
  const dir = mirror(t);
  const dest = tmp(t, 'luna-export-dest-');
  const res = exportAll({ dir, destDir: dest, now: NOW });
  assert.equal(res.ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.folder, MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.kind, MANIFEST_KIND);
  assert.equal(manifest.date, '2026-11-23');
  assert.equal(manifest.exportedAt, '2026-11-23T10:00:00.000Z');
  assert.deepEqual(manifest.counts, { memories: 3, global: 1, notes: 1, projects: 1, skipped: 2 });
  assert.deepEqual(
    manifest.skipped.sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: 'projects/github.com/acme/hud/broken.md', reason: 'invalid' },
      { file: 'projects/github.com/acme/hud/leaky.md', reason: 'secret' },
    ],
  );
  assert.equal(res.skippedCount, 2);
  assert.equal(fs.existsSync(path.join(res.folder, 'projects', 'github.com', 'acme', 'hud', 'leaky.md')), false);
  // Nothing in the backup holds the key.
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else all.push(fs.readFileSync(path.join(d, e.name), 'utf8'));
    }
  };
  walk(res.folder);
  assert.equal(all.some((text) => text.includes(FAKE_KEY)), false);
});

test('a note holding a secret is skipped too', (t) => {
  const dir = tmp(t, 'luna-export-mem-');
  writeRecord(dir, rec('alpha'));
  writeNote(dir, { project: PROJECT, text: 'Stopped here.', date: '2026-11-22', session: 'abc12345' });
  const file = noteFile(dir, PROJECT);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Stopped here.', `Stopped here, token ${FAKE_KEY}.`));
  const res = exportAll({ dir, destDir: tmp(t, 'luna-export-dest-'), now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.notes, 0);
  assert.deepEqual(res.skipped, [{ file: 'projects/github.com/acme/hud/_where-we-stopped.md', reason: 'secret' }]);
});

test('a second export the same day never writes into the first one', (t) => {
  const dir = mirror(t);
  const dest = tmp(t, 'luna-export-dest-');
  const first = exportAll({ dir, destDir: dest, now: NOW });
  const second = exportAll({ dir, destDir: dest, now: NOW });
  assert.equal(first.ok && second.ok, true);
  assert.equal(second.name, 'lunacore-memory-backup-2026-11-23-2');
});

test('bad targets are refused before anything is written', (t) => {
  const dir = mirror(t);
  const dest = tmp(t, 'luna-export-dest-');
  const cases = [
    [{ dir: path.join(dest, 'no-such-memory'), destDir: dest }, 'no-memory-dir'],
    [{ dir: undefined, destDir: dest }, 'no-memory-dir'],
    [{ dir, destDir: 'relative/folder' }, 'bad-target'],
    [{ dir, destDir: 42 }, 'bad-target'],
    [{ dir, destDir: `${dest}${path.sep}..${path.sep}${path.basename(dest)}` }, 'bad-target'],
    [{ dir, destDir: path.join(dest, 'missing') }, 'target-missing'],
    [{ dir, destDir: dir }, 'inside-memory-dir'],
    [{ dir, destDir: path.join(dir, 'projects') }, 'inside-memory-dir'],
  ];
  for (const [opts, reason] of cases) {
    assert.deepEqual(exportAll({ ...opts, now: NOW }), { ok: false, reason }, JSON.stringify(opts));
  }
  assert.deepEqual(fs.readdirSync(dest), []);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('lunacore-memory-backup-')), false);
  assert.equal(targetRefusal(dir, dest), null);
});

test('an empty memory folder exports an empty backup with its manifest', (t) => {
  const dir = tmp(t, 'luna-export-mem-');
  const res = exportAll({ dir, destDir: tmp(t, 'luna-export-dest-'), now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.files, 0);
  assert.ok(fs.existsSync(path.join(res.folder, MANIFEST_FILE)));
});
