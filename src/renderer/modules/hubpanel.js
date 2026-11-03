// ============================================================================
// LunaCore - notification hub: the right drawer (renderer)
// ----------------------------------------------------------------------------
// A drawer docked to the right edge, full window height. Not a modal: no
// backdrop, no focus trap, the terminal stays usable next to it. Built in JS
// and appended to <body> on first open. Esc closes it only while focus is
// inside it (the terminal owns Esc otherwise). textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { closeWithExit, cancelExit } from './motion.js';
import { onHubView } from './hubstate.js';

let drawer = null;
let bodyEl = null;
let titleEl = null;
let closeBtn = null;
let isOpen = false;
let returnFocus = null;
let lastView = { items: [], done: [], needs: 0 };
const openListeners = new Set();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  if (!bodyEl) return;
  const list = el('ul', 'hub-drawer__plain');
  for (const item of lastView.items) list.append(el('li', '', item.title));
  bodyEl.replaceChildren(lastView.items.length ? list : el('p', 'hint', t('hub.empty')));
}

function label() {
  titleEl.textContent = t('hub.title');
  drawer.setAttribute('aria-label', t('hub.title'));
  closeBtn.title = t('libraries.close');
  closeBtn.setAttribute('aria-label', t('libraries.close'));
}

function build() {
  drawer = el('aside', 'hub-drawer');
  drawer.id = 'hub-drawer';
  drawer.tabIndex = -1;
  drawer.hidden = true;
  const bar = el('div', 'hub-drawer__bar');
  titleEl = el('h2', 'hub-drawer__title');
  closeBtn = el('button', 'libraries__closebtn', '×');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => closeHub());
  bar.append(titleEl, closeBtn);
  bodyEl = el('div', 'hub-drawer__body');
  drawer.append(bar, bodyEl);
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeHub();
  });
  document.body.append(drawer);
  label();
  onLangChange(() => {
    label();
    render();
  });
  onHubView((view) => {
    lastView = view;
    if (isOpen) render();
  });
}

function emitOpen() {
  for (const fn of openListeners) fn(isOpen);
}

export function openHub() {
  if (isOpen) return;
  if (!drawer) build();
  cancelExit(drawer);
  isOpen = true;
  returnFocus = document.activeElement;
  render();
  drawer.hidden = false;
  drawer.focus();
  emitOpen();
}

export function closeHub() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(drawer);
  if (returnFocus && typeof returnFocus.focus === 'function' && drawer.contains(document.activeElement)) returnFocus.focus();
  returnFocus = null;
  emitOpen();
}

export function toggleHub() {
  if (isOpen) closeHub();
  else openHub();
}

/** fn(open) whenever the drawer opens or closes (the chip's aria-expanded). */
export function onHubOpenChange(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}
