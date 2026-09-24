// ============================================================================
// LunaCore - session environment assembly
// ----------------------------------------------------------------------------
// Pure env helpers for every `claude` LunaCore starts (terminal tabs and the
// headless /ask call), kept out of main.js so they can be tested without
// booting Electron.
//
// ORDER MATTERS: the marker strip applies to the INHERITED env only. It used
// to run on the merged env, after the profile and the local-launch overrides
// were layered on, and silently deleted every CLAUDE_CODE_* key those layers
// set on purpose (CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_SUBAGENT_MODEL).
//
// ANTHROPIC_CUSTOM_HEADERS ("Name: value", one per line) is also where a
// LM Studio tab carries its shim token (src/lmstudioshim.js). A LunaCore
// started from inside such a tab inherits that line, so it is stripped from
// the inherited env like any other marker - otherwise every non-shim tab
// would send it to its provider (api.z.ai, api.anthropic.com, ...).
// ============================================================================

'use strict';

/** Inherited keys that mark "you are running inside another Claude session". */
const EXPLICIT_MARKERS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_EFFORT']);

/** Request header carrying a LM Studio shim's token (lower case, as Node reports it). */
const SHIM_TOKEN_HEADER = 'x-lunacore-shim-token';

/**
 * An ANTHROPIC_CUSTOM_HEADERS value without any line for header `name`
 * (case-insensitive) and without blank lines. '' when nothing is left.
 * @param {unknown} value
 * @param {string} name lower-case header name
 * @returns {string}
 */
function withoutHeader(value, name) {
  if (typeof value !== 'string') return '';
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && line.split(':')[0].trim().toLowerCase() !== name)
    .join('\n');
}

/**
 * When LunaCore itself was launched from inside a Claude Code session (e.g.
 * `npm start` run from Claude's own terminal), the process inherits session
 * markers in env: CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID,
 * etc. A nested `claude` sees them and starts as a "child session" -> DISABLES
 * transcript saving ("transcript saving is off - inherited claude_code_child_session
 * marker"). And without a transcript neither the Context Window bar nor the
 * sparkline works (they read the JSONL). So we strip the markers, so a session
 * inside LunaCore is always a full, top-level one - regardless of where
 * LunaCore itself was launched from. We don't touch config (ANTHROPIC_*),
 * except for dropping an inherited shim-token header line (see the header).
 * Mutates and returns `env`.
 * @param {Record<string,string>} env
 */
function stripClaudeSessionMarkers(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE') || EXPLICIT_MARKERS.has(key)) delete env[key];
  }
  if (typeof env.ANTHROPIC_CUSTOM_HEADERS === 'string') {
    const kept = withoutHeader(env.ANTHROPIC_CUSTOM_HEADERS, SHIM_TOKEN_HEADER);
    if (kept) env.ANTHROPIC_CUSTOM_HEADERS = kept;
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  return env;
}

/**
 * Guarantees color in the PTY session.
 *
 * Reason: when LunaCore is launched from a terminal that disables color
 * (Claude Code sets NO_COLOR=1 so its own output stays clean), a nested
 * `claude` inherits that variable and renders COMPLETELY WITHOUT COLOR - the
 * Claude logo comes out white instead of orange. This is not a theme bug:
 * xterm receives plain text, so no theme can fix it.
 *
 * So we clear the color-suppressing variables and declare a 256-color +
 * truecolor terminal. We do NOT override COLORTERM if the user set it deliberately.
 * Mutates and returns `env`.
 * @param {Record<string,string>} env
 */
function withColorSupport(env) {
  delete env.NO_COLOR;
  // FORCE_COLOR=0 is an explicit "no color"; any other value is left alone.
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR;
  env.TERM = 'xterm-256color';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';
  return env;
}

/**
 * The env for one `claude` process: the inherited env minus session markers,
 * then each layer on top in order (profile env, auto model, launch overrides).
 * Layers are applied AFTER the strip, so a CLAUDE_CODE_* key a layer sets on
 * purpose always survives. Never mutates its inputs; null layers are skipped.
 * @param {Record<string,string>|null|undefined} inherited
 * @param {...(Record<string,string>|null|undefined)} layers
 * @returns {Record<string,string>}
 */
function buildSessionEnv(inherited, ...layers) {
  const env = stripClaudeSessionMarkers({ ...(inherited || {}) });
  for (const layer of layers) {
    if (layer && typeof layer === 'object') Object.assign(env, layer);
  }
  return env;
}

module.exports = { stripClaudeSessionMarkers, withColorSupport, buildSessionEnv, withoutHeader, SHIM_TOKEN_HEADER };
