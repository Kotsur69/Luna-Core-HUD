// ============================================================================
// LunaCore - highlight extractor panel: state/orchestration
// ----------------------------------------------------------------------------
// Renderer-side half of the batch clip-trimmer. src/highlights.js (main
// process) owns the actual work (ffmpeg detection, folder listing, the
// sequential HighlightBatchJob) - this module only decides WHEN things
// happen: opening the overlay, checking ffmpeg status, wiring the folder
// pickers, validating before a run, and which per-file status is on screen
// as highlights:progress events arrive. Everything that BUILDS a node lives
// in highlightsview.js; everything with no DOM lives in highlightscommand.js -
// same three-way split modules/ask.js/askview.js/askcommand.js established,
// for the same reasons (see those files' headers).
//
// Reachable two ways: the #highlights-open chip (mountHighlightsChip, wired
// from modules/terminal.js like every other chip), or - once Phase 5 wires
// it - an /ask suggestion card's "Run it" button via openHighlightExtractor(
// prefill). That is why openHighlightExtractor() takes a real prefill object
// instead of being called bare: Phase 5 is a one-line change on the CALLER's
// side (modules/ask.js's onRunSuggestion), not a signature change here.
//
// PROGRESS LISTENER, REGISTERED ONCE
// -----------------------------------
// window.lunacore.onHighlightProgress() (preload.js) wraps a bare
// ipcRenderer.on() with no matching "off" - calling it again on every run
// would stack a new listener on top of the last one, and every one of them
// would fire for every future event. So it is called exactly ONCE, at module
// load, with a single handler that filters on `payload.jobId ===
// currentJobId` - events for a job this panel is not currently tracking
// (a stale run from before a close/reopen, or - in principle - another
// panel's job) are dropped rather than misapplied.
// ============================================================================

'use strict';

import { onLangChange } from './bus.js';
import { term } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
import { panelSkeleton, folderPickerRow, secondsField, fileStatusRow, ffmpegMissingBanner } from './highlightsview.js';
import { DEFAULT_SECONDS, isValidSeconds, parseSecondsInput, validateRunInputs, statusForEvent } from './highlightscommand.js';
import { t } from './util.js';

// The FFmpeg catalog entry's id, exactly as src/libraries.js's slugify()
// derives it from the "FFmpeg" name Phase 3 added to config/libraries.json's
// Videos category: lowercased, non-alphanumeric runs collapsed to '-', no
// other entry in that file slugifies to the same string, so there is no
// collision suffix to account for (see slugify()'s own header for when one
// would apply).
const FFMPEG_CATALOG_ID = 'ffmpeg';

/** Reasons runHighlightBatch()/validateRunInputs() can hand back, mapped to
 *  their i18n key. Anything unrecognized falls back to the generic row. */
const ERROR_KEYS = {
  'bad-folder': 'highlights.error.badFolder',
  'empty-folder': 'highlights.error.noFiles',
  'bad-seconds': 'highlights.error.badSeconds',
  generic: 'highlights.error.generic',
};

// ---- DOM --------------------------------------------------------------------

const overlayEl = document.getElementById('highlights');
const bodyEl = document.getElementById('highlights-body');

let isOpen = false;
/** Bumped on every openHighlightExtractor(), so a getFfmpegStatus() reply
 *  that lands after the user has already closed/reopened knows its gesture
 *  has been superseded - same guard libraries.js's open()/ask.js's openAsk()
 *  use around their own async calls. */
let openSeq = 0;

let sourceFolder = null;
let outputFolder = null;
let seconds = DEFAULT_SECONDS;
let ffmpegOk = null;
/** The batch currently in flight, or null between runs. Also the filter the
 *  module-scope progress listener uses (see this file's header). */
let currentJobId = null;
/** name -> status, insertion order preserved (a Map) so the file list
 *  redraws in the order runHighlightBatch() returned it. */
let fileStatuses = new Map();
/** The current panelSkeleton() refs, or null while nothing is rendered
 *  (before the first ffmpeg-status reply, or after close()). */
let panelRefs = null;

function clearBody() {
  bodyEl.textContent = '';
  panelRefs = null;
}

// ---- File list ----------------------------------------------------------------

/** Rebuilds just the <ul> from `fileStatuses` - cheap enough to call on every
 *  progress event without touching the folder rows/seconds field/buttons a
 *  full render() would also rebuild. */
function renderFileList() {
  if (!panelRefs) return;
  panelRefs.filesEl.textContent = '';
  for (const [name, status] of fileStatuses) {
    panelRefs.filesEl.appendChild(fileStatusRow({ name, status }));
  }
}

function setFileStatus(name, status) {
  if (!fileStatuses.has(name)) return;
  fileStatuses.set(name, status);
  renderFileList();
}

// ---- Errors ---------------------------------------------------------------------

/** Shows a typed error in the banner slot - reused for run failures since it
 *  never coincides with the ffmpeg-missing banner (Run stays disabled while
 *  ffmpeg is missing, so a run can only fail once ffmpeg is already there). */
function showRunError(reason) {
  if (!panelRefs) return;
  panelRefs.bannerHost.textContent = '';
  const p = document.createElement('p');
  p.className = 'highlights__error';
  p.textContent = t(ERROR_KEYS[reason] || ERROR_KEYS.generic);
  panelRefs.bannerHost.appendChild(p);
}

// ---- Render -----------------------------------------------------------------

/** Rebuilds the whole panel from current state. Called on: the ffmpeg-status
 *  reply, a folder pick, a run starting/settling, and a language switch -
 *  NOT on every keystroke in the seconds field (that would steal focus) or
 *  every progress event (renderFileList() alone handles those). */
function render() {
  clearBody();
  const panel = panelSkeleton();
  panelRefs = panel;

  if (!ffmpegOk) {
    panel.bannerHost.appendChild(
      ffmpegMissingBanner({ onOpenCatalog: () => window.lunacore.openLibrary(FFMPEG_CATALOG_ID) })
    );
  }

  panel.form.appendChild(
    folderPickerRow('source', {
      label: t('highlights.source.label'),
      path: sourceFolder,
      onPick: () => pickFolder('source'),
    })
  );
  panel.form.appendChild(
    folderPickerRow('output', {
      label: t('highlights.output.label'),
      path: outputFolder,
      onPick: () => pickFolder('output'),
    })
  );
  panel.form.appendChild(
    secondsField({
      value: seconds,
      onChange: (raw) => {
        seconds = parseSecondsInput(raw);
      },
    })
  );

  const validation = validateRunInputs({ sourceFolder, outputFolder, seconds });
  panel.runBtn.disabled = !ffmpegOk || !validation.ok || !!currentJobId;
  panel.runBtn.addEventListener('click', runBatch);
  panel.cancelBtn.disabled = !currentJobId;
  panel.cancelBtn.addEventListener('click', cancelBatch);

  bodyEl.appendChild(panel.el);
  renderFileList();
}

// ---- Folder pickers -----------------------------------------------------------

async function pickFolder(role) {
  let picked;
  try {
    picked = await window.lunacore.pickHighlightsFolder(role);
  } catch {
    picked = null;
  }
  if (!isOpen || !picked) return; // closed meanwhile, or the dialog was cancelled
  if (role === 'output') outputFolder = picked;
  else sourceFolder = picked;
  render();
}

// ---- Run / cancel ---------------------------------------------------------------

function runBatch() {
  if (currentJobId) return; // already running - the button is disabled, but guard anyway
  const validation = validateRunInputs({ sourceFolder, outputFolder, seconds });
  if (!validation.ok) return; // Run stays disabled in this case; nothing to do

  window.lunacore
    .runHighlightBatch({ sourceFolder, outputFolder, seconds })
    .then((result) => {
      if (!isOpen) return;
      if (!result || !result.ok) {
        showRunError((result && result.reason) || 'generic');
        return;
      }
      currentJobId = result.jobId;
      fileStatuses = new Map((result.files || []).map((f) => [f.name, 'queued']));
      render();
    })
    .catch(() => {
      if (isOpen) showRunError('generic');
    });
}

function cancelBatch() {
  if (!currentJobId) return;
  window.lunacore.cancelHighlightBatch(currentJobId);
}

/** A batch just settled (finished or was cancelled) - re-enables Run,
 *  disables Cancel, and stops filtering this job's (now-final) events in. */
function onBatchSettled() {
  currentJobId = null;
  if (!panelRefs) return;
  const validation = validateRunInputs({ sourceFolder, outputFolder, seconds });
  panelRefs.runBtn.disabled = !ffmpegOk || !validation.ok;
  panelRefs.cancelBtn.disabled = true;
}

// ---- Progress listener (registered once - see this file's header) --------------

function handleProgress(payload) {
  if (!payload || payload.jobId !== currentJobId) return;
  const status = statusForEvent(payload.event);
  if (status && payload.file) setFileStatus(payload.file, status);
  if (payload.event === 'batch-done' || payload.event === 'batch-cancelled') onBatchSettled();
}

window.lunacore.onHighlightProgress(handleProgress);

// ---- Open / close -----------------------------------------------------------

/**
 * Opens the panel, optionally pre-filled. Resets to a clean state first
 * (reopening onto a previous run's leftover folders/seconds is not a state
 * anyone asked to persist - same reasoning libraries.js's open() gives for
 * always landing back on the grid) and applies `prefill` on top.
 *
 * A batch still running in main when the panel is closed keeps running -
 * closing only stops this panel from tracking it (see handleProgress()'s
 * jobId filter); it is not cancelled. Reopening always starts a fresh,
 * untracked view rather than trying to resume watching it.
 *
 * @param {{sourceFolder?:string, outputFolder?:string, seconds?:number}} [prefill]
 *   Phase 5 (not this phase's scope) will call this from an /ask suggestion
 *   card with real folder/seconds values; a bare call (the chip) passes none.
 */
export async function openHighlightExtractor(prefill) {
  // Esc-then-reopen inside the exit window is a real gesture here too, same
  // reasoning as libraries.js's open()/ask.js's openAsk().
  cancelExit(overlayEl);
  isOpen = true;
  const seq = ++openSeq;
  overlayEl.hidden = false;
  overlayEl.focus();

  sourceFolder = null;
  outputFolder = null;
  seconds = DEFAULT_SECONDS;
  currentJobId = null;
  fileStatuses = new Map();
  clearBody();

  if (prefill) {
    if (typeof prefill.sourceFolder === 'string' && prefill.sourceFolder) sourceFolder = prefill.sourceFolder;
    if (typeof prefill.outputFolder === 'string' && prefill.outputFolder) outputFolder = prefill.outputFolder;
    if (isValidSeconds(prefill.seconds)) seconds = prefill.seconds;
  }

  let status;
  try {
    status = await window.lunacore.getFfmpegStatus();
  } catch {
    status = { ok: false, version: null };
  }

  // Closed (or closed-then-reopened) while the call was in flight: this
  // continuation is answering a gesture the user has already replaced.
  if (!isOpen || seq !== openSeq) return;

  ffmpegOk = !!(status && status.ok);
  render();

  // Best-effort keyboard entry point: the overlay itself already has focus
  // for Escape/backdrop to work, but a real control is a better landing spot.
  const firstControl = panelRefs && panelRefs.el.querySelector('button, input');
  if (firstControl) firstControl.focus();
}

export function closeHighlightExtractor() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(overlayEl);
}

// ---- Closing gestures -------------------------------------------------------

overlayEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeHighlightExtractor();
    term.focus();
  }
});

// Both the backdrop and the x carry data-highlights-close.
overlayEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-highlights-close')) {
    closeHighlightExtractor();
    term.focus();
  }
});

// Every string on screen came from t() at render time; redraw whatever is
// currently up rather than let it go stale on a language switch - same
// convention libraries.js/ask.js follow for their own overlays.
onLangChange(() => {
  if (isOpen && panelRefs) render();
});

// ---- Mount ------------------------------------------------------------------

/** Called once by the `terminal` widget's mount() - see modules/terminal.js.
 *  Same shape as mountLibrariesChip (modules/libraries.js). */
export function mountHighlightsChip(root) {
  const btn = root.querySelector('#highlights-open');
  if (btn) btn.addEventListener('click', () => openHighlightExtractor());
}
