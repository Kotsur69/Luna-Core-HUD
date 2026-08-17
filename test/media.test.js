// Tests for the pure functions behind the Media Deck (system volume + media
// playback controller). Zero DOM/process spawning - parseNowPlaying/
// parseVolume/truncateLabel are pure; sampleMedia/sendTransportCommand/
// getVolume/setVolume/toggleMute/MediaSampler spawn a real powershell.exe
// process against real GSMTC/COM state and are left to the plan's manual
// verification checklist, same testing boundary gpu.js documents for
// sampleGpu/GpuSampler in its own footer comment.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNowPlaying, parseVolume } = require('../src/media.js');
const { truncateLabel } = require('../src/renderer/modules/media.js');

// ---- parseNowPlaying ------------------------------------------------------------

test('parseNowPlaying parses a full now-playing payload', () => {
  const out = JSON.stringify({ title: 'Song', artist: 'Artist', appId: 'Spotify.exe', isPlaying: true });
  assert.deepEqual(parseNowPlaying(out), { title: 'Song', artist: 'Artist', appId: 'Spotify.exe', isPlaying: true });
});

test('parseNowPlaying treats empty/whitespace stdout as null (no session)', () => {
  assert.equal(parseNowPlaying(''), null);
  assert.equal(parseNowPlaying('   '), null);
  assert.equal(parseNowPlaying(undefined), null);
});

test('parseNowPlaying treats malformed JSON as null', () => {
  assert.equal(parseNowPlaying('not json'), null);
});

test('parseNowPlaying defaults missing/wrong-typed fields to empty/false', () => {
  const out = JSON.stringify({ title: 42 });
  assert.deepEqual(parseNowPlaying(out), { title: '', artist: '', appId: '', isPlaying: false });
});

// ---- parseVolume -----------------------------------------------------------------

test('parseVolume parses a full volume payload', () => {
  assert.deepEqual(parseVolume(JSON.stringify({ level: 42, muted: false })), { level: 42, muted: false });
});

test('parseVolume treats empty stdout as null', () => {
  assert.equal(parseVolume(''), null);
  assert.equal(parseVolume(undefined), null);
});

test('parseVolume treats malformed JSON as null', () => {
  assert.equal(parseVolume('not json'), null);
});

test('parseVolume treats a missing/non-numeric level as null', () => {
  assert.equal(parseVolume(JSON.stringify({ muted: true })), null);
  assert.equal(parseVolume(JSON.stringify({ level: 'loud' })), null);
});

test('parseVolume clamps level into 0-100 and rounds it', () => {
  assert.deepEqual(parseVolume(JSON.stringify({ level: 142, muted: false })), { level: 100, muted: false });
  assert.deepEqual(parseVolume(JSON.stringify({ level: -5, muted: false })), { level: 0, muted: false });
  assert.deepEqual(parseVolume(JSON.stringify({ level: 41.6, muted: false })), { level: 42, muted: false });
});

// ---- truncateLabel (renderer widget) ---------------------------------------------

test('truncateLabel leaves a short label untouched', () => {
  assert.equal(truncateLabel('Song', 40), 'Song');
});

test('truncateLabel truncates a long label with an ellipsis', () => {
  assert.equal(truncateLabel('abcdefghij', 4), 'abc…');
});

test('truncateLabel on a non-string input treats it as empty', () => {
  assert.equal(truncateLabel(undefined, 10), '');
  assert.equal(truncateLabel(null, 10), '');
});
