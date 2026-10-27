// ============================================================================
// LunaCore - Luna's Work checkpoints + rollback (docs/LUNAS_WORK_PLAN.md #4)
// ----------------------------------------------------------------------------
// After every green iteration the base branch on origin is tagged
// `luna-work/<runId>/iter-<N>` and the tag is pushed. After the playtest the
// controller (src/lunaswork.js) asks lunasworkRules.rollbackDecision whether
// the iteration broke a core journey that passed before, or dropped the
// milestone score by more than ROLLBACK_MARGIN. On a rollback:
//
//   1. in a temporary detached worktree, every first-parent commit since the
//      last good tag is reverted in one `git revert --no-edit` sequence
//      (`-m 1` when it holds merges: God Mode merges with --no-ff, so main's
//      own line is merge commits plus fix-up commits) and the result is
//      pushed as a normal fast-forward
//   2. the broken head is tagged `luna-work/<runId>/iter-<N>-rolled-back`
//      (pushed), so the reverted work is easy to find as evidence
//   3. the rolled-back work becomes a `bug` card tagged run:<id>, with the
//      evidence and the reverted commit list
//   4. the rollback goes into design/DECISIONS.md
//   5. with o.restoreData (LW 3.29, src/lunasworkStaging.js) the staging data
//      snapshot that matches the good tag is restored right after the revert
//      reached origin; the restore goes into the card and DECISIONS.md too
//
// NEVER a force-push or a reset, in any code path: history on origin only
// grows. Every git call goes through guardedGit(), which refuses `reset`,
// `update-ref`, force / delete / mirror pushes, `+` and `:` refspecs and tag
// moves before anything runs. A rejected push leaves origin as it was and is
// reported; the temporary worktree is thrown away, the project checkout is
// never touched.
//
// The git runner is injected ((cwd, args) => Promise<{ok, out, err}>), so the
// tests drive a real temp repo and can inspect every args list.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pack = require('./lunasworkPack');
const { applyCards, REPRO_ACCEPTANCE } = require('./lunasworkCritic');
const { runTag, MAX_DETAILS_CHARS, MAX_TEXT_CHARS } = require('./todorows');

const TAG_PREFIX = 'luna-work';
const GIT_TIMEOUT_MS = 60 * 1000;
const MAX_REVERTS = 200;
const MAX_LISTED = 20;
const MAX_LINE = 300;
// What may go into a tag name: lunasworkRules' SAFE_ID, minus what git refuses.
const TAG_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
// A branch name as `git rev-parse --abbrev-ref HEAD` prints it.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_LINE) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- names ---------------------------------------------------------------------------

const safeRunId = (runId) =>
  typeof runId === 'string' && TAG_ID_RE.test(runId) && !runId.includes('..') && !runId.endsWith('.') && !runId.endsWith('.lock');

/** `luna-work/<runId>/iter-<N>`, or null for an id or iteration git could not take. */
function tagName(runId, iteration) {
  if (!safeRunId(runId) || !Number.isInteger(iteration) || iteration < 1) return null;
  return `${TAG_PREFIX}/${runId}/iter-${iteration}`;
}

/** The tag on a rolled-back head: the reverted work stays reachable. */
function rolledBackTagName(runId, iteration) {
  const base = tagName(runId, iteration);
  return base ? `${base}-rolled-back` : null;
}

// ---- the guard -----------------------------------------------------------------------

const FORCE_PUSH_FLAGS = new Set(['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--prune']);

/** A short flag bundle like `-fu` that holds `f`. */
const bundlesForce = (a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a);

/**
 * Why a git args list must never run, or null. The module never builds one of
 * these; the guard makes sure no future edit can either.
 * @param {string[]} args
 * @returns {string|null}
 */
function forbiddenGit(args) {
  const list = (Array.isArray(args) ? args : []).map(String);
  const at = list.findIndex((a) => !a.startsWith('-'));
  const sub = at >= 0 ? list[at] : null;
  const rest = at >= 0 ? list.slice(at + 1) : [];
  if (sub === 'reset') return 'reset';
  if (sub === 'update-ref') return 'update-ref';
  if (sub === 'push') {
    if (rest.some((a) => FORCE_PUSH_FLAGS.has(a) || a.startsWith('--force') || bundlesForce(a))) return 'force push';
    if (rest.some((a) => !a.startsWith('-') && (a.startsWith('+') || a.startsWith(':')))) return 'force or delete refspec';
  }
  if (sub === 'tag' && rest.some((a) => ['-f', '--force', '-d', '--delete'].includes(a))) return 'tag move';
  if ((sub === 'checkout' || sub === 'switch') && rest.some((a) => ['-B', '-C', '--force', '-f'].includes(a))) return 'branch overwrite';
  if (sub === 'branch' && rest.some((a) => ['-f', '--force', '-D', '-M'].includes(a))) return 'branch overwrite';
  return null;
}

/** Default runner: one git call via execFile. Resolves {ok, out, err}; never rejects. */
function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim().split('\n')[0] }),
    );
  });
}

/** The runner behind the guard: a forbidden args list is refused, never run. */
function guardedGit(run) {
  return async (cwd, args) => {
    const bad = forbiddenGit(args);
    if (bad) return { ok: false, out: '', err: `refused: ${bad}` };
    try {
      const res = await run(cwd, args);
      return isObj(res) ? { ok: res.ok === true, out: String(res.out || ''), err: String(res.err || '') } : { ok: false, out: '', err: 'no result' };
    } catch (err) {
      return { ok: false, out: '', err: errText(err) };
    }
  };
}

// ---- pure helpers --------------------------------------------------------------------

/**
 * `git log --first-parent --format=%H%x09%P%x09%s` output -> commits, newest first.
 * @returns {Array<{sha:string, merge:boolean, subject:string}>}
 */
function parseLog(out) {
  return String(out || '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([sha]) => SHA_RE.test(sha || ''))
    .map(([sha, parents = '', ...subject]) => ({
      sha,
      merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      subject: oneLine(subject.join('\t'), 200),
    }));
}

/** The `git revert` args for these commits (newest first): one sequence, so --abort undoes all of it. */
function revertArgs(commits) {
  // -m 1 keeps main's side of a merge; git takes it for plain commits too (2.21+).
  return ['revert', '--no-edit', ...(commits.some((c) => c.merge) ? ['-m', '1'] : []), ...commits.map((c) => c.sha)];
}

/**
 * Journeys that passed in the last good iteration and fail now: the
 * "core journey that passed before" rollback trigger.
 * @param {object[]} journeys this iteration's playtest journeys
 * @param {string[]|null} passedBefore names that passed in the last good iteration (null = unknown)
 * @returns {string[]|null} null when nothing is known about before (the caller falls back to all-pass)
 */
function regressedJourneys(journeys, passedBefore) {
  if (!Array.isArray(passedBefore)) return null;
  const before = new Set(passedBefore);
  return (Array.isArray(journeys) ? journeys : [])
    .filter((j) => isObj(j) && j.passed === false && before.has(j.name))
    .map((j) => j.name);
}

/**
 * The journeys that passed in the latest green iteration that was not rolled
 * back. No earlier iteration at all: nothing passed before ([]). Earlier
 * iterations but no lap kept for them (a run from before laps): unknown (null).
 * @param {object[]} laps run.laps, oldest first
 * @param {number} earlierRecords history records before this iteration
 * @returns {string[]|null}
 */
function journeysPassedBefore(laps, earlierRecords) {
  const good = [...(Array.isArray(laps) ? laps : [])].reverse().find((l) => isObj(l) && l.selfCheck === 'green' && l.rolledBack !== true);
  if (good) return Array.isArray(good.journeysPassed) ? good.journeysPassed : [];
  return earlierRecords > 0 ? null : [];
}

/**
 * What a rollback card shows: the broken journeys (the regressed ones when
 * known), the serious findings, the score drop, the evidence folder and the
 * cards whose work is reverted.
 * @param {{decision:{toIteration:number}, history:object[], report?:object|null, regressed?:string[]|null,
 *   evidenceDir?:string|null, cards?:string[]}} o
 */
function rollbackEvidence({ decision, history, report, regressed, evidenceDir, cards }) {
  const list = Array.isArray(history) ? history : [];
  const latest = list[list.length - 1] || {};
  const target = list.find((r) => isObj(r) && r.n === decision.toIteration);
  const r = isObj(report) ? report : {};
  const wanted = Array.isArray(regressed) && regressed.length ? new Set(regressed) : null;
  return {
    milestone: latest.milestone || null,
    scoreBefore: target && Number.isFinite(target.score) ? target.score : null,
    scoreNow: Number.isFinite(latest.score) ? latest.score : null,
    failedJourneys: (Array.isArray(r.journeys) ? r.journeys : []).filter((j) => isObj(j) && j.passed === false && (!wanted || wanted.has(j.name))),
    findings: (Array.isArray(r.findings) ? r.findings : []).filter((f) => isObj(f) && (f.severity === 'blocker' || f.severity === 'high')),
    evidenceDir: evidenceDir || null,
    cards: Array.isArray(cards) ? cards : [],
  };
}

/** The human reason of a rollback, one line. */
function reasonText(reason, evidence = {}) {
  if (reason === 'coreJourneyBroken') {
    const names = (evidence.failedJourneys || []).filter(isObj).map((j) => `"${oneLine(j.name, 80)}"`).slice(0, 5);
    return `a core journey that passed before failed${names.length ? `: ${names.join(', ')}` : ''}`;
  }
  if (reason === 'scoreDrop') {
    const m = evidence.milestone ? ` "${oneLine(evidence.milestone, 80)}"` : '';
    const from = Number.isFinite(evidence.scoreBefore) ? evidence.scoreBefore : '?';
    const to = Number.isFinite(evidence.scoreNow) ? evidence.scoreNow : '?';
    return `the milestone${m} score fell from ${from} to ${to}, more than the rollback margin`;
  }
  return oneLine(reason || 'rollback', 100);
}

const bulletList = (title, items) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`), ''] : []);

function journeyLine(j) {
  const ev = isObj(j.evidence) ? j.evidence : {};
  const shot = ev.screenshot ? ` (screenshot ${oneLine(ev.screenshot, 200)})` : '';
  const steps = Array.isArray(ev.steps) && ev.steps.length ? ` - steps: ${oneLine(ev.steps.join(' > '), 200)}` : '';
  return `${oneLine(j.name, 120)}${shot}${steps}`;
}

/**
 * The `bug` card the rolled-back work becomes: the evidence, the reverted
 * commits and the cards whose work went with them.
 * @returns {{kind:'bug', severity:string, text:string, details:string, acceptance:string[], files:string[], updatesCardId:null}}
 */
function rollbackCard({ iteration, fromTag, toTag, reason, evidence = {}, reverted = [], data = null }) {
  const why = reasonText(reason, evidence);
  const journeys = (evidence.failedJourneys || []).filter(isObj).slice(0, MAX_LISTED).map(journeyLine);
  const findings = (evidence.findings || [])
    .filter(isObj)
    .slice(0, MAX_LISTED)
    .map((f) => `[${oneLine(f.severity, 10)}] ${oneLine(f.title, 160)}${f.screenshot ? ` (screenshot ${oneLine(f.screenshot, 200)})` : ''}`);
  const cards = (evidence.cards || []).slice(0, MAX_LISTED).map((t) => oneLine(t, 160));
  const commits = reverted.slice(0, MAX_LISTED).map((c) => `${c.sha.slice(0, 7)} ${oneLine(c.subject, 160)}`);
  if (reverted.length > MAX_LISTED) commits.push(`... and ${reverted.length - MAX_LISTED} more`);
  const details = [
    `Luna's Work rolled main back from ${fromTag} to ${toTag} after iteration ${iteration}: ${why}.`,
    `The reverted work is still on the tag ${fromTag}.`,
    '',
    ...bulletList('Failing journeys', journeys),
    ...bulletList('Findings', findings),
    ...(evidence.evidenceDir ? [`Evidence folder: ${oneLine(evidence.evidenceDir, 300)}`, ''] : []),
    ...bulletList('Cards whose work was reverted (reopened)', cards),
    ...bulletList('Reverted commits', commits),
    ...(isObj(data) && data.note ? [`Staging data: ${oneLine(data.note, 300)}`, ''] : []),
    'Start from a failing test that reproduces the problem, then redo the work without breaking it.',
  ].join('\n');
  return {
    kind: 'bug',
    severity: reason === 'coreJourneyBroken' ? 'blocker' : 'high',
    text: `Redo the work rolled back after iteration ${iteration}: ${why}`.slice(0, MAX_TEXT_CHARS),
    details: details.slice(0, MAX_DETAILS_CHARS),
    acceptance: [REPRO_ACCEPTANCE, 'The core journeys in TEST_PLAN.md pass again'],
    files: [],
    updatesCardId: null,
  };
}

// ---- git steps ---------------------------------------------------------------------

/**
 * @param {{git?:(cwd:string, args:string[])=>Promise<{ok:boolean, out:string, err:string}>,
 *   tmpDir?:()=>string, log?:(line:string)=>void}} [deps]
 */
function createCheckpoints(deps = {}) {
  const git = guardedGit(deps.git || execGit);
  const log = deps.log || (() => {});
  const tmpRoot = deps.tmpDir || (() => os.tmpdir());

  /** The checkout's branch (God Mode's base) and origin's head of it. */
  async function originHead(repoPath) {
    const head = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = head.ok ? head.out : '';
    if (!BRANCH_RE.test(branch) || branch === 'HEAD' || branch.includes('..')) return { error: 'notOnBranch' };
    const fetched = await git(repoPath, ['fetch', 'origin', `refs/heads/${branch}`]);
    if (!fetched.ok) return { error: 'fetchFailed', detail: fetched.err };
    const sha = await git(repoPath, ['rev-parse', 'FETCH_HEAD^{commit}']);
    if (!sha.ok || !SHA_RE.test(sha.out)) return { error: 'fetchFailed', detail: sha.err };
    return { branch, sha: sha.out };
  }

  const verifyTag = async (repoPath, ref) => {
    const res = await git(repoPath, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    return res.ok && SHA_RE.test(res.out) ? res.out : null;
  };

  /** The commit a tag points at: local first, else fetched from origin (never moved). */
  async function tagSha(repoPath, tag) {
    const ref = `refs/tags/${tag}`;
    const local = await verifyTag(repoPath, ref);
    if (local) return local;
    await git(repoPath, ['fetch', 'origin', `${ref}:${ref}`]);
    return verifyTag(repoPath, ref);
  }

  /** Creates a tag on sha (when missing) and pushes it. */
  async function tagAndPush(repoPath, tag, sha) {
    const existing = await verifyTag(repoPath, `refs/tags/${tag}`);
    if (!existing) {
      const made = await git(repoPath, ['tag', tag, sha]);
      if (!made.ok) return { ok: false, error: 'tagFailed', detail: made.err };
    } else if (existing !== sha) {
      // A tag is never moved: the one from before a restart stays.
      log(`[lunaswork] tag ${tag} already points at ${existing.slice(0, 7)}`);
    }
    const pushed = await git(repoPath, ['push', 'origin', `refs/tags/${tag}`]);
    if (!pushed.ok) return { ok: false, error: 'tagPushFailed', detail: pushed.err };
    return { ok: true };
  }

  /**
   * Tags origin's base branch after a green iteration and pushes the tag.
   * @returns {Promise<{ok:boolean, tag?:string, sha?:string, error?:string, detail?:string}>}
   */
  async function tagIteration({ repoPath, runId, iteration }) {
    const tag = tagName(runId, iteration);
    if (!tag) return { ok: false, error: 'badTagName' };
    const head = await originHead(repoPath);
    if (head.error) return { ok: false, tag, error: head.error, detail: head.detail };
    const res = await tagAndPush(repoPath, tag, head.sha);
    return res.ok ? { ok: true, tag, sha: head.sha } : { ...res, tag };
  }

  async function removeWorktree(repoPath, dir) {
    const removed = await git(repoPath, ['worktree', 'remove', dir]);
    if (removed.ok) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log(`[lunaswork] could not remove ${dir}: ${errText(err)}`);
    }
    await git(repoPath, ['worktree', 'prune']);
  }

  /** Reverts `commits` on top of headSha in a throwaway worktree and pushes. */
  async function revertInWorktree(repoPath, branch, headSha, commits) {
    const dir = fs.mkdtempSync(path.join(tmpRoot(), 'lunaswork-revert-'));
    // mkdtemp reserved a unique name; git wants to create the folder itself.
    fs.rmdirSync(dir);
    const added = await git(repoPath, ['worktree', 'add', '--detach', dir, headSha]);
    if (!added.ok) return { ok: false, error: 'worktreeFailed', detail: added.err };
    try {
      const reverted = await git(dir, revertArgs(commits));
      if (!reverted.ok) {
        // Undoes the local, never-pushed revert commits of this sequence only.
        await git(dir, ['revert', '--abort']);
        return { ok: false, error: 'revertFailed', detail: reverted.err };
      }
      const pushed = await git(dir, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      if (!pushed.ok) return { ok: false, error: 'pushFailed', detail: pushed.err };
      const after = await git(dir, ['rev-parse', 'HEAD']);
      return { ok: true, headAfter: after.ok ? after.out : null };
    } finally {
      await removeWorktree(repoPath, dir);
    }
  }

  /**
   * C5: the staging data restore that goes with the revert (o.restoreData,
   * src/lunasworkStaging.js). Null when there is none. Never throws.
   */
  async function restoreData(o) {
    if (typeof o.restoreData !== 'function') return null;
    try {
      const res = await o.restoreData({ repoPath: o.repoPath, runId: o.runId, iteration: o.iteration, toIteration: o.toIteration });
      return isObj(res) ? res : null;
    } catch (err) {
      return { restored: false, error: 'restoreFailed', note: `staging data not restored: ${oneLine(errText(err), 200)}` };
    }
  }

  /** The card and the DECISIONS.md line of a rollback that went through. */
  function recordRollback({ repoPath, runId, iteration, fromTag, toTag, reason, evidence, reverted, todoStore, data }) {
    let cards = [];
    let cardError = null;
    const tag = runTag(runId);
    if (todoStore && tag) {
      try {
        const applied = applyCards(todoStore, [rollbackCard({ iteration, fromTag, toTag, reason, evidence, reverted, data })], tag);
        cards = applied.created.map((c) => c.at);
        cardError = applied.error || null;
      } catch (err) {
        cardError = errText(err);
      }
    }
    const restored = isObj(data) && data.restored === true ? ` and restore the staging data snapshot of iteration ${data.iteration}` : '';
    const op = pack.appendDecision({
      choice: `to roll main back from ${fromTag} to ${toTag} with ${reverted.length} revert commit(s)${restored}`,
      because: `${reasonText(reason, evidence)}${isObj(data) && data.note ? `; ${oneLine(data.note, 200)}` : ''}`,
      source: `Luna's Work checkpoint, iteration ${iteration}`,
    });
    const written = op ? pack.applyWrite(repoPath, op) : { ok: false, error: 'rejected' };
    if (cardError) log(`[lunaswork] rollback card not saved: ${cardError}`);
    if (!written.ok) log(`[lunaswork] rollback not written to DECISIONS.md: ${written.error}`);
    return { cards, cardError, decision: written.ok === true };
  }

  /**
   * Reverts origin's base branch to the last good tag with revert commits.
   * @param {{repoPath:string, runId:string, iteration:number, toIteration:number, reason:string,
   *   evidence?:object, todoStore?:{read:Function, write:Function},
   *   restoreData?:(ctx:{repoPath:string, runId:string, iteration:number, toIteration:number})=>Promise<object|null>}} o
   * @returns {Promise<{ok:boolean, nothing?:boolean, fromTag?:string, toTag?:string,
   *   reverted?:Array<{sha:string, subject:string}>, cards?:number[], decision?:boolean,
   *   data?:{restored:boolean, iteration?:number, note:string, error?:string},
   *   error?:string, detail?:string}>}
   */
  async function rollback(o) {
    const toTag = tagName(o.runId, o.toIteration);
    const fromTag = rolledBackTagName(o.runId, o.iteration);
    if (!toTag || !fromTag) return { ok: false, error: 'badTagName' };
    const base = { fromTag, toTag };
    const fail = (error, detail) => ({ ...base, ok: false, error, ...(detail ? { detail } : {}) });
    const head = await originHead(o.repoPath);
    if (head.error) return fail(head.error, head.detail);
    const good = await tagSha(o.repoPath, toTag);
    if (!good) return fail('noGoodTag');
    const ancestor = await git(o.repoPath, ['merge-base', '--is-ancestor', good, head.sha]);
    if (!ancestor.ok) return fail('goodTagNotOnBranch');
    // Already at the good state (a restart after the push): nothing to revert.
    const same = await git(o.repoPath, ['diff', '--quiet', good, head.sha]);
    if (same.ok) return { ...base, ok: true, nothing: true, reverted: [], cards: [] };
    const listed = await git(o.repoPath, ['log', '--first-parent', '--format=%H%x09%P%x09%s', `${good}..${head.sha}`]);
    if (!listed.ok) return fail('logFailed', listed.err);
    const commits = parseLog(listed.out);
    if (!commits.length) return { ...base, ok: true, nothing: true, reverted: [], cards: [] };
    if (commits.length > MAX_REVERTS) return fail('tooManyCommits');
    const res = await revertInWorktree(o.repoPath, head.branch, head.sha, commits);
    if (!res.ok) return fail(res.error, res.detail);
    // Only once the revert is on origin: a failed rollback leaves no tag behind.
    // The broken head stays in history either way; the tag just names it.
    const kept = await tagAndPush(o.repoPath, fromTag, head.sha);
    if (!kept.ok) log(`[lunaswork] ${fromTag} not pushed: ${kept.error}${kept.detail ? ` (${kept.detail})` : ''}`);
    const reverted = commits.map(({ sha, subject }) => ({ sha, subject }));
    // C5: the staging data goes back with the code - only once the revert is on origin.
    const data = await restoreData(o);
    const recorded = recordRollback({ ...o, fromTag, toTag, reverted, evidence: isObj(o.evidence) ? o.evidence : {}, data });
    return { ...base, ok: true, reverted, headAfter: res.headAfter, ...recorded, ...(data ? { data } : {}) };
  }

  return { tagIteration, rollback };
}

module.exports = {
  TAG_PREFIX,
  tagName,
  rolledBackTagName,
  forbiddenGit,
  guardedGit,
  execGit,
  parseLog,
  revertArgs,
  regressedJourneys,
  journeysPassedBefore,
  rollbackEvidence,
  reasonText,
  rollbackCard,
  createCheckpoints,
};
