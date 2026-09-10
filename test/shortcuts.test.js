// ============================================================================
// LunaCore - keyboard-shortcut reference tests
// ----------------------------------------------------------------------------
// modules/shortcuts.js only DESCRIBES chords that live in other files. The
// point of this file, like test/modifiers.test.js, is the drift guards:
//
//   1. every row's `source.marker` still appears in the file that implements
//      the chord - so renaming or deleting a binding fails here until the
//      reference list is updated;
//   2. every i18n key the table names is defined in BOTH languages in
//      src/renderer/i18n.js - so a row can never render as a raw key.
//
// Plus the cheap structural checks that keep the data shape honest.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SHORTCUT_GROUPS,
  flattenShortcuts,
} = require('../src/renderer/modules/shortcuts.js');

const ROOT = path.join(__dirname, '..');
const readRepoFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- i18n dictionary, split into its two language halves --------------------
const I18N_SRC = readRepoFile('src/renderer/i18n.js');
const EN_AT = I18N_SRC.indexOf('\n  en: {');
assert.ok(EN_AT > 0, 'i18n.js should have a `pl` block followed by an `en` block');
const I18N_PL = I18N_SRC.slice(0, EN_AT);
const I18N_EN = I18N_SRC.slice(EN_AT);

/** Every i18n key the table references (group titles, row descriptions, and
 *  any localized `{ t }` token), plus the section's own static keys. */
function referencedI18nKeys() {
  const keys = new Set(['shortcuts.title', 'shortcuts.macNote']);
  for (const group of SHORTCUT_GROUPS) {
    keys.add(group.titleKey);
    for (const row of group.rows) {
      keys.add(row.descKey);
      for (const alt of row.chords) {
        for (const token of alt) {
          if (token && typeof token === 'object') keys.add(token.t);
        }
      }
    }
  }
  return [...keys];
}

test('every group is well formed', () => {
  assert.ok(SHORTCUT_GROUPS.length > 0);
  const ids = new Set();
  for (const group of SHORTCUT_GROUPS) {
    assert.equal(typeof group.id, 'string');
    assert.ok(group.id.length > 0);
    assert.ok(!ids.has(group.id), `duplicate group id: ${group.id}`);
    ids.add(group.id);
    assert.match(group.titleKey, /^shortcuts\./);
    assert.ok(Array.isArray(group.rows) && group.rows.length > 0);
  }
});

test('every row is well formed', () => {
  for (const row of flattenShortcuts()) {
    assert.match(row.descKey, /^shortcuts\./);
    assert.ok(Array.isArray(row.chords) && row.chords.length > 0, row.descKey);
    for (const alt of row.chords) {
      assert.ok(Array.isArray(alt) && alt.length > 0, `empty alternative in ${row.descKey}`);
      for (const token of alt) {
        const ok =
          (typeof token === 'string' && token.length > 0) ||
          (token && typeof token === 'object' && typeof token.t === 'string');
        assert.ok(ok, `bad token in ${row.descKey}: ${JSON.stringify(token)}`);
      }
    }
    assert.equal(typeof row.source.file, 'string');
    assert.ok(row.source.marker.length > 0);
  }
});

test('row descriptions are unique', () => {
  const seen = new Set();
  for (const row of flattenShortcuts()) {
    assert.ok(!seen.has(row.descKey), `duplicate descKey: ${row.descKey}`);
    seen.add(row.descKey);
  }
});

test('every referenced i18n key is defined in both pl and en', () => {
  for (const key of referencedI18nKeys()) {
    const needle = `'${key}':`;
    assert.ok(I18N_PL.includes(needle), `missing pl translation: ${key}`);
    assert.ok(I18N_EN.includes(needle), `missing en translation: ${key}`);
  }
});

test('drift guard: each source marker still exists in its file', () => {
  const cache = new Map();
  for (const row of flattenShortcuts()) {
    const { file, marker } = row.source;
    if (!cache.has(file)) cache.set(file, readRepoFile(file));
    assert.ok(
      cache.get(file).includes(marker),
      `${row.descKey}: "${marker}" no longer found in ${file} - update modules/shortcuts.js`
    );
  }
});
