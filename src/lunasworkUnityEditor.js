// ============================================================================
// LunaCore - Luna's Work Unity adapter: the editor before play mode
// ----------------------------------------------------------------------------
// A playtest must run the code the build just merged. An open, unfocused
// Unity editor does not import or compile it on its own (Unity compiles on
// focus or an Asset Database refresh), so run lwmwwnl7xf playtested STALE code:
// the merges had landed, Library/ScriptAssemblies had no new dll, the scene
// said "referenced script (Unknown) is missing". Before play mode (Unity
// Pipeline only) the adapter therefore runs prepareEditor():
//
//   1. auto tick on for the session (`editor set_auto_tick`, persisted so it
//      survives the domain reloads of the recompile and of play mode);
//      restoreAutoTick() puts the previous setting back after the playtest,
//      also when start fails
//   2. `editor status`: the codeLoadCount before the compile
//   3. asset refresh (the Assets/Refresh menu item), then `script recompile`
//      (no focus steal: auto tick keeps the editor running unfocused)
//   4. poll `script recompile_status` + `editor status` until the compile is
//      done, its domain reload finished and the editor idle - at most
//      COMPILE_WAIT_MS; busy / reload answers are retried
//   5. the compile check: the console's groundTruth.compilationFailed from a
//      fresh sample. The same answer carries the console cursor the playtest
//      window starts from (helpers/playtest-bridge/unityConsole.js).
//
// A compile failure, a compile still running at the end of the wait or an
// editor that stays busy is an ENVIRONMENT failure, never a game result:
// prepareEditor() throws an Error that carries {ok:false, environment:true,
// reason, errors} (environmentFailureOf() hands it back as a plain object),
// so no Playtester runs and nothing is scored.
//
// The previous auto tick setting: the editor has no command that reads it
// (`set_auto_tick` answers the state AFTER the call, `editor status` does not
// carry it). What can be known is the setting the editor runs with by its own
// config: on, every 16 ms, while the Pipeline watchdog is enabled
// (UserSettings/Packages/com.unity.pipeline/EditorPipelineConfig.json
// m_WatchdogEnabled, default true), off otherwise. previousAutoTick() reads
// that; an explicit set_auto_tick someone made earlier in the same editor
// session cannot be seen.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { UNITY_PIPELINE, UNITY_PIPELINE_EDITOR } = require('../helpers/playtest-bridge/unity');
const { consoleWindowOf } = require('../helpers/playtest-bridge/unityConsole');
const { PIPELINE_ERROR, isTransientPipelineError, pipelineCommandDidNotRun } = require('../helpers/playtest-bridge/pipeline-http');

const POLL_MS = 500;
// err.code of a wait that ran out of its deadline.
const WAIT_TIMEOUT = 'LUNA_UNITY_WAIT_TIMEOUT';
// The bounded wait for refresh + recompile + its domain reload + the compile check.
const COMPILE_WAIT_MS = 4 * 60 * 1000;
// A successful compile reloads the domain (codeLoadCount + 1). An idle editor
// whose count did not move is accepted after this long, so a compile that
// reloads nothing cannot stall the start.
const RELOAD_GRACE_MS = 5 * 1000;
// A groundTruth sample older than this describes an older console (the package's own limit is 2 s).
const GROUND_TRUTH_MAX_AGE_MS = 2000;
// An editor that gives no groundTruth at all: recompile_status alone decides after this long.
const GROUND_TRUTH_GRACE_MS = 5 * 1000;
const MAX_COMPILE_ERRORS = 20;
const MAX_COMPILE_ERROR_CHARS = 500;
const COMPILER_ERROR_RE = /\berror CS\d{4}\b/;
const MAX_CONFIG_CHARS = 64 * 1024;
const PIPELINE_CONFIG_PARTS = Object.freeze(['UserSettings', 'Packages', 'com.unity.pipeline', 'EditorPipelineConfig.json']);
// com.unity.pipeline AutoTickCommand.DefaultIntervalMs and EditorPipelineConfig.DefaultWatchdogEnabled.
const AUTO_TICK_INTERVAL_MS = 16;
const DEFAULT_WATCHDOG_ENABLED = true;
/** The setting a playtest runs with. */
const AUTO_TICK_SESSION = Object.freeze({ enabled: true, intervalMs: AUTO_TICK_INTERVAL_MS });

const RECOMPILE_DONE = new Set(['completed', 'up_to_date']);
const RECOMPILE_RUNNING = new Set(['triggered', 'compiling']);
const EDITOR_BUSY_STATUSES = new Set(['compiling', 'reloading', 'blocked_by_dialog']);

/** err.code of an environment failure, and its reasons. */
const UNITY_ENVIRONMENT_FAILURE = 'LUNA_UNITY_ENVIRONMENT';
const ENVIRONMENT_REASON = Object.freeze({
  compileFailed: 'compile-failed',
  stillCompiling: 'still-compiling',
  editorBusy: 'editor-busy',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const seconds = (ms) => Math.round(ms / 1000);

// ---- waits --------------------------------------------------------------------------

/**
 * The adapter's two waits on one clock.
 * @param {{now:()=>number, sleep:(ms:number)=>Promise<unknown>}} clock
 */
function createWaits({ now, sleep }) {
  /**
   * Polls `probe` until it returns true. A failure `retryable` accepts (by
   * default a transient Unity Pipeline failure: a domain reload) is retried
   * until `deadline`; any other ends the wait at once.
   */
  async function pollUntil(deadline, probe, timeoutMessage, retryable = isTransientPipelineError) {
    let last = null;
    for (;;) {
      try {
        if (await probe()) return;
        last = null;
      } catch (err) {
        if (!retryable(err)) throw err;
        last = err;
      }
      if (now() >= deadline) {
        throw Object.assign(new Error(last ? `${timeoutMessage} (last error: ${errText(last)})` : timeoutMessage), { code: WAIT_TIMEOUT });
      }
      await sleep(POLL_MS);
    }
  }

  /** One editor action, sent again until `deadline` only while the editor certainly did not run it. */
  function act(deadline, send, timeoutMessage) {
    const once = async () => {
      await send();
      return true;
    };
    return pollUntil(deadline, once, timeoutMessage, pipelineCommandDidNotRun);
  }

  return { pollUntil, act };
}

// ---- environment failure -----------------------------------------------------------

/** Compiler messages as short single strings, at most MAX_COMPILE_ERRORS. */
function cleanErrors(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => typeof e === 'string' && e.trim())
    .slice(0, MAX_COMPILE_ERRORS)
    .map((e) => e.trim().slice(0, MAX_COMPILE_ERROR_CHARS));
}

/** An Error that IS the environment-failure result {ok:false, environment:true, reason, errors}. */
function environmentFailure(reason, message, errors = []) {
  return Object.assign(new Error(message), { code: UNITY_ENVIRONMENT_FAILURE, ok: false, environment: true, reason, errors: cleanErrors(errors) });
}

/** True for the error prepareEditor() throws when the editor, not the game, failed. */
function isEnvironmentFailure(err) {
  return !!err && err.code === UNITY_ENVIRONMENT_FAILURE && err.environment === true;
}

/**
 * The plain environment-failure result of such an error, else null.
 * @returns {{ok:false, environment:true, reason:string, message:string, errors:string[]}|null}
 */
function environmentFailureOf(err) {
  if (!isEnvironmentFailure(err)) return null;
  return { ok: false, environment: true, reason: err.reason, message: err.message, errors: [...err.errors] };
}

/** The compiler messages: recompile_status's own, else the console's compiler errors. */
function compileErrors(statusErrors, consoleAnswer) {
  const own = cleanErrors(statusErrors);
  if (own.length) return own;
  const entries = isObj(consoleAnswer) && Array.isArray(consoleAnswer.entries) ? consoleAnswer.entries : [];
  return cleanErrors(entries.filter((e) => isObj(e) && typeof e.message === 'string' && COMPILER_ERROR_RE.test(e.message)).map((e) => e.message));
}

function compileFailure(errors) {
  const clean = cleanErrors(errors);
  const count = clean.length ? ` (${clean.length} compiler error${clean.length === 1 ? '' : 's'})` : '';
  const first = clean.length ? `: ${clean[0]}` : ' (see the Unity console)';
  return environmentFailure(ENVIRONMENT_REASON.compileFailed, `Unity could not compile the game's scripts${count}${first} - not a playtest result`, clean);
}

/** A wait that ran out: still compiling, or an editor that stayed busy. */
function timeoutFailure(err, watch) {
  const reason = watch.state === 'compiling' ? ENVIRONMENT_REASON.stillCompiling : ENVIRONMENT_REASON.editorBusy;
  const what = reason === ENVIRONMENT_REASON.stillCompiling ? 'Unity was still compiling' : 'the Unity editor stayed busy';
  return environmentFailure(reason, `${what} after ${seconds(COMPILE_WAIT_MS)}s - not a playtest result (${errText(err)})`);
}

// ---- auto tick ----------------------------------------------------------------------

/**
 * The auto tick setting the editor runs with by its own config (see the
 * header): on at 16 ms while the Pipeline watchdog is enabled, else off.
 * @param {string} unityProjectDir
 * @param {(line:string)=>void} [log]
 * @returns {{enabled:boolean, intervalMs:number}}
 */
function previousAutoTick(unityProjectDir, log = () => {}) {
  const file = path.join(unityProjectDir, ...PIPELINE_CONFIG_PARTS);
  let watchdog = DEFAULT_WATCHDOG_ENABLED;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > MAX_CONFIG_CHARS) throw new Error('too large');
    const config = JSON.parse(text);
    if (isObj(config) && typeof config.m_WatchdogEnabled === 'boolean') watchdog = config.m_WatchdogEnabled;
  } catch (err) {
    // Never the parser's message: it would quote the file.
    const why = err && typeof err.code === 'string' ? err.code : 'not valid JSON';
    if (!err || err.code !== 'ENOENT') log(`[lunaswork] Unity Pipeline config unreadable (${why}); auto tick goes back to the package default after the playtest`);
  }
  return { enabled: watchdog, intervalMs: AUTO_TICK_INTERVAL_MS };
}

/** A command that ran and failed (or does not exist): nothing was changed. */
const commandFailed = (err) => !!err && err.code === PIPELINE_ERROR.failed;

/**
 * One preparation step whose failure is not fatal: refused -> `onFailed`, a
 * lost answer -> logged (it may have run). A wait that ran out still throws.
 */
async function optionalStep(io, deadline, call, what, onFailed = () => {}) {
  try {
    await io.waits.act(deadline, () => io.call(call), `Unity did not take the ${what} within ${seconds(COMPILE_WAIT_MS)}s`);
  } catch (err) {
    if (commandFailed(err)) {
      onFailed();
      io.log(`[lunaswork] Unity ${what} refused (${errText(err)}); going on`);
      return;
    }
    if (!isTransientPipelineError(err)) throw err;
    io.log(`[lunaswork] Unity ${what}: no answer (${errText(err)}), going on`);
  }
}

/**
 * Puts the previous auto tick setting back; throws when the editor did not take it.
 * @param {{call:Function, waits:object, autoTick:{changed:boolean, previous:object|null}}} io
 * @param {number} deadline
 */
async function restoreAutoTick(io, deadline) {
  if (!io.autoTick.changed) return;
  const previous = io.autoTick.previous || { enabled: DEFAULT_WATCHDOG_ENABLED, intervalMs: AUTO_TICK_INTERVAL_MS };
  await io.waits.act(deadline, () => io.call(UNITY_PIPELINE_EDITOR.setAutoTick(previous)), 'Unity did not take the auto tick setting back in time');
  io.autoTick.changed = false;
}

// ---- compile ------------------------------------------------------------------------

/** True while the editor compiles, reloads its domain or sits behind a dialog. */
function editorBusy(status) {
  if (!isObj(status)) return true;
  return status.compiling === true || status.domainReloadInProgress === true || EDITOR_BUSY_STATUSES.has(status.status);
}

async function editorStatus(io, deadline) {
  let status = null;
  const probe = async () => {
    status = await io.call(UNITY_PIPELINE.state());
    return true;
  };
  await io.waits.pollUntil(deadline, probe, `Unity did not answer editor status within ${seconds(COMPILE_WAIT_MS)}s`);
  return isObj(status) ? status : {};
}

/** `script recompile`: a refusal (compile errors standing) or a lost answer leaves the verdict to the status poll. */
async function triggerRecompile(io, deadline) {
  try {
    await io.waits.act(deadline, () => io.call(UNITY_PIPELINE_EDITOR.recompile()), `Unity did not start the recompile within ${seconds(COMPILE_WAIT_MS)}s`);
  } catch (err) {
    if (commandFailed(err)) {
      io.log(`[lunaswork] Unity script recompile refused (${errText(err)}); reading its status`);
      return;
    }
    if (!isTransientPipelineError(err)) throw err;
    io.log(`[lunaswork] Unity script recompile: no answer (${errText(err)}), waiting for the editor`);
  }
}

/** True once the scripts reloaded since `before` (or when either side has no count). */
function reloadedSince(before, status) {
  const a = before.codeLoadCount;
  const b = status.codeLoadCount;
  return !Number.isInteger(a) || !Number.isInteger(b) || a !== b;
}

/**
 * Polls until the recompile is done and its domain reload finished.
 * @returns {Promise<{failed:boolean, errors:string[], status:string}>}
 */
async function waitForCompile(io, deadline, before, watch) {
  let result = null;
  let idleSince = null;
  const probe = async () => {
    watch.state = 'busy';
    const rs = await io.call(UNITY_PIPELINE_EDITOR.recompileStatus());
    const status = isObj(rs) && typeof rs.status === 'string' ? rs.status : '';
    if (RECOMPILE_RUNNING.has(status)) watch.state = 'compiling';
    if (!RECOMPILE_DONE.has(status)) return false;
    if (rs.failed === true) {
      result = { failed: true, errors: cleanErrors(rs.errors), status };
      return true;
    }
    const es = await io.call(UNITY_PIPELINE.state());
    if (editorBusy(es)) {
      if (isObj(es) && es.compiling === true) watch.state = 'compiling';
      idleSince = null;
      return false;
    }
    if (status === 'completed' && !reloadedSince(before, es)) {
      if (idleSince === null) idleSince = io.now();
      if (io.now() - idleSince < RELOAD_GRACE_MS) return false;
      io.log(`[lunaswork] Unity compiled but did not reload its scripts within ${seconds(RELOAD_GRACE_MS)}s; going on`);
    }
    result = { failed: false, errors: [], status };
    return true;
  };
  await io.waits.pollUntil(deadline, probe, `Unity did not finish compiling within ${seconds(COMPILE_WAIT_MS)}s`);
  return result;
}

/**
 * The compile check: a `console get --level error` whose groundTruth is a
 * fresh sample of an editor that is not compiling.
 * @returns {Promise<object>} the console answer
 */
async function readCompileCheck(io, deadline, watch) {
  let answer = null;
  let missingSince = null;
  const probe = async () => {
    watch.state = 'busy';
    answer = await io.call(UNITY_PIPELINE_EDITOR.compileCheck());
    const truth = isObj(answer) && isObj(answer.groundTruth) ? answer.groundTruth : null;
    if (!truth) {
      if (missingSince === null) missingSince = io.now();
      return io.now() - missingSince >= GROUND_TRUTH_GRACE_MS;
    }
    if (truth.compiling === true) {
      watch.state = 'compiling';
      return false;
    }
    return !(typeof truth.ageMs === 'number' && truth.ageMs > GROUND_TRUTH_MAX_AGE_MS);
  };
  await io.waits.pollUntil(deadline, probe, `Unity gave no current compile state within ${seconds(COMPILE_WAIT_MS)}s`);
  if (!isObj(answer) || !isObj(answer.groundTruth)) io.log('[lunaswork] Unity console gave no groundTruth; the compile verdict is recompile_status alone');
  return answer;
}

/**
 * Brings the editor up to date before play mode (see the header). Throws an
 * environment failure (isEnvironmentFailure) when the game's code does not
 * compile or the editor does not settle within COMPILE_WAIT_MS.
 * @param {{call:Function, now:()=>number, waits:{pollUntil:Function, act:Function}, log:(line:string)=>void,
 *   autoTick:{changed:boolean, previous:object|null}}} io
 * @returns {Promise<{window:{session:string, cursor:number, startedAt:string}|null, groundTruth:object|null}>}
 */
async function prepareEditor(io) {
  const deadline = io.now() + COMPILE_WAIT_MS;
  const watch = { state: 'busy' };
  try {
    // From here on restoreAutoTick() puts the setting back, even when the answer is lost.
    io.autoTick.changed = true;
    await optionalStep(io, deadline, UNITY_PIPELINE_EDITOR.setAutoTick(AUTO_TICK_SESSION), 'auto tick', () => {
      io.autoTick.changed = false;
    });
    const before = await editorStatus(io, deadline);
    // `script recompile` refreshes too; the menu item runs first so a new asset is imported either way.
    await optionalStep(io, deadline, UNITY_PIPELINE_EDITOR.refresh(), 'asset refresh');
    await triggerRecompile(io, deadline);
    const compiled = await waitForCompile(io, deadline, before, watch);
    const check = await readCompileCheck(io, deadline, watch);
    const truth = isObj(check) && isObj(check.groundTruth) ? check.groundTruth : null;
    if (compiled.failed || (truth && truth.compilationFailed === true)) throw compileFailure(compileErrors(compiled.errors, check));
    return { window: consoleWindowOf(check, new Date(io.now()).toISOString()), groundTruth: truth };
  } catch (err) {
    if (err && err.code === WAIT_TIMEOUT) throw timeoutFailure(err, watch);
    throw err;
  }
}

module.exports = {
  POLL_MS,
  WAIT_TIMEOUT,
  COMPILE_WAIT_MS,
  RELOAD_GRACE_MS,
  AUTO_TICK_SESSION,
  PIPELINE_CONFIG_PARTS,
  UNITY_ENVIRONMENT_FAILURE,
  ENVIRONMENT_REASON,
  createWaits,
  previousAutoTick,
  restoreAutoTick,
  prepareEditor,
  isEnvironmentFailure,
  environmentFailureOf,
};
