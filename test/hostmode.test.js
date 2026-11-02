// ============================================================================
// LunaCore - host mode inside the running HUD
// ----------------------------------------------------------------------------
// src/hostswitch.js (start / stop / make-default without a restart, the
// launcher's window hiding) and src/hostmodeipc.js (the renderer payload is
// whitelisted before anything runs).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostSwitch } = require('../src/hostswitch.js');
const { runHostMode, validAction, registerHostModeIpc, ACTIONS } = require('../src/hostmodeipc.js');

/** A fake startHost(): records calls; stop() runs onStop like the real one. */
function fakeHost({ defaultFile = { machine: null } } = {}) {
  const calls = [];
  let live = null;
  // Like the real setDefault(): write the file, then onDefaultSet (no own configSync).
  const writeDefault = (opts) => {
    defaultFile.machine = opts.machine;
    if (opts.onDefaultSet) opts.onDefaultSet();
  };
  const startHost = (opts) => {
    calls.push({ kind: 'start', opts });
    if (opts.makeDefault) writeDefault(opts);
    live = {
      stopped: false,
      stop() {
        if (this.stopped) return;
        this.stopped = true;
        calls.push({ kind: 'stop' });
        opts.onStop();
      },
      setDefault() {
        calls.push({ kind: 'setDefault' });
        writeDefault(opts);
      },
    };
    return live;
  };
  return { calls, startHost, defaultFile, live: () => live };
}

function fakeWindow() {
  return {
    visible: true,
    destroyed: false,
    hide() { this.visible = false; },
    show() { this.visible = true; },
    isDestroyed() { return this.destroyed; },
  };
}

function setup({ cloud = { id: 'cloud' }, chatTabs = { id: 'tabs' }, wins = [fakeWindow()] } = {}) {
  const fake = fakeHost();
  const soon = [];
  const logs = [];
  const control = createHostSwitch({
    machine: 'KT-PC-LLM',
    startHost: fake.startHost,
    hud: () => ({ cloud, chatTabs, configSync: { soon: () => soon.push(1) } }),
    windows: () => wins,
    isDefault: () => fake.defaultFile.machine === 'KT-PC-LLM',
    log: (...a) => logs.push(a.join(' ')),
  });
  return { control, fake, soon, logs, wins };
}

// ---- hostswitch -----------------------------------------------------------

test('start: runs startHost on the HUD cloud and chat tabs, no restart', () => {
  const { control, fake, wins } = setup();
  const r = control.start();
  assert.deepEqual(r, { ok: true, on: true, isDefault: false, machine: 'KT-PC-LLM' });
  assert.equal(fake.calls.length, 1);
  const { opts } = fake.calls[0];
  assert.deepEqual(opts.cloud, { id: 'cloud' });
  assert.deepEqual(opts.chatTabs, { id: 'tabs' });
  assert.equal(opts.makeDefault, false);
  assert.equal(control.isOn(), true);
  assert.equal(wins[0].visible, true, 'the in-app toggle leaves the HUD up');
});

test('start twice: one host only', () => {
  const { control, fake } = setup();
  control.start();
  control.start();
  assert.equal(fake.calls.filter((c) => c.kind === 'start').length, 1);
});

test('start: no HUD cloud yet -> refused, nothing started', () => {
  const { control, fake, logs } = setup({ cloud: null });
  assert.deepEqual(control.start(), { ok: false, reason: 'notReady' });
  assert.equal(fake.calls.length, 0);
  assert.equal(control.isOn(), false);
  assert.equal(logs.length, 1);
});

test('start: a throwing startHost leaves host mode off and the windows shown', () => {
  const wins = [fakeWindow()];
  const control = createHostSwitch({
    machine: 'M',
    startHost: () => {
      throw new Error('tray failed');
    },
    hud: () => ({ cloud: {} }),
    windows: () => wins,
    isDefault: () => false,
    log: () => {},
  });
  assert.deepEqual(control.start({ hideWindows: true }), { ok: false, reason: 'failed' });
  assert.equal(control.isOn(), false);
  assert.equal(wins[0].visible, true);
});

test('stop: stops the host cleanly and allows a fresh start', () => {
  const { control, fake } = setup();
  control.start();
  const first = fake.live();
  assert.deepEqual(control.stop(), { ok: true, on: false, isDefault: false, machine: 'KT-PC-LLM' });
  assert.equal(first.stopped, true);
  assert.equal(control.isOn(), false);
  control.start();
  assert.notEqual(fake.live(), first, 'a new host (fresh chat slots), not the stopped one');
  assert.equal(fake.calls.filter((c) => c.kind === 'start').length, 2);
});

test('stop while off is a no-op', () => {
  const { control, fake } = setup();
  assert.equal(control.stop().on, false);
  assert.equal(fake.calls.length, 0);
});

test('the host tray Stop (onStop) turns the switch off too', () => {
  const { control, fake } = setup();
  control.start();
  fake.live().stop(); // the tray's Stop calls the host's own stop()
  assert.equal(control.isOn(), false);
  assert.equal(control.status().on, false);
});

test('makeDefault while off: starts host mode with --make-default and pushes it', () => {
  const { control, fake, soon } = setup();
  const r = control.makeDefault();
  assert.deepEqual(r, { ok: true, on: true, isDefault: true, machine: 'KT-PC-LLM' });
  assert.equal(fake.calls[0].opts.makeDefault, true);
  assert.equal(soon.length, 1, 'the HUD config sync pushes host:default');
});

test('makeDefault while on: host.setDefault() on the running host', () => {
  const { control, fake, soon } = setup();
  control.start();
  const r = control.makeDefault();
  assert.equal(r.isDefault, true);
  assert.deepEqual(fake.calls.map((c) => c.kind), ['start', 'setDefault']);
  assert.equal(soon.length, 1);
});

test('the host tray "make default" item reaches the HUD config sync too', () => {
  const { control, fake, soon } = setup();
  control.start();
  assert.equal(soon.length, 0);
  fake.live().setDefault(); // the tray item calls the host's own setDefault()
  assert.equal(soon.length, 1);
  assert.equal(control.status().isDefault, true);
});

test('launcher switch (--host second instance) hides the HUD; Stop shows it again', () => {
  const wins = [fakeWindow(), fakeWindow()];
  const { control, fake } = setup({ wins });
  control.start({ hideWindows: true });
  assert.deepEqual(wins.map((w) => w.visible), [false, false]);
  wins[1].destroyed = true;
  fake.live().stop();
  assert.deepEqual(wins.map((w) => w.visible), [true, false], 'a destroyed window is skipped');
});

// ---- hostmodeipc ----------------------------------------------------------

test('validAction: only the exact whitelisted strings', () => {
  for (const a of ACTIONS) assert.equal(validAction(a), a);
  for (const bad of ['START', ' start', 'start ', 'makeDefault', '', 'quit', null, undefined, 1, {}, ['start'], { action: 'start' }]) {
    assert.equal(validAction(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});

test('runHostMode: a bad payload never touches the controller', () => {
  let touched = false;
  const spy = new Proxy({}, { get: () => () => { touched = true; } });
  assert.deepEqual(runHostMode(spy, 'rm -rf'), { ok: false, reason: 'badAction' });
  assert.deepEqual(runHostMode(spy, { toString: () => 'start' }), { ok: false, reason: 'badAction' });
  assert.equal(touched, false);
});

test('runHostMode: routes each action', () => {
  const { control } = setup();
  assert.equal(runHostMode(control, 'status').on, false);
  assert.equal(runHostMode(control, 'start').on, true);
  assert.equal(runHostMode(control, 'make-default').isDefault, true);
  assert.equal(runHostMode(control, 'stop').on, false);
});

test('runHostMode: no controller (headless host) and a throwing one answer cleanly', () => {
  assert.deepEqual(runHostMode(null, 'start'), { ok: false, reason: 'unavailable' });
  const orig = console.error;
  console.error = () => {};
  try {
    const boom = { start: () => { throw new Error('x'); } };
    assert.deepEqual(runHostMode(boom, 'start'), { ok: false, reason: 'failed' });
  } finally {
    console.error = orig;
  }
});

test('registerHostModeIpc: one channel, payload passed through validation', async () => {
  const handlers = new Map();
  const { control } = setup();
  registerHostModeIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, control });
  assert.deepEqual([...handlers.keys()], ['hostMode:run']);
  const handle = handlers.get('hostMode:run');
  assert.deepEqual(await handle({}, 42), { ok: false, reason: 'badAction' });
  assert.equal((await handle({}, 'start')).on, true);
});
