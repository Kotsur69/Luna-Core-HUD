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
//
// One time only (hubBriefHintSeen in ui.local.json): a small hint under the
// Mission Control chip says the brief moved to the hub. Clicking it opens the
// drawer; it goes away on its own after a few seconds.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { startHub, onHubView, hubLoaded } from './hubstate.js';
import { toggleHub, openHub, onHubOpenChange } from './hubpanel.js';
import { shouldAutoOpen, normalizeAutoOpen } from './hubrules.js';

const PULSE_CLASS = 'is-bumped';
/** Past the boot sequence, so the hint is not covered by it. */
const HINT_DELAY_MS = 5000;
const HINT_SHOW_MS = 12000;
const HINT_GAP_PX = 8;

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => null);

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

function showBriefMovedHint(mcChip) {
  const r = mcChip.getBoundingClientRect();
  // A chip that is not on screen (hidden module, collapsed bar) gets no hint
  // and the hint stays unseen for the next launch.
  if (!r.width || !r.height) return;
  call('setUiPrefs', { hubBriefHintSeen: true });
  const tip = document.createElement('button');
  tip.type = 'button';
  tip.className = 'hub-hint';
  tip.textContent = t('hub.briefMoved');
  tip.setAttribute('role', 'status');
  tip.style.top = `${Math.round(r.bottom + HINT_GAP_PX)}px`;
  tip.style.right = `${Math.max(HINT_GAP_PX, Math.round(window.innerWidth - r.right))}px`;
  const dismiss = () => tip.remove();
  tip.addEventListener('click', () => {
    dismiss();
    openHub();
  });
  document.body.append(tip);
  setTimeout(dismiss, HINT_SHOW_MS);
}

async function maybeBriefMovedHint(root) {
  const mcChip = root.querySelector('#mission-open');
  if (!mcChip) return;
  const prefs = await call('getUiPrefs');
  if (!prefs || prefs.hubBriefHintSeen === true) return;
  setTimeout(() => {
    if (document.documentElement.dataset.hideMission === '1') return;
    showBriefMovedHint(mcChip);
  }, HINT_DELAY_MS);
}

/**
 * Launch auto-open (hubrules.js shouldAutoOpen): the drawer opens once, by
 * itself, when a view in the first AUTO_OPEN_WINDOW_MS has unseen Needs-you
 * items (or always / never, per the hubAutoOpen setting). The listener stays
 * subscribed but goes inert after its one decision.
 */
function wireAutoOpen() {
  const launchedAt = Date.now();
  let opened = false;
  let mode = null;
  let latest = null;
  function check() {
    if (opened || mode === null || !latest || !hubLoaded()) return;
    if (!shouldAutoOpen({ mode, unseen: latest.unseen, opened, sinceLaunchMs: Date.now() - launchedAt })) return;
    opened = true;
    openHub();
  }
  onHubView((view) => {
    latest = view;
    check();
  });
  // The prefs answer may land after the first view: it re-checks the latest one.
  call('getUiPrefs').then((prefs) => {
    mode = normalizeAutoOpen(prefs && prefs.hubAutoOpen);
    check();
  });
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
  wireAutoOpen();
  startHub();
  maybeBriefMovedHint(root);
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
