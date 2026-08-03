// Burn-rate sparkline tests.
//
// These exist because of a bug that shipped in the sparkline's very first commit
// (55ac9e5) and survived A1 and A2 untouched: pushSample() stored
// { t, tokens, percent } while renderBurn() computed CTX_WARN_HIGH * last.limit.
// `limit` was never in the sample, so the product was NaN, `remaining > 0` was
// false, and the code fell into the else branch - announcing "w strefie compact"
// at 6% context. The ETA to 85% had therefore never worked.
//
// It hid for three refactors because NaN comparisons do not throw, they just
// quietly pick the wrong branch, and nothing in test/ touched either function.
// Found by hand on 2026-08-03 during the owed by-hand pass on `context`.
//
// The lesson worth encoding: the two halves must be tested TOGETHER. Testing
// etaMinutes() with a hand-built object would still pass while pushSample()
// dropped the field - so the last test here feeds one into the other.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pushSample, etaMinutes, SPARK_MAX } = require('../src/renderer/modules/spark.js');

const M = (tokens, percent, limit) => ({ tokens, percent, limit });

// ---- pushSample -------------------------------------------------------------

test('pushSample zapisuje limit razem z probka', () => {
  const buf = pushSample([], M(61000, 0.061, 1000000));
  assert.equal(buf.length, 1);
  assert.equal(buf[0].tokens, 61000);
  assert.equal(buf[0].percent, 0.061);
  // The regression: without this field renderBurn multiplies by undefined.
  assert.equal(buf[0].limit, 1000000);
});

test('pushSample odswieza limit, gdy liczba tokenow sie nie zmienila', () => {
  // B2 promuje okno w trakcie sesji, wiec probka moze przezyc swoj limit.
  const buf = pushSample([], M(61000, 0.061, 200000));
  pushSample(buf, M(61000, 0.305, 1000000));
  assert.equal(buf.length, 1, 'ta sama liczba tokenow nie dokłada punktu');
  assert.equal(buf[0].limit, 1000000);
});

test('pushSample dokłada punkt, gdy tokeny wzrosly', () => {
  const buf = pushSample([], M(1000, 0.001, 1000000));
  pushSample(buf, M(2000, 0.002, 1000000));
  assert.equal(buf.length, 2);
  assert.equal(buf[1].tokens, 2000);
});

test('pushSample przycina bufor do SPARK_MAX', () => {
  let buf = [];
  for (let i = 1; i <= SPARK_MAX + 10; i++) buf = pushSample(buf, M(i * 100, i / 1000, 1000000));
  assert.equal(buf.length, SPARK_MAX);
  // Najstarsze probki wypadaja z poczatku.
  assert.equal(buf[buf.length - 1].tokens, (SPARK_MAX + 10) * 100);
});

// ---- etaMinutes -------------------------------------------------------------

test('etaMinutes liczy czas do progu 85%', () => {
  // 850k - 61k = 789k do progu, przy 2000 tok/min => ~394.5 min
  const min = etaMinutes({ tokens: 61000, limit: 1000000 }, 2000);
  assert.ok(Math.abs(min - 394.5) < 0.1, `oczekiwano ~394.5, jest ${min}`);
});

test('etaMinutes zwraca 0 po przekroczeniu progu', () => {
  assert.equal(etaMinutes({ tokens: 900000, limit: 1000000 }, 2000), 0);
});

test('etaMinutes zwraca null bez znanego limitu', () => {
  // TO byl ten bug: undefined * cokolwiek = NaN, a NaN > 0 to false, wiec stara
  // wersja twierdzila "w strefie compact" przy 6% kontekstu.
  assert.equal(etaMinutes({ tokens: 61000 }, 2000), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: 0 }, 2000), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: null }, 2000), null);
  assert.equal(etaMinutes(null, 2000), null);
});

test('etaMinutes zwraca null, gdy kontekst nie rosnie', () => {
  assert.equal(etaMinutes({ tokens: 61000, limit: 1000000 }, 0), null);
  assert.equal(etaMinutes({ tokens: 61000, limit: 1000000 }, -500), null);
});

// ---- obie polowy razem ------------------------------------------------------

test('probka z pushSample daje policzalne ETA (regresja 55ac9e5)', () => {
  // Ten test jest calym sensem pliku. etaMinutes sprawdzone osobno przechodzi
  // nawet wtedy, gdy pushSample gubi `limit` - dopiero polaczenie obu polowek
  // odtwarza realna sciezke danych i lapie tamten blad.
  const buf = pushSample([], M(61000, 0.061, 1000000));
  const min = etaMinutes(buf[buf.length - 1], 2000);
  assert.notEqual(min, null, 'ETA policzone z realnej probki nie moze byc nieznane');
  assert.ok(min > 0, 'przy 6% kontekstu prog 85% jest wciaz przed nami');
});
