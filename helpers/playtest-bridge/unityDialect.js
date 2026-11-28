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
// result failed) and every step has a built-in equivalent (key and wait),
// the driver gets one probe: a single zero-ms wait step, which has no effect
// in the game. A driver that rejects even that cannot read LunaCore's step
// format at all, so nothing of the call ran: the same steps run on the
// editor's built-in key route (unityBuiltin.js, runtime simulate_key) and the
// answer carries a mismatch warning the Playtester puts in its report. From
// then on, for the rest of the session, key/wait-only calls go straight to
// the built-in route; calls with other step types still try the driver.
//
// A driver that passes the probe reads the format: its failure is the game's
// own (a bad key name, a paused game, a step that threw half way) and comes
// back as it is - nothing is re-run, so no key is pressed twice and a game
// failure is never blamed on the contract. A transport failure (timeout,
// busy, editor gone) is not a dialect question either. Plain Node, no
// dependencies.
// ============================================================================

'use strict';

const { PIPELINE_ERROR } = require('./pipeline-http');

const FALLBACK_STEP_TYPES = Object.freeze(['key', 'wait']);
// The step format probe: one LunaCore step that does nothing in the game.
const PROBE_STEP = Object.freeze({ type: 'wait', ms: 0 });
// A step result or status that says the step did not run: it must START with
// the failure word, so a success text such as "all steps ran, no error" never matches.
const FAILED_RE = /^\s*(?:fail(?:ed|ure)?|reject(?:ed)?|unsupported|unknown|invalid|error)\b/i;
// The editor's error message quoted in a reason (the game's own answer text never is).
const MAX_REASON_CHARS = 160;
// Per-step result arrays a driver may answer with.
const STEP_RESULT_KEYS = Object.freeze(['results', 'steps']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
// One line of plain text: control, format (bidi, zero-width) and separator characters become spaces.
const clip = (text) => String(text).replace(/[\p{C}\p{Z}\s]+/gu, ' ').trim().slice(0, MAX_REASON_CHARS);
/** A command the editor ran and that failed (success:false), as pipeline-http.js throws it. */
const commandFailed = (err) => !!err && err.code === PIPELINE_ERROR.failed;

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
 * does not (a success, a partial run, or an answer this cannot read). The
 * reason is a fixed text: the game's own answer text is never echoed to the
 * Playtester (it is untrusted and would land in the report).
 * @param {unknown} answer the `playtest input` result
 * @param {object[]} steps what was sent
 * @returns {string|null}
 */
function noneRan(answer, steps) {
  if (typeof answer === 'string') return FAILED_RE.test(answer) ? 'the driver answered with a failure text' : null;
  if (!isObj(answer)) return null;
  if (Number.isInteger(answer.done) && answer.done > 0) return null;
  if (answer.done === 0 && steps.length > 0) return `the driver ran 0 of ${steps.length} steps`;
  if (answer.success === false) return 'the driver answered success: false';
  if (typeof answer.status === 'string' && FAILED_RE.test(answer.status)) return 'the driver answered a failed status';
  for (const key of STEP_RESULT_KEYS) {
    const list = answer[key];
    if (Array.isArray(list) && list.length > 0 && list.every(stepFailed)) return `the driver answered every step as failed (${key})`;
  }
  return null;
}

/** The warning a fallback answer carries. */
function mismatchWarning(reason) {
  return `PlaytestDriver step format mismatch: the game's 'playtest input' rejected LunaCore's steps (${reason}; it rejects even a 0 ms wait step). `
    + 'Key and wait steps ran on the editor\'s built-in key route (runtime simulate_key) instead; button, axis, click, ui and game step types still need a driver that follows the PLAYTEST CONTRACT. '
    + 'Report this as a PlaytestDriver contract problem, not as a game input bug.';
}

/** The note on a call the built-ins cannot run, once the mismatch is known. */
const needsDriverNote = (reason) => `None of these steps ran (${reason}). The game's PlaytestDriver does not accept LunaCore's step format (see the earlier mismatch warning), and only key and wait steps have a built-in stand-in.`;

/**
 * True when the driver rejects the probe step too: it cannot read LunaCore's
 * step format. A transport failure of the probe is thrown.
 */
async function rejectsFormat(driver) {
  try {
    return noneRan(await driver([{ ...PROBE_STEP }]), [PROBE_STEP]) !== null;
  } catch (err) {
    if (commandFailed(err)) return true;
    throw err;
  }
}

/**
 * The dialect state of one bridge session (one Playtester).
 * @returns {{run:(routes:{driver:(steps:object[])=>Promise<unknown>, builtin:(steps:object[])=>Promise<unknown>}, steps:object[])=>Promise<unknown>, mismatch:()=>string|null}}
 */
function createInputDialect() {
  let warning = null; // set once the built-in route stood in for a driver that rejects the format

  /** The steps on the built-ins; the warning is kept only when they ran. */
  async function viaBuiltin(builtin, steps, note, reason) {
    let answer;
    try {
      answer = await builtin(steps);
    } catch (err) {
      throw new Error(`${errText(err)} (the built-in key route stood in because ${reason})`, { cause: err });
    }
    warning = note;
    return { ...(isObj(answer) ? answer : { answer }), route: 'builtin', warnings: [note] };
  }

  async function run({ driver, builtin }, steps) {
    const fallback = builtinCanRun(steps);
    if (warning && fallback) return viaBuiltin(builtin, steps, warning, 'the driver rejects LunaCore\'s step format');
    let answer;
    let failure = null;
    let reason;
    try {
      answer = await driver(steps);
      reason = noneRan(answer, steps);
    } catch (err) {
      // Only a command the editor ran and that failed is a dialect question.
      if (!commandFailed(err)) throw err;
      failure = err;
      reason = `the command failed: ${clip(err.message)}`;
    }
    if (!reason) return answer;
    if (fallback && (await rejectsFormat(driver))) return viaBuiltin(builtin, steps, mismatchWarning(reason), reason);
    // The game's own failure (or steps the built-ins cannot run): back as it is, nothing re-run.
    if (failure) {
      if (warning) throw new Error(`${failure.message} (${needsDriverNote('the command failed')})`, { cause: failure });
      throw failure;
    }
    const note = warning ? needsDriverNote(reason) : `None of these steps ran (${reason}).`;
    return isObj(answer) ? { ...answer, warnings: [note] } : { answer, warnings: [note] };
  }

  return { run, mismatch: () => warning };
}

module.exports = {
  FALLBACK_STEP_TYPES,
  PROBE_STEP,
  builtinCanRun,
  noneRan,
  mismatchWarning,
  createInputDialect,
};
