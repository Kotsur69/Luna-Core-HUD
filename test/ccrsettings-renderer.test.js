// ============================================================================
// LunaCore - CCR Settings panel renderer tests
// ----------------------------------------------------------------------------
// describeCcrStatus() is the one pure decision ccrsettings.js makes (a
// `ccr:status` IPC result -> status text/dot/button-availability) - no
// document.*, no window.lunacore, so it can be require()'d directly from a
// plain `node --test` run, same pattern as test/providers-renderer.test.js.
// The DOM/IPC half (mountCcrSettings) is left untested for the same reason
// every other renderer modules/*.js file in this repo is (it does
// module-scope DOM work the moment it is imported).
//
// One case per state describeState() (src/ccr.js) can actually return -
// confirmed against src/ccr.js directly, not guessed: 'not-installed',
// 'down', 'starting', 'up', 'port-mismatch', 'foreign-port', 'auth-required'.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeCcrStatus } = require('../src/renderer/modules/ccrsettings.js');

// ---- not-installed -----------------------------------------------------------

test('describeCcrStatus: not-installed disables every action', () => {
  const info = describeCcrStatus({ installed: false });
  assert.equal(info.textKey, 'ccr.status.notInstalled');
  assert.equal(info.dotClass, 'diag-item__dot--fail');
  assert.equal(info.canStart, false);
  assert.equal(info.canStop, false);
  assert.equal(info.canOpenUi, false);
});

test('describeCcrStatus: installed:false forces not-installed even with a stray state field', () => {
  const info = describeCcrStatus({ installed: false, state: 'up', port: 3456 });
  assert.equal(info.textKey, 'ccr.status.notInstalled');
  assert.equal(info.canOpenUi, false);
});

test('describeCcrStatus: junk/missing input behaves like not-installed, never throws', () => {
  assert.equal(describeCcrStatus(undefined).textKey, 'ccr.status.notInstalled');
  assert.equal(describeCcrStatus(null).textKey, 'ccr.status.notInstalled');
  assert.equal(describeCcrStatus('nope').textKey, 'ccr.status.notInstalled');
});

// ---- down ---------------------------------------------------------------------

test('describeCcrStatus: down offers Start, not Stop, still lets you open CCR\'s own UI', () => {
  const info = describeCcrStatus({ installed: true, state: 'down', startedByUs: false });
  assert.equal(info.textKey, 'ccr.status.down');
  assert.equal(info.dotClass, 'diag-item__dot--fail');
  assert.equal(info.canStart, true);
  assert.equal(info.canStop, false);
  assert.equal(info.canOpenUi, true);
});

// ---- starting -------------------------------------------------------------------

test('describeCcrStatus: starting disables Start (already in flight), offers Stop (we started it)', () => {
  const info = describeCcrStatus({ installed: true, state: 'starting', startedByUs: true, port: 3456 });
  assert.equal(info.textKey, 'ccr.status.starting');
  assert.equal(info.dotClass, 'diag-item__dot--unknown');
  assert.equal(info.canStart, false);
  assert.equal(info.canStop, true);
  assert.equal(info.canOpenUi, true);
});

// ---- up -------------------------------------------------------------------------

test('describeCcrStatus: up (gateway healthy) offers Stop only when startedByUs', () => {
  const ours = describeCcrStatus({ installed: true, state: 'up', startedByUs: true, port: 3456 });
  assert.equal(ours.textKey, 'ccr.status.up');
  assert.deepEqual(ours.textParams, { port: 3456 });
  assert.equal(ours.dotClass, 'diag-item__dot--ok');
  assert.equal(ours.canStart, false);
  assert.equal(ours.canStop, true);
  assert.equal(ours.canOpenUi, true);

  const foreign = describeCcrStatus({ installed: true, state: 'up', startedByUs: false, port: 3456 });
  assert.equal(foreign.canStop, false);
});

// ---- port-mismatch ---------------------------------------------------------------

test('describeCcrStatus: port-mismatch is a warning, not a failure', () => {
  const info = describeCcrStatus({ installed: true, state: 'port-mismatch', startedByUs: true, port: 3457 });
  assert.equal(info.textKey, 'ccr.status.portMismatch');
  assert.deepEqual(info.textParams, { port: 3457 });
  assert.equal(info.dotClass, 'diag-item__dot--warn');
  assert.equal(info.canStart, false);
  assert.equal(info.canStop, true);
});

// ---- foreign-port -----------------------------------------------------------------

test('describeCcrStatus: foreign-port is a warning; never claims a foreign process as ours to stop', () => {
  const info = describeCcrStatus({ installed: true, state: 'foreign-port', startedByUs: false, port: 3456 });
  assert.equal(info.textKey, 'ccr.status.foreignPort');
  assert.deepEqual(info.textParams, { port: 3456 });
  assert.equal(info.dotClass, 'diag-item__dot--warn');
  assert.equal(info.canStop, false);
});

// ---- auth-required ------------------------------------------------------------------

test('describeCcrStatus: auth-required is the healthy "up, gated behind a client key" case', () => {
  const info = describeCcrStatus({ installed: true, state: 'auth-required', startedByUs: true, port: 3456 });
  assert.equal(info.textKey, 'ccr.status.authRequired');
  assert.deepEqual(info.textParams, { port: 3456 });
  assert.equal(info.dotClass, 'diag-item__dot--ok');
  assert.equal(info.canStart, false);
  assert.equal(info.canStop, true);
  assert.equal(info.canOpenUi, true);
});

// ---- unrecognized state (defensive) --------------------------------------------------

test('describeCcrStatus: an unrecognized state string falls back without throwing', () => {
  const info = describeCcrStatus({ installed: true, state: 'something-new', startedByUs: false });
  assert.equal(info.textKey, 'ccr.status.unknown');
  assert.equal(info.dotClass, 'diag-item__dot--unknown');
});

// ---- port field -------------------------------------------------------------------------

test('describeCcrStatus: a non-finite port is normalized to null, never NaN/undefined leaking into params', () => {
  const info = describeCcrStatus({ installed: true, state: 'up', startedByUs: true, port: 'nope' });
  assert.deepEqual(info.textParams, { port: null });
});
