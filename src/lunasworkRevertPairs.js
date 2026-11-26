// ============================================================================
// LunaCore - Luna's Work rollback: commits net of revert pairs
// ----------------------------------------------------------------------------
// A rollback (src/lunasworkCheckpoint.js) reverts main's first-parent commits
// since the last good tag. After an earlier rollback that range already holds
// the earlier rollback's revert commits next to the work they undid:
//
//   iter-2 tag  C1  C2  R(C2)  R(C1)  D1  D2   <- head after iteration 4
//
// Reverting all six gives a "Reapply" commit for every R and a "Revert" for
// every C - the same tree, but a chain of commits that cancel each other.
// netOfReverts() drops each commit together with a later revert of it inside
// the range (newest first, so a revert of a revert cancels the revert and the
// original stays applied), and only what is still applied is reverted: D2, D1.
//
// Which commit a revert undoes: git revert's body line "This reverts commit
// <sha>." (", reversing changes made to <parent>." follows for a merge). Only
// when that line is missing (an edited message) the subject is used:
// `Revert "<S>"` undoes the newest older commit with subject S, `Reapply "<S>"`
// (git 2.43+, a revert of a revert) the one with subject `Revert "<S>"`.
// A revert whose target lies before the range stays: it is needed to reach
// the good tag's tree (reverting it re-applies that older commit).
// ============================================================================

'use strict';

const SHA_RE = /^[0-9a-f]{40}$/;
const REVERTS_RE = /^This reverts commit ([0-9a-f]{40})\b/m;
const REVERT_SUBJECT_RE = /^Revert "(.+)"$/;
const REAPPLY_SUBJECT_RE = /^Reapply "(.+)"$/;
// Record and field separators of the body log (`--format=%H%x1f%B%x1e`).
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/** The `git log` args whose output parseRevertLinks reads, for one range. */
const revertLinkArgs = (range) => ['log', '--first-parent', '--format=%H%x1f%B%x1e', range];

/**
 * `git log --format=%H%x1f%B%x1e` output -> sha of a revert -> sha it reverts
 * (from the "This reverts commit" body line). Commits without one are left out.
 * @returns {Map<string, string>}
 */
function parseRevertLinks(out) {
  const links = new Map();
  for (const record of String(out || '').split(RECORD_SEP)) {
    const at = record.indexOf(FIELD_SEP);
    if (at < 0) continue;
    const sha = record.slice(0, at).trim();
    const m = record.slice(at + 1).match(REVERTS_RE);
    if (SHA_RE.test(sha) && m) links.set(sha, m[1]);
  }
  return links;
}

/** The subject of the commit a revert's own subject names, or null. */
function subjectTarget(subject) {
  const s = String(subject || '');
  const reapply = s.match(REAPPLY_SUBJECT_RE);
  if (reapply) return `Revert "${reapply[1]}"`;
  const revert = s.match(REVERT_SUBJECT_RE);
  return revert ? revert[1] : null;
}

/** The sha in `older` (newest first) that commit `c` reverts and that still counts, or null. */
function targetOf(c, older, links, cancelled) {
  const live = (o) => !cancelled.has(o.sha);
  const linked = links.get(c.sha);
  // A body line is the whole truth: a target outside the range is no pair.
  if (linked) return older.some((o) => o.sha === linked && live(o)) ? linked : null;
  const wanted = subjectTarget(c.subject);
  const hit = wanted ? older.find((o) => live(o) && o.subject === wanted) : null;
  return hit ? hit.sha : null;
}

/**
 * Pure: the commits of a rollback range that are still applied.
 * @template {{sha:string, subject:string}} C
 * @param {C[]} commits newest first (lunasworkCheckpoint.parseLog)
 * @param {Map<string, string>} [links] parseRevertLinks' answer for the same range
 * @returns {{applied:C[], cancelled:C[]}} both newest first
 */
function netOfReverts(commits, links = new Map()) {
  const list = Array.isArray(commits) ? commits : [];
  const cancelled = new Set();
  list.forEach((c, i) => {
    if (cancelled.has(c.sha)) return;
    const target = targetOf(c, list.slice(i + 1), links, cancelled);
    if (!target) return;
    cancelled.add(c.sha);
    cancelled.add(target);
  });
  return { applied: list.filter((c) => !cancelled.has(c.sha)), cancelled: list.filter((c) => cancelled.has(c.sha)) };
}

module.exports = { revertLinkArgs, parseRevertLinks, subjectTarget, netOfReverts };
