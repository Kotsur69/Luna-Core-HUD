// Tests for the functions behind the Media Deck (system volume + media
// playback controller). Zero DOM/process spawning - parseNowPlaying/
// parseVolume/parseVolumeError/truncateLabel are pure, and the volume calls
// (getVolume/setVolume/toggleMute) run against a stubbed runner via their
// deps seam. sampleMedia/sendTransportCommand/MediaSampler spawn a real
// powershell.exe against real GSMTC state and are left to the plan's manual
// verification checklist, same testing boundary gpu.js documents for
// sampleGpu/GpuSampler in its own footer comment.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNowPlaying,
  parseVolume,
  parseVolumeError,
  getVolume,
  setVolume,
  toggleMute,
} = require('../src/media.js');
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

test('parseVolume tolerates a BOM, CRLF and stray lines around the payload', () => {
  const out = '﻿WARNING: something noisy\r\n{"level":30,"muted":true}\r\n\r\n';
  assert.deepEqual(parseVolume(out), { level: 30, muted: true });
});

test('parseVolume returns null for the script error payload', () => {
  assert.equal(parseVolume(JSON.stringify({ error: 'Element not found.' })), null);
});

// ---- parseVolumeError ------------------------------------------------------------

test('parseVolumeError extracts the script-reported message', () => {
  assert.equal(parseVolumeError('{"error":"  Element not found.  "}\r\n'), 'Element not found.');
});

test('parseVolumeError returns null for state, empty or malformed output', () => {
  assert.equal(parseVolumeError(JSON.stringify({ level: 10, muted: false })), null);
  assert.equal(parseVolumeError(''), null);
  assert.equal(parseVolumeError('not json'), null);
  assert.equal(parseVolumeError(JSON.stringify({ error: '' })), null);
});

// ---- toggleMute / getVolume with a stubbed runner -------------------------------

function stubDeps(result) {
  const calls = [];
  const logs = [];
  const runner = async (action, level) => {
    calls.push([action, level]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { deps: { runner, isWindows: true, log: (m) => logs.push(m) }, calls, logs };
}

test('toggleMute returns the parsed state and logs nothing on success', async () => {
  const { deps, calls, logs } = stubDeps({ stdout: '{"level":30,"muted":false}\r\n', error: null });
  assert.deepEqual(await toggleMute(deps), { level: 30, muted: false });
  assert.deepEqual(calls, [['mute', undefined]]);
  assert.deepEqual(logs, []);
});

test('toggleMute resolves null and logs the timeout reason (the laptop bug)', async () => {
  const { deps, logs } = stubDeps({ stdout: '', error: 'timed out after 30000 ms' });
  assert.equal(await toggleMute(deps), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /volume 'mute' failed: timed out after 30000 ms/);
});

test('toggleMute prefers the script-reported error over the exit code', async () => {
  const { deps, logs } = stubDeps({ stdout: '{"error":"Element not found."}', error: 'exit 1: ' });
  assert.equal(await toggleMute(deps), null);
  assert.match(logs[0], /Element not found\./);
});

test('toggleMute logs unparseable output instead of failing silently', async () => {
  const { deps, logs } = stubDeps({ stdout: 'garbage', error: null });
  assert.equal(await toggleMute(deps), null);
  assert.match(logs[0], /unparseable output: "garbage"/);
});

test('toggleMute survives a runner that throws', async () => {
  const { deps, logs } = stubDeps(new Error('spawn powershell.exe ENOENT'));
  assert.equal(await toggleMute(deps), null);
  assert.match(logs[0], /ENOENT/);
});

test('toggleMute shares one in-flight run between overlapping callers', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let runs = 0;
  const deps = {
    isWindows: true,
    log: () => {},
    runner: async () => {
      runs += 1;
      await gate;
      return { stdout: '{"level":5,"muted":true}', error: null };
    },
  };
  const first = toggleMute(deps);
  const second = toggleMute(deps);
  release();
  assert.deepEqual(await first, { level: 5, muted: true });
  assert.deepEqual(await second, { level: 5, muted: true });
  assert.equal(runs, 1);
  // Once settled, the next toggle runs again.
  await toggleMute(deps);
  assert.equal(runs, 2);
});

test('toggleMute resolves null without running anything off Windows', async () => {
  const { deps, calls } = stubDeps({ stdout: '{"level":1,"muted":false}', error: null });
  assert.equal(await toggleMute({ ...deps, isWindows: false }), null);
  assert.deepEqual(calls, []);
});

test('getVolume and setVolume pass action and clamped level to the runner', async () => {
  const { deps, calls } = stubDeps({ stdout: '{"level":100,"muted":false}', error: null });
  assert.deepEqual(await getVolume(deps), { level: 100, muted: false });
  assert.deepEqual(await setVolume(250, deps), { level: 100, muted: false });
  assert.deepEqual(calls, [
    ['get', undefined],
    ['set', 100],
  ]);
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
