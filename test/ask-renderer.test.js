// ============================================================================
// LunaCore - /ask panel renderer tests (src/renderer/modules/ask*.js)
// ----------------------------------------------------------------------------
// isAskCommand/parseAskQuery live in modules/askcommand.js, not modules/ask.js
// itself - ask.js does module-scope document.getElementById() the moment it
// is imported (its own overlay DOM refs), so it cannot be require()'d from a
// plain `node --test` run with no DOM. Same wall gitquick.js hit, same fix:
// its pure formatting helpers live in gitquick-format.js, tested directly in
// test/gitquick.test.js, never through gitquick.js itself. openAsk/closeAsk
// are the DOM-touching half here and are left untested for the same reason -
// no existing renderer modules/*.js test in this repo touches the DOM (see
// e.g. test/notify.test.js, test/gitquick.test.js): every one of them targets
// a sibling file whose functions never call document.* at all.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ASK_PREFIX, isAskCommand, parseAskQuery } = require('../src/renderer/modules/askcommand.js');

const ROOT = path.join(__dirname, '..');

// ---- ASK_PREFIX ---------------------------------------------------------------

test('ASK_PREFIX is the literal command word', () => {
  assert.equal(ASK_PREFIX, '/ask');
});

// ---- isAskCommand ---------------------------------------------------------------

test('isAskCommand accepts "/ask <question>"', () => {
  assert.equal(isAskCommand('/ask what should I use to edit gaming clips'), true);
});

test('isAskCommand is case-insensitive on the prefix', () => {
  assert.equal(isAskCommand('/ASK what tool'), true);
  assert.equal(isAskCommand('/Ask what tool'), true);
});

test('isAskCommand tolerates leading/trailing whitespace around the whole value', () => {
  assert.equal(isAskCommand('   /ask what tool   '), true);
});

test('isAskCommand accepts multiple spaces between the prefix and the question', () => {
  assert.equal(isAskCommand('/ask    what tool'), true);
});

test('isAskCommand rejects a bare "/ask" with no question', () => {
  // No \s+ after the prefix to match - matches src/ask.js's own runAsk(),
  // which would reject an empty question anyway (see openAsk()'s
  // defense-in-depth errorRow('empty-question') path).
  assert.equal(isAskCommand('/ask'), false);
  assert.equal(isAskCommand('/ask   '), false);
});

test('isAskCommand rejects plain filter text and other slash commands', () => {
  assert.equal(isAskCommand('react hooks'), false);
  assert.equal(isAskCommand('/asking for a friend'), false);
  assert.equal(isAskCommand('/other command'), false);
  assert.equal(isAskCommand(''), false);
});

test('isAskCommand rejects non-string input without throwing', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(isAskCommand(bad), false);
  }
});

// ---- parseAskQuery ---------------------------------------------------------------

test('parseAskQuery strips the prefix and leading whitespace', () => {
  assert.equal(parseAskQuery('/ask what should I use to edit gaming clips'), 'what should I use to edit gaming clips');
});

test('parseAskQuery is case-insensitive on the prefix', () => {
  assert.equal(parseAskQuery('/ASK what tool'), 'what tool');
});

test('parseAskQuery collapses the whitespace between the prefix and the question', () => {
  assert.equal(parseAskQuery('/ask     what tool'), 'what tool');
});

test('parseAskQuery trims surrounding whitespace on the whole value', () => {
  assert.equal(parseAskQuery('   /ask what tool   '), 'what tool');
});

test('parseAskQuery leaves input unchanged when the prefix does not actually match', () => {
  // Same \s+-after-the-prefix rule isAskCommand() uses: a bare "/ask" with no
  // question has nothing for the regex to strip, so it passes through as-is
  // rather than being silently emptied.
  assert.equal(parseAskQuery('/ask'), '/ask');
  assert.equal(parseAskQuery('react hooks'), 'react hooks');
});

test('parseAskQuery returns an empty string for non-string input without throwing', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(parseAskQuery(bad), '');
  }
});

// ---- i18n: the /ask panel's own strings ---------------------------------------
// Same shape as test/libraries.test.js's "every libraries.* i18n key used by
// the overlay exists in both languages" test, scanning ask.js/askview.js/the
// #ask markup instead of libraries.js/index.html's #libraries block.

test('every ask.* i18n key used by the panel exists in both languages', () => {
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  assert.ok(enAt > 0, 'i18n.js should have a `pl` block followed by an `en` block');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const askSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/ask.js'), 'utf8');
  const askViewSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/askview.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

  const keys = new Set([
    // t('...') calls in either module
    ...[...askSrc.matchAll(/t\('(ask\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    ...[...askViewSrc.matchAll(/t\('(ask\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    // data-i18n* attributes in the #ask markup
    ...[...htmlSrc.matchAll(/data-i18n(?:-ph|-title|-aria)?="(ask\.[a-zA-Z.]+)"/g)].map((m) => m[1]),
  ]);

  assert.ok(keys.size > 0, 'found no ask.* keys to check - did the selectors drift?');
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});

test('every ask.* i18n key is present in both languages, independent of current usage', () => {
  // Broader than the scan above: pins the full key set the plan specifies,
  // including ask.suggestions.added - reserved for when onAddSuggestion()
  // (modules/ask.js) is wired to a real libraries:add bridge in a later
  // phase and starts showing it, so it is not yet referenced by any t() call.
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const expectedKeys = [
    'ask.panel.title',
    'ask.loading',
    'ask.summary.label',
    'ask.recommended.heading',
    'ask.suggestions.heading',
    'ask.suggestions.add',
    'ask.suggestions.added',
    'ask.suggestions.run',
    'ask.error.noClaude',
    'ask.error.timeout',
    'ask.error.badJson',
    'ask.error.emptyQuestion',
    'ask.error.generic',
    'ask.close',
  ];

  for (const key of expectedKeys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});
