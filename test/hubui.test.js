// ============================================================================
// LunaCore - notification hub renderer contract (N2 + N3)
// ----------------------------------------------------------------------------
// Static drift guards over the renderer files - the drawer and the chip run
// in Electron, not node, so these check what can be checked without a DOM:
//   - the face chip is in the palette bar, badge hidden at 0, theme-coloured;
//   - #mission-brief and its button left Mission Control for good;
//   - hub.css uses theme tokens only (no hex, rgb or `white`);
//   - the drawer renders with textContent only and has its three sections;
//   - every hub.* key the renderer names exists in pl and en;
//   - the hubWidth / hubBriefHintSeen prefs are clamped.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('src/renderer/index.html');
const CSS = read('src/renderer/hub.css');
const PANEL = read('src/renderer/modules/hubpanel.js');
const ICON = read('src/renderer/modules/hubicon.js');
const I18N = read('src/renderer/i18n.js');
const EN_AT = I18N.indexOf('\n  en: {');

test("the '!' chip sits in the palette bar with a hidden badge", () => {
  const chip = HTML.slice(HTML.indexOf('id="hub-open"'), HTML.indexOf('</button>', HTML.indexOf('id="hub-open"')));
  assert.ok(chip.includes('palette-chip'), 'same chip class as its neighbours');
  assert.ok(/class="hub-chip__mark"[^>]*>!<\/span>/.test(chip), "N8: a text '!' instead of the SVG face");
  assert.ok(!chip.includes('<svg'), 'the SVG face is gone');
  assert.ok(/id="hub-count"[^>]*hidden/.test(chip), 'the badge starts hidden (count 0)');
  assert.ok(HTML.indexOf('id="hub-open"') < HTML.indexOf('id="mission-open"'), 'next to the Mission Control chip');
  assert.ok(HTML.includes('href="hub.css"'));
});

test("N8: one '!' chip - no old attention inbox leftovers", () => {
  const files = [
    'src/renderer/index.html',
    'src/preload.js',
    'src/main.js',
    'src/renderer/i18n.js',
    'src/renderer/styles.css',
    'src/renderer/modules/terminal.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    for (const gone of ['inbox-open', 'inbox-count', 'inbox-chip', 'inboxList', "'inbox:list'", 'mountInboxChip', "'inbox.chip"]) {
      assert.ok(!src.includes(gone), `${rel} still names ${gone}`);
    }
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/inbox.js')), 'src/inbox.js deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/renderer/modules/inbox.js')), 'renderer inbox.js deleted');
  // The chip keeps its badge pulse and shortcut.
  assert.ok(ICON.includes('hub-count') || HTML.includes('id="hub-count"'));
  assert.ok(/Ctrl\+Shift\+H/.test(HTML));
});

test('N8: run items open the run summary through the validated inbox:run handler', () => {
  assert.ok(PANEL.includes("import { openRunSummary } from './godmodesummary.js'"));
  assert.ok(/openRunSummary: \(arg\) => runSummary\(arg\)/.test(PANEL));
  const preload = read('src/preload.js');
  assert.ok(preload.includes("ipcRenderer.invoke('inbox:run', { machine, id })"), 'machine + id only');
  assert.ok(read('src/renderer/modules/godmodesummary.js').includes("call('inboxRun', machine, id)"));
});

test('the brief left Mission Control', () => {
  assert.ok(!HTML.includes('id="mission-brief"'));
  assert.ok(!HTML.includes('mission-brief-open'));
  assert.ok(!read('src/renderer/modules/missionpanel.js').includes('missionbriefview'));
  assert.ok(PANEL.includes("import { showBrief } from './missionbriefview.js'"), 'mounted in the drawer instead');
});

test('hub.css uses theme tokens only', () => {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(noComments), 'no hex colours');
  assert.ok(!/\brgba?\(/.test(noComments), 'no rgb() colours');
  assert.ok(!/\bwhite\b/.test(noComments), 'no hard-coded white');
  assert.ok(noComments.includes('var(--accent, var(--neon-cyan))'), 'the face uses the theme accent');
  assert.ok(noComments.includes('backdrop-filter'), 'acrylic on glass themes');
});

test('the drawer renders with textContent only and has three sections', () => {
  for (const src of [PANEL, ICON, read('src/renderer/modules/hubstate.js')]) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src), 'no HTML injection');
  }
  for (const key of ['hub.sec.needs', 'hub.sec.briefs', 'hub.sec.recent']) assert.ok(PANEL.includes(`'${key}'`), key);
  assert.ok(PANEL.includes("el('details', 'hub-sec hub-sec--recent')"), 'Recent is a <details>, collapsed by default');
  assert.ok(!/recent\.open\s*=\s*true/.test(PANEL));
});

test('primary actions are a fixed whitelist matching main', () => {
  const { ACTIONS } = require('../src/hub.js');
  const body = PANEL.slice(PANEL.indexOf('const ACTIONS = {'), PANEL.indexOf('};', PANEL.indexOf('const ACTIONS = {')));
  const names = [...body.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(ACTIONS.has(name), `${name} is whitelisted in src/hub.js`);
});

test('every hub.* key is defined in pl and en', () => {
  const used = new Set();
  for (const src of [PANEL, ICON, read('src/hubcollect.js'), read('src/hubpeers.js'), read('src/renderer/modules/hubtoast.js')]) {
    for (const m of src.matchAll(/'(hub\.[a-zA-Z.]+[a-zA-Z])'/g)) used.add(m[1]);
  }
  for (const m of HTML.matchAll(/data-i18n[a-z-]*="(hub\.[^"]+)"/g)) used.add(m[1]);
  for (const action of require('../src/hub.js').ACTIONS) used.add(`hub.action.${action}`);
  assert.ok(used.size > 20);
  for (const key of used) {
    assert.ok(I18N.slice(0, EN_AT).includes(`'${key}':`), `pl ${key}`);
    assert.ok(I18N.slice(EN_AT).includes(`'${key}':`), `en ${key}`);
  }
});

test('hub prefs are clamped', () => {
  const { cleanHubWidth } = require('../src/uiprefs.js');
  assert.equal(cleanHubWidth(500), 500);
  for (const bad of [undefined, null, '500', 12, 5000, 420.5, NaN]) assert.equal(cleanHubWidth(bad), 420);
});
