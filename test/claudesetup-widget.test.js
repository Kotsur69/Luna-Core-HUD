// ============================================================================
// LunaCore - Claude setup switcher widget flow (modules/claudesetup.js)
// ----------------------------------------------------------------------------
// The widget's state machine against a stub DOM and a fake window.lunacore:
// it lists and shows the applied profile, previews before anything is
// written, Cancel never reaches apply and puts the select back, Confirm calls
// apply and reports the running-session count, and failures are an error
// state rather than a crash. The tests share one module instance (its state
// survives remounts by design), so they run in order and build on each other.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- stub DOM --------------------------------------------------------------------

let focused = null;

function fakeEl(tag = 'div') {
  const listeners = {};
  let value = '';
  const el = {
    tag,
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    children: [],
    classList: {
      names: new Set(),
      toggle(name, on) {
        if (on) this.names.add(name);
        else this.names.delete(name);
      },
      contains(name) {
        return this.names.has(name);
      },
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, ev = {}) {
      for (const fn of listeners[type] || []) fn(ev);
    },
    replaceChildren(...kids) {
      el.children = kids;
    },
    append(...kids) {
      el.children.push(...kids);
    },
    focus() {
      focused = el;
    },
  };
  // A <select> only takes a value one of its options has, like the real one.
  Object.defineProperty(el, 'value', {
    get: () => value,
    set: (v) => {
      value = tag !== 'select' || el.children.some((o) => o.value === v) ? v : '';
    },
  });
  return el;
}

const IDS = {
  'claude-setup-select': 'select',
  'claude-setup-refresh': 'button',
  'claude-setup-desc': 'p',
  'claude-setup-cost': 'p',
  'claude-setup-stale': 'p',
  'claude-setup-note': 'p',
  'claude-setup-confirm': 'div',
  'claude-setup-confirm-title': 'p',
  'claude-setup-steps': 'ul',
  'claude-setup-running': 'p',
  'claude-setup-apply': 'button',
  'claude-setup-cancel': 'button',
  'claude-setup-agy-toggle': 'input',
  'claude-setup-agy-sync': 'button',
  'claude-setup-agy-status': 'p',
};

function fakeRoot() {
  const els = Object.fromEntries(Object.entries(IDS).map(([id, tag]) => [id, fakeEl(tag)]));
  return { els, querySelector: (sel) => els[sel.replace(/^#/, '')] || null };
}

// ---- fake bridge -----------------------------------------------------------------

const PROFILES = [
  { name: 'coding', description: 'Everyday coding', active: true },
  { name: 'minimal', description: 'Bare minimum', active: false },
  { name: 'current', description: 'Snapshot', active: false },
];

const bridge = {
  calls: [],
  active: 'coding',
  listAnswer: null, // override for the next list() only
  previewAnswer: null, // override for the next preview() only
  previewGate: null, // a promise preview() waits on, to hold it in flight
  // Antigravity mirror. Its calls go to agyCalls, so the switch flow's call
  // lists above stay exactly what they were.
  agyCalls: [],
  agy: { ok: true, available: true, enabled: true, profile: null, mirroredAt: null, lastError: null },
  applyAgy: null, // the `agy` field of the next apply() answer
  agySyncAnswer: null, // override for the next agySync() only
};

globalThis.window = {
  i18n: { lang: 'en', t: (key, params) => (params && Object.keys(params).length ? `${key} ${JSON.stringify(params)}` : key) },
  lunacore: {
    claudeSetupList: async () => {
      bridge.calls.push(['list']);
      const answer = bridge.listAnswer || { ok: true, profiles: PROFILES.map((p) => ({ ...p, active: p.name === bridge.active })), stale: false };
      bridge.listAnswer = null;
      return answer;
    },
    claudeSetupStatus: async () => {
      bridge.calls.push(['status']);
      return { ok: true, profile: bridge.active, appliedAt: null, tokens: bridge.active === 'coding' ? 18234 : 4200 };
    },
    claudeSetupPreview: async (name) => {
      bridge.calls.push(['preview', name]);
      if (bridge.previewGate) await bridge.previewGate;
      const answer = bridge.previewAnswer || {
        ok: true,
        profile: name,
        from: bridge.active,
        steps: ['replace settings.json', 'remove 12 skills'],
        warnings: ['plugin x is not installed'],
        running: 3,
        tokens: null,
      };
      bridge.previewAnswer = null;
      return answer;
    },
    claudeSetupApply: async (name) => {
      bridge.calls.push(['apply', name]);
      bridge.active = name;
      const agy = bridge.applyAgy ? { agy: bridge.applyAgy } : {};
      bridge.applyAgy = null;
      return { ok: true, profile: name, steps: [], warnings: [], running: 2, tokens: 4200, ...agy };
    },
    claudeSetupAgyStatus: async () => {
      bridge.agyCalls.push(['agyStatus']);
      return { ...bridge.agy };
    },
    claudeSetupAgySetEnabled: async (on) => {
      bridge.agyCalls.push(['agySetEnabled', on]);
      bridge.agy = { ...bridge.agy, enabled: on };
      return { ...bridge.agy };
    },
    claudeSetupAgySync: async () => {
      bridge.agyCalls.push(['agySync']);
      const answer = bridge.agySyncAnswer || { ok: true, profile: bridge.active, mirroredAt: '2026-11-16T12:00:00.000Z', servers: 1, skills: 3, skipped: 0, warnings: [] };
      bridge.agySyncAnswer = null;
      return answer;
    },
  },
};
globalThis.document = { createElement: (tag) => fakeEl(tag) };

const { initClaudeSetup, formatTokens } = require('../src/renderer/modules/claudesetup.js');
const { getWidget } = require('../src/renderer/modules/registry.js');

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};
const kinds = () => bridge.calls.map((c) => c[0]);
const optionValues = (select) => select.children.map((o) => o.value);

let root = null;
let unmount = null;

function mount() {
  root = fakeRoot();
  unmount = getWidget('setup').mount(root);
  return root.els;
}

// ---- the flow --------------------------------------------------------------------

test('formatTokens: thousands as k, small numbers as they are', () => {
  assert.equal(formatTokens(18234), '18k');
  assert.equal(formatTokens(640), '640');
  assert.equal(formatTokens(null), '');
  assert.equal(formatTokens(-5), '');
});

test('the setup widget is registered with its template and title', () => {
  const w = getWidget('setup');
  assert.ok(w);
  assert.equal(w.template, 'w-setup');
  assert.equal(w.titleKey, 'claudesetup.title');
});

test('nothing loads until initClaudeSetup(); then profiles, active, description and cost show', async () => {
  const els = mount();
  await settle();
  assert.deepEqual(bridge.calls, [], 'mounting alone asks main nothing');

  initClaudeSetup();
  await settle();
  assert.deepEqual(kinds(), ['list', 'status']);
  const select = els['claude-setup-select'];
  assert.deepEqual(optionValues(select), ['coding', 'minimal', 'current']);
  assert.equal(select.value, 'coding');
  assert.equal(select.disabled, false);
  assert.equal(els['claude-setup-desc'].textContent, 'Everyday coding');
  assert.match(els['claude-setup-cost'].textContent, /"n":"18k"/);
  assert.equal(els['claude-setup-confirm'].hidden, true);
});

test('picking a profile previews first; Cancel never applies and reverts the select', async () => {
  const els = root.els;
  bridge.calls = [];
  const select = els['claude-setup-select'];
  select.value = 'minimal';
  select.fire('change');
  await settle();

  assert.deepEqual(bridge.calls, [['preview', 'minimal']]);
  assert.equal(els['claude-setup-confirm'].hidden, false);
  assert.match(els['claude-setup-confirm-title'].textContent, /minimal/);
  const steps = els['claude-setup-steps'].children;
  assert.deepEqual(steps.map((li) => li.textContent), ['replace settings.json', 'remove 12 skills', 'plugin x is not installed']);
  assert.equal(steps[2].className, 'is-warning');
  assert.match(els['claude-setup-running'].textContent, /^claudesetup\.running \{"n":3\}$/);
  assert.equal(select.disabled, true, 'no second pick while the confirm is open');
  assert.equal(focused, els['claude-setup-cancel'], 'focus lands on the safe button');

  els['claude-setup-cancel'].fire('click');
  await settle();
  assert.ok(!kinds().includes('apply'), 'Cancel must not apply');
  assert.equal(els['claude-setup-confirm'].hidden, true);
  assert.equal(select.value, 'coding');
  assert.equal(select.disabled, false);
});

test('Escape in the confirm panel is a Cancel', async () => {
  const els = root.els;
  bridge.calls = [];
  els['claude-setup-select'].value = 'current';
  els['claude-setup-select'].fire('change');
  await settle();
  assert.equal(els['claude-setup-confirm'].hidden, false);
  els['claude-setup-confirm'].fire('keydown', { key: 'Escape' });
  await settle();
  assert.deepEqual(kinds(), ['preview']);
  assert.equal(els['claude-setup-select'].value, 'coding');
});

test('Confirm calls apply, reports the running sessions and reloads', async () => {
  const els = root.els;
  bridge.calls = [];
  els['claude-setup-select'].value = 'minimal';
  els['claude-setup-select'].fire('change');
  await settle();
  els['claude-setup-apply'].fire('click');
  await settle();

  assert.deepEqual(bridge.calls, [['preview', 'minimal'], ['apply', 'minimal'], ['list'], ['status']]);
  const note = els['claude-setup-note'];
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^claudesetup\.applied\.running /);
  assert.match(note.textContent, /"n":2/);
  assert.ok(note.classList.contains('is-ok'));
  assert.equal(els['claude-setup-select'].value, 'minimal');
  assert.equal(els['claude-setup-desc'].textContent, 'Bare minimum');
  assert.match(els['claude-setup-cost'].textContent, /"n":"4k"/);
  assert.equal(focused, els['claude-setup-select'], 'focus returns to the select after the reload');
});

test('a failed preview shows the error and leaves the select on the applied profile', async () => {
  const els = root.els;
  bridge.calls = [];
  bridge.previewAnswer = { ok: false, error: 'switcher-too-old' };
  els['claude-setup-select'].value = 'coding';
  els['claude-setup-select'].fire('change');
  await settle();
  assert.deepEqual(kinds(), ['preview']);
  assert.equal(els['claude-setup-confirm'].hidden, true);
  assert.equal(els['claude-setup-note'].textContent, 'claudesetup.err.tooOld');
  assert.ok(els['claude-setup-note'].classList.contains('is-error'));
  assert.equal(els['claude-setup-select'].value, 'minimal');
  assert.equal(els['claude-setup-select'].disabled, false);
});

test('a list failure is an error state with a working refresh, not a crash', async () => {
  const els = root.els;
  bridge.calls = [];
  bridge.listAnswer = { ok: false, error: 'clone-failed' };
  els['claude-setup-refresh'].fire('click');
  await settle();
  assert.deepEqual(kinds(), ['list']);
  assert.deepEqual(optionValues(els['claude-setup-select']), ['']);
  assert.equal(els['claude-setup-select'].children[0].textContent, 'claudesetup.unavailable');
  assert.equal(els['claude-setup-select'].disabled, true);
  assert.equal(els['claude-setup-refresh'].disabled, false);
  assert.equal(els['claude-setup-note'].textContent, 'claudesetup.err.clone');

  els['claude-setup-refresh'].fire('click');
  await settle();
  assert.equal(els['claude-setup-select'].disabled, false);
  assert.equal(els['claude-setup-note'].hidden, true);
});

test('unmounting mid-preview is safe, and a remount shows the open confirm', async () => {
  let release = null;
  bridge.previewGate = new Promise((r) => {
    release = r;
  });
  const els = root.els;
  els['claude-setup-select'].value = 'current';
  els['claude-setup-select'].fire('change');
  await settle();
  unmount();
  release();
  bridge.previewGate = null;
  await settle();

  const again = mount();
  assert.equal(again['claude-setup-confirm'].hidden, false);
  assert.equal(again['claude-setup-select'].value, 'current');
  again['claude-setup-cancel'].fire('click');
  assert.equal(again['claude-setup-select'].value, 'minimal');
  unmount();
});

// ---- the Antigravity (agy) mirror row ------------------------------------------

test('the agy row shows the saved state: toggle on, never synced', async () => {
  const els = mount();
  await settle();
  assert.ok(bridge.agyCalls.some((c) => c[0] === 'agyStatus'), 'loading the widget asks for the agy status');
  assert.equal(els['claude-setup-agy-toggle'].checked, true);
  assert.equal(els['claude-setup-agy-toggle'].disabled, false);
  assert.equal(els['claude-setup-agy-sync'].disabled, false);
  assert.equal(els['claude-setup-agy-status'].textContent, 'claudesetup.agy.never');
  assert.equal(els['claude-setup-agy-status'].hidden, false);
});

test('unchecking the toggle saves false in main and shows the answer', async () => {
  const els = root.els;
  bridge.agyCalls = [];
  els['claude-setup-agy-toggle'].checked = false;
  els['claude-setup-agy-toggle'].fire('change');
  await settle();
  assert.deepEqual(bridge.agyCalls, [['agySetEnabled', false]]);
  assert.equal(els['claude-setup-agy-toggle'].checked, false);
  assert.equal(els['claude-setup-agy-toggle'].disabled, false);
});

test('Sync to agy now reports the counts, then re-reads the status', async () => {
  const els = root.els;
  bridge.agyCalls = [];
  bridge.calls = [];
  els['claude-setup-agy-sync'].fire('click');
  await settle();
  assert.deepEqual(bridge.agyCalls, [['agySync'], ['agyStatus']]);
  assert.deepEqual(bridge.calls, [], 'a manual sync never touches the Claude switch');
  const line = els['claude-setup-agy-status'];
  assert.match(line.textContent, /^claudesetup\.agy\.synced /);
  assert.match(line.textContent, /"servers":1/);
  assert.match(line.textContent, /"skills":3/);
  assert.ok(line.classList.contains('is-ok'));
});

test('a switch whose agy mirror failed is still a switch; the agy line shows the error', async () => {
  const els = root.els;
  bridge.applyAgy = { ok: false, error: 'broken-json', detail: 'mcp_config.json' };
  els['claude-setup-select'].value = 'coding';
  els['claude-setup-select'].fire('change');
  await settle();
  els['claude-setup-apply'].fire('click');
  await settle();
  const note = els['claude-setup-note'];
  assert.match(note.textContent, /^claudesetup\.applied/);
  assert.ok(note.classList.contains('is-ok'), 'the Claude switch reads as done');
  const line = els['claude-setup-agy-status'];
  assert.equal(line.textContent, 'claudesetup.agy.err.brokenJson (mcp_config.json)');
  assert.ok(line.classList.contains('is-error'));
});

test('a failed manual sync shows its error and never throws', async () => {
  const els = root.els;
  bridge.agySyncAnswer = { ok: false, error: 'busy' };
  els['claude-setup-agy-sync'].fire('click');
  await settle();
  assert.equal(els['claude-setup-agy-status'].textContent, 'claudesetup.err.busy');
  assert.equal(els['claude-setup-agy-sync'].disabled, false);
});

test('without agy installed the row is disabled and says so', async () => {
  const els = root.els;
  bridge.agy = { ...bridge.agy, available: false, enabled: false };
  els['claude-setup-refresh'].fire('click');
  await settle();
  assert.equal(els['claude-setup-agy-toggle'].disabled, true);
  assert.equal(els['claude-setup-agy-sync'].disabled, true);
  assert.equal(els['claude-setup-agy-status'].textContent, 'claudesetup.agy.missing');
  unmount();
});

test('a failed agy status read keeps the loaded state and says it failed', async () => {
  const els = mount();
  const original = window.lunacore.claudeSetupAgyStatus;
  bridge.agy = { ...bridge.agy, available: true, enabled: true };
  els['claude-setup-refresh'].fire('click');
  await settle();
  assert.equal(els['claude-setup-agy-sync'].disabled, false);

  window.lunacore.claudeSetupAgyStatus = async () => {
    throw new Error('ipc gone');
  };
  try {
    els['claude-setup-refresh'].fire('click');
    await settle();
    assert.equal(els['claude-setup-agy-status'].textContent, 'claudesetup.agy.err.failed');
    assert.equal(els['claude-setup-agy-toggle'].checked, true, 'the last good state stays');
    assert.equal(els['claude-setup-agy-sync'].disabled, false);
  } finally {
    window.lunacore.claudeSetupAgyStatus = original;
    unmount();
  }
});
