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
  const pins = [];
  registerMissionIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    getModel: () => 'haiku',
    getEnv: () => ({}),
    run: async () => ({ ok: false, reason: 'unused' }),
    ledgerService: {
      report: async (req) => {
        reports.push(req);
        return {
          ok: true,
          projects: [
            { key: 'git:github.com/me/a', name: 'a' },
            { key: 'other', name: 'other' },
          ],
        };
      },
    },
    projects: {
      setClass: (key, cls) => {
        if (key !== 'git:github.com/me/a') throw new Error('bad project key');
        classes.push([key, cls]);
      },
      setPin: (key, on, name) => pins.push([key, on, name]),
    },
  });
  return { invoke: (ch, arg) => handlers.get(ch)({}, arg), reports, classes, pins, handlers };
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

test('mission:project-pin accepts only keys of the last ledger report, with the report name', async () => {
  const h = harness();
  const pin = (req) => h.invoke('mission:project-pin', req);
  // Nothing is known before a report.
  assert.deepEqual(await pin({ key: 'git:github.com/me/a', pinned: true }), { ok: false, reason: 'bad-input' });
  await h.invoke('mission:ledger', {});
  assert.deepEqual(await pin({ key: 'git:github.com/me/a', pinned: true, name: 'evil' }), { ok: true });
  assert.deepEqual(await pin({ key: 'git:github.com/me/a', pinned: false }), { ok: true });
  assert.deepEqual(await pin({ key: 'git:github.com/me/b', pinned: true }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await pin({ key: 'other', pinned: true }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await pin({ key: 'git:github.com/me/a', pinned: 'yes' }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await pin({ key: '__proto__', pinned: true }), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await pin(null), { ok: false, reason: 'bad-input' });
  assert.deepEqual(h.pins, [
    ['git:github.com/me/a', true, 'a'],
    ['git:github.com/me/a', false, 'a'],
  ]);
});
