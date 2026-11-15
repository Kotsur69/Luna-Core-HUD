// ============================================================================
// LunaCore - God Mode follow-up channel: launch wiring and revocation
// ----------------------------------------------------------------------------
// Which lunacore MCP config and allow rules a God Mode session starts with
// (the channel itself is src/orchestraFollowups.js):
//
//   every God Mode session that runs a model - package workers, plan-run
//   workers, the merge fix-up ('fixup') and the self-check fix-up
//   ('selfcheck') - carries a `godMode` marker on its tab task
//   ({runId, packageId, followups}). main's prepareIntake then issues a
//   SCOPED token instead of the tab's full one (never both):
//     followups on   scope 'worker': luna_todo_add + luna_todo_list
//     followups off  scope 'godmode': no to-do tool at all
//   --allowedTools gets mcp__lunacore__luna_todo_add / _list only when the
//   option is on (so a dontAsk worker never stalls on them), and loses them
//   when it is off.
//
//   regular workers   the session's --mcp-config file (withIntakeMcp) holds
//                     the scoped token
//   plan-run workers  --strict-mcp-config: no lunacore server when the option
//                     is off (as before); when it is on, a per-session file
//                     holds their Playwright server(s) plus lunacore, and it
//                     replaces the shared Playwright-only file on the command
//
// A token is revoked when its package settles (pushed, stalled, failed,
// closed, killed), when the fix-up settles, when the run is discarded and
// when a run is restored after a restart - always matched by run + package,
// so a newer worker's or a user tab's token is never touched.
// ============================================================================

'use strict';

const fs = require('fs');
const { SERVER_NAME, mcpConfigFor, sessionConfigPath } = require('./intake');
const { withIntakeMcp } = require('./launch');
const { RUN_ID_RE, PACKAGE_ID_RE } = require('./orchestraFollowups');

/** The allow rules of the channel's two tools. */
const FOLLOWUP_ALLOWED_TOOLS = Object.freeze(['luna_todo_add', 'luna_todo_list'].map((n) => `mcp__${SERVER_NAME}__${n}`));
const SELFCHECK_PACKAGE_ID = 'selfcheck';
const FIXUP_PACKAGE_ID = 'fixup';
// A path typed into the shell single-quoted: no quote, backtick, $ or newline
// (same rule as orchestraPlanRunLaunch.js SAFE_PATH_RE).
const SAFE_PATH_RE = /^[^'`$\r\n\u2018-\u201B]+$/;
const STRICT_RE = /(^|\s)--strict-mcp-config(?=\s|$)/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isLockdown = (task) => isObj(task) && !!task.lockdown;
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * A God Mode tab task with its marker and the channel's allow rules on (or
 * off). Never mutates `task`.
 * @param {object} task a worker / plan-worker / fix-up task
 * @param {{runId:string, packageId:string, followups:boolean}} who
 * @returns {object}
 */
function godModeTask(task, { runId, packageId, followups }) {
  const base = isObj(task) ? task : {};
  const on = followups === true;
  const godMode = { runId, packageId, followups: on };
  if (isLockdown(base)) {
    // Off: the lockdown exactly as orchestraPlanRunLaunch.js made it, no extra rule.
    const { extraAllowedTools: _dropped, ...lockdown } = base.lockdown;
    return { ...base, godMode, lockdown: on ? { ...lockdown, extraAllowedTools: [...FOLLOWUP_ALLOWED_TOOLS] } : lockdown };
  }
  const own = (Array.isArray(base.allowedTools) ? base.allowedTools : []).filter((rule) => !FOLLOWUP_ALLOWED_TOOLS.includes(rule));
  return { ...base, godMode, allowedTools: on ? [...own, ...FOLLOWUP_ALLOWED_TOOLS] : own };
}

/**
 * The validated God Mode marker of a tab task, or null (not a God Mode
 * session, or a marker that does not hold up - such a tab gets no scoped token).
 * @param {unknown} task
 * @returns {{runId:string, packageId:string, followups:boolean}|null}
 */
function godModeOf(task) {
  const gm = isObj(task) && isObj(task.godMode) ? task.godMode : null;
  if (!gm || typeof gm.runId !== 'string' || !RUN_ID_RE.test(gm.runId)) return null;
  if (typeof gm.packageId !== 'string' || !PACKAGE_ID_RE.test(gm.packageId)) return null;
  return { runId: gm.runId, packageId: gm.packageId, followups: gm.followups === true };
}

/** True for a task that carries a God Mode marker at all (valid or not). */
const hasGodModeMarker = (task) => isObj(task) && task.godMode !== undefined;

/** The intake token scope of a God Mode session. */
function intakeScopeOf(gm) {
  return { scope: gm.followups ? 'worker' : 'godmode', runId: gm.runId, packageId: gm.packageId };
}

/**
 * The extra allow rules a plan-run lockdown may carry: only the channel's two
 * tools, whatever else the task holds.
 * @param {unknown} lockdown
 * @returns {string[]}
 */
function lockdownExtraTools(lockdown) {
  const extra = isObj(lockdown) && Array.isArray(lockdown.extraAllowedTools) ? lockdown.extraAllowedTools : [];
  return FOLLOWUP_ALLOWED_TOOLS.filter((rule) => extra.includes(rule));
}

/**
 * The servers of a plan worker's own MCP config file, minus any `lunacore`
 * entry; {} when it has none; null when the file cannot be read (the worker
 * then keeps its original config and gets no channel).
 */
function baseServers(file, fsImpl) {
  if (file === null || file === undefined) return {};
  if (typeof file !== 'string' || !file) return null;
  const doc = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  if (!isObj(doc) || !isObj(doc.mcpServers)) return null;
  return Object.fromEntries(Object.entries(doc.mcpServers).filter(([name, cfg]) => name !== SERVER_NAME && isObj(cfg)));
}

/**
 * Issues a God Mode session's scoped token and writes its --mcp-config file.
 * @param {{dir:string, sessionId:string, url:string, server:{issueToken:Function, revoke:Function},
 *   task:object, fsImpl?:object, log?:(line:string) => void}} args
 * @returns {string|null} the file, or null: no lunacore server for this session
 */
function writeGodModeConfig({ dir, sessionId, url, server, task, fsImpl = fs, log = () => {} }) {
  const gm = godModeOf(task);
  if (!gm) {
    if (hasGodModeMarker(task)) log(`[followups] session ${sessionId}: invalid God Mode marker, no lunacore tools`);
    return null;
  }
  const locked = isLockdown(task);
  // A plan worker had no lunacore server before the channel: only the option adds one.
  if (locked && !gm.followups) return null;
  let base = {};
  if (locked) {
    try {
      base = baseServers(task.lockdown.mcpConfigPath, fsImpl);
    } catch (err) {
      base = null;
      log(`[followups] session ${sessionId}: plan worker MCP config unreadable (${errText(err)})`);
    }
    if (!base) return null;
  }
  const token = server.issueToken(sessionId, intakeScopeOf(gm));
  const file = sessionConfigPath(dir, sessionId);
  try {
    const doc = { mcpServers: { ...base, ...mcpConfigFor(url, token).mcpServers } };
    fsImpl.writeFileSync(file, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (err) {
    server.revoke(sessionId);
    log(`[followups] session ${sessionId}: MCP config not written (${err && err.code ? err.code : errText(err)})`);
    return null;
  }
}

/**
 * The start command with the session's lunacore config attached. Not a God
 * Mode session or a regular worker: exactly withIntakeMcp(). A plan worker
 * with the option on: its shared Playwright-only file is swapped for the
 * per-session file (which holds those servers too); otherwise unchanged.
 * @param {string} command
 * @param {string|null} configPath what prepareIntake returned
 * @param {object|null} task the tab's launch task
 * @returns {string}
 */
function withGodModeMcp(command, configPath, task) {
  if (!godModeOf(task) || !isLockdown(task)) return withIntakeMcp(command, configPath);
  const cmd = String(command || '').trim();
  if (!godModeOf(task).followups || typeof configPath !== 'string' || !SAFE_PATH_RE.test(configPath)) return cmd;
  // The refusal echo of an unlockable profile has no --strict-mcp-config: left alone.
  if (!STRICT_RE.test(cmd)) return cmd;
  const shared = task.lockdown.mcpConfigPath;
  const withoutShared = typeof shared === 'string' && shared ? cmd.split(` --mcp-config '${shared}'`).join('') : cmd;
  return withoutShared.replace(STRICT_RE, (_m, lead) => `${lead}--strict-mcp-config --mcp-config '${configPath}'`);
}

/**
 * The tabs of a run's settled packages that may still hold a token.
 * @param {object|null} plan
 * @param {Set<string>} settledStates orchestraSupervisor.SETTLED_STATES
 * @returns {Array<{sessionId:string, runId:string, packageId:string}>}
 */
function settledSessions(plan, settledStates) {
  if (!plan || !Array.isArray(plan.packages)) return [];
  return plan.packages
    .filter((p) => p && settledStates.has(p.state) && typeof p.sessionId === 'string' && p.sessionId)
    .map((p) => ({ sessionId: p.sessionId, runId: plan.id, packageId: p.id }));
}

/**
 * The orchestra controller's revoke hooks over one intake server.
 * @param {{revokeScoped:Function, revokeRun:Function}|null} intake
 */
function followupDeps(intake) {
  if (!intake) return {};
  return {
    revokeFollowups: (list) => {
      for (const s of Array.isArray(list) ? list : []) intake.revokeScoped(s.sessionId, { runId: s.runId, packageId: s.packageId });
    },
    revokeRunFollowups: (runId) => intake.revokeRun(runId),
  };
}

module.exports = {
  FOLLOWUP_ALLOWED_TOOLS,
  SELFCHECK_PACKAGE_ID,
  FIXUP_PACKAGE_ID,
  godModeTask,
  godModeOf,
  intakeScopeOf,
  lockdownExtraTools,
  writeGodModeConfig,
  withGodModeMcp,
  settledSessions,
  followupDeps,
};
