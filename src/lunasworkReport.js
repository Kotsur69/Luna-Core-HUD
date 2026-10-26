// ============================================================================
// LunaCore - Luna's Work run report + end-of-run email (LUNAS_WORK_PLAN 1.5d)
// ----------------------------------------------------------------------------
// When a run ends (SHIP / PLATEAU / RED / STOP), the controller's onRunEnd
// hands the finished run here, once. This module:
//
//   1. writes <runsDir>/lunaswork-<runId>.md and a standalone .html twin
//      (reportHtml.js), in this order:
//        ## Needs you         what waits for Mati, or 'Nothing - all done'
//        ## Verdict           the verdict and why
//        ## Iterations        cards planned / closed / opened, score,
//                             merge + self-check, checkpoint tag or rollback
//        ## Scores per milestone
//        ## Rollbacks         from / to tag, why, the reverted commits
//        ## Model choices     every choice with its reason (the run log)
//        ## Decisions         the Critic's DECISIONS.md lines, per iteration
//        ## Notes             loop-hook failures and skips per iteration (graph
//                             refresh, reviews, second opinion, i18n, Lighthouse)
//        ## Evidence          the evidence folder of every iteration
//        ## Timeline
//   2. emails it, under God Mode's "Email me when a run finishes" setting
//      (mailprefs.godmodeEmailOn). PLATEAU and RED mails carry the tail of
//      design/PLAYTEST_LOG.md. Never per iteration: only the run end calls
//      in, and the run id is marked sent in mail-state so a restart that
//      replays onRunEnd sends nothing.
//   3. onMilestone: a short email when a milestone gate passed and the run
//      goes on (B12, lean): what was reached, the scores, what waits for
//      Mati, and the feedback block (B17) - each item's status and the link
//      to the phone / web feedback form. Once per run and milestone.
//      LW 2.18: plus the decisions taken since the previous gate (the
//      DECISIONS.md lines), the milestone's key screenshots inline and an
//      optional TIME TO SHIP line (only when ctx.timeToShip is given); the
//      sending and dedupe live in src/lunasworkMail.js.
//   4. LW 2.18: the "while you were away" return pack
//      (src/lunasworkReturn.js), saved as <runsDir>/lunaswork-<id>-return.md
//      and attached to the run email with the screen tour's screenshots.
//      LW 2.26: it lists the repo's legal drafts (files marked "DRAFT -
//      check before publishing", lunasworkLegal.findDraftFiles).
//
// Both emails list the run's feedback items with their status
// (lunasworkFeedback.emailLines).
//
// Model text (card titles, journey names, decisions, commit subjects) is
// quoted on one line with control characters out; the HTML escapes every
// string. The email names the repo, never its path, and shows evidence
// folders by name only.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const h = require('./reportHtml');
const pack = require('./lunasworkPack');
const { PLATEAU_WINDOW, RED_STREAK } = require('./lunasworkRules');
const { emailLines: feedbackLines } = require('./lunasworkFeedback');
const { decisionLine } = require('./lunasworkDecisions');
const { buildReturnPack } = require('./lunasworkReturn');
const { createMilestoneMailer, screenshotAttachments } = require('./lunasworkMail');
const { findDraftFiles } = require('./lunasworkLegal');

// The run email carries the HTML report and the return pack: room for three screenshots (gmailsend caps at 5).
const RUN_MAIL_IMAGES = 3;

const FINAL_VERDICTS = ['ship', 'plateau', 'red', 'stop'];
const VERDICT_LABEL = { ship: 'SHIP', plateau: 'PLATEAU', red: 'RED', stop: 'STOP' };
const VERDICT_TONE = { ship: 'ok', plateau: 'warn', red: 'bad', stop: 'muted' };
// A run id that may name a file: no dots, so no traversal (lunasworkRules' SAFE_ID is wider).
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The id mail-state keeps sent runs under (mailprefs RUN_ID_RE).
const MAIL_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_LIST = 200;
const MAX_LINE = 300;
const MAX_TAIL_LINES = 40;
const MAX_TAIL_CHARS = 6000;
const MAX_REPORT = 60000;
const MAX_MAIL_RUNS = 50;

const STOP_REASONS = {
  killSwitch: 'stopped with the kill switch',
  steer: 'a `stop` steer card',
  stepFailed: 'one step failed 3 times in a row',
  packIncomplete: 'the design pack is not complete',
  projectMissing: "the project's folder is gone",
  noProfile: 'no confirmed project profile',
  godModeKilled: 'God Mode was killed during a build',
  lowDisk: 'the disk was almost full (under 5 GB free on the project drive)',
  updatesNotPaused: 'Windows Update could not be paused and Mati chose to stop',
};
// Stop reasons that leave work for Mati (the others were his own choice).
const STOP_NEEDS = {
  stepFailed: "A step kept failing - read the run log in the Luna's Work panel, fix the cause, then start again.",
  packIncomplete: 'Finish the design pack (the interview), then start again.',
  projectMissing: "The project's folder is gone - check the project in LunaCore.",
  noProfile: "Set the project profile in Luna's Work settings, then start again.",
  godModeKilled: 'God Mode was killed mid-build - check its board, then start again.',
  lowDisk: "Free some space on the project's drive, then start again.",
  updatesNotPaused: 'Start LunaCore as administrator (or pause Windows Update by hand), then start again.',
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj).slice(0, MAX_LIST) : []);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_LINE) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const code = (v, max = 200) => `\`${oneLine(v, max).replace(/`/g, "'") || '-'}\``;
const cell = (v) => String(v == null || v === '' ? '-' : v).replace(/\|/g, '\\|');
const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const errText = (err) => (err instanceof Error ? err.message : String(err));

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

const repoName = (run) => oneLine(path.basename(String(run.repoPath || '')), 100) || 'repo';
const verdictOf = (run) => (FINAL_VERDICTS.includes(run.verdict) ? run.verdict : 'stop');
const evidenceName = (dir, forEmail) => (forEmail ? oneLine(path.basename(String(dir)), 120) : oneLine(dir, 500));

// ---- content (shared by markdown and HTML) ------------------------------------------

/** The verdict in one sentence. */
function verdictWhy(run) {
  const verdict = verdictOf(run);
  const milestone = run.milestone ? ` "${oneLine(run.milestone, 80)}"` : '';
  if (verdict === 'ship') return 'The Critic said every gate in SHIP_CRITERIA.md passes, and a fresh SHIP-confirmation Playtester agreed.';
  if (verdict === 'plateau') return `No score gain and no card closed in the last ${PLATEAU_WINDOW} iterations of milestone${milestone}.`;
  if (verdict === 'red') return `The merged result stayed red after fix-up in ${RED_STREAK} iterations in a row, so it was not pushed to the base branch.`;
  const reason = run.stopReason ? STOP_REASONS[run.stopReason] || oneLine(run.stopReason, 80) : 'stopped';
  return `Stopped: ${reason}.`;
}

const rollbackOf = (lap) => (lap.checkpoint && isObj(lap.checkpoint.rollback) ? lap.checkpoint.rollback : null);

/** What waits for Mati, one line each. */
function needsYou(run) {
  const verdict = verdictOf(run);
  const laps = list(run.laps);
  const last = laps[laps.length - 1];
  const needs = [];
  if (verdict === 'red') {
    const branch = last && last.integrationBranch ? ` The red result is on ${code(last.integrationBranch)}.` : '';
    needs.push(`The base branch is not pushable: fix the red self-check by hand.${branch}`);
  }
  if (verdict === 'plateau') needs.push('No progress for a while: read the PLAYTEST_LOG tail, then steer with a card or sharpen the design pack.');
  if (verdict === 'stop' && STOP_NEEDS[run.stopReason]) needs.push(STOP_NEEDS[run.stopReason]);
  for (const lap of laps) {
    const rb = rollbackOf(lap);
    if (rb && rb.ok) needs.push(`Iteration ${lap.n} was rolled back (${oneLine(rb.why || rb.reason, 200)}) - its work is a bug card now.`);
    else if (rb) needs.push(`Iteration ${lap.n}: the rollback failed (${oneLine(rb.error || 'failed', 80)}) - the base branch still has that work.`);
    else if (lap.checkpoint && lap.checkpoint.tagError) needs.push(`Iteration ${lap.n}: the checkpoint tag was not pushed (${oneLine(lap.checkpoint.tagError, 80)}).`);
  }
  // LW 2.22a: the release after the docs iteration.
  const release = isObj(run.shipDocs) && isObj(run.shipDocs.release) ? run.shipDocs.release : null;
  if (release && !release.ok) {
    needs.push(`The release did not go out (${oneLine(release.error, 80)}${release.detail ? `: ${oneLine(release.detail, 160)}` : ''}) - tag it and run gh release create by hand.`);
  }
  if (verdict === 'stop' && isObj(run.shipDocs) && !release) needs.push('Every gate passed, but the docs iteration (README, user guide, release) did not go green - finish it by hand.');
  return needs;
}

function selfCheckText(lap) {
  if (lap.skipped) return 'nothing built';
  const parts = [lap.selfCheck];
  if (Number.isFinite(lap.fixups) && lap.fixups > 0) parts.push(`${lap.fixups} fix-up`);
  if (lap.integrationBranch) parts.push(`kept on ${oneLine(lap.integrationBranch, 120)}`);
  if (lap.buildError) parts.push(oneLine(lap.buildError, 120));
  return parts.join(', ');
}

function checkpointText(lap) {
  const rb = rollbackOf(lap);
  const cp = lap.checkpoint || {};
  if (rb && rb.ok) return `rolled back to ${oneLine(rb.toTag, 120)}`;
  if (rb) return `rollback failed (${oneLine(rb.error || 'failed', 60)})`;
  if (cp.tag) return oneLine(cp.tag, 120);
  if (cp.tagError) return `tag failed (${oneLine(cp.tagError, 60)})`;
  if (cp.note) return oneLine(cp.note, 120);
  return '-';
}

const ITERATION_HEAD = ['#', 'Milestone', 'Score', 'Cards closed', 'Cards opened', 'Merge / self-check', 'Checkpoint'];

function iterationCells(lap) {
  return [
    String(lap.n),
    oneLine(lap.milestone, 80) || '-',
    Number.isFinite(lap.score) ? String(lap.score) : '-',
    `${lap.cardsClosed.length} / ${lap.cardsPlanned}`,
    lap.cardsUpdated ? `${lap.cardsOpened} new, ${lap.cardsUpdated} updated` : String(lap.cardsOpened),
    selfCheckText(lap),
    checkpointText(lap),
  ];
}

/** Scores per milestone, oldest first, from the run history. */
function scoresByMilestone(run) {
  const out = new Map();
  for (const r of list(run.history)) {
    if (!Number.isFinite(r.score)) continue;
    const key = oneLine(r.milestone, 80) || '(no milestone)';
    out.set(key, [...(out.get(key) || []), { n: r.n, score: r.score, rolledBack: r.rolledBack === true }]);
  }
  return [...out.entries()];
}

const scoreLine = (points) => points.map((p) => `${p.score}${p.rolledBack ? ' (rolled back)' : ''}`).join(' -> ');

function rollbacks(run) {
  return list(run.laps).map((lap) => ({ lap, rb: rollbackOf(lap) })).filter((x) => x.rb);
}

function modelChoices(run) {
  return list(run.log)
    .filter((e) => e.kind === 'model')
    .map((e) => `Iteration ${e.n}, ${oneLine(e.role, 20)}: ${oneLine(e.model, 20)} (${oneLine(e.reason || 'setting', 160)})${Number.isFinite(e.card) ? `, card ${e.card}` : ''}`);
}

function decisions(run) {
  return list(run.laps).flatMap((lap) =>
    list(lap.decisions).map((d) => `Iteration ${lap.n}: chose ${oneLine(d.choice, 200)} because ${oneLine(d.because, 200)}`),
  );
}

/** The loop hooks' notes (src/lunasworkLoopHooks.js): what failed or was skipped. */
function hookNotes(run) {
  return list(run.laps).flatMap((lap) => (Array.isArray(lap.notes) ? lap.notes : [])
    .filter((n) => typeof n === 'string' && n)
    .map((n) => `Iteration ${lap.n}: ${oneLine(n, MAX_LINE)}`));
}

function evidence(run, forEmail) {
  const laps = list(run.laps).filter((l) => typeof l.evidenceDir === 'string' && l.evidenceDir);
  if (!laps.length && typeof run.evidenceDir === 'string' && run.evidenceDir) return [`Last iteration: ${evidenceName(run.evidenceDir, forEmail)}`];
  return laps.map((l) => `Iteration ${l.n}: ${evidenceName(l.evidenceDir, forEmail)}`);
}

const bullets = (items, none = '- none') => (items.length ? items.map((i) => `- ${i}`) : [none]);

// ---- markdown ---------------------------------------------------------------------

function rollbackMarkdown(run) {
  const out = [];
  for (const { lap, rb } of rollbacks(run)) {
    const why = oneLine(rb.why || rb.reason, 200);
    out.push(
      rb.ok
        ? `- Iteration ${lap.n}: ${code(rb.fromTag)} -> ${code(rb.toTag)} - ${why}`
        : `- Iteration ${lap.n}: rollback to ${code(rb.toTag)} failed (${oneLine(rb.error || 'failed', 80)}${rb.detail ? `: ${oneLine(rb.detail, 160)}` : ''}) - ${why}`,
    );
    for (const c of list(rb.reverted)) out.push(`  - reverted ${code(String(c.sha).slice(0, 7), 10)} ${oneLine(c.subject, 160)}`);
    if (rb.ok) out.push(`  - ${(rb.cards || []).length} bug card(s), ${(rb.reopened || []).length} card(s) reopened${rb.decision ? ', logged in DECISIONS.md' : ''}`);
  }
  return out.length ? out : ['- none'];
}

function iterationTable(laps) {
  if (!laps.length) return ['No iteration finished.'];
  return [
    `| ${ITERATION_HEAD.join(' | ')} |`,
    `|${ITERATION_HEAD.map(() => '---').join('|')}|`,
    ...laps.map((l) => `| ${iterationCells(l).map(cell).join(' | ')} |`),
  ];
}

/**
 * @param {object} run the finished run (the controller's onRunEnd snapshot)
 * @param {{now?:number, forEmail?:boolean}} [extra]
 * @returns {string} markdown
 */
function buildRunReport(run, extra = {}) {
  const r = isObj(run) ? run : {};
  const verdict = verdictOf(r);
  const laps = list(r.laps);
  const needs = needsYou(r);
  const ended = Number.isFinite(r.endedAt) ? r.endedAt : extra.now;
  const lines = [
    `# Luna's Work run ${oneLine(r.id, 64)}`,
    '',
    `- Repo: ${repoName(r)}`,
    `- Verdict: ${VERDICT_LABEL[verdict]}`,
    `- Iterations: ${Number.isInteger(r.iteration) ? r.iteration : laps.length}`,
    `- Milestone: ${oneLine(r.milestone, 80) || '-'}`,
    '',
    '## Needs you',
    '',
    ...(needs.length ? bullets(needs) : ['Nothing - all done']),
    '',
    '## Verdict',
    '',
    `${VERDICT_LABEL[verdict]} - ${verdictWhy(r)}`,
    '',
    '## Iterations',
    '',
    ...iterationTable(laps),
    '',
    '## Scores per milestone',
    '',
    ...bullets(scoresByMilestone(r).map(([m, points]) => `${m}: ${scoreLine(points)}`)),
    '',
    '## Rollbacks',
    '',
    ...rollbackMarkdown(r),
    '',
    '## Model choices',
    '',
    ...bullets(modelChoices(r)),
    '',
    '## Decisions',
    '',
    ...bullets(decisions(r)),
    '',
    '## Notes',
    '',
    ...bullets(hookNotes(r)),
    '',
    '## Evidence',
    '',
    ...bullets(evidence(r, extra.forEmail === true)),
    '',
    '## Timeline',
    '',
    `- Started: ${fmt(r.startedAt)} UTC`,
    `- Ended: ${fmt(ended)} UTC`,
    `- Took: ${Number.isFinite(r.startedAt) && Number.isFinite(ended) ? duration(ended - r.startedAt) : '-'}`,
  ];
  return `${lines.join('\n')}\n`;
}

// ---- HTML -------------------------------------------------------------------------

const esc = h.escapeHtml;

function rollbackHtml(run) {
  const rows = rollbacks(run).map(({ lap, rb }) => [
    esc(String(lap.n)),
    rb.ok ? h.pill('rolled back', 'warn') : h.pill('failed', 'bad'),
    esc(`${oneLine(rb.fromTag, 120) || '-'} -> ${oneLine(rb.toTag, 120) || '-'}`),
    esc(oneLine(rb.why || rb.reason, 200)),
    esc(list(rb.reverted).map((c) => `${String(c.sha).slice(0, 7)} ${oneLine(c.subject, 120)}`).join('; ') || oneLine(rb.error, 80) || '-'),
  ]);
  return h.table(['#', 'Result', 'From -> to', 'Why', 'Reverted commits'], rows, 'No rollbacks');
}

function scoresHtml(run) {
  const groups = scoresByMilestone(run);
  if (!groups.length) return h.empty('No scores');
  return groups
    .map(([m, points]) => {
      const rows = points.map((p) => ({ label: `#${p.n}`, value: p.score, tone: p.rolledBack ? 'warn' : 'info' }));
      return `<h3>${esc(m)}</h3>${h.barChart(rows, { emptyText: 'No score above 0' })}`;
    })
    .join('');
}

/**
 * @param {object} run the finished run
 * @param {{now?:number}} [extra]
 * @returns {string} a standalone HTML page, every string escaped
 */
function renderRunReportHtml(run, extra = {}) {
  const r = isObj(run) ? run : {};
  const verdict = verdictOf(r);
  const laps = list(r.laps);
  const ended = Number.isFinite(r.endedAt) ? r.endedAt : extra.now;
  const closed = laps.reduce((sum, l) => sum + l.cardsClosed.length, 0);
  const opened = laps.reduce((sum, l) => sum + l.cardsOpened, 0);
  const rolled = rollbacks(r).filter((x) => x.rb.ok).length;
  const body = [
    h.cards([
      { label: 'Verdict', value: VERDICT_LABEL[verdict], tone: VERDICT_TONE[verdict] },
      { label: 'Iterations', value: laps.length, tone: 'info' },
      { label: 'Cards closed', value: closed, tone: closed ? 'ok' : 'muted' },
      { label: 'Cards opened', value: opened, tone: 'muted' },
      { label: 'Rollbacks', value: rolled, tone: rolled ? 'warn' : 'muted' },
    ]),
    h.section('Needs you', h.list(needsYou(r), 'Nothing - all done')),
    h.section('Verdict', `<p>${esc(`${VERDICT_LABEL[verdict]} - ${verdictWhy(r)}`)}</p>`),
    h.section('Iterations', h.table(ITERATION_HEAD, laps.map((l) => iterationCells(l).map((c) => esc(c))), 'No iteration finished')),
    h.section('Scores per milestone', scoresHtml(r)),
    h.section('Rollbacks', rollbackHtml(r)),
    h.section('Model choices', h.list(modelChoices(r), 'No model choice logged')),
    h.section('Decisions', h.list(decisions(r), 'No decisions')),
    h.section('Notes', h.list(hookNotes(r), 'No notes')),
    h.section('Evidence', h.list(evidence(r, false), 'No evidence folder')),
  ].join('\n');
  return h.page({
    title: `Luna's Work run ${oneLine(r.id, 64)}`,
    subtitle: `${repoName(r)} · ${VERDICT_LABEL[verdict]} · milestone ${oneLine(r.milestone, 80) || '-'}`,
    body,
    footer: `Started ${fmt(r.startedAt)} UTC · ended ${fmt(ended)} UTC`,
  });
}

// ---- email --------------------------------------------------------------------------

/** The last lines of PLAYTEST_LOG.md, capped; '' when there is none. */
function playtestLogTail(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  return lines.slice(-MAX_TAIL_LINES).join('\n').slice(-MAX_TAIL_CHARS);
}

// Control characters out, newlines kept.
// eslint-disable-next-line no-control-regex
const plain = (text, max) => String(text || '').slice(0, max).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

/**
 * @param {object} run the finished run
 * @param {{now?:number, logTail?:string}} [opts]
 * @returns {{subject:string, text:string}}
 */
function buildRunEmail(run, opts = {}) {
  const r = isObj(run) ? run : {};
  const verdict = verdictOf(r);
  const needs = needsYou(r);
  const subject = `Luna's Work: ${repoName(r)} - ${VERDICT_LABEL[verdict]}${needs.length ? ' - needs you' : ''}`;
  const lines = ['NEEDS YOU', ...bullets(needs, '- nothing'), '', `${VERDICT_LABEL[verdict]}: ${verdictWhy(r)}`, ''];
  const tail = (verdict === 'plateau' || verdict === 'red') && opts.logTail ? plain(opts.logTail, MAX_TAIL_CHARS) : '';
  if (tail) lines.push('PLAYTEST LOG (latest entries)', '', tail, '');
  // The run is over: statuses only, no link to send more.
  if (Array.isArray(r.feedback) && r.feedback.length) lines.push(...feedbackLines(r.feedback, { link: null }), '');
  lines.push('FULL REPORT', '', plain(buildRunReport(r, { now: opts.now, forEmail: true }), MAX_REPORT));
  return { subject, text: lines.join('\n') };
}

/**
 * LW 2.18: the DECISIONS.md lines taken since the previous passed gate - the
 * Critic's per lap and the decision queue's answers - for the milestone email.
 */
function decisionsSinceGate(run) {
  const laps = list(run.laps).sort((a, b) => a.n - b.n);
  const previous = laps.slice(0, -1).filter((l) => l.gate === true).pop();
  const since = previous ? previous.n : 0;
  const critic = laps
    .filter((l) => l.n > since)
    .flatMap((l) => list(l.decisions).map((d) => `- Chose ${oneLine(d.choice, 200)} because ${oneLine(d.because, 200)} (Critic, iteration ${l.n})`));
  const queue = list(run.decisions)
    .filter((d) => d.status === 'answered' && (!Number.isInteger(d.iteration) || d.iteration > since))
    .map((d) => {
      try {
        return decisionLine(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((line) => oneLine(line, 400));
  return [...critic, ...queue];
}

/** LW 2.25a: the design-variant choices still open, with their deadline ([] when none). */
function variantLines(r) {
  const open = list(r.variants).filter((e) => isObj(e) && e.status === 'asked');
  if (!open.length) return [];
  const deadlineOf = (e) => {
    const d = list(r.decisions).find((x) => x.id === e.decisionId);
    return d && Number.isFinite(d.deadline) ? ` by ${new Date(d.deadline).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  };
  return [
    'DESIGN VARIANTS - PICK ONE (screenshots inline below)',
    ...open.map((e) => `- "${oneLine(e.screen, 80)}": variants ${list(e.shots).map((s) => String(s.variant).toUpperCase()).join(', ')}`
      + ` - answer its decision with a letter${deadlineOf(e)}, or the Critic picks`),
    '',
  ];
}

/**
 * The milestone email: a gate passed and the run goes on.
 * @param {object} run the run right after the gate (already on the next milestone)
 * @param {{milestone:string, timeToShip?:string, screenshots?:{name:string, n:number, filename:string}[]}} ctx
 *   the milestone that was reached; timeToShip = the estimate (the line only renders when given);
 *   screenshots = the inline images attached (lunasworkMail)
 * @returns {{subject:string, text:string}}
 */
function buildMilestoneEmail(run, ctx) {
  const r = isObj(run) ? run : {};
  const c = isObj(ctx) ? ctx : {};
  const reached = oneLine(c.milestone, 80) || 'a milestone';
  const pending = list(r.decisions).filter((d) => d.status === 'pending');
  const lap = Math.max(0, (Number.isInteger(r.iteration) ? r.iteration : 1) - 1);
  const timeToShip = oneLine(c.timeToShip, 120);
  const shots = list(c.screenshots);
  const lines = [
    `Milestone "${reached}" reached after iteration ${lap}. The run goes on${r.milestone ? ` with "${oneLine(r.milestone, 80)}"` : ''}.`,
    '',
    ...(timeToShip ? [`TIME TO SHIP: ${timeToShip}`, ''] : []),
    'WAITS FOR YOU',
    ...bullets(pending.map((d) => `${oneLine(d.question, 200)}${d.defaultAnswer ? '' : ' (no default - waits for you)'}`), '- nothing'),
    '',
    'SCORES PER MILESTONE',
    ...bullets(scoresByMilestone(r).map(([name, points]) => `${name}: ${scoreLine(points)}`)),
    '',
    'DECISIONS SINCE THE LAST GATE (DECISIONS.md)',
    ...(decisionsSinceGate(r).length ? decisionsSinceGate(r) : ['- none']),
    '',
    ...variantLines(r),
    ...(shots.length ? ['SCREENSHOTS (inline below)', ...shots.map((s) => `- ${oneLine(s.name, 80)} (iteration ${s.n}): ${oneLine(s.filename, 100)}`), ''] : []),
    ...feedbackLines(r.feedback),
  ];
  return { subject: `Luna's Work: ${repoName(r)} - milestone ${reached} reached`, text: lines.join('\n') };
}

// ---- the onRunEnd hook ----------------------------------------------------------------

/**
 * @param {{
 *   runsDir: ()=>string,
 *   mail?: {sender:{status:Function, send:Function}, prefs:{loadPrefs:Function, loadState:Function, updateState:Function},
 *     enabled:(prefs:object, connected:boolean)=>boolean},
 *   readFile?: (repoPath:string, name:string)=>string|null,
 *   writeFile?: (file:string, text:string)=>void,
 *   now?: ()=>number, log?: (line:string)=>void,
 * }} deps
 */
function createLunasWorkReporter(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const readFile = deps.readFile || ((repoPath, name) => pack.readPackFile(repoPath, name));
  const writeFile =
    deps.writeFile ||
    ((file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    });
  // One send at a time per run, on top of the persisted mark.
  const inFlight = new Set();
  const findDrafts = typeof deps.findDrafts === 'function' ? deps.findDrafts : findDraftFiles;

  /** LW 2.26: the repo's legal drafts for the return pack; [] when they cannot be listed. */
  function legalDrafts(run) {
    try {
      return run.repoPath ? findDrafts(run.repoPath) : [];
    } catch (err) {
      log(`[lunaswork] legal drafts not listed: ${errText(err)}`);
      return [];
    }
  }

  /** Writes the .md, the -return.md (LW 2.18) and the .html. */
  function writeReports(run) {
    const base = path.join(deps.runsDir(), `lunaswork-${run.id}`);
    const out = { file: null, html: null, htmlText: null, returnFile: null };
    try {
      writeFile(`${base}.md`, buildRunReport(run, { now: now() }));
      out.file = `${base}.md`;
    } catch (err) {
      log(`[lunaswork] report not written: ${errText(err)}`);
    }
    try {
      writeFile(`${base}-return.md`, buildReturnPack(run, { legalDrafts: legalDrafts(run) }));
      out.returnFile = `${base}-return.md`;
    } catch (err) {
      log(`[lunaswork] return pack not written: ${errText(err)}`);
    }
    try {
      out.htmlText = renderRunReportHtml(run, { now: now() });
      writeFile(`${base}.html`, out.htmlText);
      out.html = `${base}.html`;
    } catch (err) {
      log(`[lunaswork] html report not written: ${errText(err)}`);
    }
    return out;
  }

  // mailprefs RUN_KEY_RE shape: '<count>|<word>'.
  const mailKey = (run) => `${Math.max(0, Math.min(9999, Number.isInteger(run.iteration) ? run.iteration : 0))}|${verdictOf(run)}`;

  function markSent(m, run) {
    m.prefs.updateState((s) => {
      const godmode = { ...s.godmode };
      delete godmode[run.id];
      godmode[run.id] = mailKey(run);
      const ids = Object.keys(godmode);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_MAIL_RUNS))) delete godmode[id];
      return { ...s, godmode };
    });
  }

  /** @returns {Promise<{sent:boolean, skipped?:string, error?:string}>} never rejects */
  async function mail(run, htmlText) {
    const m = deps.mail;
    if (!m) return { sent: false, skipped: 'no-mailer' };
    try {
      const st = m.sender.status();
      const prefs = m.prefs.loadPrefs();
      // Not connected is told apart from switched off (same rule as God Mode's mail).
      if (!st.connected && prefs.godmodeEmail !== false) return { sent: false, skipped: 'not-connected' };
      if (!m.enabled(prefs, st.connected)) return { sent: false, skipped: 'off' };
      const persist = MAIL_ID_RE.test(run.id);
      if (persist && m.prefs.loadState().godmode[run.id]) return { sent: false, skipped: 'duplicate' };
      if (inFlight.has(run.id)) return { sent: false, skipped: 'busy' };
      inFlight.add(run.id);
      try {
        const email = buildRunEmail(run, { now: now(), logTail: playtestLogTail(readFile(run.repoPath, 'PLAYTEST_LOG.md')) });
        // LW 2.18: the return pack (file names only, no local paths) and the screen tour's screenshots.
        const shots = screenshotAttachments(run, { max: RUN_MAIL_IMAGES, readImage: deps.readImage });
        const attachments = [
          ...(htmlText ? [{ filename: `lunaswork-run-${run.id}.html`, mimeType: 'text/html', content: htmlText }] : []),
          { filename: `lunaswork-${run.id}-return.md`, mimeType: 'text/markdown', content: buildReturnPack(run, { forEmail: true, legalDrafts: legalDrafts(run) }) },
          ...shots.map(({ filename, mimeType, content }) => ({ filename, mimeType, content })),
        ];
        await m.sender.send({ subject: email.subject, text: email.text, ...(attachments.length ? { attachments } : {}) });
        if (persist) markSent(m, run);
        return { sent: true };
      } finally {
        inFlight.delete(run.id);
      }
    } catch (err) {
      const reason = (err && err.reason) || 'gmail-failed';
      log(`[lunaswork] run email failed: ${reason} ${errText(err)}`);
      return { sent: false, error: reason };
    }
  }

  // LW 2.18: one email per run and milestone, with the milestone's screenshots inline.
  const milestoneMailer = createMilestoneMailer({ mail: deps.mail, build: buildMilestoneEmail, readImage: deps.readImage, log });

  /**
   * The controller's onMilestone hook: one email per run and milestone.
   * @returns {Promise<{sent:boolean, images?:number, skipped?:string, error?:string}>} never rejects
   */
  function onMilestone(run, ctx) {
    return milestoneMailer.send(run, ctx);
  }

  /**
   * The controller's onRunEnd hook: report files, then one email.
   * @returns {Promise<{ok:boolean, file?:string|null, html?:string|null, mail?:object, skipped?:string}>}
   */
  async function onRunEnd(run) {
    if (!isObj(run) || typeof run.id !== 'string' || !FILE_ID_RE.test(run.id)) return { ok: false, skipped: 'bad-run' };
    if (!FINAL_VERDICTS.includes(run.verdict)) return { ok: false, skipped: 'not-ended' };
    const written = writeReports(run);
    const sent = await mail(run, written.htmlText);
    return { ok: !!written.file, file: written.file, html: written.html, returnFile: written.returnFile, mail: sent };
  }

  return { onRunEnd, onMilestone };
}

/** <runsDir>/lunaswork-<runId>.md for a file-safe run id, else null. */
function reportFileFor(runsDir, runId) {
  if (typeof runId !== 'string' || !FILE_ID_RE.test(runId) || typeof runsDir !== 'string' || !runsDir) return null;
  return path.join(runsDir, `lunaswork-${runId}.md`);
}

module.exports = {
  FINAL_VERDICTS,
  buildRunReport,
  renderRunReportHtml,
  buildRunEmail,
  buildMilestoneEmail,
  playtestLogTail,
  needsYou,
  verdictWhy,
  reportFileFor,
  createLunasWorkReporter,
};
