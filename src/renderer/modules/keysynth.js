// ============================================================================
// LunaCore - keystroke/agent-stream acoustic engine (Web Audio API)
// ----------------------------------------------------------------------------
// Keystrokes play real recorded samples (assets/keysounds/, see
// CONCEPT_TYPING_SYNTH.md's follow-up: nathan-fiscaletti/keyboardsounds was
// the reference for "randomize pitch per hit from a sample pack" - a single
// oscillator tone reads as generic no matter how it's modulated).
// Agent-stream stays a pure synth texture (out of scope - see keystroke sound
// bug memory: only the keystroke click itself was reported as "generic").
//
// A mouse-click sound (from the same sample pool as atm/secretcode/
// securitycode below) existed briefly on 2026-08-26 and was removed the same
// day - Mati found firing on every click across the HUD "kinda annoying
// quickly." Those 3 files stayed - repurposed as 3 more keyboard variants.
//
// No IPC hop for any of this: decode + slice + playback all happen right here
// in the renderer via native decodeAudioData(), same reasoning as the original
// keysynth.js had for keystrokes - see reference/TYPING_SYNTH_PLAN.md.
// ============================================================================

'use strict';

let ctx = null;
let enabled = true;
let masterVolume = 0.7; // 0..1 - mirrors uiprefs.soundVolume/100
let variant = 'mechanical';

let lastUserTs = 0;
let lastAgentTs = 0;
let lastAgentPlayTs = 0;
let lastUserSampleIdx = -1;

// Floor between two agent-stream blips - Claude's stdout can arrive in a
// tight loop of tiny chunks, and without a floor that reads as white noise
// rather than a "data flowing" texture.
const AGENT_MIN_GAP_MS = 45;

// Keystroke pitch jitter on top of the WPM-driven base rate - real key hits
// on the same physical key still vary a little take to take.
const USER_JITTER = 0.08;

/** Lazily creates the single AudioContext - must happen on a user gesture
 * (a real keypress qualifies) or Chromium's autoplay policy leaves it
 * suspended forever. */
function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Source recordings are mastered for ambience, not transient punch - their
// peaks sit well under full scale (unlike an oscillator, which is always
// +-1). Without this every sample plays back "barely audible" no matter how
// high the gain/volume slider goes, since gain only ever scales *down* from
// the buffer's own peak.
const TARGET_PEAK = 0.95;

function normalizeBuffer(buffer, targetPeak = TARGET_PEAK) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak < 0.001 || peak >= targetPeak) return buffer; // silence, or already loud enough
  const scale = targetPeak / peak;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
  return buffer;
}

export function setEnabled(v) {
  enabled = !!v;
}

export function setVolume(pct) {
  masterVolume = clamp(Number(pct) || 0, 0, 100) / 100;
}

export function setVariant(id) {
  if (KEYBOARD_PACKS[id]) {
    variant = id;
    loadPack(KEYBOARD_PACKS[id]); // prime it - see preloadCurrentVariant()
  }
}

// Multi-hit recordings, sliced into individual hits on first use. Bare
// filenames, not paths/URLs: the renderer's CSP (connect-src 'none', D4 in
// index.html) blocks fetch() outright, so these bytes come from the main
// process over IPC (window.lunacore.readKeysound(), preload.js) instead -
// see main.js's 'keysynth:read' handler, which resolves inside
// assets/keysounds/ itself.
const KEYBOARD_PACKS = {
  mechanical: 'mechanical.mp3',
  soft: 'soft.mp3',
  scifi: 'scifi.mp3',
  typewriter: 'typewriter.wav',
  atm: 'atm.wav',
  secretcode: 'secretcode.wav',
  securitycode: 'securitycode.wav',
};

const packCache = new Map(); // name -> Promise<AudioBuffer[]> (sliced hits)

// ---- Onset slicing -----------------------------------------------------

const WINDOW_MS = 3;
// Debounce between onsets, not a hit-duration filter: measuring "how long
// before it fell silent" rejected real hits outright on crisp/percussive
// recordings (typewriter.wav, soft.mp3) where the whole audible transient is
// under 15ms - the pack ended up with zero valid hits and silently fell back
// to replaying the entire multi-second source file from t=0 on every
// keystroke (see keysynth-loudness follow-up, 2026-08-26). Grabbing a fixed
// window after each onset instead has no such failure mode.
const MIN_ONSET_GAP_MS = 50;
const HIT_LENGTH_MS = 140;
const TAIL_FADE_MS = 8;
const MAX_HITS_PER_PACK = 60;

/** Slices one continuous multi-keystroke recording into individual hit
 * AudioBuffers: find each onset (a short-window RMS envelope crossing above
 * an adaptive noise floor, debounced so one hit's own decay ripple can't
 * re-trigger), then grab a fixed-length chunk starting there - truncated
 * early if another onset is coming up, so two hits never bleed together. */
function sliceHits(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const windowLen = Math.max(1, Math.round((WINDOW_MS / 1000) * sr));
  const windowCount = Math.ceil(data.length / windowLen);

  const rms = new Float32Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowLen;
    const end = Math.min(data.length, start + windowLen);
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    rms[w] = Math.sqrt(sum / (end - start));
  }

  const sorted = Float32Array.from(rms).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const threshold = Math.max(noiseFloor * 4, 0.015);

  const minGapWindows = Math.ceil(MIN_ONSET_GAP_MS / WINDOW_MS);
  const onsetWindows = [];
  let lastOnset = -Infinity;
  for (let w = 0; w < windowCount; w++) {
    const rising = w === 0 || rms[w - 1] <= threshold;
    if (rms[w] > threshold && rising && w - lastOnset >= minGapWindows) {
      onsetWindows.push(w);
      lastOnset = w;
    }
  }

  const preRollSamples = Math.round(0.003 * sr);
  const hitLenSamples = Math.round((HIT_LENGTH_MS / 1000) * sr);
  const fadeSamples = Math.round((TAIL_FADE_MS / 1000) * sr);
  const channels = buffer.numberOfChannels;

  const hits = [];
  for (let n = 0; n < onsetWindows.length; n++) {
    const onsetSample = onsetWindows[n] * windowLen;
    const nextOnsetSample =
      n + 1 < onsetWindows.length ? onsetWindows[n + 1] * windowLen : data.length;

    const start = Math.max(0, onsetSample - preRollSamples);
    const end = Math.min(data.length, start + hitLenSamples, nextOnsetSample);
    const length = end - start;
    if (length <= 0) continue;

    const out = audioCtx().createBuffer(channels, length, sr);
    const fade = Math.min(length, fadeSamples);
    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        let s = src[start + i] || 0;
        const distFromEnd = length - i;
        if (distFromEnd <= fade) s *= distFromEnd / fade;
        dst[i] = s;
      }
    }
    hits.push(normalizeBuffer(out));
    if (hits.length >= MAX_HITS_PER_PACK) break;
  }
  return hits;
}

/** Bytes of one assets/keysounds/ file via the main process (see the CSP
 * note above KEYBOARD_PACKS) - readKeysound() resolves to a Uint8Array, or
 * null if the file is missing. */
async function readArrayBuffer(name) {
  const bytes = await window.lunacore.readKeysound(name);
  if (!bytes) throw new Error(`keysynth: ${name} not found`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function decodePack(name) {
  const arrayBuffer = await readArrayBuffer(name);
  const buffer = await audioCtx().decodeAudioData(arrayBuffer);
  const hits = sliceHits(buffer);
  return hits.length ? hits : [normalizeBuffer(buffer)]; // fall back to the whole clip if slicing found nothing usable
}

function loadPack(name) {
  if (!packCache.has(name)) {
    packCache.set(
      name,
      decodePack(name).catch((err) => {
        console.error('[keysynth] failed to load keyboard pack', err);
        return [];
      })
    );
  }
  return packCache.get(name);
}

/** Called once at startup (termcustom.js's init) so the current variant's
 * pack is already decoded and sliced by the time the user's first real
 * keystroke lands - decode+slice of a 20-30s recording is real work, not
 * something to do for the first time on the critical path of a keypress. */
export function preloadCurrentVariant() {
  loadPack(KEYBOARD_PACKS[variant]);
}

/** Random pick that avoids repeating the same sample twice in a row (once
 * there's more than one to choose from). `lastIdx` is passed by the caller
 * and returned updated, since this module has no per-pool state to close
 * over generically. */
function pickHit(hits, lastIdx) {
  if (hits.length === 0) return [null, lastIdx];
  if (hits.length === 1) return [hits[0], 0];
  let idx = Math.floor(Math.random() * hits.length);
  if (idx === lastIdx) idx = (idx + 1) % hits.length;
  return [hits[idx], idx];
}

/** Plays one AudioBufferSourceNode through a gain envelope at the given
 * playback rate (pitch). */
function playSample(buffer, { rate, gain }) {
  const c = audioCtx();
  const t0 = c.currentTime;

  const src = c.createBufferSource();
  const g = c.createGain();

  src.buffer = buffer;
  src.playbackRate.value = rate;

  const peak = clamp(gain * masterVolume, 0, 1);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.002);

  src.connect(g);
  g.connect(c.destination);
  src.start(t0);
}

/**
 * Call for one confirmed real keystroke (terminals.js's onData, gated to
 * length-1 chunks - reference/TYPING_SYNTH_PLAN.md settled that real typing
 * is never anything else).
 *
 * Base pitch tracks typing speed (the interval since the last call, same
 * "acoustic acceleration" as before), with random jitter layered on top so
 * repeated keys at the same speed still vary - and a random (non-repeating)
 * sample is picked from the pack's sliced hit pool each press, instead of
 * one oscillator tone every time.
 */
export function userKeystroke() {
  if (!enabled) return;
  const now = performance.now();
  const interval = now - lastUserTs;
  lastUserTs = now;

  const url = KEYBOARD_PACKS[variant] || KEYBOARD_PACKS.mechanical;
  const cached = packCache.get(url);
  if (!cached) {
    loadPack(url); // not ready yet (e.g. variant just switched) - skip this one hit
    return;
  }
  cached.then((hits) => {
    const [hit, idx] = pickHit(hits, lastUserSampleIdx);
    lastUserSampleIdx = idx;
    if (!hit) return;

    const speed = clamp(1 - interval / 220, 0, 1); // 0 = slow/first key, 1 = fast burst
    const basePitch = 0.9 + speed * 0.25;
    const jitter = 1 + (Math.random() * 2 - 1) * USER_JITTER;

    playSample(hit, { rate: clamp(basePitch * jitter, 0.6, 1.8), gain: 0.85 });
  });
}

// ---- Agent stream (unchanged - pure synth, out of scope) ----------------

const AGENT_VARIANT = { osc: 'triangle', filter: 'bandpass', freq: 1000, q: 8 };

function blip({ pitchHz, decayMs, gain, osc, filterType, filterFreq, filterQ }) {
  const c = audioCtx();
  const t0 = c.currentTime;

  const o = c.createOscillator();
  const f = c.createBiquadFilter();
  const g = c.createGain();

  o.type = osc;
  o.frequency.setValueAtTime(pitchHz, t0);

  f.type = filterType;
  f.frequency.setValueAtTime(filterFreq, t0);
  f.Q.setValueAtTime(filterQ, t0);

  const peak = clamp(gain * masterVolume, 0, 1);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decayMs / 1000);

  o.connect(f);
  f.connect(g);
  g.connect(c.destination);

  o.start(t0);
  o.stop(t0 + decayMs / 1000 + 0.02);
}

/**
 * Call from the ACTIVE session's stdout handler only (sessions.js) - a
 * background tab already has no visible/audible surface, same reasoning
 * markWorking() vs markBucketWorking() already follows for the LED.
 *
 * Renders Claude's output stream as a cascading, pitch-shifting texture
 * scaled by bytes/ms, rather than one discrete click per chunk.
 */
export function agentStream(chunkLen = 1) {
  if (!enabled) return;
  const now = performance.now();
  const interval = clamp(now - lastAgentTs, 1, 500);
  lastAgentTs = now;
  if (now - lastAgentPlayTs < AGENT_MIN_GAP_MS) return;
  lastAgentPlayTs = now;

  const rate = clamp(chunkLen / interval, 0, 4); // bytes/ms - how hard it's streaming

  blip({
    pitchHz: 500 + rate * 900,
    decayMs: 35 + rate * 15,
    gain: clamp(0.25 + rate * 0.15, 0, 0.55),
    osc: AGENT_VARIANT.osc,
    filterType: AGENT_VARIANT.filter,
    filterFreq: 1000 + rate * 2000,
    filterQ: AGENT_VARIANT.q,
  });
}
