// ============================================================================
// LunaCore - Luna's Work rules (docs/LUNAS_WORK_PLAN.md, slice 1)
// ----------------------------------------------------------------------------
// Pure decisions only - no timers, no git, no tabs, no disk. The Luna's Work
// controller owns the state and the side effects and asks this module:
//
//   models     -> which model a role runs on (a fixed setting, or `auto`
//                 with a reason that goes into the run report)
//   phases     -> directing -> building -> launching -> playtesting ->
//                 critiquing -> directing ... (one iteration per lap)
//   cards      -> what the Director may schedule, in which order
//   card rules -> built -> done after in-app checks (B1), a bug card needs a
//                 test file (#3), stuck cards (B4), the scope guard (B5),
//                 flaky tests kept away from rollback (B9)
//   history    -> plateau, red streak, rollback, and the stop verdict
//   restart    -> validating the stored run (normalizeStoredRun)
//
// One iteration record: { n, milestone, score 0-100, cardsClosed, selfCheck
// 'green'|'red', coreJourneysOk, rolledBack }. Scores are only ever compared
// within one milestone: a new, harder milestone starts lower by design.
// History functions skip malformed entries instead of throwing.
// God Mode is not touched here.
// ============================================================================

'use strict';

const path = require('path');

const ROLES = ['director', 'builder', 'playtester', 'critic', 'reviewer', 'researcher'];
const MODEL_CHOICES = ['opus', 'sonnet', 'haiku', 'auto'];
// Mati's standard (2026-10-22): director + builders opus, playtester sonnet.
// Critic and reviewers are Luna's defaults for the roles he did not name.
const DEFAULT_MODELS = Object.freeze({
  director: 'opus',
  builder: 'opus',
  playtester: 'sonnet',
  critic: 'opus',
  reviewer: 'sonnet',
  researcher: 'sonnet',
});

const PHASES = ['directing', 'building', 'launching', 'playtesting', 'critiquing'];

const STEP_BACK_EVERY = 5;
const MAX_CARDS_PER_ITERATION = 6;
const STUCK_AFTER = 2;
const PLATEAU_WINDOW = 3;
const RED_STREAK = 2;
// Milestone score points a green iteration may lose before it is rolled back.
const ROLLBACK_MARGIN = 10;
const MAX_HISTORY = 500;
const MAX_ID_CHARS = 64;
const MAX_TEXT_CHARS = 200;
// The run id ends up in git tag names (luna-work/<id>/iter-N).
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// Lower rank = scheduled earlier. Unknown values rank last.
const KIND_RANK = { bug: 0, missing: 1, feel: 2, idea: 3 };
const SEVERITY_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
const UNKNOWN_RANK = 99;

// ---- models per role ---------------------------------------------------------------

/**
 * @param {unknown} raw stored or user-entered { role: choice }
 * @returns {Record<string,string>} every role, unknown choices replaced by the default
 */
function normalizeModels(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_MODELS };
  for (const role of ROLES) {
    if (MODEL_CHOICES.includes(src[role])) out[role] = src[role];
  }
  return out;
}

/** The `auto` rule for one role. ctx: { size, risky, shipConfirm, gate, stepBack }. */
function autoModel(role, ctx) {
  switch (role) {
    case 'builder':
      // ctx.risky is decided by the controller (IPC, auth, migrations,
      // merge conflicts last iteration). Stall escalation stays God Mode's.
      return String(ctx.size || '').toUpperCase() === 'L' || ctx.risky
        ? { model: 'opus', reason: 'large or risky card' }
        : { model: 'sonnet', reason: 'small or medium card' };
    case 'playtester':
      return ctx.shipConfirm
        ? { model: 'opus', reason: 'SHIP confirmation pass' }
        : { model: 'sonnet', reason: 'exploratory pass' };
    case 'director':
    case 'critic':
      return ctx.gate || ctx.stepBack
        ? { model: 'opus', reason: ctx.gate ? 'milestone gate' : 'step-back iteration' }
        : { model: 'sonnet', reason: 'regular iteration' };
    default:
      return { model: 'sonnet', reason: 'scheduled review' };
  }
}

/**
 * @param {string} role
 * @param {Record<string,string>} models a normalizeModels result
 * @param {object} [ctx]
 * @returns {{model:string, reason:string}|null} null for an unknown role
 */
function pickModel(role, models, ctx = {}) {
  if (!ROLES.includes(role)) return null;
  const choice = normalizeModels(models)[role];
  if (choice !== 'auto') return { model: choice, reason: 'setting' };
  return autoModel(role, ctx || {});
}

// ---- phases -------------------------------------------------------------------------

/** @returns {string|null} the phase after `phase`, wrapping to directing */
function nextPhase(phase) {
  const i = PHASES.indexOf(phase);
  if (i < 0) return null;
  return PHASES[(i + 1) % PHASES.length];
}

/** Every STEP_BACK_EVERY-th iteration re-reads the brief before writing cards. */
function isStepBack(iteration) {
  return Number.isInteger(iteration) && iteration > 0 && iteration % STEP_BACK_EVERY === 0;
}

// ---- cards ---------------------------------------------------------------------------

const rankOf = (table, value) => {
  const key = typeof value === 'string' ? value.toLowerCase() : value;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : UNKNOWN_RANK;
};

/** A card that failed STUCK_AFTER iterations is split or sent to the decision queue. */
function isStuck(card) {
  return !!card && Number.isInteger(card.failCount) && card.failCount >= STUCK_AFTER;
}

/**
 * What the Director may schedule this iteration. Every steer card, always
 * (Mati's input is never cut by the limit); then the cards filed from
 * mid-run feedback (B17, within the limit); then the rest by kind (bug,
 * missing, feel, idea) and severity, input order on ties, up to `limit` in
 * total. `idea` cards only once the current milestone gate has passed, unless
 * Mati steered them. Stuck cards are left out - they are split or asked about.
 * @param {object[]} cards
 * @param {{gatePassed?:boolean, limit?:number}} [opts]
 * @returns {object[]} a new array; the cards themselves are not changed
 */
function orderCards(cards, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : MAX_CARDS_PER_ITERATION;
  const list = Array.isArray(cards) ? cards : [];
  const ranked = list
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card && typeof card === 'object' && !isStuck(card))
    .filter(({ card }) => rankOf(KIND_RANK, card.kind) !== KIND_RANK.idea || opts.gatePassed === true || card.steer === true)
    .sort(
      (a, b) =>
        rankOf(KIND_RANK, a.card.kind) - rankOf(KIND_RANK, b.card.kind) ||
        rankOf(SEVERITY_RANK, a.card.severity) - rankOf(SEVERITY_RANK, b.card.severity) ||
        a.index - b.index,
    )
    .map(({ card }) => card);
  const steer = ranked.filter((c) => c.steer === true);
  const feedback = ranked.filter((c) => c.steer !== true && c.feedback === true);
  const rest = ranked.filter((c) => c.steer !== true && c.feedback !== true);
  return [...steer, ...[...feedback, ...rest].slice(0, Math.max(0, limit - steer.length))];
}

/** @param {{criteria?:{passed:boolean}[]}|null} gate */
function gatePassed(gate) {
  const criteria = gate && Array.isArray(gate.criteria) ? gate.criteria : [];
  return criteria.length > 0 && criteria.every((c) => c && c.passed === true);
}

// ---- history: plateau, red, rollback ---------------------------------------------------

/** Entries usable by the history rules; anything malformed is skipped. */
const usable = (history) =>
  (Array.isArray(history) ? history : []).filter((r) => r && typeof r === 'object' && Number.isFinite(r.score));

const milestoneOf = (r) => (typeof r.milestone === 'string' ? r.milestone : null);

/**
 * No score above the best before the window, and no card closed, for
 * PLATEAU_WINDOW iterations - all within the current milestone.
 */
function isPlateau(history) {
  const all = usable(history);
  if (!all.length) return false;
  const current = milestoneOf(all[all.length - 1]);
  const same = all.filter((r) => milestoneOf(r) === current);
  if (same.length <= PLATEAU_WINDOW) return false;
  const window = same.slice(-PLATEAU_WINDOW);
  const bestBefore = Math.max(...same.slice(0, -PLATEAU_WINDOW).map((r) => r.score));
  return window.every((r) => r.score <= bestBefore && !(r.cardsClosed > 0));
}

/** Self-check stayed red after fix-up RED_STREAK iterations in a row. */
function isRedStreak(history) {
  const list = (Array.isArray(history) ? history : []).filter((r) => r && typeof r === 'object');
  if (list.length < RED_STREAK) return false;
  return list.slice(-RED_STREAK).every((r) => r.selfCheck === 'red');
}

const isGood = (r) => r.selfCheck === 'green' && r.coreJourneysOk !== false && r.rolledBack !== true;

/**
 * Whether the latest iteration must be reverted on `main`. A red iteration
 * never reached `main`, and a rolled-back one is already reverted, so neither
 * is rolled back. A score drop only counts against the last good iteration
 * of the same milestone; a broken core journey counts against any.
 * @returns {{rollback:boolean, toIteration?:number, reason?:string}}
 */
function rollbackDecision(history) {
  const all = usable(history);
  if (!all.length) return { rollback: false };
  const latest = all[all.length - 1];
  if (latest.selfCheck !== 'green' || latest.rolledBack === true) return { rollback: false };
  const earlierGood = all.slice(0, -1).reverse().filter(isGood);
  if (latest.coreJourneysOk === false) {
    return earlierGood.length
      ? { rollback: true, toIteration: earlierGood[0].n, reason: 'coreJourneyBroken' }
      : { rollback: false };
  }
  const sameMilestone = earlierGood.find((r) => milestoneOf(r) === milestoneOf(latest));
  if (sameMilestone && latest.score < sameMilestone.score - ROLLBACK_MARGIN) {
    return { rollback: true, toIteration: sameMilestone.n, reason: 'scoreDrop' };
  }
  return { rollback: false };
}

/**
 * The run's verdict after a critic pass. Precedence: stop > ship > red > plateau.
 * @param {{history?:object[], critic?:{verdict?:string}, shipConfirmed?:boolean, stopRequested?:boolean}} s
 * @returns {{type:'stop'|'ship'|'red'|'plateau'|'continue'}}
 */
function stopVerdict(s) {
  const history = Array.isArray(s && s.history) ? s.history : [];
  if (s && s.stopRequested === true) return { type: 'stop' };
  if (s && s.critic && s.critic.verdict === 'ship' && s.shipConfirmed === true) return { type: 'ship' };
  if (isRedStreak(history)) return { type: 'red' };
  if (isPlateau(history)) return { type: 'plateau' };
  return { type: 'continue' };
}

// ---- card rules: built -> done, bug tests, stuck, scope, flaky ----------------------------

// A check about the code, not the running app: "A test reproduces the bug".
// The Playtester cannot see it; the bug-test rule (bugTestVerdict) covers it.
const CODE_CHECK_RE = /\b(repro\w*|reproduc\w*|unit|automated|regression)\b[^.\n]{0,60}\btests?\b|^\s*an?\s+tests?\b/i;
// Test files of the common stacks: test/ tests/ __tests__/ spec/ e2e/ folders,
// *.test.* / *.spec.*, Python test_*.py, Go / Python *_test.*.
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;
// Card words that say nothing about scope.
const SCOPE_STOPWORDS = new Set(
  ('the and for with from into onto that this when then than does dont doesnt should must make made '
    + 'add adds added show shows shown work works fix fixes fixed have has not now new more less some '
    + 'page screen view button text user users card cards able after before every also only just like '
    + 'what where which while there their them they your other same each').split(' '),
);
const SCOPE_MIN_CHARS = 4;
// Share of a card's terms DESIGN.md / ROADMAP.md must mention for it to count as in scope.
const SCOPE_MIN_SHARE = 0.5;

const cardKind = (card) => {
  if (typeof card.kind === 'string') return card.kind;
  const tag = (Array.isArray(card.tags) ? card.tags : []).find((t) => typeof t === 'string' && t.startsWith('kind:'));
  return tag ? tag.slice(5) : null;
};

/** The acceptance checks the Playtester can confirm in the running app. */
function appChecks(card) {
  const list = card && Array.isArray(card.acceptance) ? card.acceptance : [];
  return list.filter((c) => typeof c === 'string' && c.trim() && !CODE_CHECK_RE.test(c));
}

/**
 * B1: what the Playtester's pass means for one *built* card. Every app check
 * confirmed closes it; any failed check reopens it; a check the pass did not
 * get to leaves it built until the next pass. A card with no app check has
 * nothing to confirm in the app and closes.
 * @param {{acceptance?:string[]}} card
 * @param {Array<{check:number, passed:boolean, evidence?:object}>} results this card's
 *   results, `check` = index into appChecks(card)
 * @returns {{outcome:'done'|'reopen'|'built', failed:object[], missing:number[]}}
 */
function builtVerdict(card, results) {
  const checks = appChecks(card);
  const list = (Array.isArray(results) ? results : []).filter((r) => r && Number.isInteger(r.check) && r.check >= 0 && r.check < checks.length);
  const failed = list.filter((r) => r.passed === false).map((r) => ({ ...r, text: checks[r.check] }));
  const failedIdx = new Set(failed.map((f) => f.check));
  const confirmed = new Set(list.filter((r) => r.passed === true).map((r) => r.check));
  const missing = checks.map((_, i) => i).filter((i) => !confirmed.has(i) && !failedIdx.has(i));
  if (failed.length) return { outcome: 'reopen', failed, missing };
  return { outcome: missing.length ? 'built' : 'done', failed: [], missing };
}

/** A repo path that is a test file. */
function isTestFile(file) {
  return typeof file === 'string' && TEST_FILE_RE.test(file.replace(/\\/g, '/'));
}

/**
 * Idea #3, checked at finish: a `bug` card's commit must add or change a test
 * file, or the card stays open. Other kinds always pass.
 * @param {{kind?:string, tags?:string[]}} card
 * @param {string[]|null} files the paths its merged work changed (null = unknown)
 * @returns {{ok:boolean, note?:string}}
 */
function bugTestVerdict(card, files) {
  if (!card || cardKind(card) !== 'bug') return { ok: true };
  if (Array.isArray(files) && files.some(isTestFile)) return { ok: true };
  return {
    ok: false,
    note: Array.isArray(files)
      ? 'Still open: the fix did not add or change a test file. A bug card must ship with a test that reproduces the bug.'
      : 'Still open: the files the fix changed are not known, so its repro test could not be checked.',
  };
}

/**
 * B4: failed iterations per card after one iteration. A failed card counts
 * one more; a closed card (done, split) is forgotten.
 * @param {Record<string,number>} counts
 * @param {{failed?:number[], closed?:number[]}} outcome
 * @returns {Record<string,number>} a new map
 */
function nextFailCounts(counts, { failed = [], closed = [] } = {}) {
  const out = {};
  for (const [at, n] of Object.entries(counts && typeof counts === 'object' ? counts : {})) {
    if (Number.isInteger(n) && n > 0) out[at] = n;
  }
  for (const at of new Set(failed.filter(Number.isFinite))) out[at] = (out[at] || 0) + 1;
  for (const at of closed.filter(Number.isFinite)) delete out[at];
  return out;
}

/** B4: the stuck cards (failCount >= STUCK_AFTER) among `ats`. */
function stuckOf(ats, counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  return (Array.isArray(ats) ? ats : []).filter((at) => isStuck({ failCount: c[at] }));
}

/**
 * B4: a stuck card the Critic split is done with; every other one goes to the
 * decision queue.
 * @returns {{split:number[], ask:number[]}}
 */
function stuckOutcome(stuck, split) {
  const done = new Set(Array.isArray(split) ? split : []);
  const list = Array.isArray(stuck) ? stuck : [];
  return { split: list.filter((at) => done.has(at)), ask: list.filter((at) => !done.has(at)) };
}

/** Lowercase words of a text, a trailing plural `s` dropped. */
const wordsOf = (text) =>
  (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).map((w) => (w.length > SCOPE_MIN_CHARS && w.endsWith('s') ? w.slice(0, -1) : w));

/**
 * B5: whether a card stays inside DESIGN.md / ROADMAP.md. Mati's steer cards,
 * feedback cards (B17: a scope part is held by its own decision) and bug
 * cards (broken work is never new scope) always do. Otherwise at
 * least SCOPE_MIN_SHARE of the card title's terms must appear in the pack. An
 * empty pack cannot be judged against, so nothing is out of it.
 * @param {{text?:string, kind?:string, steer?:boolean, feedback?:boolean, tags?:string[]}} card
 * @param {string} packText DESIGN.md + ROADMAP.md
 * @returns {{inScope:boolean, reason:string, missing?:string[]}}
 */
function scopeCheck(card, packText) {
  if (!card || typeof card !== 'object') return { inScope: false, reason: 'badCard' };
  if (card.steer === true || (Array.isArray(card.tags) && card.tags.includes('steer'))) return { inScope: true, reason: 'steer' };
  if (card.feedback === true || (Array.isArray(card.tags) && card.tags.includes('feedback'))) return { inScope: true, reason: 'feedback' };
  if (cardKind(card) === 'bug') return { inScope: true, reason: 'bug' };
  const vocabulary = new Set(wordsOf(packText));
  if (!vocabulary.size) return { inScope: true, reason: 'noPack' };
  const terms = [...new Set(wordsOf(card.text))].filter((w) => w.length >= SCOPE_MIN_CHARS && !SCOPE_STOPWORDS.has(w));
  if (!terms.length) return { inScope: true, reason: 'noTerms' };
  const missing = terms.filter((w) => !vocabulary.has(w));
  return (terms.length - missing.length) / terms.length >= SCOPE_MIN_SHARE
    ? { inScope: true, reason: 'pack' }
    : { inScope: false, reason: 'outsidePack', missing };
}

/**
 * B9: tests (core journeys) that failed and passed on the same code - the
 * same `rev` - are flaky.
 * @param {Array<{name:string, passed:boolean, rev:string}>} observations
 * @returns {string[]} names, first-seen order
 */
function flakyTests(observations) {
  const seen = new Map();
  for (const o of Array.isArray(observations) ? observations : []) {
    if (!o || typeof o.name !== 'string' || !o.name || typeof o.passed !== 'boolean' || typeof o.rev !== 'string') continue;
    const key = `${o.rev}\u0000${o.name}`;
    const entry = seen.get(key) || { name: o.name, passed: false, failed: false };
    seen.set(key, { ...entry, [o.passed ? 'passed' : 'failed']: true });
  }
  return [...new Set([...seen.values()].filter((e) => e.passed && e.failed).map((e) => e.name))];
}

/**
 * B9: the journeys the rollback rules may look at - quarantined (flaky) ones
 * are left out, so they can never trigger a rollback.
 * @param {object[]} journeys
 * @param {Array<string|{name:string}>} quarantine
 * @returns {object[]}
 */
function withoutQuarantined(journeys, quarantine) {
  const names = new Set((Array.isArray(quarantine) ? quarantine : []).map((q) => (typeof q === 'string' ? q : q && q.name)));
  return (Array.isArray(journeys) ? journeys : []).filter((j) => !(j && names.has(j.name)));
}

// ---- stored run ------------------------------------------------------------------------

const strOrNull = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const clampScore = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/**
 * One stored record, or null. A record without a real score or self-check
 * result is dropped rather than filled in: an invented 0 or 'red' would fake
 * a rollback baseline or a RED stop after a corrupted save.
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.n) || raw.n < 1) return null;
  if (!Number.isFinite(raw.score) || !['green', 'red'].includes(raw.selfCheck)) return null;
  return {
    n: raw.n,
    milestone: strOrNull(raw.milestone, MAX_TEXT_CHARS),
    score: clampScore(raw.score),
    cardsClosed: Number.isInteger(raw.cardsClosed) && raw.cardsClosed > 0 ? raw.cardsClosed : 0,
    selfCheck: raw.selfCheck,
    coreJourneysOk: raw.coreJourneysOk !== false,
    rolledBack: raw.rolledBack === true,
  };
}

/** Sorted by n; a duplicate n keeps the record stored last. */
function normalizeHistory(raw) {
  const byN = new Map();
  for (const r of (Array.isArray(raw) ? raw : []).map(normalizeRecord)) if (r) byN.set(r.n, r);
  return [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_HISTORY);
}

/**
 * Validates a run read back from lunaswork.local.json.
 * @param {unknown} raw
 * @returns {object|null} null when it is not a usable run
 */
function normalizeStoredRun(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  if (!SAFE_ID.test(raw.id) || raw.id.includes('..') || raw.id.length > MAX_ID_CHARS) return null;
  if (typeof raw.repoPath !== 'string' || !path.isAbsolute(raw.repoPath)) return null;
  const history = normalizeHistory(raw.history);
  const lastN = history.length ? history[history.length - 1].n : 0;
  const iteration = Number.isInteger(raw.iteration) && raw.iteration >= 0 ? raw.iteration : 0;
  return {
    id: raw.id,
    projectId: strOrNull(raw.projectId, MAX_TEXT_CHARS),
    repoPath: raw.repoPath,
    // An unknown phase restarts the iteration from its first step.
    phase: PHASES.includes(raw.phase) ? raw.phase : 'directing',
    // Never behind the history, or iteration tags would collide.
    iteration: Math.max(iteration, lastN),
    milestone: strOrNull(raw.milestone, MAX_TEXT_CHARS),
    models: normalizeModels(raw.models),
    history: history.slice(-MAX_HISTORY),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    handover: raw.handover === true,
    stopReason: strOrNull(raw.stopReason, MAX_TEXT_CHARS),
  };
}

// ---- playtest personas (LW 2.14) and browser/device matrix (LW 2.24) ----------------

/** Iteration -> rotation index: a non-negative whole number (bad input = 0). */
const rotationIndex = (iteration) => (Number.isInteger(iteration) && iteration > 0 ? iteration : 0);

// Every pass runs the test plan's core journeys; the personas are extra lenses.
const CORE_PERSONA = Object.freeze({
  id: 'core',
  label: 'Core journeys',
  prompt: 'Run every journey in the test plan end to end, exactly as written.',
});

const PERSONAS = Object.freeze([
  {
    id: 'firstTime',
    label: 'First-time user',
    prompt: 'You have never seen this app. Use only what the screen tells you: read every label, '
      + 'button and hint, and flag anything you had to guess, any jargon, and any step with no obvious next action.',
  },
  {
    id: 'power',
    label: 'Power user',
    prompt: 'You use this app every day and want speed: keyboard shortcuts, Tab/Enter flows, bulk actions, '
      + 'many items at once. Flag every extra click, missing shortcut, slow response and lost input.',
  },
  {
    id: 'phone',
    label: 'Phone user',
    prompt: 'You are on a phone (390px wide, touch, slow network). Flag tap targets under 44px, horizontal '
      + 'scroll, text that overflows or is too small, hover-only controls and missing loading states.',
  },
  {
    id: 'a11y',
    label: 'Accessibility',
    prompt: 'You use the keyboard only. Check the focus order and that focus is always visible, contrast, '
      + 'and that every control has a name in the accessibility tree (browser_snapshot): unlabeled buttons, '
      + 'inputs without labels, images without alt text.',
  },
  {
    id: 'breakIt',
    label: 'Break it',
    prompt: 'Try to break it: invalid and empty input, huge values and very long text, double clicks on every '
      + 'submit, the back button mid-flow, reload during a save, and every empty state.',
  },
].map((p) => Object.freeze(p)));

/**
 * The Playtester personas for one pass: the core journeys every iteration
 * plus one persona rotated round-robin; at a milestone gate, all of them.
 * @param {number} iteration
 * @param {boolean} isGate
 * @returns {Array<{id:string, label:string, prompt:string}>} core first
 */
function personasFor(iteration, isGate) {
  if (isGate === true) return [CORE_PERSONA, ...PERSONAS];
  return [CORE_PERSONA, PERSONAS[rotationIndex(iteration) % PERSONAS.length]];
}

const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
const WIDTHS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 820, height: 1180 }),
  desktop: Object.freeze({ width: 1440, height: 900 }),
});

const combo = (engine, device) => Object.freeze({ engine, device, ...WIDTHS[device] });
const ALL_COMBOS = Object.freeze(ENGINES.flatMap((e) => Object.keys(WIDTHS).map((d) => combo(e, d))));
const BASELINE_COMBO = ALL_COMBOS.find((c) => c.engine === 'chromium' && c.device === 'desktop');
const ROTATED_COMBOS = ALL_COMBOS.filter((c) => c !== BASELINE_COMBO);

/**
 * The engine x width combos for one pass: Chromium desktop is always the
 * baseline, plus one other combo rotated per iteration; at a milestone gate,
 * every engine x width.
 * @param {number} iteration
 * @param {boolean} isGate
 * @returns {Array<{engine:string, device:string, width:number, height:number}>} baseline first
 */
function matrixFor(iteration, isGate) {
  if (isGate === true) return [BASELINE_COMBO, ...ROTATED_COMBOS];
  return [BASELINE_COMBO, ROTATED_COMBOS[rotationIndex(iteration) % ROTATED_COMBOS.length]];
}

module.exports = {
  ROLES,
  MODEL_CHOICES,
  DEFAULT_MODELS,
  PHASES,
  STEP_BACK_EVERY,
  MAX_CARDS_PER_ITERATION,
  STUCK_AFTER,
  PLATEAU_WINDOW,
  RED_STREAK,
  ROLLBACK_MARGIN,
  MAX_TEXT_CHARS,
  normalizeModels,
  pickModel,
  nextPhase,
  isStepBack,
  orderCards,
  isStuck,
  gatePassed,
  isPlateau,
  isRedStreak,
  rollbackDecision,
  stopVerdict,
  normalizeStoredRun,
  CORE_PERSONA,
  PERSONAS,
  personasFor,
  ENGINES,
  WIDTHS,
  BASELINE_COMBO,
  matrixFor,
  appChecks,
  builtVerdict,
  isTestFile,
  bugTestVerdict,
  nextFailCounts,
  stuckOf,
  stuckOutcome,
  scopeCheck,
  flakyTests,
  withoutQuarantined,
};
