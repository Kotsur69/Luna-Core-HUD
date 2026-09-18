// ============================================================================
// LunaCore - recommended libraries & tools directory (Ctrl+B)
// ----------------------------------------------------------------------------
// A browsable, filterable catalog of links worth keeping within reach
// (config/libraries.json). Same overlay shape as the palette: fixed backdrop,
// centered modal, a filter field in the bar, Esc to close.
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

const overlayEl = document.getElementById('libraries');
const inputEl = document.getElementById('libraries-input');
const listEl = document.getElementById('libraries-list');
const countEl = document.getElementById('libraries-count');
const noteEl = document.getElementById('libraries-note');

/** How long a "copied" / "pasted" acknowledgement stays in the footer. */
const NOTE_MS = 2000;

let catalog = null; // { categories, total }, fetched lazily on first open
let isOpen = false;
let noteTimer = null;
/** Bumped on every open(), so a catalog fetch that lands after the user has
 *  already closed and reopened knows its gesture has been superseded. */
let openSeq = 0;
/** The row buttons currently on screen, in DOM order - the arrow-key path. */
let rowButtons = [];

// ---- Data -------------------------------------------------------------------

/**
 * Does this entry match the query? Matched against everything visible on the
 * row plus its category, so "react", "scraping" and "github.com" all work.
 * @param {{name:string,url:string,description:string}} item
 * @param {string} categoryTitle already resolved to the current language
 * @param {string} query lower-cased, non-empty
 */
function matches(item, categoryTitle, query) {
  const haystack = `${item.name} ${item.description} ${item.url} ${categoryTitle}`;
  return haystack.toLowerCase().includes(query);
}

/**
 * Applies the filter, keeping only categories that still have entries.
 * @returns {{groups: Array<{title: string, items: Array}>, shown: number}}
 */
function filterCatalog(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  const groups = [];
  let shown = 0;

  for (const category of (catalog && catalog.categories) || []) {
    // loc() at RENDER time, not load time - the language switch is live.
    const title = loc(category.title);
    const items = query ? category.items.filter((i) => matches(i, title, query)) : category.items;
    if (items.length === 0) continue;
    groups.push({ title, items });
    shown += items.length;
  }

  return { groups, shown };
}

/** "github.com" out of "https://github.com/owner/repo". Falls back to the raw
 *  string if it somehow will not parse - main already validated it, so this is
 *  belt-and-braces rather than a real branch. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- Rendering --------------------------------------------------------------

/** Footer acknowledgement that clears itself. */
function note(message) {
  if (noteTimer) clearTimeout(noteTimer);
  noteEl.textContent = message;
  noteTimer = setTimeout(() => {
    noteEl.textContent = '';
    noteTimer = null;
  }, NOTE_MS);
}

/** A small icon button in a row's action cluster. */
function actionButton(className, glyph, titleKey, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `libraries-item__action ${className}`;
  btn.textContent = glyph;
  btn.title = t(titleKey);
  btn.setAttribute('aria-label', t(titleKey));
  btn.addEventListener('click', (e) => {
    // Without this the click also reaches the row button behind it and the
    // "copy" gesture would open the page as well.
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** The main, full-width part of a row: name, host and description. */
function rowButton(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'libraries-item__open';
  btn.title = t('libraries.open.title');

  const head = document.createElement('span');
  head.className = 'libraries-item__head';

  const name = document.createElement('span');
  name.className = 'libraries-item__name';
  name.textContent = item.name;

  const host = document.createElement('span');
  host.className = 'libraries-item__host';
  // The host alone, not the full URL: it is the part that tells you where a
  // click lands, and a long repo path would push the name off a narrow modal.
  host.textContent = hostOf(item.url);

  head.append(name, host);
  btn.appendChild(head);

  if (item.description) {
    const desc = document.createElement('span');
    desc.className = 'libraries-item__desc';
    desc.textContent = item.description;
    btn.appendChild(desc);
  }

  btn.addEventListener('click', () => {
    window.lunacore.openLibrary(item.id);
  });
  return btn;
}

function render() {
  // A re-render destroys the node the user is standing on. Without this, a
  // language switch mid-browse drops focus to <body>, and because the overlay's
  // key handler listens on overlayEl, Esc and the arrows go dead until the next
  // click. -1 (focus in the filter field, the common case) restores nothing.
  const focusedRow = rowButtons.indexOf(document.activeElement);

  listEl.textContent = '';
  rowButtons = [];

  if (!catalog) {
    const failed = document.createElement('p');
    failed.className = 'libraries__empty';
    failed.textContent = t('libraries.unavailable');
    listEl.appendChild(failed);
    countEl.textContent = '';
    if (focusedRow >= 0) inputEl.focus();
    return;
  }

  const { groups, shown } = filterCatalog(inputEl.value);
  countEl.textContent = t('libraries.count', { n: shown, total: catalog.total });

  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'libraries__empty';
    empty.textContent = t('libraries.empty');
    listEl.appendChild(empty);
    // No row left to stand on; the field keeps the overlay's key handler alive.
    if (focusedRow >= 0) inputEl.focus();
    return;
  }

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'libraries__group';

    const heading = document.createElement('h3');
    heading.className = 'libraries__grouptitle';
    heading.textContent = group.title;
    section.appendChild(heading);

    const ul = document.createElement('ul');
    ul.className = 'libraries__items';

    for (const item of group.items) {
      const li = document.createElement('li');
      li.className = 'libraries-item';

      const openBtn = rowButton(item);
      rowButtons.push(openBtn);

      const actions = document.createElement('div');
      actions.className = 'libraries-item__actions';
      actions.append(
        actionButton('is-copy', '⧉', 'libraries.copy', () => copyLink(item.url)),
        actionButton('is-insert', '↳', 'libraries.insert', () => insertLink(item.url))
      );

      li.append(openBtn, actions);
      ul.appendChild(li);
    }

    section.appendChild(ul);
    listEl.appendChild(section);
  }

  // The list shrinks as the filter narrows, so clamp rather than assume the
  // same index still exists.
  if (focusedRow >= 0 && rowButtons.length > 0) {
    rowButtons[Math.min(focusedRow, rowButtons.length - 1)].focus();
  }
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

  inputEl.value = '';
  noteEl.textContent = '';
  render();
  inputEl.focus();
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

overlayEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    term.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusRow(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusRow(-1);
  }
});

inputEl.addEventListener('input', render);

// Enter straight from the filter field opens the first match - the footer
// promises it, and the palette (Ctrl+K) sets the expectation that typing and
// hitting return is a complete gesture. Handled on the field rather than the
// overlay so Enter on an already-focused row keeps its native button
// behaviour, and so Enter on an action button copies/inserts instead.
inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (rowButtons.length > 0) rowButtons[0].click();
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
  if (isOpen) render();
});
