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

test('isLocalized recognizes an object with languages', () => {
  assert.equal(isLocalized({ pl: 'Testy', en: 'Tests' }), true);
  assert.equal(isLocalized({ en: 'Tests' }), true);
});

test('isLocalized rejects strings, arrays, and foreign objects', () => {
  assert.equal(isLocalized('Git'), false);
  assert.equal(isLocalized(['a', 'b']), false);
  assert.equal(isLocalized({ de: 'Tests' }), false);
  assert.equal(isLocalized(null), false);
});

// ---- hasText ----------------------------------------------------------------

test('hasText accepts a plain string and an object with content', () => {
  assert.equal(hasText('Git'), true);
  assert.equal(hasText({ pl: 'Testy', en: 'Tests' }), true);
  assert.equal(hasText({ en: ['line'] }), true);
});

test('hasText rejects empty values', () => {
  assert.equal(hasText(''), false);
  assert.equal(hasText('   '), false);
  assert.equal(hasText({ pl: '  ' }), false);
  assert.equal(hasText(undefined), false);
});

// ---- normalizeText ----------------------------------------------------------

test('normalizeText joins an array of lines into a string', () => {
  assert.equal(normalizeText(['a', 'b']), 'a\nb');
});

test('normalizeText joins arrays SEPARATELY for each language', () => {
  // This is why the loader cannot simply pick a language up front:
  // the { pl, en } shape must survive all the way to the renderer.
  assert.deepEqual(normalizeText({ pl: ['a', 'b'], en: ['x', 'y'] }), {
    pl: 'a\nb',
    en: 'x\ny',
  });
});

test('normalizeText passes a plain string through unchanged', () => {
  assert.equal(normalizeText('Git'), 'Git');
});

test('normalizeText returns null when there is no content at all', () => {
  assert.equal(normalizeText(''), null);
  assert.equal(normalizeText({ pl: '   ' }), null);
  assert.equal(normalizeText(null), null);
});

test('normalizeText skips empty languages, keeping the rest', () => {
  assert.deepEqual(normalizeText({ pl: 'Testy', en: '' }), { pl: 'Testy' });
});

// ---- mergeKey ---------------------------------------------------------------

test('mergeKey gives a stable string for a localized title', () => {
  // Without this, overriding from *.local.json silently stops working: objects
  // in a Map compare by identity, so every group would end up unique.
  assert.equal(mergeKey({ pl: 'Testy / Build', en: 'Tests / Build' }), 'Testy / Build');
});

test('mergeKey lets an old local override match the new base', () => {
  // Base is localized, local was written before the change - they must produce the same key.
  assert.equal(mergeKey({ pl: 'Git', en: 'Git' }), mergeKey('Git'));
});

test('mergeKey falls back to en when there is no pl', () => {
  assert.equal(mergeKey({ en: 'Tests' }), 'Tests');
});

// ---- pickLocalized (renderer) -----------------------------------------------

test('pickLocalized picks the requested language', () => {
  const v = { pl: 'Testy', en: 'Tests' };
  assert.equal(pickLocalized(v, 'pl'), 'Testy');
  assert.equal(pickLocalized(v, 'en'), 'Tests');
});

test('pickLocalized treats a plain string as language-neutral', () => {
  // `git status` and `/compact` mean the same thing everywhere - which is
  // exactly why they stay as plain short entries in the config.
  assert.equal(pickLocalized('git status', 'en'), 'git status');
  assert.equal(pickLocalized('git status', 'pl'), 'git status');
});

test('pickLocalized falls back to pl, then to en', () => {
  // A config translated only halfway should show the other language, not a blank:
  // an empty label looks like a broken app.
  assert.equal(pickLocalized({ pl: 'Testy' }, 'en'), 'Testy');
  assert.equal(pickLocalized({ en: 'Tests' }, 'pl'), 'Tests');
});

test('pickLocalized joins arrays of lines', () => {
  assert.equal(pickLocalized(['a', 'b'], 'pl'), 'a\nb');
  assert.equal(pickLocalized({ en: ['x', 'y'] }, 'en'), 'x\ny');
});

test('pickLocalized always returns a string', () => {
  assert.equal(pickLocalized(null, 'pl'), '');
  assert.equal(pickLocalized(undefined, 'pl'), '');
  assert.equal(pickLocalized({}, 'pl'), '');
  assert.equal(pickLocalized({ de: 'Tests' }, 'pl'), '');
});
