// Layout preset tests (C1). Pure loader + validation, no DOM.
//
// The two validation rules worth having tests for are the ones that protect the
// user from a config they cannot recover from by hand:
//
//   * a layout that never places `terminal` is a HUD with no terminal;
//   * a layout that never places `appearance` hides the layout <select>, i.e.
//     it locks you into itself with no way back short of editing JSON.
//
// Both are rejected at the boundary so the FALLBACK takes over, exactly like a
// malformed profile or project entry.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadLayouts, getLayout, normalizeLayout, gridAreas, REQUIRED_WIDGETS } = require('../src/layouts.js');

/** A minimal valid layout; individual tests override one field at a time. */
function base(over = {}) {
  return {
    id: 'classic',
    label: 'Classic',
    grid: { columns: '260px 1fr 280px', rows: '1fr', areas: ['left main right'] },
    slots: {
      left: ['appearance'],
      main: ['terminal'],
      right: ['context'],
    },
    ...over,
  };
}

// ---- normalizeLayout: happy path -------------------------------------------

test('normalizeLayout passes a valid layout through', () => {
  const l = normalizeLayout(base());
  assert.equal(l.id, 'classic');
  assert.equal(l.label, 'Classic');
  assert.equal(l.columns, '260px 1fr 280px');
  assert.equal(l.rows, '1fr');
  assert.deepEqual(l.areas, ['left main right']);
  assert.equal(l.gridTemplateAreas, '"left main right"');
  assert.deepEqual(l.slots.main, ['terminal']);
});

test('normalizeLayout accepts a localized {pl,en} label', () => {
  const l = normalizeLayout(base({ label: { pl: 'Klasyczny', en: 'Classic' } }));
  // normalizeText keeps the object so the renderer can pick a language later.
  assert.equal(typeof l.label, 'object');
  assert.equal(l.label.pl, 'Klasyczny');
  assert.equal(l.label.en, 'Classic');
});

test('normalizeLayout fills in a missing label with the id', () => {
  const raw = base();
  delete raw.label;
  assert.equal(normalizeLayout(raw).label, 'classic');
});

// ---- normalizeLayout: the two lock-out rules -------------------------------

test('normalizeLayout rejects a layout without a terminal', () => {
  const l = base({ slots: { left: ['appearance'], main: ['context'], right: [] } });
  assert.equal(normalizeLayout(l), null);
});

test('normalizeLayout rejects a layout without appearance (would close the way back)', () => {
  const l = base({ slots: { left: ['profile'], main: ['terminal'], right: [] } });
  assert.equal(normalizeLayout(l), null);
});

test('REQUIRED_WIDGETS lists exactly these two', () => {
  assert.deepEqual([...REQUIRED_WIDGETS].sort(), ['appearance', 'terminal']);
});

// ---- normalizeLayout: grid shape -------------------------------------------

test('normalizeLayout rejects ragged grid-template-areas rows', () => {
  // Rows of different token counts are invalid CSS - the whole grid would be
  // dropped by the engine and the HUD would collapse into one column.
  const l = base({
    grid: { columns: '1fr 1fr', rows: '1fr 1fr', areas: ['left main', 'right'] },
  });
  assert.equal(normalizeLayout(l), null);
});

test('normalizeLayout rejects a layout with no areas', () => {
  assert.equal(normalizeLayout(base({ grid: { columns: '1fr', rows: '1fr', areas: [] } })), null);
});

test('normalizeLayout accepts a dot as an empty cell', () => {
  const l = normalizeLayout(
    base({
      grid: { columns: '1fr 1fr', rows: '1fr 1fr', areas: ['main main', 'left .'] },
      slots: { left: ['appearance'], main: ['terminal'] },
    })
  );
  assert.notEqual(l, null);
  assert.deepEqual(l.areas, ['main main', 'left .']);
});

// ---- normalizeLayout: slots ------------------------------------------------

test('normalizeLayout drops slots outside the areas', () => {
  const l = normalizeLayout(
    base({ slots: { left: ['appearance'], main: ['terminal'], nope: ['ports'] } })
  );
  assert.equal(l.slots.nope, undefined);
  assert.deepEqual(Object.keys(l.slots).sort(), ['left', 'main']);
});

test('normalizeLayout rejects the same widget in two slots', () => {
  // One widget has one root element; two slots would fight over it.
  const l = base({
    slots: { left: ['appearance', 'ports'], main: ['terminal'], right: ['ports'] },
  });
  assert.equal(normalizeLayout(l), null);
});

test('normalizeLayout rejects a repeat within one slot', () => {
  const l = base({ slots: { left: ['appearance', 'appearance'], main: ['terminal'] } });
  assert.equal(normalizeLayout(l), null);
});

test('normalizeLayout preserves widget order within a slot', () => {
  const l = normalizeLayout(
    base({ slots: { left: ['appearance', 'profile', 'project'], main: ['terminal'] } })
  );
  assert.deepEqual(l.slots.left, ['appearance', 'profile', 'project']);
});

// ---- normalizeLayout: region order + chrome --------------------------------

test('normalizeLayout returns regions in first-appearance order', () => {
  const l = normalizeLayout(
    base({
      grid: { columns: '1fr 1fr', rows: '1fr 1fr', areas: ['main main', 'left right'] },
      slots: { left: ['appearance'], main: ['terminal'], right: ['ports'] },
    })
  );
  assert.deepEqual(l.regionOrder, ['main', 'left', 'right']);
});

test('chrome defaults to the first region without a terminal', () => {
  // areas start with `main`, but `main` holds the terminal - chrome would be
  // dropped there, so it falls to `left`.
  const l = normalizeLayout(
    base({
      grid: { columns: '1fr 1fr', rows: '1fr 1fr', areas: ['main main', 'left right'] },
      slots: { left: ['appearance'], main: ['terminal'], right: ['ports'] },
    })
  );
  assert.deepEqual(l.chrome, { brand: 'left', status: 'left' });
});

test('chrome respects an explicit region choice', () => {
  const l = normalizeLayout(base({ chrome: { brand: 'right', status: 'left' } }));
  assert.deepEqual(l.chrome, { brand: 'right', status: 'left' });
});

test('chrome pointing at the terminal region is corrected, not lost', () => {
  const l = normalizeLayout(base({ chrome: { brand: 'main', status: 'main' } }));
  assert.deepEqual(l.chrome, { brand: 'left', status: 'left' });
});

test('chrome pointing at a nonexistent region falls back to the default', () => {
  const l = normalizeLayout(base({ chrome: { brand: 'nope', status: 42 } }));
  assert.deepEqual(l.chrome, { brand: 'left', status: 'left' });
});

// ---- normalizeLayout: junk --------------------------------------------------

test('normalizeLayout rejects anything that is not an object', () => {
  for (const junk of [null, undefined, 'classic', 42, []]) {
    assert.equal(normalizeLayout(junk), null);
  }
});

test('normalizeLayout rejects a layout without id', () => {
  const raw = base();
  delete raw.id;
  assert.equal(normalizeLayout(raw), null);
});

// ---- the shipped config -----------------------------------------------------
//
// A preset that fails validation disappears silently, so the HUD would just come
// up on a different layout than the one config/layouts.json names. Pin it.

test('config/layouts.json - every preset passes validation', () => {
  const { layouts, activeLayout } = loadLayouts();
  const ids = layouts.map((l) => l.id);
  assert.deepEqual(ids, [
    'classic',
    'focus',
    'monitor-heavy',
    'bottom-dock',
    // v0.10 phase 4.1. Order here is the order they appear in the picker.
    'left-only',
    'cockpit',
    'ultrawide',
    'stacked',
    'zen',
  ]);
  assert.equal(activeLayout, 'classic');
  assert.notEqual(getLayout(layouts, 'classic'), null);
});

test('config/layouts.json - no preset places autocompact', () => {
  // autocompact mounts into a slot nested INSIDE the actions template, so it is
  // not independently placeable - see the WIDGETS comment in renderer.js.
  for (const l of loadLayouts().layouts) {
    for (const ids of Object.values(l.slots)) {
      assert.equal(ids.includes('autocompact'), false, `${l.id} places autocompact`);
    }
  }
});

test('config/layouts.json - classic reproduces today\'s layout', () => {
  const l = getLayout(loadLayouts().layouts, 'classic');
  assert.equal(l.columns, '260px 1fr 280px');
  assert.deepEqual(l.slots.main, ['terminal']);
  // E1 inserted `telemetry` between usage and skilltracker in ALL presets;
  // the Active-Files Heatmap added `activefiles` right after skilltracker (plan §8);
  // §6.1 added `sessiontimeline` right after that; Media Deck added `media`
  // right after `telemetry` (app-scoped like usage/telemetry, not per-session);
  // the widget plan then added `devices` next to `media` (both app-scoped OS
  // controls) and `todo`/`clipboard` after `scratchpad` (all three are the
  // "things I keep on the side" group); `git`/`mcp` then went next to `ports`,
  // because all three answer "what is the state of my machine right now" from a
  // passive scan rather than from anything the session did. The diagnostics
  // tile then went right after `mcp`, for the same reason - it consolidates the
  // machine's own degraded-state self-checks (mpv, claude on PATH, MCP usage).
  // This assertion exists so that a change like that doesn't slip by unnoticed.
  assert.deepEqual(l.slots.right, [
    'context',
    'usage',
    'telemetry',
    'media',
    'devices',
    'skilltracker',
    'activefiles',
    'sessiontimeline',
    'ports',
    'git',
    'mcp',
    'diagnostics',
    'scratchpad',
    'todo',
    'clipboard',
  ]);
  assert.deepEqual(l.chrome, { brand: 'left', status: 'left' });
});

// ---- gridAreas --------------------------------------------------------------

test('gridAreas quotes every row for CSS', () => {
  assert.equal(gridAreas(['left main right']), '"left main right"');
  assert.equal(gridAreas(['main main', 'left right']), '"main main" "left right"');
});

// ---- customLayouts merge (v0.10 4.2) ----------------------------------------
//
// The user's saved layouts are merged HERE rather than in the renderer, so they
// are validated by the same normalizeLayout() as a shipped preset instead of by
// a second copy of those rules that would have to be kept in step with it.

/** A saved layout as uiprefs stores it - keyed by id, id not repeated inside. */
function stored(over = {}) {
  return {
    label: { pl: 'Moj uklad', en: 'My setup' },
    grid: { columns: '300px 1fr', rows: '1fr', areas: ['side main'] },
    slots: { side: ['appearance'], main: ['terminal'] },
    ...over,
  };
}

test('loadLayouts with no argument is exactly the shipped list', () => {
  // Every existing caller passes nothing; the builder must not change them.
  assert.deepEqual(
    loadLayouts().layouts.map((l) => l.id),
    loadLayouts(undefined).layouts.map((l) => l.id)
  );
});

test('loadLayouts appends a saved layout after the shipped presets', () => {
  const { layouts } = loadLayouts({ 'my-setup': stored() });
  const ids = layouts.map((l) => l.id);
  assert.equal(ids.at(-1), 'my-setup');
  assert.equal(ids.includes('classic'), true);
});

test('loadLayouts normalizes a saved layout like any other', () => {
  const l = getLayout(loadLayouts({ mine: stored() }).layouts, 'mine');
  assert.equal(l.gridTemplateAreas, '"side main"');
  assert.deepEqual(l.regionOrder, ['side', 'main']);
  // chrome defaults to the first region that does not hold the terminal.
  assert.equal(l.chrome.brand, 'side');
});

test('a saved layout overrides a shipped preset with the same id', () => {
  // Last source wins, and the user's own is last: a layout they built and named
  // must not be silently replaced by a preset that later ships under that id.
  const { layouts } = loadLayouts({ classic: stored({ label: 'Mine now' }) });
  const classic = getLayout(layouts, 'classic');
  assert.equal(classic.label, 'Mine now');
  assert.equal(classic.columns, '300px 1fr');
  assert.equal(layouts.filter((l) => l.id === 'classic').length, 1);
});

test('the map key wins over a stale id inside the entry', () => {
  // Otherwise the map holds two names for one layout and which one wins depends
  // on iteration order.
  const { layouts } = loadLayouts({ mine: stored({ id: 'something-else' }) });
  assert.notEqual(getLayout(layouts, 'mine'), null);
  assert.equal(getLayout(layouts, 'something-else'), null);
});

test('an unloadable saved layout is dropped, the shipped presets survive', () => {
  // Ragged areas pass the uiprefs write gate on purpose and die here instead,
  // which is what lets the rules tighten without stranding a saved file.
  const ragged = stored({ grid: { columns: '1fr 1fr', rows: '1fr 1fr', areas: ['a b', 'c'] } });
  const { layouts } = loadLayouts({ mine: ragged });
  assert.equal(getLayout(layouts, 'mine'), null);
  assert.notEqual(getLayout(layouts, 'classic'), null);
});

test('a saved layout that places no terminal is dropped', () => {
  const noTerm = stored({ slots: { side: ['appearance'], main: ['context'] } });
  assert.equal(getLayout(loadLayouts({ mine: noTerm }).layouts, 'mine'), null);
});

test('loadLayouts ignores a customLayouts value that is not a map', () => {
  for (const bad of [null, 42, 'x', [], true]) {
    assert.equal(loadLayouts(bad).layouts.length, loadLayouts().layouts.length);
  }
});
