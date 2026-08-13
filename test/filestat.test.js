// Testy czystych funkcji ekstrakcji statystyk diffa dla Active-Files Heatmap
// (ACTIVE_FILES_HEATMAP_PLAN.md §3.1, §10). Zero I/O - dziala na obiektach
// juz sparsowanych z JSONL, tak jak reszta observer.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countPatch,
  countLines,
  countStringDiff,
  fileStatFromEntry,
  MAX_DIFF_LINES,
} = require('../src/filestat');

// ---- countPatch -------------------------------------------------------------

test('countPatch sums +/- across multiple hunks and ignores context lines', () => {
  const patch = [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' ctx', '+add1', '-rem1'] },
    { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: ['+add2', '+add3', ' ctx2'] },
  ];
  assert.deepEqual(countPatch(patch), { added: 3, removed: 1 });
});

test('countPatch ignores a "\\ No newline at end of file" line', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+add', '\\ No newline at end of file'] }];
  assert.deepEqual(countPatch(patch), { added: 1, removed: 0 });
});

test('countPatch on [] / undefined / garbage returns {0,0}', () => {
  assert.deepEqual(countPatch([]), { added: 0, removed: 0 });
  assert.deepEqual(countPatch(undefined), { added: 0, removed: 0 });
  assert.deepEqual(countPatch('not an array'), { added: 0, removed: 0 });
  assert.deepEqual(countPatch(null), { added: 0, removed: 0 });
});

// ---- countLines ---------------------------------------------------------------

test('countLines on empty string is 0', () => {
  assert.equal(countLines(''), 0);
});

test('countLines counts N for a file ending in a newline, not N+1', () => {
  assert.equal(countLines('a\nb\nc\n'), 3);
});

test('countLines counts a file with no trailing newline correctly', () => {
  assert.equal(countLines('a\nb\nc'), 3);
});

// ---- countStringDiff -----------------------------------------------------------

test('countStringDiff reports +1 -1 for a one-line change inside a 5-line block', () => {
  const oldString = 'a\nb\nc\nd\ne';
  const newString = 'a\nb\nCHANGED\nd\ne';
  assert.deepEqual(countStringDiff(oldString, newString), { added: 1, removed: 1 });
});

test('countStringDiff above MAX_DIFF_LINES falls back to whole-block count without hanging', () => {
  const big = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `line${i}`).join('\n');
  const other = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `other${i}`).join('\n');
  const start = Date.now();
  const result = countStringDiff(big, other);
  assert.ok(Date.now() - start < 2000, 'must not hang on the O(n*m) table');
  assert.deepEqual(result, { added: MAX_DIFF_LINES + 5, removed: MAX_DIFF_LINES + 10 });
});

// ---- fileStatFromEntry -----------------------------------------------------------

test('fileStatFromEntry prefers structuredPatch over oldString/newString when both present', () => {
  const obj = {
    filePath: 'C:\\repo\\src\\main.js',
    oldString: 'a\nb\nc\nd\ne',
    newString: 'a\nb\nCHANGED\nd\ne',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+one', '+two', '-three'] }],
  };
  assert.deepEqual(fileStatFromEntry(obj), { file: 'C:\\repo\\src\\main.js', added: 2, removed: 1 });
});

test('fileStatFromEntry on type:create with empty patch counts all-additions from content', () => {
  const obj = { type: 'create', filePath: 'C:\\repo\\new.md', content: 'line1\nline2\nline3\n', structuredPatch: [], originalFile: null };
  assert.deepEqual(fileStatFromEntry(obj), { file: 'C:\\repo\\new.md', added: 3, removed: 0 });
});

test('fileStatFromEntry on type:update uses the real structuredPatch, not the whole file', () => {
  const obj = {
    type: 'update',
    filePath: 'C:\\repo\\existing.md',
    content: 'whole new file content spanning many lines\nline2\nline3\n',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+onlyline'] }],
  };
  assert.deepEqual(fileStatFromEntry(obj), { file: 'C:\\repo\\existing.md', added: 1, removed: 0 });
});

test('fileStatFromEntry on a Read entry (nested file.filePath) returns touch-only {0,0}', () => {
  const obj = { type: 'text', file: { filePath: 'C:\\repo\\README.md', content: '...', numLines: 10, totalLines: 10 } };
  assert.deepEqual(fileStatFromEntry(obj), { file: 'C:\\repo\\README.md', added: 0, removed: 0 });
});

test('fileStatFromEntry on a failed Edit (toolUseResult is an error string) returns null', () => {
  assert.equal(fileStatFromEntry('Error: file has been modified since last read'), null);
});

test('fileStatFromEntry on an entry with no filePath returns null', () => {
  assert.equal(fileStatFromEntry({ structuredPatch: [] }), null);
  assert.equal(fileStatFromEntry({}), null);
  assert.equal(fileStatFromEntry(null), null);
  assert.equal(fileStatFromEntry(undefined), null);
});
