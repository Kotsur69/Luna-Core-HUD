// ============================================================================
// LunaCore - /ask panel: state/orchestration (typed into the Ctrl+B filter box)
// ----------------------------------------------------------------------------
// Renderer-side half of the /ask feature. src/ask.js (main process) is the
// other half - it already owns the security boundary (see that file's
// header): a hallucinated catalog id or a bad-scheme suggestion url never
// even reaches this module, because parseAskResponse() drops it before the
// IPC reply is sent. Nothing here re-validates that; it only decides WHEN
// things happen - opening the overlay, showing a loading state, calling the
// bridge, and which of the four render states (loading / success / error /
// empty-question) ends up on screen. Everything that BUILDS a node lives in
// askview.js - same split modules/libraries.js and modules/librariesview.js
// already established, and for the same reason (see that pair's headers).
//
// Kept entirely separate from modules/libraries.js rather than folding into
// it: that file is already at the repo's 500-line ceiling (CLAUDE.md). This
// module only reuses the libraries filter INPUT as a place to type the
// command (wired from the other side, in libraries.js's Enter-key handler);
// it owns no state in common with that file.
// ============================================================================

'use strict';

import { onLangChange } from './bus.js';
import { t } from './util.js';
import { term } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
import {
  askPanelSkeleton,
  loadingRow,
  recommendedCard,
  suggestionCard,
  errorRow,
} from './askview.js';
// Pure command parsing lives in its own file - see askcommand.js's header for
// why (module-scope document.getElementById() below makes THIS file
// impossible to require() without a DOM, the same reason gitquick.js's pure
// helpers live in gitquick-format.js instead of gitquick.js). Re-exported so
// callers of ask.js (modules/libraries.js) don't need to know that.
import { ASK_PREFIX, isAskCommand, parseAskQuery } from './askcommand.js';
// Phase 5 bridge: a suggestion card's "Run it" button opens the highlight
// extractor panel. openHighlightExtractor() takes a real prefill object for
// exactly this reason (see modules/highlights.js's header) - this import is
// the one-line change the plan's build order anticipated.
import { openHighlightExtractor } from './highlights.js';

export { ASK_PREFIX, isAskCommand, parseAskQuery };

// ---- DOM ----------------------------------------------------------------------

const overlayEl = document.getElementById('ask');
const questionEl = document.getElementById('ask-question');
const bodyEl = document.getElementById('ask-body');

let isOpen = false;
/** Bumped on every openAsk(), so an askLibraries() reply that lands after the
 *  user has already closed/reopened knows its gesture has been superseded -
 *  same guard libraries.js's open() uses around getLibraries(). */
let openSeq = 0;
/** The last thing rendered, so a language switch mid-view can redraw it
 *  instead of going stale - same convention libraries.js/gitquick.js follow
 *  for their own onLangChange hooks. */
let lastRender = null;

function clearBody() {
  bodyEl.textContent = '';
}

function renderLoading() {
  lastRender = { kind: 'loading' };
  clearBody();
  bodyEl.appendChild(loadingRow());
}

function renderError(reason) {
  lastRender = { kind: 'error', reason };
  clearBody();
  bodyEl.appendChild(errorRow(reason));
}

/** The id, never a url - main resolves the address from its own copy of the
 *  catalog (src/libraries.js), same rule every other catalog row follows. */
function openRecommended(id) {
  window.lunacore.openLibrary(id);
}

/**
 * "Add to my library": persists a suggestion card into
 * config/libraries.local.json via the libraries:add bridge
 * (src/libraries.js's addLibraryItem, through src/main.js's handler).
 *
 * `item.category` is either a real catalog title or the literal "new"
 * (src/ask.js's parseAskResponse) - "new" is never a usable category name by
 * itself, so `item.newCategoryTitle` (the model's own short, specific name,
 * or the "Suggested Tools" fallback) is used instead. This is the "good
 * category" half of the feature: a suggestion outside the existing catalog
 * lands in a real, named bucket rather than one generic pile.
 *
 * `buttonEl` is disabled for the round trip and swapped to the "Added to
 * your library" label on success, or re-enabled (so the user can retry) on
 * failure - the only place this module mutates a DOM node passed in from
 * askview.js rather than building one itself, because the alternative
 * (re-rendering the whole panel just to update one button) would also lose
 * the user's place if they had scrolled the suggestions list.
 * @param {{name:string,url:string,description:string,category:string,newCategoryTitle:?string}} item
 * @param {HTMLButtonElement} buttonEl
 */
async function onAddSuggestion(item, buttonEl) {
  const category = item.category === 'new' ? item.newCategoryTitle : item.category;
  if (buttonEl) buttonEl.disabled = true;

  let result;
  try {
    result = await window.lunacore.addLibraryItem({
      name: item.name,
      url: item.url,
      description: item.description,
      category,
    });
  } catch {
    result = { ok: false };
  }

  if (!buttonEl) return;
  if (result && result.ok) {
    buttonEl.textContent = t('ask.suggestions.added');
  } else {
    buttonEl.disabled = false;
  }
}

/**
 * Stub for this phase: the highlight extractor (modules/highlights.js,
 * openHighlightExtractor) is Phase 3/4 scope and does not exist yet. PHASE 5
 * SWAPS THIS ONE-LINE BODY for a real call to openHighlightExtractor(item) -
 * see the plan's build order, step 5 ("Bridge").
 *
 * A suggestion card only ever carries name/url/description/capability - no
 * folder path - so there is nothing here worth prefilling; the extractor
 * opens with its own defaults and the user picks folders there. Closing this
 * panel first avoids stacking two overlays on screen at once.
 * @param {{name:string,url:string,description:string,capability:string}} _item
 */
function onRunSuggestion(_item) {
  closeAsk();
  openHighlightExtractor();
}

function renderSuccess(result) {
  lastRender = { kind: 'success', result };
  clearBody();

  const panel = askPanelSkeleton();
  panel.summaryEl.textContent = result.summary;

  if (result.recommended.length > 0) {
    for (const item of result.recommended) {
      panel.recommendedList.appendChild(recommendedCard(item, { onOpen: openRecommended }));
    }
  } else {
    panel.recommendedSection.hidden = true;
  }

  if (result.suggestions.length > 0) {
    for (const item of result.suggestions) {
      panel.suggestionsList.appendChild(
        suggestionCard(item, { onAdd: onAddSuggestion, onRun: onRunSuggestion })
      );
    }
  } else {
    panel.suggestionsSection.hidden = true;
  }

  bodyEl.appendChild(panel.el);
}

// ---- Open / close ---------------------------------------------------------

/**
 * Opens the /ask overlay for one question: shows a loading row, calls the
 * askLibraries() bridge (src/ask.js's ask:query, wired in main.js/preload.js
 * during Phase 1), and renders whichever state comes back.
 *
 * A blank question never reaches the bridge - runAsk() in src/ask.js would
 * just reject it as 'empty-question' anyway - so this renders that same
 * error row directly and saves the round trip.
 * @param {string} question already stripped of the "/ask " prefix
 */
export async function openAsk(question) {
  // Esc-then-reopen inside the exit window is a real gesture here too, same
  // reasoning as libraries.js's open().
  cancelExit(overlayEl);
  isOpen = true;
  const seq = ++openSeq;
  overlayEl.hidden = false;
  questionEl.textContent = question;
  // No input field to focus inside this overlay (unlike #libraries/#palette);
  // without focusing the overlay itself the Escape/backdrop handlers below
  // never see a keydown, since xterm's textarea keeps focus - same tradeoff
  // gitquick.js's openGitQuick() documents for the same reason.
  overlayEl.focus();

  const trimmed = typeof question === 'string' ? question.trim() : '';
  if (!trimmed) {
    renderError('empty-question');
    return;
  }

  renderLoading();

  let result;
  try {
    result = await window.lunacore.askLibraries(trimmed);
  } catch {
    result = { ok: false, reason: 'generic' };
  }

  // Closed (or closed-then-reopened) while the call was in flight: this
  // continuation is answering a gesture the user has already replaced.
  if (!isOpen || seq !== openSeq) return;

  if (result && result.ok) renderSuccess(result);
  else renderError((result && result.reason) || 'generic');
}

export function closeAsk() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(overlayEl);
}

// ---- Closing gestures -------------------------------------------------------

overlayEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAsk();
    term.focus();
  }
});

// Both the backdrop and the x carry data-ask-close.
overlayEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-ask-close')) {
    closeAsk();
    term.focus();
  }
});

// Every string on screen came from t() at render time; redraw whatever state
// is currently up rather than let it go stale on a language switch - same
// convention libraries.js/gitquick.js follow for their own overlays.
onLangChange(() => {
  if (!isOpen || !lastRender) return;
  if (lastRender.kind === 'loading') renderLoading();
  else if (lastRender.kind === 'error') renderError(lastRender.reason);
  else if (lastRender.kind === 'success') renderSuccess(lastRender.result);
});
