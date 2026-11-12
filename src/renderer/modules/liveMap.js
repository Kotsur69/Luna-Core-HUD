// ============================================================================
// LunaCore - Live map overlay (Ctrl+Shift+G): the shell
// ----------------------------------------------------------------------------
// A large overlay with three tabs - Sessions | God Mode | Luna's Work. This
// module owns only the shell: open / close, the tab strip (roving focus,
// Arrow keys), the focus trap, focus return, the remembered tab and the
// Ctrl+Shift+G / Esc keys. Each tab's content is a plug-in:
//
//   registerTab(key, { mount(panel), unmount(), onShow(), onHide(), onKey(e), onLang() })
//
// mount() runs once, on the tab's first show, into the tab's panel (the
// placeholder markup from index.html is cleared first); onShow / onHide run
// every time the tab comes into view or leaves it (the overlay closing
// counts as leaving). onKey(e) gets Escape and plain keys first and returns
// true when it used them. Every hook is optional. God Mode is registered
// here; Sessions and Luna's Work keep their placeholders until a later
// package registers them.
//
// Static markup in index.html (#livemap), .palette overlay CSS like Mission
// Control. Ctrl+Shift+G is matched on e.code ('KeyG'); gitquick.js leaves
// the shifted chord alone.
// ============================================================================

'use strict';

import { onLangChange } from './bus.js';
import { term } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
import { anyTallOpen } from './talloverlay.js';
import { TAB_KEYS, DEFAULT_TAB, STORAGE_TAB, readPref, writePref, nextTab } from './liveMapHelpers.js';
import { createGodModeTab } from './liveMapGodMode.js';

const overlayEl = typeof document !== 'undefined' ? document.getElementById('livemap') : null;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** key -> {impl, mounted} */
const tabs = new Map();
let isOpen = false;
let current = null;
let returnFocus = null;

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const q = (sel) => (overlayEl ? overlayEl.querySelector(sel) : null);
const tabButton = (key) => q(`[data-lm-tab="${key}"]`);
const panelOf = (key) => q(`[data-lm-panel="${key}"]`);
const call = (key, hook, ...args) => {
  const entry = tabs.get(key);
  if (!entry || typeof entry.impl[hook] !== 'function') return undefined;
  try {
    return entry.impl[hook](...args);
  } catch (err) {
    // One tab's bug must not take the overlay down; say which hook failed.
    console.error(`[livemap] ${key}.${hook} failed:`, err);
    return undefined;
  }
};

/**
 * Plugs a tab's content in. Replaces an earlier registration of the same key.
 * @param {'sessions'|'godmode'|'lunaswork'} key
 * @param {{mount?:(panel:HTMLElement) => void, unmount?:() => void, onShow?:() => void,
 *   onHide?:() => void, onKey?:(e:KeyboardEvent) => boolean, onLang?:() => void}} impl
 * @returns {() => void} unregisters (the placeholder does not come back)
 */
export function registerTab(key, impl) {
  if (!TAB_KEYS.includes(key) || !impl || typeof impl !== 'object') throw new Error(`livemap: bad tab ${key}`);
  if (tabs.has(key)) unregister(key);
  tabs.set(key, { impl, mounted: false });
  if (isOpen && current === key) showTab(key);
  return () => {
    if (tabs.get(key) && tabs.get(key).impl === impl) unregister(key);
  };
}

function unregister(key) {
  const entry = tabs.get(key);
  if (!entry) return;
  if (isOpen && current === key) call(key, 'onHide');
  if (entry.mounted) call(key, 'unmount');
  tabs.delete(key);
}

function showTab(key) {
  const entry = tabs.get(key);
  const panel = panelOf(key);
  if (entry && panel && !entry.mounted) {
    panel.replaceChildren();
    entry.mounted = true;
    call(key, 'mount', panel);
  }
  call(key, 'onShow');
}

/** Switches tabs (and remembers the choice). */
export function selectTab(key, { focus = false } = {}) {
  if (!overlayEl || !TAB_KEYS.includes(key)) return;
  if (current === key) {
    if (focus) tabButton(key).focus();
    return;
  }
  if (current && isOpen) call(current, 'onHide');
  current = key;
  writePref(storage(), STORAGE_TAB, key);
  for (const k of TAB_KEYS) {
    const btn = tabButton(k);
    const panel = panelOf(k);
    const on = k === key;
    if (btn) {
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    }
    if (panel) panel.hidden = !on;
  }
  if (focus) tabButton(key).focus();
  if (isOpen) showTab(key);
}

/** Opens the live map (on a given tab, or the remembered one). */
export function openLiveMap(tab) {
  if (!overlayEl) return;
  if (isOpen) {
    if (tab) selectTab(tab, { focus: true });
    return;
  }
  isOpen = true;
  returnFocus = document.activeElement;
  cancelExit(overlayEl);
  overlayEl.hidden = false;
  const key = TAB_KEYS.includes(tab) ? tab : readPref(storage(), STORAGE_TAB, TAB_KEYS, DEFAULT_TAB);
  // Cleared so selectTab() shows the tab again (its onHide ran on close).
  current = null;
  selectTab(key, { focus: true });
}

/**
 * Closes it; focus goes back where it was (or to the terminal).
 * @param {{focusTerminal?: boolean}} [opts] focusTerminal: a worker tab was just
 *   activated, so the terminal (now showing it) takes focus, not the old element.
 */
export function closeLiveMap(opts = {}) {
  if (!isOpen) return;
  isOpen = false;
  if (current) call(current, 'onHide');
  closeWithExit(overlayEl);
  const back = returnFocus;
  returnFocus = null;
  if (!opts.focusTerminal && back && back.isConnected && typeof back.focus === 'function' && back !== document.body) back.focus();
  else term.focus();
}

export const isLiveMapOpen = () => isOpen;

/** Keeps Tab / Shift+Tab inside the modal. */
function trapFocus(e) {
  const modal = q('.palette__modal');
  if (!modal) return;
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!modal.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onOpenKey(e) {
  if (e.key === 'Tab') {
    trapFocus(e);
    return;
  }
  if (e.key === 'Escape') {
    // A tall overlay on top (run summary) closes first, on its own.
    if (anyTallOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!call(current, 'onKey', e)) closeLiveMap();
    return;
  }
  // Only keys aimed at the overlay; the terminal never sees them while it is open.
  if (overlayEl.contains(e.target) && call(current, 'onKey', e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

if (overlayEl) {
  registerTab('godmode', createGodModeTab({ close: (opts) => closeLiveMap(opts) }));

  overlayEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-livemap-close')) closeLiveMap();
  });
  for (const key of TAB_KEYS) {
    const btn = tabButton(key);
    if (btn) btn.addEventListener('click', () => selectTab(key, { focus: true }));
  }
  const strip = q('.lm-tabs');
  if (strip) {
    strip.addEventListener('keydown', (e) => {
      const to = nextTab(e.key, current);
      if (!to) return;
      e.preventDefault();
      selectTab(to, { focus: true });
    });
  }
  onLangChange(() => {
    if (isOpen && current) call(current, 'onLang');
  });

  // Capture phase, to get ahead of xterm.js - same as Ctrl+Shift+M / Ctrl+Shift+H.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault();
        e.stopPropagation();
        // A held chord would flicker the overlay open and shut.
        if (e.repeat) return;
        if (isOpen) closeLiveMap();
        else openLiveMap();
        return;
      }
      if (isOpen) onOpenKey(e);
    },
    true,
  );
}
