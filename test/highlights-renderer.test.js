// ============================================================================
// LunaCore - highlight extractor panel renderer tests
// (src/renderer/modules/highlights*.js)
// ----------------------------------------------------------------------------
// isValidSeconds/parseSecondsInput/validateRunInputs/statusForEvent live in
// modules/highlightscommand.js, not modules/highlights.js itself -
// highlights.js does module-scope document.getElementById() the moment it is
// imported (its own overlay DOM refs, plus a window.lunacore.onHighlightProgress()
// call), so it cannot be require()'d from a plain `node --test` run with no
// DOM. Same wall ask.js hit, same fix - see test/ask-renderer.test.js's own
// header for the precedent this file follows. openHighlightExtractor/
// closeHighlightExtractor and the view builders in highlightsview.js are the
// DOM-touching half and are left untested for the same reason: no existing
// renderer modules/*.js test in this repo touches the DOM.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_SECONDS,
  isValidSeconds,
  parseSecondsInput,
  validateRunInputs,
  statusForEvent,
} = require('../src/renderer/modules/highlightscommand.js');

const ROOT = path.join(__dirname, '..');

// ---- DEFAULT_SECONDS ---------------------------------------------------------

test('DEFAULT_SECONDS is a sane positive default', () => {
  assert.equal(DEFAULT_SECONDS, 30);
  assert.equal(isValidSeconds(DEFAULT_SECONDS), true);
});

// ---- isValidSeconds ---------------------------------------------------------

test('isValidSeconds accepts a positive finite number', () => {
  assert.equal(isValidSeconds(1), true);
  assert.equal(isValidSeconds(30), true);
  assert.equal(isValidSeconds(0.5), true);
});

test('isValidSeconds rejects zero, negative, non-finite and non-number values', () => {
  for (const bad of [0, -5, NaN, Infinity, -Infinity, '20', null, undefined, {}, []]) {
    assert.equal(isValidSeconds(bad), false, `should have rejected: ${String(bad)}`);
  }
});

// ---- parseSecondsInput ---------------------------------------------------------

test('parseSecondsInput parses a numeric string', () => {
  assert.equal(parseSecondsInput('30'), 30);
  assert.equal(parseSecondsInput('12.5'), 12.5);
});

test('parseSecondsInput returns NaN for empty/garbage input rather than coercing to 0', () => {
  assert.ok(Number.isNaN(parseSecondsInput('')));
  assert.ok(Number.isNaN(parseSecondsInput('not a number')));
  assert.ok(Number.isNaN(parseSecondsInput(undefined)));
});

// ---- validateRunInputs ---------------------------------------------------------

test('validateRunInputs accepts both folders picked and a positive seconds', () => {
  assert.deepEqual(
    validateRunInputs({ sourceFolder: 'C:/clips', outputFolder: 'C:/out', seconds: 30 }),
    { ok: true }
  );
});

test('validateRunInputs rejects a missing source folder', () => {
  assert.deepEqual(validateRunInputs({ sourceFolder: null, outputFolder: 'C:/out', seconds: 30 }), {
    ok: false,
    reason: 'no-source',
  });
  assert.deepEqual(validateRunInputs({ sourceFolder: '', outputFolder: 'C:/out', seconds: 30 }), {
    ok: false,
    reason: 'no-source',
  });
});

test('validateRunInputs rejects a missing output folder', () => {
  assert.deepEqual(validateRunInputs({ sourceFolder: 'C:/clips', outputFolder: null, seconds: 30 }), {
    ok: false,
    reason: 'no-output',
  });
});

test('validateRunInputs rejects a bad seconds value', () => {
  assert.deepEqual(
    validateRunInputs({ sourceFolder: 'C:/clips', outputFolder: 'C:/out', seconds: NaN }),
    { ok: false, reason: 'bad-seconds' }
  );
  assert.deepEqual(
    validateRunInputs({ sourceFolder: 'C:/clips', outputFolder: 'C:/out', seconds: 0 }),
    { ok: false, reason: 'bad-seconds' }
  );
});

test('validateRunInputs checks source before output before seconds', () => {
  // Missing everything still reports the first thing wrong, not the last -
  // consistent, predictable precedence rather than an arbitrary pick.
  assert.deepEqual(validateRunInputs({}), { ok: false, reason: 'no-source' });
});

// ---- statusForEvent ---------------------------------------------------------

test('statusForEvent maps every real highlights:progress per-file event', () => {
  assert.equal(statusForEvent('file-start'), 'running');
  assert.equal(statusForEvent('file-done'), 'done');
  assert.equal(statusForEvent('file-error'), 'error');
  assert.equal(statusForEvent('file-cancelled'), 'cancelled');
});

test('statusForEvent returns null for batch-level events and anything unrecognized', () => {
  assert.equal(statusForEvent('batch-done'), null);
  assert.equal(statusForEvent('batch-cancelled'), null);
  assert.equal(statusForEvent('something-else'), null);
  assert.equal(statusForEvent(undefined), null);
});

// ---- i18n: the panel's own strings ---------------------------------------
// Same shape as test/ask-renderer.test.js's ask.* pair, scanning
// highlights.js/highlightsview.js/the #highlights markup instead.

test('every highlights.* i18n key used by the panel exists in both languages', () => {
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  assert.ok(enAt > 0, 'i18n.js should have a `pl` block followed by an `en` block');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const moduleSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/highlights.js'), 'utf8');
  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/highlightsview.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

  const keys = new Set([
    // t('...') calls in either module
    ...[...moduleSrc.matchAll(/t\('(highlights\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    ...[...viewSrc.matchAll(/t\('(highlights\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    // data-i18n* attributes in the #highlights markup and its chip
    ...[...htmlSrc.matchAll(/data-i18n(?:-ph|-title|-aria)?="(highlights\.[a-zA-Z.]+)"/g)].map((m) => m[1]),
  ]);

  assert.ok(keys.size > 0, 'found no highlights.* keys to check - did the selectors drift?');
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});

test('every highlights.* i18n key is present in both languages, independent of current usage', () => {
  // Broader than the scan above: the scan's regex only catches t('literal')
  // calls, so it misses keys resolved dynamically (STATUS_KEYS[status],
  // ERROR_KEYS[reason], and the role-ternary pick-button label in
  // highlightsview.js's folderPickerRow()) even though they are genuinely
  // used at runtime. This pins the full key set instead.
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  const enAt = i18nSrc.indexOf('\n  en: {');
  const pl = i18nSrc.slice(0, enAt);
  const en = i18nSrc.slice(enAt);

  const expectedKeys = [
    'highlights.chip.title',
    'highlights.panel.title',
    'highlights.source.label',
    'highlights.source.pick',
    'highlights.output.label',
    'highlights.output.pick',
    'highlights.seconds.label',
    'highlights.run',
    'highlights.cancel',
    'highlights.status.queued',
    'highlights.status.running',
    'highlights.status.done',
    'highlights.status.error',
    'highlights.status.cancelled',
    'highlights.ffmpeg.missing',
    'highlights.ffmpeg.openCatalog',
    'highlights.keyframeWarning',
    'highlights.error.badFolder',
    'highlights.error.noFiles',
    'highlights.error.badSeconds',
    'highlights.error.generic',
    'highlights.close',
  ];

  for (const key of expectedKeys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});
