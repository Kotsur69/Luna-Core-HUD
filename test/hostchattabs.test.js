// ============================================================================
// LunaCore - phone-driven host sessions as read-only HUD tabs (src/hostchattabs.js)
// ----------------------------------------------------------------------------
// A phone session opens one tab on its first event, every event is written
// as terminal text (escapes from model output stripped), the end marks the
// tab ended but leaves it open, and a closed tab reopens on new events.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostChatTabs, formatEvent, readOnlySession } = require('../src/hostchattabs');

function setup() {
  const open = new Set();
  const writes = [];
  const ended = [];
  let n = 0;
  const tabs = createHostChatTabs({
    open: (name) => {
      const id = `s${++n}`;
      open.add(id);
      writes.push([id, `<open ${name}>`]);
      return id;
    },
    isOpen: (id) => open.has(id),
    write: (id, data) => writes.push([id, data]),
    end: (id) => ended.push(id),
  });
  return { tabs, open, writes, ended };
}

test('first event opens one tab per phone session; events go to it', () => {
  const { tabs, writes } = setup();
  tabs.onEvent('A', 'prompt', { text: 'hi' }, { name: 'luna' });
  tabs.onEvent('A', 'text', { text: 'Hello\nthere' }, { name: 'luna' });
  tabs.onEvent('B', 'status', { status: 'working' }, { name: 'other' });
  assert.deepEqual(writes.filter((w) => w[1].startsWith('<open')).map((w) => w[0]), ['s1', 's2']);
  assert.ok(writes.some(([id, d]) => id === 's1' && d.includes('Driven from phone')));
  assert.ok(writes.some(([id, d]) => id === 's1' && d === 'Hello\r\nthere'));
});

test('the end marks the tab ended and keeps it; a turn being done does not', () => {
  const { tabs, ended, open } = setup();
  tabs.onEvent('A', 'status', { status: 'done' }, { name: 'luna' });
  assert.deepEqual(ended, []);
  tabs.onEvent('A', 'status', { status: 'done', reason: 'ended' }, { name: 'luna' });
  assert.deepEqual(ended, ['s1']);
  assert.ok(open.has('s1'), 'stays open until closed by hand');
});

test('a tab closed by hand reopens when the session goes on', () => {
  const { tabs, open, writes } = setup();
  tabs.onEvent('A', 'text', { text: 'x' }, { name: 'luna' });
  open.delete('s1');
  tabs.onEvent('A', 'text', { text: 'y' }, { name: 'luna' });
  assert.deepEqual(writes.at(-1), ['s2', 'y']);
});

test('model output cannot inject terminal escapes', () => {
  assert.equal(formatEvent('text', { text: 'a\x1b]0;evil\x07b' }), 'a]0;evilb');
  assert.equal(formatEvent('unknown', {}), '');
  assert.match(formatEvent('permission', { tool: 'Bash', summary: 'ls' }, 'pl'), /Zgoda: Bash ls/);
});

test('attach follows a chat and detaches', () => {
  const { tabs, writes } = setup();
  let listener = null;
  const chat = {
    onEvent: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const detach = tabs.attach(chat);
  listener('A', 'text', { text: 'hi' }, { name: 'luna' });
  assert.ok(writes.length > 0);
  detach();
  assert.equal(listener, null);
});

test('readOnlySession has no process and is flagged', () => {
  const s = readOnlySession('s9', 'luna');
  assert.equal(s.proc, null);
  assert.equal(s.readOnly, true);
  assert.equal(s.cwd, 'luna');
});
