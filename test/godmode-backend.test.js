// ============================================================================
// God Mode's handling of the overnight guard's local-backend signals
// (src/overnight.js -> godmode:signal). backendSignalStep() is the pure
// transition; the module's DOM/IPC side is not exercised here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { backendSignalStep, promptFor, limitResumeDelay } = require('../src/renderer/modules/godmode.js');

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

// ---- promptFor: never let a to-do run as a slash command --------------------

test('an item starting with a slash is framed as a task, not run as a command', () => {
  const out = promptFor('/clear into local model thing');
  assert.ok(out.startsWith('Task: /clear into local model thing'));
  assert.ok(!out.startsWith('/'));
});

test('leading whitespace cannot sneak a slash command through', () => {
  assert.ok(promptFor('  /compact now').startsWith('Task: /compact now'));
});

test('a plain item is sent as written, with the autonomy nudge', () => {
  const out = promptFor('fix the login bug');
  assert.ok(out.startsWith('fix the login bug ('));
  assert.ok(out.includes('Running unattended via God Mode'));
});

// ---- limitResumeDelay: a usage limit is waited out, never a stall -----------

test('a known reset time is waited out, plus a one-minute buffer', () => {
  const now = 1_000_000;
  assert.equal(limitResumeDelay(now + 30 * 60 * 1000, now), 31 * 60 * 1000);
});

test('a reset time already past still waits the buffer, not zero', () => {
  assert.equal(limitResumeDelay(500, 1_000_000), 60 * 1000);
});

test('no reset time falls back to retrying every five minutes', () => {
  assert.equal(limitResumeDelay(null, 1_000_000), 5 * 60 * 1000);
});
