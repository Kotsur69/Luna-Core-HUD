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
//
// Both emails list the run's feedback items with their status
// (lunasworkFeedback.emailLines).
//
// Media (deps.launch / deps.demo, optional):
//   SHIP       the launch assets (lunasworkLaunch.js, C10) are written into
//              the project's marketing/ first, then the return pack lists
//              them under ## Launch assets
//   demo       a walkthrough video per milestone gate and at SHIP
//              (lunasworkDemo.js, B13): attached to that email when small
//              enough, else linked by its place under runs/; every demo of
//              the run is listed under ## Demo videos. An unknown Remotion
//              setup becomes a "Needs you" line asking for its path.
// Neither ever blocks a report or an email: a failure is a line in them.
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
// Milestone emails already sent (run id + milestone), per LunaCore session.
const MAX_MILESTONE_KEYS = 200;

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

function evidence(run, forEmail) {
  const laps = list(run.laps).filter((l) => typeof l.evidenceDir === 'string' && l.evidenceDir);
  if (!laps.length && typeof run.evidenceDir === 'string' && run.evidenceDir) return [`Last iteration: ${evidenceName(run.evidenceDir, forEmail)}`];
  return laps.map((l) => `Iteration ${l.n}: ${evidenceName(l.evidenceDir, forEmail)}`);
}

const bullets = (items, none = '- none') => (items.length ? items.map((i) => `- ${i}`) : [none]);

// ---- media: launch assets (C10) and demo videos (B13) -------------------------------

/** A demo video: its full path locally, its place under LunaCore's runs/ in an email. */
const videoName = (file, runId, forEmail) =>
  (forEmail ? `runs/lunaswork-${oneLine(runId, 64)}/${oneLine(path.basename(String(file)), 120)}` : oneLine(file, 500));

/** "Needs you" lines from the media: the Remotion path when it is unknown. */
function mediaNeeds(media) {
  const demo = isObj(media) && isObj(media.demo) ? media.demo : null;
  return demo && isObj(demo.note) ? [`${oneLine(demo.note.en, 400)} (PL: ${oneLine(demo.note.pl, 400)})`] : [];
}

/** ## Launch assets: an intro line and the written files; null when there were none to make. */
function launchSection(media) {
  const launch = isObj(media) && isObj(media.launch) ? media.launch : null;
  if (!launch || launch.skipped) return null;
  if (!launch.ok) {
    const detail = launch.detail ? ` (${oneLine(launch.detail, 160)})` : '';
    return { intro: `The marketing agent wrote nothing: ${oneLine(launch.error || 'failed', 80)}${detail}.`, items: [] };
  }
  const files = (Array.isArray(launch.files) ? launch.files : []).slice(0, MAX_LIST).map((f) => oneLine(f, 200));
  return { intro: "In the project's marketing/ folder, not committed - review, then commit.", items: files };
}

/** ## Demo videos: every rendered video of the run, and why the last one did not render. */
function demoSection(run, media, forEmail) {
  const m = isObj(media) ? media : {};
  const videos = (Array.isArray(m.videos) ? m.videos : []).slice(0, MAX_LIST).map((f) => videoName(f, run.id, forEmail));
  const demo = isObj(m.demo) ? m.demo : null;
  if (!videos.length && !demo) return null;
  // Written before the email goes out, so it never claims the video was attached.
  let intro = '';
  if (demo && demo.error) {
    const props = demo.propsFile ? ` - its props are in ${forEmail ? oneLine(path.basename(path.dirname(demo.propsFile)), 80) : oneLine(demo.propsFile, 500)}` : '';
    intro = `The SHIP walkthrough did not render (${oneLine(demo.error, 80)})${props}.`;
  }
  // Nothing rendered and nothing to say (no evidence, or the path note in Needs you).
  if (!videos.length && !intro) return null;
  return { intro, items: videos };
}

function sectionMarkdown(title, section) {
  if (!section) return [];
  return [`## ${title}`, '', ...(section.intro ? [section.intro, ''] : []), ...(section.items.length ? [...bullets(section.items), ''] : [])];
}

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
 * @param {{now?:number, forEmail?:boolean, media?:{launch?:object, demo?:object, videos?:string[]}}} [extra]
 * @returns {string} markdown
 */
function buildRunReport(run, extra = {}) {
  const r = isObj(run) ? run : {};
  const verdict = verdictOf(r);
  const laps = list(r.laps);
  const needs = [...needsYou(r), ...mediaNeeds(extra.media)];
  const forEmail = extra.forEmail === true;
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
    '## Evidence',
    '',
    ...bullets(evidence(r, forEmail)),
    '',
    ...sectionMarkdown('Launch assets', launchSection(extra.media)),
    ...sectionMarkdown('Demo videos', demoSection(r, extra.media, forEmail)),
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

function mediaHtml(title, section, empty) {
  if (!section) return '';
  return h.section(title, `${section.intro ? `<p>${esc(section.intro)}</p>` : ''}${section.items.length || !section.intro ? h.list(section.items, empty) : ''}`);
}

/**
 * @param {object} run the finished run
 * @param {{now?:number, media?:{launch?:object, demo?:object, videos?:string[]}}} [extra]
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
    h.section('Needs you', h.list([...needsYou(r), ...mediaNeeds(extra.media)], 'Nothing - all done')),
    h.section('Verdict', `<p>${esc(`${VERDICT_LABEL[verdict]} - ${verdictWhy(r)}`)}</p>`),
    h.section('Iterations', h.table(ITERATION_HEAD, laps.map((l) => iterationCells(l).map((c) => esc(c))), 'No iteration finished')),
    h.section('Scores per milestone', scoresHtml(r)),
    h.section('Rollbacks', rollbackHtml(r)),
    h.section('Model choices', h.list(modelChoices(r), 'No model choice logged')),
    h.section('Decisions', h.list(decisions(r), 'No decisions')),
    h.section('Evidence', h.list(evidence(r, false), 'No evidence folder')),
    mediaHtml('Launch assets', launchSection(extra.media), 'No files'),
    mediaHtml('Demo videos', demoSection(r, extra.media, false), 'No video'),
  ].filter(Boolean).join('\n');
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
 * @param {{now?:number, logTail?:string, media?:{launch?:object, demo?:object, videos?:string[]}}} [opts]
 * @returns {{subject:string, text:string}}
 */
function buildRunEmail(run, opts = {}) {
  const r = isObj(run) ? run : {};
  const verdict = verdictOf(r);
  const needs = [...needsYou(r), ...mediaNeeds(opts.media)];
  const subject = `Luna's Work: ${repoName(r)} - ${VERDICT_LABEL[verdict]}${needs.length ? ' - needs you' : ''}`;
  const lines = ['NEEDS YOU', ...bullets(needs, '- nothing'), '', `${VERDICT_LABEL[verdict]}: ${verdictWhy(r)}`, ''];
  const tail = (verdict === 'plateau' || verdict === 'red') && opts.logTail ? plain(opts.logTail, MAX_TAIL_CHARS) : '';
  if (tail) lines.push('PLAYTEST LOG (latest entries)', '', tail, '');
  // The run is over: statuses only, no link to send more.
  if (Array.isArray(r.feedback) && r.feedback.length) lines.push(...feedbackLines(r.feedback, { link: null }), '');
  lines.push('FULL REPORT', '', plain(buildRunReport(r, { now: opts.now, forEmail: true, media: opts.media }), MAX_REPORT));
  return { subject, text: lines.join('\n') };
}

/** The DEMO VIDEO block of the milestone email; [] without a demo result. */
function demoEmailLines(run, demo) {
  if (!isObj(demo) || demo.skipped === 'no-evidence' || demo.skipped === 'bad-run') return [];
  let line;
  if (demo.attach) line = `Attached: ${oneLine(demo.attach.filename, 120)}`;
  else if (demo.ok && demo.link) line = `Too big to attach - saved as ${videoName(demo.link, run.id, true)} in LunaCore's config folder.`;
  else if (isObj(demo.note)) line = `${oneLine(demo.note.en, 400)}\n  PL: ${oneLine(demo.note.pl, 400)}`;
  else line = `Not rendered (${oneLine(demo.error || 'failed', 80)}) - the run goes on.`;
  return ['DEMO VIDEO', `- ${line}`, ''];
}

/**
 * The milestone email: a gate passed and the run goes on.
 * @param {object} run the run right after the gate (already on the next milestone)
 * @param {{milestone:string, demo?:object}} ctx the milestone that was reached, and its demo video result
 * @returns {{subject:string, text:string}}
 */
function buildMilestoneEmail(run, ctx) {
  const r = isObj(run) ? run : {};
  const reached = oneLine(ctx && ctx.milestone, 80) || 'a milestone';
  const pending = list(r.decisions).filter((d) => d.status === 'pending');
  const lap = Math.max(0, (Number.isInteger(r.iteration) ? r.iteration : 1) - 1);
  const lines = [
    `Milestone "${reached}" reached after iteration ${lap}. The run goes on${r.milestone ? ` with "${oneLine(r.milestone, 80)}"` : ''}.`,
    '',
    'WAITS FOR YOU',
    ...bullets(pending.map((d) => `${oneLine(d.question, 200)}${d.defaultAnswer ? '' : ' (no default - waits for you)'}`), '- nothing'),
    '',
    'SCORES PER MILESTONE',
    ...bullets(scoresByMilestone(r).map(([name, points]) => `${name}: ${scoreLine(points)}`)),
    '',
    ...demoEmailLines(r, ctx && ctx.demo),
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
 *   launch?: (run:object)=>Promise<object>,
 *   demo?: {make:(run:object, ctx:object)=>Promise<object>, videos:(runId:string)=>string[]},
 *   readFile?: (repoPath:string, name:string)=>string|null,
 *   writeFile?: (file:string, text:string)=>void,
 *   now?: ()=>number, log?: (line:string)=>void,
 * }} deps
 *   launch  the SHIP launch assets (lunasworkLaunch.runLaunchAssets) - SHIP only
 *   demo    the walkthrough video (lunasworkDemo.createDemoMaker)
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

  /** Writes the .md and .html. */
  function writeReports(run, media) {
    const base = path.join(deps.runsDir(), `lunaswork-${run.id}`);
    const out = { file: null, html: null, htmlText: null };
    try {
      writeFile(`${base}.md`, buildRunReport(run, { now: now(), media }));
      out.file = `${base}.md`;
    } catch (err) {
      log(`[lunaswork] report not written: ${errText(err)}`);
    }
    try {
      out.htmlText = renderRunReportHtml(run, { now: now(), media });
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

  /**
   * Sends; a send with the demo video that Gmail turned down (an HTTP error)
   * goes once more without it - the email matters more. A network error or
   * timeout is not retried: Gmail may have taken it, and a resend would
   * duplicate the email.
   */
  async function sendMail(m, msg, video) {
    if (!video) return m.sender.send(msg);
    try {
      return await m.sender.send({ ...msg, attachments: [...(msg.attachments || []), video] });
    } catch (err) {
      const rejected = err && err.reason === 'gmail-failed' && /^HTTP \d+$/.test(String(err.message));
      if (!rejected) throw err;
      log(`[lunaswork] email with the demo video failed, sending it without: ${errText(err)}`);
      return m.sender.send({ ...msg, text: `${msg.text}\n\n(The demo video could not be attached.)` });
    }
  }

  /** @returns {Promise<{sent:boolean, skipped?:string, error?:string}>} never rejects */
  async function mail(run, htmlText, media) {
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
        const email = buildRunEmail(run, { now: now(), logTail: playtestLogTail(readFile(run.repoPath, 'PLAYTEST_LOG.md')), media });
        const attachments = htmlText ? [{ filename: `lunaswork-run-${run.id}.html`, mimeType: 'text/html', content: htmlText }] : [];
        const video = media && media.demo && media.demo.attach ? media.demo.attach : null;
        await sendMail(m, { subject: email.subject, text: email.text, ...(attachments.length ? { attachments } : {}) }, video);
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

  /** A media step that must never break the report: its result, or a failure record. */
  async function safely(what, fn) {
    try {
      const res = await fn();
      return isObj(res) ? res : { ok: false, error: 'failed' };
    } catch (err) {
      log(`[lunaswork] ${what} failed: ${errText(err)}`);
      return { ok: false, error: 'crashed' };
    }
  }

  const milestonesSent = new Set();
  // Demo videos already made (run id + milestone), so a replayed hook never renders twice.
  const demosMade = new Set();
  const remember = (set, key) => {
    set.add(key);
    if (set.size > MAX_MILESTONE_KEYS) set.delete(set.values().next().value);
  };

  /** Why the milestone email does not go out, or null when it does. Throws on a broken sender. */
  function milestoneMailSkip(m) {
    if (!m) return 'no-mailer';
    const st = m.sender.status();
    const prefs = m.prefs.loadPrefs();
    if (!st.connected && prefs.godmodeEmail !== false) return 'not-connected';
    if (!m.enabled(prefs, st.connected)) return 'off';
    return null;
  }

  async function milestoneDemo(run, ctx, key) {
    if (!deps.demo || demosMade.has(key)) return null;
    remember(demosMade, key);
    const fallback = Math.max(0, (Number.isInteger(run.iteration) ? run.iteration : 1) - 1);
    const iteration = Number.isInteger(ctx && ctx.iteration) ? ctx.iteration : fallback;
    return safely('demo video', () => deps.demo.make(run, { ...ctx, iteration }));
  }

  /**
   * The controller's onMilestone hook: the demo video, then one email per run
   * and milestone with the video attached or linked.
   * @returns {Promise<{sent:boolean, skipped?:string, error?:string, demo?:object}>} never rejects
   */
  async function onMilestone(run, ctx) {
    const m = deps.mail;
    if (!isObj(run) || typeof run.id !== 'string' || !FILE_ID_RE.test(run.id)) return { sent: false, skipped: 'bad-run' };
    const key = `${run.id}|${oneLine(ctx && ctx.milestone, 80)}`;
    if (milestonesSent.has(key)) return { sent: false, skipped: 'duplicate' };
    let skip;
    try {
      skip = milestoneMailSkip(m);
    } catch (err) {
      skip = 'gmail-failed';
      log(`[lunaswork] milestone email failed: ${skip} ${errText(err)}`);
    }
    if (!skip) remember(milestonesSent, key);
    const demo = await milestoneDemo(run, ctx, key);
    const withDemo = demo ? { demo } : {};
    if (skip === 'gmail-failed') return { sent: false, error: skip, ...withDemo };
    if (skip) return { sent: false, skipped: skip, ...withDemo };
    try {
      const email = buildMilestoneEmail(run, { ...ctx, demo });
      await sendMail(m, { subject: email.subject, text: email.text }, demo && demo.attach ? demo.attach : null);
      return { sent: true, ...withDemo };
    } catch (err) {
      const reason = (err && err.reason) || 'gmail-failed';
      log(`[lunaswork] milestone email failed: ${reason} ${errText(err)}`);
      return { sent: false, error: reason, ...withDemo };
    }
  }

  /** At SHIP: the launch assets, then the last milestone's walkthrough; every demo of the run. */
  async function runMedia(run) {
    const media = {};
    if (run.verdict === 'ship' && deps.launch) media.launch = await safely('launch assets', () => deps.launch(run));
    if (!deps.demo) return media;
    const key = `${run.id}|${oneLine(run.milestone, 80)}`;
    if (run.verdict === 'ship' && !demosMade.has(key)) {
      remember(demosMade, key);
      media.demo = await safely('demo video', () => deps.demo.make(run, { milestone: run.milestone }));
    }
    try {
      media.videos = deps.demo.videos(run.id);
    } catch (err) {
      log(`[lunaswork] demo videos not listed: ${errText(err)}`);
    }
    return media;
  }

  /**
   * The controller's onRunEnd hook: media at SHIP, report files, then one email.
   * @returns {Promise<{ok:boolean, file?:string|null, html?:string|null, mail?:object, media?:object, skipped?:string}>}
   */
  async function onRunEnd(run) {
    if (!isObj(run) || typeof run.id !== 'string' || !FILE_ID_RE.test(run.id)) return { ok: false, skipped: 'bad-run' };
    if (!FINAL_VERDICTS.includes(run.verdict)) return { ok: false, skipped: 'not-ended' };
    const media = await runMedia(run);
    const written = writeReports(run, media);
    const sent = await mail(run, written.htmlText, media);
    return { ok: !!written.file, file: written.file, html: written.html, mail: sent, media };
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
