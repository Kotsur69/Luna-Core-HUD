// ============================================================================
// LunaCore - Luna's Work project queue panel (docs/LUNAS_WORK_PLAN.md, B16)
// ----------------------------------------------------------------------------
// The "Queue" group of the Luna's Work Settings pane: the projects waiting for
// a run, in order, each with the start command and URL that were pinned when
// it was queued. Add (the project picked above), move up / down, remove.
// When a run ends with SHIP the next one starts; PLATEAU / RED / STOP leave
// the queue paused.
//
// Everything goes through window.lunacore.lunasworkQueue* (src/lunasworkipc.js):
// main decides whether a project may join (profile, design pack) and answers
// with the stored queue, which is what gets painted - through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { sfx } from './sound.js';
import { onLangChange } from './bus.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Localized text for a refused call. */
function reasonText(res) {
  const reason = res && typeof res.reason === 'string' ? res.reason : 'failed';
  const text = t(`lw.err.${reason}`);
  return text === `lw.err.${reason}` ? t('lw.err.failed') : text;
}

/**
 * @param {HTMLElement} root the Settings overlay
 * @param {{projectId: () => string|null}} ctx
 * @returns {{refresh: () => Promise<void>, dispose: () => void}}
 */
export function mountLunasWorkQueue(root, { projectId }) {
  const ui = {
    list: root.querySelector('#lw-queue-list'),
    empty: root.querySelector('#lw-queue-empty'),
    error: root.querySelector('#lw-queue-error'),
    add: root.querySelector('#lw-queue-add'),
  };
  if (Object.values(ui).some((v) => !v)) return { refresh: async () => {}, dispose: () => {} };

  let queue = [];
  let busy = false;

  function showError(text) {
    ui.error.textContent = text || '';
    ui.error.hidden = !text;
  }

  function iconButton(label, glyph, onClick, disabled) {
    const btn = el('button', 'pad-send lw-queue__btn', glyph);
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function item(entry, i) {
    const li = el('li', 'lw-queue__item');
    const text = el('div', 'lw-queue__text');
    text.append(el('span', 'lw-queue__label', entry.label), el('span', 'lw-queue__cmd', `${entry.startCommand} · ${entry.url}`));
    const actions = el('div', 'lw-queue__actions');
    actions.append(
      iconButton(t('lw.queue.up'), '↑', () => act(() => window.lunacore.lunasworkQueueMove(entry.projectId, -1)), busy || i === 0),
      iconButton(t('lw.queue.down'), '↓', () => act(() => window.lunacore.lunasworkQueueMove(entry.projectId, 1)), busy || i === queue.length - 1),
      iconButton(t('lw.queue.remove'), '✕', () => act(() => window.lunacore.lunasworkQueueRemove(entry.projectId)), busy),
    );
    li.append(text, actions);
    return li;
  }

  function paint() {
    ui.list.replaceChildren(...queue.map(item));
    ui.empty.hidden = queue.length > 0;
    const id = projectId();
    ui.add.disabled = busy || !id || queue.some((e) => e.projectId === id);
  }

  /** Runs one queue call and paints main's answer. */
  async function act(call) {
    if (busy) return;
    busy = true;
    paint();
    try {
      const res = await call();
      if (res && res.ok) {
        sfx.modeToggle();
        queue = Array.isArray(res.queue) ? res.queue : [];
        showError('');
      } else {
        showError(reasonText(res));
      }
    } finally {
      busy = false;
      paint();
    }
  }

  async function refresh() {
    const res = await window.lunacore.lunasworkQueueList();
    if (res && res.ok) queue = Array.isArray(res.queue) ? res.queue : [];
    else showError(reasonText(res));
    paint();
  }

  const onAdd = () => {
    const id = projectId();
    if (id) act(() => window.lunacore.lunasworkQueueAdd(id));
  };
  ui.add.addEventListener('click', onAdd);
  // A SHIP takes the head off the queue: every run event may change it.
  const offEvent = window.lunacore.onLunasworkEvent((event) => {
    if (event && event.type === 'phase') refresh();
  });
  onLangChange(paint);

  refresh();
  return {
    refresh: async () => {
      showError('');
      await refresh();
    },
    dispose: () => {
      ui.add.removeEventListener('click', onAdd);
      if (typeof offEvent === 'function') offEvent();
    },
  };
}
