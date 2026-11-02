// Tests for the sounds loader (sounds.json). pickSoundEntry is a pure function,
// no I/O - the rest of the tests check the SHIPPED config/sounds.json + the
// placeholders in helpers/sounds/ (following the "data test" pattern from rates.test.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadSoundConfig, resolveSoundFile, pickSoundEntry } = require('../src/sounds');

// ---- pickSoundEntry (pure) --------------------------------------------------

const CFG = {
  sfx: {
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

test('pickSoundEntry has no variant handling: an entry without `file` is null', () => {
  // Keystroke sound lives in keysynth.js now; the old `variants` shape is gone.
  const cfg = { sfx: { k: { volume: 35, variants: [{ id: 'a', file: 'sfx/a.wav' }] } }, voice: {} };
  assert.equal(pickSoundEntry(cfg, 'sfx.k'), null);
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

test('config/sounds.json has no mpv keystroke entry (keysynth.js owns typing sound)', () => {
  const { sfx } = loadSoundConfig();
  assert.equal(sfx.keystroke, undefined);
});

test('no keystroke-*.wav left in helpers/sounds/sfx', () => {
  const dir = path.join(__dirname, '..', 'helpers', 'sounds', 'sfx');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('keystroke-')), []);
});

test('resolveSoundFile finds every sfx key', () => {
  for (const key of ['sfx.navClick', 'sfx.modeToggle', 'sfx.terminalNew', 'sfx.terminalClose', 'sfx.moonFlare']) {
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

test('resolveSoundFile returns null for a missing file', () => {
  assert.equal(resolveSoundFile('sfx.thisKeyDoesNotExistAnywhere'), null);
});
