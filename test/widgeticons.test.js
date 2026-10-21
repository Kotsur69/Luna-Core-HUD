// ============================================================================
// LunaCore - collapsed-rail widget icon tests (modules/widgeticons.js)
// ----------------------------------------------------------------------------
// The rail draws one icon per widget id. A widget registered without an entry
// here falls back to the default diamond, which is safe but quietly brings
// back the "three identical buttons" problem the icons exist to fix. So this
// scans the source the same way test/libraries.test.js scans libicons.js: every
// defineWidget() with a non-empty titleKey (i.e. one that can appear on a rail)
// must have a drawing.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'src/renderer/modules');

/** Icon keys, read off the source - two-space-indented `name: [` lines. */
function iconKeys() {
  const src = fs.readFileSync(path.join(MODULES, 'widgeticons.js'), 'utf8');
  return new Set([...src.matchAll(/^ {2}([a-z][a-z0-9-]*): \[/gm)].map((m) => m[1]));
}

/** Widget ids registered with a non-empty titleKey, across every module. */
function titledWidgetIds() {
  const ids = [];
  const shape = /defineWidget\(\{\s*id:\s*'([^']+)',\s*(?:\/\/[^\n]*\n\s*)*titleKey:\s*'([^']*)'/g;
  for (const file of fs.readdirSync(MODULES)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(MODULES, file), 'utf8');
    for (const m of src.matchAll(shape)) {
      if (m[2]) ids.push(m[1]);
    }
  }
  return ids;
}

test('widgeticons.js defines a default icon', () => {
  const keys = iconKeys();
  assert.ok(keys.size > 1, 'found no icons in widgeticons.js - did the shape drift?');
  assert.ok(keys.has('default'), 'widgeticons.js must define a `default` icon to fall back to');
});

test('every titled widget has a rail icon', () => {
  const keys = iconKeys();
  const ids = titledWidgetIds();
  assert.ok(ids.length >= 20, `found only ${ids.length} titled widgets - did the defineWidget shape drift?`);
  for (const id of ids) assert.ok(keys.has(id), `widget "${id}" has no icon in widgeticons.js`);
});

test('the widgets the rail is known to show are all covered', () => {
  const keys = iconKeys();
  const expected = [
    'usage', 'telemetry', 'profile', 'project', 'context', 'git', 'todo', 'mcp', 'skills',
    'skilltracker', 'prompts', 'cheatsheets', 'clipboard', 'scratchpad', 'activefiles',
    'sessiontimeline', 'diagnostics', 'devices', 'ports', 'media', 'appearance', 'actions',
    'calendar', 'mailcleanup', 'missionnews', 'missiontelemetry',
  ];
  for (const id of expected) assert.ok(keys.has(id), `missing icon for "${id}"`);
});

test('the module is DOM-free at load and exports the builder', () => {
  const mod = require('../src/renderer/modules/widgeticons.js');
  assert.equal(typeof mod.widgetIconSvg, 'function');
  assert.ok(Array.isArray(mod.WIDGET_ICONS.default));
});

test('libicons and widgeticons share one drawing helper, no innerHTML', () => {
  const lib = require('../src/renderer/modules/libicons.js');
  assert.equal(typeof lib.drawIcon, 'function');
  const src = fs.readFileSync(path.join(MODULES, 'widgeticons.js'), 'utf8');
  assert.match(src, /import \{ drawIcon \} from '\.\/libicons\.js'/);
  assert.doesNotMatch(src, /\.innerHTML\s*=/);
});
