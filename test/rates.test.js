// Testy cennika i szacowania kosztu (B4). Czyste funkcje, bez I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rateFor, estimateCost, formatUsd, normalizeRate } = require('../src/rates');

const RATES = [
  { id: 'claude-opus-4-8', input: 5, output: 25 },
  { id: 'claude-sonnet-5', input: 3, output: 15 },
  { id: 'claude-haiku-4-5', input: 1, output: 5 },
];

// ---- normalizeRate ----------------------------------------------------------

test('normalizeRate przepuszcza poprawny wpis', () => {
  assert.deepEqual(normalizeRate({ id: 'x', input: 1, output: 2 }), {
    id: 'x',
    input: 1,
    output: 2,
  });
});

test('normalizeRate odrzuca wpisy bez id lub z nieliczbowa cena', () => {
  assert.equal(normalizeRate({ input: 1, output: 2 }), null);
  assert.equal(normalizeRate({ id: 'x', input: '5', output: 2 }), null);
  assert.equal(normalizeRate({ id: 'x', input: 1 }), null);
  assert.equal(normalizeRate(null), null);
});

test('normalizeRate odrzuca ceny ujemne', () => {
  assert.equal(normalizeRate({ id: 'x', input: -1, output: 2 }), null);
});

// ---- rateFor ----------------------------------------------------------------

test('rateFor dopasowuje dokladnie', () => {
  assert.equal(rateFor('claude-opus-4-8', RATES).input, 5);
  assert.equal(rateFor('claude-haiku-4-5', RATES).output, 5);
});

test('rateFor dopasowuje po prefiksie (id z sufiksem daty)', () => {
  // Transkrypt potrafi zawierac "claude-sonnet-5-20260115".
  assert.equal(rateFor('claude-sonnet-5-20260115', RATES).id, 'claude-sonnet-5');
});

test('rateFor jest niewrazliwy na wielkosc liter', () => {
  assert.equal(rateFor('CLAUDE-OPUS-4-8', RATES).id, 'claude-opus-4-8');
});

test('rateFor zwraca null dla nieznanego modelu', () => {
  // Kluczowe: brak szacunku jest lepszy niz zmyslona kwota.
  assert.equal(rateFor('qwen2.5-coder-32b', RATES), null);
  assert.equal(rateFor('', RATES), null);
  assert.equal(rateFor(null, RATES), null);
  assert.equal(rateFor('claude-opus-4-8', null), null);
});

// ---- estimateCost -----------------------------------------------------------

const MULT = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

test('estimateCost liczy wejscie i wyjscie po cenie za milion', () => {
  const c = estimateCost({ input: 1000000, output: 1000000 }, RATES[0], MULT);
  assert.equal(c.input, 5);
  assert.equal(c.output, 25);
  assert.equal(c.usd, 30);
});

test('estimateCost wycenia cache mnoznikiem od stawki WEJSCIOWEJ', () => {
  // 1M odczytu z cache przy stawce 5 USD i mnozniku 0.1 => 0.50 USD.
  const c = estimateCost({ cacheRead: 1000000 }, RATES[0], MULT);
  assert.equal(c.cacheRead, 0.5);
  assert.equal(c.usd, 0.5);
});

test('estimateCost wycenia zapis cache drozej niz zwykle wejscie', () => {
  // 1M zapisu przy stawce 5 USD i mnozniku 1.25 => 6.25 USD.
  const c = estimateCost({ cacheWrite: 1000000 }, RATES[0], MULT);
  assert.equal(c.cacheWrite, 6.25);
});

test('estimateCost sumuje wszystkie cztery skladniki', () => {
  const c = estimateCost(
    { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 },
    RATES[0],
    MULT
  );
  assert.equal(c.usd, 5 + 25 + 0.5 + 6.25);
});

test('estimateCost traktuje brakujace liczniki jako zero', () => {
  assert.equal(estimateCost({}, RATES[0], MULT).usd, 0);
});

test('estimateCost zwraca null bez stawki (nieznany model)', () => {
  assert.equal(estimateCost({ input: 100 }, null, MULT), null);
  assert.equal(estimateCost(null, RATES[0], MULT), null);
});

test('estimateCost ma sensowne domyslne mnozniki cache', () => {
  const c = estimateCost({ cacheRead: 1000000 }, RATES[0]);
  assert.equal(c.cacheRead, 0.5);
});

// ---- formatUsd --------------------------------------------------------------

test('formatUsd dobiera precyzje do rzedu wielkosci', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0004), '$0.0004');
  assert.equal(formatUsd(0.25), '$0.250');
  assert.equal(formatUsd(12.5), '$12.50');
});

test('formatUsd zwraca pusty string dla niepoprawnej kwoty', () => {
  assert.equal(formatUsd(null), '');
  assert.equal(formatUsd(NaN), '');
  assert.equal(formatUsd(-1), '');
});
