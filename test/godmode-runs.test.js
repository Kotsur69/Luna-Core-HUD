// ============================================================================
// God Mode with several tabs at once (ORCHESTRATOR_PLAN.md slice 2), driven
// end to end through a fake window.lunacore bridge: two tabs share one list,
// each run claims its own item, dependencies hold a run back, ticks from two
// runs never overwrite each other, and a run that can never move stalls.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- fake bridge (must exist before the module is loaded) ------------------

const bridge = {
  list: [],
  pastes: [], // [sessionId, text]
  reported: [], // every setGodModeRuns payload
  listeners: {},
};

const api = {
  getTodos: async () => bridge.list.map((item) => ({ ...item })),
  saveTodos: async (list) => {
    // A deliberately slow write: without serialization, two runs ticking at
    // once would each save a list missing the other's tick.
    await new Promise((r) => setTimeout(r, 5));
    bridge.list = list.map((item) => ({ ...item }));
    return true;
  },
  pastePrompt: (text, _submit, sessionId) => bridge.pastes.push([sessionId, text]),
  confirmGodMode: async () => true,
  setGodModeRuns: (ids) => bridge.reported.push([...ids].sort()),
  onTurnEnd: (cb) => { bridge.listeners.turnEnd = cb; },
  onGodModeSignal: (cb) => { bridge.listeners.signal = cb; },
  onSessions: (cb) => { bridge.listeners.sessions = cb; },
};

globalThis.window = {
  // Anything else the module chain touches is a harmless no-op.
  lunacore: new Proxy(api, { get: (o, k) => (k in o ? o[k] : k === 'then' ? undefined : () => () => {}) }),
  i18n: { t: (key) => key, lang: 'en' },
};

const { mountGodModeControl, isBoundSession } = require('../src/renderer/modules/godmode.js');
const { setActiveSessionId } = require('../src/renderer/modules/terminals.js');

// ---- fake widget DOM ---------------------------------------------------------

const toggle = {
  checked: false,
  onChange: null,
  addEventListener(_type, fn) { this.onChange = fn; },
};
const status = { textContent: '' };
const field = { classList: { toggle() {} } };
const root = {
  querySelector: (sel) => ({ '#godmode-field': field, '#godmode-status': status, '#godmode-toggle': toggle })[sel],
};
mountGodModeControl(root);

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 2));
};

async function armOn(sessionId) {
  setActiveSessionId(sessionId);
  toggle.checked = true;
  toggle.onChange();
  await flush();
}

async function turnEnd(sessionId) {
  bridge.listeners.turnEnd({ sessionId });
  await flush();
}

const pastedTo = (sessionId) => bridge.pastes.filter(([id]) => id === sessionId).map(([, text]) => text.split(' (')[0]);
const item = (at, text, extra = {}) => ({ text, done: false, at, ...extra });

test('two tabs split one list, respect dependsOn, and both ticks land', async () => {
  bridge.list = [item(1, 'one'), item(2, 'two'), item(3, 'three', { dependsOn: [2] })];

  await armOn('s1');
  await armOn('s2');
  assert.deepEqual(pastedTo('s1'), ['one']);
  assert.deepEqual(pastedTo('s2'), ['two'], 's2 skips the item s1 holds');
  assert.deepEqual(bridge.reported.at(-1), ['s1', 's2']);
  assert.equal(isBoundSession('s1'), true);

  // s1 finishes "one"; "three" waits on "two" (held by s2) -> s1 waits.
  // s2 finishes "two" in the same breath - both ticks must survive.
  bridge.listeners.turnEnd({ sessionId: 's1' });
  bridge.listeners.turnEnd({ sessionId: 's2' });
  await flush();
  assert.deepEqual(bridge.list.map((i) => i.done), [true, true, false]);
  const third = [...pastedTo('s1'), ...pastedTo('s2')].filter((t) => t === 'three');
  assert.equal(third.length, 1, '"three" is pasted exactly once, by whichever run got it');

  const holder = pastedTo('s1').includes('three') ? 's1' : 's2';
  await turnEnd(holder);
  assert.equal(bridge.list.every((i) => i.done), true);
  assert.deepEqual(bridge.reported.at(-1), [], 'both runs ended, the overnight guard is released');
  assert.equal(isBoundSession('s1'), false);
  assert.equal(isBoundSession('s2'), false);
});

test('a dependency cycle stalls the run instead of waiting forever', async () => {
  bridge.list = [item(10, 'a', { dependsOn: [11] }), item(11, 'b', { dependsOn: [10] })];
  const before = bridge.pastes.length;
  await armOn('s1');
  assert.equal(bridge.pastes.length, before, 'nothing pasted');
  assert.equal(isBoundSession('s1'), false);
  assert.equal(status.textContent, 'godmode.stalled');
  assert.equal(toggle.checked, false);
});

test('closing a tab ends its run and frees its claim for the others', async () => {
  bridge.list = [item(20, 'x'), item(21, 'y')];
  await armOn('s3');
  await armOn('s4');
  assert.deepEqual(pastedTo('s4').at(-1), 'y');
  bridge.listeners.sessions({ sessions: [{ id: 's4' }] }); // s3's tab closed
  await flush();
  assert.equal(isBoundSession('s3'), false);
  await turnEnd('s4');
  assert.deepEqual(pastedTo('s4').at(-1), 'x', 's4 picks up the item s3 abandoned');
  await turnEnd('s4');
  assert.deepEqual(bridge.reported.at(-1), []);
});
