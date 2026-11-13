// ============================================================================
// LunaCore - tall, scrollable Settings-style overlay (renderer)
// ----------------------------------------------------------------------------
// The Settings overlay's look (.termcustom, Ctrl+L) at a bigger size, for the
// God Mode run summary and the Mission Control brief.
// Built in JS and appended to <body> on first use, so index.html carries no
// markup for it. Overlays stack: Esc closes only the top one, and the panels
// under it (Mission Control) ask anyTallOpen() before taking Esc themselves.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { closeWithExit, cancelExit } from './motion.js';

const stack = [];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Whether any tall overlay is open (Mission Control leaves Esc to it). */
export const anyTallOpen = () => stack.length > 0;

/**
 * @param {{id:string, glyph:string, titleKey:string, onClose?:() => void, onKeydown?:(e:KeyboardEvent) => boolean}} spec
 *   onKeydown = the overlay's own keys while it is on top; true = handled (Esc then does not close it)
 * @returns {{body:HTMLElement, open:() => void, close:() => void, isOpen:() => boolean, setTitle:(text:string) => void}}
 */
export function createTallOverlay({ id, glyph, titleKey, onClose, onKeydown }) {
  const root = el('div', 'termcustom tall-overlay');
  root.id = id;
  root.tabIndex = -1;
  root.hidden = true;
  const backdrop = el('div', 'termcustom__backdrop');
  const modal = el('div', 'termcustom__modal tall-overlay__modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const bar = el('div', 'termcustom__bar');
  const title = el('span', 'termcustom__title tall-overlay__title');
  const closeBtn = el('button', 'libraries__closebtn', '×');
  closeBtn.type = 'button';
  bar.append(el('span', 'termcustom__glyph', glyph), title, closeBtn);
  const body = el('div', 'termcustom__body tall-overlay__body');
  const foot = el('div', 'termcustom__foot');
  const escHint = el('span');
  foot.append(escHint);
  modal.append(bar, body, foot);
  root.append(backdrop, modal);
  document.body.append(root);

  let customTitle = '';
  let returnFocus = null;

  function label() {
    title.textContent = customTitle || t(titleKey);
    modal.setAttribute('aria-label', title.textContent);
    closeBtn.title = t('libraries.close');
    closeBtn.setAttribute('aria-label', t('libraries.close'));
    const kbd = el('kbd', '', 'Esc');
    escHint.replaceChildren(kbd, ` ${t('palette.foot.close')}`);
  }

  const isOpen = () => stack.includes(api);

  function open() {
    if (isOpen()) return;
    cancelExit(root);
    returnFocus = document.activeElement;
    stack.push(api);
    label();
    root.hidden = false;
    body.scrollTop = 0;
    root.focus();
  }

  function close() {
    const at = stack.indexOf(api);
    if (at < 0) return;
    stack.splice(at, 1);
    closeWithExit(root);
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
    returnFocus = null;
    if (onClose) onClose();
  }

  function setTitle(text) {
    customTitle = text || '';
    label();
  }

  const api = { body, open, close, isOpen, setTitle, onKeydown: typeof onKeydown === 'function' ? onKeydown : null };
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  onLangChange(label);
  label();
  return api;
}

// Capture phase on window, registered before any panel that imports this
// module - so the top overlay gets Esc first and nothing under it closes.
// The top overlay's own key handler goes first: an Esc it used (cancel an
// edit, clear a selection) does not close it.
window.addEventListener(
  'keydown',
  (e) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    if (top.onKeydown && top.onKeydown(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    top.close();
  },
  true
);
