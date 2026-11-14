// ============================================================================
// LunaCore - the optional usefulness, decay and conflict fields of a memory
// record (src/memoryrecord.js brainFields)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRecord, normalizeRecord, serializeRecord, recordFromFile, scoreOf } = require('../src/memoryrecord.js');

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
