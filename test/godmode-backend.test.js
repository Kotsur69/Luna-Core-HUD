// ============================================================================
// God Mode's handling of the overnight guard's local-backend signals
// (src/overnight.js -> godmode:signal). backendSignalStep() is the pure
// transition; the module's DOM/IPC side is not exercised here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { backendSignalStep } = require('../src/renderer/modules/godmode.js');

test('backendRecovering parks a running run in waiting-backend', () => {
  assert.deepEqual(backendSignalStep('running', false, 'backendRecovering'), {
    phase: 'waiting-backend',
    sawDrop: false,
    effect: 'wait',
  });
});

test('backendRecovering after a drop remembers the drop', () => {
  const step = backendSignalStep('waiting-connection', false, 'backendRecovering');
  assert.equal(step.phase, 'waiting-backend');
  assert.equal(step.sawDrop, true);
});

test('a connection error while waiting for the backend is only remembered', () => {
  assert.deepEqual(backendSignalStep('waiting-backend', false, 'connectionError'), {
    phase: 'waiting-backend',
    sawDrop: true,
    effect: 'none',
  });
});

test('a connection error outside waiting-backend is left to the normal retry path', () => {
  assert.equal(backendSignalStep('running', false, 'connectionError'), null);
});

test('backendRecovered resumes without a continue when nothing dropped', () => {
  assert.deepEqual(backendSignalStep('waiting-backend', false, 'backendRecovered'), {
    phase: 'running',
    sawDrop: false,
    effect: 'resume',
  });
});

test('backendRecovered pastes continue only after a dropped request', () => {
  assert.equal(backendSignalStep('waiting-backend', true, 'backendRecovered').effect, 'continue');
});

test('backendRecovered is ignored unless the run is waiting for the backend', () => {
  assert.equal(backendSignalStep('running', true, 'backendRecovered'), null);
});

test('backendLost stalls the run from any engaged phase', () => {
  for (const phase of ['running', 'waiting-connection', 'waiting-backend', 'waiting-limit']) {
    assert.equal(backendSignalStep(phase, true, 'backendLost').effect, 'stall');
  }
});

test('unrelated signals are not a backend concern', () => {
  assert.equal(backendSignalStep('running', false, 'usageLimit'), null);
  assert.equal(backendSignalStep('waiting-backend', false, 'turnStarted'), null);
});
