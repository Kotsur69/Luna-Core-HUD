// Testy parseGpu() - jedynej czystej funkcji src/gpu.js (reszta spawnuje
// prawdziwy proces, patrz komentarz na dole modulu i test/ports.test.js dla
// tej samej konwencji).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGpu } = require('../src/gpu');

test('parseGpu odczytuje procent z poprawnego JSON-a', () => {
  assert.deepEqual(parseGpu('{"percent":42}'), { percent: 42 });
});

test('parseGpu przycina zakres do 0-100', () => {
  assert.deepEqual(parseGpu('{"percent":142}'), { percent: 100 });
  assert.deepEqual(parseGpu('{"percent":-5}'), { percent: 0 });
});

test('parseGpu zaokragla wartosci niecalkowite', () => {
  assert.deepEqual(parseGpu('{"percent":41.6}'), { percent: 42 });
});

test('parseGpu zwraca null dla pustego/bialego stdout (brak licznika GPU)', () => {
  assert.equal(parseGpu(''), null);
  assert.equal(parseGpu('   \n'), null);
  assert.equal(parseGpu(undefined), null);
});

test('parseGpu zwraca null dla uszkodzonego JSON-a', () => {
  assert.equal(parseGpu('not json'), null);
});

test('parseGpu zwraca null, gdy pole percent ma zly typ lub go brak', () => {
  assert.equal(parseGpu('{}'), null);
  assert.equal(parseGpu('{"percent":"42"}'), null);
  assert.equal(parseGpu('{"percent":null}'), null);
});
