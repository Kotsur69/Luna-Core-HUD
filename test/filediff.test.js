// Tests for src/filediff.js - the pure unified-diff line classifier behind the
// Active-Files Heatmap's accumulated diff viewer. The git call and the path-
// containment guard live in main.js / src/gitfiles.js (pathInsideCwd, covered
// in gitfiles.test.js); this file is DOM-free and git-free, the same split
// gitfiles.test.js and filestat.test.js already use.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyDiffLine, parseDiff } = require('../src/filediff.js');

// ---- classifyDiffLine -------------------------------------------------------

test('classifyDiffLine tags an added content line', () => {
  assert.equal(classifyDiffLine('+  const x = 1;'), 'add');
});

test('classifyDiffLine tags a removed content line', () => {
  assert.equal(classifyDiffLine('-  const x = 0;'), 'del');
});

test('classifyDiffLine tags a context line (leading space) as ctx', () => {
  assert.equal(classifyDiffLine('  unchanged line'), 'ctx');
});

test('classifyDiffLine tags a @@ hunk header', () => {
  assert.equal(classifyDiffLine('@@ -1,4 +1,6 @@ function f()'), 'hunk');
});

test('classifyDiffLine tags "diff --git" and the file/index headers as meta', () => {
  assert.equal(classifyDiffLine('diff --git a/src/main.js b/src/main.js'), 'meta');
  assert.equal(classifyDiffLine('index 1a2b3c4..5d6e7f8 100644'), 'meta');
  assert.equal(classifyDiffLine('--- a/src/main.js'), 'meta');
  assert.equal(classifyDiffLine('+++ b/src/main.js'), 'meta');
  assert.equal(classifyDiffLine('new file mode 100644'), 'meta');
  assert.equal(classifyDiffLine('deleted file mode 100644'), 'meta');
});

test('classifyDiffLine tags the binary sentinel as meta', () => {
  assert.equal(classifyDiffLine('Binary files a/logo.png and b/logo.png differ'), 'meta');
});

test('classifyDiffLine does not mistake "---"/"+++" headers for del/add', () => {
  assert.notEqual(classifyDiffLine('--- a/x'), 'del');
  assert.notEqual(classifyDiffLine('+++ b/x'), 'add');
});

test('classifyDiffLine on a non-string returns ctx', () => {
  assert.equal(classifyDiffLine(undefined), 'ctx');
  assert.equal(classifyDiffLine(null), 'ctx');
});

// ---- parseDiff ------------------------------------------------------------

const SAMPLE = [
  'diff --git a/a.txt b/a.txt',
  'index e69de29..4b825dc 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n');

test('parseDiff classifies every line and drops the trailing newline element', () => {
  const { lines, truncated } = parseDiff(SAMPLE);
  assert.equal(truncated, false);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add'],
  );
  assert.equal(lines[6].text, '-old');
  assert.equal(lines[7].text, '+new');
});

test('parseDiff on empty / missing input returns no lines, not truncated', () => {
  assert.deepEqual(parseDiff(''), { lines: [], truncated: false });
  assert.deepEqual(parseDiff(undefined), { lines: [], truncated: false });
  assert.deepEqual(parseDiff(null), { lines: [], truncated: false });
});

test('parseDiff keeps a binary diff sentinel as a meta line', () => {
  const out = parseDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n');
  assert.deepEqual(
    out.lines.map((l) => l.kind),
    ['meta', 'meta'],
  );
});

test('parseDiff strips a trailing CR so a CRLF checkout leaves no carriage returns', () => {
  const { lines } = parseDiff('@@ -1 +1 @@\r\n+added\r\n');
  assert.equal(lines[0].text, '@@ -1 +1 @@');
  assert.equal(lines[1].text, '+added');
});

test('parseDiff flags truncation at the char boundary and still classifies the partial tail', () => {
  const line = '+xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'; // 31 chars incl newline
  const big = line.repeat(50); // 1550 chars
  const { lines, truncated } = parseDiff(big, 100);
  assert.equal(truncated, true);
  // 100 chars / 31 per line = 3 whole lines + a partial 4th
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.kind === 'add'));
});

test('parseDiff with no cap (maxChars 0 or omitted) never truncates', () => {
  const big = '+x\n'.repeat(10000);
  assert.equal(parseDiff(big, 0).truncated, false);
  assert.equal(parseDiff(big).truncated, false);
});
