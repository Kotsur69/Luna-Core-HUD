// ============================================================================
// LunaCore - Luna's Work: open the playtest scene in edit mode (Unity Pipeline)
// ----------------------------------------------------------------------------
// `scene open` refuses to run while the editor is in (or entering) play mode:
//   "Command Execution Failed - 'scene open' cannot run while the editor is in
//    (or entering) play mode. Exit play mode (editor.playmode stop) and retry"
// Seen live (Luna's Work run lwmwzajado, Blade & Bullet): play mode was left on
// in the editor, every playtest start failed, and the run paused 30 min as
// "tool down" three times until a human stopped play mode.
//
// So before `scene open` the adapter (src/lunasworkUnity.js enterPlayMode)
// reads the editor's play mode from the last `editor status` prepareEditor
// already read (no extra call when the editor is in edit mode). Playing or
// entering: `editor.playmode stop`, wait (PLAY_MODE_EXIT_WAIT_MS) until the
// status reads edit mode, then open the scene. A `scene open` that is still
// refused with exactly that error stops play mode and is sent once more, in
// the same start. Nothing else in the scene state is touched.
// ============================================================================

'use strict';

const { isTransientPipelineError } = require('../helpers/playtest-bridge/pipeline-http');
const { isPlaying } = require('../helpers/playtest-bridge/unity');

// Leaving play mode reloads the domain (port file gone, busy answers): retried until this.
const PLAY_MODE_EXIT_WAIT_MS = 30 * 1000;
// The Pipeline's `editor status` playMode value in edit mode (unity.js UNITY_PIPELINE.state).
const EDIT_MODE = 'stopped';
const PLAY_MODE_BLOCK_RE = /cannot run while the editor is in \(or entering\) play mode/i;
const PLAY_MODE_STOPPED_LINE = '[lunaswork] editor was in play mode: stopped it before opening the scene';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** True when an editor status says play mode is on or on its way (anything but edit mode). */
function playModeOn(status) {
  if (!isObj(status)) return false;
  if (typeof status.playMode === 'string') return status.playMode !== EDIT_MODE;
  if (status.isPlayingOrWillChangePlaymode === true) return true;
  return isPlaying(status);
}

/** True for the editor's "cannot run while the editor is in (or entering) play mode" refusal. */
function isPlayModeBlock(err) {
  return !!err && PLAY_MODE_BLOCK_RE.test(errText(err));
}

/**
 * Opens `scene` with the editor in edit mode (see the header).
 * @param {{call:Function, calls:{state:Function, stop:Function, openScene:Function}, scene:string,
 *   status:object|null, deadline:number, sec:number, now:()=>number,
 *   waits:{pollUntil:Function, act:Function}, log:(line:string)=>void}} io
 *   status = the last `editor status` answer (null: read here); deadline = the start's
 * @returns {Promise<number>} the start deadline to go on with: a fresh one after play mode was stopped
 */
async function openSceneInEditMode(io) {
  const { call, calls, scene, sec, now, waits } = io;
  const openMessage = `Unity could not open ${scene} within ${sec}s`;
  const fresh = () => now() + sec * 1000;
  let deadline = io.deadline;
  const status = io.status || (await readStatus(io));
  if (playModeOn(status)) {
    await stopPlayMode(io);
    deadline = fresh();
  }
  try {
    await waits.act(deadline, () => call(calls.openScene(scene)), openMessage);
  } catch (err) {
    if (!isPlayModeBlock(err)) throw err;
    // The status said edit mode, or play mode began after it: stop it, then one more try.
    await stopPlayMode(io);
    deadline = fresh();
    await waits.act(deadline, () => call(calls.openScene(scene)), openMessage);
  }
  return deadline;
}

/** One `editor status` read, retried through a domain reload. */
async function readStatus({ call, calls, now, waits }) {
  let status = null;
  const probe = async () => {
    status = await call(calls.state());
    return true;
  };
  await waits.pollUntil(now() + PLAY_MODE_EXIT_WAIT_MS, probe, `Unity did not answer editor status within ${PLAY_MODE_EXIT_WAIT_MS / 1000}s`);
  return isObj(status) ? status : null;
}

/** `editor.playmode stop`, then the wait for edit mode; one log line. */
async function stopPlayMode({ call, calls, now, waits, log }) {
  const deadline = now() + PLAY_MODE_EXIT_WAIT_MS;
  const sec = PLAY_MODE_EXIT_WAIT_MS / 1000;
  try {
    await waits.act(deadline, () => call(calls.stop()), `Unity could not leave play mode within ${sec}s`);
  } catch (err) {
    // Sent, but the answer was lost (the domain reload of leaving play mode): the poll tells.
    // A refused stop is fine only when the editor is in edit mode by now (it left on its own).
    if (!isTransientPipelineError(err) && playModeOn(await call(calls.state()))) throw err;
  }
  await waits.pollUntil(deadline, async () => !playModeOn(await call(calls.state())), `Unity did not return to edit mode within ${sec}s`);
  log(PLAY_MODE_STOPPED_LINE);
}

module.exports = {
  PLAY_MODE_EXIT_WAIT_MS,
  PLAY_MODE_STOPPED_LINE,
  playModeOn,
  isPlayModeBlock,
  openSceneInEditMode,
};
