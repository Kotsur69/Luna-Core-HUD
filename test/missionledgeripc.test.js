// ============================================================================
// LunaCore - Mission Control ledger IPC tests (mission:ledger*, project-class)
// ----------------------------------------------------------------------------
// Driven through a fake ipcMain; the service and the store are fakes. The renderer side is untrusted: every payload shape is probed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerMissionIpc } = require('../src/missioncontrolipc.js');

function harness() {
  const handlers = new Map();
  const reports = [];
  const classes = [];
  registerMissionIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    getModel: () => 'haiku',
    getEnv: () => ({}),
    run: async () => ({ ok: false, reason: 'unused' }),
    ledgerService: {
      report: async (req) => {
        reports.push(req);
        return { ok: true, projects: [] };
      },
    },
    projects: {
      setClass: (key, cls) => {
        if (key !== 'git:github.com/me/a') throw new Error('bad project key');
        classes.push([key, cls]);
      },
    },
  });
  return { invoke: (ch, arg) => handlers.get(ch)({}, arg), reports, classes, handlers };
}

test('mission:ledger passes only a numeric resetsAt to the service', async () => {
  const h = harness();
  await h.invoke('mission:ledger', { resetsAt: 123, evil: 'x' });
  await h.invoke('mission:ledger', { resetsAt: '123' });
  await h.invoke('mission:ledger');
  assert.deepEqual(h.reports, [{ resetsAt: 123 }, { resetsAt: null }, { resetsAt: null }]);
});

test('mission:project-class sets a valid class and reports bad input without throwing', async () => {
  const h = harness();
  assert.deepEqual(await h.invoke('mission:project-class', { key: 'git:github.com/me/a', cls: 'fun' }), { ok: true });
  assert.deepEqual(await h.invoke('mission:project-class', { key: 'C:\\x', cls: 'fun' }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await h.invoke('mission:project-class', null), { ok: false, reason: 'bad-input' });
  assert.deepEqual(h.classes, [['git:github.com/me/a', 'fun']]);
});

test('the old shared-folder channels are gone', () => {
  const h = harness();
  assert.equal(h.handlers.has('mission:ledger-pick-dir'), false);
  assert.equal(h.handlers.has('mission:ledger-clear-dir'), false);
});
