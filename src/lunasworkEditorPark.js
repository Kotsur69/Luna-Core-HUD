// ============================================================================
// LunaCore - Luna's Work: park the live Unity editor around checkout updates
// ----------------------------------------------------------------------------
// When git rewrites the .unity file the open editor has loaded, Unity raises
// a modal "Scene(s) have been modified externally - Reload?" dialog. It
// blocks the editor's main thread, so every Pipeline call hangs until a human
// clicks. Luna's Work therefore parks the editor on an empty, untitled scene
// around every git step that rewrites files in the project checkout:
//
//   withParkedEditor(ctx, gitStep)
//     1. park     `scene list_open` (which scenes are open, which are dirty),
//                 then an empty untitled scene in Single mode (a fixed
//                 `script eval` of EditorSceneManager.NewScene; the Pipeline
//                 has no unsaved new-scene command, `scene create` saves a
//                 file). Unsaved changes are DISCARDED, never saved: a dirty
//                 scene is logged ("unsaved editor changes were dropped") and
//                 recorded for the run report.
//     2. gitStep  the fast-forward / revert / commit itself
//     3. refresh  the Assets/Refresh menu item, as prepareEditor() runs it
//                 (src/lunasworkUnityEditor.js): the new files are imported
//                 while nothing on disk is open
//     4. reopen   the profile's scene (else the scene that was active) with
//                 `scene open`, retried through the refresh's domain reload
//
// Never blocks the git step: an editor that cannot be reached (no port file,
// port refused, no answer) is skipped, logged and recorded; any other park
// failure the same. A gitStep error propagates after a best-effort reopen. A
// failed reopen is a log line, never an error. Only the Unity adapter over
// the Pipeline transport parks (legacy MCP for Unity has no unsaved new
// scene); every other adapter is a pass-through.
// ============================================================================

'use strict';

const { UNITY_PIPELINE, pipelineCall } = require('../helpers/playtest-bridge/unity');
const { PIPELINE_ERROR } = require('../helpers/playtest-bridge/pipeline-http');
const { createWaits, refreshAssets, WAIT_TIMEOUT } = require('./lunasworkUnityEditor');

// Busy answers (a compile, an import) are retried this long before the park is skipped.
const PARK_WAIT_MS = 30 * 1000;
// Refresh + its domain reload + the scene open.
const UNPARK_WAIT_MS = 2 * 60 * 1000;
const MAX_OPEN_SCENES = 16;
const MAX_DETAIL_CHARS = 200;
const MAX_COUNT = 100000;

/** Why a park did not happen. */
const PARK_SKIP = Object.freeze({
  unreachable: 'unreachable',
  refused: 'refused',
  busy: 'busy',
  playing: 'playing',
  unsupported: 'unsupported',
  error: 'error',
});

// Transport failures: the editor is closed, reloading or not answering.
const UNREACHABLE_CODES = new Set([
  PIPELINE_ERROR.notOpen,
  PIPELINE_ERROR.badDescriptor,
  PIPELINE_ERROR.stale,
  PIPELINE_ERROR.unreachable,
  PIPELINE_ERROR.timeout,
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const clip = (v) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS); // eslint-disable-line no-control-regex
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? Math.min(v, MAX_COUNT) : 0);

/** A park that did not happen: nothing to reopen. */
const skipped = (reason, detail = '') => ({ parked: false, discarded: false, skipped: reason, detail: clip(detail), reopen: null });

/** The skip reason of a failed park call. */
function skipReason(err) {
  if (err && err.code === WAIT_TIMEOUT) return PARK_SKIP.busy;
  if (err && UNREACHABLE_CODES.has(err.code)) return PARK_SKIP.unreachable;
  if (err && typeof err.code === 'string' && err.code.startsWith('UNITY_PIPELINE_')) return PARK_SKIP.refused;
  return PARK_SKIP.error;
}

/** The open scenes of a `scene list_open` answer: {path, isActive, isDirty}. */
function openScenesOf(answer) {
  return (Array.isArray(answer) ? answer : [])
    .filter(isObj)
    .slice(0, MAX_OPEN_SCENES)
    .map((s) => ({ path: typeof s.path === 'string' ? s.path : '', isActive: s.isActive === true, isDirty: s.isDirty === true }));
}

/**
 * The Pipeline half: parks and unparks one editor, each over its own short
 * connection (one editor = one connection).
 * @param {{connect:()=>{exec:Function, close:Function}, scene?:string|null, now:()=>number,
 *   sleep:(ms:number)=>Promise<unknown>, log?:(line:string)=>void}} ctx scene: the profile's
 * @returns {{park:()=>Promise<object>, unpark:(state:object)=>Promise<{reopened:boolean, error?:string}>}}
 */
function createEditorPark(ctx) {
  const log = ctx.log || (() => {});
  const waits = createWaits({ now: ctx.now, sleep: ctx.sleep });
  const busyOnly = (err) => !!err && err.retryable === true;

  async function session(fn) {
    const client = ctx.connect();
    try {
      return await fn((call) => pipelineCall(client, call));
    } finally {
      try {
        await client.close();
      } catch (err) {
        log(`[lunaswork] Unity editor park: closing the connection failed: ${errText(err)}`);
      }
    }
  }

  /** One call, retried through busy answers only (an unreachable editor is skipped at once). */
  async function once(call, deadline, command, what) {
    let answer;
    const probe = async () => {
      answer = await call(command);
      return true;
    };
    await waits.pollUntil(deadline, probe, `Unity stayed busy and did not ${what}`, busyOnly);
    return answer;
  }

  async function park() {
    const deadline = ctx.now() + PARK_WAIT_MS;
    let scenes;
    try {
      scenes = await session((call) => once(call, deadline, UNITY_PIPELINE.openScenes(), 'list its open scenes'));
    } catch (err) {
      return skipped(skipReason(err), errText(err));
    }
    const open = openScenesOf(scenes).filter((s) => s.path);
    const active = open.find((s) => s.isActive) || open[0] || null;
    const reopen = ctx.scene || (active ? active.path : null);
    // Nothing on disk is open: no file git rewrites can raise the dialog.
    if (!open.length) return { parked: false, discarded: false, skipped: null, detail: 'no saved scene open', reopen: null };
    const dirty = openScenesOf(scenes).filter((s) => s.isDirty);
    try {
      await session((call) => once(call, deadline, UNITY_PIPELINE.newScene(), 'open an empty scene'));
    } catch (err) {
      // No answer: the empty scene may be open now, so the scene is reopened after the git step.
      if (err && err.code === PIPELINE_ERROR.timeout) {
        log(`[lunaswork] Unity editor park: no answer to the empty scene (${errText(err)}); reopening after the git step`);
        return { parked: true, discarded: false, skipped: null, detail: 'no answer', reopen };
      }
      return skipped(skipReason(err), errText(err));
    }
    if (dirty.length) {
      log(`[lunaswork] Unity editor parked: unsaved editor changes were dropped (${dirty.map((s) => s.path || 'untitled').join(', ').slice(0, MAX_DETAIL_CHARS)})`);
    } else {
      log('[lunaswork] Unity editor parked on an empty scene');
    }
    return { parked: true, discarded: dirty.length > 0, skipped: null, detail: '', reopen };
  }

  async function unpark(state) {
    if (!isObj(state) || !state.parked) return { reopened: false };
    const deadline = ctx.now() + UNPARK_WAIT_MS;
    try {
      await session(async (call) => {
        await refreshAssets({ call, waits, log }, deadline);
        if (!state.reopen) return;
        const sec = Math.round(UNPARK_WAIT_MS / 1000);
        await waits.act(deadline, () => call(UNITY_PIPELINE.openScene(state.reopen)), `Unity could not open ${state.reopen} within ${sec}s`);
      });
    } catch (err) {
      log(`[lunaswork] Unity editor not unparked: ${errText(err)}`);
      return { reopened: false, error: clip(errText(err)) };
    }
    if (state.reopen) log(`[lunaswork] Unity editor back on ${state.reopen}`);
    return { reopened: !!state.reopen };
  }

  return { park, unpark };
}

/**
 * Runs `gitStep` with the editor parked (see the header). `ctx.editor` is the
 * adapter's {park, unpark} (null / missing for a non-Unity profile: a
 * pass-through). `ctx.onPark` gets the park outcome for the run report.
 * @template T
 * @param {{editor?:{park:()=>Promise<object>, unpark:(state:object)=>Promise<unknown>}|null,
 *   log?:(line:string)=>void, onPark?:(outcome:{parked:boolean, discarded:boolean, skipped:string|null, detail:string})=>void}} ctx
 * @param {()=>Promise<T>} gitStep
 * @returns {Promise<T>}
 */
async function withParkedEditor(ctx, gitStep) {
  const editor = isObj(ctx) ? ctx.editor : null;
  if (!editor || typeof editor.park !== 'function' || typeof editor.unpark !== 'function') return gitStep();
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  let state;
  try {
    state = await editor.park();
  } catch (err) {
    state = skipped(PARK_SKIP.error, errText(err));
  }
  if (!isObj(state)) state = skipped(PARK_SKIP.error, 'no park state');
  if (state.skipped) log(`[lunaswork] Unity editor not parked (${state.skipped}${state.detail ? `: ${state.detail}` : ''}); running the git step anyway`);
  if (typeof ctx.onPark === 'function') {
    try {
      ctx.onPark({ parked: state.parked === true, discarded: state.discarded === true, skipped: state.skipped || null, detail: clip(state.detail) });
    } catch (err) {
      log(`[lunaswork] Unity editor park not recorded: ${errText(err)}`);
    }
  }
  try {
    return await gitStep();
  } finally {
    if (state.parked) {
      try {
        await editor.unpark(state);
      } catch (err) {
        log(`[lunaswork] Unity editor not unparked: ${errText(err)}`);
      }
    }
  }
}

/**
 * The {park, unpark} of the run's profile, or null when it does not park
 * (not a Unity profile, an adapter without park). The live adapter is used
 * when there is one, else a fresh one is made just for the park.
 * @param {{profile:object|null, adapter?:object|null, createAdapter:()=>object, log?:(line:string)=>void}} o
 */
function editorFor(o) {
  const profile = isObj(o) ? o.profile : null;
  if (!isObj(profile) || profile.adapter !== 'unity') return null;
  let adapter = o.adapter || null;
  if (!adapter) {
    try {
      adapter = o.createAdapter();
    } catch (err) {
      if (typeof o.log === 'function') o.log(`[lunaswork] Unity editor park: no adapter (${errText(err)})`);
      return null;
    }
  }
  if (!isObj(adapter) || typeof adapter.park !== 'function' || typeof adapter.unpark !== 'function') return null;
  return { park: () => adapter.park(profile), unpark: (state) => adapter.unpark(state) };
}

// ---- run tally + report ---------------------------------------------------------------

/** The run's park tally, cleaned: {discarded, unreachable, failed, last}. */
function cleanParkTally(raw) {
  const t = isObj(raw) ? raw : {};
  return {
    discarded: count(t.discarded),
    unreachable: count(t.unreachable),
    failed: count(t.failed),
    last: typeof t.last === 'string' && t.last ? clip(t.last) : null,
  };
}

/** A new tally with one park outcome added. */
function addParkOutcome(tally, outcome) {
  const t = cleanParkTally(tally);
  const o = isObj(outcome) ? outcome : {};
  const reason = typeof o.skipped === 'string' ? o.skipped : null;
  const unreachable = reason === PARK_SKIP.unreachable;
  const failed = !!reason && !unreachable;
  return {
    discarded: t.discarded + (o.discarded === true ? 1 : 0),
    unreachable: t.unreachable + (unreachable ? 1 : 0),
    failed: t.failed + (failed ? 1 : 0),
    last: failed ? clip(`${reason}${o.detail ? `: ${o.detail}` : ''}`) : t.last,
  };
}

/**
 * The run report's lines about the parked editor, each {en, pl} (pl without
 * diacritics); empty when nothing worth a line happened.
 * @returns {{en:string, pl:string}[]}
 */
function parkReportLines(raw) {
  const t = cleanParkTally(raw);
  const lines = [];
  if (t.discarded) {
    lines.push({
      en: `Unity editor: unsaved scene changes were discarded (never saved) before ${t.discarded} checkout update(s).`,
      pl: `Edytor Unity: niezapisane zmiany sceny zostaly odrzucone (nigdy zapisane) przed ${t.discarded} aktualizacja(mi) checkoutu.`,
    });
  }
  if (t.unreachable) {
    lines.push({
      en: `Unity editor: not reachable, so it was not parked before ${t.unreachable} checkout update(s); a "modified externally" dialog may wait for a click.`,
      pl: `Edytor Unity: nieosiagalny, wiec nie zostal zaparkowany przed ${t.unreachable} aktualizacja(mi) checkoutu; okno "modified externally" moze czekac na klikniecie.`,
    });
  }
  if (t.failed) {
    const last = t.last ? ` (${t.last})` : '';
    lines.push({
      en: `Unity editor: could not be parked before ${t.failed} checkout update(s)${last}.`,
      pl: `Edytor Unity: nie dal sie zaparkowac przed ${t.failed} aktualizacja(mi) checkoutu${last}.`,
    });
  }
  return lines;
}

module.exports = {
  PARK_WAIT_MS,
  UNPARK_WAIT_MS,
  PARK_SKIP,
  createEditorPark,
  withParkedEditor,
  editorFor,
  cleanParkTally,
  addParkOutcome,
  parkReportLines,
};
