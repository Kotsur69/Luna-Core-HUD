'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceDuck } = require('../src/voiceduck');

/** Spy-backed deps with knobs for the two live checks. */
function makeDuck({ enabled = true, playing = true } = {}) {
  const calls = { pause: 0, resume: 0 };
  const duck = createVoiceDuck({
    isEnabled: () => enabled,
    isMediaPlaying: () => playing,
    pauseMedia: () => {
      calls.pause += 1;
    },
    resumeMedia: () => {
      calls.resume += 1;
    },
  });
  return { duck, calls, set: (k, v) => (k === 'enabled' ? (enabled = v) : (playing = v)) };
}

test('pauses media when enabled and something is playing', async () => {
  const { duck, calls } = makeDuck({ enabled: true, playing: true });
  await duck.onVoiceActive(true);
  assert.equal(calls.pause, 1);
  assert.equal(duck.pausedByUs, true);
});

test('resumes the media it paused when narration ends', async () => {
  const { duck, calls } = makeDuck();
  await duck.onVoiceActive(true);
  await duck.onVoiceActive(false);
  assert.equal(calls.resume, 1);
  assert.equal(duck.pausedByUs, false);
});

test('does nothing when the toggle is off', async () => {
  const { duck, calls } = makeDuck({ enabled: false, playing: true });
  await duck.onVoiceActive(true);
  await duck.onVoiceActive(false);
  assert.equal(calls.pause, 0);
  assert.equal(calls.resume, 0);
});

test('does not pause when no media is playing', async () => {
  const { duck, calls } = makeDuck({ enabled: true, playing: false });
  await duck.onVoiceActive(true);
  assert.equal(calls.pause, 0);
  assert.equal(duck.pausedByUs, false);
});

test('never resumes media it did not pause', async () => {
  const { duck, calls } = makeDuck({ enabled: true, playing: false });
  await duck.onVoiceActive(false);
  assert.equal(calls.resume, 0);
});

test('a repeated active signal does not pause twice', async () => {
  const { duck, calls } = makeDuck();
  await duck.onVoiceActive(true);
  await duck.onVoiceActive(true);
  assert.equal(calls.pause, 1);
});

test('still resumes if the toggle is switched off mid-narration', async () => {
  const { duck, calls, set } = makeDuck({ enabled: true, playing: true });
  await duck.onVoiceActive(true);
  set('enabled', false);
  await duck.onVoiceActive(false);
  assert.equal(calls.resume, 1);
  assert.equal(duck.pausedByUs, false);
});

test('a trailing idle signal after resume is a no-op', async () => {
  const { duck, calls } = makeDuck();
  await duck.onVoiceActive(true);
  await duck.onVoiceActive(false);
  await duck.onVoiceActive(false);
  assert.equal(calls.resume, 1);
});
