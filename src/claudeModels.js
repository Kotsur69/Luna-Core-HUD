// ============================================================================
// LunaCore - the Claude CLI model aliases Mati can pick (pure, no requires)
// ----------------------------------------------------------------------------
// One list for every "which Claude model" choice that ends up as the value of
// a `claude --model <alias>` flag: God Mode's planner / worker / card model
// and Luna's Work's role models. Each caller keeps its own allow-list (some
// add 'plan' or 'auto', some leave haiku out) but builds it from here, so a
// new alias is added in one place.
//
//   CLAUDE_MODELS   weakest -> strongest
//   MODEL_RANK      alias -> its place in that order (for "strongest of")
//   MODEL_LABELS    alias -> the name shown in the UI
//
// The renderer cannot require main-side modules: its copies
// (src/renderer/modules/orchestraPick.js, orchestrasettings.js, the Luna's
// Work panels) are kept in line by hand and by test/claude-models.test.js.
// ============================================================================

'use strict';

const CLAUDE_MODELS = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

const MODEL_RANK = Object.freeze(Object.fromEntries(CLAUDE_MODELS.map((m, i) => [m, i])));

const MODEL_LABELS = Object.freeze({ haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' });

// Not a Claude model: the Antigravity CLI (`agy`, src/launch.js isAgyCommand)
// as a worker choice. It belongs in lists of where a worker RUNS (God Mode's
// worker model, a task card's model) and never in CLAUDE_MODELS, so no
// `claude --model` flag ever carries it.
const AGY_MODEL = 'agy';

/** Every model a worker-model choice list may hold: the Claude aliases plus agy. */
const WORKER_MODEL_CHOICES = Object.freeze([...CLAUDE_MODELS, AGY_MODEL]);

/** True for one of the aliases above. */
function isClaudeModel(model) {
  return CLAUDE_MODELS.includes(model);
}

/** True for a Claude alias or agy: a valid worker-model choice. */
function isWorkerModelChoice(model) {
  return WORKER_MODEL_CHOICES.includes(model);
}

/**
 * The stronger of two aliases; an unknown one loses, two unknown give null.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {string|null}
 */
function strongerModel(a, b) {
  const known = [a, b].filter(isClaudeModel);
  if (!known.length) return null;
  return known.reduce((best, m) => (MODEL_RANK[m] > MODEL_RANK[best] ? m : best));
}

module.exports = {
  CLAUDE_MODELS,
  MODEL_RANK,
  MODEL_LABELS,
  AGY_MODEL,
  WORKER_MODEL_CHOICES,
  isClaudeModel,
  isWorkerModelChoice,
  strongerModel,
};
