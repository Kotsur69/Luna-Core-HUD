// ============================================================================
// LunaCore - Free God Mode v2 plan runs: the worker lockdown (slice F1c)
// ----------------------------------------------------------------------------
// A plan-run worker writes Markdown and nothing else. That is enforced by the
// CLI's permission config, not by the prompt (weaker models drift):
//
//   profile      `freellm-auto` (ANTHROPIC_MODEL=auto:easy, deliberately no
//                fallback chain, so a build run can never pick it)
//   permissions  --permission-mode dontAsk: anything not on the allow-list is
//                refused without a prompt
//   allow-list   Read Glob Grep WebSearch WebFetch, the read-only Playwright
//                tools (navigate / snapshot / evaluate) and
//                Edit(docs/plans/<run>/**) - an Edit rule covers Write too; a
//                Write(...) rule does NOT match (CLI 2.1.319, live-checked)
//   deny-list    Bash / PowerShell / NotebookEdit and the Playwright tools that
//                fill forms or move files: a deny rule beats any allow rule
//   isolation    --restricted: no user / project / local settings files (no
//                repo hooks, no stray allow rules, no plugins' hooks), file
//                tools confined to the worktree + the brief dir, no code-
//                running tools; --tools names the only built-ins there are;
//                --strict-mcp-config + a Playwright-only --mcp-config file,
//                so no other MCP server (user's or repo's .mcp.json) loads.
//                Live-checked (CLI 2.1.319, headless): Write/Edit inside the
//                plan folder pass, a Write outside it and a Read outside the
//                worktree are denied, there is no shell, and
//                permission_denials lists only those real refusals (the
//                earlier extra denials came from user-level hooks)
//   branches     luna-plan/<slug>, always committed and pushed, integration
//                fixed to 'branches' - the same prefix-safety rules as
//                orchestraFree.js (luna-free/)
//
// A profile command that already decides its own permissions (or tools) can
// never carry the lockdown: such a worker is refused, never started unlocked.
// Build runs and Claude runs never reach this module: their launch command
// stays byte-for-byte what launch.js withTaskBrief() makes.
//
// Pure: no Electron, no fs, no child processes.
// ============================================================================

'use strict';

const { withTaskBrief, isClaudeCommand } = require('./launch');
const { PROTECTED_BRANCHES } = require('./orchestraFree');
const { validateRunSlug, planFolder } = require('./orchestraPlanRun');

/** The profile every plan-run worker (and the free topic planner) runs on. */
const PLAN_PROFILE_ID = 'freellm-auto';
const PLAN_BRANCH_PREFIX = 'luna-plan/';
const PLAN_INTEGRATION = 'branches';
const PLAN_PERMISSION_MODE = 'dontAsk';

/** Read-only Playwright MCP tools: navigate, snapshot, evaluate - nothing else. */
const PLAYWRIGHT_READ_TOOLS = Object.freeze([
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_evaluate',
]);
const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
/** The only built-in tools a plan worker has at all (--tools); Write is gated by the Edit rule. */
const PLAN_TOOLS = Object.freeze([...READ_TOOLS, 'Edit', 'Write']);
/** Same package and flags as the Luna's Work researcher (lunasworkResearch.js). */
const PLAYWRIGHT_PACKAGE = '@playwright/mcp@latest';
// A path typed into the shell single-quoted: no quote, backtick, $ or newline.
const SAFE_PATH_RE = /^[^'`$\r\n‘-‛]+$/;

/**
 * Never allowed, even when a repo's own settings allow them: no shell, no
 * notebook edits, no form filling, no uploads, no downloads.
 */
const DENIED_TOOLS = Object.freeze([
  'Bash',
  'PowerShell',
  'NotebookEdit',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_file_upload',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_run_code',
  'mcp__playwright__browser_install',
  'Task',
  'Agent',
]);

// Profile flags that would decide permissions, tools, settings or MCP servers
// themselves: the lockdown cannot be guaranteed on top of them.
const DECIDES_PERMISSIONS_RE =
  /(^|\s)(--permission-mode|--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--allowed-?tools|--disallowed-?tools|--settings|--setting-sources|--permission-prompt-tool|--tools|--mcp-config|--plugin-dir|--agents)(\s|=|$)/i;

// Typed into the tab's shell instead of `claude` when the lockdown cannot be
// applied: it starts nothing. No apostrophe inside (single-quoted below).
const REFUSED_COMMAND = "echo 'LunaCore did not start this plan worker: its profile command decides permissions itself'";

/** The branch a plan-run package works on, from its worktree slug. */
function planBranchName(slug) {
  return `${PLAN_BRANCH_PREFIX}${slug}`;
}

/**
 * True when `branch` is a plan-run branch that is not the target branch.
 * Same rules as orchestraFree.isSafeFreeBranch, its own prefix.
 * @param {unknown} branch
 * @param {string|null} baseBranch the run's normal target branch
 */
function isSafePlanBranch(branch, baseBranch) {
  if (typeof branch !== 'string' || !branch.startsWith(PLAN_BRANCH_PREFIX)) return false;
  const tail = branch.slice(PLAN_BRANCH_PREFIX.length);
  if (!tail || tail.includes('..')) return false;
  return branch !== baseBranch && !PROTECTED_BRANCHES.has(branch);
}

/**
 * The exact allow-list of one plan run's workers.
 * @param {string} runSlug a slug validateRunSlug() accepts
 * @returns {string[]}
 */
function planAllowedTools(runSlug) {
  // planFolder() throws on a bad slug: no rule is ever built from one.
  const folder = planFolder(runSlug);
  return [...READ_TOOLS, ...PLAYWRIGHT_READ_TOOLS, `Edit(${folder}**)`];
}

/**
 * What a plan run is fixed to, or why it cannot run.
 * @param {{profileExists:boolean}} input whether PLAN_PROFILE_ID is configured
 * @returns {{ok:true, profileId:string, integrationMode:string, branchPrefix:string, permissionMode:string}
 *   | {ok:false, error:'noPlanProfile'}}
 */
function planRunSettings({ profileExists }) {
  if (profileExists !== true) return { ok: false, error: 'noPlanProfile' };
  return {
    ok: true,
    profileId: PLAN_PROFILE_ID,
    integrationMode: PLAN_INTEGRATION,
    branchPrefix: PLAN_BRANCH_PREFIX,
    permissionMode: PLAN_PERMISSION_MODE,
  };
}

/** A plan run's integration can never change away from 'branches'. */
function planIntegrationFor(plan, requested) {
  return plan && plan.planRun ? PLAN_INTEGRATION : requested;
}

/** True for a task object that asks for the plan-worker lockdown. */
function isLockdownTask(task) {
  return !!task && typeof task === 'object' && !!task.lockdown;
}

/**
 * The tab task of a plan-run worker: no model (ANTHROPIC_MODEL of the profile
 * decides), no effort, the lockdown and its own allow-list.
 * @param {{briefPath:string, runSlug:string}} args
 */
function planWorkerTask({ briefPath, runSlug, mcpConfigPath = null }) {
  const slug = validateRunSlug(runSlug);
  if (!slug.ok) throw new TypeError(`invalid plan run slug (${slug.error})`);
  return {
    briefPath,
    model: null,
    effort: null,
    permissionMode: PLAN_PERMISSION_MODE,
    allowedTools: planAllowedTools(slug.slug),
    lockdown: { runSlug: slug.slug, mcpConfigPath: typeof mcpConfigPath === 'string' && mcpConfigPath ? mcpConfigPath : null },
  };
}

/**
 * The plan workers' --mcp-config document: Playwright and nothing else,
 * headless and with a throw-away browser profile.
 */
function planMcpConfig() {
  return {
    mcpServers: {
      playwright: { type: 'stdio', command: 'npx', args: [PLAYWRIGHT_PACKAGE, '--headless', '--isolated'] },
    },
  };
}

const quoted = (rule) => `'${rule}'`;

/**
 * The start command of a plan-run worker: the normal brief launch plus the
 * isolation flags (--restricted, --strict-mcp-config, --tools, the Playwright
 * --mcp-config) and `--permission-mode dontAsk --allowedTools <list>
 * --disallowedTools <list>`. Null when the lockdown cannot be guaranteed (not
 * a plain `claude` launch, a profile that decides permissions / tools / MCP
 * itself, a bad slug, an unsafe brief or MCP config path).
 * @param {string} command the profile's start command
 * @param {{briefPath:string, lockdown:{runSlug:string, mcpConfigPath?:string|null}}} task planWorkerTask()
 * @returns {string|null}
 */
function withPlanLockdown(command, task) {
  const cmd = String(command || '').trim();
  if (!isLockdownTask(task) || !isClaudeCommand(cmd) || DECIDES_PERMISSIONS_RE.test(cmd)) return null;
  const slug = validateRunSlug(task.lockdown.runSlug);
  if (!slug.ok) return null;
  const mcpPath = task.lockdown.mcpConfigPath;
  if (mcpPath != null && (typeof mcpPath !== 'string' || !SAFE_PATH_RE.test(mcpPath))) return null;
  // The plain brief launch, with nothing of the build worker's own flags.
  const base = withTaskBrief(cmd, { briefPath: task.briefPath, model: null, effort: null, permissionMode: null, allowedTools: [] });
  if (!base) return null;
  return [
    base,
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    quoted(PLAN_TOOLS.join(',')),
    // No config file: no MCP server at all (still locked down, just no browser).
    ...(mcpPath ? ['--mcp-config', quoted(mcpPath)] : []),
    '--permission-mode',
    PLAN_PERMISSION_MODE,
    '--allowedTools',
    ...planAllowedTools(slug.slug).map(quoted),
    '--disallowedTools',
    ...DENIED_TOOLS.map(quoted),
  ].join(' ');
}

/**
 * A tab's start command for a worker task. Build / Claude tasks: exactly
 * withTaskBrief() (null = the caller starts the profile command as before).
 * Plan tasks: withPlanLockdown(), or a harmless echo when the lockdown cannot
 * be applied - never the unlocked profile command.
 * @param {string} profileCommand
 * @param {object} task
 * @returns {string|null}
 */
function workerLaunchCommand(profileCommand, task) {
  if (!isLockdownTask(task)) return withTaskBrief(profileCommand, task);
  return withPlanLockdown(profileCommand, task) || REFUSED_COMMAND;
}

/**
 * A restart of a tab whose FIRST launch was a plan worker (profile restart,
 * account failover - the task itself is consumed by then): the locked-down
 * launch again, or the refusal. Null for any other tab, which then restarts
 * exactly as before.
 * @param {string} profileCommand
 * @param {object|null} launchTask the task the tab was first started with
 * @returns {string|null}
 */
function lockedRestartCommand(profileCommand, launchTask) {
  return isLockdownTask(launchTask) ? workerLaunchCommand(profileCommand, launchTask) : null;
}

/**
 * True when a profile's start command can carry the lockdown (checked before
 * a plan run starts, so a broken profile is refused up front).
 * @param {string} command
 */
function canLockdown(command) {
  return withPlanLockdown(command, { briefPath: 'lockdown-check.md', lockdown: { runSlug: 'check' } }) !== null;
}

/**
 * The brief a plan-run worker reads first: the package's own brief plus the
 * rules of the lockdown. No verify step and no git: the worker has no shell,
 * LunaCore commits and pushes its document.
 * @param {{id:string, title:string, prompt:string, planRun:{runSlug:string}}} pkg
 * @param {string} branch
 * @param {{resume?:boolean, escalation?:{reason:string, detail:string|null}, depMerge?:object|null}} [opts]
 * @returns {string}
 */
function planBriefText(pkg, branch, opts = {}) {
  const folder = planFolder(pkg.planRun.runSlug);
  const esc = opts.escalation;
  const depMerge = opts.depMerge !== undefined ? opts.depMerge : pkg.depMerge;
  const missingInputs = !!(depMerge && Array.isArray(depMerge.branches) && depMerge.branches.length);
  return [
    `# LunaCore plan task: ${pkg.title}`,
    '',
    `Package \`${pkg.id}\` of a God Mode plan run. You are in an isolated git worktree on branch \`${branch}\`.`,
    ...(opts.resume
      ? ['', 'RESUMING: an earlier session already worked on this. Read what is already in your output file and continue from there.']
      : []),
    ...(esc
      ? ['', `ESCALATED: the previous worker stalled twice on this package (last reason: ${esc.reason}${esc.detail ? ` - ${esc.detail}` : ''}).`]
      : []),
    ...(missingInputs
      ? ['', 'Some input documents could not be merged into this worktree. If a document you must read is missing, stop and end with the BLOCKED line below.']
      : []),
    '',
    pkg.prompt,
    '',
    '## How this run works',
    `- You can read the whole repo and search and read the web. You can write ONLY inside \`${folder}\`: every other edit, every shell command and every form is refused without asking.`,
    '- Create your document with the Write tool; change it with Edit. Never try a shell command or git: you have none.',
    '- LunaCore commits and pushes your document when you finish. Changes outside the plan folder are reverted and stall the package.',
    `- End your final message with the line \`LUNA_DONE ${pkg.id}\`, or \`LUNA_BLOCKED ${pkg.id}: <reason>\` if you cannot finish.`,
    '',
  ].join('\n');
}

/**
 * The plan-run profile from the profile list: its id, start command and env
 * overlay, or null when it is not configured.
 * @param {object[]} profiles
 * @returns {{id:string, command:string, env:object}|null}
 */
function planProfileFrom(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const p = list.find((x) => x && x.id === PLAN_PROFILE_ID);
  if (!p) return null;
  const command = [p.command, ...(Array.isArray(p.args) ? p.args : [])].filter((s) => typeof s === 'string' && s).join(' ').trim();
  return { id: PLAN_PROFILE_ID, command, env: p.env && typeof p.env === 'object' ? { ...p.env } : {} };
}

module.exports = {
  PLAN_PROFILE_ID,
  PLAN_BRANCH_PREFIX,
  PLAN_INTEGRATION,
  PLAN_PERMISSION_MODE,
  PLAYWRIGHT_READ_TOOLS,
  READ_TOOLS,
  DENIED_TOOLS,
  PLAN_TOOLS,
  REFUSED_COMMAND,
  planMcpConfig,
  lockedRestartCommand,
  planBranchName,
  isSafePlanBranch,
  planAllowedTools,
  planRunSettings,
  planIntegrationFor,
  isLockdownTask,
  planWorkerTask,
  withPlanLockdown,
  workerLaunchCommand,
  canLockdown,
  planBriefText,
  planProfileFrom,
};
