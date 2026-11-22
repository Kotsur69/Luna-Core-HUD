// ============================================================================
// LunaCore - Unity Pipeline: AttackStep frame data <-> AnimationClip sync
// ----------------------------------------------------------------------------
// A scene / asset worker calls `animation_frame_sync` to check that an attack
// AnimationClip matches its AttackStep ScriptableObject (startup / active /
// recovery frame counts, the expected frame rate, Animator root motion off),
// and optionally to bake AnimationEvent markers at the exact frames.
//
//   1. checkFrameSyncPayload(raw)       the worker's payload, validated
//   2. UNITY_PIPELINE_ANIMATION.inspect the editor reads clip + AttackStep
//   3. readInspectResult(result)        the editor's answer, validated
//   4. validateAttackFrames(input)      pure: mismatches + event frames
//   5. UNITY_PIPELINE_ANIMATION.bake    only when bake is asked and step 4 found
//                                       nothing but root motion on (the bake turns it off)
//
// Pipeline protocol (the C# side is a custom command group `animation` in the
// game project; NOT verified against a live editor yet - if it names the
// commands or fields differently, fix them HERE):
//
//   animation inspect {clip, attackStep, character?}
//     -> {clip: {length (s), frameRate}, attackStep: {startup, active,
//         recovery, parryStart?, parryEnd?}, rootMotion: <Animator.applyRootMotion>}
//   animation bake_events {clip, events: '<JSON [{functionName, frame, time}]>',
//                          applyRootMotion: false, character?}
//     Existing events with the same function names are replaced, others kept.
//     An .fbx clip is written through its ModelImporter clipAnimations.
//     character (a prefab) names the animator; without it the C# side uses
//     the Animators whose controller references the clip.
//
// Plain Node, no dependencies. This module does not require unity.js (which
// requires it); the runner takes the Pipeline invoke function instead.
// ============================================================================

'use strict';

const ANIMATION_GROUP = 'animation';
const ASSETS_PREFIX = 'Assets/';
const CLIP_EXTS = Object.freeze(['.anim', '.fbx']);
const ATTACK_STEP_EXTS = Object.freeze(['.asset']);
const CHARACTER_EXTS = Object.freeze(['.prefab']);
const MAX_PATH_CHARS = 260;
const MIN_FPS = 10;
const MAX_FPS = 240;
// Fighting-game frame data is counted at 60 fps unless the payload says otherwise.
const DEFAULT_ATTACK_FPS = 60;
// A clip's frame rate is a float in Unity (e.g. 59.99994); closer than this counts as equal.
const FPS_TOLERANCE = 0.01;
const MAX_FRAMES = 10000;
const MAX_CLIP_SECONDS = 600;
const MAX_CLIP_FPS = 1000;
// Printable ASCII only (no look-alike dots, no bidi overrides), minus the
// characters Windows or Unity refuse, and '%' (no encoded dots for the C# side).
const SEGMENT_RE = /^[\x20-\x7e]+$/;
const BAD_SEGMENT_CHARS = /[<>:"|?*\\%]/;
// Windows device names (CON, NUL, COM1...) are not files, even with an extension.
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\.|$)/i;

/** AnimationEvent function names the character's MonoBehaviour receives. */
const EVENT_FUNCTIONS = Object.freeze({
  hitOpen: 'OnHitWindowOpen',
  hitClose: 'OnHitWindowClose',
  recoveryEnd: 'OnRecoveryEnd',
  parryOpen: 'OnParryWindowOpen',
  parryClose: 'OnParryWindowClose',
});

/** Codes of validateAttackFrames() mismatches. */
const MISMATCH = Object.freeze({
  tooShort: 'frames_too_short',
  tooLong: 'frames_too_long',
  fps: 'wrong_fps',
  rootMotion: 'root_motion_on',
  parry: 'parry_outside_clip',
  parryOrder: 'parry_window_empty',
});

// The one mismatch the bake itself repairs (it sets applyRootMotion false).
const BAKE_FIXES = new Set([MISMATCH.rootMotion]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFrame = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_FRAMES;

class PayloadError extends Error {}

// ---- 1. the worker's payload --------------------------------------------------------

/**
 * One folder or file name: printable ASCII, no padding, not '.', not ending in
 * '.' (Windows drops it) or '~' (Unity ignores the folder), not a device name.
 */
function isAssetSegment(s) {
  if (!s || s !== s.trim() || !SEGMENT_RE.test(s) || BAD_SEGMENT_CHARS.test(s)) return false;
  return !s.endsWith('.') && !s.endsWith('~') && !WINDOWS_DEVICE_RE.test(s);
}

/** A project-relative asset path under Assets/ with one of `exts`, or a PayloadError. */
function assetPath(raw, field, exts) {
  if (typeof raw !== 'string' || !raw) throw new PayloadError(`${field} must be a non-empty string`);
  if (raw.length > MAX_PATH_CHARS) throw new PayloadError(`${field} is longer than ${MAX_PATH_CHARS} characters`);
  if (!raw.startsWith(ASSETS_PREFIX)) throw new PayloadError(`${field} must start with ${ASSETS_PREFIX}`);
  if (raw.includes('..')) throw new PayloadError(`${field} must not contain '..'`);
  const segments = raw.slice(ASSETS_PREFIX.length).split('/');
  if (segments.some((s) => !isAssetSegment(s))) throw new PayloadError(`${field} has an empty segment or characters an asset path cannot hold`);
  // The file name needs a base name before its extension ('Slash.anim', not '.anim').
  const fileName = segments[segments.length - 1].toLowerCase();
  if (!exts.some((ext) => fileName.endsWith(ext) && fileName.length > ext.length)) {
    throw new PayloadError(`${field} must end in ${exts.join(' or ')}`);
  }
  return raw;
}

function fpsValue(raw) {
  if (raw === undefined || raw === null) return DEFAULT_ATTACK_FPS;
  if (!Number.isInteger(raw) || raw < MIN_FPS || raw > MAX_FPS) throw new PayloadError(`fps must be a whole number from ${MIN_FPS} to ${MAX_FPS}`);
  return raw;
}

function bakeFlag(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new PayloadError('bake must be true or false');
  return raw;
}

/**
 * Validates the worker's animation_frame_sync payload; unknown keys are dropped.
 * @param {unknown} raw {clipPath, attackStepPath, fps?, bake?, characterPath?}
 * @returns {{ok:true, args:{clipPath:string, attackStepPath:string, fps:number, bake:boolean, characterPath?:string}}|{ok:false, error:string}}
 */
function checkFrameSyncPayload(raw) {
  if (!isObj(raw)) return { ok: false, error: 'payload must be an object' };
  try {
    const args = {
      clipPath: assetPath(raw.clipPath, 'clipPath', CLIP_EXTS),
      attackStepPath: assetPath(raw.attackStepPath, 'attackStepPath', ATTACK_STEP_EXTS),
      fps: fpsValue(raw.fps),
      bake: bakeFlag(raw.bake),
    };
    if (raw.characterPath !== undefined && raw.characterPath !== null) {
      args.characterPath = assetPath(raw.characterPath, 'characterPath', CHARACTER_EXTS);
    }
    return { ok: true, args };
  } catch (err) {
    if (err instanceof PayloadError) return { ok: false, error: err.message };
    throw err;
  }
}

// ---- 2 + 5. the Pipeline calls ------------------------------------------------------

const withCharacter = (params, characterPath) => (characterPath ? { ...params, character: characterPath } : params);

/**
 * The `animation inspect` call for a checked payload.
 * @param {{clipPath:string, attackStepPath:string, characterPath?:string}} args from checkFrameSyncPayload
 * @returns {[string, object]}
 */
function inspectCall({ clipPath, attackStepPath, characterPath }) {
  return [`${ANIMATION_GROUP} inspect`, withCharacter({ clip: clipPath, attackStep: attackStepPath }, characterPath)];
}

/**
 * The `animation bake_events` call: events at time = frame / fps, root motion off.
 * Events travel as a JSON string, like the PlaytestDriver's input steps.
 * @param {{clipPath:string, characterPath?:string}} args from checkFrameSyncPayload
 * @param {Array<{functionName:string, frame:number, time:number}>} events from eventTimeline()
 * @returns {[string, object]}
 */
function bakeCall({ clipPath, characterPath }, events) {
  if (!Array.isArray(events) || !events.length) throw new Error('bake needs at least one event');
  return [`${ANIMATION_GROUP} bake_events`, withCharacter({ clip: clipPath, events: JSON.stringify(events), applyRootMotion: false }, characterPath)];
}

/** Unity Pipeline animation calls: name -> [command, parameters]. */
const UNITY_PIPELINE_ANIMATION = Object.freeze({
  inspect: inspectCall,
  bake: bakeCall,
});

// ---- 3. the editor's answer ---------------------------------------------------------

function answerFrame(raw, field) {
  if (!isFrame(raw)) throw new Error(`Unity 'animation inspect' answered a bad ${field} (a whole number from 0 to ${MAX_FRAMES} expected)`);
  return raw;
}

/**
 * The `animation inspect` answer as validateAttackFrames() input (without fps).
 * The clip's frame count is its length times its frame rate, rounded.
 * @param {unknown} result
 * @returns {{clipFrames:number, clipFps:number, startup:number, active:number, recovery:number, rootMotion:boolean, parryStart?:number, parryEnd?:number}}
 */
function readInspectResult(result) {
  const clip = isObj(result) && result.clip;
  const step = isObj(result) && result.attackStep;
  if (!isObj(clip) || !isObj(step)) throw new Error("Unity 'animation inspect' answered without clip and attackStep objects");
  const { length, frameRate } = clip;
  if (typeof length !== 'number' || !Number.isFinite(length) || length < 0 || length > MAX_CLIP_SECONDS) {
    throw new Error(`Unity 'animation inspect' answered a bad clip length (0 to ${MAX_CLIP_SECONDS} s expected)`);
  }
  if (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > MAX_CLIP_FPS) {
    throw new Error(`Unity 'animation inspect' answered a bad clip frameRate (above 0, at most ${MAX_CLIP_FPS} expected)`);
  }
  if (typeof result.rootMotion !== 'boolean') throw new Error("Unity 'animation inspect' answered without a rootMotion boolean");
  const clipFrames = Math.round(length * frameRate);
  if (clipFrames > MAX_FRAMES) throw new Error(`Unity 'animation inspect' answered a clip of ${clipFrames} frames (at most ${MAX_FRAMES}): not an attack clip`);
  const report = {
    clipFrames,
    clipFps: frameRate,
    startup: answerFrame(step.startup, 'startup'),
    active: answerFrame(step.active, 'active'),
    recovery: answerFrame(step.recovery, 'recovery'),
    rootMotion: result.rootMotion,
  };
  const hasParry = step.parryStart !== undefined && step.parryStart !== null;
  if (hasParry || (step.parryEnd !== undefined && step.parryEnd !== null)) {
    report.parryStart = answerFrame(step.parryStart, 'parryStart');
    report.parryEnd = answerFrame(step.parryEnd, 'parryEnd');
  }
  return report;
}

// ---- 4. the pure validator ----------------------------------------------------------

function inputFrame(raw, field, min = 0) {
  if (!Number.isInteger(raw) || raw < min || raw > MAX_FRAMES) throw new TypeError(`${field} must be a whole number from ${min} to ${MAX_FRAMES}`);
  return raw;
}

function parryWindow({ parryStart, parryEnd }) {
  const absent = (v) => v === undefined || v === null;
  if (absent(parryStart) && absent(parryEnd)) return null;
  return { start: inputFrame(parryStart, 'parryStart'), end: inputFrame(parryEnd, 'parryEnd') };
}

/**
 * Checks an AttackStep's frame data against its clip. Pure.
 * Frame indices are 0-based frame boundaries: with startup 5, frames 0..4 are
 * startup and the hit window opens at frame 5; it closes at startup + active;
 * recovery ends at startup + active + recovery = the clip's end, so a clip of
 * N frames has length N / fps and its recoveryEnd event sits at its length.
 * @param {{clipFrames:number, clipFps:number, startup:number, active:number, recovery:number, rootMotion:boolean, fps?:number, parryStart?:number, parryEnd?:number}} input
 *   fps is the expected frame rate (default 60).
 * @returns {{ok:boolean, fps:number, mismatches:Array<{code:string, message:string, expected:unknown, actual:unknown}>, events:{hitOpen:number, hitClose:number, recoveryEnd:number, parryOpen?:number, parryClose?:number}}}
 */
function validateAttackFrames(input) {
  if (!isObj(input)) throw new TypeError('validateAttackFrames needs an object');
  const clipFrames = inputFrame(input.clipFrames, 'clipFrames');
  const startup = inputFrame(input.startup, 'startup');
  const active = inputFrame(input.active, 'active', 1);
  const recovery = inputFrame(input.recovery, 'recovery');
  const fps = input.fps === undefined || input.fps === null ? DEFAULT_ATTACK_FPS : input.fps;
  if (!Number.isInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) throw new TypeError(`fps must be a whole number from ${MIN_FPS} to ${MAX_FPS}`);
  const { clipFps, rootMotion } = input;
  if (typeof clipFps !== 'number' || !Number.isFinite(clipFps) || clipFps <= 0) throw new TypeError('clipFps must be a positive number');
  if (typeof rootMotion !== 'boolean') throw new TypeError('rootMotion must be a boolean');
  const parry = parryWindow(input);

  const total = startup + active + recovery;
  const events = { hitOpen: startup, hitClose: startup + active, recoveryEnd: total };
  if (parry) Object.assign(events, { parryOpen: parry.start, parryClose: parry.end });

  const mismatches = [];
  if (clipFrames < total) {
    mismatches.push({ code: MISMATCH.tooShort, message: `clip has ${clipFrames} frames, AttackStep needs ${total} (${total - clipFrames} short)`, expected: total, actual: clipFrames });
  } else if (clipFrames > total) {
    mismatches.push({ code: MISMATCH.tooLong, message: `clip has ${clipFrames} frames, AttackStep needs ${total} (${clipFrames - total} too many)`, expected: total, actual: clipFrames });
  }
  if (Math.abs(clipFps - fps) > FPS_TOLERANCE) {
    mismatches.push({ code: MISMATCH.fps, message: `clip runs at ${clipFps} fps, frame data is at ${fps} fps`, expected: fps, actual: clipFps });
  }
  if (rootMotion) {
    mismatches.push({ code: MISMATCH.rootMotion, message: 'Animator root motion is on; attacks need it off', expected: false, actual: true });
  }
  if (parry && parry.end <= parry.start) {
    mismatches.push({ code: MISMATCH.parryOrder, message: `parry window closes on frame ${parry.end}, not after it opens on frame ${parry.start}`, expected: `> ${parry.start}`, actual: parry.end });
  } else if (parry && parry.end > total) {
    mismatches.push({ code: MISMATCH.parry, message: `parry window ends on frame ${parry.end}, after the attack ends on frame ${total}`, expected: total, actual: parry.end });
  }
  return { ok: mismatches.length === 0, fps, mismatches, events };
}

/**
 * The events to bake, in frame order: {functionName, frame, time = frame / fps}.
 * @param {{hitOpen:number, hitClose:number, recoveryEnd:number, parryOpen?:number, parryClose?:number}} events
 * @param {number} fps
 */
function eventTimeline(events, fps) {
  if (!isObj(events)) throw new TypeError('eventTimeline needs the events object');
  if (!Number.isInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) throw new TypeError(`fps must be a whole number from ${MIN_FPS} to ${MAX_FPS}`);
  return Object.keys(EVENT_FUNCTIONS)
    .filter((key) => events[key] !== undefined)
    .map((key) => ({ functionName: EVENT_FUNCTIONS[key], frame: inputFrame(events[key], key), time: events[key] / fps }))
    .sort((a, b) => a.frame - b.frame);
}

// ---- the whole command --------------------------------------------------------------

/**
 * animation_frame_sync: validate the payload, inspect, check the frame data,
 * and bake only when asked and nothing but root motion is wrong (the bake
 * turns root motion off itself). Editor failures throw.
 * After a bake, ok is true and `fixed` lists the mismatch codes it repaired;
 * `mismatches` still reports what the inspection found.
 * @param {unknown} rawPayload the worker's payload
 * @param {(call:[string, object]) => Promise<unknown>} invoke one Pipeline call (unity.js pipelineCall bound to a client)
 * @returns {Promise<{ok:boolean, error?:string, fps?:number, mismatches:object[], events:object[], baked:boolean, fixed?:string[], bakeResult?:unknown}>}
 */
async function runAnimationFrameSync(rawPayload, invoke) {
  if (typeof invoke !== 'function') throw new TypeError('runAnimationFrameSync needs an invoke function');
  const checked = checkFrameSyncPayload(rawPayload);
  if (!checked.ok) return { ok: false, error: checked.error, mismatches: [], events: [], baked: false };
  const { args } = checked;
  const report = readInspectResult(await invoke(inspectCall(args)));
  const verdict = validateAttackFrames({ ...report, fps: args.fps });
  const events = eventTimeline(verdict.events, verdict.fps);
  const base = { ok: verdict.ok, fps: verdict.fps, mismatches: verdict.mismatches, events, baked: false };
  const blocking = verdict.mismatches.filter((m) => !BAKE_FIXES.has(m.code));
  if (!args.bake || blocking.length) return base;
  const bakeResult = await invoke(bakeCall(args, events));
  return { ...base, ok: true, baked: true, fixed: verdict.mismatches.map((m) => m.code), bakeResult };
}

/** Tool definition for a worker's tool list (NOT the Playtester's: baking writes assets). */
const ANIMATION_FRAME_SYNC_TOOL = Object.freeze({
  name: 'animation_frame_sync',
  description: `Check an attack AnimationClip against its AttackStep frame data (startup + active + recovery frames, ${DEFAULT_ATTACK_FPS} fps by default, Animator root motion off). With bake true and every check passing, bakes AnimationEvents (${Object.values(EVENT_FUNCTIONS).join(', ')}) at the exact frames and turns root motion off.`,
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
      clipPath: { type: 'string', description: 'Assets/... .anim or .fbx' },
      attackStepPath: { type: 'string', description: 'Assets/... .asset (the AttackStep ScriptableObject)' },
      fps: { type: 'integer', minimum: MIN_FPS, maximum: MAX_FPS, description: `Frame rate of the frame data (default ${DEFAULT_ATTACK_FPS}).` },
      bake: { type: 'boolean', description: 'Bake the events and turn root motion off when every check passes.' },
      characterPath: { type: 'string', description: 'Optional Assets/... .prefab whose Animator gets root motion off.' },
    },
    required: ['clipPath', 'attackStepPath'],
  }),
});

module.exports = {
  ANIMATION_GROUP,
  ANIMATION_FRAME_SYNC_TOOL,
  UNITY_PIPELINE_ANIMATION,
  EVENT_FUNCTIONS,
  MISMATCH,
  DEFAULT_ATTACK_FPS,
  MIN_FPS,
  MAX_FPS,
  checkFrameSyncPayload,
  readInspectResult,
  validateAttackFrames,
  eventTimeline,
  runAnimationFrameSync,
};
