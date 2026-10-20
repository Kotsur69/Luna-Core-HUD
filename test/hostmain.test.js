// ============================================================================
// LunaCore - host mode: the pure parts of src/hostmain.js
// ----------------------------------------------------------------------------
// Arg parsing, the startup decision under the single-instance lock, the lock
// holder's answer to a second launch, and the verifier loading (no hostauth
// -> null, so every command is refused).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHostArgs, decideBoot, decideSecondInstance, trayLabel, skillNames, loadVerifier } = require('../src/hostmain.js');

const EXE = ['C:\\LunaCore\\LunaCore.exe'];

test('parseHostArgs: --host and --make-default, exact flags only', () => {
  assert.deepEqual(parseHostArgs([...EXE]), { host: false, makeDefault: false });
  assert.deepEqual(parseHostArgs([...EXE, '--host']), { host: true, makeDefault: false });
  assert.deepEqual(parseHostArgs([...EXE, '--host', '--make-default']), { host: true, makeDefault: true });
  assert.deepEqual(parseHostArgs(['electron', '.', '--make-default', '--host']), { host: true, makeDefault: true }, 'any order');
  assert.deepEqual(parseHostArgs([...EXE, '--make-default']), { host: false, makeDefault: false }, '--make-default alone does nothing');
  assert.deepEqual(parseHostArgs([...EXE, '--hostile', '--host=1']), { host: false, makeDefault: false });
  assert.deepEqual(parseHostArgs(null), { host: false, makeDefault: false });
  assert.deepEqual(parseHostArgs([42, '--host']), { host: true, makeDefault: false });
});

test('decideBoot: a host takes the lock or hands over; the HUD always runs', () => {
  assert.equal(decideBoot({ host: true, gotLock: true }), 'host');
  assert.equal(decideBoot({ host: true, gotLock: false }), 'quit', 'the running app switches instead');
  assert.equal(decideBoot({ host: false, gotLock: true }), 'hud');
  assert.equal(decideBoot({ host: false, gotLock: false }), 'hud', 'a second plain launch behaves as before');
});

test('decideSecondInstance: --host switches a running HUD into host mode', () => {
  assert.equal(decideSecondInstance({ mode: 'hud', argv: [...EXE, '--host'] }), 'switch');
  assert.equal(decideSecondInstance({ mode: 'hud', argv: [...EXE, '--host', '--make-default'] }), 'switch');
  assert.equal(decideSecondInstance({ mode: 'hud', argv: [...EXE] }), 'ignore');
  assert.equal(decideSecondInstance({ mode: 'host', argv: [...EXE, '--host'] }), 'ignore', 'already a host');
  assert.equal(decideSecondInstance({ mode: 'host', argv: [...EXE, '--host', '--make-default'] }), 'make-default');
  assert.equal(decideSecondInstance({ mode: 'host', argv: [...EXE] }), 'ignore');
});

test('trayLabel names the machine and the default flag', () => {
  assert.equal(trayLabel({ machine: 'DESKTOP-1', isDefault: true }), 'Luna host · DESKTOP-1 · default');
  assert.equal(trayLabel({ machine: 'mac', isDefault: false }), 'Luna host · mac');
});

test('skillNames flattens a skill scan', () => {
  assert.deepEqual(skillNames({ categories: [{ skills: [{ name: 'a' }] }, { skills: [{ name: 'b' }] }] }), ['a', 'b']);
  assert.deepEqual(skillNames(null), []);
});

test('loadVerifier: absent module -> null; either export shape works', async () => {
  const missing = () => {
    const err = new Error('nope');
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
  assert.equal(loadVerifier(missing), null);
  assert.equal(loadVerifier(() => ({})), null);
  const fn = async () => ({ ok: true });
  assert.equal(loadVerifier(() => ({ verifyCommand: fn })), fn);
  const wrapped = loadVerifier(() => ({ createHostAuth: () => ({ verify: async (row) => ({ ok: row.id === 'x' }) }) }));
  assert.deepEqual(await wrapped({ id: 'x' }), { ok: true });
});
