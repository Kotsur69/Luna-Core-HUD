'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const i18n = require('../src/lunasworkI18n');
const { validateCritique } = require('../src/lunasworkCritic');

/** A temp project with the given files ({relPath: content}). */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-i18n-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('flattenKeys flattens nested objects with dots and stringifies leaves', () => {
  assert.deepEqual(i18n.flattenKeys({ a: { b: 'x', c: { d: '' } }, e: null, f: 3 }), {
    'a.b': 'x', 'a.c.d': '', e: '', f: '3',
  });
});

test('detectLayout: locales/{pl,en}.json', () => {
  const root = project({ 'locales/pl.json': { home: { title: 'Dom' } }, 'locales/en.json': { home: { title: 'Home' } } });
  try {
    const layout = i18n.detectLayout(root);
    assert.equal(layout.type, 'json');
    assert.deepEqual(layout.keys.pl, { 'home.title': 'Dom' });
    assert.deepEqual(layout.keys.en, { 'home.title': 'Home' });
  } finally {
    cleanup(root);
  }
});

test('detectLayout: next-intl messages/{pl,en}.json', () => {
  const root = project({ 'messages/pl.json': { a: 'A', b: 'B' }, 'messages/en.json': { a: 'A' } });
  try {
    const layout = i18n.detectLayout(root);
    assert.equal(layout.type, 'json');
    assert.deepEqual(i18n.missingKeys(layout), [{ key: 'b', missingIn: 'en', reason: 'missing' }]);
  } finally {
    cleanup(root);
  }
});

test('detectLayout: i18next resources public/locales/{pl,en}/<ns>.json', () => {
  const root = project({
    'public/locales/pl/common.json': { save: 'Zapisz', cancel: 'Anuluj' },
    'public/locales/en/common.json': { save: 'Save', cancel: '' },
  });
  try {
    const layout = i18n.detectLayout(root);
    assert.equal(layout.type, 'namespaces');
    assert.deepEqual(Object.keys(layout.keys.pl).sort(), ['common.cancel', 'common.save']);
    assert.deepEqual(i18n.missingKeys(layout), [{ key: 'common.cancel', missingIn: 'en', reason: 'empty' }]);
  } finally {
    cleanup(root);
  }
});

test('detectLayout: a pl/en object map in source (LunaCore i18n.js shape)', () => {
  const src = [
    "'use strict';",
    '// a comment with pl: { not: real }',
    'const DICT = {',
    '  pl: {',
    "    'app.title': 'Tytul',",
    "    'app.long': 'Raz ' +",
    "      'dwa',",
    '    nested: { deep: "Gleboko" },',
    "    'only.pl': 'Tylko',",
    '  },',
    '  en: {',
    "    'app.title': 'Title',",
    "    'app.long': 'One two',",
    "    nested: { deep: '' },",
    '  },',
    '};',
    'module.exports = { DICT };',
  ].join('\n');
  const root = project({ 'src/renderer/i18n.js': src });
  try {
    const layout = i18n.detectLayout(root);
    assert.equal(layout.type, 'object');
    assert.equal(layout.keys.pl['app.long'], 'Raz dwa');
    assert.deepEqual(i18n.missingKeys(layout), [
      { key: 'nested.deep', missingIn: 'en', reason: 'empty' },
      { key: 'only.pl', missingIn: 'en', reason: 'missing' },
    ]);
  } finally {
    cleanup(root);
  }
});

test('detectLayout: single language or none -> null (skip)', () => {
  const single = project({ 'locales/en.json': { a: 'A' }, 'src/i18n.js': "module.exports = { en: { a: 'A' } };" });
  const none = project({ 'src/index.js': 'console.log(1)' });
  try {
    assert.equal(i18n.detectLayout(single), null);
    assert.equal(i18n.detectLayout(none), null);
    assert.equal(i18n.detectLayout(path.join(none, 'missing-dir')), null);
    assert.equal(i18n.detectLayout(''), null);
  } finally {
    cleanup(single);
    cleanup(none);
  }
});

test('detectLayout uses the injected fs', () => {
  const files = {
    [path.join('/repo', 'locales', 'pl.json')]: '{"a":"A"}',
    [path.join('/repo', 'locales', 'en.json')]: '{"a":"A","b":"B"}',
  };
  const fakeFs = {
    readdirSync: () => [],
    readFileSync: (p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    },
  };
  const layout = i18n.detectLayout('/repo', { fs: fakeFs });
  assert.equal(layout.type, 'json');
  assert.deepEqual(i18n.missingKeys(layout), [{ key: 'b', missingIn: 'pl', reason: 'missing' }]);
});

test('missingKeys is empty on parity and on bad input', () => {
  assert.deepEqual(i18n.missingKeys({ keys: { pl: { a: 'x' }, en: { a: 'y' } } }), []);
  assert.deepEqual(i18n.missingKeys(null), []);
});

const DIFF = [
  'diff --git a/src/Button.tsx b/src/Button.tsx',
  '--- a/src/Button.tsx',
  '+++ b/src/Button.tsx',
  '@@ -1,2 +10,5 @@',
  ' const x = 1;',
  '+  <button>Save changes</button>',
  '+  <input placeholder="Your email" />',
  '+  <p>{t("home.title")}</p>',
  '+  if (count > limit && b < c) {}',
  'diff --git a/src/util.js b/src/util.js',
  '--- a/src/util.js',
  '+++ b/src/util.js',
  '@@ -1 +1 @@',
  "+const s = '<b>Not UI</b>';",
].join('\n');

test('hardcodedStrings flags added JSX/HTML text and attributes only', () => {
  assert.deepEqual(i18n.hardcodedStrings(DIFF), [
    { file: 'src/Button.tsx', line: 11, text: 'Save changes' },
    { file: 'src/Button.tsx', line: 12, text: 'Your email' },
  ]);
  assert.deepEqual(i18n.hardcodedStrings(''), []);
  assert.deepEqual(i18n.hardcodedStrings(undefined), []);
});

test('i18nCards: missing keys -> exactly ONE bug card listing them, with a key-parity repro test', () => {
  const root = project({
    'locales/pl.json': { a: 'A', b: 'B', c: { d: 'D' } },
    'locales/en.json': { a: 'A' },
  });
  try {
    const out = i18n.i18nCards({ repoPath: root, runId: 'r1' });
    assert.equal(out.layout, 'json');
    assert.equal(out.cards.length, 1);
    const [card] = out.cards;
    assert.equal(card.kind, 'bug');
    assert.match(card.text, /^2 translation key/);
    assert.match(card.details, /- b: missing in en/);
    assert.match(card.details, /- c\.d: missing in en/);
    assert.match(card.details, /key parity/);
    assert.ok(card.acceptance.some((a) => /key parity/.test(a)));
    // The Critic did not have to add its generic repro text: ours already asks for one.
    assert.deepEqual(out.warnings, []);
    assert.ok(card.tags.includes('run:r1'));
    assert.ok(card.tags.includes(i18n.I18N_TAG));
    // The card shape passes the Critic's trust boundary unchanged.
    const again = validateCritique(
      { cards: [card], logEntry: {}, architecture: '', decisions: [], newJourneys: [], verdict: 'CONTINUE' },
    );
    assert.equal(again.cards.length, 1);
  } finally {
    cleanup(root);
  }
});

test('i18nCards: hard-coded strings add one low-severity card', () => {
  const root = project({ 'messages/pl.json': { a: 'A' }, 'messages/en.json': { a: 'A' } });
  try {
    const out = i18n.i18nCards({ repoPath: root, runId: 'r1', diff: DIFF });
    assert.equal(out.cards.length, 1);
    assert.equal(out.cards[0].kind, 'missing');
    assert.equal(out.cards[0].severity, 'low');
    assert.deepEqual(out.cards[0].files, ['src/Button.tsx']);
  } finally {
    cleanup(root);
  }
});

test('i18nCards: single-language project is skipped, bad input never throws', () => {
  const root = project({ 'locales/en.json': { a: 'A' } });
  try {
    const out = i18n.i18nCards({ repoPath: root, runId: 'r1', diff: DIFF });
    assert.equal(out.layout, null);
    assert.deepEqual(out.cards, []);
    assert.deepEqual(out.notes, []);
  } finally {
    cleanup(root);
  }
  assert.deepEqual(i18n.i18nCards(null).cards, []);
  assert.match(i18n.i18nCards({ repoPath: '/x' }).notes[0], /badRunId/);
  const throwing = { readdirSync: () => { throw new Error('boom'); }, readFileSync: () => { throw new Error('boom'); } };
  assert.deepEqual(i18n.i18nCards({ repoPath: '/x', runId: 'r1', fs: throwing }).cards, []);
});
