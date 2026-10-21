// ============================================================================
// LunaCore - Settings overlay (Ctrl+L): category rail + cross-category search
// ----------------------------------------------------------------------------
// The overlay's markup (index.html) is a rail of category tabs and one
// <section class="termcustom__pane"> per category, each holding titled
// .termcustom__group blocks. Every control keeps its original id, so the
// modules that mount into #termcustom (notify.js, autocompact.js, ...) never
// notice the regrouping - this file only shows and hides containers.
//
// Two modes:
//   browse - one pane visible, picked in the rail (click or arrow keys);
//   search - a non-empty query shows every pane at once and hides each group
//            item that matches in neither language (settingsearch.js).
// Hiding uses a class, never the `hidden` attribute: several fields
// (#autocompact-turns-field, #termcustom-font-family-custom-field, ...) own
// their `hidden` state, and search must not clobber it.
// ============================================================================

'use strict';

import { filterSettings, findMatchRanges, moveNavIndex } from './settingsearch.js';
import { t } from './util.js';
import { onLangChange } from './bus.js';

const HIDE = 'is-search-hidden';
const HIGHLIGHT_NAME = 'termcustom-match';

/** Every language's text for the i18n keys on `el` and its descendants. */
function i18nTexts(el) {
  const tAll = window.i18n && window.i18n.tAll;
  if (typeof tAll !== 'function') return [];
  const out = [];
  const nodes = [el, ...el.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-ph]')];
  for (const node of nodes) {
    const { i18n, i18nTitle, i18nPh } = node.dataset || {};
    for (const key of [i18n, i18nTitle, i18nPh]) if (key) out.push(...tAll(key));
  }
  return out;
}

/** The searchable text of one element: what is on screen plus both languages. */
function haystackOf(el) {
  return [el.textContent || '', el.getAttribute('title') || '', ...i18nTexts(el)];
}

/** Paints the CSS Custom Highlight for `query` over the visible text in `root`. */
function paintHighlights(root, query) {
  const registry = window.CSS && CSS.highlights;
  if (!registry || typeof Highlight !== 'function') return; // feature-detect, cosmetic only
  registry.delete(HIGHLIGHT_NAME);
  if (!query) return;
  const ranges = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    // <option> text never renders inline, and hidden items are not on screen.
    if (!parent || parent.closest(`option, select, .${HIDE}, [hidden]`)) continue;
    for (const [start, end] of findMatchRanges(node.data, query)) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  if (ranges.length) registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

/**
 * Wires the rail, the panes and the search box inside the #termcustom overlay.
 * Returns { onOpen } - termcustom.js calls it every time the overlay opens.
 */
export function initSettingsNav(root) {
  const nav = root.querySelector('#termcustom-nav');
  const body = root.querySelector('#termcustom-body');
  const search = root.querySelector('#termcustom-search');
  const empty = root.querySelector('#termcustom-empty');
  const tabs = Array.from(nav.querySelectorAll('.termcustom__navitem'));
  const panes = Array.from(body.querySelectorAll('.termcustom__pane'));
  const groups = Array.from(body.querySelectorAll('.termcustom__group'));

  let current = 0;

  /** Browse mode: shows only the selected pane and marks its tab. */
  function selectTab(index, { focus = false } = {}) {
    current = index;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      // Roving tabindex: Tab enters the rail once, arrows move inside it.
      tab.tabIndex = on ? 0 : -1;
    });
    if (!search.value.trim()) panes.forEach((pane, i) => { pane.hidden = i !== index; });
    if (focus) tabs[index].focus();
    body.scrollTop = 0;
  }

  /** Splits a group into its title element and its filterable children. */
  function partsOf(group) {
    const title = group.querySelector(':scope > .termcustom__section');
    const items = Array.from(group.children).filter((el) => el !== title);
    return { title, items };
  }

  /** Clears every search-mode mark and returns to browse mode. */
  function clearFilter() {
    body.classList.remove('is-searching');
    body.querySelectorAll(`.${HIDE}`).forEach((el) => el.classList.remove(HIDE));
    tabs.forEach((tab) => tab.classList.remove('has-match', 'no-match'));
    empty.hidden = true;
    paintHighlights(body, '');
    selectTab(current);
  }

  /** Applies the search box's query across all panes. */
  function applyFilter() {
    const query = search.value.trim();
    const parts = groups.map(partsOf);
    const result = filterSettings(
      parts.map(({ title, items }) => ({
        title: title ? haystackOf(title) : '',
        items: items.map(haystackOf),
      })),
      query
    );
    if (!result) { clearFilter(); return; }

    body.classList.add('is-searching');
    const hits = new Map(result.groups.map((g) => [g.index, new Set(g.items)]));
    parts.forEach(({ items }, gi) => {
      const visible = hits.get(gi);
      groups[gi].classList.toggle(HIDE, !visible);
      items.forEach((item, ii) => item.classList.toggle(HIDE, !visible || !visible.has(ii)));
    });
    panes.forEach((pane, pi) => {
      const any = pane.querySelector(`.termcustom__group:not(.${HIDE})`) !== null;
      pane.hidden = false;
      pane.classList.toggle(HIDE, !any);
      tabs[pi].classList.toggle('has-match', any);
      tabs[pi].classList.toggle('no-match', !any);
    });

    empty.hidden = result.count > 0;
    if (!result.count) empty.textContent = t('termcustom.search.empty', { q: query });
    paintHighlights(body, query);
    body.scrollTop = 0;
  }

  search.addEventListener('input', applyFilter);

  // Enter in the search box jumps to the first visible control - otherwise
  // the overlay's generic Enter handler would just blur and refocus the box.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const first = body.querySelector(
      `.termcustom__pane:not(.${HIDE}) :is(input, select, button):not([disabled])`
    );
    const visible = first && !first.closest(`.${HIDE}, [hidden]`) ? first : null;
    if (visible) visible.focus();
  });

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      // Picking a category is a way out of search: the query would otherwise
      // keep every other pane visible underneath the one just chosen.
      if (search.value) { search.value = ''; clearFilter(); }
      selectTab(i);
    });
  });

  nav.addEventListener('keydown', (e) => {
    const next = moveNavIndex(current, e.key, tabs.length);
    if (next < 0) return;
    e.preventDefault();
    if (search.value) { search.value = ''; clearFilter(); }
    selectTab(next, { focus: true });
  });

  // Status spans and the empty-state text are re-translated on a language
  // change; re-running the filter keeps highlights on the new strings.
  onLangChange(() => { if (search.value.trim()) applyFilter(); });

  selectTab(0);

  return {
    /** Fresh state on every open: empty query, search box focused. */
    onOpen() {
      if (search.value) { search.value = ''; clearFilter(); }
      search.focus();
    },
  };
}
