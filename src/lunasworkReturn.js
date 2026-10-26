// ============================================================================
// LunaCore - Luna's Work "while you were away" return pack (LW 2.18)
// ----------------------------------------------------------------------------
// Built when a run ends (SHIP / STOP / PLATEAU / RED) from the finished run,
// saved as <runsDir>/lunaswork-<id>-return.md and attached to the run email
// (lunasworkReport). Pure: no IO.
//
//   ## What changed per milestone   the cards each iteration closed, grouped
//                                   by milestone, with the gate it passed
//   ## Ten decisions to double-check
//                                   rankRiskyDecisions(): default after the
//                                   deadline > new dependency > migration >
//                                   deleted feature > DESIGN change, newest
//                                   first within a rank
//   ## Rollbacks                    every rollback, why, what was reverted
//   ## Screen tour                  one screenshot per key screen
//                                   (lunasworkRun.keyScreens) with a caption
//
// The decisions come from the decision queue (Mati's answers and the defaults
// taken after a deadline) and from the Critic's DECISIONS.md lines, which are
// classified with the queue's own rules (lunasworkDecisions.needsDecision).
// forEmail: screenshots by file name only, never a local path.
// ============================================================================

'use strict';

const path = require('path');
const { needsDecision } = require('./lunasworkDecisions');
const { keyScreens } = require('./lunasworkRun');

// The risky kinds, riskiest first (after "taken by default").
const RISK_KINDS = Object.freeze(['dependency', 'migration', 'featureDelete', 'designChange']);
const KIND_LABEL = Object.freeze({
  dependency: 'new dependency',
  migration: 'migration',
  featureDelete: 'deleted feature',
  designChange: 'DESIGN change',
});
const DEFAULT_LIMIT = 10;
const MAX_LINE = 300;
const MAX_CHANGES_PER_LAP = 15;
// Queue answers carry clock times, Critic lines only an iteration number:
// lifted past any iteration so "newest first" keeps them in their own order.
const CLOCK_OFFSET = 1e9;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_LINE) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);

/** 0 = taken by default after a deadline; then the risky kinds in order; null = not risky. */
function riskRank(d) {
  if (d.defaulted === true) return 0;
  const kind = RISK_KINDS.indexOf(d.kind);
  return kind < 0 ? null : kind + 1;
}

/**
 * THE RANKING (pure): the riskiest decisions to double-check, at most `limit`.
 * Order: default after the deadline > new dependency > migration > deleted
 * feature > DESIGN change. Defaults sort by kind among themselves; ties go
 * newest first. Anything else (a choice Mati made outside those kinds) is
 * not listed.
 * @param {{kind:string|null, defaulted?:boolean, at?:number|null, text:string}[]} decisions
 * @param {{limit?:number}} [opts]
 * @returns {{kind:string|null, defaulted:boolean, at:number|null, text:string, rank:number}[]}
 */
function rankRiskyDecisions(decisions, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const kindOrder = (kind) => (RISK_KINDS.includes(kind) ? RISK_KINDS.indexOf(kind) : RISK_KINDS.length);
  const time = (d) => (Number.isFinite(d.at) ? d.at : -1);
  return list(decisions)
    .map((d, i) => ({ d, i, rank: riskRank(d) }))
    .filter((x) => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || kindOrder(a.d.kind) - kindOrder(b.d.kind) || time(b.d) - time(a.d) || a.i - b.i)
    .slice(0, limit)
    .map(({ d, rank }) => ({
      kind: typeof d.kind === 'string' ? d.kind : null,
      defaulted: d.defaulted === true,
      at: Number.isFinite(d.at) ? d.at : null,
      text: oneLine(d.text),
      rank,
    }));
}

/**
 * Every decision of the run in the ranking's shape: answered queue entries
 * and the Critic's DECISIONS.md lines (per lap), classified like the queue.
 * @returns {{kind:string|null, defaulted:boolean, at:number|null, text:string}[]}
 */
function riskyDecisionsOf(run) {
  const r = isObj(run) ? run : {};
  const queue = list(r.decisions)
    .filter((d) => d.status === 'answered')
    .map((d) => ({
      kind: d.kind,
      defaulted: d.answeredBy === 'default',
      at: Number.isFinite(d.answeredAt) ? d.answeredAt + CLOCK_OFFSET : null,
      text: `"${oneLine(d.question, 160)}" -> ${oneLine(d.answer, 80)} (${d.answeredBy === 'default' ? 'default after the deadline' : 'answered by Mati'})`,
    }));
  const critic = list(r.laps).flatMap((lap) => list(lap.decisions).map((d) => {
    // The choice only: a reason like "no new dependency" is no new dependency.
    const hit = needsDecision({ text: String(d.choice || ''), from: 'critic' });
    return {
      kind: hit ? hit.kind : null,
      defaulted: false,
      at: Number.isInteger(lap.n) ? lap.n : null,
      text: `Chose ${oneLine(d.choice, 160)} because ${oneLine(d.because, 120)} (Critic, iteration ${lap.n})`,
    };
  }));
  return [...queue, ...critic];
}

// ---- the pack ---------------------------------------------------------------------------

const VERDICT_LABEL = { ship: 'SHIP', plateau: 'PLATEAU', red: 'RED', stop: 'STOP' };

function milestoneGroups(laps) {
  const groups = [];
  for (const lap of laps) {
    const name = oneLine(lap.milestone, 120) || '(no milestone)';
    const found = groups.find((g) => g.name === name);
    const group = found || { name, laps: [], gate: null };
    if (!found) groups.push(group);
    group.laps.push(lap);
    if (lap.gate === true) group.gate = lap.n;
  }
  return groups;
}

function changeLine(lap) {
  const changes = list(lap.changes).slice(0, MAX_CHANGES_PER_LAP).map((c) => oneLine(c.text, 120));
  const score = Number.isFinite(lap.score) ? `, score ${lap.score}` : '';
  const rolled = lap.rolledBack ? ' - rolled back' : '';
  return `- Iteration ${lap.n}${score}: ${changes.length ? changes.join('; ') : 'nothing closed'}${rolled}`;
}

function changesSection(laps) {
  const groups = milestoneGroups(laps);
  if (!groups.length) return ['- no iteration finished', ''];
  return groups.flatMap((g) => [
    `### ${g.name} - ${g.gate === null ? 'gate not passed' : `gate passed in iteration ${g.gate}`}`,
    '',
    ...g.laps.map(changeLine),
    '',
  ]);
}

function decisionLabel(d) {
  if (!d.defaulted) return KIND_LABEL[d.kind];
  return KIND_LABEL[d.kind] ? `default after the deadline, ${KIND_LABEL[d.kind]}` : 'default after the deadline';
}

function decisionsSection(run) {
  const ranked = rankRiskyDecisions(riskyDecisionsOf(run));
  if (!ranked.length) return ['- none - no default answers, new dependencies, migrations, deleted features or DESIGN changes'];
  return ranked.map((d, i) => `${i + 1}. [${decisionLabel(d)}] ${d.text}`);
}

function rollbacksSection(laps) {
  const rolled = laps.filter((l) => isObj(l.checkpoint) && isObj(l.checkpoint.rollback));
  if (!rolled.length) return ['- none'];
  return rolled.flatMap((lap) => {
    const rb = lap.checkpoint.rollback;
    const head = rb.ok
      ? `- Iteration ${lap.n} rolled back${rb.toTag ? ` to ${oneLine(rb.toTag, 120)}` : ''}: ${oneLine(rb.why || rb.reason, 200)}`
      : `- Iteration ${lap.n}: the rollback FAILED (${oneLine(rb.error || 'failed', 80)}): ${oneLine(rb.why || rb.reason, 200)}`;
    return [head, ...list(rb.reverted).slice(0, 10).map((c) => `  - reverted ${oneLine(c.sha, 12).slice(0, 7)} ${oneLine(c.subject, 120)}`)];
  });
}

/** Markdown image target: a forward-slash path in <>, or the bare file name in an email. */
function imageTarget(file, forEmail) {
  if (forEmail) return path.basename(String(file));
  return `<${String(file).replace(/\\/g, '/').replace(/[<>]/g, '')}>`;
}

function screensSection(laps, forEmail) {
  const shots = keyScreens(laps);
  if (!shots.length) return ['- no screenshots in the evidence'];
  return shots.flatMap((s) => [
    `### ${oneLine(s.name, 80)}`,
    '',
    `![${oneLine(s.name, 80)}](${imageTarget(s.screenshot, forEmail)})`,
    '',
    `*${oneLine(s.name, 80)}, as the Playtester saw it in iteration ${s.n}.*`,
    '',
  ]);
}

function releaseLines(run) {
  const sd = isObj(run.shipDocs) ? run.shipDocs : null;
  if (!sd) return [];
  const rel = sd.release;
  let line = '- no release step ran';
  if (rel && rel.ok) line = `- Released ${oneLine(rel.tag, 40)}${rel.url ? `: ${oneLine(rel.url, 200)}` : ''}`;
  else if (rel) line = `- The release did not go out (${oneLine(rel.error, 80)}${rel.detail ? `: ${oneLine(rel.detail, 160)}` : ''}) - tag and publish it by hand`;
  const landed = Array.isArray(sd.landed) ? sd.landed.length : 0;
  const cards = Array.isArray(sd.cards) ? sd.cards.length : 0;
  return ['## Docs and release', '', `- Docs iteration ${sd.n}: ${landed}/${cards} cards landed (README, user guide, release prep)`, line, ''];
}

/**
 * The return pack as Markdown.
 * @param {object} run the finished run
 * @param {{forEmail?:boolean}} [opts]
 * @returns {string}
 */
function buildReturnPack(run, opts = {}) {
  const r = isObj(run) ? run : {};
  const laps = [...list(r.laps)].sort((a, b) => a.n - b.n);
  const verdict = VERDICT_LABEL[r.verdict] || 'STOP';
  const repo = oneLine(path.basename(String(r.repoPath || '')), 100) || 'repo';
  return `${[
    `# While you were away - ${repo} (${verdict})`,
    '',
    `Run ${oneLine(r.id, 40)}: ${laps.length} iteration(s), ended ${verdict}.`,
    '',
    '## What changed per milestone',
    '',
    ...changesSection(laps),
    '## Ten decisions to double-check',
    '',
    ...decisionsSection(r),
    '',
    '## Rollbacks',
    '',
    ...rollbacksSection(laps),
    '',
    ...releaseLines(r),
    '## Screen tour',
    '',
    ...screensSection(laps, opts.forEmail === true),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

module.exports = { RISK_KINDS, rankRiskyDecisions, riskyDecisionsOf, buildReturnPack };
