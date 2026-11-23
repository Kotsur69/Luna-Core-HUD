// ============================================================================
// LunaCore - repo doc chunks for memory_search (src/memorydocs.js)
// ----------------------------------------------------------------------------
// Heading chunking, the size cap, the mtime cache, the skip rules and path
// safety, against a real temp folder standing in for a mapped repo.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDocSource, chunkMarkdown, docKey, isDocKey, parseDocKey, MAX_CHUNK_CHARS, MAX_FILE_BYTES } = require('../src/memorydocs.js');

const PROJECT = 'github.com/acme/hud';

function repo(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memdocs-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

const sourceFor = (root) => createDocSource({ resolveRoot: (project) => (project === PROJECT ? root : null) });
const filesOf = (chunks) => [...new Set(chunks.map((c) => c.file))].sort();

// ---- heading chunking -------------------------------------------------------

test('a file is cut at #, ## and ### headings with 1-based line ranges', () => {
  const text = ['# Title', 'intro', '', '## Install', 'run it', '### Deep', 'detail', '#### Not a cut', 'still deep'].join('\n');

  const chunks = chunkMarkdown(text, 'README.md');

  assert.deepEqual(
    chunks.map((c) => [c.heading, c.startLine, c.endLine]),
    [
      ['Title', 1, 3],
      ['Install', 4, 5],
      ['Deep', 6, 9],
    ],
  );
  assert.ok(chunks.every((c) => c.file === 'README.md'));
  assert.match(chunks[2].text, /#### Not a cut/);
});

test('text before the first heading is a chunk named after the file', () => {
  const chunks = chunkMarkdown('just words\nmore words\n# Later\nbody', 'docs/reference/NOTES.md');

  assert.deepEqual(
    chunks.map((c) => [c.heading, c.startLine, c.endLine]),
    [
      ['NOTES.md', 1, 2],
      ['Later', 3, 4],
    ],
  );
});

test('a # line inside a fenced code block is not a heading', () => {
  const text = ['# Real', '```sh', '# a comment, not a heading', '```', '## Next', 'x'].join('\n');

  const chunks = chunkMarkdown(text, 'README.md');

  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['Real', 'Next'],
  );
});

test('CRLF files and a BOM chunk the same as LF', () => {
  const lf = chunkMarkdown('# A\nx\n## B\ny', 'README.md');
  const crlf = chunkMarkdown(String.fromCharCode(0xfeff) + '# A\r\nx\r\n## B\r\ny', 'README.md');

  assert.deepEqual(crlf, lf);
});

test('the newline that ends a file is not a line of its own', () => {
  const [chunk] = chunkMarkdown('# A\nx\n', 'README.md');

  assert.deepEqual([chunk.startLine, chunk.endLine], [1, 2]);
  assert.equal(chunk.text, '# A\nx');
});

test('empty sections make no chunk', () => {
  assert.deepEqual(chunkMarkdown('', 'README.md'), []);
  assert.deepEqual(chunkMarkdown('\n\n  \n', 'README.md'), []);
});

// ---- the size cap -------------------------------------------------------------

test('a long section is cut at line breaks into chunks of at most the cap', () => {
  const line = 'word '.repeat(19).trim(); // 94 characters
  const body = Array.from({ length: 60 }, () => line);
  const text = ['# Big', ...body].join('\n');

  const chunks = chunkMarkdown(text, 'README.md');

  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= MAX_CHUNK_CHARS, `chunk of ${c.text.length} chars`);
    assert.equal(c.heading, 'Big');
  }
  // The pieces are consecutive and cover every line once.
  assert.equal(chunks[0].startLine, 1);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1);
  assert.equal(chunks.at(-1).endLine, 61);
  assert.equal(chunks.map((c) => c.text).join('\n'), text);
});

test('a single line longer than the cap is sliced, each slice within the cap', () => {
  const chunks = chunkMarkdown(`# Blob\n${'x'.repeat(MAX_CHUNK_CHARS * 2 + 50)}\nafter`, 'README.md');

  assert.ok(chunks.every((c) => c.text.length <= MAX_CHUNK_CHARS));
  assert.equal(chunks.filter((c) => c.startLine === 2 && c.endLine === 2).length, 3);
  assert.equal(chunks.at(-1).text, 'after');
});

// ---- discovery and skip rules -----------------------------------------------

test('only README, CLAUDE, docs/reference and docs/tbc_docs markdown is read', (t) => {
  const root = repo(t, {
    'README.md': '# Readme\nhello',
    'CLAUDE.md': '# Claude\nrules',
    'docs/reference/A.md': '# A\nx',
    'docs/tbc_docs/B.md': '# B\ny',
    'docs/done_docs/C.md': '# C\nz',
    'docs/reference/notes.txt': 'not markdown',
    'docs/reference/sub/D.md': '# D\nnested',
    'src/E.md': '# E\nelsewhere',
  });

  const { chunks } = sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(filesOf(chunks), ['CLAUDE.md', 'README.md', 'docs/reference/A.md', 'docs/tbc_docs/B.md']);
  assert.ok(chunks.every((c) => c.project === PROJECT && c.key === docKey(PROJECT, c)));
});

test('.local. files and files over 512 KB are skipped', (t) => {
  const root = repo(t, {
    'README.md': '# Readme\nhello',
    'CLAUDE.local.md': '# Private\nsecret notes',
    'docs/reference/PLAN.local.md': '# Plan\nprivate',
    'docs/reference/Big.md': `# Big\n${'a'.repeat(MAX_FILE_BYTES)}`,
    'docs/reference/Edge.md': `# Edge\n${'b\n'.repeat(10)}`,
  });

  const { chunks } = sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(filesOf(chunks), ['README.md', 'docs/reference/Edge.md']);
});

test('a project with no mapped folder, or a folder with no docs, has no chunks', (t) => {
  const empty = repo(t, { 'package.json': '{}' });

  assert.deepEqual(sourceFor(empty).chunksFor('github.com/acme/other'), { chunks: [], signature: '' });
  assert.deepEqual(sourceFor(empty).chunksFor(PROJECT).chunks, []);
  assert.deepEqual(sourceFor(path.join(empty, 'missing')).chunksFor(PROJECT).chunks, []);
  assert.deepEqual(createDocSource({}).chunksFor(PROJECT).chunks, []);
  assert.deepEqual(createDocSource({ resolveRoot: () => null }).chunksFor(PROJECT).chunks, []);
});

test('a resolver that throws gives no chunks and does not throw', (t) => {
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  t.after(() => {
    console.error = original;
  });
  const source = createDocSource({
    resolveRoot: () => {
      throw new Error('boom');
    },
  });

  assert.deepEqual(source.chunksFor(PROJECT).chunks, []);
  assert.equal(errors.length, 1);
});

test('files under node_modules are never read, even through a docs folder that points there', (t) => {
  const root = repo(t, { 'README.md': '# Readme\nhello', 'node_modules/pkg/docs/reference/X.md': '# X\ndep docs' });
  try {
    fs.symlinkSync(path.join(root, 'node_modules', 'pkg', 'docs'), path.join(root, 'docs'), 'junction');
  } catch {
    t.skip('cannot create a junction here');
    return;
  }

  const { chunks } = sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(filesOf(chunks), ['README.md']);
});

// ---- path safety --------------------------------------------------------------

test('a doc file that is a link leaving the repo root is not read', (t) => {
  const outside = repo(t, { 'secret.md': '# Secret\noutside the repo' });
  const root = repo(t, { 'README.md': '# Readme\nhello' });
  fs.mkdirSync(path.join(root, 'docs'));
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'CLAUDE.md'), 'file');
  } catch {
    t.skip('cannot create a symlink here');
    return;
  }

  const { chunks } = sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(filesOf(chunks), ['README.md']);
});

test('a docs folder that is a link leaving the repo root is not read', (t) => {
  const outside = repo(t, { 'reference/Leak.md': '# Leak\noutside the repo' });
  const root = repo(t, { 'README.md': '# Readme\nhello' });
  try {
    fs.symlinkSync(outside, path.join(root, 'docs'), 'junction');
  } catch {
    t.skip('cannot create a junction here');
    return;
  }

  const { chunks } = sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(filesOf(chunks), ['README.md']);
});

test('doc keys parse only for the allowed files and cannot name another path', () => {
  const chunk = { file: 'docs/reference/ENGINEERING_NOTES.md', startLine: 3, endLine: 9 };
  const key = docKey(PROJECT, chunk);

  assert.equal(key, `doc:${PROJECT}/docs/reference/ENGINEERING_NOTES.md#L3-L9`);
  assert.equal(isDocKey(key), true);
  assert.deepEqual(parseDocKey(key), { project: PROJECT, ...chunk });
  assert.deepEqual(parseDocKey(`doc:${PROJECT}/README.md#L1-L2`), { project: PROJECT, file: 'README.md', startLine: 1, endLine: 2 });

  for (const bad of [
    `doc:${PROJECT}/../../etc/passwd#L1-L2`,
    `doc:${PROJECT}/docs/reference/../../secret.md#L1-L2`,
    `doc:${PROJECT}/docs/reference/a\\b.md#L1-L2`,
    `doc:${PROJECT}/src/main.js#L1-L2`,
    `doc:${PROJECT}/CLAUDE.local.md#L1-L2`,
    `doc:${PROJECT}/README.md`,
    'doc:',
    null,
    42,
  ]) {
    assert.equal(parseDocKey(bad), null, String(bad));
  }
});

// ---- the cache ----------------------------------------------------------------

test('chunks are cached by path and mtime, and rebuilt when the file changes', (t) => {
  const root = repo(t, { 'README.md': '# One\nfirst' });
  const source = sourceFor(root);
  const file = path.join(root, 'README.md');

  const first = source.chunksFor(PROJECT);
  const again = source.chunksFor(PROJECT);
  assert.equal(again.chunks[0], first.chunks[0], 'an untouched file is served from the cache');
  assert.equal(again.signature, first.signature);

  fs.writeFileSync(file, '# Two\nsecond, and longer');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(file, later, later);

  const changed = source.chunksFor(PROJECT);
  assert.equal(changed.chunks[0].heading, 'Two');
  assert.notEqual(changed.signature, first.signature);
});

test('the cache is not written to disk: the repo folder gains no files', (t) => {
  const root = repo(t, { 'README.md': '# One\nfirst' });
  const before = fs.readdirSync(root);

  sourceFor(root).chunksFor(PROJECT);

  assert.deepEqual(fs.readdirSync(root), before);
});

test('get finds a chunk by its key and returns null once the file changed under it', (t) => {
  const root = repo(t, { 'README.md': '# One\nfirst' });
  const source = sourceFor(root);
  const [chunk] = source.chunksFor(PROJECT).chunks;

  assert.equal(source.get(chunk.key).text, '# One\nfirst');

  fs.writeFileSync(path.join(root, 'README.md'), '# One\nfirst\nand a new line');
  assert.equal(source.get(chunk.key), null);
  assert.equal(source.get('doc:nonsense'), null);
});

// ---- review fixes ---------------------------------------------------------------

test('the slices of one over-long line get distinct keys and each can be read by key', (t) => {
  const root = repo(t, { 'README.md': `# Blob\n${'x'.repeat(MAX_CHUNK_CHARS * 2 + 50)}\n` });
  const source = sourceFor(root);

  const chunks = source.chunksFor(PROJECT).chunks.filter((c) => c.startLine === 2);

  assert.equal(chunks.length, 3);
  assert.equal(new Set(chunks.map((c) => c.key)).size, 3);
  for (const c of chunks) {
    assert.ok(parseDocKey(c.key), c.key);
    assert.equal(source.get(c.key).text, c.text);
  }
});

test('a file that failed to read changes the signature, so the index is rebuilt when it reads again', (t) => {
  const root = repo(t, { 'README.md': '# One\nfirst', 'CLAUDE.md': '# Two\nsecond' });
  let failing = true;
  const flaky = {
    ...fs,
    readFileSync: (file, ...rest) => {
      if (failing && String(file).endsWith('CLAUDE.md')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.readFileSync(file, ...rest);
    },
  };
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const source = createDocSource({ resolveRoot: () => root, fsImpl: flaky });

  const during = source.chunksFor(PROJECT);
  failing = false;
  const after = source.chunksFor(PROJECT);

  assert.deepEqual(filesOf(during.chunks), ['README.md']);
  assert.notEqual(after.signature, during.signature);
  assert.deepEqual(filesOf(after.chunks), ['CLAUDE.md', 'README.md']);
});

test('a project folder is resolved once per few seconds, then again', (t) => {
  const root = repo(t, { 'README.md': '# One\nfirst' });
  let calls = 0;
  let clock = 1000;
  const source = createDocSource({
    resolveRoot: () => {
      calls++;
      return root;
    },
    now: () => clock,
  });

  source.chunksFor(PROJECT);
  source.chunksFor(PROJECT);
  assert.equal(calls, 1);
  clock += 6000;
  source.chunksFor(PROJECT);
  assert.equal(calls, 2);
});

test('a .md link whose target is not markdown is not read', (t) => {
  const root = repo(t, { 'README.md': '# Readme\nhello', '.env': 'TOKEN=abc' });
  try {
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'CLAUDE.md'), 'file');
  } catch {
    t.skip('cannot create a symlink here');
    return;
  }

  assert.deepEqual(filesOf(sourceFor(root).chunksFor(PROJECT).chunks), ['README.md']);
});
