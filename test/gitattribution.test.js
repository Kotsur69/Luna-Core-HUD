// Tests for per-terminal attribution of git-sourced Active Files rows
// (src/gitattribution.js). The bug this guards: GitFileWatcher reads the whole
// repo, so an idle terminal on the same project showed another terminal's work.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { SessionAttribution, pathKey, ACTIVITY_WINDOW_MS } = require('../src/gitattribution.js');

const F = (name, added = 1, removed = 0) => ({ file: path.resolve('/repo', name), added, removed });
const start = (id) => ({ phase: 'start', id, file: '' });
const end = (id, file = '', added = 0, removed = 0) => ({ phase: 'end', id, file, added, removed });

test('an idle session claims nothing from a repo-wide git emission', () => {
  const s = new SessionAttribution();
  assert.deepEqual(s.attribute([F('a.js')], { now: 100000, foreignEdited: new Set() }), []);
});

test('a file appearing while a tool call is still running is claimed', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('b1')], 1000);
  const own = s.attribute([F('a.js')], { now: 1000 + ACTIVITY_WINDOW_MS * 10, foreignEdited: new Set() });
  assert.equal(own.length, 1);
});

test('a file appearing shortly after a tool call ended is claimed', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('b1'), end('b1')], 1000);
  assert.equal(s.attribute([F('a.js')], { now: 1000 + ACTIVITY_WINDOW_MS - 1, foreignEdited: new Set() }).length, 1);
});

test('activity older than the window does not claim a new file', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('b1'), end('b1')], 1000);
  assert.deepEqual(s.attribute([F('a.js')], { now: 1000 + ACTIVITY_WINDOW_MS + 1, foreignEdited: new Set() }), []);
});

test('a file already present while idle is not claimed later just because the session wakes up', () => {
  const s = new SessionAttribution();
  s.attribute([F('a.js', 3)], { now: 0, foreignEdited: new Set() });
  s.noteToolEvents([start('r1'), end('r1')], 50000);
  assert.deepEqual(s.attribute([F('a.js', 3), F('b.js')], { now: 50001, foreignEdited: new Set() }).map((f) => f.file), [
    F('b.js').file,
  ]);
});

test('a claimed file keeps reporting updated stats after the session goes idle', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('b1'), end('b1')], 1000);
  s.attribute([F('a.js', 1)], { now: 1001, foreignEdited: new Set() });
  const own = s.attribute([F('a.js', 9)], { now: 999999, foreignEdited: new Set() });
  assert.deepEqual(own, [F('a.js', 9)]);
});

test("another session's transcript edit is never claimed, even while busy", () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('b1')], 1000);
  const foreign = new Set([pathKey(F('a.js').file)]);
  assert.deepEqual(s.attribute([F('a.js')], { now: 1001, foreignEdited: foreign }), []);
});

test('own transcript edits are recorded so other sessions can exclude them', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('e1'), end('e1', F('a.js').file, 2, 1)], 1000);
  assert.ok(s.edited.has(pathKey(F('a.js').file)));
});

test('a read (0/0) is not recorded as an edit', () => {
  const s = new SessionAttribution();
  s.noteToolEvents([start('r1'), end('r1', F('a.js').file, 0, 0)], 1000);
  assert.equal(s.edited.size, 0);
});
