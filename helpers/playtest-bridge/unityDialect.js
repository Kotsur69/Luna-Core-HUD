// ============================================================================
// LunaCore - send_input when the game's PlaytestDriver speaks another step
// dialect (Luna's Work, Unity Pipeline)
// ----------------------------------------------------------------------------
// LunaCore sends its own step JSON (tools.js send_input) to `playtest input`
// as soon as the game lists that command. A driver written against a step
// format of its own answers every step 'Failed': seen live (Blade & Bullet),
// the keyboard score went from 8 to 0 for a whole iteration.
//
// So the game's answer is checked. When it shows that NONE of LunaCore's
// steps ran (the command failed, done: 0, success: false, or every per-step
// result failed) and every step has a built-in equivalent (key and wait), the
// same steps run on the editor's built-in key route (unityBuiltin.js, runtime
// simulate_key) and the answer carries a mismatch warning the Playtester puts
// in its report. From then on, for the rest of the session, key/wait-only
// calls go straight to the built-in route; calls with other step types still
// try the driver, which may accept them.
//
// A call where some steps ran is never re-run (that would press keys twice),
// and a transport failure (timeout, busy, editor gone) is not a dialect
// problem: both reach the Playtester as they are. Plain Node, no dependencies.
// ============================================================================

'use strict';

const { PIPELINE_ERROR } = require('./pipeline-http');

const FALLBACK_STEP_TYPES = Object.freeze(['key', 'wait']);
// A step result or status that says the step did not run.
const FAILED_RE = /\b(?:fail(?:ed|ure)?|reject(?:ed)?|unsupported|unknown|invalid|error)\b/i;
const MAX_REASON_CHARS = 300;
// Per-step result arrays a driver may answer with.
const STEP_RESULT_KEYS = Object.freeze(['results', 'steps']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);

/** True when every step has a built-in equivalent. */
function builtinCanRun(steps) {
  return Array.isArray(steps) && steps.length > 0 && steps.every((s) => isObj(s) && FALLBACK_STEP_TYPES.includes(s.type));
}

/** True when one per-step result says the step failed. */
function stepFailed(entry) {
  if (typeof entry === 'string') return FAILED_RE.test(entry);
  if (!isObj(entry)) return false;
  if (entry.ok === false || entry.success === false) return true;
  return ['status', 'result'].some((key) => typeof entry[key] === 'string' && FAILED_RE.test(entry[key]));
}

/**
 * Why the driver's answer shows that none of the steps ran, or null when it
 * does not (a success, a partial run, or an answer this cannot read).
 * @param {unknown} answer the `playtest input` result
 * @param {object[]} steps what was sent
 * @returns {string|null}
 */
function noneRan(answer, steps) {
  if (typeof answer === 'string') return FAILED_RE.test(answer) ? `the driver answered "${clip(answer)}"` : null;
  if (!isObj(answer)) return null;
  if (Number.isInteger(answer.done) && answer.done > 0) return null;
  if (answer.done === 0 && steps.length > 0) return `the driver ran 0 of ${steps.length} steps`;
  if (answer.success === false) return `the driver answered success: false${answer.error ? ` (${clip(answer.error)})` : ''}`;
  if (typeof answer.status === 'string' && FAILED_RE.test(answer.status)) return `the driver answered status "${clip(answer.status)}"`;
  for (const key of STEP_RESULT_KEYS) {
    const list = answer[key];
    if (Array.isArray(list) && list.length > 0 && list.every(stepFailed)) return `the driver answered every step as failed (${key})`;
  }
  return null;
}

/** The warning a fallback answer carries, once per answer. */
function mismatchWarning(reason) {
  return `PlaytestDriver step format mismatch: the game's 'playtest input' rejected LunaCore's steps (${clip(reason)}). `
    + 'Key and wait steps ran on the editor\'s built-in key route (runtime simulate_key) instead; button, axis, click, ui and game step types still need a driver that follows the PLAYTEST CONTRACT. '
    + 'Report this as a PlaytestDriver contract problem, not as a game input bug.';
}

/**
 * The dialect state of one bridge session (one Playtester).
 * @returns {{run:(routes:{driver:(steps:object[])=>Promise<unknown>, builtin:(steps:object[])=>Promise<unknown>}, steps:object[])=>Promise<unknown>, mismatch:()=>string|null}}
 */
function createInputDialect() {
  let warning = null;

  const viaBuiltin = async (builtin, steps) => {
    const answer = await builtin(steps);
    return { ...(isObj(answer) ? answer : { answer }), route: 'builtin', warnings: [warning] };
  };

  async function run({ driver, builtin }, steps) {
    const fallback = builtinCanRun(steps);
    if (warning && fallback) return viaBuiltin(builtin, steps);
    let answer;
    try {
      answer = await driver(steps);
    } catch (err) {
      // Only a command the editor ran and that failed is a dialect question.
      if (!err || err.code !== PIPELINE_ERROR.failed) throw err;
      if (fallback) {
        warning = mismatchWarning(err.message);
        return viaBuiltin(builtin, steps);
      }
      if (warning) throw new Error(`${err.message} (${warning})`, { cause: err });
      throw err;
    }
    const reason = noneRan(answer, steps);
    if (!reason) return answer;
    if (fallback) {
      warning = mismatchWarning(reason);
      return viaBuiltin(builtin, steps);
    }
    // Not re-run on the built-ins (they cannot run these types): the answer goes back with a note.
    const note = warning || `None of these steps ran (${reason}). If the driver rejects every step, its step format does not match the PLAYTEST CONTRACT.`;
    return isObj(answer) ? { ...answer, warnings: [note] } : { answer, warnings: [note] };
  }

  return { run, mismatch: () => warning };
}

module.exports = {
  FALLBACK_STEP_TYPES,
  builtinCanRun,
  noneRan,
  mismatchWarning,
  createInputDialect,
};
