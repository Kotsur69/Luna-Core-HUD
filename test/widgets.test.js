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

test('normalizeWidget fills in optional fields', () => {
  const w = normalizeWidget({ id: 'ports', mount: noop });
  assert.equal(w.id, 'ports');
  assert.equal(w.titleKey, '');
  assert.equal(w.template, '');
  assert.equal(w.mount, noop);
});

test('normalizeWidget trims whitespace in id, titleKey and template', () => {
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

test('normalizeWidget rejects a spec without id', () => {
  assert.throws(() => normalizeWidget({ mount: noop }), TypeError);
  assert.throws(() => normalizeWidget({ id: '   ', mount: noop }), TypeError);
});

test('normalizeWidget rejects a spec without mount()', () => {
  // Without mount() a widget has no way to appear - that's a programmer
  // error, so the exception fires right at import, not only at mount time.
  assert.throws(() => normalizeWidget({ id: 'ports' }), TypeError);
  assert.throws(() => normalizeWidget({ id: 'ports', mount: 'nope' }), TypeError);
});

test('normalizeWidget rejects anything that is not an object', () => {
  assert.throws(() => normalizeWidget(null), TypeError);
  assert.throws(() => normalizeWidget('ports'), TypeError);
});

// ---- createRegistry ---------------------------------------------------------

test('registry returns a defined widget', () => {
  const reg = createRegistry();
  reg.define({ id: 'ports', titleKey: 'ports.title', template: 'w-ports', mount: noop });

  assert.equal(reg.has('ports'), true);
  assert.equal(reg.size, 1);
  assert.equal(reg.get('ports').titleKey, 'ports.title');
});

test('registry returns null for an unknown id', () => {
  const reg = createRegistry();
  assert.equal(reg.get('no-such-id'), null);
  assert.equal(reg.has('no-such-id'), false);
});

test('registry rejects a repeated id', () => {
  // A duplicate means two modules fighting over the same slot - a silent win
  // for the latter would be very hard to notice.
  const reg = createRegistry();
  reg.define({ id: 'ports', mount: noop });
  assert.throws(() => reg.define({ id: 'ports', mount: noop }), /already defined/);
  assert.equal(reg.size, 1);
});

test('list() preserves definition order', () => {
  const reg = createRegistry();
  reg.define({ id: 'ctx', mount: noop });
  reg.define({ id: 'usage', mount: noop });
  reg.define({ id: 'ports', mount: noop });
  assert.deepEqual(
    reg.list().map((w) => w.id),
    ['ctx', 'usage', 'ports']
  );
});

test('registries are independent of each other', () => {
  // This is exactly why createRegistry() is a factory: tests don't inherit
  // state from each other and don't have to reset it.
  const a = createRegistry();
  const b = createRegistry();
  a.define({ id: 'ports', mount: noop });
  assert.equal(b.has('ports'), false);
  assert.equal(b.size, 0);
});
