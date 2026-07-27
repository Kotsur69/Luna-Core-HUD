// Localized config values (src/localized.js + src/renderer/modules/localize.js).
//
// The rule these tests exist to pin down: A PLAIN STRING IS LANGUAGE-NEUTRAL.
// That is what keeps every *.local.json written before localization working,
// and what keeps `git status` / `/compact` / `Cyberpunk` one-liners in config.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLocalized, hasText, normalizeText, mergeKey } = require('../src/localized.js');
const { pickLocalized } = require('../src/renderer/modules/localize.js');

// ---- isLocalized ------------------------------------------------------------

test('isLocalized rozpoznaje obiekt z jezykami', () => {
  assert.equal(isLocalized({ pl: 'Testy', en: 'Tests' }), true);
  assert.equal(isLocalized({ en: 'Tests' }), true);
});

test('isLocalized odrzuca stringi, tablice i obce obiekty', () => {
  assert.equal(isLocalized('Git'), false);
  assert.equal(isLocalized(['a', 'b']), false);
  assert.equal(isLocalized({ de: 'Tests' }), false);
  assert.equal(isLocalized(null), false);
});

// ---- hasText ----------------------------------------------------------------

test('hasText akceptuje zwykly string i obiekt z trescia', () => {
  assert.equal(hasText('Git'), true);
  assert.equal(hasText({ pl: 'Testy', en: 'Tests' }), true);
  assert.equal(hasText({ en: ['linia'] }), true);
});

test('hasText odrzuca puste wartosci', () => {
  assert.equal(hasText(''), false);
  assert.equal(hasText('   '), false);
  assert.equal(hasText({ pl: '  ' }), false);
  assert.equal(hasText(undefined), false);
});

// ---- normalizeText ----------------------------------------------------------

test('normalizeText sklada tablice linii w string', () => {
  assert.equal(normalizeText(['a', 'b']), 'a\nb');
});

test('normalizeText sklada tablice OSOBNO dla kazdego jezyka', () => {
  // To jest powod, dla ktorego loader nie moze po prostu wybrac jezyka:
  // ksztalt { pl, en } musi przetrwac az do renderera.
  assert.deepEqual(normalizeText({ pl: ['a', 'b'], en: ['x', 'y'] }), {
    pl: 'a\nb',
    en: 'x\ny',
  });
});

test('normalizeText przepuszcza zwykly string bez zmian', () => {
  assert.equal(normalizeText('Git'), 'Git');
});

test('normalizeText zwraca null, gdy nie ma zadnej tresci', () => {
  assert.equal(normalizeText(''), null);
  assert.equal(normalizeText({ pl: '   ' }), null);
  assert.equal(normalizeText(null), null);
});

test('normalizeText pomija puste jezyki, zachowujac reszte', () => {
  assert.deepEqual(normalizeText({ pl: 'Testy', en: '' }), { pl: 'Testy' });
});

// ---- mergeKey ---------------------------------------------------------------

test('mergeKey daje stabilny string dla tytulu zlokalizowanego', () => {
  // Bez tego override z *.local.json po cichu przestaje dzialac: obiekty w
  // Mapie porownuja sie przez tozsamosc, wiec kazda grupa bylaby unikalna.
  assert.equal(mergeKey({ pl: 'Testy / Build', en: 'Tests / Build' }), 'Testy / Build');
});

test('mergeKey pozwala staremu local override trafic w nowy base', () => {
  // Base zlokalizowany, local napisany przed zmiana - musza dac ten sam klucz.
  assert.equal(mergeKey({ pl: 'Git', en: 'Git' }), mergeKey('Git'));
});

test('mergeKey spada na en, gdy nie ma pl', () => {
  assert.equal(mergeKey({ en: 'Tests' }), 'Tests');
});

// ---- pickLocalized (renderer) -----------------------------------------------

test('pickLocalized wybiera zadany jezyk', () => {
  const v = { pl: 'Testy', en: 'Tests' };
  assert.equal(pickLocalized(v, 'pl'), 'Testy');
  assert.equal(pickLocalized(v, 'en'), 'Tests');
});

test('pickLocalized traktuje zwykly string jako neutralny jezykowo', () => {
  // `git status` i `/compact` znacza to samo wszedzie - i tak wlasnie
  // zostaja krotkimi wpisami w configu.
  assert.equal(pickLocalized('git status', 'en'), 'git status');
  assert.equal(pickLocalized('git status', 'pl'), 'git status');
});

test('pickLocalized spada na pl, potem na en', () => {
  // Konfiguracja przetlumaczona w polowie ma pokazac drugi jezyk, nie pustke:
  // pusta etykieta wyglada jak zepsuta aplikacja.
  assert.equal(pickLocalized({ pl: 'Testy' }, 'en'), 'Testy');
  assert.equal(pickLocalized({ en: 'Tests' }, 'pl'), 'Tests');
});

test('pickLocalized sklada tablice linii', () => {
  assert.equal(pickLocalized(['a', 'b'], 'pl'), 'a\nb');
  assert.equal(pickLocalized({ en: ['x', 'y'] }, 'en'), 'x\ny');
});

test('pickLocalized zawsze zwraca string', () => {
  assert.equal(pickLocalized(null, 'pl'), '');
  assert.equal(pickLocalized(undefined, 'pl'), '');
  assert.equal(pickLocalized({}, 'pl'), '');
  assert.equal(pickLocalized({ de: 'Tests' }, 'pl'), '');
});
