// ============================================================================
// LunaCore - the optional usefulness, decay and conflict fields of a memory
// record (src/memoryrecord.js brainFields)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkRecord,
  normalizeRecord,
  serializeRecord,
  recordFromFile,
  scoreOf,
  MAX_RECORD_BYTES,
  MAX_EXTRA_FIELDS,
  MAX_EXTRA_VALUE,
} = require('../src/memoryrecord.js');
const { hasSecret } = require('../src/memorysync.js');

const PROJECT = 'github.com/acme/hud';
const base = {
  id: 'busy-after-sleep',
  type: 'gotcha',
  project: PROJECT,
  title: 'Retry says busy after sleep',
  created: '2026-10-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: 'Restart LunaCore.',
};
const where = { project: PROJECT, id: base.id };

test('an older record without the new fields loads and serializes exactly as before', () => {
  const record = normalizeRecord(base);
  assert.deepEqual(Object.keys(record).sort(), Object.keys(base).sort());
  const text = serializeRecord(record);
  assert.doesNotMatch(text, /usefulness|last_used|archived|conflicts|compatible/);
  assert.deepEqual(recordFromFile(text, where).record, record);
});

test('the new fields survive the markdown file and the sync value alike', () => {
  const full = normalizeRecord({
    ...base,
    usefulness: 72,
    usefulness_note: 'Saves an hour: "busy" is not a code bug.',
    usefulness_at: '2026-11-01',
    last_used: '2026-11-10',
    archived: '2026-11-12',
    conflicts: ['retry-works-after-sleep'],
    compatible: ['gm-retry'],
  });
  assert.equal(full.usefulness, 72);
  assert.equal(full.usefulness_note, 'Saves an hour: "busy" is not a code bug.');
  assert.deepEqual(full.conflicts, ['retry-works-after-sleep']);
  const back = recordFromFile(serializeRecord(full), where).record;
  assert.deepEqual(back, full);
  // The cloud carries the record as JSON: the same record comes back.
  assert.deepEqual(normalizeRecord(JSON.parse(JSON.stringify(full))), full);
});

test('a bad value is dropped, never failing the whole record', () => {
  const res = checkRecord({
    ...base,
    // Not a number at all: an out-of-range one is clamped (memoryrecord usefulnessOf).
    usefulness: 'high',
    usefulness_note: 'x',
    last_used: 'yesterday',
    archived: 7,
    conflicts: ['../escape', base.id],
    compatible: 'gm-retry',
  });
  assert.ok(res.record, res.error);
  for (const field of ['usefulness', 'usefulness_note', 'last_used', 'archived', 'conflicts', 'compatible']) {
    assert.equal(field in res.record, false, field);
  }
  // One parser for the extractor's guess and the scan's score: rounded, clamped to 0-100.
  assert.equal(normalizeRecord({ ...base, usefulness: 12.5 }).usefulness, 13);
  assert.equal(normalizeRecord({ ...base, usefulness: 140 }).usefulness, 100);
  assert.equal(normalizeRecord({ ...base, usefulness: '40' }).usefulness, 40);
  assert.equal(normalizeRecord({ ...base, usefulness: 0 }).usefulness, 0);
});

test('a reason is one clean line, cut to its limit', () => {
  const record = normalizeRecord({ ...base, usefulness: 50, usefulness_note: `line one\nline‮two ${'x'.repeat(400)}` });
  assert.doesNotMatch(record.usefulness_note, /[\n‮]/);
  assert.ok(record.usefulness_note.length <= 200);
});

test('scoreOf gives null for a memory the scan has not rated', () => {
  assert.deepEqual(scoreOf(normalizeRecord(base)), { usefulness: null, usefulness_note: null });
  assert.deepEqual(scoreOf(normalizeRecord({ ...base, usefulness: 9, usefulness_note: 'Vague.' })), { usefulness: 9, usefulness_note: 'Vague.' });
});

// ---- fields a newer version wrote (record.extra) ----------------------------------

/** A memory file as serializeRecord writes it, plus `tail` lines after the known fields. */
const fileWith = (tail) =>
  [
    '---',
    'id: busy-after-sleep',
    'type: gotcha',
    `project: ${PROJECT}`,
    'title: Retry says busy after sleep',
    'created: 2026-10-01',
    'confidence: confirmed',
    'supersedes: []',
    'links: []',
    ...tail,
    '---',
    'Restart LunaCore.',
    '',
  ].join('\n');

test("an unknown field ('final_score: 80') survives parse -> checkRecord -> serialize unchanged", () => {
  const text = fileWith(['final_score: 80', 'review_state: "needs a look # soon"']);
  const { record } = recordFromFile(text, where);
  assert.deepEqual(record.extra, [
    ['final_score', '80'],
    ['review_state', '"needs a look # soon"'],
  ]);
  assert.equal(serializeRecord(record), text);
  // The cloud carries the record as JSON: the bag comes back the same.
  assert.deepEqual(normalizeRecord(JSON.parse(JSON.stringify(record))), record);
});

test('an older PC that rewrites the memory (approve, decay, verify) keeps the unknown fields', () => {
  const { record } = recordFromFile(fileWith(['final_score: 80']), where);
  const rewritten = normalizeRecord({ ...record, last_verified: '2026-11-14', usefulness: 40 });
  assert.match(serializeRecord(rewritten), /\nfinal_score: 80\n---\n/);
});

test('unknown fields are written after the known ones, in their original order', () => {
  const text = fileWith([]).replace('type: gotcha\n', 'type: gotcha\nzeta_flag: yes\n').replace('links: []\n', 'links: []\nalpha_note: first\n');
  const { record } = recordFromFile(text, where);
  assert.deepEqual(record.extra, [
    ['zeta_flag', 'yes'],
    ['alpha_note', 'first'],
  ]);
  assert.equal(serializeRecord(record), fileWith(['zeta_flag: yes', 'alpha_note: first']));
});

test('a file without unknown fields serializes byte for byte as before, with no extra bag', () => {
  for (const text of [fileWith([]), fileWith(['usefulness: 72', 'usefulness_note: Saves an hour.'])]) {
    // The brain fields sit before supersedes in the canonical order.
    const canonical = text.includes('usefulness') ? text.replace('supersedes: []\nlinks: []\nusefulness: 72\nusefulness_note: Saves an hour.\n', 'usefulness: 72\nusefulness_note: Saves an hour.\nsupersedes: []\nlinks: []\n') : text;
    const { record } = recordFromFile(canonical, where);
    assert.equal('extra' in record, false);
    assert.equal(serializeRecord(record), canonical);
  }
});

test('bad unknown keys and values are dropped and never fail the record', () => {
  const long = 'x'.repeat(MAX_EXTRA_VALUE + 1);
  const text = fileWith(['Final_Score: 1', 'final-score: 2', `k${'a'.repeat(40)}: 3`, `big_value: ${long}`, 'nested:', '  child: 4', 'ok_field: 5']);
  const res = recordFromFile(text, where);
  assert.ok(res.record, res.error);
  assert.deepEqual(res.record.extra, [['ok_field', '5']]);

  // The same rules hold for a bag that arrives as JSON from another PC.
  const fromCloud = checkRecord({
    ...base,
    extra: [
      ['title', 'a known field cannot hide in the bag'],
      ['extra', 'nor can the bag itself'],
      ['constructor', 'x'],
      ['line_break', 'one\nfake_field: two'],
      ['hidden', 'a\u202Eb'],
      ['not_text', 42],
      ['short'],
      'not-a-pair',
      ['max_ok', 'x'.repeat(MAX_EXTRA_VALUE)],
      ['dup', 'first'],
      ['dup', 'last'],
    ],
  });
  assert.ok(fromCloud.record, fromCloud.error);
  assert.deepEqual(fromCloud.record.extra, [
    ['max_ok', 'x'.repeat(MAX_EXTRA_VALUE)],
    ['dup', 'last'],
  ]);
  assert.equal(normalizeRecord({ ...base, extra: 'dropped' }).extra, undefined);
});

test('at most MAX_EXTRA_FIELDS unknown fields are kept, the first ones', () => {
  const pairs = Array.from({ length: MAX_EXTRA_FIELDS + 5 }, (_, i) => [`field_${i}`, String(i)]);
  const { extra } = normalizeRecord({ ...base, extra: pairs });
  assert.equal(extra.length, MAX_EXTRA_FIELDS);
  assert.deepEqual(extra[0], ['field_0', '0']);
  assert.deepEqual(extra.at(-1), [`field_${MAX_EXTRA_FIELDS - 1}`, String(MAX_EXTRA_FIELDS - 1)]);
});

test('the whole record still fits one sync unit: unknown fields go first, the record stays', () => {
  const bytes = (r) => Buffer.byteLength(JSON.stringify(r), 'utf8');
  const shell = bytes({ ...normalizeRecord(base), body: '' });
  const pair = bytes(['field_0', 'v'.repeat(MAX_EXTRA_VALUE)]);
  // Two-byte characters fill the record under MAX_BODY characters, leaving room for one carried pair.
  const body = 'ż'.repeat(Math.floor((MAX_RECORD_BYTES - shell - pair - 20) / 2));
  const pairs = Array.from({ length: 5 }, (_, i) => [`field_${i}`, 'v'.repeat(MAX_EXTRA_VALUE)]);
  const res = checkRecord({ ...base, body, extra: pairs });
  assert.ok(res.record, res.error);
  assert.ok(bytes(res.record) <= MAX_RECORD_BYTES);
  assert.deepEqual(
    res.record.extra.map(([k]) => k),
    ['field_0'],
  );
  // Too big without any extras is still refused, as before.
  assert.equal(checkRecord({ ...base, body: 'b'.repeat(MAX_RECORD_BYTES) }).error, 'body-too-long');
});

test('the secret scanner reads the carried values too', () => {
  // Assembled at runtime: the full key shape never appears in the source.
  const fakeKey = ['sk', 'a'.repeat(24)].join('-');
  const clean = normalizeRecord({ ...base, extra: [['final_score', '80']] });
  const leaky = normalizeRecord({ ...base, extra: [['api_note', `use ${fakeKey}`]] });
  assert.equal(hasSecret(clean), false);
  assert.equal(hasSecret(leaky), true);
});
