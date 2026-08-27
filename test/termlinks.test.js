// parseFileLinks() - the pure detection half of the clickable file:line
// feature (src/renderer/modules/termlinks.js). The xterm link provider and the
// spawn are covered by the manual checklist; this is the logic worth pinning:
// a token that stops being detected, or a URL that wrongly turns into a link,
// leaves nothing on screen to catch by eye.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFileLinks } = require('../src/renderer/modules/termlinks.js');

test('a single src/foo.js:123 token -> one match, line 123, no column', () => {
  const hits = parseFileLinks('  edited src/foo.js:123 ok');
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.file, 'src/foo.js');
  assert.equal(h.line, 123);
  assert.equal(h.col, null);
  assert.equal(h.startIndex, 9);
  assert.equal(h.length, 'src/foo.js:123'.length);
});

test('two tokens on one line -> two matches with the right columns', () => {
  const hits = parseFileLinks('./a/b.ts:45:12 and lib/c.rs:9');
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => [h.file, h.line, h.col]),
    [
      ['./a/b.ts', 45, 12],
      ['lib/c.rs', 9, null],
    ]
  );
});

test('an https URL with a port is not a link', () => {
  assert.deepEqual(parseFileLinks('see https://example.com:443/x for details'), []);
});

test('a bracketed [12:34:56] timestamp is not a link', () => {
  assert.deepEqual(parseFileLinks('[12:34:56] done'), []);
});

test('a bare Makefile:10 (no ext, no separator) is not a link', () => {
  assert.deepEqual(parseFileLinks('Makefile:10'), []);
});

test('./Makefile:10 (has a separator) IS a link', () => {
  const hits = parseFileLinks('./Makefile:10');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, './Makefile');
  assert.equal(hits[0].line, 10);
  assert.equal(hits[0].col, null);
});

test('a Windows path with a drive letter keeps the drive in the file field', () => {
  const hits = parseFileLinks('at C:\\proj\\src\\x.js:7 now');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'C:\\proj\\src\\x.js');
  assert.equal(hits[0].line, 7);
  assert.equal(hits[0].col, null);
});

test('a backslash-relative path is detected', () => {
  const hits = parseFileLinks('a\\b\\c.py:12:3');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'a\\b\\c.py');
  assert.equal(hits[0].line, 12);
  assert.equal(hits[0].col, 3);
});

test('grep -n style output x.js:12:match is detected', () => {
  const hits = parseFileLinks('src/util.js:12:  return null;');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'src/util.js');
  assert.equal(hits[0].line, 12);
  assert.equal(hits[0].col, null);
});

test('trailing sentence punctuation is not swallowed', () => {
  const hits = parseFileLinks('the bug is in src/main.js:1463.');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'src/main.js');
  assert.equal(hits[0].line, 1463);
});

test('junk input returns an empty array', () => {
  assert.deepEqual(parseFileLinks(''), []);
  assert.deepEqual(parseFileLinks(null), []);
  assert.deepEqual(parseFileLinks(undefined), []);
  assert.deepEqual(parseFileLinks('no links here at all'), []);
});
