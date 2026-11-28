// ============================================================================
// LunaCore - Luna's Work harness-loop guard (pure)
// ----------------------------------------------------------------------------
// Seen live (run lwmwzajado): ten iterations, Milestone 1 never passed, and
// most cards were playtest-harness plumbing (driver, send_input dialect,
// button steps, snapshot visibility) - the Critic itself wrote "the loop has
// drifted into harness plumbing". This module notices that shape so the
// controller can ask Mati instead of building on.
//
//   state        run.harnessLoop: the current milestone, how many iterations
//                ran on it without its gate passing, the cards of its last
//                SHARE_WINDOW iterations (all / harness), and the triggers
//                already asked about (never asked twice)
//   isHarnessCard  a card whose files (the landed files when the build
//                merged it, else its predicted files) touch only playtest
//                harness code, or whose text / tags say it is harness work
//   loopTrigger  STALL_ITERATIONS iterations on one milestone without a
//                pass, OR more than HARNESS_SHARE of the cards of the last
//                SHARE_WINDOW iterations were harness cards
//   loopDecision the decision-queue spec: what blocks the gate (the Critic's
//                score and choices, the playtest's unscored criteria and its
//                coverage {planned, run}), options keep going / drop the
//                unscorable criterion / stop the run; default keep going
//
// No IO, no timers: src/lunasworkDecisionGates.js applies it to the run.
// ============================================================================

'use strict';

/** Iterations on one milestone without a pass before Mati is asked. */
const STALL_ITERATIONS = 4;
/** How many of the latest iterations the harness share is taken over. */
const SHARE_WINDOW = 3;
/** Harness cards must be MORE than this share of the window's cards. */
const HARNESS_SHARE = 0.5;
/** How long the harness-loop question waits before its default (keep going). */
const HARNESS_DEADLINE_MS = 2 * 60 * 60 * 1000;

const KEEP_GOING = 'keep-going';
const DROP_CRITERION = 'drop-criterion';
const STOP = 'stop';
const OPTIONS = Object.freeze([KEEP_GOING, DROP_CRITERION, STOP]);
const TRIGGERS = Object.freeze(['stalled', 'harness']);

const MAX_ASKED = 50;
const MAX_NAME = 200;
const MAX_CRITERION = 200;
const MAX_CARDS = 200;
const MAX_DETAIL = 300;

// Playtest harness code: the LunaPlaytest bridge, the playtest driver, the
// playtest command / snapshot files, and the dev-only scripts folder.
const HARNESS_PATH_RES = [
  /(^|\/)LunaPlaytest(\/|\.meta$|$)/i,
  /(^|\/)Scripts\/Dev(\/|\.meta$|$)/i,
  /(^|\/)[^/]*playtest[^/]*$/i,
];
const HARNESS_TEXT_RE = new RegExp(
  [
    '\\bplaytest(?:ing)?[ -](?:harness|driver|bridge|command|commands|snapshot|snapshots|plumbing|dialect)\\b',
    '\\bharness\\b',
    '\\bPlaytestDriver\\b',
    '\\bLunaPlaytest\\b',
    '\\bsend_input\\b',
    '\\bBuildSandbox\\b',
  ].join('|'),
  'i',
);
const HARNESS_TAGS = new Set(['harness', 'playtest-harness', 'kind:harness']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_CARDS) : 0);
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

// ---- harness cards -------------------------------------------------------------

/** True when the path is playtest-harness code. */
function isHarnessPath(file) {
  if (typeof file !== 'string' || !file) return false;
  const p = normPath(file);
  return HARNESS_PATH_RES.some((re) => re.test(p));
}

/**
 * A harness card: its files (the landed ones when known) are all harness
 * code, or its text / tags mark it as harness work.
 * @param {{text?:string, details?:string, tags?:string[], files?:string[]}|null} card
 * @param {string[]|null} [landed] what the merged packages of this card changed
 * @returns {boolean}
 */
function isHarnessCard(card, landed = null) {
  if (!isObj(card)) return false;
  const files = strings(landed).length ? strings(landed) : strings(card.files);
  if (files.length && files.every(isHarnessPath)) return true;
  if (strings(card.tags).some((t) => HARNESS_TAGS.has(t.toLowerCase()))) return true;
  return HARNESS_TEXT_RE.test(`${oneLine(card.text, 1000)}\n${oneLine(card.details, 2000)}`);
}

/**
 * The files each card of this iteration landed, from the stored merges
 * (lunasworkCompileRevert.mergesOf: packages with their card ats and touched paths).
 * @returns {Map<number, string[]>}
 */
function landedByCard(merges) {
  const out = new Map();
  const packages = isObj(merges) && Array.isArray(merges.packages) ? merges.packages : [];
  for (const p of packages.filter(isObj)) {
    for (const at of Array.isArray(p.cards) ? p.cards : []) {
      out.set(at, [...(out.get(at) || []), ...strings(p.touched)]);
    }
  }
  return out;
}

/**
 * How many of an iteration's cards there were and how many were harness work.
 * @param {object[]} cards the iteration's cards, with tags where known (the to-do store's)
 * @param {object|null} merges the iteration's stored merges
 * @returns {{cards:number, harness:number}}
 */
function harnessTally(cards, merges) {
  const list = (Array.isArray(cards) ? cards : []).filter(isObj).slice(0, MAX_CARDS);
  const landed = landedByCard(merges);
  return { cards: list.length, harness: list.filter((c) => isHarnessCard(c, landed.get(c.at) || null)).length };
}

// ---- state ---------------------------------------------------------------------

/** A fresh state for a milestone; the triggers already asked stay. */
const freshFor = (milestone, asked = [], lastN = 0) => ({ milestone, stalled: 0, window: [], asked, decisionId: null, trigger: null, criterion: null, lastN });

/** The empty state (an old run has none). */
const emptyLoop = () => freshFor(null);

function cleanWindow(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((w) => isObj(w) && Number.isInteger(w.n) && w.n > 0)
    .slice(-SHARE_WINDOW)
    .map((w) => {
      const cards = count(w.cards);
      return { n: w.n, cards, harness: Math.min(cards, count(w.harness)) };
    });
}

/**
 * run.harnessLoop read back from disk; an old run (no field) or a broken one
 * gets the empty state.
 * @param {unknown} raw
 */
function restoreLoop(raw) {
  if (!isObj(raw)) return emptyLoop();
  const asked = [...new Set(strings(raw.asked).map((k) => k.slice(0, MAX_NAME + 20)))].slice(-MAX_ASKED);
  const trigger = TRIGGERS.includes(raw.trigger) ? raw.trigger : null;
  return {
    milestone: oneLine(raw.milestone, MAX_NAME) || null,
    stalled: Number.isInteger(raw.stalled) && raw.stalled >= 0 ? Math.min(raw.stalled, 10000) : 0,
    window: cleanWindow(raw.window),
    asked,
    decisionId: Number.isSafeInteger(raw.decisionId) && raw.decisionId > 0 ? raw.decisionId : null,
    trigger,
    criterion: oneLine(raw.criterion, MAX_CRITERION) || null,
    // The newest iteration recorded: recordIteration never counts one twice.
    lastN: Number.isSafeInteger(raw.lastN) && raw.lastN > 0 ? raw.lastN : 0,
  };
}

/**
 * The state after one finished iteration. Idempotent per iteration number
 * (a restart that ends the same iteration again changes nothing). A passed
 * gate or a new milestone starts the count again.
 * @param {object} state
 * @param {{n:number, milestone:string|null, passed:boolean, cards:number, harness:number}} it
 */
function recordIteration(state, it) {
  const s = restoreLoop(state);
  if (!isObj(it) || !Number.isInteger(it.n) || it.n < 1) return s;
  const milestone = oneLine(it.milestone, MAX_NAME) || null;
  if (it.n <= s.lastN) return s;
  // A pending question stays with the state across a milestone change.
  const keep = { decisionId: s.decisionId, trigger: s.trigger, criterion: s.criterion };
  if (it.passed === true) return { ...freshFor(milestone, s.asked, it.n), ...keep };
  const base = s.milestone === milestone ? s : { ...freshFor(milestone, s.asked), ...keep };
  const cards = count(it.cards);
  return {
    ...base,
    lastN: it.n,
    stalled: base.stalled + 1,
    window: [...base.window, { n: it.n, cards, harness: Math.min(cards, count(it.harness)) }].slice(-SHARE_WINDOW),
  };
}

/** The harness share of the window: {cards, harness, share 0..1}; share null without a full window. */
function harnessShare(state) {
  const s = restoreLoop(state);
  const cards = s.window.reduce((n, w) => n + w.cards, 0);
  const harness = s.window.reduce((n, w) => n + w.harness, 0);
  const full = s.window.length >= SHARE_WINDOW && cards > 0;
  return { cards, harness, share: full ? harness / cards : null, iterations: s.window.length };
}

const askedKey = (milestone, trigger) => `${milestone || '-'}|${trigger}`;

/**
 * The triggers that hold now and were not asked about yet for this milestone.
 * `keys` marks EVERY trigger of the milestone asked: one question per
 * milestone, so a harness-share question is not followed by a stall one.
 * @returns {{triggers:string[], keys:string[]}|null}
 */
function loopTrigger(state) {
  const s = restoreLoop(state);
  const share = harnessShare(s).share;
  const hits = [];
  if (s.stalled >= STALL_ITERATIONS) hits.push('stalled');
  if (share !== null && share > HARNESS_SHARE) hits.push('harness');
  const fresh = hits.filter((t) => !s.asked.includes(askedKey(s.milestone, t)));
  return fresh.length ? { triggers: fresh, keys: TRIGGERS.map((t) => askedKey(s.milestone, t)) } : null;
}

/** The dashboard's counts: iterations on this milestone, harness share in percent (null before a full window). */
function loopCounts(state) {
  const s = restoreLoop(state);
  const share = harnessShare(s);
  return {
    milestone: s.milestone,
    iterations: s.stalled,
    stallLimit: STALL_ITERATIONS,
    harnessPercent: share.share === null ? null : Math.round(share.share * 100),
    harnessCards: share.harness,
    cards: share.cards,
    window: share.iterations,
  };
}

// ---- the question --------------------------------------------------------------

/** The first criterion of the milestone the playtest could not score, or null. */
function unscoredCriterion(report, milestone) {
  const list = isObj(report) && Array.isArray(report.notScored) ? report.notScored.filter(isObj) : [];
  const mine = list.find((r) => !milestone || r.milestone === milestone) || list[0];
  return mine ? oneLine(mine.criterion, MAX_CRITERION) || null : null;
}

/** What blocks the gate, in one line: the Critic's score and choices, the unscored criteria, the coverage. */
function blockerSummary({ critic, report, milestone }) {
  const parts = [];
  const m = isObj(critic) && isObj(critic.milestone) ? critic.milestone : null;
  if (m && Number.isFinite(m.score)) parts.push(`Critic: ${oneLine(m.name, 60) || milestone || 'gate'} at ${m.score}, not passed`);
  const choices = isObj(critic) && Array.isArray(critic.decisions) ? critic.decisions.filter(isObj) : [];
  for (const d of choices.slice(0, 2)) parts.push(`${oneLine(d.choice, 80)}${d.because ? ` (${oneLine(d.because, 80)})` : ''}`);
  const notScored = isObj(report) && Array.isArray(report.notScored) ? report.notScored.filter(isObj) : [];
  if (notScored.length) {
    const first = notScored[0];
    parts.push(`not scored: "${oneLine(first.criterion, 80)}"${first.reason ? ` - ${oneLine(first.reason, 80)}` : ''}${notScored.length > 1 ? ` (+${notScored.length - 1})` : ''}`);
  }
  const cov = isObj(report) && isObj(report.coverage) ? report.coverage : null;
  if (cov && Number.isInteger(cov.planned) && cov.planned > 0) parts.push(`journeys run ${cov.run}/${cov.planned}`);
  return oneLine(parts.join('; '), MAX_DETAIL) || 'the Critic gave no reason';
}

/**
 * The decision-queue spec for a harness loop.
 * @param {{triggers:string[], counts:object, critic?:object|null, report?:object|null, milestone?:string|null}} o
 */
function loopDecision({ triggers, counts, critic = null, report = null, milestone = null }) {
  const name = milestone || counts.milestone || 'the current milestone';
  const why = [];
  if (triggers.includes('stalled')) why.push(`has run ${counts.iterations} iterations without passing its gate`);
  if (triggers.includes('harness')) {
    why.push(`${counts.harnessCards} of the last ${counts.cards} cards (${counts.window} iterations) were playtest-harness work`);
  }
  return {
    kind: 'harnessLoop',
    question: `Milestone "${oneLine(name, 80)}" ${why.join(', and ')}. Keep going, drop the criterion the playtest cannot score from the gate, or stop the run?`,
    detail: blockerSummary({ critic, report, milestone: name }),
    options: [...OPTIONS],
    defaultAnswer: KEEP_GOING,
    deadlineMs: HARNESS_DEADLINE_MS,
    cardIds: [],
  };
}

/** The DECISIONS.md line the Critic reads when Mati drops the unscorable criterion. */
function dropCriterionLine({ milestone, criterion, date }) {
  const what = criterion ? `"${oneLine(criterion, MAX_CRITERION).replace(/"/g, "'")}"` : 'the criterion the playtest cannot score';
  const day = typeof date === 'string' && date ? `${date}, ` : '';
  return `- Gate change (${day}Mati): ${what} is dropped from the ${oneLine(milestone, 80) || 'current'} milestone gate - the playtest cannot score it; judge the gate on its other criteria and stop filing harness cards for it.`;
}

module.exports = {
  STALL_ITERATIONS,
  SHARE_WINDOW,
  HARNESS_SHARE,
  HARNESS_DEADLINE_MS,
  KEEP_GOING,
  DROP_CRITERION,
  STOP,
  OPTIONS,
  isHarnessPath,
  isHarnessCard,
  harnessTally,
  emptyLoop,
  restoreLoop,
  recordIteration,
  harnessShare,
  loopTrigger,
  loopCounts,
  unscoredCriterion,
  blockerSummary,
  loopDecision,
  dropCriterionLine,
};
