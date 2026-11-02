#!/usr/bin/env node
/**
 * Procedurally synthesizes the four UI sound cues in helpers/sounds/sfx/:
 * nav-click, mode-toggle, terminal-new, terminal-close.
 *
 * No dependencies: raw PCM + envelope math, written as 16-bit mono WAV at
 * 44.1 kHz (the same format as the other sfx files). Output is deterministic
 * (seeded noise), so re-running produces byte-identical files.
 *
 * Usage: node scripts/gen-ui-sounds.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const OUT_DIR = path.join(__dirname, '..', 'helpers', 'sounds', 'sfx');
const FADE_IN_MS = 2;
const FADE_OUT_MS = 10;

/** Deterministic LCG noise in [-1, 1]. */
function makeNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

/** A decaying sine partial starting at `startMs`. */
function tone({ freq, startMs = 0, decayMs, gain = 1 }) {
  const start = (startMs / 1000) * SAMPLE_RATE;
  return (i) => {
    if (i < start) return 0;
    const t = (i - start) / SAMPLE_RATE;
    return gain * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / (decayMs / 1000));
  };
}

/** Short noise burst, used as the "tick" transient of the nav click. */
function noiseBurst({ decayMs, gain, seed }) {
  const noise = makeNoise(seed);
  return (i) => gain * noise() * Math.exp(-i / SAMPLE_RATE / (decayMs / 1000));
}

/** Sums partials, applies raised-cosine fades and normalizes to `peak`. */
function render(durationMs, partials, peak) {
  const n = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeIn = Math.round((FADE_IN_MS / 1000) * SAMPLE_RATE);
  const fadeOut = Math.round((FADE_OUT_MS / 1000) * SAMPLE_RATE);
  // Partials are evaluated in sample order (the noise burst is stateful).
  const raw = Array.from({ length: n }, (_, i) => {
    const sum = partials.reduce((acc, p) => acc + p(i), 0);
    const inGain = i < fadeIn ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn) : 1;
    const left = n - 1 - i;
    const outGain = left < fadeOut ? 0.5 - 0.5 * Math.cos((Math.PI * left) / fadeOut) : 1;
    return sum * inGain * outGain;
  });
  const max = raw.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  return raw.map((v) => (v / max) * peak);
}

/** Encodes float samples in [-1, 1] as a 16-bit mono PCM WAV buffer. */
function encodeWav(samples) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  samples.forEach((v, i) => {
    const clamped = Math.max(-1, Math.min(1, v));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  });
  return buf;
}

// Each builder returns fresh partials, so the stateful noise restarts per render.
const SOUNDS = {
  // ~30 ms soft tick: damped high sine plus a tiny noise transient.
  'nav-click': () =>
    render(30, [
      tone({ freq: 1900, decayMs: 6 }),
      tone({ freq: 3800, decayMs: 3, gain: 0.25 }),
      noiseBurst({ decayMs: 1.5, gain: 0.3, seed: 7 }),
    ], 0.3),

  // ~80 ms two-tone up blip: A5 then E6.
  'mode-toggle': () =>
    render(80, [
      tone({ freq: 880, decayMs: 14 }),
      tone({ freq: 1318.5, startMs: 36, decayMs: 18 }),
    ], 0.32),

  // ~150 ms soft rising chime: G5 -> D6, each with a quiet octave partial.
  'terminal-new': () =>
    render(150, [
      tone({ freq: 784, decayMs: 40 }),
      tone({ freq: 1568, decayMs: 20, gain: 0.15 }),
      tone({ freq: 1174.7, startMs: 55, decayMs: 45 }),
      tone({ freq: 2349.3, startMs: 55, decayMs: 22, gain: 0.15 }),
    ], 0.35),

  // ~150 ms soft falling chime: D6 -> G5 (mirror of terminal-new).
  'terminal-close': () =>
    render(150, [
      tone({ freq: 1174.7, decayMs: 40 }),
      tone({ freq: 2349.3, decayMs: 20, gain: 0.15 }),
      tone({ freq: 784, startMs: 55, decayMs: 45 }),
      tone({ freq: 1568, startMs: 55, decayMs: 22, gain: 0.15 }),
    ], 0.35),
};

function main() {
  Object.entries(SOUNDS).forEach(([name, build]) => {
    const file = path.join(OUT_DIR, `${name}.wav`);
    const wav = encodeWav(build());
    fs.writeFileSync(file, wav);
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)} (${wav.length} bytes)\n`);
  });
}

if (require.main === module) main();

module.exports = { SOUNDS, encodeWav, render, SAMPLE_RATE };
