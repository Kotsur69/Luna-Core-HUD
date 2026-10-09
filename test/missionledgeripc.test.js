// ============================================================================
// LunaCore - Mission Control ledger IPC tests (mission:ledger*, project-class)
// ----------------------------------------------------------------------------
// Driven through a fake ipcMain; the service, the store and the folder dialog
// are fakes. The renderer side is untrusted: every payload shape is probed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerMissionIpc } = require('../src/missioncontrolipc.js');

function harness({ picked = null } = {}) {
  const handlers = new Map();
  const reports = [];
  const classes = [];
  const dirs = [];
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
      setSharedDir: (dir) => {
        dirs.push(dir);
        return { classes: {}, sharedDir: dir };
      },
    },
    pickDir: async () => picked,
  });
  return { invoke: (ch, arg) => handlers.get(ch)({}, arg), reports, classes, dirs };
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

test('mission:ledger-pick-dir stores the folder the dialog returned', async () => {
  const h = harness({ picked: 'D:\\Sync\\ledger' });
  assert.deepEqual(await h.invoke('mission:ledger-pick-dir', 'C:\\ignored-renderer-path'), { ok: true, sharedDir: 'D:\\Sync\\ledger' });
  assert.deepEqual(h.dirs, ['D:\\Sync\\ledger']);
});

test('a cancelled dialog changes nothing', async () => {
  const h = harness({ picked: null });
  assert.deepEqual(await h.invoke('mission:ledger-pick-dir'), { ok: false, reason: 'cancelled' });
  assert.deepEqual(h.dirs, []);
});

test('mission:ledger-clear-dir clears the folder', async () => {
  const h = harness();
  assert.deepEqual(await h.invoke('mission:ledger-clear-dir'), { ok: true, sharedDir: null });
  assert.deepEqual(h.dirs, [null]);
});
