// ============================================================================
// LunaCore - notification hub: the face chip and its badge (renderer, N2)
// ----------------------------------------------------------------------------
// The chip sits in the palette bar next to Mission Control / Life. Its face is
// static SVG in index.html, stroked in the theme accent (hub.css). The badge
// is the number of open "needs" items from hubstate.js: hidden at 0, live on
// every hub:changed push, and it pulses once when the count goes up (never
// under prefers-reduced-motion or the in-app motion "off").
//
// Ctrl+Shift+H toggles the drawer (hubpanel.js). Matched on e.code ('KeyH'),
// like Ctrl+Shift+M / N: the physical key is what the user learns. Free in
// main.js's before-input-event (it only claims Ctrl+Shift+K there) and in
// every other renderer module; capture phase gets ahead of xterm.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { startHub, onHubView } from './hubstate.js';
import { toggleHub, onHubOpenChange } from './hubpanel.js';

const PULSE_CLASS = 'is-bumped';

let chipEl = null;
let badgeEl = null;
let shownNeeds = 0;

const motionAllowed = () =>
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'off';

function label(needs) {
  if (!chipEl) return;
  const text = needs ? t('hub.chip.count', { n: needs }) : t('hub.chip.label');
  chipEl.setAttribute('aria-label', text);
}

function bump() {
  if (!badgeEl || !motionAllowed()) return;
  badgeEl.classList.remove(PULSE_CLASS);
  // Force a reflow so the one-shot animation can run again.
  void badgeEl.offsetWidth;
  badgeEl.classList.add(PULSE_CLASS);
}

function paint(view) {
  if (!badgeEl) return;
  const needs = Number.isInteger(view.needs) && view.needs > 0 ? view.needs : 0;
  badgeEl.textContent = needs > 99 ? '99+' : String(needs);
  badgeEl.hidden = needs === 0;
  label(needs);
  if (needs > shownNeeds) bump();
  shownNeeds = needs;
}

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountHubChip(root) {
  chipEl = root.querySelector('#hub-open');
  badgeEl = root.querySelector('#hub-count');
  if (!chipEl) return;
  chipEl.addEventListener('click', () => toggleHub());
  badgeEl.addEventListener('animationend', () => badgeEl.classList.remove(PULSE_CLASS));
  onHubOpenChange((open) => chipEl.setAttribute('aria-expanded', String(open)));
  onHubView(paint);
  onLangChange(() => label(shownNeeds));
  startHub();
}

window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.repeat && e.code === 'KeyH') {
      e.preventDefault();
      e.stopPropagation();
      toggleHub();
    }
  },
  true
);
