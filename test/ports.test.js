// Tests for the port tracker's parsers. We test ONLY text parsing -
// scanPorts() spawns a system shell, so it is not suitable for a unit test.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWindows, parsePosix, dedupeByPort, isSystemPort } = require('../src/ports');

// ---- parseWindows (PowerShell output as JSON) ---------------------------

test('parseWindows handles a single object (ConvertTo-Json does not wrap in an array)', () => {
  const out = parseWindows('{"port":3000,"procId":42,"name":"node","addr":"127.0.0.1"}');
  assert.deepEqual(out, [{ port: 3000, procId: 42, name: 'node' }]);
});

test('parseWindows reads an array and sorts by port number', () => {
  const json = JSON.stringify([
    { port: 8080, procId: 2, name: 'python', addr: '127.0.0.1' },
    { port: 3000, procId: 1, name: 'node', addr: '127.0.0.1' },
  ]);
  assert.deepEqual(parseWindows(json).map((r) => r.port), [3000, 8080]);
});

test('parseWindows rejects addresses outside localhost', () => {
  const json = JSON.stringify([
    { port: 3000, procId: 1, name: 'node', addr: '127.0.0.1' },
    { port: 445, procId: 4, name: 'System', addr: '192.168.1.10' },
  ]);
  assert.deepEqual(parseWindows(json).map((r) => r.port), [3000]);
});

test('parseWindows accepts every form of localhost (IPv4, IPv6, wildcard)', () => {
  const json = JSON.stringify([
    { port: 1, procId: 1, name: 'a', addr: '127.0.0.1' },
    { port: 2, procId: 2, name: 'b', addr: '::1' },
    { port: 3, procId: 3, name: 'c', addr: '0.0.0.0' },
    { port: 4, procId: 4, name: 'd', addr: '::' },
  ]);
  assert.equal(parseWindows(json).length, 4);
});

test('parseWindows deduplicates the same port across multiple interfaces', () => {
  const json = JSON.stringify([
    { port: 3000, procId: 1, name: 'node', addr: '0.0.0.0' },
    { port: 3000, procId: 1, name: 'node', addr: '::' },
  ]);
  assert.equal(parseWindows(json).length, 1);
});

test('parseWindows substitutes "?" for a missing process name', () => {
  const out = parseWindows('{"port":3000,"procId":42,"addr":"127.0.0.1"}');
  assert.equal(out[0].name, '?');
});

test('parseWindows returns an empty list for empty/corrupt input', () => {
  // The ports tile should show "none", not crash the renderer.
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('   \n  '), []);
  assert.deepEqual(parseWindows('this is not JSON'), []);
  assert.deepEqual(parseWindows('{"torn":'), []);
});

// ---- parsePosix (lsof output) ----------------------------------------------

const LSOF = [
  'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node     1234 mmazur   23u  IPv4 0x1111      0t0  TCP 127.0.0.1:3000 (LISTEN)',
  'python     99 mmazur    5u  IPv6 0x2222      0t0  TCP *:8080 (LISTEN)',
].join('\n');

test('parsePosix parses lsof rows and skips the header', () => {
  assert.deepEqual(parsePosix(LSOF), [
    { port: 3000, procId: 1234, name: 'node' },
    { port: 8080, procId: 99, name: 'python' },
  ]);
});

test('parsePosix skips rows with no port at the end of the address', () => {
  const text = 'node 1 u 1u IPv4 0x1 0t0 TCP 127.0.0.1 (LISTEN)';
  assert.deepEqual(parsePosix(text), []);
});

test('parsePosix skips rows that are too short (truncated output)', () => {
  assert.deepEqual(parsePosix('node 1234 mmazur'), []);
});

test('parsePosix returns an empty list for empty input', () => {
  assert.deepEqual(parsePosix(''), []);
});

// ---- dedupeByPort -----------------------------------------------------------

test('dedupeByPort keeps the first occurrence of a port', () => {
  const out = dedupeByPort([
    { port: 3000, procId: 1, name: 'first' },
    { port: 3000, procId: 2, name: 'second' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'first');
});

test('dedupeByPort rejects non-positive ports', () => {
  assert.deepEqual(dedupeByPort([{ port: 0, procId: 1, name: 'x' }]), []);
  assert.deepEqual(dedupeByPort([{ port: -1, procId: 1, name: 'x' }]), []);
});

test('dedupeByPort sorts ascending', () => {
  const out = dedupeByPort([
    { port: 9000, procId: 1, name: 'c' },
    { port: 80, procId: 2, name: 'a' },
    { port: 3000, procId: 3, name: 'b' },
  ]);
  assert.deepEqual(out.map((r) => r.port), [80, 3000, 9000]);
});

// ---- isSystemPort (B5 noise filter) -----------------------------------------
// New tests are in English: the project switched to English comments in 8ddeba0
// and this file is on the list still to be translated.

test('isSystemPort flags known OS process names', () => {
  assert.equal(isSystemPort({ port: 5040, name: 'svchost' }), true);
  assert.equal(isSystemPort({ port: 7680, name: 'System' }), true); // case-insensitive
  assert.equal(isSystemPort({ port: 5000, name: 'ControlCenter' }), false); // dev port wins
});

test('isSystemPort flags the privileged and ephemeral ranges', () => {
  assert.equal(isSystemPort({ port: 135, name: 'unknown' }), true); // < 1024
  assert.equal(isSystemPort({ port: 49664, name: 'unknown' }), true); // >= 49152
  assert.equal(isSystemPort({ port: 4321, name: 'unknown' }), false); // ordinary range
});

test('isSystemPort never hides a well-known dev port', () => {
  // The whole point of the panel: a local server must stay visible even when a
  // range rule would otherwise sweep it away (80/443 are below 1024).
  for (const port of [80, 443, 3000, 5173, 8080, 11434]) {
    assert.equal(isSystemPort({ port, name: 'nginx' }), false, `port ${port}`);
  }
});

test('isSystemPort keeps ordinary dev processes visible', () => {
  assert.equal(isSystemPort({ port: 3000, name: 'node' }), false);
  assert.equal(isSystemPort({ port: 8501, name: 'python' }), false);
});

test('isSystemPort survives junk input', () => {
  assert.equal(isSystemPort(null), false);
  assert.equal(isSystemPort({ port: 3000 }), false); // no name
});
