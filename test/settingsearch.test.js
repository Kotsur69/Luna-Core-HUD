// Tests for the pure search/navigation logic behind the Ctrl+L Settings
// overlay (settingsearch.js). Zero DOM - settingsnav.js, which applies the
// result to the overlay, queries the document and is left to the manual
// checklist, same as gitquick.js/termcustom.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeSearchText,
  tokenizeQuery,
  matchesQuery,
  findMatchRanges,
  filterSettings,
  moveNavIndex,
} = require('../src/renderer/modules/settingsearch.js');

// ---- normalizeSearchText / tokenizeQuery -----------------------------------

test('normalizeSearchText lowercases, strips Polish diacritics and collapses whitespace', () => {
  assert.equal(normalizeSearchText('  Głośność   Dźwięku '), 'glosnosc dzwieku');
  assert.equal(normalizeSearchText('ŁÓDŹ'), 'lodz');
  assert.equal(normalizeSearchText(null), '');
});

test('tokenizeQuery splits on whitespace and drops duplicates', () => {
  assert.deepEqual(tokenizeQuery('Font  font size'), ['font', 'size']);
  assert.deepEqual(tokenizeQuery('   '), []);
});

// ---- matchesQuery ------------------------------------------------------------

test('matchesQuery requires every token, in any order', () => {
  assert.equal(matchesQuery('Rozmiar czcionki', 'czcionki rozmiar'), true);
  assert.equal(matchesQuery('Rozmiar czcionki', 'rozmiar kursora'), false);
});

test('matchesQuery is accent-insensitive in both directions', () => {
  assert.equal(matchesQuery('Głośność', 'glosnosc'), true);
  assert.equal(matchesQuery('Glosnosc', 'głośność'), true);
});

test('matchesQuery searches across every language text of an item', () => {
  const item = ['Rozmiar czcionki', 'Font size'];
  assert.equal(matchesQuery(item, 'font size'), true);
  assert.equal(matchesQuery(item, 'czcionki'), true);
});

test('matchesQuery treats an empty query as a match', () => {
  assert.equal(matchesQuery('anything', '  '), true);
});

// ---- findMatchRanges -----------------------------------------------------------

test('findMatchRanges returns source indices, even across diacritics', () => {
  const text = 'Głośność';
  const ranges = findMatchRanges(text, 'osno');
  assert.deepEqual(ranges, [[2, 6]]);
  assert.equal(text.slice(2, 6), 'ośno');
});

test('findMatchRanges finds every occurrence and merges overlaps', () => {
  assert.deepEqual(findMatchRanges('abcabc', 'bc'), [[1, 3], [4, 6]]);
  assert.deepEqual(findMatchRanges('Font size', 'font ont'), [[0, 4]]);
});

test('findMatchRanges returns [] for an empty query or text', () => {
  assert.deepEqual(findMatchRanges('Font', ''), []);
  assert.deepEqual(findMatchRanges('', 'font'), []);
});

// ---- filterSettings --------------------------------------------------------------

const GROUPS = [
  { title: ['Wyglad terminala', 'Terminal appearance'], items: [['Czcionka', 'Font family'], ['Styl kursora', 'Cursor style']] },
  { title: ['Dzwiek i start', 'Sound & startup'], items: [['Glosnosc', 'Volume'], ['Dzwiek klawiszy', 'Keystroke sound']] },
  { title: ['LM Studio'], items: [['Odswiez liste', 'Refresh list'], []] },
];

test('filterSettings returns null for an empty query (browse mode)', () => {
  assert.equal(filterSettings(GROUPS, ''), null);
  assert.equal(filterSettings(GROUPS, '   '), null);
});

test('filterSettings keeps only matching items across groups', () => {
  const res = filterSettings(GROUPS, 'cursor');
  assert.deepEqual(res, { groups: [{ index: 0, titleMatch: false, items: [1] }], count: 1 });
});

test('filterSettings matches the other language than the one on screen', () => {
  const res = filterSettings(GROUPS, 'glosnosc');
  assert.deepEqual(res.groups.map((g) => [g.index, g.items]), [[1, [0]]]);
});

test('filterSettings shows a whole group when its title matches', () => {
  const res = filterSettings(GROUPS, 'lm studio');
  assert.deepEqual(res.groups, [{ index: 2, titleMatch: true, items: [0, 1] }]);
  assert.equal(res.count, 2);
});

test('filterSettings reports zero hits for the empty state', () => {
  assert.deepEqual(filterSettings(GROUPS, 'nothing-matches-this'), { groups: [], count: 0 });
});

test('filterSettings tolerates missing titles/items', () => {
  assert.deepEqual(filterSettings([{}, { items: ['font'] }], 'font'), {
    groups: [{ index: 1, titleMatch: false, items: [0] }],
    count: 1,
  });
});

// ---- moveNavIndex -------------------------------------------------------------------

test('moveNavIndex wraps arrows and handles Home/End', () => {
  assert.equal(moveNavIndex(0, 'ArrowDown', 3), 1);
  assert.equal(moveNavIndex(2, 'ArrowDown', 3), 0);
  assert.equal(moveNavIndex(0, 'ArrowUp', 3), 2);
  assert.equal(moveNavIndex(1, 'Home', 3), 0);
  assert.equal(moveNavIndex(1, 'End', 3), 2);
});

test('moveNavIndex ignores other keys and empty rails', () => {
  assert.equal(moveNavIndex(0, 'Enter', 3), -1);
  assert.equal(moveNavIndex(0, 'ArrowDown', 0), -1);
  assert.equal(moveNavIndex(99, 'ArrowDown', 3), 1); // out-of-range current snaps to 0
});

// ---- markup contract ------------------------------------------------------------------

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

test('every Settings rail tab has a matching pane, and every pane a tab', () => {
  const tabs = [...html.matchAll(/class="termcustom__navitem"[^>]*data-cat="([a-z]+)"/g)].map((m) => m[1]);
  const panes = [...html.matchAll(/class="termcustom__pane" data-cat="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, 'expected the category rail to be present');
  assert.deepEqual(tabs, panes);
});

test('the overlay still holds exactly one #termcustom-reset', () => {
  assert.equal(html.split('id="termcustom-reset"').length - 1, 1);
});
