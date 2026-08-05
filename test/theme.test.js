// ============================================================================
// LunaCore - testy motywow (C3)
// ----------------------------------------------------------------------------
// Dwie rzeczy do sprawdzenia: normalizeTheme()/loadThemes() jako granica (co
// przyjmuje, co odrzuca, co tylko ostrzega) oraz to, ze slownik tokenow w
// theme.js nie rozjechal sie z :root w styles.css.
//
// Ten drugi test jest powodem, dla ktorego duplikacja listy tokenow jest w ogole
// bezpieczna: KNOWN_TOKENS istnieje po to, by literowka w motywie byla widoczna,
// ale sama lista tez moze sie zestarzec. Tu sie nie zestarzeje.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadThemes, normalizeTheme, KNOWN_TOKENS } = require('../src/theme');

const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');

/** Tokeny zadeklarowane w bloku :root { ... } w styles.css. */
function rootTokens() {
  const css = fs.readFileSync(STYLES, 'utf8');
  const start = css.indexOf(':root {');
  assert.ok(start !== -1, 'styles.css musi miec blok :root');
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
}

// ---- granica: co normalizeTheme przyjmuje, a co odrzuca ---------------------

test('normalizeTheme odrzuca to, co nie jest obiektem', () => {
  for (const bad of [null, undefined, 42, 'motyw', []]) {
    assert.strictEqual(normalizeTheme(bad), null);
  }
});

test('normalizeTheme odrzuca motyw bez id', () => {
  assert.strictEqual(normalizeTheme({ vars: { '--bg': '#000' } }), null);
  assert.strictEqual(normalizeTheme({ id: '', vars: { '--bg': '#000' } }), null);
});

test('normalizeTheme odrzuca motyw bez tokenow i bez dziedziczenia', () => {
  assert.strictEqual(normalizeTheme({ id: 'pusty', vars: {} }), null);
  assert.strictEqual(normalizeTheme({ id: 'pusty' }), null);
});

test('normalizeTheme przyjmuje motyw bez tokenow, gdy dziedziczy', () => {
  const t = normalizeTheme({ id: 'wariant', extends: 'matrix' });
  assert.ok(t);
  assert.strictEqual(t.extends, 'matrix');
});

test('normalizeTheme podstawia id jako label, gdy brak label', () => {
  const t = normalizeTheme({ id: 'void', vars: { '--bg': '#000' } });
  assert.strictEqual(t.label, 'void');
});

test('normalizeTheme pomija wartosci, ktore nie sa stringami', () => {
  const t = normalizeTheme({ id: 'x', vars: { '--bg': '#000', '--radius': 10 } });
  assert.deepStrictEqual(Object.keys(t.vars), ['--bg']);
});

test('normalizeTheme ostrzega o nieznanym tokenie i go pomija', () => {
  const warns = [];
  // "--radius-small" nie istnieje - poprawna nazwa to "--radius-sm".
  const t = normalizeTheme(
    { id: 'x', vars: { '--bg': '#000', '--radius-small': '4px' } },
    (m) => warns.push(m)
  );
  assert.deepStrictEqual(Object.keys(t.vars), ['--bg']);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /--radius-small/);
});

test('literowka w tokenie nie odrzuca calego motywu', () => {
  const t = normalizeTheme({ id: 'x', vars: { '--bg': '#000', '--nie-ma': 'x' } });
  assert.ok(t, 'motyw ma przetrwac pojedyncza literowke');
  assert.strictEqual(t.vars['--bg'], '#000');
});

// ---- slownik tokenow nie moze sie rozjechac ze stylami ---------------------

test('KNOWN_TOKENS pokrywa sie z blokiem :root w styles.css', () => {
  const inCss = rootTokens();
  const missingFromCss = [...KNOWN_TOKENS].filter((t) => !inCss.has(t));
  const missingFromList = [...inCss].filter((t) => !KNOWN_TOKENS.has(t));

  assert.deepStrictEqual(
    missingFromCss,
    [],
    `theme.js zna tokeny, ktorych nie ma w :root: ${missingFromCss.join(', ')}`
  );
  assert.deepStrictEqual(
    missingFromList,
    [],
    `:root ma tokeny, ktorych motyw nie moze ustawic: ${missingFromList.join(', ')}`
  );
});

// ---- dziedziczenie ---------------------------------------------------------

test('shipowane motywy laduja sie bez ostrzezen', () => {
  const warns = [];
  const { themes } = loadThemes((m) => warns.push(m));
  assert.deepStrictEqual(warns, []);
  assert.ok(themes.length >= 9, `spodziewane >=9 motywow, jest ${themes.length}`);
});

test('kazdy shipowany motyw ma komplet tokenow po rozwiazaniu extends', () => {
  const { themes } = loadThemes(() => {});
  for (const t of themes) {
    // Kolory sa obowiazkowe - bez nich motyw nie jest motywem, tylko akcentem.
    for (const must of ['--bg', '--bg-panel', '--text', '--text-dim', '--term-bg']) {
      assert.ok(t.vars[must], `motyw "${t.id}" nie ustawia ${must}`);
    }
    assert.ok(t.terminal.background, `motyw "${t.id}" nie ustawia tla terminala`);
  }
});

test('extends dziedziczy tokeny rodzica, wlasne wygrywaja', () => {
  const { themes } = loadThemes(() => {});
  const matrix = themes.find((t) => t.id === 'matrix');
  const amber = themes.find((t) => t.id === 'amber-crt');
  assert.ok(matrix && amber);
  // Forma przychodzi od matrixa...
  assert.strictEqual(amber.vars['--radius'], matrix.vars['--radius']);
  assert.strictEqual(amber.vars['--font-ui'], matrix.vars['--font-ui']);
  // ...ale kolory sa wlasne.
  assert.notStrictEqual(amber.vars['--bg'], matrix.vars['--bg']);
  assert.strictEqual(amber.vars['--bg'], '#0d0800');
});

test('rozwiazany motyw nie niesie juz klucza extends do renderera', () => {
  const { themes } = loadThemes(() => {});
  for (const t of themes) {
    assert.ok(!('extends' in t), `motyw "${t.id}" wypuszcza extends do renderera`);
  }
});

// ---- motywy, ktore Mati moze miec zapisane w ui.local.json -----------------

test('zadne z dotychczasowych id motywow nie zniknelo', () => {
  const { themes } = loadThemes(() => {});
  const ids = new Set(themes.map((t) => t.id));
  // Usuniecie ktoregokolwiek osierociloby zapisany wybor w ui.local.json.
  for (const id of ['cyberpunk', 'synthwave', 'matrix', 'nord', 'light']) {
    assert.ok(ids.has(id), `motyw "${id}" zniknal z config/themes.json`);
  }
});

test('matrix to juz nie sam zielony filtr', () => {
  const { themes } = loadThemes(() => {});
  const matrix = themes.find((t) => t.id === 'matrix');
  // To jest cala teza C3: motyw ma zmieniac ksztalt, nie tylko barwe.
  assert.strictEqual(matrix.vars['--radius'], '0px');
  assert.match(matrix.vars['--font-ui'], /Mono|Consolas/);
  assert.notStrictEqual(matrix.vars['--texture'], 'none');
  assert.ok(matrix.vars['--text-glow'] && matrix.vars['--text-glow'] !== 'none');
});

test('plaskie motywy naprawde gasza poswiate', () => {
  const { themes } = loadThemes(() => {});
  for (const id of ['nord', 'paper', 'void', 'light']) {
    const t = themes.find((x) => x.id === id);
    assert.strictEqual(t.vars['--glow-size'], '0px', `motyw "${id}"`);
    assert.strictEqual(t.vars['--text-glow'], 'none', `motyw "${id}"`);
  }
});
