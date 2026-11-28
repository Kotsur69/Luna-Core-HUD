// ============================================================================
// LunaCore - Luna's Work Playtester plan (split out of lunasworkPlaytest.js)
// ----------------------------------------------------------------------------
// Why it exists: a long design/TEST_PLAN.md used to be cut at a fixed length
// and played top to bottom, so the current milestone's journeys at its end
// were never reached, and the Playtester scored reworded criteria that no
// gate item matched - the gate then stayed unscored however the code changed.
//
//   buildPlan        TEST_PLAN.md reordered for this pass: the current
//                    milestone's journeys first (file order otherwise), whole
//                    journeys left out from the end when it is too long, and
//                    the current milestone's gate criteria to score
//   planPromptLines  the prompt section that says so
//   matchCriterion   THE CRITERION RULE, shared with the gate
//                    (lunasworkCritic.gateStatus): a score counts only under
//                    a gate item's exact text in its own milestone - case,
//                    spacing and punctuation aside, never reworded
//   cleanScoredList  the report boundary: scores with a gate item's text are
//                    rewritten to it, the rest are rejected with a reason
//   cleanNotScored / cleanNotRun
//                    the Playtester's own "not scored" / "not run" reasons
//   planCoverage     journeys planned vs run, computed here from the report,
//                    never taken from the model; cleanCoverage re-validates a
//                    stored one
//
// A journey belongs to a milestone when a "Scores:" line under it quotes one
// of that milestone's gate items, a "Milestone:" line names it, or its
// heading names it ("Milestone 1 regression sweep", "M1 ..."). A label names
// a milestone only as a whole (milestoneMatches): "Milestone 1", "M1", "1"
// or its title - never "Milestone 10" or a number inside another title.
// ============================================================================

'use strict';

const { parseShipCriteria } = require('./lunasworkPack');

// The test plan as it reaches the prompt (the raw file may be longer).
const MAX_PLAN_CHARS = 60000;
// Free exploration and other sections before the journeys get at most this share.
const HEAD_SHARE = 0.25;
const MAX_NAME_CHARS = 120;
const MAX_CRITERION_CHARS = 200;
const MAX_REASON_CHARS = 300;
const MAX_NOT_SCORED = 100;
const MAX_NOT_RUN = 100;
const MAX_UNMATCHED = 20;
const MAX_LISTED_NAMES = 40;
const MAX_NOTE_CHARS = 2000;
const MAX_COUNT = 1000;
// A "Scores:" / "Milestone:" line under a journey (optionally bold, optionally a list item).
const SCORES_LINE_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?Scores?(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i;
const MILESTONE_LINE_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?Milestone(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i;
// "milestone 1" at the start of a gate name: the short form a journey heading uses.
const GATE_KEY_RE = /^(\p{L}+) (\d+)(?: |$)/u;
const QUOTES_RE = /^["'`“”‘’]+|["'`“”‘’]+$/g;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const defang = (line) => line.replace(/<<</g, '<< <').replace(/>>>/g, '>> >');
const quoted = (name) => `"${name}"`;

/** Comparison form of a text: lower case, letters and digits only (any script), single spaces. */
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A gate name's parts: its norm() form, its short keys ("milestone 1", "m1"), number and title. */
function gateParts(name) {
  const full = norm(name);
  const m = full.match(GATE_KEY_RE);
  if (!m) return { full, keys: [], number: null, title: full };
  const keys = [`${m[1]} ${m[2]}`, `${m[1][0]}${m[2]}`];
  return { full, keys, number: m[2], title: full.slice(keys[0].length).trim() };
}

/**
 * Whether a label names this milestone: "Milestone 1: Skeleton" is named by
 * itself, "Milestone 1", "M1", "1", "Skeleton" or "M1 Skeleton" - never by
 * "Milestone 10", a bare "Milestone", or a number inside another title.
 */
function milestoneMatches(gateName, label) {
  const l = norm(label);
  if (!l) return false;
  const g = gateParts(gateName);
  if (l === g.full || (g.title && l === g.title) || l === g.number || g.keys.includes(l)) return true;
  return g.keys.some((k) => !!g.title && l === `${k} ${g.title}`);
}

/** The milestones of SHIP_CRITERIA.md that have gate items, as {name, criteria:string[]}. */
function gatesOf(shipCriteria) {
  return parseShipCriteria(typeof shipCriteria === 'string' ? shipCriteria : '')
    .filter((m) => m.criteria.length > 0)
    .map((m) => ({ name: m.name, criteria: m.criteria.map((c) => c.text) }));
}

/**
 * The gate item a score or a "not scored" entry names: its exact text, in
 * that milestone. Case, spacing and punctuation do not count; words do.
 * @param {{name:string, criteria:string[]}[]} gates gatesOf()
 * @returns {{milestone:string, criterion:string}|null} the gate's own texts
 */
function matchCriterion(gates, milestone, criterion) {
  const key = norm(criterion);
  if (!key || !norm(milestone) || !Array.isArray(gates)) return null;
  for (const gate of gates) {
    if (!milestoneMatches(gate.name, milestone)) continue;
    const hit = gate.criteria.find((c) => norm(c) === key);
    if (hit) return { milestone: gate.name, criterion: hit };
  }
  return null;
}

/** Why a score matched no gate item - shown to the Critic next to the rejected score. */
function mismatchReason(gates, criterion) {
  const key = norm(criterion);
  const elsewhere = gates.some((g) => g.criteria.some((c) => norm(c) === key));
  return elsewhere ? 'that milestone has no such gate item' : 'not the exact text of a gate item';
}

/**
 * The run's current milestone among the gates: the one named; none named
 * (a run's first iteration) = the first rung. A name that is no gate (a
 * renamed heading) resolves to null: the plan keeps its file order rather
 * than putting a guessed milestone first.
 */
function resolveMilestone(gates, milestone) {
  if (!gates.length) return null;
  if (!norm(milestone)) return gates[0];
  return gates.find((g) => milestoneMatches(g.name, milestone)) || null;
}

// ---- TEST_PLAN.md -------------------------------------------------------------------

/** Whether a line ends inside an HTML comment, given the state before it. */
function commentAfter(line, open) {
  let inside = open;
  let from = 0;
  for (;;) {
    const at = line.indexOf(inside ? '-->' : '<!--', from);
    if (at < 0) return inside;
    from = at + (inside ? 3 : 4);
    inside = !inside;
  }
}

/** The "Scores:" and "Milestone:" values under one journey (comments and fences included as written). */
function journeyTags(lines) {
  const scores = [];
  const milestones = [];
  for (const line of lines) {
    const s = line.match(SCORES_LINE_RE);
    if (s) scores.push(s[1].replace(QUOTES_RE, ''));
    const m = line.match(MILESTONE_LINE_RE);
    if (m) milestones.push(m[1].replace(QUOTES_RE, ''));
  }
  return { scores, milestones };
}

/**
 * TEST_PLAN.md split into what comes before "## Journeys", the journeys
 * ("### " blocks), and the sections after them. Headings inside comments or
 * code fences are text.
 * @returns {{head:string[], intro:string[], journeys:{name:string, lines:string[]}[], tail:string[]}}
 */
function parseTestPlan(md) {
  const out = { head: [], intro: [], journeys: [], tail: [] };
  let section = 'head';
  let inComment = false;
  let inFence = false;
  for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const plain = !inComment && !inFence;
    const h2 = plain && line.match(/^##\s+(.+?)\s*$/);
    const h3 = plain && line.match(/^###\s+(.+?)\s*$/);
    if (plain && /^\s*(```|~~~)/.test(line)) inFence = true;
    else if (inFence && /^\s*(```|~~~)/.test(line)) inFence = false;
    if (!inFence) inComment = commentAfter(line, inComment);
    if (h2 && /^journeys$/i.test(h2[1])) {
      section = 'journeys';
      continue;
    }
    if (h2 && section === 'journeys') section = 'tail';
    if (section === 'journeys' && h3) {
      // A comment on the heading line is not part of the journey's name.
      const name = oneLine(h3[1].replace(/<!--.*?(?:-->|$)/g, ''), MAX_NAME_CHARS);
      out.journeys.push({ name: name || oneLine(h3[1], MAX_NAME_CHARS), lines: [line] });
    } else if (section === 'journeys') {
      (out.journeys.length ? out.journeys[out.journeys.length - 1].lines : out.intro).push(line);
    } else {
      out[section].push(line);
    }
  }
  return out;
}

/**
 * The criteria one "Scores:" value may name: the whole value, else its parts
 * ("A"; "B" or "A", "B") - a criterion text may hold commas of its own.
 */
function scoredTexts(value) {
  const parts = value.split(/\s*;\s*|["”]\s*,\s*["“]/).map((p) => p.replace(QUOTES_RE, '').trim()).filter(Boolean);
  return [value, ...(parts.length > 1 ? parts : [])];
}

/** The milestones one journey belongs to (see the header). */
function journeyGates(journey, gates) {
  const tags = journeyTags(journey.lines.slice(1));
  const scored = new Set(tags.scores.flatMap(scoredTexts).map(norm));
  const heading = ` ${norm(journey.name)} `;
  return gates
    .filter((g) => g.criteria.some((c) => scored.has(norm(c)))
      || tags.milestones.some((m) => milestoneMatches(g.name, m))
      || [gateParts(g.name).full, ...gateParts(g.name).keys].some((k) => heading.includes(` ${k} `)))
    .map((g) => g.name);
}

/** Joined lines, cut at `max` characters on a line break when one is close. */
function capLines(lines, max) {
  const text = lines.join('\n');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf('\n');
  return at > max / 2 ? cut.slice(0, at) : cut;
}

/** The plan text: head, then the ordered journeys that fit, then the sections after them. */
function renderPlan(parsed, ordered, maxChars) {
  const head = capLines(parsed.head, Math.floor(maxChars * HEAD_SHARE)).replace(/\s+$/, '');
  const parts = [head, '## Journeys', ...(parsed.intro.join('\n').trim() ? [parsed.intro.join('\n').trim()] : [])];
  let size = parts.join('\n\n').length;
  const cut = [];
  for (const journey of ordered) {
    const block = journey.lines.join('\n').trim();
    if (size + block.length + 2 > maxChars) {
      cut.push(journey.name);
      continue;
    }
    parts.push(block);
    size += block.length + 2;
  }
  const tail = parsed.tail.join('\n').trim();
  const tailFits = !tail || size + tail.length + 2 <= maxChars;
  if (tail && tailFits) parts.push(tail);
  // The note comes on top of maxChars, capped on its own.
  const notes = [
    ...(cut.length ? [`${cut.length} journey(s) left out of this pass for length: ${cut.slice(0, MAX_LISTED_NAMES).map(quoted).join(', ')}`] : []),
    ...(tailFits ? [] : ['the sections after the journeys were left out for length']),
  ];
  if (notes.length) parts.push(`(${notes.join('; ')})`.slice(0, MAX_NOTE_CHARS));
  return { text: parts.filter(Boolean).join('\n\n'), cut };
}

/**
 * The plan of one pass.
 * @param {{testPlan:string, shipCriteria:string, milestone?:string|null, maxChars?:number}} input
 *   milestone = the run's current milestone (null: the first rung of the ladder; a name
 *   that is no gate: no milestone, file order)
 * @returns {{milestone:{name:string, criteria:string[]}|null, planned:string[], first:string[],
 *   cut:string[], text:string}} planned = every journey of the file, current milestone first;
 *   first = the current milestone's journeys; cut = journeys left out of `text` for length
 */
function buildPlan({ testPlan = '', shipCriteria = '', milestone = null, maxChars = MAX_PLAN_CHARS } = {}) {
  const gates = gatesOf(shipCriteria);
  const current = resolveMilestone(gates, milestone);
  const parsed = parseTestPlan(testPlan);
  const isFirst = (j) => !!current && journeyGates(j, gates).includes(current.name);
  const first = parsed.journeys.filter(isFirst);
  const ordered = [...first, ...parsed.journeys.filter((j) => !isFirst(j))];
  const raw = String(testPlan || '').trim();
  const rendered = ordered.length ? renderPlan(parsed, ordered, maxChars) : { text: capLines([raw], maxChars), cut: [] };
  return {
    milestone: current ? { name: current.name, criteria: [...current.criteria] } : null,
    planned: ordered.map((j) => j.name),
    first: first.map((j) => j.name),
    cut: rendered.cut,
    text: rendered.text,
  };
}

/**
 * The prompt section that puts the current milestone first; [] without one.
 * Names and criteria come from the design pack, so delimiters are broken up.
 */
function planPromptLines(plan) {
  if (!isObj(plan) || !isObj(plan.milestone)) return [];
  const m = plan.milestone;
  const name = oneLine(m.name, MAX_NAME_CHARS);
  const first = Array.isArray(plan.first) ? plan.first : [];
  return [
    '',
    `CURRENT MILESTONE FIRST - "${name}". Before anything else:`,
    first.length
      ? `- Run its ${first.length} journey(s) first, in this order (they open the test plan below): ${first.map((j) => quoted(oneLine(j, MAX_NAME_CHARS))).join(', ')}.`
      : '- No test-plan journey is marked for it: check its criteria directly.',
    `- Score EVERY gate criterion of "${name}". In "criterion" copy the text below word for word - never reword, shorten or merge it - and put "${name}" in "milestone". A score whose criterion is not exactly one of these texts is thrown away:`,
    ...m.criteria.map((c) => `  - ${oneLine(c, MAX_CRITERION_CHARS)}`),
    '- A criterion you could not score goes in notScored with its exact text and the reason (not reached, blocked by a bug, no way to check it with your tools).',
    '- Then confirm the built cards listed below (if any), then run the remaining journeys in order, then explore. If you cannot finish everything, this order decides what is left out - and every journey you did not run goes in journeysNotRun with the reason.',
  ].map(defang);
}

// ---- the report boundary ------------------------------------------------------------

const reasonItem = (keys) => ({
  type: 'object',
  additionalProperties: false,
  required: [...keys, 'reason'],
  properties: { ...Object.fromEntries(keys.map((k) => [k, { type: 'string' }])), reason: { type: 'string' } },
});
// The report's `notScored`: a gate criterion the pass did not score, by its exact text, and why.
const NOT_SCORED_SCHEMA = { type: 'array', maxItems: MAX_NOT_SCORED, items: reasonItem(['milestone', 'criterion']) };
// The report's `journeysNotRun`: a test-plan journey the pass did not run, by its exact name, and why.
const NOT_RUN_SCHEMA = { type: 'array', maxItems: MAX_NOT_RUN, items: reasonItem(['name']) };

/**
 * Scores rewritten to their gate item's texts; the rest rejected. No gates
 * (no SHIP_CRITERIA.md items) = nothing to match against: scores kept as they are.
 * @param {object[]} scores already evidence-checked
 * @param {{name:string, criteria:string[]}[]|undefined} gates
 * @param {object[]} warnings pushed to
 * @returns {{scores:object[], unmatched:{milestone:string, criterion:string, score:number, reason:string}[]}}
 */
function cleanScoredList(scores, gates, warnings) {
  if (!Array.isArray(gates) || !gates.length) return { scores, unmatched: [] };
  const kept = [];
  const unmatched = [];
  for (const s of scores) {
    const hit = matchCriterion(gates, s.milestone, s.criterion);
    if (hit) {
      kept.push({ ...s, milestone: hit.milestone, criterion: hit.criterion });
      continue;
    }
    const reason = mismatchReason(gates, s.criterion);
    warnings.push({ code: 'unknownCriterion', criterion: s.criterion, detail: reason });
    if (unmatched.length < MAX_UNMATCHED) unmatched.push({ milestone: s.milestone, criterion: s.criterion, score: s.score, reason });
  }
  return { scores: kept, unmatched };
}

/**
 * The Playtester's "not scored" entries: gate items only, one per item, never
 * one that was scored after all.
 * @returns {{milestone:string, criterion:string, reason:string}[]}
 */
function cleanNotScored(raw, gates, scores, warnings) {
  if (!Array.isArray(raw) || !Array.isArray(gates) || !gates.length) return [];
  const taken = new Set((Array.isArray(scores) ? scores : []).map((s) => `${s.milestone}\n${s.criterion}`));
  const out = [];
  for (const r of raw.slice(0, MAX_NOT_SCORED)) {
    const hit = isObj(r) ? matchCriterion(gates, r.milestone, r.criterion) : null;
    if (!hit) {
      warnings.push({ code: 'unknownCriterion', criterion: isObj(r) ? oneLine(r.criterion, MAX_CRITERION_CHARS) : '' });
      continue;
    }
    const key = `${hit.milestone}\n${hit.criterion}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ ...hit, reason: oneLine(r.reason, MAX_REASON_CHARS) || 'no reason given' });
  }
  return out;
}

/**
 * The Playtester's "not run" journeys, by a planned name when there is a plan.
 * @returns {{name:string, reason:string}[]}
 */
function cleanNotRun(raw, plan) {
  if (!Array.isArray(raw)) return [];
  const planned = isObj(plan) && Array.isArray(plan.planned) ? new Map(plan.planned.map((n) => [norm(n), n])) : null;
  const seen = new Set();
  const out = [];
  for (const r of raw.slice(0, MAX_NOT_RUN)) {
    const name = isObj(r) ? oneLine(r.name, MAX_NAME_CHARS) : '';
    const known = planned ? planned.get(norm(name)) : name;
    if (!known || seen.has(norm(known))) continue;
    seen.add(norm(known));
    out.push({ name: known, reason: oneLine(r.reason, MAX_REASON_CHARS) || 'no reason given' });
  }
  return out;
}

/**
 * Journeys planned vs run, and the current milestone's share of both. Counted
 * from the validated report: a journey counts as run when the report has an
 * entry for it (passed or failed).
 * @param {ReturnType<typeof buildPlan>|null} plan
 * @param {{journeys?:object[], notRun?:object[], scores?:object[], checks?:{asked:number, answered:number}}} report
 * @returns {object|null} null without a plan
 */
function planCoverage(plan, { journeys = [], notRun = [], scores = [], checks = null } = {}) {
  if (!isObj(plan) || !Array.isArray(plan.planned)) return null;
  const ran = new Set(journeys.filter(isObj).map((j) => norm(j.name)));
  const isRun = (name) => ran.has(norm(name));
  const reasons = new Map(notRun.filter(isObj).map((r) => [norm(r.name), r.reason]));
  const cut = new Set(plan.cut || []);
  const m = isObj(plan.milestone) ? plan.milestone : null;
  const scored = new Set(scores.filter((s) => isObj(s) && m && s.milestone === m.name).map((s) => s.criterion));
  const missing = plan.planned.filter((name) => !isRun(name));
  const reasonOf = (name) => reasons.get(norm(name)) || (cut.has(name) ? 'left out of the prompt for length' : 'not reported');
  return {
    planned: plan.planned.length,
    run: plan.planned.length - missing.length,
    cut: cut.size,
    milestone: m ? m.name : null,
    milestonePlanned: plan.first.length,
    milestoneRun: plan.first.filter(isRun).length,
    criteria: m ? m.criteria.length : 0,
    criteriaScored: m ? m.criteria.filter((c) => scored.has(c)).length : 0,
    ...(checks ? { cardsAsked: checks.asked, cardsAnswered: checks.answered } : {}),
    notRun: missing.slice(0, MAX_NOT_RUN).map((name) => ({ name, reason: reasonOf(name) })),
  };
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_COUNT) : 0);

/** A stored coverage record re-validated (lunasworkRun.cleanReport); null when there is none. */
function cleanCoverage(raw) {
  if (!isObj(raw)) return null;
  const out = {
    planned: count(raw.planned),
    run: count(raw.run),
    cut: count(raw.cut),
    milestone: typeof raw.milestone === 'string' && raw.milestone ? oneLine(raw.milestone, MAX_NAME_CHARS) : null,
    milestonePlanned: count(raw.milestonePlanned),
    milestoneRun: count(raw.milestoneRun),
    criteria: count(raw.criteria),
    criteriaScored: count(raw.criteriaScored),
    notRun: (Array.isArray(raw.notRun) ? raw.notRun : []).filter(isObj).slice(0, MAX_NOT_RUN)
      .map((r) => ({ name: oneLine(r.name, MAX_NAME_CHARS), reason: oneLine(r.reason, MAX_REASON_CHARS) }))
      .filter((r) => r.name),
  };
  if (Number.isInteger(raw.cardsAsked)) Object.assign(out, { cardsAsked: count(raw.cardsAsked), cardsAnswered: count(raw.cardsAnswered) });
  return out;
}

module.exports = {
  MAX_PLAN_CHARS,
  NOT_SCORED_SCHEMA,
  NOT_RUN_SCHEMA,
  norm,
  milestoneMatches,
  gatesOf,
  matchCriterion,
  resolveMilestone,
  parseTestPlan,
  journeyGates,
  buildPlan,
  planPromptLines,
  cleanScoredList,
  cleanNotScored,
  cleanNotRun,
  planCoverage,
  cleanCoverage,
};
