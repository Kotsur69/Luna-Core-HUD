// ============================================================================
// LunaCore - God Mode v2 failure diagnosis (run report "What went wrong")
// ----------------------------------------------------------------------------
// An error code on a package or on the integration says THAT something broke;
// Mati wants to know what happened, why, and what to do about it. This module
// turns every code God Mode can leave behind into those three plain sentences,
// plus the evidence the run kept (git / test / worker output). Pure: the
// report (orchestraReport.js) and the to-do stall note read it; nothing here
// runs anything.
//
// Evidence can quote model or test output: callers pass it through the
// report's own oneLine()/code() caps before it reaches markdown or HTML.
// ============================================================================

'use strict';

const { findTurnEndMessage, textBlocks } = require('./ttsExtract');

const MAX_LAST_WORDS = 500;
const MAX_TAIL_LINES = 12;
const MAX_TAIL_CHARS = 1500;

/**
 * Package stop reasons (pkg.error, or pkg.state when there is no error).
 * {what, why, fix} - `fix` is what Mati does next, concretely.
 */
const PACKAGE = {
  blocked: {
    what: 'The worker stopped on purpose and reported a blocker (LUNA_BLOCKED).',
    why: 'It hit something it could not decide or do on its own - its own words are quoted below.',
    fix: 'Answer the blocker: add the missing decision or info to the to-do card details (or do the blocked step yourself), then Retry the package.',
  },
  noMarker: {
    what: 'The worker ended its turns without ever saying LUNA_DONE, even after 3 nudges.',
    why: 'Usually one of: it finished but forgot the marker, it is waiting for an answer to a question it asked, it ran out of context, or the task was too vague to know when it was done.',
    fix: 'Read the worker\'s last words below. If the work is done, open its tab and type LUNA_DONE <id> (or Retry); if it asked a question, answer it in the card and Retry; if the card is vague, add acceptance checks first.',
  },
  needsApproval: {
    what: 'The worker is waiting on a permission prompt in its tab.',
    why: 'It wanted to run a tool that the worker permission mode / allow-list does not cover.',
    fix: 'Approve it in the tab, or add the suggested allow rule from the run board (Allow-rule suggestions) so future workers do not stop there.',
  },
  approvalTimeout: {
    what: 'A permission prompt went unanswered for too long, so LunaCore closed the tab without approving anything.',
    why: 'The run was unattended and the tool the worker asked for is not on the allow-list.',
    fix: 'Allow the rule shown (Settings -> God Mode v2, or the board suggestion) if it is safe, then Retry. Otherwise reword the card so the worker does not need that tool.',
  },
  timeout: {
    what: 'The worker ran past its working-time cap (2 h) and was stopped.',
    why: 'The package was too big for one session, or the worker went round in circles (often a test it could not make pass).',
    fix: 'Split the card into smaller ones (size S/M with their own acceptance checks), or look at the branch to see where it got stuck, then Retry.',
  },
  restarted: {
    what: 'LunaCore was closed or restarted while this worker was running.',
    why: 'The worker tab died with the app; its worktree and branch were kept.',
    fix: 'Retry - the new worker continues in the same worktree from the last commit.',
  },
  verifyFailed: {
    what: 'The worker said it was done, but the verify command kept failing after the allowed fix-up rounds.',
    why: 'Either the change really breaks something (see the test output below), or the verify command itself is wrong for this repo (missing script, wrong path, needs a service running).',
    fix: 'Run the verify command in the worktree and read the first failure. If the code is wrong, add the failure to the card and Retry; if the command is wrong, fix the card\'s verify field and Retry.',
  },
  noCommitsFailed: {
    what: 'The worker finished, but its branch has no new commits.',
    why: 'It changed nothing - the to-do may already be done on the base branch, or the worker misunderstood the card.',
    fix: 'Check whether the to-do is already done (then tick it). If not, make the card more concrete (files, acceptance checks) and Retry.',
  },
  commitFailed: {
    what: 'Committing the worker\'s changes failed.',
    why: 'Git refused the commit - most often a pre-commit hook failed, or git has no user.name/user.email in that worktree.',
    fix: 'Run `git commit` in the worktree to see the exact error, fix the hook failure or git identity, then Retry.',
  },
  pushFailed: {
    what: 'Pushing the package branch failed.',
    why: 'The remote refused it: no remote / no network, expired GitHub auth, or a branch with that name already exists there with other commits.',
    fix: 'Check `gh auth status` and `git remote -v`, push the branch by hand from the worktree if needed, then Retry.',
  },
  briefFailed: {
    what: 'LunaCore could not write the worker\'s brief file.',
    why: 'The LunaCore data folder (tasks/) is not writable - disk full, permissions, or antivirus locking the file.',
    fix: 'Free disk space / check the folder permissions, then Retry.',
  },
  noTab: {
    what: 'LunaCore could not open a terminal tab for the worker.',
    why: 'The worker profile could not start (claude missing from PATH, a broken profile, or too many tabs open).',
    fix: 'Close unused tabs, check the worker profile starts in a normal tab, then Retry.',
  },
  conflict: {
    what: 'Combining this package\'s dependency branches hit a merge conflict.',
    why: 'Two packages it depends on changed the same lines.',
    fix: 'Merge the dependency branches by hand in a session (files listed below), commit, then Retry.',
  },
  depMergeFailed: {
    what: 'LunaCore could not combine the branches this package depends on.',
    why: 'A dependency branch is missing or git refused the merge.',
    fix: 'Check the dependency packages were pushed, merge their branches by hand if needed, then Retry.',
  },
  depVerifyFailed: {
    what: 'The dependency branches combined, but the verify command fails on the result.',
    why: 'The packages it builds on work alone but break together.',
    fix: 'Fix the combination in a session (run verify on the merged branches), then Retry.',
  },
  unsafeBranch: {
    what: 'The worker\'s branch was not a separate luna-free/ branch, so the package was stopped before it could touch anything.',
    why: 'Free mode only ever works on its own branches; something else was checked out in the worktree.',
    fix: 'Remove the stale worktree (git worktree list / remove), then Retry.',
  },
  launchThrew: {
    what: 'Starting the worker crashed inside LunaCore.',
    why: 'An internal error - the message is quoted below.',
    fix: 'Retry once; if it happens again, report the message below as a LunaCore bug.',
  },
  badName: {
    what: 'The worktree name for this package was rejected.',
    why: 'The package id made an invalid git branch or folder name.',
    fix: 'Plan again - the planner picks a new id.',
  },
  notRepo: {
    what: 'The project folder is not a git repository.',
    why: 'God Mode works in git worktrees and needs a repo.',
    fix: 'Run `git init` and make a first commit in the project, then plan again.',
  },
  noCommits: {
    what: 'The repo has no commits yet, so no worktree can branch from it.',
    why: 'A worktree needs a base commit.',
    fix: 'Make a first commit on the base branch, then Retry.',
  },
  exists: {
    what: 'A worktree or branch with this package\'s name already exists.',
    why: 'Left over from an earlier run that was not cleaned up.',
    fix: 'Remove it (`git worktree remove` / `git branch -D luna/<id>`) or finish the old run, then Retry.',
  },
  gitFailed: {
    what: 'A git command failed while setting up the worktree.',
    why: 'Git\'s own message is quoted below (locked index, disk, permissions).',
    fix: 'Fix what git reports, then Retry.',
  },
  worktreeFailed: {
    what: 'The worktree for this package could not be created.',
    why: 'Git refused - the message is quoted below.',
    fix: 'Fix what git reports (often a leftover lock or worktree), then Retry.',
  },
  killed: {
    what: 'The run was stopped with the kill switch while this package was running.',
    why: 'Stopped by hand (Ctrl+Shift+K / Stop all).',
    fix: 'Retry it when you want it done - its worktree is kept.',
  },
  closed: {
    what: 'The worker\'s tab was closed before it finished.',
    why: 'Closed by hand, or the terminal process died.',
    fix: 'Retry - a new worker continues in the same worktree.',
  },
  pending: {
    what: 'This package never started.',
    why: 'It waits on a package that did not finish (see blocked by), or the run ended before its turn.',
    fix: 'Get the package it depends on through first, then Retry this one.',
  },
};

/** Integration (end-of-run) error codes. */
const INTEGRATION = {
  noBaseBranch: {
    what: 'Integration did not start: the repo is not on a branch (detached HEAD).',
    why: 'LunaCore merges into the branch the plan was made on and could not tell which one that is.',
    fix: 'Check out the base branch in the repo, then press Finish run on the board.',
  },
  baseMoved: {
    what: 'Integration did not start: the repo is no longer on the branch the plan was made on.',
    why: 'The repo was switched to another branch during the run.',
    fix: 'Check out the original base branch again, then Finish run.',
  },
  noGh: {
    what: 'Pull requests could not be opened: GitHub CLI (gh) is not installed.',
    why: 'PR mode uses gh to open the PRs.',
    fix: 'Install gh and run `gh auth login`, then Finish run - or choose "branches only".',
  },
  ghFailed: {
    what: 'GitHub CLI refused to open a pull request.',
    why: 'gh\'s message is quoted below - usually expired auth, no GitHub remote, or a PR that already exists.',
    fix: 'Run `gh auth status`, fix what it says, then Finish run.',
  },
  missingCwd: {
    what: 'Integration could not run: the repo folder does not exist on this PC.',
    why: 'The run was planned on another machine or the folder was moved.',
    fix: 'Run Finish run on the machine that has the repo.',
  },
  fetchFailed: {
    what: 'Could not fetch the latest base branch before merging.',
    why: 'No network, or the remote refused (auth).',
    fix: 'Check `git fetch` works in the repo, then Finish run.',
  },
  worktreeFailed: {
    what: 'The integration worktree could not be created.',
    why: 'Git refused - often a leftover integration worktree from an earlier run.',
    fix: 'Remove the stale integration worktree (`git worktree prune`), then Finish run.',
  },
  installFailed: {
    what: 'Installing dependencies in the integration worktree failed.',
    why: 'npm / the package manager failed - output quoted below.',
    fix: 'Run the install in the repo yourself to see the error, fix it, then Finish run.',
  },
  mergeFailed: {
    what: 'Merging package branches into the base failed.',
    why: 'Git refused the merge - message quoted below.',
    fix: 'Merge the skipped branches by hand in a session, then Retry / Finish run.',
  },
  conflictFailed: {
    what: 'A merge conflict could not be resolved automatically.',
    why: 'Two packages changed the same lines (files listed below).',
    fix: 'Merge that branch by hand in a session, resolve the conflict, commit, then Finish run.',
  },
  verifyFailed: {
    what: 'The tests went red after merging, so nothing was pushed.',
    why: 'The packages work alone but break together, or the base branch moved.',
    fix: 'Run the tests on the integration branch, fix the failure in a session, then Finish run.',
  },
  selfCheckFailed: {
    what: 'The end-of-run self-check failed after the merge.',
    why: 'Tests, syntax or smoke check went red on the merged result (tail below).',
    fix: 'Fix the failure on the pushed integration branch, then merge it by hand.',
  },
  pushFailed: {
    what: 'Pushing the merged base branch was rejected.',
    why: 'Someone pushed to the base branch meanwhile, the branch is protected, or auth expired.',
    fix: 'Pull, re-run Finish run - or open a PR from the integration branch if the base is protected.',
  },
  beforePushFailed: {
    what: 'The check before the final push failed, so the base branch was not pushed.',
    why: 'The merged result did not pass the pre-push check.',
    fix: 'Fix the failure on the integration branch, then Finish run.',
  },
  nothingMergedFailed: {
    what: 'No package could be merged - every one was skipped.',
    why: 'Each skipped package has its own reason below (conflicts or red tests).',
    fix: 'Work through the skipped packages one by one, then Finish run.',
  },
  integrateThrew: {
    what: 'Integration crashed inside LunaCore.',
    why: 'An internal error - message quoted below.',
    fix: 'Press Finish run again; if it repeats, report the message as a LunaCore bug.',
  },
  unavailable: {
    what: 'Integration is not available in this build.',
    why: 'The integration step was not wired up.',
    fix: 'Integrate the pushed branches by hand.',
  },
};

/** Integration skip stages (one package left out of the merge). */
const SKIP = {
  conflict: {
    what: 'The branch conflicts with what was already merged.',
    why: 'It changed the same lines as an earlier package (files below).',
    fix: 'Merge the branch by hand in a session, resolve the conflict, then Retry.',
  },
  merge: {
    what: 'Git refused to merge the branch.',
    why: 'Git\'s message is quoted below.',
    fix: 'Merge the branch by hand in a session, then Retry.',
  },
  verify: {
    what: 'The branch merged, but the tests went red, so it was taken back out.',
    why: 'It works alone but breaks something the other packages brought in.',
    fix: 'Rebase the branch on the merged base, fix the failing test, then Retry.',
  },
};

const UNKNOWN = {
  what: 'The package stopped with a reason LunaCore has no explanation for yet.',
  why: 'See the code and detail below.',
  fix: 'Open the worker tab or branch to see what it did, then Retry.',
};

/**
 * What happened / why / fix for a package that did not get pushed.
 * @param {{state:string, error?:string|null}} pkg
 * @returns {{what:string, why:string, fix:string}}
 */
function diagnosePackage(pkg) {
  const key = (pkg && pkg.error) || (pkg && pkg.state);
  return PACKAGE[key] || UNKNOWN;
}

/** Same, for the integration's error code ('<stage>Failed' or a plain code). */
function diagnoseIntegration(code) {
  return INTEGRATION[code] || { ...UNKNOWN, what: 'Integration stopped with an unexplained error.' };
}

/** Same, for one package the integration skipped. */
function diagnoseSkip(stage) {
  return SKIP[stage] || SKIP.merge;
}

/**
 * The worker's own last words: the final assistant message of a finished
 * turn (transcript JSONL fragment), its last lines joined, capped.
 * @param {string} fragment
 * @returns {string} '' when the turn has no text
 */
function lastWordsFrom(fragment) {
  const message = findTurnEndMessage(fragment);
  if (!message) return '';
  const lines = textBlocks(message)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6);
  const text = lines.join(' / ');
  return text.length > MAX_LAST_WORDS ? `...${text.slice(text.length - MAX_LAST_WORDS)}` : text;
}

/**
 * The end of a failed verify run, for the report: the last non-empty lines.
 * @param {string} output
 * @returns {string} newline-joined, capped
 */
function outputTail(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const text = lines.slice(-MAX_TAIL_LINES).join('\n');
  return text.length > MAX_TAIL_CHARS ? text.slice(text.length - MAX_TAIL_CHARS) : text;
}

module.exports = {
  diagnosePackage,
  diagnoseIntegration,
  diagnoseSkip,
  lastWordsFrom,
  outputTail,
  MAX_LAST_WORDS,
  MAX_TAIL_CHARS,
};
