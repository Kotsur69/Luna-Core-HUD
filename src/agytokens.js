// ============================================================================
// LunaCore - real token counts of one agy conversation, per model (pure)
// ----------------------------------------------------------------------------
// Since agy 1.5.12 every PLANNER_RESPONSE step logs the model that wrote it
// and its token counts (input_tokens excludes cache reads; agy's own total is
// input + output + cache_read). This book sums them per model, in the shape
// observer.js' TranscriptWatcher reports as metrics.byModel
// ({<model id>: {input, output, cacheRead, cacheWrite}}), so God Mode can book
// an agy worker tab like a Claude one (orchestraUsage.js usageFromTranscript).
//
//   * A step is identified by (step_index, type, created_at). agy logs a step
//     again when its status moves on: the newer counts replace the older ones,
//     so a step is never counted twice. A step with neither an index nor a
//     time cannot be told apart from another and is counted as it comes.
//   * agy logs no cache writes: cacheWrite is always 0.
//   * No price: nothing here knows what a Gemini token costs, and nothing
//     downstream may invent it (orchestraUsage.js books tab usage at cost 0).
// ============================================================================

'use strict';

const { AGY_MODEL } = require('./claudeModels');

/** Steps remembered for de-duplication; an older step logged again past this is counted again. */
const MAX_BOOKED_STEPS = 16384;
/** Models one conversation reports at most (orchestraUsage.js keeps 24). */
const MAX_USAGE_MODELS = 24;
/** The key a step with no model of its own (and none named before it) is booked under. */
const UNKNOWN_AGY_MODEL = AGY_MODEL;

/** A model id usable as a plain object key (orchestraUsage.js' modelKey rule): never __proto__ and friends. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const modelIdOf = (model) => (typeof model === 'string' && MODEL_ID_RE.test(model) ? model : UNKNOWN_AGY_MODEL);

const USAGE_KEYS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * The per-model totals of a list of byModel objects, summed. Pure: the inputs
 * are never changed.
 * @param {Array<Record<string, {input:number, output:number, cacheRead:number, cacheWrite:number}>>} parts
 * @returns {Record<string, {input:number, output:number, cacheRead:number, cacheWrite:number}>}
 */
function sumAgyByModel(parts) {
  const out = {};
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue;
    for (const [model, numbers] of Object.entries(part)) {
      if (!numbers || typeof numbers !== 'object' || !MODEL_ID_RE.test(model)) continue;
      const prev = out[model] || zeroUsage();
      out[model] = Object.fromEntries(USAGE_KEYS.map((k) => [k, prev[k] + (Number(numbers[k]) || 0)]));
    }
  }
  return out;
}

/**
 * Per model and per field, the larger of two byModel objects. For a reader
 * catching up on a conversation another reader already counted: until it has
 * read as far, its totals are below the old ones, and a total that drops reads
 * as a transcript that started over (orchestraUsage.js banks it, then counts
 * everything again on top).
 * @returns {Record<string, {input:number, output:number, cacheRead:number, cacheWrite:number}>}
 */
function maxAgyByModel(a, b) {
  const out = sumAgyByModel([a]);
  for (const [model, numbers] of Object.entries(sumAgyByModel([b]))) {
    const prev = out[model] || zeroUsage();
    out[model] = Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.max(prev[k], numbers[k])]));
  }
  return out;
}

class AgyUsageBook {
  constructor() {
    /** model id -> {input, output, cacheRead, cacheWrite} */
    this.totals = new Map();
    /** step key -> {model, usage} as booked, oldest first. */
    this.booked = new Map();
  }

  /**
   * Books one planner step's counts. A step booked before has its old counts
   * taken back first, so only its newest version counts.
   * @param {{index:number|null, type:string, at:number|null,
   *   usage:{input:number, cacheRead:number, output:number}|null}} step
   * @param {string} model the model id the step ran on ('' or unusable = unknown)
   * @returns {boolean} true when the totals changed
   */
  book(step, model) {
    if (!step || step.type !== 'PLANNER_RESPONSE' || !step.usage) return false;
    const key = step.index === null && step.at === null ? null : `${step.index}|${step.type}|${step.at}`;
    const entry = { model: modelIdOf(model), usage: { ...step.usage } };
    const prev = key === null ? null : this.booked.get(key);
    if (prev && prev.model === entry.model && sameCounts(prev.usage, entry.usage)) return false;
    if (!prev && !this.totals.has(entry.model) && this.totals.size >= MAX_USAGE_MODELS) return false;
    if (prev) this.move(prev, -1);
    this.move(entry, 1);
    if (key !== null) this.remember(key, entry);
    return true;
  }

  /** Adds (sign 1) or takes back (sign -1) one step's counts. */
  move({ model, usage }, sign) {
    const prev = this.totals.get(model) || zeroUsage();
    this.totals.set(model, {
      input: Math.max(0, prev.input + sign * usage.input),
      output: Math.max(0, prev.output + sign * usage.output),
      cacheRead: Math.max(0, prev.cacheRead + sign * usage.cacheRead),
      cacheWrite: 0,
    });
  }

  remember(key, entry) {
    this.booked.delete(key); // re-inserted: the map's order stays oldest-first
    this.booked.set(key, entry);
    if (this.booked.size > MAX_BOOKED_STEPS) this.booked.delete(this.booked.keys().next().value);
  }

  /** @returns {Record<string, {input:number, output:number, cacheRead:number, cacheWrite:number}>} a copy */
  byModel() {
    return Object.fromEntries([...this.totals].map(([model, t]) => [model, { ...t }]));
  }

  /** A copy that keeps counting where this one is: what it booked stays booked. */
  clone() {
    const next = new AgyUsageBook();
    for (const [model, t] of this.totals) next.totals.set(model, { ...t });
    for (const [key, entry] of this.booked) next.booked.set(key, { model: entry.model, usage: { ...entry.usage } });
    return next;
  }
}

function sameCounts(a, b) {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead;
}

module.exports = { AgyUsageBook, sumAgyByModel, maxAgyByModel, UNKNOWN_AGY_MODEL, MAX_BOOKED_STEPS };
