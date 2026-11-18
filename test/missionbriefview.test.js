// ============================================================================
// LunaCore - weekly / daily brief card renderer (modules/missionbriefview.js)
// ----------------------------------------------------------------------------
// Stub DOM + real i18n dictionary. Pins: when the brief card mounts while
// window.i18n.lang is still 'pl' (startup before initAppearance() applies the
// saved 'en' preference, or when the user switches PL <-> EN while the hub
// drawer is open), emitLangChange() repaints the tabs, action buttons, review
// button, section headings and error/working status in the new language.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- stub DOM --------------------------------------------------------------------

function fakeEl(tag = 'div') {
  const listeners = {};
  const attrs = {};
  let value = '';
  const el = {
    tag,
    textContent: '',
    className: '',
    type: '',
    hidden: false,
    disabled: false,
    children: [],
    setAttribute(name, val) {
      attrs[name] = String(val);
    },
    getAttribute(name) {
      return attrs[name] ?? null;
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
  };
  Object.defineProperty(el, 'value', {
    get: () => value,
    set: (v) => {
      value = tag !== 'select' || el.children.some((o) => o.value === v) ? v : '';
    },
  });
  return el;
}

function walk(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

function texts(root, predicate = () => true) {
  return walk(root)
    .filter(predicate)
    .map((n) => n.textContent)
    .filter(Boolean);
}

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

const WEEKLY_ENTRY = {
  kind: 'weekly',
  key: '2026-W47',
  at: new Date(2026, 10, 16, 8, 30).getTime(),
  model: 'haiku',
  costUsd: 0.02,
  brief: {
    headline: 'Quiet week ahead.',
    weekend: 'Shipped two small fixes.',
    priorities: ['Cut release'],
    events: [{ key: 'e1', note: 'Dry track' }],
    todos: [{ project: 'LunaCore', text: 'Fix brief lang' }],
    mail: [{ threadId: 't1', from: 'Alex', subject: 'Schedule', why: 'Confirm slot' }],
    news: ['Electron update'],
    nudge: '',
  },
  failure: null,
  inputs: {
    events: [{ key: 'e1', title: 'Trackday', start: '2026-11-19T09:00:00+01:00', allDay: false, weather: null }],
    todos: { projects: [{ project: 'LunaCore', items: ['Fix brief lang'] }] },
  },
};

let briefReply = {
  ok: true,
  model: 'haiku',
  models: ['haiku', 'sonnet', 'opus'],
  weekly: { keys: ['2026-W47', '2026-W46'], entry: WEEKLY_ENTRY },
  daily: { keys: [], entry: null },
};

globalThis.window = {
  addEventListener: () => {},
  lunacore: {
    missionBrief: async () => briefReply,
    missionBriefRun: async () => briefReply,
    missionBriefModel: async (m) => ({ ...briefReply, model: m }),
  },
};
globalThis.document = {
  createElement: (tag) => fakeEl(tag),
  getElementById: () => fakeEl('div'),
  querySelectorAll: () => [],
  documentElement: { dataset: {} },
};

require('../src/renderer/i18n.js');
const { emitLangChange } = require('../src/renderer/modules/bus.js');
const { showBrief } = require('../src/renderer/modules/missionbriefview.js');

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

test('showBrief mounted while lang is pl repaints to English on emitLangChange()', async () => {
  window.i18n.setLang('pl');
  const root = fakeEl('div');
  showBrief(root);
  await settle();

  const plButtons = texts(root, (n) => n.tag === 'button');
  assert.deepEqual(plButtons, ['Dzienny brief', 'Tygodniowy brief', 'Wygeneruj ponownie', 'Przeglad niedzielny']);
  const plHeads = texts(root, (n) => n.tag === 'h4');
  assert.deepEqual(plHeads, ['Priorytety', 'Kalendarz', 'To-do', 'Poczta do decyzji', 'Newsy']);

  // Simulate initAppearance() applying prefs.lang = 'en' after the hub opened,
  // or the user switching PL -> EN in Settings while the drawer is open.
  window.i18n.setLang('en');
  emitLangChange();

  const enButtons = texts(root, (n) => n.tag === 'button');
  assert.deepEqual(enButtons, ['Daily brief', 'Weekly brief', 'Regenerate', 'Sunday review']);
  const enHeads = texts(root, (n) => n.tag === 'h4');
  assert.deepEqual(enHeads, ['Priorities', 'Calendar', 'To-dos', 'Mail that needs a call', 'News']);
  const selects = walk(root).filter((n) => n.tag === 'select');
  assert.deepEqual(
    selects.map((s) => s.getAttribute('aria-label')),
    ['Brief history', 'Brief model']
  );
});

test('switching EN -> PL on the empty daily tab repaints the hint and button', async () => {
  window.i18n.setLang('en');
  emitLangChange();
  const root = fakeEl('div');
  showBrief(root);
  await settle();

  // Click the Daily brief tab (no daily entry exists).
  const dailyTab = walk(root).find((n) => n.tag === 'button' && n.textContent === 'Daily brief');
  assert.ok(dailyTab);
  dailyTab.fire('click');

  assert.ok(texts(root, (n) => n.tag === 'button').includes('Brief me'));
  assert.ok(texts(root, (n) => n.tag === 'p').includes('No daily brief - click "Brief me".'));

  window.i18n.setLang('pl');
  emitLangChange();

  assert.deepEqual(texts(root, (n) => n.tag === 'button'), ['Dzienny brief', 'Tygodniowy brief', 'Brief me']);
  assert.ok(texts(root, (n) => n.tag === 'p').includes('Brak dziennego briefu - kliknij "Brief me".'));
});

test('emitLangChange() re-translates working and error status lines', async () => {
  window.i18n.setLang('pl');
  const root = fakeEl('div');
  let resolveRun = null;
  window.lunacore.missionBriefRun = () =>
    new Promise((r) => {
      resolveRun = r;
    });

  showBrief(root);
  await settle();

  // Trigger a brief run while lang is PL -> working status appears in PL.
  const goBtn = walk(root).find((n) => n.tag === 'button' && n.textContent === 'Brief me');
  assert.ok(goBtn);
  goBtn.fire('click');
  await settle();
  assert.ok(texts(root, (n) => n.className === 'hint mc-status').includes('Przygotowuje brief (jedno wywolanie modelu, Gmail tylko do odczytu)...'));

  // Switch to EN mid-run -> working status repaints in EN.
  window.i18n.setLang('en');
  emitLangChange();
  assert.ok(texts(root, (n) => n.className === 'hint mc-status').includes('Preparing the brief (one model call, Gmail read-only)...'));

  // Finish the run with a timeout error in EN, then switch back to PL -> error repaints in PL.
  resolveRun({ ok: false, reason: 'timeout' });
  await settle();
  assert.ok(texts(root, (n) => n.className === 'hint mc-status').includes('The model did not answer in time.'));

  window.i18n.setLang('pl');
  emitLangChange();
  assert.ok(texts(root, (n) => n.className === 'hint mc-status').includes('Model nie odpowiedzial na czas.'));
});
