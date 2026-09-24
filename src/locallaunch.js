// ============================================================================
// LunaCore - launch prep for local-model tabs (LM Studio)
// ----------------------------------------------------------------------------
// spawnInto() fixes a tab's env at pty.spawn, so everything a LM Studio tab
// needs has to be known BEFORE the spawn, not after a watcher tick:
//
//   - the shim URL (src/lmstudioshim.js), without which turn one is a 400,
//     and the shim's token, sent as a custom header on every request;
//   - which model EVERY tier maps to. Claude Code sends side requests under
//     the haiku/fable/small-fast tiers too; left unset, those name a model
//     LM Studio does not have;
//   - CLAUDE_CODE_MAX_CONTEXT_TOKENS = the LOADED context length. Unset, the
//     CLI assumes 200k and auto-compacts long after LM Studio has overflowed;
//   - the lean launch flags: MCP servers off and a set of built-in CLI tools
//     hidden, which halved the first-turn prompt (measured 2026-09-24).
//
// Lean mode NEVER trims ~/.claude: CLAUDE.md, rules, skills, agents and hooks
// always load in full - the flags below only touch MCP servers and tools that
// ship inside the CLI itself.
//
// Pure over injected deps (probe, shim, MCP file), so it is testable without
// LM Studio, and prepareLocalLaunch() never rejects: a failed step degrades to
// the direct upstream / no extra env instead of a tab that never starts.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { localEndpointFromProfile, pickLoadedModel } = require('./lmstudio');
const { SHIM_TOKEN_HEADER, withoutHeader } = require('./sessionenv');

const LOCAL_LAUNCH_KEYS = ['shim', 'leanMcp', 'leanTools'];

/** Every env var Claude Code reads to pick a model for some request tier. */
const TIER_MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

/**
 * Built-in CLI tools a local session has no use for. Their schemas alone were
 * ~43 KB of every request. Harness content (skills, agents) is not listed and
 * must never be.
 */
const LEAN_DISALLOWED_TOOLS = [
  'DesignSync', 'Workflow', 'SendMessage', 'ScheduleWakeup', 'EnterWorktree',
  'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList', 'ReportFindings',
  'PushNotification', 'NotebookEdit', 'ListAgents', 'TaskStop',
];

const EMPTY_MCP_CONFIG = { mcpServers: {} };
const MCP_CONFIG_FILE = 'lmstudio-empty-mcp.json';

/** Upper bound on the whole pre-spawn wait. A tab must open regardless. */
const PREP_TIMEOUT_MS = 4000;

/**
 * Per-request timeout for a local tab (50 min, the value GLM ships with). The
 * CLI's 10-minute default is too close to a full 128k prefill on a 16 GB card
 * (measured ~8 min) for an unattended run.
 */
const LOCAL_API_TIMEOUT_MS = 50 * 60 * 1000;

/**
 * Validates a localLaunch block: only known keys with boolean values survive.
 * @param {unknown} value
 * @returns {{shim?:boolean, leanMcp?:boolean, leanTools?:boolean}|null}
 */
function normalizeLocalLaunch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    LOCAL_LAUNCH_KEYS.filter((k) => typeof value[k] === 'boolean').map((k) => [k, value[k]]),
  );
}

/**
 * The effective launch settings for a profile: its template's defaults with
 * the profile's own values on top. Null = not a local-launch profile.
 * @param {{templateId?:string|null, localLaunch?:Object|null}} profile
 * @param {Array<{id:string, localLaunch?:Object|null}>} providers
 * @returns {{shim:boolean, leanMcp:boolean, leanTools:boolean}|null}
 */
function resolveLocalLaunch(profile, providers) {
  if (!profile) return null;
  const template = profile.templateId
    ? (providers || []).find((p) => p && p.id === profile.templateId)
    : null;
  const fromTemplate = normalizeLocalLaunch(template && template.localLaunch);
  const fromProfile = normalizeLocalLaunch(profile.localLaunch);
  if (!fromTemplate && !fromProfile) return null;
  const merged = { ...(fromTemplate || {}), ...(fromProfile || {}) };
  return Object.fromEntries(LOCAL_LAUNCH_KEYS.map((k) => [k, merged[k] === true]));
}

/**
 * The tab's effective ANTHROPIC_CUSTOM_HEADERS (one "Name: value" per line)
 * with the shim token line appended. Any earlier line for the shim header is
 * dropped, so the tab always carries exactly the current token.
 * @param {unknown} current the value the tab would otherwise get
 * @param {string} token
 * @returns {string}
 */
function withShimHeader(current, token) {
  const kept = withoutHeader(current, SHIM_TOKEN_HEADER);
  return [kept, `${SHIM_TOKEN_HEADER}: ${token}`].filter(Boolean).join('\n');
}

/**
 * Env overrides for a local tab. A key the profile already sets is never
 * touched - an explicit choice always wins over a derived one. The two
 * exceptions are the shim routing keys: the base URL has to point at the
 * shim, and the custom headers are merged, never replaced - the profile's
 * own value, or the inherited one when the profile sets none.
 * @param {{profileEnv:Object, inheritedEnv?:Object, model:string|null, contextLength:number|null, shimUrl:string|null, shimToken?:string|null}} input
 * @returns {Object}
 */
function buildLocalEnv({ profileEnv, inheritedEnv = {}, model, contextLength, shimUrl, shimToken = null }) {
  const own = profileEnv || {};
  const isUnset = (key) => typeof own[key] !== 'string' || own[key] === '';
  const tiers = model
    ? Object.fromEntries(TIER_MODEL_KEYS.filter(isUnset).map((k) => [k, model]))
    : {};
  const context = Number.isInteger(contextLength) && contextLength > 0 && isUnset('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextLength) }
    : {};
  const timeout = isUnset('API_TIMEOUT_MS') ? { API_TIMEOUT_MS: String(LOCAL_API_TIMEOUT_MS) } : {};
  // Without its token the shim refuses every request, so a URL alone is
  // worse than the direct upstream - route through it only with both.
  const viaShim = typeof shimUrl === 'string' && shimUrl !== '' && typeof shimToken === 'string' && shimToken !== '';
  const headers = typeof own.ANTHROPIC_CUSTOM_HEADERS === 'string'
    ? own.ANTHROPIC_CUSTOM_HEADERS
    : (inheritedEnv || {}).ANTHROPIC_CUSTOM_HEADERS;
  const shim = viaShim
    ? { ANTHROPIC_BASE_URL: shimUrl, ANTHROPIC_CUSTOM_HEADERS: withShimHeader(headers, shimToken) }
    : {};
  return { ...tiers, ...context, ...timeout, ...shim };
}

/**
 * Single-quotes one argument for the shell the command is typed into
 * (PowerShell on Windows, a POSIX shell elsewhere - both read '...' literally).
 * Returns null for a value that cannot be quoted that simply.
 * NOT general-purpose shell quoting: only for trusted values (a userData path,
 * a constant list) - never for free-form user or model text.
 */
function quoteArg(value) {
  if (typeof value !== 'string' || !value || value.includes("'")) return null;
  return `'${value}'`;
}

/**
 * CLI flags for the lean toggles.
 * @param {{leanMcp?:boolean, leanTools?:boolean}} localLaunch
 * @param {{mcpConfigPath?:string|null}} opts
 * @returns {{args:string[], notes:string[]}}
 */
function buildLocalArgs(localLaunch, { mcpConfigPath = null } = {}) {
  const args = [];
  const notes = [];
  if (localLaunch && localLaunch.leanMcp) {
    const quoted = quoteArg(mcpConfigPath);
    if (quoted) args.push('--strict-mcp-config', '--mcp-config', quoted);
    else notes.push('mcp-config-unavailable');
  }
  if (localLaunch && localLaunch.leanTools) {
    args.push('--disallowedTools', quoteArg(LEAN_DISALLOWED_TOOLS.join(',')));
  }
  return { args, notes };
}

/**
 * Writes the empty MCP config the lean flag points at (the packaged app's
 * config/ lives inside the asar, which an external `claude` cannot read).
 * @returns {string|null} absolute path, or null when it could not be written
 */
function ensureEmptyMcpConfig(dir, fsImpl = fs) {
  try {
    const file = path.join(dir, MCP_CONFIG_FILE);
    const wanted = JSON.stringify(EMPTY_MCP_CONFIG);
    let current = null;
    try {
      current = fsImpl.readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== wanted) fsImpl.writeFileSync(file, wanted, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** Resolves to the promise's value, or to `fallback` on rejection/timeout. */
function settle(promiseFactory, timeoutMs, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    Promise.resolve()
      .then(promiseFactory)
      .then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); resolve(fallback); },
      );
  });
}

/** The loaded row the session will talk to, per the profile's model rule. */
function targetModel(profile, models) {
  const explicit = profile.env && typeof profile.env.ANTHROPIC_MODEL === 'string' ? profile.env.ANTHROPIC_MODEL : '';
  if (explicit) {
    const row = (models || []).find((m) => m && m.id === explicit);
    return { model: explicit, contextLength: row && row.loaded === true ? row.loadedContext : null };
  }
  if (profile.autoModel !== true) return { model: null, contextLength: null };
  const row = pickLoadedModel(models);
  return row ? { model: row.id, contextLength: row.loadedContext } : { model: null, contextLength: null };
}

/**
 * Everything a local tab needs before its spawn. Never rejects.
 * @param {Object} profile
 * @param {{shim:boolean, leanMcp:boolean, leanTools:boolean}} localLaunch
 * @param {{probe:Function, ensureShim:Function, ensureMcpFile:Function, inheritedEnv?:Object, timeoutMs?:number}} deps
 * @returns {Promise<{envOverrides:Object, extraArgs:string[], notes:string[]}>}
 */
async function prepareLocalLaunch(profile, localLaunch, deps) {
  const timeoutMs = deps.timeoutMs || PREP_TIMEOUT_MS;
  const upstream = localEndpointFromProfile(profile);
  const notes = [];
  if (!upstream) return { envOverrides: {}, extraArgs: [], notes: ['not-local'] };

  const [probe, shim] = await Promise.all([
    settle(() => deps.probe(upstream), timeoutMs, null),
    localLaunch.shim ? settle(() => deps.ensureShim(upstream), timeoutMs, null) : Promise.resolve(null),
  ]);
  if (!probe || !probe.up) notes.push('probe-failed');
  const shimReady = Boolean(shim && shim.ok && shim.url && shim.token);
  if (localLaunch.shim && !shimReady) notes.push('shim-failed');

  let mcpConfigPath = null;
  if (localLaunch.leanMcp) {
    try {
      mcpConfigPath = deps.ensureMcpFile();
    } catch {
      mcpConfigPath = null;
    }
  }
  const { args, notes: argNotes } = buildLocalArgs(localLaunch, { mcpConfigPath });
  const { model, contextLength } = targetModel(profile, probe && probe.up ? probe.models : []);

  return {
    envOverrides: buildLocalEnv({
      profileEnv: profile.env,
      inheritedEnv: deps.inheritedEnv,
      model,
      contextLength,
      shimUrl: shimReady ? shim.url : null,
      shimToken: shimReady ? shim.token : null,
    }),
    extraArgs: args,
    notes: [...notes, ...argNotes],
  };
}

/**
 * Runs prep, then spawns - unless the tab was closed or relaunched meanwhile
 * (a newer launch bumps session.spawnSeq, so a slow stale prep is dropped).
 * @param {{spawnSeq?:number}} session
 * @param {Object} profile
 * @param {{prepare:Function, spawn:Function, isLive:Function}} hooks
 */
async function launchWhenReady(session, profile, { prepare, spawn, isLive }) {
  const seq = (session.spawnSeq || 0) + 1;
  session.spawnSeq = seq;
  const launch = await prepare();
  if (!isLive() || session.spawnSeq !== seq) return;
  spawn(session, profile, launch);
}

module.exports = {
  normalizeLocalLaunch,
  resolveLocalLaunch,
  buildLocalEnv,
  buildLocalArgs,
  ensureEmptyMcpConfig,
  prepareLocalLaunch,
  launchWhenReady,
  LEAN_DISALLOWED_TOOLS,
  TIER_MODEL_KEYS,
  PREP_TIMEOUT_MS,
};
