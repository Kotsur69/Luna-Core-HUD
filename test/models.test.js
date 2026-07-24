// Testy wiedzy o modelach: okno kontekstu + etykieta. Czyste funkcje, bez I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { contextLimitFor, modelLabel, DEFAULT_CONTEXT_LIMIT } = require('../src/models');

// ---- contextLimitFor --------------------------------------------------------

test('contextLimitFor domyslnie zwraca 200k', () => {
  assert.equal(contextLimitFor('claude-opus-4-8'), DEFAULT_CONTEXT_LIMIT);
  assert.equal(contextLimitFor('claude-sonnet-4-5-20250929'), 200000);
});

test('contextLimitFor jest odporny na brak/pusty model', () => {
  assert.equal(contextLimitFor(''), 200000);
  assert.equal(contextLimitFor(null), 200000);
  assert.equal(contextLimitFor(undefined), 200000);
});

test('contextLimitFor rozpoznaje marker 1M w id modelu', () => {
  assert.equal(contextLimitFor('claude-sonnet-4-5-1m'), 1000000);
  assert.equal(contextLimitFor('claude-sonnet-4-5[1m]'), 1000000);
});

test('contextLimitFor nie myli sie o zwykla cyfre 1 w id', () => {
  assert.equal(contextLimitFor('claude-opus-4-1'), 200000);
  assert.equal(contextLimitFor('claude-sonnet-4-5-20260115'), 200000);
});

test('contextLimitFor awansuje okno, gdy obserwacja przeczy zalozeniu', () => {
  // To jest wlasciwa naprawa buga "pasek klamie na sesji 1M": kontekst nie moze
  // przekroczyc wlasnego okna, wiec 600k tokenow dowodzi, ze okno to nie 200k.
  assert.equal(contextLimitFor('claude-sonnet-4-5', 600000), 1000000);
});

test('contextLimitFor nie awansuje, dopoki miescimy sie w oknie', () => {
  assert.equal(contextLimitFor('claude-opus-4-8', 199999), 200000);
  assert.equal(contextLimitFor('claude-opus-4-8', 200000), 200000);
});

test('contextLimitFor zatrzymuje sie na najwiekszym znanym progu', () => {
  // Nie znamy okna wiekszego niz 1M - lepiej pokazac 100% niz zmyslic prog.
  assert.equal(contextLimitFor('cokolwiek', 5000000), 1000000);
});

// ---- modelLabel -------------------------------------------------------------

test('modelLabel skraca id modelu do rodziny i wersji', () => {
  assert.equal(modelLabel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5'), 'Fable 5');
});

test('modelLabel radzi sobie ze stara kolejnoscia (wersja przed rodzina)', () => {
  assert.equal(modelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
});

test('modelLabel dokleja znacznik 1M', () => {
  assert.equal(modelLabel('claude-sonnet-4-5-1m'), 'Sonnet 4.5 1M');
});

test('modelLabel zwraca nieznane id BEZ ZMIAN (lokalne modele z LM Studio)', () => {
  // Lepiej pokazac surowa nazwe niz zgadywac rodzine, ktorej nie znamy.
  assert.equal(modelLabel('qwen2.5-coder-32b-instruct'), 'qwen2.5-coder-32b-instruct');
  assert.equal(modelLabel('gpt-4o'), 'gpt-4o');
});

test('modelLabel zwraca pusty string dla braku modelu', () => {
  assert.equal(modelLabel(''), '');
  assert.equal(modelLabel(null), '');
  assert.equal(modelLabel(undefined), '');
});
