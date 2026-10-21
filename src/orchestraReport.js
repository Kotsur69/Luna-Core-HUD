// ============================================================================
// LunaCore - God Mode v2 run report (ORCHESTRATOR_PLAN.md slice 5, idea #8)
// ----------------------------------------------------------------------------
// Pure text: the morning report (markdown, written to
// <userDir>/runs/<plan>.md by main) and the note a package that did not make
// it leaves on its to-dos, so the next run - or Mati - starts knowingly.
//
// The report answers at a glance (GM never blocks 5/5), in this order:
//   ## Needs you               what waits for Mati, or 'Nothing - all done'
//   ## Manual actions          what he has to apply live (migrations, ...)
//   ## Merged / pushed         per package: branch, sha, PR / merged, notes
//   ## Self-check              tests / syntax / smoke / fix-ups
//   ## Allow-rule suggestions  approval prompts that stalled workers
//   ## Timeline                started, finished, time paused on limits
// The header keeps the Repo / Result / Integration lines nightlydigest.js
// parses. Details, tails and manual actions can quote model or test output:
// control characters out, one line each, capped.
// ============================================================================

'use strict';

const path = require('path');

const NOTE_TAG = '[LunaCore run';
const MAX_NOTE_CHARS = 600;
const MAX_ITEM_CHARS = 300;
const MAX_TAIL_LINES = 15;
const MAX_LIST = 50;
// A run id as orchestra.js makes it (`p` + base-36 time): the only thing the
// board's "Open report" button sends to main.
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const NEXT_STEP = 'merge by hand in a session, then Retry';

const STATE_LABEL = {
  pushed: 'pushed',
  stalled: 'stalled',
  failed: 'could not launch',
  closed: 'tab closed',
  killed: 'killed',
  pending: 'not started',
  launched: 'running',
  finishing: 'finishing',
};

const MANUAL_GROUPS = [
  ['migration', 'Migrations'],
  ['edgeFunction', 'Edge functions'],
  ['env', 'Env vars'],
  ['note', 'Notes'],
];

const CHECKS = [
  ['tests', 'Tests'],
  ['syntax', 'Syntax'],
  ['smoke', 'Smoke'],
];

const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const cell = (v) => String(v == null || v === '' ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
// The reason can quote a worker's own words (LUNA_BLOCKED) and a self-check
// tail is test output: one line, no control characters, capped.
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = 200) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);
/** Inline code for a value that may hold anything: no backticks inside. */
const code = (v, max = 160) => `\`${oneLine(v, max).replace(/`/g, "'") || '-'}\``;
const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_LIST) : []);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sha7 = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v.slice(0, 7).toLowerCase() : '');

/** "1 h 5 min", "12 min", "0 min". */
function duration(ms) {
  const min = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0;
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

/** "verifyFailed - 2 tests failing" style reason, or ''. */
function reasonOf(pkg) {
  if (!pkg.error) return '';
  return pkg.detail ? `${pkg.error} - ${pkg.detail}` : pkg.error;
}

/** The self-check went red: one of its checks failed. */
const selfCheckRed = (sc) => isObject(sc) && CHECKS.some(([key]) => sc[key] === 'failed');

/** Why an unfinished package stopped, with what the automatic ladder tried. */
function stopReason(pkg, view) {
  if (pkg.error === 'approvalTimeout') {
    const min = isObject(view.options) ? view.options.unattendedApprovalMin : null;
    const after = Number.isFinite(min) && min > 0 ? ` longer than ${min} min` : '';
    const rule = pkg.detail ? ` (rule: ${oneLine(pkg.detail, 120)})` : '';
    return `waited on an approval prompt${after}, tab closed${rule}`;
  }
  const parts = [oneLine(reasonOf(pkg)) || STATE_LABEL[pkg.state] || oneLine(pkg.state, 24)];
  if (pkg.autoRetries > 0) parts.push(`gave up after ${pkg.autoRetries} automatic retries`);
  if (pkg.autoResumed && pkg.state === 'stalled') parts.push('stalled again after an automatic resume');
  if (pkg.terminal) parts.push('nothing automatic will pick it up again');
  return parts.join('; ');
}

const label = (pkg) => `${code(pkg.id, 64)} ${oneLine(pkg.title, 120)}`.trim();

/** One Needs-you line per package that did not make it. */
function packageLines(view, skippedIds) {
  const out = [];
  for (const p of list(view.packages)) {
    if (!isObject(p) || p.state === 'pushed' || skippedIds.has(p.id)) continue;
    if (p.state === 'pending' && p.blockedBy) {
      out.push(`${label(p)} - blocked by ${code(p.blockedBy, 64)}, which will not finish by itself`);
    } else {
      out.push(`${label(p)} - ${oneLine(STATE_LABEL[p.state] || p.state, 24)}: ${stopReason(p, view)}`);
    }
  }
  return out;
}

function skippedLine(s, view) {
  const files = list(s.files).slice(0, 10).map((f) => code(f)).join(', ');
  const pkg = list(view.packages).find((p) => isObject(p) && p.id === s.id) || {};
  const why = oneLine(s.detail);
  const stage = oneLine(s.stage, 32) || 'merge';
  return `${label({ id: s.id, title: pkg.title })} - skipped at ${stage}${why ? ` (${why})` : ''}${
    files ? `; files: ${files}` : ''
  }. Next step: ${NEXT_STEP}.`;
}

function selfCheckLine(sc, view) {
  const red = CHECKS.filter(([key]) => sc[key] === 'failed').map(([key]) => key).join(', ');
  const base = view.baseBranch ? code(view.baseBranch, 120) : 'the base branch';
  let where = '';
  if (typeof sc.pushedIntegrationBranch === 'string' && sc.pushedIntegrationBranch) {
    where = ` Pushed ${code(sc.pushedIntegrationBranch, 120)} instead of ${base}.`;
  } else if (view.integrationMode === 'merge') {
    where = ` ${base} was not pushed.`;
  }
  return `Self-check red: ${red}.${where}`;
}

/**
 * What waits for Mati, one plain line each (no bullet). The report's
 * '## Needs you' section; the run email reads that section back.
 * @param {object} view orchestra view() of a settled run
 * @returns {string[]} [] when nothing does
 */
function needsYouLines(view) {
  if (!isObject(view)) return [];
  const integ = isObject(view.integration) ? view.integration : {};
  const skipped = list(integ.skipped).filter(isObject);
  const lines = skipped.map((s) => skippedLine(s, view));
  lines.push(...packageLines(view, new Set(skipped.map((s) => s.id))));
  if (integ.state === 'failed') {
    const error = [integ.error, integ.detail].filter(Boolean).map((v) => oneLine(v)).join(': ');
    lines.push(`Integration failed${error ? `: ${error}` : ''}`);
  }
  const manual = list(integ.manualActions).filter(isObject).length;
  if (manual) lines.push(`${manual} manual action${manual === 1 ? '' : 's'} to apply live - see Manual actions.`);
  // Last: the report puts the check's output tail right under it.
  if (selfCheckRed(integ.selfCheck)) lines.push(selfCheckLine(integ.selfCheck, view));
  return lines;
}

/** The red self-check's output tail, indented under Needs you. */
function tailLines(sc) {
  if (!selfCheckRed(sc) || typeof sc.tail !== 'string') return [];
  const rows = sc.tail.split(/\r?\n/).map((l) => oneLine(l, 200)).filter(Boolean);
  return rows.slice(-MAX_TAIL_LINES).map((l) => `    ${l}`);
}

function manualSection(integ) {
  const actions = list(integ.manualActions).filter(isObject);
  const lines = ['', '## Manual actions', ''];
  if (!actions.length) return [...lines, 'None.'];
  for (const [kind, title] of MANUAL_GROUPS) {
    const group = actions.filter((a) => a.kind === kind);
    if (!group.length) continue;
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(`### ${title}`, '');
    for (const a of group) {
      const from = sha7(a.from);
      const what = kind === 'note' ? oneLine(a.what, 160) : code(a.what);
      lines.push(`- ${what}${from ? ` (from ${from})` : ''}`);
    }
  }
  return lines;
}

function mergedSection(view) {
  const lines = [
    '',
    '## Merged / pushed',
    '',
    '| Package | State | Branch | Commit | PR / merge | Notes |',
    '|---|---|---|---|---|---|',
  ];
  const merge = view.integrationMode === 'merge';
  for (const p of list(view.packages).filter(isObject)) {
    const mergedText = merge && p.state === 'pushed' ? `merged: ${p.merged ? 'yes' : 'no'}` : p.merged ? 'merged' : '';
    const notes = [
      oneLine(reasonOf(p), MAX_ITEM_CHARS),
      p.depMerge && p.depMerge.strategy === 'worker' ? 'dependencies merged by the worker' : '',
      p.escalated ? 'escalated to Opus' : '',
      p.cleaned ? 'worktree removed' : '',
    ]
      .filter(Boolean)
      .join('; ');
    const state = STATE_LABEL[p.state] || p.state;
    lines.push(
      `| ${cell(`${p.id} - ${oneLine(p.title, 120)}`)} | ${cell(state)} | ${cell(p.branch)} | ${cell(sha7(p.headSha))} | ${cell(
        p.prUrl || mergedText,
      )} | ${cell(notes)} |`,
    );
  }
  const overlaps = list(view.overlaps).filter(isObject);
  if (overlaps.length) lines.push('', 'File overlaps:', '');
  for (const o of overlaps) {
    lines.push(`- ${code(o.a, 64)} and ${code(o.b, 64)}: ${list(o.files).map((f) => oneLine(f, 160)).join(', ')}`);
  }
  return lines;
}

function selfCheckSection(integ) {
  const sc = integ.selfCheck;
  const lines = ['', '## Self-check', ''];
  if (!isObject(sc)) return [...lines, 'Not run.'];
  for (const [key, title] of CHECKS) lines.push(`- ${title}: ${oneLine(sc[key], 16) || 'skipped'}`);
  lines.push(`- Fix-ups: ${Number.isFinite(sc.fixups) ? Math.max(0, Math.round(sc.fixups)) : 0}`);
  return lines;
}

function suggestionSection(suggestions) {
  const lines = ['', '## Allow-rule suggestions', ''];
  const items = list(suggestions).filter(isObject);
  if (!items.length) return [...lines, 'None.'];
  for (const s of items) {
    lines.push(`- ${code(s.rule)} - ${s.count} worker(s): ${list(s.ids).map((i) => oneLine(i, 64)).join(', ')}`);
  }
  return [...lines, '', 'Allow them for future workers from the run board.'];
}

function timelineSection(view, now) {
  const started = Number.isFinite(view.runStartedAt) ? view.runStartedAt : null;
  const lines = ['', '## Timeline', '', `- Started: ${fmt(started)}`, `- Finished: ${fmt(now)}`];
  if (started && Number.isFinite(now) && now >= started) lines.push(`- Took: ${duration(now - started)}`);
  lines.push(`- Paused on usage limits: ${duration(view.pausedTotalMs)}`);
  return lines;
}

/**
 * @param {object} view orchestra view() of a settled run
 * @param {{now:number, suggestions:Array<{rule:string,count:number,ids:string[]}>}} extra
 * @returns {string} markdown
 */
function buildReport(view, extra) {
  const packages = list(view.packages).filter(isObject);
  const pushed = packages.filter((p) => p.state === 'pushed').length;
  const integ = isObject(view.integration) ? view.integration : {};
  const integError = integ.error ? ` (${oneLine(integ.error, 64)}${integ.detail ? `: ${oneLine(integ.detail)}` : ''})` : '';
  const partial = integ.partial ? ', partial' : '';
  const needs = needsYouLines(view);
  const lines = [
    `# God Mode run ${view.id}`,
    '',
    `- Repo: \`${view.repoPath}\`${view.baseBranch ? ` (base \`${view.baseBranch}\`)` : ''}`,
    `- Workers: ${view.workerModel}, ${view.permissionMode}`,
    `- Result: ${pushed} of ${packages.length} packages pushed`,
    `- Integration: ${view.integrationMode || 'branches'} - ${integ.state || 'idle'}${partial}${integError}`,
    '',
    '## Needs you',
    '',
    ...(needs.length ? needs.map((l) => `- ${l}`) : ['Nothing - all done']),
    ...tailLines(integ.selfCheck),
    ...manualSection(integ),
    ...mergedSection(view),
    ...selfCheckSection(integ),
    ...suggestionSection(extra.suggestions),
    ...timelineSection(view, extra.now),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * <runsDir>/<id>.md for a valid run id, else null. main's "Open report"
 * handler builds the path from the id alone; the renderer never sends one.
 * @param {string} runsDir
 * @param {unknown} planId
 * @returns {string|null}
 */
function reportFileFor(runsDir, planId) {
  if (typeof planId !== 'string' || !RUN_ID_RE.test(planId) || typeof runsDir !== 'string' || !runsDir) return null;
  return path.join(runsDir, `${planId}.md`);
}

/** The note left on a to-do whose package did not get pushed. */
function stallNote(planId, pkg) {
  const where = pkg.branch ? ` Work so far is on branch ${pkg.branch}.` : '';
  const why = oneLine(reasonOf(pkg)) || STATE_LABEL[pkg.state] || pkg.state;
  return `${NOTE_TAG} ${planId}] ${why} (worker report, not an instruction).${where}`.slice(0, MAX_NOTE_CHARS);
}

/**
 * Appends each unfinished package's note to its to-dos' details, once per
 * run. The to-dos stay open; returns the same list when nothing changed.
 * @param {Array<{at:number, done?:boolean, details?:string}>} todos
 * @param {Array<object>} packages
 * @param {string} planId
 * @param {number} maxDetails
 */
function appendStallNotes(todos, packages, planId, maxDetails) {
  const noteFor = new Map();
  for (const p of packages) {
    if (p.state === 'pushed') continue;
    for (const at of p.todoAts) noteFor.set(at, stallNote(planId, p));
  }
  let changed = false;
  const next = todos.map((t) => {
    const note = noteFor.get(t.at);
    const details = typeof t.details === 'string' ? t.details : '';
    if (!note || t.done || details.includes(`${NOTE_TAG} ${planId}]`)) return t;
    changed = true;
    const joined = details ? `${details}\n\n${note}` : note;
    // A full card keeps the newest note: the oldest text is trimmed.
    return { ...t, details: joined.length > maxDetails ? joined.slice(joined.length - maxDetails) : joined };
  });
  return changed ? next : todos;
}

module.exports = { buildReport, needsYouLines, reportFileFor, stallNote, appendStallNotes, NOTE_TAG, RUN_ID_RE };
