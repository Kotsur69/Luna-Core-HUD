// Tests for the early pty data buffer (src/renderer/modules/earlypty.js):
// 'pty:data' that arrives before the terminal host is mounted must be shown
// once the pane mounts - not lost - and the buffer must stay bounded.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEarlyPtyBuffer,
  DEFAULT_MAX_CHARS_PER_SESSION,
} = require('../src/renderer/modules/earlypty.js');

/**
 * Mimics sessions.js: data is parked while the host is unmounted and written
 * straight through afterwards; mounting replays the parked data once.
 */
function makeHarness(opts) {
  const buffer = createEarlyPtyBuffer(opts);
  const written = new Map();
  const exits = [];
  let mounted = false;
  const write = (id, data) => written.set(id, (written.get(id) || '') + data);
  return {
    written,
    exits,
    buffer,
    onData(id, data) {
      if (!mounted) buffer.pushData(id, data);
      else write(id, data);
    },
    onExit(id, code) {
      if (!mounted) buffer.pushExit(id, code);
      else exits.push({ id, code });
    },
    mount() {
      mounted = true;
      for (const entry of buffer.drain()) {
        if (entry.data) write(entry.sessionId, entry.data);
        if (entry.hasExit) exits.push({ id: entry.sessionId, code: entry.exitCode });
      }
    },
  };
}

test('data that arrives before mount is shown once the pane mounts', () => {
  const h = makeHarness();
  h.onData('s1', 'Welcome ');
  h.onData('s1', 'to Claude');
  assert.equal(h.written.size, 0, 'nothing is written before mount');
  h.mount();
  assert.equal(h.written.get('s1'), 'Welcome to Claude');
});

test('early data is replayed exactly once and later data follows in order', () => {
  const h = makeHarness();
  h.onData('s1', 'a');
  h.mount();
  h.onData('s1', 'b');
  h.mount(); // a second flush must not duplicate anything
  assert.equal(h.written.get('s1'), 'ab');
  assert.equal(h.buffer.size(), 0);
});

test('sessions are kept apart', () => {
  const h = makeHarness();
  h.onData('s1', 'one');
  h.onData('s2', 'two');
  h.onData('s1', '!');
  h.mount();
  assert.equal(h.written.get('s1'), 'one!');
  assert.equal(h.written.get('s2'), 'two');
});

test('an early exit is replayed after that session\'s data', () => {
  const h = makeHarness();
  h.onData('s1', 'bye');
  h.onExit('s1', 0);
  h.mount();
  assert.equal(h.written.get('s1'), 'bye');
  assert.deepEqual(h.exits, [{ id: 's1', code: 0 }]);
});

test('per-session buffer is bounded and keeps the newest output', () => {
  const buffer = createEarlyPtyBuffer({ maxCharsPerSession: 10 });
  buffer.pushData('s1', '0123456');
  buffer.pushData('s1', '789abcdef');
  assert.equal(buffer.size(), 10);
  const [entry] = buffer.drain();
  assert.equal(entry.data, '6789abcdef');
});

test('a single oversized chunk is trimmed to the cap', () => {
  const buffer = createEarlyPtyBuffer({ maxCharsPerSession: 4 });
  buffer.pushData('s1', 'abcdefgh');
  assert.equal(buffer.drain()[0].data, 'efgh');
});

test('the number of tracked sessions is bounded', () => {
  const buffer = createEarlyPtyBuffer({ maxSessions: 2 });
  assert.equal(buffer.pushData('s1', 'a'), true);
  assert.equal(buffer.pushData('s2', 'b'), true);
  assert.equal(buffer.pushData('s3', 'c'), false);
  assert.equal(buffer.pushData('s1', 'more'), true, 'known sessions still accept data');
  assert.deepEqual(buffer.drain().map((e) => e.sessionId), ['s1', 's2']);
});

test('non-string or empty chunks are ignored', () => {
  const buffer = createEarlyPtyBuffer();
  assert.equal(buffer.pushData('s1', ''), false);
  assert.equal(buffer.pushData('s1', undefined), false);
  assert.deepEqual(buffer.drain(), []);
});

test('the default cap is a sane positive number', () => {
  assert.ok(DEFAULT_MAX_CHARS_PER_SESSION > 0);
  const buffer = createEarlyPtyBuffer();
  buffer.pushData('s1', 'x'.repeat(DEFAULT_MAX_CHARS_PER_SESSION + 5));
  assert.equal(buffer.size(), DEFAULT_MAX_CHARS_PER_SESSION);
});
