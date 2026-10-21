// ============================================================================
// LunaCore - Life dashboard: productivity score settings (main process)
// ----------------------------------------------------------------------------
// config/life-score.local.json:
//   {v: 1, weights: {focus, shipping, goals, health}, focusTargetH}
// The weights are saved normalised to whole numbers summing to 100 (the
// Settings sliders send any non-negative numbers; at least one above 0).
// focusTargetH = the daily focus target in hours (default 6).
// Persistence and the read/write contract: src/lifestore.js.
// ============================================================================

'use strict';

const { createStore } = require('./lifestore');

const PARTS = ['focus', 'shipping', 'goals', 'health'];
const DEFAULT_TARGET_H = 6;
const MIN_TARGET_H = 0.5;
const MAX_TARGET_H = 16;
const MAX_WEIGHT = 1000;

const defaultWeights = () => Object.fromEntries(PARTS.map((k) => [k, 100 / PARTS.length]));
const defaults = () => ({ v: 1, weights: defaultWeights(), focusTargetH: DEFAULT_TARGET_H });

const validWeight = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_WEIGHT;
const validTarget = (v) => typeof v === 'number' && v >= MIN_TARGET_H && v <= MAX_TARGET_H && Number.isInteger(v * 2);

/** Whole-number weights summing to exactly 100 (largest remainder); null if all are 0 or any is invalid. */
function normalizeWeights(raw) {
  if (!raw || typeof raw !== 'object' || !PARTS.every((k) => validWeight(raw[k]))) return null;
  const total = PARTS.reduce((s, k) => s + raw[k], 0);
  if (!(total > 0)) return null;
  const exact = PARTS.map((k) => (raw[k] / total) * 100);
  const out = exact.map(Math.floor);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let n = 100 - out.reduce((s, v) => s + v, 0), j = 0; n > 0; n--, j++) out[order[j][1]] += 1;
  return Object.fromEntries(PARTS.map((k, i) => [k, out[i]]));
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    v: 1,
    weights: normalizeWeights(src.weights) || defaultWeights(),
    focusTargetH: validTarget(src.focusTargetH) ? src.focusTargetH : DEFAULT_TARGET_H,
  };
}

const store = createStore({ fileName: 'life-score.local.json', defaults, normalize });

const loadScorePrefs = (file) => store.load(file);

/** Throws 'bad value' unless every weight and the target are valid. */
function setScorePrefs(data, file) {
  const weights = normalizeWeights(data && data.weights);
  if (!weights || !validTarget(data.focusTargetH)) throw new Error('bad value');
  return store.update(() => ({ v: 1, weights, focusTargetH: data.focusTargetH }), file);
}

module.exports = { loadScorePrefs, setScorePrefs, normalizeWeights, PARTS, DEFAULT_TARGET_H };
