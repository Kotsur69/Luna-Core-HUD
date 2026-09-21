// ============================================================================
// LunaCore - the nodes the libraries directory is built from (Ctrl+B)
// ----------------------------------------------------------------------------
// Everything in here answers "what does it look like". Everything in
// modules/libraries.js answers "what does it do" - which level you are on, what
// the arrows move, when the overlay opens and closes.
//
// The split is not cosmetic: with both jobs in one file the module ran past 650
// lines, and the parent CLAUDE.md puts the ceiling at 500. Drawing a tile and
// deciding which tile has focus are also genuinely different concerns, and the
// builders below are the half with no state at all.
//
// HOW THE CALLBACKS GET HERE
// --------------------------
// A row has to be able to open, copy and insert, and a tile has to be able to
// descend - but none of that lives here. Rather than thread four callbacks
// through every signature, modules/libraries.js calls setHandlers() once at
// boot and the builders close over the result. One wiring point, and the
// builders keep the argument lists they would have had anyway.
// ============================================================================

'use strict';

import { t } from './util.js';
import { iconSvg } from './libicons.js';

/**
 * What the built nodes call. Replaced once, at boot, by modules/libraries.js.
 * The no-op defaults are not defensive padding - they mean a node built before
 * wiring is inert rather than throwing on the first click.
 */
let handlers = {
  openItem() {},
  copy() {},
  insert() {},
  openCategory() {},
  back() {},
};

/** @param {Partial<typeof handlers>} next */
export function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

/** "github.com" out of "https://github.com/owner/repo". Falls back to the raw
 *  string if it somehow will not parse - main already validated it, so this is
 *  belt-and-braces rather than a real branch. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A one-line message in place of a list: nothing matched, nothing loaded. */
export function emptyLine(message) {
  const p = document.createElement('p');
  p.className = 'libraries__empty';
  p.textContent = message;
  return p;
}

// ---- Level 1: a category tile ----------------------------------------------

/**
 * One square in the grid: icon, title, how many tools are inside.
 *
 * @param {{icon: string, items: Array}} category
 * @param {number} index position in the grid, which drives the stagger
 * @param {string} title already resolved to the current language
 * @returns {HTMLButtonElement}
 */
export function categoryTile(category, index, title) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'libraries-tile';
  // The visible count is a bare number - a tile has no room for a noun, and
  // Polish would need three of them to be correct at 1, 2 and 5. The spoken
  // label carries the full phrase, where there is no width to run out of.
  tile.setAttribute('aria-label', t('libraries.tile.aria', { title, n: category.items.length }));
  // Staggered entrance, one tile behind the next. --stagger drops to 0 under
  // reduced motion, which collapses this to "all at once" for free.
  tile.style.setProperty('--tile-index', String(index));

  const icon = document.createElement('span');
  icon.className = 'libraries-tile__icon';
  icon.appendChild(iconSvg(category.icon));

  const label = document.createElement('span');
  label.className = 'libraries-tile__title';
  label.textContent = title;

  const count = document.createElement('span');
  count.className = 'libraries-tile__count';
  count.textContent = String(category.items.length);

  tile.append(icon, label, count);
  tile.addEventListener('click', () => handlers.openCategory(index));
  return tile;
}

// ---- Level 2: the header above one category's rows --------------------------

/**
 * Back button, the category's own icon, and its title.
 * @param {{icon: string}} category
 * @param {string} title already resolved to the current language
 */
export function detailHeader(category, title) {
  const header = document.createElement('div');
  header.className = 'libraries__detailhead';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'libraries__back';
  back.textContent = '←';
  back.title = t('libraries.back');
  back.setAttribute('aria-label', t('libraries.back'));
  back.addEventListener('click', () => handlers.back());

  const icon = document.createElement('span');
  icon.className = 'libraries__detailicon';
  icon.appendChild(iconSvg(category.icon));

  const heading = document.createElement('h3');
  heading.className = 'libraries__detailtitle';
  heading.textContent = title;

  header.append(back, icon, heading);
  return header;
}

// ---- Entry rows, shared by `detail` and `results` ---------------------------

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

/**
 * The main, full-width part of a row: name, host, description, and - in the
 * results view only - the category the entry belongs to.
 *
 * @param {{id:string,name:string,url:string,description:string}} item
 * @param {string} categoryTitle '' inside a category, where the header says it
 */
function rowButton(item, categoryTitle) {
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

  if (categoryTitle) {
    const cat = document.createElement('span');
    cat.className = 'libraries-item__cat';
    cat.textContent = categoryTitle;
    head.appendChild(cat);
  }

  btn.appendChild(head);

  if (item.description) {
    const desc = document.createElement('span');
    desc.className = 'libraries-item__desc';
    desc.textContent = item.description;
    btn.appendChild(desc);
  }

  // The ID, never the address: main resolves it from its own copy of the
  // catalog (src/libraries.js), which is what keeps this from being an open
  // redirect straight into the user's browser.
  btn.addEventListener('click', () => handlers.openItem(item.id));
  return btn;
}

/**
 * A <ul> of entry rows, plus those row buttons in DOM order - the caller needs
 * that list to drive the arrow keys, and re-deriving it from the DOM afterwards
 * would only be the same order, found again.
 *
 * @param {Array<{item: object, category: string}>} entries
 * @returns {{el: HTMLUListElement, rows: HTMLButtonElement[]}}
 */
export function itemList(entries) {
  const el = document.createElement('ul');
  el.className = 'libraries__items';
  const rows = [];

  for (const { item, category } of entries) {
    const li = document.createElement('li');
    li.className = 'libraries-item';

    const openBtn = rowButton(item, category);
    rows.push(openBtn);

    const actions = document.createElement('div');
    actions.className = 'libraries-item__actions';
    actions.append(
      actionButton('is-copy', '⧉', 'libraries.copy', () => handlers.copy(item.url)),
      actionButton('is-insert', '↳', 'libraries.insert', () => handlers.insert(item.url))
    );

    li.append(openBtn, actions);
    el.appendChild(li);
  }
  return { el, rows };
}
