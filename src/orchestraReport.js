// ============================================================================
// LunaCore - God Mode v2 run report (ORCHESTRATOR_PLAN.md slice 5, idea #8)
// ----------------------------------------------------------------------------
// Pure text: the morning report (markdown, written to
// <userDir>/runs/<plan>.md by main) and the note a package that did not make
// it leaves on its to-dos, so the next run - or Mati - starts knowingly.
// ============================================================================

'use strict';

const NOTE_TAG = '[LunaCore run';
const MAX_NOTE_CHARS = 600;

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

const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const cell = (v) => String(v == null || v === '' ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** "verifyFailed - 2 tests failing" style reason, or ''. */
function reasonOf(pkg) {
  if (!pkg.error) return '';
  return pkg.detail ? `${pkg.error} - ${pkg.detail}` : pkg.error;
}

/**
 * @param {object} view orchestra view() of a settled run
 * @param {{now:number, suggestions:Array<{rule:string,count:number,ids:string[]}>}} extra
 * @returns {string} markdown
 */
function buildReport(view, extra) {
  const pushed = view.packages.filter((p) => p.state === 'pushed').length;
  const integ = view.integration || {};
  const integError = integ.error ? ` (${integ.error}${integ.detail ? `: ${integ.detail}` : ''})` : '';
  const lines = [
    `# God Mode run ${view.id}`,
    '',
    `- Finished: ${fmt(extra.now)}`,
    `- Repo: \`${view.repoPath}\`${view.baseBranch ? ` (base \`${view.baseBranch}\`)` : ''}`,
    `- Workers: ${view.workerModel}, ${view.permissionMode}`,
    `- Result: ${pushed} of ${view.packages.length} packages pushed`,
    `- Integration: ${view.integrationMode || 'branches'} - ${integ.state || 'idle'}${integError}`,
    '',
    '| Package | State | Branch | Commit | PR / merge | Notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const p of view.packages) {
    const out = p.prUrl || (p.merged ? 'merged' : '');
    const notes = [reasonOf(p), p.escalated ? 'escalated to Opus' : '', p.cleaned ? 'worktree removed' : '']
      .filter(Boolean)
      .join('; ');
    const sha = p.headSha ? p.headSha.slice(0, 7) : '';
    const state = STATE_LABEL[p.state] || p.state;
    lines.push(
      `| ${cell(`${p.id} - ${p.title}`)} | ${cell(state)} | ${cell(p.branch)} | ${cell(sha)} | ${cell(out)} | ${cell(notes)} |`,
    );
  }
  if (view.overlaps && view.overlaps.length) {
    lines.push('', '## File overlaps', '');
    for (const o of view.overlaps) lines.push(`- \`${o.a}\` and \`${o.b}\`: ${o.files.join(', ')}`);
  }
  if (extra.suggestions.length) {
    lines.push('', '## Approval prompts that stalled workers', '');
    for (const s of extra.suggestions) lines.push(`- \`${s.rule}\` - ${s.count} worker(s): ${s.ids.join(', ')}`);
    lines.push('', 'Allow them for future workers from the run board.');
  }
  return `${lines.join('\n')}\n`;
}

// The reason can quote a worker's own words (LUNA_BLOCKED), and a to-do's
// details go back to Claude later: one line, no control characters, capped,
// and labelled as what it is.
// eslint-disable-next-line no-control-regex
const oneLine = (v) => String(v || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);

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

module.exports = { buildReport, stallNote, appendStallNotes, NOTE_TAG };
