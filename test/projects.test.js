// Testy przelacznika projektu. Sedno: rozwijanie "~" - to ono czyni config
// PRZENOSNYM miedzy maszynami (rozne litery dyskow / nazwy userow).
// Asercje sciezek buduje path.join/os.homedir, nie wpisane na sztywno
// separatory - inaczej test przechodzilby tylko na jednym systemie.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { expandHome, normalizeProject, getProject } = require('../src/projects');

// ---- expandHome -------------------------------------------------------------

test('expandHome rozwija samotna tylde na katalog domowy', () => {
  assert.equal(expandHome('~'), os.homedir());
});

test('expandHome rozwija tylde ze slashem POSIX', () => {
  assert.equal(expandHome('~/repos/Luna-Core-HUD'), path.join(os.homedir(), 'repos/Luna-Core-HUD'));
});

test('expandHome rozwija tylde z backslashem (config pisany na Windowsie)', () => {
  assert.equal(expandHome('~\\repos'), path.join(os.homedir(), 'repos'));
});

test('expandHome zostawia sciezki bezwzgledne bez zmian', () => {
  assert.equal(expandHome('/var/log'), '/var/log');
  assert.equal(expandHome('C:\\Users\\mmazur'), 'C:\\Users\\mmazur');
});

test('expandHome NIE rozwija tyldy bez separatora (~foo to nie katalog domowy)', () => {
  assert.equal(expandHome('~foo'), '~foo');
});

// ---- normalizeProject -------------------------------------------------------

test('normalizeProject rozwija i normalizuje sciezke', () => {
  const p = normalizeProject({ id: 'hud', label: 'HUD', path: '~/repos/Luna-Core-HUD' });
  assert.equal(p.id, 'hud');
  assert.equal(p.label, 'HUD');
  assert.equal(p.path, path.normalize(path.join(os.homedir(), 'repos/Luna-Core-HUD')));
});

test('normalizeProject odrzuca wpisy bez id, label lub path', () => {
  assert.equal(normalizeProject({ label: 'X', path: '~' }), null);
  assert.equal(normalizeProject({ id: 'x', path: '~' }), null);
  assert.equal(normalizeProject({ id: 'x', label: 'X' }), null);
  assert.equal(normalizeProject({ id: 'x', label: 'X', path: '' }), null);
});

test('normalizeProject odrzuca nie-obiekty', () => {
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject('~/repos'), null);
});

test('normalizeProject nie sprawdza istnienia katalogu (repo moze byc na innej maszynie)', () => {
  // To jest swiadoma decyzja: config listujacy repo z innego komputera musi sie
  // zaladowac. Istnienie katalogu weryfikuje dopiero safeCwd() tuz przed spawnem.
  const p = normalizeProject({ id: 'obcy', label: 'Obcy', path: '~/nie-ma-mnie-tutaj-12345' });
  assert.notEqual(p, null);
  assert.ok(p.path.includes('nie-ma-mnie-tutaj-12345'));
});

test('getProject znajduje po id, inaczej null', () => {
  const list = [{ id: 'home', label: 'Home', path: '/home' }];
  assert.equal(getProject(list, 'home').label, 'Home');
  assert.equal(getProject(list, 'brak'), null);
});
