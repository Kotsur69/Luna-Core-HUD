// ============================================================================
// LunaCore - recommended libraries & tools directory tests (Ctrl+B)
// ----------------------------------------------------------------------------
// Two jobs here.
//
//   1. THE BOUNDARY. src/libraries.js is the only thing standing between a
//      hand-edited config/libraries.local.json and shell.openExternal. The
//      rejection branches - a non-http scheme, a missing name, a duplicate
//      id - are the whole reason the file exists, so they are tested directly
//      rather than through the loader.
//
//   2. THE SHIPPED CATALOG. config/libraries.json is data, and data rots
//      quietly: a typo'd URL or a duplicated name produces a row that opens
//      the wrong page, with nothing in the UI to say so.
//
// Pure loader + validation, no DOM and no Electron - same shape as
// test/layouts.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  loadLibraries,
  resolveLibraryUrl,
  normalizeItem,
  normalizeCategory,
  normalizeIcon,
  safeUrl,
  slugify,
} = require('../src/libraries.js');

const ROOT = path.join(__dirname, '..');

/** A minimal valid entry; individual tests override one field at a time. */
function item(over = {}) {
  return { name: 'Example Lib', url: 'https://example.com', description: 'Does a thing.', ...over };
}

// ---- safeUrl: the gate in front of shell.openExternal ----------------------

test('safeUrl accepts http and https', () => {
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('http://example.com/a'), 'http://example.com/a');
});

test('safeUrl trims surrounding whitespace', () => {
  assert.equal(safeUrl('  https://example.com/a  '), 'https://example.com/a');
});

test('safeUrl rejects every scheme the OS would happily launch', () => {
  for (const bad of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-msdt:/id',
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(safeUrl(bad), '', `should have rejected: ${bad}`);
  }
});

test('safeUrl rejects a non-string, an empty string and an unparseable value', () => {
  for (const bad of [undefined, null, 42, {}, '', '   ', 'not a url', '//example.com']) {
    assert.equal(safeUrl(bad), '');
  }
});

// ---- slugify ---------------------------------------------------------------

test('slugify turns a display name into a readable id', () => {
  assert.equal(slugify('Kokonut UI', 0), 'kokonut-ui');
  assert.equal(slugify('cloudflare/computer', 0), 'cloudflare-computer');
  assert.equal(slugify('Particles (Casberry)', 0), 'particles-casberry');
  assert.equal(slugify('daisyUI', 0), 'daisyui');
});

test('slugify falls back to a positional id when nothing survives', () => {
  assert.equal(slugify('!!!', 7), 'item-7');
});

// ---- normalizeItem ---------------------------------------------------------

test('normalizeItem passes a valid entry through', () => {
  assert.deepEqual(normalizeItem(item()), {
    name: 'Example Lib',
    url: 'https://example.com/',
    description: 'Does a thing.',
  });
});

test('normalizeItem rejects an entry with no name or no usable url', () => {
  assert.equal(normalizeItem(item({ name: '' })), null);
  assert.equal(normalizeItem(item({ name: '   ' })), null);
  assert.equal(normalizeItem(item({ name: 42 })), null);
  assert.equal(normalizeItem(item({ url: undefined })), null);
  assert.equal(normalizeItem(item({ url: 'file:///etc/passwd' })), null);
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem('a string'), null);
});

test('normalizeItem treats the description as optional', () => {
  assert.equal(normalizeItem(item({ description: undefined })).description, '');
  assert.equal(normalizeItem(item({ description: 99 })).description, '');
});

// ---- normalizeCategory -----------------------------------------------------

test('normalizeCategory keeps a localized title and drops bad entries', () => {
  const category = normalizeCategory({
    title: { pl: 'Przyklad', en: 'Example' },
    items: [item(), item({ url: 'javascript:alert(1)' }), item({ name: 'Second' })],
  });
  assert.deepEqual(category.title, { pl: 'Przyklad', en: 'Example' });
  assert.equal(category.items.length, 2);
  assert.equal(category.items[1].name, 'Second');
});

test('normalizeCategory rejects a category with no title or no surviving entries', () => {
  assert.equal(normalizeCategory({ title: '', items: [item()] }), null);
  assert.equal(normalizeCategory({ title: 'Example', items: [] }), null);
  assert.equal(normalizeCategory({ title: 'Example', items: 'nope' }), null);
  // Every entry rejected is the same as no entries at all.
  assert.equal(normalizeCategory({ title: 'Example', items: [item({ url: 'ftp://x/y' })] }), null);
  assert.equal(normalizeCategory(null), null);
});

// ---- The shipped catalog ---------------------------------------------------

const catalog = loadLibraries();

test('the shipped catalog loads with categories and entries', () => {
  assert.ok(catalog.categories.length > 0, 'config/libraries.json produced no categories');
  assert.equal(
    catalog.total,
    catalog.categories.reduce((n, c) => n + c.items.length, 0),
    'total does not match the entries actually returned'
  );
});

test('every shipped category carries both languages', () => {
  for (const category of catalog.categories) {
    const title = category.title;
    assert.equal(typeof title, 'object', `not localized: ${JSON.stringify(title)}`);
    assert.ok(title.pl, `missing pl title: ${JSON.stringify(title)}`);
    assert.ok(title.en, `missing en title: ${JSON.stringify(title)}`);
  }
});

test('Polish category titles stay free of diacritics (repo convention)', () => {
  for (const category of catalog.categories) {
    assert.doesNotMatch(
      category.title.pl,
      /[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c\u0104\u0106\u0118\u0141\u0143\u00d3\u015a\u0179\u017b]/,
      `config/*.json Polish is written without diacritics: "${category.title.pl}"`
    );
  }
});

test('every shipped entry has an id, a name, a description and an http(s) url', () => {
  for (const category of catalog.categories) {
    for (const entry of category.items) {
      assert.match(entry.id, /^[a-z0-9-]+$/, `bad id: ${entry.id}`);
      assert.ok(entry.name, `entry with no name in ${JSON.stringify(category.title)}`);
      assert.ok(entry.description, `${entry.name} has no description`);
      assert.match(entry.url, /^https?:\/\//, `${entry.name}: ${entry.url}`);
    }
  }
});

test('shipped ids are unique across the whole catalog', () => {
  const ids = catalog.categories.flatMap((c) => c.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, 'two entries resolve to the same id');
});

test('shipped urls are unique - a duplicate row is a copy-paste slip', () => {
  const urls = catalog.categories.flatMap((c) => c.items.map((i) => i.url));
  assert.equal(new Set(urls).size, urls.length, 'the same address appears twice');
});

// ---- resolveLibraryUrl: what main.js actually calls -------------------------

test('resolveLibraryUrl answers for every id the renderer can be handed', () => {
  for (const category of catalog.categories) {
    for (const entry of category.items) {
      assert.equal(resolveLibraryUrl(entry.id), entry.url, `id ${entry.id} did not resolve`);
    }
  }
});

test('resolveLibraryUrl refuses anything that is not a catalog id', () => {
  // This is the control: whatever the renderer sends, only an id already in the
  // catalog produces an address, so nothing else can reach openExternal.
  for (const bad of [
    'no-such-entry',
    'https://evil.example.com',
    'file:///C:/Windows/System32/calc.exe',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(resolveLibraryUrl(bad), null, `should not have resolved: ${String(bad)}`);
  }
});

// ---- i18n: the overlay's own strings ---------------------------------------

test('every libraries.* i18n key used by the overlay exists in both languages', () => {
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  assert.ok(enAt > 0, 'i18n.js should have a `pl` block followed by an `en` block');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const moduleSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/libraries.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

  const keys = new Set([
    // t('...') calls in the module
    ...[...moduleSrc.matchAll(/t\('(libraries\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    // data-i18n* attributes in the markup
    ...[...htmlSrc.matchAll(/data-i18n(?:-ph|-title|-aria)?="(libraries\.[a-zA-Z.]+)"/g)].map(
      (m) => m[1]
    ),
  ]);

  assert.ok(keys.size > 0, 'found no libraries.* keys to check - did the selectors drift?');
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});

// ---- The Videos category ---------------------------------------------------
// Spec-anchored, unlike the generic catalog guards above: these eight tools are
// the point of the category, and a rename or a dropped row would otherwise pass
// every structural check while quietly emptying the section.
//
// Deliberately the exception, not the new house rule. Videos was requested as a
// FIXED list, so pinning the names is the spec; every other category is meant to
// grow, and pinning those would turn each new row into a test edit for nothing.
//
// FFmpeg is the one entry that does not link to a GitHub repo (it has none in
// the usual sense) - it links to the official download page instead, since
// that is what the missing-ffmpeg banner in the highlight extractor deep-links to.

test('the shipped catalog carries a Videos category with the expected tools', () => {
  const videos = catalog.categories.find((c) => c.title.en === 'Videos');
  assert.ok(videos, 'no category titled "Videos" in config/libraries.json');

  const expected = [
    'brag',
    'autoclip',
    'vhs',
    'claude-video',
    'video-use',
    'OpenMontage',
    'Remotion',
    'FFmpeg',
  ];
  assert.deepEqual(
    videos.items.map((i) => i.name),
    expected,
    'the Videos entries drifted from the spec'
  );

  for (const entry of videos.items) {
    const isFfmpeg = entry.name === 'FFmpeg';
    const pattern = isFfmpeg ? /^https:\/\/ffmpeg\.org\// : /^https:\/\/github\.com\//;
    assert.match(entry.url, pattern, `${entry.name} should link to its ${isFfmpeg ? 'download page' : 'repo'}`);
  }
});

// ---- Category icons ---------------------------------------------------------
// A tile in the grid is an icon and a title, so the icon is the only thing
// telling fourteen otherwise-identical squares apart. It is NAMED in the config
// and DRAWN in the renderer, which is exactly the kind of split that rots
// quietly - hence the map guard at the bottom of this block.
//
// The config names an icon, it never carries one. A glyph or a markup string in
// a hand-edited libraries.local.json would be a second way for data to reach the
// DOM; a slug can only ever select from a table the renderer already ships.

test('normalizeIcon accepts a lowercase slug', () => {
  assert.equal(normalizeIcon('video'), 'video');
  assert.equal(normalizeIcon('  waveform  '), 'waveform');
  assert.equal(normalizeIcon('pen-tool'), 'pen-tool');
});

test('normalizeIcon falls back to the default for anything unusable', () => {
  for (const bad of [
    '',
    '   ',
    'Video',
    'vi deo',
    '<svg onload=alert(1)>',
    '../../etc/passwd',
    'a'.repeat(40),
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    assert.equal(normalizeIcon(bad), 'default', `should have fallen back: ${String(bad)}`);
  }
});

test('normalizeCategory attaches an icon, defaulting when the field is absent', () => {
  const titled = { title: { pl: 'Kategoria', en: 'Category' }, items: [item()] };
  assert.equal(normalizeCategory({ ...titled, icon: 'chart' }).icon, 'chart');
  assert.equal(normalizeCategory(titled).icon, 'default');
});

test('every shipped category names an icon, and none of them falls back', () => {
  for (const category of catalog.categories) {
    assert.ok(category.icon, `${category.title.en} has no icon`);
    assert.notEqual(
      category.icon,
      'default',
      `${category.title.en} did not name a usable icon - check the spelling in config/libraries.json`
    );
  }
});

test('shipped icons are unique - two tiles must not read as the same thing', () => {
  const icons = catalog.categories.map((c) => c.icon);
  assert.equal(new Set(icons).size, icons.length, 'two categories share an icon');
});

test('every shipped icon name is one the renderer can actually draw', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/libicons.js'), 'utf8');
  const known = new Set([...src.matchAll(/^ {2}([a-z][a-z0-9-]*): \[/gm)].map((m) => m[1]));
  assert.ok(known.size > 1, 'found no icons in libicons.js - did the shape drift?');
  assert.ok(known.has('default'), 'libicons.js must define a `default` icon to fall back to');
  for (const category of catalog.categories) {
    assert.ok(known.has(category.icon), `renderer cannot draw "${category.icon}" (${category.title.en})`);
  }
});

// ---- Descriptions ----------------------------------------------------------
// The description is the whole reason a row is worth more than a bookmark, and
// it is the field most likely to be written once from a repo's tagline and then
// never checked against what the tool actually became.

test('every shipped description is a real sentence, not a stub', () => {
  for (const category of catalog.categories) {
    for (const entry of category.items) {
      assert.ok(
        entry.description.length >= 40,
        `${entry.name}: description is too short to tell you anything`
      );
      assert.ok(
        entry.description.length <= 400,
        `${entry.name}: description is too long for a row`
      );
      assert.match(
        entry.description,
        /[.!?]$/,
        `${entry.name}: description should end in a full stop`
      );
    }
  }
});
