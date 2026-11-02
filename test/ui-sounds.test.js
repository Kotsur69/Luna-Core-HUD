'use strict';

// Guards the four procedurally generated UI cues (scripts/gen-ui-sounds.js):
// they must be real, short, unclipped 16-bit mono WAVs, not 0-byte stubs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SFX_DIR = path.join(__dirname, '..', 'helpers', 'sounds', 'sfx');
const NAMES = ['nav-click', 'mode-toggle', 'terminal-new', 'terminal-close'];
const MAX_MS = 200;
const CLIP_LIMIT = 32767 * 0.99;

function parseWav(buf) {
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(buf.readUInt16LE(20), 1, 'PCM');
  assert.strictEqual(buf.readUInt16LE(22), 1, 'mono');
  assert.strictEqual(buf.readUInt16LE(34), 16, '16-bit');
  assert.strictEqual(buf.toString('ascii', 36, 40), 'data');
  const sampleRate = buf.readUInt32LE(24);
  const dataSize = buf.readUInt32LE(40);
  assert.strictEqual(buf.length, 44 + dataSize, 'data chunk matches file size');
  const count = dataSize / 2;
  const peak = Array.from({ length: count }, (_, i) => Math.abs(buf.readInt16LE(44 + i * 2)))
    .reduce((m, v) => Math.max(m, v), 0);
  return { sampleRate, durationMs: (count / sampleRate) * 1000, peak };
}

for (const name of NAMES) {
  test(`${name}.wav is a valid, short, unclipped WAV`, () => {
    const buf = fs.readFileSync(path.join(SFX_DIR, `${name}.wav`));
    assert.ok(buf.length > 44, 'not an empty stub');
    const { sampleRate, durationMs, peak } = parseWav(buf);
    assert.strictEqual(sampleRate, 44100);
    assert.ok(durationMs > 0 && durationMs < MAX_MS, `duration ${durationMs}ms`);
    assert.ok(peak > 0, 'not silent');
    assert.ok(peak < CLIP_LIMIT, `peak ${peak} clips`);
  });
}

test('generator output matches the committed files', () => {
  const { SOUNDS, encodeWav } = require('../scripts/gen-ui-sounds.js');
  for (const name of NAMES) {
    const committed = fs.readFileSync(path.join(SFX_DIR, `${name}.wav`));
    assert.ok(encodeWav(SOUNDS[name]()).equals(committed), `${name}.wav is stale`);
  }
});
