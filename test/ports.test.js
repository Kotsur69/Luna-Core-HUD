// Testy parserow trackera portow. Testujemy WYLACZNIE parsowanie tekstu -
// scanPorts() odpala powloke systemowa, wiec nie nadaje sie do testu jednostkowego.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWindows, parsePosix, dedupeByPort } = require('../src/ports');

// ---- parseWindows (wyjscie PowerShella jako JSON) ---------------------------

test('parseWindows radzi sobie z pojedynczym obiektem (ConvertTo-Json nie opakowuje w tablice)', () => {
  const out = parseWindows('{"port":3000,"procId":42,"name":"node","addr":"127.0.0.1"}');
  assert.deepEqual(out, [{ port: 3000, procId: 42, name: 'node' }]);
});

test('parseWindows czyta tablice i sortuje po numerze portu', () => {
  const json = JSON.stringify([
    { port: 8080, procId: 2, name: 'python', addr: '127.0.0.1' },
    { port: 3000, procId: 1, name: 'node', addr: '127.0.0.1' },
  ]);
  assert.deepEqual(parseWindows(json).map((r) => r.port), [3000, 8080]);
});

test('parseWindows odrzuca adresy spoza localhosta', () => {
  const json = JSON.stringify([
    { port: 3000, procId: 1, name: 'node', addr: '127.0.0.1' },
    { port: 445, procId: 4, name: 'System', addr: '192.168.1.10' },
  ]);
  assert.deepEqual(parseWindows(json).map((r) => r.port), [3000]);
});

test('parseWindows akceptuje wszystkie formy localhosta (IPv4, IPv6, wildcard)', () => {
  const json = JSON.stringify([
    { port: 1, procId: 1, name: 'a', addr: '127.0.0.1' },
    { port: 2, procId: 2, name: 'b', addr: '::1' },
    { port: 3, procId: 3, name: 'c', addr: '0.0.0.0' },
    { port: 4, procId: 4, name: 'd', addr: '::' },
  ]);
  assert.equal(parseWindows(json).length, 4);
});

test('parseWindows deduplikuje ten sam port na wielu interfejsach', () => {
  const json = JSON.stringify([
    { port: 3000, procId: 1, name: 'node', addr: '0.0.0.0' },
    { port: 3000, procId: 1, name: 'node', addr: '::' },
  ]);
  assert.equal(parseWindows(json).length, 1);
});

test('parseWindows podstawia "?" za brakujaca nazwe procesu', () => {
  const out = parseWindows('{"port":3000,"procId":42,"addr":"127.0.0.1"}');
  assert.equal(out[0].name, '?');
});

test('parseWindows zwraca pusta liste na pustym/uszkodzonym wejsciu', () => {
  // Kafelek portow ma pokazac "brak", a nie wywrocic renderer.
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('   \n  '), []);
  assert.deepEqual(parseWindows('to nie jest JSON'), []);
  assert.deepEqual(parseWindows('{"urwany":'), []);
});

// ---- parsePosix (wyjscie lsof) ----------------------------------------------

const LSOF = [
  'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node     1234 mmazur   23u  IPv4 0x1111      0t0  TCP 127.0.0.1:3000 (LISTEN)',
  'python     99 mmazur    5u  IPv6 0x2222      0t0  TCP *:8080 (LISTEN)',
].join('\n');

test('parsePosix parsuje wiersze lsof i pomija naglowek', () => {
  assert.deepEqual(parsePosix(LSOF), [
    { port: 3000, procId: 1234, name: 'node' },
    { port: 8080, procId: 99, name: 'python' },
  ]);
});

test('parsePosix pomija wiersze bez portu na koncu adresu', () => {
  const text = 'node 1 u 1u IPv4 0x1 0t0 TCP 127.0.0.1 (LISTEN)';
  assert.deepEqual(parsePosix(text), []);
});

test('parsePosix pomija wiersze za krotkie (urwane wyjscie)', () => {
  assert.deepEqual(parsePosix('node 1234 mmazur'), []);
});

test('parsePosix zwraca pusta liste na pustym wejsciu', () => {
  assert.deepEqual(parsePosix(''), []);
});

// ---- dedupeByPort -----------------------------------------------------------

test('dedupeByPort zachowuje pierwsze wystapienie portu', () => {
  const out = dedupeByPort([
    { port: 3000, procId: 1, name: 'pierwszy' },
    { port: 3000, procId: 2, name: 'drugi' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'pierwszy');
});

test('dedupeByPort odrzuca porty niedodatnie', () => {
  assert.deepEqual(dedupeByPort([{ port: 0, procId: 1, name: 'x' }]), []);
  assert.deepEqual(dedupeByPort([{ port: -1, procId: 1, name: 'x' }]), []);
});

test('dedupeByPort sortuje rosnaco', () => {
  const out = dedupeByPort([
    { port: 9000, procId: 1, name: 'c' },
    { port: 80, procId: 2, name: 'a' },
    { port: 3000, procId: 3, name: 'b' },
  ]);
  assert.deepEqual(out.map((r) => r.port), [80, 3000, 9000]);
});
