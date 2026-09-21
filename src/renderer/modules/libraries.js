// ============================================================================
// LunaCore - recommended libraries & tools directory (Ctrl+B)
// ----------------------------------------------------------------------------
// A browsable, filterable catalog of links worth keeping within reach
// (config/libraries.json). Same overlay shape as the palette: fixed backdrop,
// centered modal, a filter field in the bar, Esc to leave.
//
// THREE VIEWS, ONE OVERLAY
// ------------------------
//   grid     - one square tile per category: icon, title, how many tools.
//              The landing view, and the thing the directory opens on.
//   detail   - the tools inside one category, as rows.
//   results  - whatever the filter matches, flat, across every category.
//
// The grid exists because the flat list did not scale. Fourteen categories and
// forty entries stacked in one scroller meant the only way to reach the video
// tools was to scroll past the UI kits, and the category headings - the one
// piece of structure the catalog has - did no work beyond labelling. Squares
// make the categories the thing you navigate, and push the paragraph of
// description down a level, where there is room for it.
//
// WHY THE FILTER OVERRIDES THE LEVEL
// ----------------------------------
// Typing anything switches to `results` from wherever you are, and clearing the
// field puts you back. A filter scoped to the category you happen to be
// standing in would mean the same keystroke does two different things depending
// on invisible state, and searching from the grid - the common case - would
// have nothing to scope to. One box, one behaviour, at any depth; the category
// each hit came from rides along on the row.
//
// THREE THINGS EACH ENTRY CAN DO
//   click / Enter  - open in the default browser (the modal STAYS open: a
//                    directory is for browsing, and closing it after every
//                    link would make opening three of them three round trips)
//   copy           - the URL to the clipboard
//   insert         - the URL pasted into the active session, unsent, so you
//                    can write around it before hitting return
//
// WHY THE ROWS ARE BUTTONS AND NOT LINKS
// --------------------------------------
// An <a href> would do nothing here - Electron has no browser to hand it to -
// and window.open/target="_blank" would open a Chromium window inside the app.
// The address also deliberately never travels renderer -> main: the row carries
// the catalog ID, main looks the URL up in its own copy (src/libraries.js) and
// opens that. Same rule main.js's claude:docs handler is built on.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { onLangChange } from './bus.js';
import { term } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
// Everything that BUILDS a node lives next door; this file only decides which
// of them should be on screen and what the keyboard moves. See librariesview.js.
import {
  setHandlers,
  categoryTile,
  detailHeader,
  itemList,
  emptyLine,
} from './librariesview.js';
// "/ask <question>" hands off to the /ask panel instead of opening a row -
// see modules/ask.js's own header for why it lives in a separate file.
import { isAskCommand, parseAskQuery, openAsk } from './ask.js';

const overlayEl = document.getElementById('libraries');
const inputEl = document.getElementById('libraries-input');
const listEl = document.getElementById('libraries-list');
const countEl = document.getElementById('libraries-count');
const noteEl = document.getElementById('libraries-note');

/** How long a "copied" / "pasted" acknowledgement stays in the footer. */
const NOTE_MS = 2000;

const VIEW_GRID = 'grid';
const VIEW_DETAIL = 'detail';

let catalog = null; // { categories, total }, fetched lazily on first open
let isOpen = false;
let noteTimer = null;
/** Bumped on every open(), so a catalog fetch that lands after the user has
 *  already closed and reopened knows its gesture has been superseded. */
let openSeq = 0;

let view = VIEW_GRID;
/** Index into catalog.categories while in `detail`; -1 otherwise. */
let activeIndex = -1;
/** Where the grid was scrolled to when we left it, restored on the way back -
 *  returning from a category to the top of the list loses your place, and the
 *  place is most of what the grid is for. */
let gridScrollTop = 0;
/** Side the next render animates in from; '' skips the animation entirely. */
let enterFrom = '';

/** The tiles currently on screen, in DOM order - the grid's arrow-key path. */
let tiles = [];
/** The row buttons currently on screen, in DOM order - the list arrow path. */
let rowButtons = [];

// ---- Data -------------------------------------------------------------------

/** The filter as typed, trimmed. Empty string means "no filter". */
function query() {
  return inputEl.value.trim();
}

/**
 * Does this entry match the query? Matched against everything visible on the
 * row plus its category, so "react", "scraping" and "github.com" all work.
 * @param {{name:string,url:string,description:string}} item
 * @param {string} categoryTitle already resolved to the current language
 * @param {string} needle lower-cased, non-empty
 */
function matches(item, categoryTitle, needle) {
  const haystack = `${item.name} ${item.description} ${item.url} ${categoryTitle}`;
  return haystack.toLowerCase().includes(needle);
}

/**
 * Every entry matching the filter, flattened, each paired with the category it
 * came from - in `results` the category is no longer implied by where you are
 * standing, so it has to travel with the row.
 * @returns {{hits: Array<{item: object, category: string}>}}
 */
function filterCatalog(rawQuery) {
  const needle = rawQuery.toLowerCase();
  const hits = [];
  for (const category of (catalog && catalog.categories) || []) {
    // loc() at RENDER time, not load time - the language switch is live.
    const title = loc(category.title);
    for (const item of category.items) {
      if (matches(item, title, needle)) hits.push({ item, category: title });
    }
  }
  return { hits };
}

// ---- Footer note ------------------------------------------------------------

/** Footer acknowledgement that clears itself. */
function note(message) {
  if (noteTimer) clearTimeout(noteTimer);
  noteEl.textContent = message;
  noteTimer = setTimeout(() => {
    noteEl.textContent = '';
    noteTimer = null;
  }, NOTE_MS);
}

/** Builds the rows for a set of entries and records them as the arrow path. */
function rowsFor(entries) {
  const { el, rows } = itemList(entries);
  rowButtons.push(...rows);
  return el;
}

// ---- The three views --------------------------------------------------------

/** Level 1: one square per category. */
function renderGrid(host) {
  const grid = document.createElement('div');
  grid.className = 'libraries__grid';

  catalog.categories.forEach((category, index) => {
    // loc() at RENDER time, not load time - the language switch is live.
    const tile = categoryTile(category, index, loc(category.title));
    tiles.push(tile);
    grid.appendChild(tile);
  });

  host.appendChild(grid);
  countEl.textContent = t('libraries.count.grid', {
    n: catalog.categories.length,
    total: catalog.total,
  });
}

/** Level 2: the tools inside one category. */
function renderDetail(host, category) {
  // No category tag on these rows: the header above already says it, and
  // repeating it forty pixels lower is noise.
  host.append(
    detailHeader(category, loc(category.title)),
    rowsFor(category.items.map((item) => ({ item, category: '' })))
  );

  countEl.textContent = t('libraries.count', { n: category.items.length, total: catalog.total });
}

/** The filter's own view: every match, flat, tagged with where it came from. */
function renderResults(host, rawQuery) {
  const { hits } = filterCatalog(rawQuery);
  countEl.textContent = t('libraries.count', { n: hits.length, total: catalog.total });
  host.appendChild(hits.length === 0 ? emptyLine(t('libraries.empty')) : rowsFor(hits));
}

// ---- Render -----------------------------------------------------------------

/**
 * Rebuilds the body for whatever the current state says should be on screen.
 *
 * A re-render destroys the node the user is standing on. Without the focus
 * bookkeeping below, a language switch mid-browse drops focus to <body>, and
 * because the overlay's key handler listens on overlayEl, Esc and the arrows go
 * dead until the next click.
 *
 * @param {{focus?: 'keep'|'input'|'first'}} [opts]
 */
function render(opts = {}) {
  const focus = opts.focus || 'keep';
  const heldTile = tiles.indexOf(document.activeElement);
  const heldRow = rowButtons.indexOf(document.activeElement);

  listEl.textContent = '';
  tiles = [];
  rowButtons = [];

  if (!catalog) {
    listEl.appendChild(emptyLine(t('libraries.unavailable')));
    countEl.textContent = '';
    inputEl.focus();
    return;
  }

  // Everything a view builds goes inside this wrapper, not straight into the
  // scroll container: animating the scroller itself would drag the scrollbar
  // along with the content.
  const host = document.createElement('div');
  host.className = 'libraries__view';
  if (enterFrom) host.classList.add(`is-from-${enterFrom}`);
  enterFrom = '';

  const q = query();
  if (q) {
    host.classList.add('is-results');
    renderResults(host, q);
  } else if (view === VIEW_DETAIL && catalog.categories[activeIndex]) {
    host.classList.add('is-detail');
    renderDetail(host, catalog.categories[activeIndex]);
  } else {
    // Any state that claims "detail" without a category behind it any more - a
    // shrunken libraries.local.json, say - falls back rather than blanking.
    view = VIEW_GRID;
    activeIndex = -1;
    host.classList.add('is-grid');
    renderGrid(host);
  }

  listEl.appendChild(host);

  if (focus === 'input') {
    inputEl.focus();
    return;
  }
  const seats = tiles.length > 0 ? tiles : rowButtons;
  if (focus === 'first') {
    if (seats.length > 0) seats[0].focus();
    else inputEl.focus();
    return;
  }
  // 'keep': stay in the same seat if there still is one. The list shrinks as
  // the filter narrows, so clamp rather than assume the index survived.
  const held = heldTile >= 0 ? heldTile : heldRow;
  if (held < 0) return;
  if (seats.length > 0) seats[Math.min(held, seats.length - 1)].focus();
  else inputEl.focus();
}

// ---- Level changes ----------------------------------------------------------

function openCategory(index) {
  if (!catalog || !catalog.categories[index]) return;
  gridScrollTop = listEl.scrollTop;
  view = VIEW_DETAIL;
  activeIndex = index;
  // Forward goes deeper, so the new level arrives from the right and leaving it
  // reverses that. The direction is the only cue saying which way you moved.
  enterFrom = 'right';
  render({ focus: 'first' });
  listEl.scrollTop = 0;
}

function backToGrid() {
  if (view !== VIEW_DETAIL) return;
  const cameFrom = activeIndex;
  view = VIEW_GRID;
  activeIndex = -1;
  enterFrom = 'left';
  render({ focus: 'keep' });
  listEl.scrollTop = gridScrollTop;
  // Land on the tile you just came out of rather than the first one: that is
  // the square you were looking at, and Enter should take you straight back in.
  if (tiles[cameFrom]) tiles[cameFrom].focus();
}

// ---- Row actions ------------------------------------------------------------

function copyLink(url) {
  navigator.clipboard.writeText(url).then(
    () => note(t('libraries.copied')),
    // Clipboard access can be refused; saying so beats a button that looks
    // like it worked.
    () => note(t('libraries.copyFailed'))
  );
}

/** Pastes the URL into the active session WITHOUT sending it, then gets out of
 *  the way - you almost always want to write a sentence around the link. */
function insertLink(url) {
  window.lunacore.pastePrompt(url, false);
  close();
  term.focus();
}

// The one wiring point between the builders next door and the behaviour here.
// Done at module scope rather than per render: the handlers never change, and
// re-registering them on every keystroke of the filter would be busywork.
setHandlers({
  // The id, never the URL - main resolves the address from its own copy of the
  // catalog, which is what stops this being an open redirect (src/libraries.js).
  openItem: (id) => window.lunacore.openLibrary(id),
  copy: copyLink,
  insert: insertLink,
  openCategory,
  back: backToGrid,
});

// ---- Open / close -----------------------------------------------------------

async function open() {
  if (isOpen) return;
  // Esc-then-Ctrl+B inside the exit window is a real gesture on a keyboard-
  // driven HUD; without this the pending timer would hide what was just opened.
  cancelExit(overlayEl);
  isOpen = true;
  const seq = ++openSeq;
  overlayEl.hidden = false;

  // Fetched on first open, then kept: the catalog is a static config file, and
  // a language switch re-renders from the same payload (titles resolve through
  // loc() at render time).
  if (!catalog) {
    try {
      catalog = await window.lunacore.getLibraries();
    } catch {
      catalog = null; // render() prints the "could not load" line
    }
  }

  // Close-then-reopen inside that round trip leaves this continuation holding a
  // gesture the user has already replaced. Finishing it would blank the filter
  // they have since typed and yank focus back out of the list.
  if (!isOpen || seq !== openSeq) return;

  // Always back to the top level: reopening onto whichever category you last
  // poked at is a state nobody asked to persist.
  view = VIEW_GRID;
  activeIndex = -1;
  gridScrollTop = 0;
  enterFrom = '';
  inputEl.value = '';
  noteEl.textContent = '';
  render({ focus: 'input' });
}

function close() {
  if (!isOpen) return;
  // The flag drops NOW, the element leaves over the next ~120ms - everything
  // asking "is it open" must get the answer the user just gave (v0.10 3.2).
  isOpen = false;
  if (noteTimer) {
    clearTimeout(noteTimer);
    noteTimer = null;
  }
  closeWithExit(overlayEl);
}

// ---- Keyboard ---------------------------------------------------------------

/** How many tiles sit on a row right now, straight from the computed grid. */
function gridColumns() {
  const grid = listEl.querySelector('.libraries__grid');
  if (!grid) return 1;
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

/** Moves focus along the rows; from the field, Down enters the list. */
function focusRow(step) {
  if (rowButtons.length === 0) return;
  const at = rowButtons.indexOf(document.activeElement);
  if (at === -1) {
    rowButtons[step > 0 ? 0 : rowButtons.length - 1].focus();
    return;
  }
  const next = at + step;
  // Past the top, go back to the field rather than wrapping to the bottom -
  // the filter is where an up-arrow streak is actually heading.
  if (next < 0) {
    inputEl.focus();
    return;
  }
  if (next >= rowButtons.length) return;
  rowButtons[next].focus();
}

/** Moves focus across the grid in two dimensions. */
function focusTile(dx, dy) {
  if (tiles.length === 0) return;
  const at = tiles.indexOf(document.activeElement);
  if (at === -1) {
    tiles[0].focus();
    return;
  }
  const cols = gridColumns();
  const next = at + dx + dy * cols;
  if (next < 0) {
    // Up out of the first row lands in the filter, matching the list's rule.
    if (dy < 0) inputEl.focus();
    return;
  }
  if (next >= tiles.length) return;
  // A sideways step must not wrap onto the next line: at the end of a row, stop.
  if (dx !== 0 && Math.floor(next / cols) !== Math.floor(at / cols)) return;
  tiles[next].focus();
}

/**
 * Esc unwinds one layer at a time: first the filter, then the category, then
 * the overlay. Three presses to leave a filtered category is the bargain every
 * find-in-page makes, and each press undoes exactly the last thing the user
 * did instead of throwing away all of it at once.
 */
function escape() {
  if (query()) {
    inputEl.value = '';
    render({ focus: 'input' });
    return;
  }
  if (view === VIEW_DETAIL) {
    backToGrid();
    return;
  }
  close();
  term.focus();
}

/** Arrow keys that move focus within the grid, as [dx, dy]. */
const TILE_STEPS = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

overlayEl.addEventListener('keydown', (e) => {
  const inField = e.target === inputEl;

  if (e.key === 'Escape') {
    e.preventDefault();
    escape();
    return;
  }

  // Backspace outside the field is "up one level"; inside it, it is editing.
  // ArrowLeft only means "back" where it is not already steering a grid.
  if (!inField && view === VIEW_DETAIL && !query()) {
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
      e.preventDefault();
      backToGrid();
      return;
    }
  }

  if (tiles.length > 0) {
    const step = TILE_STEPS[e.key];
    if (step) {
      e.preventDefault();
      focusTile(step[0], step[1]);
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusRow(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusRow(-1);
  }
});

inputEl.addEventListener('input', () => render({ focus: 'keep' }));

// Enter straight from the filter field opens the first match - the footer
// promises it, and the palette (Ctrl+K) sets the expectation that typing and
// hitting return is a complete gesture. Handled on the field rather than the
// overlay so Enter on an already-focused row keeps its native button
// behaviour, and so Enter on an action button copies/inserts instead.
inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (isAskCommand(inputEl.value)) {
    openAsk(parseAskQuery(inputEl.value));
    return;
  }
  // Rows first: with a filter up there are no tiles, and on the bare grid this
  // opens the first category, which is the only thing Enter could mean there.
  const first = rowButtons[0] || tiles[0];
  if (first) first.click();
});

// Both the backdrop and the × carry data-libraries-close.
overlayEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-libraries-close')) {
    close();
    term.focus();
  }
});

// Global Ctrl/Cmd+B (capture, to get ahead of xterm.js - same as the palette's
// Ctrl+K). Nothing else in the app claims B, in either the renderer or main.js's
// before-input-event handler.
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) {
        close();
        term.focus();
      } else {
        open();
      }
    }
  },
  true
);

// ---- Mount ------------------------------------------------------------------

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountLibrariesChip(root) {
  const btn = root.querySelector('#libraries-open');
  if (btn) btn.addEventListener('click', open);
}

// Category titles and every label in a row's actions come from the dictionary
// or from loc(); a language switch has to repaint what is already on screen.
onLangChange(() => {
  if (isOpen) render({ focus: 'keep' });
});
