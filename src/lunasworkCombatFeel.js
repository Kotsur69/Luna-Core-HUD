// ============================================================================
// LunaCore - Luna's Work combat-feel summary (Unity playtests)
// ----------------------------------------------------------------------------
// A screenshot cannot show whether hit-stop, the time-scale owner or a parry
// window feel responsive. A game that keeps a combatFeelLog ring buffer in
// its PlaytestDriver state (helpers/playtest-bridge/combatFeelLog.js) gets a
// capped, quantitative summary instead: count / min / median / p95 / max per
// metric, the Time.timeScale transitions, and the out-of-spec values. The
// Playtester's report carries it (report.combatFeel) and the Critic reads it.
//
// Pure: no IO. The log is parsed again here, so a raw one is safe too.
// ============================================================================

'use strict';

const { parseCombatFeelLog } = require('../helpers/playtest-bridge/combatFeelLog');

// Input press -> hitbox active above this reads as sluggish.
const MAX_INPUT_LATENCY_MS = 100;
// Hit-stop may miss its intended length by this many frames.
const HIT_STOP_TOLERANCE_FRAMES = 1;
// Hitbox active -> VFX spawned further apart than this reads as out of sync.
const MAX_HITBOX_TO_VFX_FRAMES = 2;
const MAX_TRANSITIONS = 20;
const MAX_FLAGS = 20;
const MAX_SUMMARY_CHARS = 2000;
const TRUNCATED = '\n(truncated)';

/** metric key -> its label and unit in the text. */
const METRICS = Object.freeze([
  ['hitStopFrames', 'hit-stop', 'frames'],
  ['hitStopMs', 'hit-stop', 'ms'],
  ['inputLatencyMs', 'input -> hitbox', 'ms'],
  ['hitboxToVfxFrames', 'hitbox -> VFX', 'frames'],
]);

const round = (v) => Math.round(v * 100) / 100;

/** Nearest-rank percentile of a sorted, non-empty list. */
function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** {count, min, median, p95, max} of the values, or null when there are none. */
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** The out-of-spec findings of one entry (its index in the log). */
function entryFlags(entry, index) {
  const flags = [];
  if (entry.inputLatencyMs !== undefined && entry.inputLatencyMs > MAX_INPUT_LATENCY_MS) {
    flags.push(`#${index}: input -> hitbox ${round(entry.inputLatencyMs)} ms > ${MAX_INPUT_LATENCY_MS} ms`);
  }
  if (entry.hitStopFrames !== undefined && entry.hitStopIntendedFrames !== undefined
    && Math.abs(entry.hitStopFrames - entry.hitStopIntendedFrames) > HIT_STOP_TOLERANCE_FRAMES) {
    flags.push(`#${index}: hit-stop ${entry.hitStopFrames} frames, intended ${entry.hitStopIntendedFrames}`);
  }
  if (entry.hitboxToVfxFrames !== undefined && Math.abs(entry.hitboxToVfxFrames) > MAX_HITBOX_TO_VFX_FRAMES) {
    flags.push(`#${index}: hitbox -> VFX ${entry.hitboxToVfxFrames} frames (limit +-${MAX_HITBOX_TO_VFX_FRAMES})`);
  }
  return flags;
}

const transitionText = (t) => `${t.atMs} ms: ${t.from} -> ${t.to}${t.reason ? ` (${t.reason})` : ''}`;
const countLabel = (total, shown) => (total > shown ? `${total}, first ${shown}` : `${total}`);

/** The summary as bounded text. */
function summaryText({ entries, metrics, transitions, transitionCount, flags, flagCount }) {
  // "#n" in the flags = the n-th kept sample, oldest first (malformed ones are not counted).
  const lines = [`combatFeelLog: ${entries} entries (#0 = oldest kept sample)`];
  for (const [key, label, unit] of METRICS) {
    const s = metrics[key];
    if (s) lines.push(`- ${label} (${unit}): n=${s.count} min=${s.min} median=${s.median} p95=${s.p95} max=${s.max}`);
  }
  if (transitionCount) {
    lines.push(`Time.timeScale transitions (${countLabel(transitionCount, transitions.length)}):`);
    lines.push(...transitions.map((t) => `- ${transitionText(t)}`));
  }
  lines.push(flagCount ? `Out of spec (${countLabel(flagCount, flags.length)}):` : 'Out of spec: none');
  lines.push(...flags.map((f) => `- ${f}`));
  const text = lines.join('\n');
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - TRUNCATED.length)}${TRUNCATED}` : text;
}

/**
 * The summary of a combatFeelLog.
 * @param {unknown} log the log array (raw or already parsed)
 * @returns {{entries:number, metrics:Record<string, object|null>, transitions:object[],
 *   transitionCount:number, flags:string[], flagCount:number, text:string}|null}
 *   null when there is no usable entry - the report stays as it was
 */
function summarizeCombatFeel(log) {
  const entries = parseCombatFeelLog({ combatFeelLog: log });
  if (!entries || !entries.length) return null;
  const metrics = {};
  for (const [key] of METRICS) {
    metrics[key] = stats(entries.map((e) => e[key]).filter((v) => v !== undefined));
  }
  const allTransitions = entries.map((e) => e.timeScale).filter(Boolean);
  const allFlags = entries.flatMap(entryFlags);
  const summary = {
    entries: entries.length,
    metrics,
    transitions: allTransitions.slice(0, MAX_TRANSITIONS),
    transitionCount: allTransitions.length,
    flags: allFlags.slice(0, MAX_FLAGS),
    flagCount: allFlags.length,
  };
  return { ...summary, text: summaryText(summary) };
}

module.exports = {
  MAX_INPUT_LATENCY_MS,
  HIT_STOP_TOLERANCE_FRAMES,
  MAX_HITBOX_TO_VFX_FRAMES,
  MAX_TRANSITIONS,
  MAX_FLAGS,
  MAX_SUMMARY_CHARS,
  summarizeCombatFeel,
};
