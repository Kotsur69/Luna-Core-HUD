// Widget registry tests (A2). Pure table + validation, no DOM.
//
// First test file that reaches into src/renderer/: those modules are ESM, which
// Node can now load because src/renderer/package.json marks the folder
// "type": "module". require() of an ESM module is supported on Node 22.12+, and
// this repo runs 24.
//
// The mounting half (host.js) is deliberately NOT covered here - it needs a DOM,
// and the thing worth checking about it (that unmount really undoes a mount)
// only shows up in the running app. Use __luna.remount('<id>') for that.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeWidget, createRegistry } = require('../src/renderer/modules/registry.js');

const noop = () => {};

// ---- normalizeWidget --------------------------------------------------------

test('normalizeWidget wypelnia pola opcjonalne', () => {
  const w = normalizeWidget({ id: 'ports', mount: noop });
  assert.equal(w.id, 'ports');
  assert.equal(w.titleKey, '');
  assert.equal(w.template, '');
  assert.equal(w.mount, noop);
});

test('normalizeWidget przycina biale znaki w id, titleKey i template', () => {
  const w = normalizeWidget({
    id: '  ports  ',
    titleKey: ' ports.title ',
    template: ' w-ports ',
    mount: noop,
  });
  assert.equal(w.id, 'ports');
  assert.equal(w.titleKey, 'ports.title');
  assert.equal(w.template, 'w-ports');
});

test('normalizeWidget odrzuca spec bez id', () => {
  assert.throws(() => normalizeWidget({ mount: noop }), TypeError);
  assert.throws(() => normalizeWidget({ id: '   ', mount: noop }), TypeError);
});

test('normalizeWidget odrzuca spec bez mount()', () => {
  // Bez mount() widget nie ma jak sie pojawic - to blad programisty, wiec
  // wyjatek leci od razu przy imporcie, a nie dopiero przy montowaniu.
  assert.throws(() => normalizeWidget({ id: 'ports' }), TypeError);
  assert.throws(() => normalizeWidget({ id: 'ports', mount: 'nope' }), TypeError);
});

test('normalizeWidget odrzuca to, co nie jest obiektem', () => {
  assert.throws(() => normalizeWidget(null), TypeError);
  assert.throws(() => normalizeWidget('ports'), TypeError);
});

// ---- createRegistry ---------------------------------------------------------

test('registry oddaje zdefiniowany widget', () => {
  const reg = createRegistry();
  reg.define({ id: 'ports', titleKey: 'ports.title', template: 'w-ports', mount: noop });

  assert.equal(reg.has('ports'), true);
  assert.equal(reg.size, 1);
  assert.equal(reg.get('ports').titleKey, 'ports.title');
});

test('registry zwraca null dla nieznanego id', () => {
  const reg = createRegistry();
  assert.equal(reg.get('nie-ma-takiego'), null);
  assert.equal(reg.has('nie-ma-takiego'), false);
});

test('registry odrzuca powtorzone id', () => {
  // Duplikat oznacza dwa moduly walczace o to samo gniazdo - cicha wygrana
  // ostatniego bylaby bardzo trudna do zauwazenia.
  const reg = createRegistry();
  reg.define({ id: 'ports', mount: noop });
  assert.throws(() => reg.define({ id: 'ports', mount: noop }), /already defined/);
  assert.equal(reg.size, 1);
});

test('list() zachowuje kolejnosc definiowania', () => {
  const reg = createRegistry();
  reg.define({ id: 'ctx', mount: noop });
  reg.define({ id: 'usage', mount: noop });
  reg.define({ id: 'ports', mount: noop });
  assert.deepEqual(
    reg.list().map((w) => w.id),
    ['ctx', 'usage', 'ports']
  );
});

test('rejestry sa od siebie niezalezne', () => {
  // Wlasnie po to createRegistry() jest fabryka: testy nie dziedzicza po sobie
  // stanu i nie musza go resetowac.
  const a = createRegistry();
  const b = createRegistry();
  a.define({ id: 'ports', mount: noop });
  assert.equal(b.has('ports'), false);
  assert.equal(b.size, 0);
});
