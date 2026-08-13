// Testy czystych funkcji Active-Files Heatmap (ACTIVE_FILES_HEATMAP_PLAN.md
// §5.5, §5.6, §10). Zero DOM - `applyFileEvent`/`shortPath` are pure; the
// widget rendering itself is covered by the manual checklist (plan §13).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFileEvent,
  shortPath,
  clearStaleInProgress,
  applyDeletedFlags,
} = require('../src/renderer/modules/activefiles.js');

const startEv = (file, at = 1000) => ({ phase: 'start', id: 't0', tile: 'Edit', at, file });
const endEv = (file, added, removed, at = 1500) => ({ phase: 'end', id: 't0', tile: 'Edit', at, file, added, removed });

// ---- shortPath ----------------------------------------------------------------

test('shortPath keeps the last two segments of a Windows absolute path', () => {
  assert.equal(shortPath('C:\\Users\\mmazur\\source\\repos\\Luna-Core-HUD\\src\\observer.js'), 'src/observer.js');
});

test('shortPath keeps the last two segments of a POSIX path', () => {
  assert.equal(shortPath('/home/mati/repo/src/observer.js'), 'src/observer.js');
});

test('shortPath on a bare filename returns just the filename', () => {
  assert.equal(shortPath('observer.js'), 'observer.js');
});

test('shortPath on an empty/missing path returns an empty string', () => {
  assert.equal(shortPath(''), '');
  assert.equal(shortPath(undefined), '');
  assert.equal(shortPath(null), '');
});

// ---- applyFileEvent -------------------------------------------------------------

test('applyFileEvent accumulates two edits to the same file into one row', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 3, 1));
  applyFileEvent(map, endEv('a.js', 2, 0));
  assert.equal(map.size, 1);
  const row = map.get('a.js');
  assert.equal(row.added, 5);
  assert.equal(row.removed, 1);
  assert.equal(row.touches, 2);
});

test('applyFileEvent on a start event sets inProgress:true and leaves added/removed untouched', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js'));
  const row = map.get('a.js');
  assert.equal(row.inProgress, true);
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
  assert.equal(row.touches, 0);
});

test('applyFileEvent on the matching end event sets inProgress:false and adds to the stats', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js'));
  applyFileEvent(map, endEv('a.js', 4, 2));
  const row = map.get('a.js');
  assert.equal(row.inProgress, false);
  assert.equal(row.added, 4);
  assert.equal(row.removed, 2);
  assert.equal(row.touches, 1);
});

test('applyFileEvent on a failed/rejected end (0/0 stat) still clears inProgress', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js'));
  applyFileEvent(map, endEv('a.js', 0, 0));
  const row = map.get('a.js');
  assert.equal(row.inProgress, false);
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
});

test('applyFileEvent on a Read (start+end, 0/0) bumps touches and lastAt but leaves added/removed at 0', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js', 1000));
  applyFileEvent(map, endEv('a.js', 0, 0, 1200));
  const row = map.get('a.js');
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
  assert.equal(row.touches, 1);
  assert.equal(row.lastAt, 1200);
});

test('applyFileEvent ignores an event with no file (Bash/Grep)', () => {
  const map = new Map();
  applyFileEvent(map, startEv('', 1000));
  applyFileEvent(map, endEv('', 0, 0, 1200));
  assert.equal(map.size, 0);
});

test('applyFileEvent returns the same map it was given (mutated in place)', () => {
  const map = new Map();
  const out = applyFileEvent(map, endEv('a.js', 1, 0));
  assert.equal(out, map);
});

// ---- clearStaleInProgress (self-heal for a lost end event) --------------------

test('clearStaleInProgress clears a row stuck live past maxAgeMs', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js', 1000));
  const changed = clearStaleInProgress(map, 1000 + 20001, 20000);
  assert.equal(changed, true);
  const row = map.get('a.js');
  assert.equal(row.inProgress, false);
  assert.equal(row.liveSince, 0);
});

test('clearStaleInProgress leaves a recently-started row alone', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js', 1000));
  const changed = clearStaleInProgress(map, 1000 + 5000, 20000);
  assert.equal(changed, false);
  assert.equal(map.get('a.js').inProgress, true);
});

test('clearStaleInProgress is a no-op on a row that already closed normally', () => {
  const map = new Map();
  applyFileEvent(map, startEv('a.js', 1000));
  applyFileEvent(map, endEv('a.js', 3, 1, 1200));
  const changed = clearStaleInProgress(map, 1000 + 999999, 20000);
  assert.equal(changed, false);
  assert.equal(map.get('a.js').inProgress, false);
});

// ---- deleted-file tracking (Mati, 2026-08-13: file deleted after editing) ---

test('applyDeletedFlags marks a row deleted when its path comes back false', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  const changed = applyDeletedFlags(map, { 'a.js': false });
  assert.equal(changed, true);
  assert.equal(map.get('a.js').deleted, true);
  // The stats stay - the edit still happened, only "still there" changed.
  assert.equal(map.get('a.js').added, 6);
  assert.equal(map.get('a.js').removed, 1);
});

test('applyDeletedFlags clears deleted when the path comes back true', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  applyDeletedFlags(map, { 'a.js': false });
  const changed = applyDeletedFlags(map, { 'a.js': true });
  assert.equal(changed, true);
  assert.equal(map.get('a.js').deleted, false);
});

test('applyDeletedFlags leaves a row alone when its path is missing from the result', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  const changed = applyDeletedFlags(map, { 'other.js': false });
  assert.equal(changed, false);
  assert.equal(map.get('a.js').deleted, false);
});

test('applyDeletedFlags is a no-op when nothing actually changed', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  assert.equal(applyDeletedFlags(map, { 'a.js': true }), false);
});

test('applyDeletedFlags on a null/undefined existsMap changes nothing', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  assert.equal(applyDeletedFlags(map, null), false);
  assert.equal(applyDeletedFlags(map, undefined), false);
});

test('applyFileEvent clears a stale deleted flag when the file is touched again', () => {
  const map = new Map();
  applyFileEvent(map, endEv('a.js', 6, 1));
  applyDeletedFlags(map, { 'a.js': false });
  assert.equal(map.get('a.js').deleted, true);
  applyFileEvent(map, endEv('a.js', 1, 0, 2000)); // e.g. Write recreates it
  assert.equal(map.get('a.js').deleted, false);
});
