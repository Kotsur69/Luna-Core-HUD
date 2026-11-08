// ============================================================================
// LunaCore phone - a confirm sheet (bottom sheet with Cancel / OK)
// ----------------------------------------------------------------------------
// Used before a God Mode action that cannot be undone from the phone (a
// merge into main, killing a run). Text only. Escape, the scrim and Cancel
// all answer false; focus goes to Cancel, the safe choice.
// ============================================================================

import { h } from '../dom.js';
import { t } from '../i18n.js';

/**
 * @param {{title: string, text?: string, ok: string, danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmSheet({ title, text = '', ok, danger = false }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    let root = null;
    const close = (answer) => {
      document.removeEventListener('keydown', onKey);
      root.remove();
      if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(false) }, t('cancel'));
    const okBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => close(true) }, ok);
    root = h(
      'div',
      { class: 'sheet-wrap' },
      h('div', { class: 'sheet-scrim', onclick: () => close(false) }),
      h(
        'div',
        { class: 'sheet stack-sm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title', 'aria-describedby': text ? 'sheet-text' : null },
        h('h2', { class: 'section-title', id: 'sheet-title' }, title),
        text ? h('p', { class: 'hint', id: 'sheet-text' }, text) : null,
        h('div', { class: 'sheet-actions' }, cancelBtn, okBtn),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(root);
    cancelBtn.focus();
  });
}
