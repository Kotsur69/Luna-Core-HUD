// ============================================================================
// LunaCore - a `claude -p` call run on the Antigravity CLI (`agy`)
// ----------------------------------------------------------------------------
// Luna's Work's role runners (Director, Critic, Playtester, Researcher, ...)
// build a `claude -p --output-format json --json-schema <S> --model <m>` argv
// and parse Claude's JSON envelope. When a role is set to 'agy' the argv says
// `--model agy` (or `--model agy:<id>`, one model of `agy models`):
// execAgy() runs that call as one headless `agy --print`
// (src/orchestraAgy.js runAgyPrint, prompt on stdin) and hands back agy's
// answer as the same envelope, so every runner's parser reads it unchanged.
//
//   argsUseAgy(args)    the argv asks for agy (`--model agy`)
//   execAgy(call)       execClaude's contract: {stdout} | {error, detail?}
//   agyEnvelope(text)   agy's text as `--output-format json`'s result envelope
//
// What carries over from the Claude argv: the JSON schema (into the prompt,
// agy has no --json-schema) and whether the call may edit files (--tools
// naming Write / Edit, or an accept-edits / bypass permission mode ->
// `--mode accept-edits`), and an 'agy:<id>' model (-> agy's `--model <id>`).
// Everything else is Claude-only and dropped: the
// tool allow / deny lists, --mcp-config (agy reads MCP servers only from its
// own config file, src/launch.js header), --agent, --effort, the dollar cap.
// So a read-only role on agy is read-only because agy's --print mode is not
// given accept-edits, not because a tool list says so.
//
// The env is the agy profile's (src/agyprofile.js agyEnv). Without one the
// call is refused with 'noAgyProfile' - it never falls back to claude.
// ============================================================================

'use strict';

const { runAgyPrint, agyJsonPrompt, extractJsonObject } = require('./orchestraAgy');
const { AGY_MODEL } = require('./claudeModels');
const { isAgyModel, agyModelIdOf } = require('./workerModels');
const { sharedAgyModels } = require('./agymodels');

/** Claude tools that write files: a call allowed any of them may edit on agy too. */
const EDIT_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Claude permission modes that auto-accept edits. */
const EDIT_MODES = Object.freeze(['acceptEdits', 'bypassPermissions']);
const NO_PROFILE_DETAIL = 'no Antigravity (agy) profile is configured';

/** The value right after `flag` in an argv, else null. */
function argValue(args, flag) {
  const list = Array.isArray(args) ? args : [];
  const i = list.indexOf(flag);
  return i >= 0 && i + 1 < list.length && typeof list[i + 1] === 'string' ? list[i + 1] : null;
}

/**
 * True when a `claude -p` argv asks for the Antigravity CLI: `--model agy`
 * or `--model agy:<id>`. That `--model` is LunaCore's internal marker in a
 * Claude-style argv, never passed on: agy gets its own `--model <id>` (the
 * bare id) from execAgy.
 * @param {unknown} args
 * @returns {boolean}
 */
function argsUseAgy(args) {
  return isAgyModel(argValue(args, '--model'));
}

/** --json-schema's schema, or null when the argv has none (or it is not a JSON object). */
function schemaOf(args) {
  const raw = argValue(args, '--json-schema');
  if (raw === null) return null;
  try {
    const schema = JSON.parse(raw);
    return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
  } catch {
    return null;
  }
}

/** True when the Claude argv lets the call edit files. */
function wantsEdits(args) {
  const tools = String(argValue(args, '--tools') || '')
    .split(',')
    .map((t) => t.trim());
  if (tools.some((t) => EDIT_TOOLS.includes(t))) return true;
  return EDIT_MODES.includes(argValue(args, '--permission-mode')) || (Array.isArray(args) && args.includes('--dangerously-skip-permissions'));
}

/**
 * agy's text answer as the Claude CLI's `--output-format json` result
 * envelope: the text as result and, for a call that asked for a JSON schema,
 * the parsed JSON object (when there is one) as structured_output. A call
 * without a schema never gets one: a stray `{...}` in prose is not an answer.
 * agy reports no cost and no tokens.
 * @param {string} text
 * @param {{structured?:boolean}} [opts] structured: the call asked for a schema (default true)
 * @returns {string} the envelope, serialized
 */
function agyEnvelope(text, { structured = true } = {}) {
  const result = String(text == null ? '' : text);
  const obj = structured ? extractJsonObject(result) : null;
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    ...(obj ? { structured_output: obj } : {}),
    total_cost_usd: null,
  });
}

/**
 * One `claude -p` call run as `agy --print`. Same contract as
 * lunasworkCritic.execClaude: resolves {stdout} (Claude's envelope) or
 * {error, detail?} - 'noAgyProfile', 'badAgyModel', 'noAgy', 'timeout',
 * 'limit' or 'failed'. Never rejects.
 *
 * `--model agy:<id>` runs agy with `--model <id>`, once the id is found in
 * the live `agy models` list (src/agymodels.js, read once if it never was);
 * an id it does not hold is refused ('badAgyModel') and never reaches argv.
 * @param {{args:string[], prompt:string, cwd:string, env:object|null, timeoutMs:number, execImpl?:Function,
 *   agyModels?:{ensure:Function, isKnownId:Function}}} call
 *   env: the agy profile's env; null = no agy profile; agyModels: the model cache (default: the shared one)
 * @returns {Promise<{stdout:string}|{error:string, detail?:string}>}
 */
async function execAgy({ args, prompt, cwd, env, timeoutMs, execImpl, agyModels }) {
  if (!env || typeof env !== 'object') return { error: 'noAgyProfile', detail: NO_PROFILE_DETAIL };
  const model = agyModelIdOf(argValue(args, '--model'));
  if (model) {
    const cache = agyModels || sharedAgyModels();
    await cache.ensure();
    if (!cache.isKnownId(model)) return { error: 'badAgyModel', detail: `agy model "${model}" is not in the \`agy models\` list` };
  }
  const schema = schemaOf(args);
  const res = await runAgyPrint({
    cwd,
    env,
    timeout: timeoutMs,
    edits: wantsEdits(args),
    model,
    prompt: schema ? agyJsonPrompt(prompt, schema) : String(prompt || ''),
    ...(typeof execImpl === 'function' ? { execImpl } : {}),
  });
  if (!res.ok) return { error: res.error, ...(res.detail ? { detail: res.detail } : {}) };
  return { stdout: agyEnvelope(res.stdout, { structured: schema !== null }) };
}

module.exports = { AGY_MODEL, argsUseAgy, schemaOf, wantsEdits, agyEnvelope, execAgy };
