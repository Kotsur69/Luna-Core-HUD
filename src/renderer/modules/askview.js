// ============================================================================
// LunaCore - the nodes the /ask panel is built from
// ----------------------------------------------------------------------------
// Everything in here answers "what does it look like". Everything in
// modules/ask.js answers "what does it do" - when the overlay opens, when the
// askLibraries() bridge gets called, which of the four states (loading /
// success / error / empty-question) is currently on screen. Same split
// modules/libraries.js and modules/librariesview.js already established, for
// the same reason: pure builders with no state and no window.lunacore calls
// of their own, so they can be read (and eventually tested) in isolation.
//
// THE "RUN IT" STUB (see modules/ask.js's onRunSuggestion)
// ----------------------------------------------------------------------------
// suggestionCard() always renders the "Run it" button when a suggestion is
// flagged capability === 'highlight-extractor' (src/ask.js's allow-list) and
// always calls the onRun(item) handler it is given - it has no idea, and does
// not need to know, that onRun is a no-op stub in this phase. The highlight
// extractor itself is Phase 3/4 scope; wiring a real handler later is a
// one-line change in modules/ask.js, not here.
// ============================================================================

'use strict';

import { t } from './util.js';

// ---- Loading / error rows ----------------------------------------------------

/** Shown while askLibraries() is in flight. */
export function loadingRow() {
  const p = document.createElement('p');
  p.className = 'libraries__empty ask__loading';
  p.textContent = t('ask.loading');
  return p;
}

/** Every AskResult failure reason this file's caller can be handed, mapped to
 *  its i18n key. Anything unrecognized falls back to the generic row rather
 *  than rendering a raw error code. */
const ERROR_KEYS = {
  'empty-question': 'ask.error.emptyQuestion',
  'no-claude': 'ask.error.noClaude',
  timeout: 'ask.error.timeout',
  'bad-json': 'ask.error.badJson',
  generic: 'ask.error.generic',
};

/**
 * One row explaining why /ask has nothing to show. `emptyQuestion` should
 * basically never render in practice - modules/ask.js's openAsk() catches a
 * blank question before it ever calls the bridge - but the row stays wired
 * for defense-in-depth, same reasoning src/ask.js's header gives for never
 * trusting a single layer alone.
 * @param {string} reason one of AskResult's `reason` values
 */
export function errorRow(reason) {
  const p = document.createElement('p');
  p.className = 'libraries__empty ask__error';
  p.textContent = t(ERROR_KEYS[reason] || ERROR_KEYS.generic);
  return p;
}

// ---- The success-state panel --------------------------------------------------

/**
 * The static shell for a successful reply: a summary line, a "recommended"
 * section (catalog matches) and a "not in your library yet" section
 * (suggestions). Built fresh per render into an otherwise-empty #ask-body -
 * same "the body is empty in markup, JS builds the current view" convention
 * #libraries-list follows (see modules/libraries.js's header) - because which
 * sections even exist depends on what came back.
 *
 * The caller (modules/ask.js) fills `summaryEl.textContent`, appends
 * recommendedCard()/suggestionCard() nodes into the two lists, and hides
 * either section outright when its list ends up empty.
 *
 * @returns {{
 *   el: HTMLElement,
 *   summaryEl: HTMLElement,
 *   recommendedSection: HTMLElement,
 *   recommendedList: HTMLUListElement,
 *   suggestionsSection: HTMLElement,
 *   suggestionsList: HTMLUListElement,
 * }}
 */
export function askPanelSkeleton() {
  const el = document.createElement('div');
  el.className = 'ask__panel';

  const summaryLabel = document.createElement('h3');
  summaryLabel.className = 'ask__heading';
  summaryLabel.textContent = t('ask.summary.label');
  el.appendChild(summaryLabel);

  const summaryEl = document.createElement('p');
  summaryEl.className = 'ask__summary';
  el.appendChild(summaryEl);

  const recommendedHeading = document.createElement('h3');
  recommendedHeading.className = 'ask__heading';
  recommendedHeading.textContent = t('ask.recommended.heading');
  const recommendedList = document.createElement('ul');
  recommendedList.className = 'ask__list';
  const recommendedSection = document.createElement('section');
  recommendedSection.className = 'ask__section ask__section--recommended';
  recommendedSection.append(recommendedHeading, recommendedList);
  el.appendChild(recommendedSection);

  const suggestionsHeading = document.createElement('h3');
  suggestionsHeading.className = 'ask__heading';
  suggestionsHeading.textContent = t('ask.suggestions.heading');
  const suggestionsList = document.createElement('ul');
  suggestionsList.className = 'ask__list';
  const suggestionsSection = document.createElement('section');
  suggestionsSection.className = 'ask__section ask__section--suggestions';
  suggestionsSection.append(suggestionsHeading, suggestionsList);
  el.appendChild(suggestionsSection);

  return { el, summaryEl, recommendedSection, recommendedList, suggestionsSection, suggestionsList };
}

/**
 * One catalog-match card. `item` is one of AskResult's `recommended` entries
 * (src/ask.js's parseAskResponse) - already cross-referenced against the
 * loaded catalog, so `item.id` is always a real, openable entry.
 *
 * @param {{id:string,name:string,description:string,categoryTitle:string}} item
 * @param {{onOpen: (id:string) => void}} handlers
 */
export function recommendedCard(item, { onOpen }) {
  const li = document.createElement('li');
  li.className = 'ask-card ask-card--recommended';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ask-card__open';
  btn.title = t('libraries.open.title');

  const head = document.createElement('span');
  head.className = 'ask-card__head';

  const name = document.createElement('span');
  name.className = 'ask-card__name';
  name.textContent = item.name;
  head.appendChild(name);

  // categoryTitle already came back as plain text from src/ask.js's
  // titleText() - no loc() needed, unlike librariesview.js's rows.
  if (item.categoryTitle) {
    const cat = document.createElement('span');
    cat.className = 'ask-card__cat';
    cat.textContent = item.categoryTitle;
    head.appendChild(cat);
  }

  btn.appendChild(head);

  if (item.description) {
    const desc = document.createElement('span');
    desc.className = 'ask-card__desc';
    desc.textContent = item.description;
    btn.appendChild(desc);
  }

  // The id, never a url - same rule librariesview.js's rowButton() follows:
  // main resolves the address from its own copy of the catalog
  // (src/libraries.js), which is what keeps this from being an open redirect.
  btn.addEventListener('click', () => onOpen(item.id));
  li.appendChild(btn);
  return li;
}

/**
 * One "not in your library yet" card. `item` is one of AskResult's
 * `suggestions` entries - `url` already passed src/libraries.js's safeUrl()
 * gate, `capability` is already coerced onto a fixed allow-list, so this
 * builder can render both without re-validating them itself.
 *
 * @param {{name:string,description:string,capability:string|null}} item
 * @param {{onAdd: (item:object, buttonEl:HTMLButtonElement) => void, onRun: (item:object) => void}} handlers
 */
export function suggestionCard(item, { onAdd, onRun }) {
  const li = document.createElement('li');
  li.className = 'ask-card ask-card--suggestion';

  const name = document.createElement('span');
  name.className = 'ask-card__name';
  name.textContent = item.name;
  li.appendChild(name);

  if (item.description) {
    const desc = document.createElement('span');
    desc.className = 'ask-card__desc';
    desc.textContent = item.description;
    li.appendChild(desc);
  }

  const actions = document.createElement('div');
  actions.className = 'ask-card__actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ask-card__add';
  addBtn.textContent = t('ask.suggestions.add');
  addBtn.addEventListener('click', () => onAdd(item, addBtn));
  actions.appendChild(addBtn);

  // Only when the model flagged this suggestion as a clip-trimming tool
  // (src/ask.js's ALLOWED_CAPABILITIES). onRun() is a no-op stub for this
  // phase (modules/ask.js's onRunSuggestion) - the highlight extractor itself
  // is Phase 3/4 scope; this button and its wiring are already correct for
  // when it lands.
  if (item.capability === 'highlight-extractor') {
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'ask-card__run';
    runBtn.textContent = t('ask.suggestions.run');
    runBtn.addEventListener('click', () => onRun(item));
    actions.appendChild(runBtn);
  }

  li.appendChild(actions);
  return li;
}
