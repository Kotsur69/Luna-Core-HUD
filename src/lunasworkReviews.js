// ============================================================================
// LunaCore - Luna's Work scheduled specialist reviews (docs/LUNAS_WORK_PLAN.md,
// idea #7, slice 2.15)
// ----------------------------------------------------------------------------
// On a schedule, one headless READ-ONLY `claude -p --json-schema` call per due
// review runs an ECC specialist agent over the iteration's diff and the repo:
//   - security     every SECURITY_EVERY-th iteration   (ecc:security-reviewer)
//   - performance  every PERFORMANCE_EVERY-th iteration (ecc:performance-optimizer)
//   - cleanup      at each milestone gate               (ecc:refactor-cleaner)
// Read-only: the allowed tools are Read,Grep,Glob; Edit, Write, Bash and
// NotebookEdit are also explicitly disallowed, and --strict-mcp-config loads
// no MCP server (a user's MCP tools could otherwise act on the machine).
//
// The findings go through the Critic's trust boundary (validateCritique in
// src/lunasworkCritic.js): same kinds, severities, caps, and every bug card
// gets a repro test. Cards come back tagged run:<id>, kind:<x>, sev:<x> and
// review:<type>; nothing is written here - the controller files them (e.g.
// via lunasworkCritic.applyCards, which keeps a card's `extraTags`).
//
// Always resolves, never rejects (a throwing injected log / now / pickModel
// included): a failing reviewer yields no cards and one note,
// '<type> review failed: <reason>'.
//
// Exports
//   REVIEW_TYPES      string[]  ['security', 'performance', 'cleanup']
//   REVIEW_AGENTS     {[type]: string}  ECC agent per review type
//   REVIEW_TOOLS      string    'Read,Grep,Glob'
//   REVIEW_SCHEMA     object    JSON schema handed to --json-schema ({cards})
//   reviewsDue(iteration:number, isGate:boolean) -> string[]
//       Pure. The review types due this iteration, in REVIEW_TYPES order.
//   buildReviewArgs({type:string, model?:string, effort?:string, budgetUsd?:number}) -> string[]
//       argv for one headless review call (no shell string; prompt on stdin).
//   buildReviewPrompt({type:string, iteration:number, diff?:string}) -> string
//   reviewCards(raw:unknown, {type:string, runId:string}) -> {cards:object[], warnings:object[], errors:object[]}
//       Pure. The reply validated as Critic cards; each card also gets
//       review:<type>, tags:string[] and extraTags:['review:<type>']. Errors when malformed.
//   runReview(type:string, opts) -> Promise<{type, cards, notes, warnings, costUsd}>
//   runReviews({iteration, isGate, runId, repoPath, diff?, pickModel?, runClaude?, env?,
//       log?, now?, timeoutMs?, budgetUsd?, isDir?}) -> Promise<{due:string[], cards:object[],
//       notes:string[], warnings:object[], costUsd:number|null, durationMs:number}>
//     pickModel(role:'reviewer') -> {model}|string|null    (default: DEFAULT_MODELS.reviewer)
//     runClaude({args, prompt, cwd, env, timeoutMs}) -> Promise<{stdout}|{error, detail?}>
//         (default: lunasworkCritic.execClaude)
//     log(message:string, detail?:unknown) -> void          (default: no-op)
//     now() -> number                                      (default: Date.now)
//     isDir(path:string) -> boolean                        (default: projects.checkCwd's check)
// ============================================================================

'use strict';

const { parsePlannerOutput } = require('./orchestraPlan');
const { checkCwd } = require('./projects');
const { DEFAULT_MODELS } = require('./lunasworkRules');
const { runTag, cleanTags } = require('./todorows');
const { CRITIC_SCHEMA, KINDS, SEVERITIES, validateCritique, execClaude } = require('./lunasworkCritic');

const SECURITY_EVERY = 3;
const PERFORMANCE_EVERY = 5;
const REVIEW_TYPES = ['security', 'performance', 'cleanup'];
const REVIEW_AGENTS = Object.freeze({
  security: 'ecc:security-reviewer',
  performance: 'ecc:performance-optimizer',
  cleanup: 'ecc:refactor-cleaner',
});
// lunasworkRules.ROLES names the role 'reviewer'.
const REVIEW_ROLE = 'reviewer';
// Read-only: a reviewer reports, the Builder fixes.
const REVIEW_TOOLS = 'Read,Grep,Glob';
const REVIEW_DISALLOWED_TOOLS = 'Bash,Edit,Write,NotebookEdit';
const REVIEW_EFFORT = 'medium';
const REVIEW_BUDGET_USD = 1;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIFF_CHARS = 60000;
const MAX_NOTE_CHARS = 300;

const REVIEW_FOCUS = Object.freeze({
  security: 'security vulnerabilities: injection, unsafe input handling, secrets in code, path traversal, unsafe IPC or eval, missing validation at trust boundaries',
  performance: 'performance problems: slow paths, needless work in hot loops, memory growth, blocking I/O on the main thread, render jank',
  cleanup: 'dead code, duplication and leftovers from this milestone that should be removed or consolidated before moving on',
});

// The Critic's card item without updatesCardId / splitsCardId: a reviewer only files new cards.
const CRITIC_CARDS = CRITIC_SCHEMA.properties.cards;
const REVIEW_CARD_PROPS = Object.fromEntries(
  Object.entries(CRITIC_CARDS.items.properties).filter(([key]) => key !== 'updatesCardId' && key !== 'splitsCardId'),
);
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: { ...CRITIC_CARDS, items: { ...CRITIC_CARDS.items, properties: REVIEW_CARD_PROPS } },
  },
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => String(s === undefined || s === null ? '' : s).slice(0, max);
const noop = () => {};

/** An injected logger that throws must not break the never-reject promise. */
const safeLog = (log) => (message, detail) => {
  try {
    log(message, detail);
  } catch {
    // ignored on purpose: logging is best effort
  }
};

/** An injected clock that throws or lies reads as 0. */
const safeNow = (now) => () => {
  try {
    const t = now();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
};

/**
 * Pure schedule. Iterations count from 1; anything else has no review due.
 * @param {number} iteration
 * @param {boolean} isGate this iteration closes a milestone gate
 * @returns {string[]} due review types in REVIEW_TYPES order
 */
function reviewsDue(iteration, isGate) {
  if (!Number.isInteger(iteration) || iteration < 1) return [];
  const due = {
    security: iteration % SECURITY_EVERY === 0,
    performance: iteration % PERFORMANCE_EVERY === 0,
    cleanup: isGate === true,
  };
  return REVIEW_TYPES.filter((t) => due[t]);
}

/** argv for one headless review call - never a shell string; the prompt goes on stdin. */
function buildReviewArgs({ type, model = DEFAULT_MODELS[REVIEW_ROLE], effort = REVIEW_EFFORT, budgetUsd = REVIEW_BUDGET_USD } = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(REVIEW_SCHEMA),
    '--agent', REVIEW_AGENTS[type],
    '--model', model,
    '--effort', effort,
    '--tools', REVIEW_TOOLS,
    '--disallowedTools', REVIEW_DISALLOWED_TOOLS,
    '--strict-mcp-config',
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

/** The review prompt: focus, card rules, then the iteration diff (capped). */
function buildReviewPrompt({ type, iteration, diff }) {
  const full = clip(diff, Infinity);
  const text = full.slice(0, MAX_DIFF_CHARS);
  return [
    `You are the ${type} reviewer of Luna's Work, iteration ${iteration}. Review READ-ONLY: do not change any file.`,
    `Look for ${REVIEW_FOCUS[type]}.`,
    'Start from the diff below, then read the surrounding code in the repo as needed.',
    `Answer ONLY with JSON {"cards": [...]}. Each card: kind (${KINDS.join(' / ')}), severity (${SEVERITIES.join(' / ')}),`,
    'text (one line, what to fix), details (why and where), acceptance (checks that prove it is fixed), files (paths).',
    'A bug card must ask for a repro test first. File only real, specific findings; an empty list is a fine answer.',
    '',
    `## Iteration diff${text.length < full.length ? ' (cut)' : ''}`,
    text || '(no diff given)',
  ].join('\n');
}

/**
 * Validates a reviewer reply through the Critic's validateCritique (caps,
 * kinds, severities, repro tests) and tags each card.
 * @param {unknown} raw model output, {cards:[...]}
 * @param {{type:string, runId:string}} ctx
 * @returns {{cards:object[], warnings:object[], errors:object[]}}
 */
function reviewCards(raw, { type, runId } = {}) {
  const tag = runTag(runId);
  if (!tag) return { cards: [], warnings: [], errors: [{ code: 'badRunId' }] };
  if (!isObj(raw) || !Array.isArray(raw.cards)) return { cards: [], warnings: [], errors: [{ code: 'badReview' }] };
  // A review is no full critique: wrap its cards in an empty one so the Critic's rules apply unchanged.
  const critique = validateCritique(
    { cards: raw.cards, logEntry: {}, architecture: '', decisions: [], newJourneys: [], verdict: 'CONTINUE' },
    { ideasAllowed: false, allPassed: false },
  );
  if (critique.errors.length) return { cards: [], warnings: critique.warnings, errors: critique.errors };
  const reviewTag = `review:${type}`;
  const cards = critique.cards.map((c) => ({
    ...c,
    review: type,
    tags: cleanTags([tag, `kind:${c.kind}`, `sev:${c.severity}`, reviewTag]),
    // lunasworkCritic.applyCards adds run/kind/sev itself and keeps these.
    extraTags: [reviewTag],
  }));
  return { cards, warnings: critique.warnings, errors: [] };
}

function pickedModel(pickModel) {
  if (typeof pickModel !== 'function') return DEFAULT_MODELS[REVIEW_ROLE];
  const pick = pickModel(REVIEW_ROLE);
  if (typeof pick === 'string' && pick) return pick;
  if (isObj(pick) && typeof pick.model === 'string' && pick.model) return pick.model;
  return DEFAULT_MODELS[REVIEW_ROLE];
}

/**
 * One review. Never rejects: any failure becomes {cards: [], notes: ['<type> review failed: ...']}.
 * @param {string} type one of REVIEW_TYPES
 * @param {object} opts see runReviews; plus `model` (already picked)
 */
async function runReview(type, opts) {
  const o = isObj(opts) ? opts : {};
  const log = safeLog(typeof o.log === 'function' ? o.log : noop);
  const failed = (reason, detail) => {
    log(`${type} review failed: ${reason}`, detail);
    const why = detail ? `${reason} (${clip(detail, MAX_NOTE_CHARS)})` : reason;
    return { type, cards: [], notes: [`${type} review failed: ${why}`], warnings: [], costUsd: null };
  };
  try {
    if (!REVIEW_TYPES.includes(type)) return failed('unknownType');
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildReviewArgs({ type, model: o.model, budgetUsd: o.budgetUsd }),
      prompt: buildReviewPrompt({ type, iteration: o.iteration, diff: o.diff }),
      cwd: o.repoPath,
      env: o.env,
      timeoutMs: o.timeoutMs || REVIEW_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return failed((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return failed(parsed.error, parsed.detail);
    const result = reviewCards(parsed.raw, { type, runId: o.runId });
    if (result.errors.length) return failed(result.errors[0].code);
    return { type, cards: result.cards, notes: [], warnings: result.warnings, costUsd: parsed.costUsd };
  } catch (err) {
    return failed('crashed', err && err.message);
  }
}

/**
 * Runs every review due this iteration, one after another (at most three
 * paid calls, never in parallel). Always resolves.
 */
async function runReviews(opts) {
  const o = isObj(opts) ? opts : {};
  const now = safeNow(typeof o.now === 'function' ? o.now : Date.now);
  const started = now();
  const due = reviewsDue(o.iteration, o.isGate);
  const done = (results, extraNotes = []) => {
    const costs = results.map((r) => r.costUsd).filter(Number.isFinite);
    return {
      due,
      cards: results.flatMap((r) => r.cards),
      notes: [...extraNotes, ...results.flatMap((r) => r.notes)],
      warnings: results.flatMap((r) => r.warnings.map((w) => ({ ...w, review: r.type }))),
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      durationMs: now() - started,
    };
  };
  const allFailed = (reason) => done([], due.map((t) => `${t} review failed: ${reason}`));
  if (!due.length) return done([]);
  try {
    if (!runTag(o.runId)) return allFailed('badRunId');
    const repo = typeof o.isDir === 'function' ? checkCwd(o.repoPath, o.isDir) : checkCwd(o.repoPath);
    if (!repo.ok) return allFailed('noRepo');
    const model = pickedModel(o.pickModel);
    const results = [];
    for (const type of due) {
      results.push(await runReview(type, { ...o, model }));
    }
    return done(results);
  } catch (err) {
    return allFailed(`crashed (${clip(err && err.message, MAX_NOTE_CHARS)})`);
  }
}

module.exports = {
  REVIEW_TYPES,
  REVIEW_AGENTS,
  REVIEW_TOOLS,
  REVIEW_SCHEMA,
  reviewsDue,
  buildReviewArgs,
  buildReviewPrompt,
  reviewCards,
  runReview,
  runReviews,
};
