// Tests for the sounds loader (sounds.json). pickSoundEntry is a pure function,
// no I/O - the rest of the tests check the SHIPPED config/sounds.json + the
// placeholders in helpers/sounds/ (following the "data test" pattern from rates.test.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadSoundConfig, resolveSoundFile, pickSoundEntry } = require('../src/sounds');

// ---- pickSoundEntry (pure) --------------------------------------------------

const CFG = {
  sfx: {
    keystroke: {
      volume: 35,
      enabled: true,
      variants: [
        { id: 'mechanical', label: 'Mechanical', file: 'sfx/keystroke-mechanical.wav' },
        { id: 'soft', label: 'Soft', file: 'sfx/keystroke-soft.wav' },
      ],
    },
    navClick: { file: 'sfx/nav-click.wav', volume: 55 },
    disabledSfx: { file: 'sfx/nope.wav', volume: 50, enabled: false },
  },
  voice: {
    done: { file: 'voice/done.mp3', volume: 80 },
  },
};

test('pickSoundEntry returns file+volume for a simple entry', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.navClick'), { file: 'sfx/nav-click.wav', volume: 55 });
  assert.deepEqual(pickSoundEntry(CFG, 'voice.done'), { file: 'voice/done.mp3', volume: 80 });
});

test('pickSoundEntry picks a variant by id', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke', { variant: 'soft' }), {
    file: 'sfx/keystroke-soft.wav',
    volume: 35,
  });
});

test('pickSoundEntry falls back to variants[0] when the variant id is missing/invalid', () => {
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke'), {
    file: 'sfx/keystroke-mechanical.wav',
    volume: 35,
  });
  assert.deepEqual(pickSoundEntry(CFG, 'sfx.keystroke', { variant: 'nonexistent' }), {
    file: 'sfx/keystroke-mechanical.wav',
    volume: 35,
  });
});

test('pickSoundEntry returns null for enabled:false', () => {
  assert.equal(pickSoundEntry(CFG, 'sfx.disabledSfx'), null);
});

test('pickSoundEntry returns null for an unknown key/group', () => {
  assert.equal(pickSoundEntry(CFG, 'sfx.doesNotExist'), null);
  assert.equal(pickSoundEntry(CFG, 'notAGroup.x'), null);
  assert.equal(pickSoundEntry(null, 'sfx.navClick'), null);
});

test('pickSoundEntry defaults volume to 70 when missing from the config', () => {
  const cfg = { sfx: { x: { file: 'sfx/x.wav' } }, voice: {} };
  assert.equal(pickSoundEntry(cfg, 'sfx.x').volume, 70);
});

// ---- coverage of the SHIPPED config/sounds.json + helpers/sounds/ -------------
// The tests below check the config and the placeholders on disk, not the logic
// itself - they guard that resolveSoundFile() really finds the files that
// config/sounds.json promises (see rates.test.js for the same convention).

test('config/sounds.json has all 4 keystroke variants', () => {
  const { sfx } = loadSoundConfig();
  assert.equal(sfx.keystroke.variants.length, 4);
  const ids = sfx.keystroke.variants.map((v) => v.id).sort();
  assert.deepEqual(ids, ['mechanical', 'scifi', 'soft', 'typewriter']);
});

test('resolveSoundFile finds every sfx key (except keystroke)', () => {
  for (const key of ['sfx.navClick', 'sfx.modeToggle', 'sfx.terminalNew', 'sfx.terminalClose']) {
    const r = resolveSoundFile(key);
    assert.ok(r, `${key} should resolve`);
    assert.ok(r.path.endsWith('.wav'));
  }
});

test('resolveSoundFile finds every one of the 5 voice lines', () => {
  for (const key of ['voice.welcome', 'voice.needYou', 'voice.done', 'voice.usage50', 'voice.usage80']) {
    const r = resolveSoundFile(key);
    assert.ok(r, `${key} should resolve`);
    assert.ok(r.path.endsWith('.mp3'));
  }
});

test('resolveSoundFile finds every keystroke variant by id', () => {
  for (const id of ['mechanical', 'soft', 'scifi', 'typewriter']) {
    const r = resolveSoundFile('sfx.keystroke', { variant: id });
    assert.ok(r, `variant ${id} should resolve`);
    assert.ok(r.path.includes(`keystroke-${id}.wav`));
  }
});

test('resolveSoundFile returns null for a missing file', () => {
  assert.equal(resolveSoundFile('sfx.thisKeyDoesNotExistAnywhere'), null);
});
