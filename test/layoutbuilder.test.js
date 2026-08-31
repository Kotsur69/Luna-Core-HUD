// Layout builder tests (v0.10 phase 4.2). Pure transforms, no DOM.
//
// The rules these defend, in the order they can bite:
//
//   * an id the user cannot predict is an id they cannot find later, so slugging
//     transliterates where it can and refuses where it cannot;
//   * renaming must not re-slug, because layoutSizes / widgetSlots /
//     railedRegions are all keyed by layout id and would be orphaned;
//   * a duplicate must not share arrays with its original;
//   * every function returns a NEW map, since the caller hands the result to
//     setUiPrefs and a mutated live object would disagree with what was written.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugify,
  uniqueLayoutId,
  specFromLive,
  saveCustomLayout,
  renameCustomLayout,
  duplicateCustomLayout,
  deleteCustomLayout,
  MAX_LABEL_LEN,
} = require('../src/renderer/modules/layoutbuilder.js');

/** The active layout as normalizeLayout() hands it over. */
function activeLayout(over = {}) {
  return {
    id: 'classic',
    columns: '260px 1fr 280px',
    rows: '1fr',
    areas: ['left main right'],
    chrome: { brand: 'left', status: 'left' },
    ...over,
  };
}

const LIVE_SLOTS = { left: ['appearance'], main: ['terminal'], right: ['ports'] };

// ---- slugify ----------------------------------------------------------------

test('slugify makes an id out of a plain name', () => {
  assert.equal(slugify('My Setup'), 'my-setup');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
});

test('slugify transliterates all nine Polish special letters', () => {
  // Eight of them decompose under NFKD. U+0142 does not, and without its own
  // replacement it falls through to the dash rule - "uklad" comes out as
  // "uk-ad", which is the kind of id nobody can find again.
  assert.equal(slugify('Mój Układ Główny'), 'moj-uklad-glowny');
  assert.equal(slugify('Żółw Ćma Ąę Śnieg Źle'), 'zolw-cma-ae-snieg-zle');
  assert.equal(slugify('ŁÓDŹ'), 'lodz');
});

test('slugify returns empty when nothing usable survives', () => {
  // The caller must ask again rather than invent a name of its own.
  for (const junk of ['!!! ???', '   ', '', null, undefined, 42, {}]) {
    assert.equal(slugify(junk), '');
  }
});

test('slugify never ends on a dash, even when the cap cuts mid-word', () => {
  const out = slugify(`${'a'.repeat(47)} tail`);
  assert.equal(out.length <= 48, true);
  assert.equal(out.endsWith('-'), false);
});

// ---- uniqueLayoutId ---------------------------------------------------------

test('uniqueLayoutId leaves a free id alone', () => {
  assert.equal(uniqueLayoutId('my-setup', ['classic']), 'my-setup');
});

test('uniqueLayoutId walks past everything taken', () => {
  // `taken` includes SHIPPED ids: typing "Classic" must not silently replace the
  // shipped preset, which loadLayouts would let it do (the user's source wins).
  assert.equal(uniqueLayoutId('classic', ['classic']), 'classic-2');
  assert.equal(uniqueLayoutId('classic', ['classic', 'classic-2', 'classic-3']), 'classic-4');
});

test('uniqueLayoutId refuses an empty base', () => {
  assert.equal(uniqueLayoutId('', ['classic']), '');
});

// ---- specFromLive -----------------------------------------------------------

test('specFromLive records the live columns over the preset ones', () => {
  const spec = specFromLive({
    layout: activeLayout(),
    columns: '300px 1fr 240px',
    slots: LIVE_SLOTS,
    label: 'My Setup',
  });
  assert.equal(spec.grid.columns, '300px 1fr 240px');
  assert.deepEqual(spec.grid.areas, ['left main right']);
  assert.equal(spec.grid.rows, '1fr');
});

test('specFromLive falls back to the preset widths when nothing was dragged', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  assert.equal(spec.grid.columns, '260px 1fr 280px');
});

test('specFromLive trims the label and refuses an empty one', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: ' Mine ' });
  assert.equal(spec.label, 'Mine');
  for (const label of ['', '   ', null, undefined, 42]) {
    assert.equal(specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label }), null);
  }
});

test('specFromLive caps the label at what uiprefs will keep', () => {
  const spec = specFromLive({
    layout: activeLayout(),
    slots: LIVE_SLOTS,
    label: 'n'.repeat(MAX_LABEL_LEN + 20),
  });
  assert.equal(spec.label.length, MAX_LABEL_LEN);
});

test('specFromLive drops empty regions rather than storing []', () => {
  const spec = specFromLive({
    layout: activeLayout(),
    slots: { left: ['appearance'], main: ['terminal'], right: [] },
    label: 'Mine',
  });
  assert.deepEqual(Object.keys(spec.slots), ['left', 'main']);
});

test('specFromLive copies the slot arrays instead of aliasing them', () => {
  const live = { left: ['appearance'], main: ['terminal'] };
  const spec = specFromLive({ layout: activeLayout(), slots: live, label: 'Mine' });
  live.left.push('ports');
  assert.deepEqual(spec.slots.left, ['appearance']);
});

test('specFromLive carries chrome over', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  assert.deepEqual(spec.chrome, { brand: 'left', status: 'left' });
});

test('specFromLive omits chrome when the layout has none', () => {
  const spec = specFromLive({
    layout: activeLayout({ chrome: undefined }),
    slots: LIVE_SLOTS,
    label: 'Mine',
  });
  assert.equal(spec.chrome, undefined);
});

test('specFromLive refuses inputs that cannot make a layout', () => {
  assert.equal(specFromLive(), null);
  assert.equal(specFromLive({ layout: null, slots: LIVE_SLOTS, label: 'Mine' }), null);
  assert.equal(
    specFromLive({ layout: activeLayout({ areas: [] }), slots: LIVE_SLOTS, label: 'x' }),
    null
  );
  assert.equal(specFromLive({ layout: activeLayout(), slots: {}, label: 'Mine' }), null);
  assert.equal(specFromLive({ layout: activeLayout(), slots: null, label: 'Mine' }), null);
});

// ---- saveCustomLayout -------------------------------------------------------

test('saveCustomLayout files the spec under its slug', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'My Setup' });
  const out = saveCustomLayout({}, spec, ['classic']);
  assert.equal(out.id, 'my-setup');
  assert.equal(out.map['my-setup'].label, 'My Setup');
});

test('saveCustomLayout does not mutate the map it was given', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const before = {};
  saveCustomLayout(before, spec, []);
  assert.deepEqual(before, {});
});

test('saveCustomLayout refuses a spec whose label cannot be slugged', () => {
  assert.equal(saveCustomLayout({}, { label: '!!!' }, []), null);
  assert.equal(saveCustomLayout({}, null, []), null);
});

// ---- renameCustomLayout -----------------------------------------------------

test('renameCustomLayout changes the label and keeps the id', () => {
  // The id is what layoutSizes, widgetSlots and railedRegions are keyed by;
  // re-slugging here would orphan all three and the layout would snap back to
  // its authored widths for no reason the user can see.
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const { map } = saveCustomLayout({}, spec, []);
  const next = renameCustomLayout(map, 'mine', 'Something Else');
  assert.deepEqual(Object.keys(next), ['mine']);
  assert.equal(next.mine.label, 'Something Else');
  assert.deepEqual(next.mine.grid, map.mine.grid);
});

test('renameCustomLayout refuses an unknown id or an empty name', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const { map } = saveCustomLayout({}, spec, []);
  assert.equal(renameCustomLayout(map, 'nope', 'X'), null);
  assert.equal(renameCustomLayout(map, 'mine', '   '), null);
});

// ---- duplicateCustomLayout --------------------------------------------------

test('duplicateCustomLayout copies under a new id', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const { map } = saveCustomLayout({}, spec, []);
  const out = duplicateCustomLayout(map, 'mine', 'Mine', ['mine']);
  assert.equal(out.id, 'mine-2');
  assert.deepEqual(out.map['mine-2'].slots, map.mine.slots);
});

test('duplicateCustomLayout deep-copies areas and slots', () => {
  // A shallow copy would leave the duplicate sharing arrays with its original,
  // so editing one would silently edit both.
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const { map } = saveCustomLayout({}, spec, []);
  const out = duplicateCustomLayout(map, 'mine', 'Copy', ['mine']);
  assert.notEqual(out.map[out.id].grid.areas, map.mine.grid.areas);
  assert.notEqual(out.map[out.id].slots.left, map.mine.slots.left);
  assert.deepEqual(out.map[out.id].grid.areas, map.mine.grid.areas);
});

test('duplicateCustomLayout refuses an unknown id', () => {
  assert.equal(duplicateCustomLayout({}, 'nope', 'X', []), null);
});

// ---- deleteCustomLayout -----------------------------------------------------

test('deleteCustomLayout removes one entry and leaves the rest', () => {
  const spec = specFromLive({ layout: activeLayout(), slots: LIVE_SLOTS, label: 'Mine' });
  const a = saveCustomLayout({}, spec, []);
  const b = saveCustomLayout(a.map, { ...spec, label: 'Other' }, [a.id]);
  const next = deleteCustomLayout(b.map, 'mine');
  assert.deepEqual(Object.keys(next), ['other']);
  // The map handed in is untouched.
  assert.deepEqual(Object.keys(b.map).sort(), ['mine', 'other']);
});

test('deleteCustomLayout returns null when there was nothing to remove', () => {
  // So a caller never persists a write that changes nothing.
  assert.equal(deleteCustomLayout({}, 'mine'), null);
  assert.equal(deleteCustomLayout(null, 'mine'), null);
});
