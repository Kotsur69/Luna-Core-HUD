// ============================================================================
// LunaCore - report visuals (renderer) under a tiny fake DOM
// ----------------------------------------------------------------------------
// src/renderer/modules/reportvisuals.js builds the stat tiles, bars, chips
// and <details> sections of the hub briefs and the God Mode run summary.
// The fake element throws on any innerHTML / outerHTML / insertAdjacentHTML
// write, so a test fails the moment data would reach HTML parsing. Static
// guards cover the two views that use the module (they import Electron-only
// modules, so they are read as text, not run).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fakeEl(tag) {
  const attrs = {};
  let text = '';
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    children: [],
    style: {},
    open: false,
    title: '',
    append(...kids) {
      for (const k of kids) node.children.push(typeof k === 'string' ? { textContent: k, children: [] } : k);
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    get textContent() {
      return text + node.children.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      text = String(v);
      node.children = [];
    },
  };
  for (const prop of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(node, prop, {
      set() {
        throw new Error(`${prop} write`);
      },
      get: () => '',
    });
  }
  node.insertAdjacentHTML = () => {
    throw new Error('insertAdjacentHTML');
  };
  return node;
}

/** Every node under (and including) root. */
function walk(root, out = []) {
  out.push(root);
  for (const c of root.children || []) walk(c, out);
  return out;
}
const byClass = (root, cls) => walk(root).filter((n) => typeof n.className === 'string' && n.className.split(' ').includes(cls));

globalThis.document = { createElement: fakeEl };
globalThis.window = { i18n: { lang: 'en', t: (key) => key } };

let rv;
test.before(async () => {
  rv = await import('../src/renderer/modules/reportvisuals.js');
});

// --- sample data ----------------------------------------------------------------

const weekly = () => ({
  key: '2026-W47',
  at: 1763380000000,
  model: 'sonnet',
  costUsd: 0.0123,
  brief: {
    headline: 'A calm week',
    priorities: ['Ship v0.33', 'Fix sync'],
    events: [{ key: 'e1', note: 'bring charger' }],
    todos: [{ project: 'LunaCore', text: 'Report visuals' }],
    mail: [{ from: 'Bank', subject: 'Statement', why: 'sign' }],
    news: ['Electron 44 is out'],
  },
  inputs: {
    week: '2026-W47',
    weekend: {
      since: '2026-11-15T00:00:00.000Z',
      commits: { repos: [{ repo: 'Luna-Core-HUD', commits: 12 }, { repo: 'site', commits: 3 }], failed: 0 },
      claude: { hours: { work: 5.25, fun: 1.5, other: 0, unassigned: 0 } },
    },
    events: [{ key: 'e1', title: 'Dentist', start: '2026-11-18T09:00:00Z', allDay: false, weather: { tMin: 2, tMax: 7, rain: 60 } }],
    todos: { totalOpen: 9, projects: [{ project: 'LunaCore', open: 9, items: ['Report visuals'] }] },
    goals: { week: '2026-W47', goals: [{ text: 'Ship', status: 'done' }, { text: 'Run', status: 'partly' }, { text: 'Read', status: 'notyet' }] },
  },
});

const run = () => ({
  id: 'p1abc',
  finishedAt: 1763380000000,
  repoName: 'Luna-Core-HUD',
  machine: 'PC-ONE',
  integrationMode: 'merge',
  integrationState: 'done',
  pushed: 3,
  merged: 2,
  total: 4,
  skipped: 1,
  blocked: 0,
  selfCheck: 'failed',
  needs: ['Resolve the conflict in a.js'],
  manual: [],
  packages: [
    { id: 'a', state: 'pushed' },
    { id: 'b', state: 'pushed' },
    { id: 'c', state: 'failed' },
    { id: 'd', state: 'weird' },
  ],
});

const tile = (tiles, label) => tiles.find((x) => x.label === label);

// --- brief data -----------------------------------------------------------------

test('briefStats: tiles come from the weekly brief inputs', () => {
  const tiles = rv.briefStats(weekly());
  assert.equal(tile(tiles, 'rv.brief.commitsWeekend').value, 15);
  assert.equal(tile(tiles, 'rv.brief.events').value, 1);
  assert.equal(tile(tiles, 'rv.brief.todosOpen').value, 9);
  assert.equal(tile(tiles, 'rv.brief.mail').value, 1);
  assert.equal(tile(tiles, 'rv.brief.goals').value, '1/3');
  assert.equal(tile(tiles, 'rv.brief.claudeHours').value, '6.8 h');
});

test("briefStats: a daily brief counts yesterday's commits", () => {
  const e = weekly();
  e.inputs = { yesterday: { repos: [{ repo: 'x', commits: 4 }] }, events: [] };
  const tiles = rv.briefStats(e);
  assert.equal(tile(tiles, 'rv.brief.commitsYesterday').value, 4);
  assert.equal(tile(tiles, 'rv.brief.events').value, 0);
  assert.equal(tile(tiles, 'rv.brief.goals'), undefined, 'no goals -> no tile');
});

test('briefStats: missing or failed sources drop their tiles, never NaN', () => {
  assert.deepEqual(rv.briefStats(null), []);
  assert.deepEqual(rv.briefStats({}), []);
  const failed = {
    brief: null,
    inputs: { weekend: { commits: { error: 'failed' }, claude: { error: 'failed' } }, todos: { error: 'failed' }, goals: { error: 'failed' } },
  };
  assert.deepEqual(rv.briefStats(failed), []);
  for (const x of rv.briefStats({ brief: { mail: 'oops' }, inputs: { todos: { totalOpen: NaN }, events: 'x' } })) {
    assert.ok(!/NaN|undefined/.test(String(x.value)), String(x.value));
  }
});

test('brief bars, Claude split and goals degrade to empty lists', () => {
  assert.deepEqual(rv.briefRepoBars(weekly()).map((r) => [r.label, r.value]), [['Luna-Core-HUD', 12], ['site', 3]]);
  assert.deepEqual(rv.briefClaudeSplit(weekly()).map((s) => s.text), ['5.3 h', '1.5 h']);
  assert.equal(rv.briefGoals(weekly()).length, 3);
  for (const bad of [null, {}, { inputs: { weekend: { commits: { repos: [null, { repo: 1 }] } } } }]) {
    assert.deepEqual(rv.briefRepoBars(bad), []);
    assert.deepEqual(rv.briefClaudeSplit(bad), []);
    assert.deepEqual(rv.briefGoals(bad), []);
  }
  assert.equal(rv.goalTone('done'), 'ok');
  assert.equal(rv.goalTone('partly'), 'warn');
  assert.equal(rv.goalTone('anything'), 'muted');
});

// --- run data -------------------------------------------------------------------

test('runStats: merge run shows merged of total, failures, skipped and self-check', () => {
  const tiles = rv.runStats(run());
  assert.deepEqual(tile(tiles, 'gm.sum.merged'), { label: 'gm.sum.merged', value: '2/4', tone: 'warn' });
  assert.equal(tile(tiles, 'rv.run.failed').value, 1);
  assert.equal(tile(tiles, 'rv.run.failed').tone, 'bad');
  assert.equal(tile(tiles, 'rv.run.skipped').value, 1);
  assert.equal(tile(tiles, 'rv.run.blocked'), undefined, 'zero blocked -> no tile');
  assert.deepEqual(tile(tiles, 'gm.sum.selfCheck'), { label: 'gm.sum.selfCheck', value: 'rv.selfCheck.failed', tone: 'bad' });
  assert.equal(tile(tiles, 'gm.sum.needs').value, 1);
});

test('runStats: a branches run counts pushed; empty runs stay readable', () => {
  const r = { ...run(), integrationMode: 'branches' };
  assert.equal(tile(rv.runStats(r), 'gm.sum.pushed').value, '3/4');
  assert.deepEqual(rv.runStats(null), []);
  const bare = rv.runStats({ packages: 'nope' });
  assert.deepEqual(tile(bare, 'gm.sum.pushed'), { label: 'gm.sum.pushed', value: '0/0', tone: 'muted' });
  assert.equal(tile(bare, 'gm.sum.selfCheck').value, 'rv.selfCheck.none');
  assert.equal(tile(bare, 'gm.sum.needs'), undefined);
});

test('runStateSegments: fixed order, unknown states last and muted', () => {
  // The test t() echoes keys, so stateLabel falls back to the raw state.
  const segs = rv.runStateSegments(run());
  assert.deepEqual(segs.map((s) => [s.label, s.value, s.tone]), [
    ['pushed', 2, 'ok'],
    ['failed', 1, 'bad'],
    ['weird', 1, 'muted'],
  ]);
  assert.deepEqual(rv.runStateSegments({}), []);
  const saved = window.i18n.t;
  window.i18n.t = (key) => (key === 'rv.state.pushed' ? 'pushed!' : key);
  try {
    assert.equal(rv.stateLabel('pushed'), 'pushed!', 'a translated label wins');
    assert.equal(rv.stateLabel(undefined), '-');
  } finally {
    window.i18n.t = saved;
  }
});

// --- DOM blocks -----------------------------------------------------------------

test('statTiles renders one tile per usable item and skips the rest', () => {
  const ul = rv.statTiles([{ label: 'A', value: 3, tone: 'ok' }, { label: 'B', value: '' }, { label: 'C', value: NaN }, { label: 'D', value: '1/2', tone: 'bogus' }], 'Numbers');
  assert.equal(ul.tagName, 'UL');
  assert.equal(ul.getAttribute('aria-label'), 'Numbers');
  assert.equal(ul.children.length, 2);
  assert.equal(ul.children[0].className, 'rv-tile is-ok');
  assert.equal(ul.children[1].className, 'rv-tile is-muted', 'an unknown tone falls back');
  assert.equal(byClass(ul, 'rv-tile__value').map((n) => n.textContent).join(','), '3,1/2');
  assert.equal(rv.statTiles([]), null);
  assert.equal(rv.statTiles(undefined), null);
});

test('statTiles renders the brief and run samples', () => {
  const brief = rv.statTiles(rv.briefStats(weekly()));
  assert.equal(brief.children.length, 6);
  const runTiles = rv.statTiles(rv.runStats(run()));
  assert.ok(byClass(runTiles, 'rv-tile__label').some((n) => n.textContent === 'gm.sum.merged'));
});

test('chip pairs the colour with an aria-hidden icon and visible text', () => {
  const c = rv.chip('failed', 'bad');
  assert.equal(c.className, 'rv-chip is-bad');
  const [icon, text] = c.children;
  assert.equal(icon.textContent, rv.TONE_ICON.bad);
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(text.textContent, 'failed');
  assert.equal(rv.chip('x', 'nope').className, 'rv-chip is-muted');
  for (const tone of Object.keys(rv.TONE_ICON)) assert.ok(rv.TONE_ICON[tone], tone);
});

test('barList scales to the largest value and keeps numbers as text', () => {
  const ul = rv.barList([{ label: 'big', value: 10 }, { label: 'small', value: 1 }, { label: 'zero', value: 0 }, { label: 'bad', value: NaN }], 'By repo');
  assert.equal(ul.children.length, 2);
  const fills = byClass(ul, 'rv-bar__fill');
  assert.deepEqual(fills.map((f) => f.style.width), ['100%', '10%']);
  assert.equal(byClass(ul, 'rv-bar__track')[0].getAttribute('aria-hidden'), 'true');
  assert.deepEqual(byClass(ul, 'rv-bar__value').map((n) => n.textContent), ['10', '1']);
  assert.equal(rv.barList([{ label: 'a', value: 0 }]), null);
  assert.equal(rv.barList(null), null);
});

test('stackBar shares sum to 100% with a chip legend', () => {
  const box = rv.stackBar(rv.runStateSegments(run()), 'States');
  const widths = byClass(box, 'rv-stack__seg').map((s) => parseFloat(s.style.width));
  assert.equal(Math.round(widths.reduce((a, b) => a + b, 0)), 100);
  assert.equal(byClass(box, 'rv-chip').length, 3);
  assert.equal(rv.stackBar([], 'x'), null);
  assert.equal(rv.stackBar([{ label: 'a', value: -1 }]), null);
});

test('details is a native <details> with a count and skips null children', () => {
  const d = rv.details('Mail', 2, [null, rv.caption('x')], { open: true, cls: 'extra' });
  assert.equal(d.tagName, 'DETAILS');
  assert.equal(d.className, 'rv-details extra');
  assert.equal(d.open, true);
  const [summary, body] = d.children;
  assert.equal(summary.tagName, 'SUMMARY');
  assert.equal(byClass(summary, 'rv-details__count')[0].textContent, '2');
  assert.equal(body.children.length, 1);
  assert.equal(rv.details('x', null, []).open, false, 'closed by default');
  assert.equal(byClass(rv.details('x', null, []), 'rv-details__count').length, 0);
});

test('hostile text stays text (the fake DOM throws on any HTML write)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const e = weekly();
  e.inputs.weekend.commits.repos = [{ repo: evil, commits: 2 }];
  e.inputs.goals.goals = [{ text: evil, status: 'done' }];
  const bars = rv.barList(rv.briefRepoBars(e));
  assert.equal(byClass(bars, 'rv-bar__label')[0].textContent, evil);
  assert.equal(rv.chip(evil, 'ok').textContent.endsWith(evil), true);
  assert.equal(rv.details(evil, 1, []).children[0].textContent.startsWith(evil), true);
});

// --- static guards over the views -----------------------------------------------

const VIEWS = ['src/renderer/modules/reportvisuals.js', 'src/renderer/modules/missionbriefview.js', 'src/renderer/modules/godmodesummary.js'];

test('the brief and run summary views never write HTML', () => {
  for (const rel of VIEWS) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|DOMParser/.test(read(rel)), rel);
});

test('the views mount the visuals and keep their public names', () => {
  const brief = read('src/renderer/modules/missionbriefview.js');
  assert.ok(brief.includes("from './reportvisuals.js'"));
  assert.ok(brief.includes('statTiles(briefStats(entry)'));
  assert.ok(/export function showBrief\(root\)/.test(brief));
  // The weekly cost line still goes through one small function (another package edits it).
  assert.ok(/^const cost = \(usd\) =>/m.test(brief));
  // The report-models package routes it through reportCost ('$0' on agy, which reports no cost).
  assert.ok(brief.includes('reportCost(entry, cost)'));
  assert.ok(brief.includes("t('mc.brief.cost', { cost: costLine })"));
  const sum = read('src/renderer/modules/godmodesummary.js');
  assert.ok(sum.includes('statTiles(runStats(run)'));
  assert.ok(sum.includes('stackBar(runStateSegments(run)'));
  assert.ok(/export async function openRunSummary\(machine, id/.test(sum));
});

test('every rv.* key is defined in pl and en, and the stylesheet is linked', () => {
  const I18N = read('src/renderer/i18n.js');
  const EN_AT = I18N.indexOf('\n  en: {');
  const used = new Set();
  for (const rel of VIEWS) for (const m of read(rel).matchAll(/'(rv\.[a-zA-Z.]+[a-zA-Z])'/g)) used.add(m[1]);
  for (const s of ['pushed', 'launched', 'finishing', 'pending', 'killed', 'stalled', 'failed', 'closed', 'unknown']) used.add(`rv.state.${s}`);
  for (const s of ['ok', 'failed', 'none']) used.add(`rv.selfCheck.${s}`);
  for (const s of ['work', 'fun', 'other', 'unassigned']) used.add(`rv.class.${s}`);
  for (const s of ['done', 'partly', 'notyet']) used.add(`rv.goal.${s}`);
  assert.ok(used.size > 30);
  for (const key of used) {
    assert.ok(I18N.slice(0, EN_AT).includes(`'${key}':`), `pl ${key}`);
    assert.ok(I18N.slice(EN_AT).includes(`'${key}':`), `en ${key}`);
  }
  assert.ok(read('src/renderer/index.html').includes('href="reportvisuals.css"'));
});

test('reportvisuals.css uses theme tokens only and respects reduced motion', () => {
  const css = read('src/renderer/reportvisuals.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex colours');
  assert.ok(!/\brgba?\(/.test(css), 'no rgb() colours');
  // Transitions only inside the no-preference block.
  const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
  assert.ok(!/transition|animation/.test(outside), 'motion only when the OS allows it');
});
