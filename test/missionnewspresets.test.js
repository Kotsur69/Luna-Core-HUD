// ============================================================================
// LunaCore - Mission Control News presets (renderer/modules/missionnewspresets.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PRESETS, applyPreset } = require('../src/renderer/modules/missionnewspresets.js');
const store = require('../src/missionnewsstore.js');

test('every preset survives the store validation unchanged (names are valid)', () => {
  for (const preset of PRESETS) {
    const saved = store.normalizeNews(applyPreset({ sources: [], topics: [] }, preset));
    assert.equal(saved.sources.length, preset.sources.length, preset.id);
    assert.equal(saved.topics.length, preset.topics.length, preset.id);
  }
});

test('applying a preset twice adds nothing the second time', () => {
  const ai = PRESETS.find((p) => p.id === 'ai');
  const once = applyPreset({ sources: [], topics: [] }, ai);
  const twice = applyPreset(once, ai);
  assert.deepEqual(twice, once);
});

test('existing items are kept; a topic already saved gains the preset platforms', () => {
  const ai = PRESETS.find((p) => p.id === 'ai');
  const before = {
    sources: [{ id: 's-1', platform: 'reddit', target: 'claudeai', label: 'mine' }],
    topics: [{ id: 't-1', query: 'claude code', platforms: ['youtube'] }],
  };
  const after = applyPreset(before, ai);
  assert.equal(after.sources.filter((s) => s.platform === 'reddit' && s.target.toLowerCase() === 'claudeai').length, 1);
  assert.equal(after.sources[0].label, 'mine');
  const cc = after.topics.find((t) => t.id === 't-1');
  assert.deepEqual(cc.platforms, ['youtube', 'twitter']);
  assert.deepEqual(before.topics[0].platforms, ['youtube'], 'input not mutated');
});
