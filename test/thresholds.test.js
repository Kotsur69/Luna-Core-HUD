// Testy E3 - detektor przekroczenia progu okna kontekstu.
//
// ctxLevel() samo w sobie jest trywialne. Testowane jest, bo od jego
// UPORZADKOWANIA zalezy regula "puls tylko w gore": gdyby zwracalo nazwy pasm
// zamiast liczb, porownanie `level > lastLevel` cicho przestaloby dzialac - a
// puls, ktory sie nie odpala, nie rzuca bledem. Nikt by tego nie zauwazyl.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ctxLevel, CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');

test('ctxLevel mapuje trzy pasma', () => {
  assert.equal(ctxLevel(0), 0);
  assert.equal(ctxLevel(0.59), 0);
  assert.equal(ctxLevel(CTX_WARN_MID), 1);
  assert.equal(ctxLevel(0.84), 1);
  assert.equal(ctxLevel(CTX_WARN_HIGH), 2);
  assert.equal(ctxLevel(1), 2);
});

// Progi sa domkniete od dolu - dokladnie 85% JEST juz strefa czerwona.
test('granice pasm naleza do pasma wyzszego', () => {
  assert.equal(ctxLevel(CTX_WARN_MID - 0.0001), 0);
  assert.equal(ctxLevel(CTX_WARN_HIGH - 0.0001), 1);
});

test('ctxLevel jest odporny na brak odczytu', () => {
  assert.equal(ctxLevel(null), 0);
  assert.equal(ctxLevel(undefined), 0);
  assert.equal(ctxLevel(NaN), 0);
  assert.equal(ctxLevel('0.9'), 0);
});

// TO JEST POWOD ISTNIENIA TEGO PLIKU. Reguly pulsu nie da sie sprawdzic bez
// DOM-u, ale jej ARYTMETYKE - owszem. Odtwarzamy tu warunek z context.js.
test('puls odpala sie tylko przy przejsciu W GORE', () => {
  const crossings = [];
  let last = null;

  // Sciezka sesji: spokojnie -> 60% -> 90% -> compact -> znowu w gore.
  for (const [pct, live] of [
    [0.1, true],
    [0.62, true], // 0 -> 1, puls
    [0.7, true],
    [0.88, true], // 1 -> 2, puls
    [0.95, true],
    [0.2, true], // po compacie w dol - BEZ pulsu
    [0.9, true], // znowu w gore, puls
  ]) {
    const level = ctxLevel(pct);
    if (live && last !== null && level > last) crossings.push(pct);
    last = level;
  }

  assert.deepEqual(crossings, [0.62, 0.88, 0.9]);
});

// Przelaczenie zakladki odtwarza zapamietane metryki z live=false. Gdyby nie ten
// warunek, klikanie miedzy dwoma zakladkami odpalaloby alarmy bez konca.
test('odtworzenie widoku zakladki nie liczy sie jako przekroczenie', () => {
  let last = ctxLevel(0.1);
  let pulses = 0;

  const level = ctxLevel(0.95);
  const live = false; // tab switch
  if (live && last !== null && level > last) pulses += 1;
  last = level;

  assert.equal(pulses, 0);
  assert.equal(last, 2, 'ale pasmo ma sie zaktualizowac, inaczej pulsnie zaraz potem');
});

// Sesja, ktora JUZ jest na 90% w chwili pierwszego odczytu, niczego nie
// przekroczyla - ona taka przyszla.
test('pierwszy odczyt sesji nigdy nie pulsuje', () => {
  const last = null;
  const level = ctxLevel(0.9);
  assert.equal(last !== null && level > last, false);
});
