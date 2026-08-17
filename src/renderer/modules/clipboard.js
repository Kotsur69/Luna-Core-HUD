// ============================================================================
// LunaCore - clipboard history widget
// ----------------------------------------------------------------------------
// Shows the last clips (newest first) with two actions each: inject into the
// session (the existing bracketed-paste path, WITHOUT sending - same choice
// scratchpad.js and the prompt library already make, so you can still edit)
// and copy back to the system clipboard.
//
// App-scoped, not per-tab: one system clipboard no matter how many terminals
// are open - so no registerSessionView, like media.js/telemetry.js.
//
// The list is rebuilt with innerHTML='' + createElement rather than an HTML
// string: clip text is arbitrary user content and must never be parsed as
// markup. ports.js's row builder sets the precedent.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange, onClipboardUpdate } from './bus.js';
import { term } from './terminals.js';
import { defineWidget } from './registry.js';

// How much of a clip a row shows. Long enough to recognise a snippet, short
// enough that twenty rows stay a list rather than a wall.
const PREVIEW_MAX = 90;

let els = null;
let entries = [];
let enabled = false;

/**
 * Collapses a clip to one preview line: whitespace runs (including newlines)
 * become single spaces, then a hard length cap. Pure, exported for tests.
 */
export function previewOf(text, max = PREVIEW_MAX) {
  const str = typeof text === 'string' ? text : '';
  const oneLine = str.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function renderRows() {
  if (!els) return;
  els.list.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'clip-item';

    const text = document.createElement('span');
    text.className = 'clip-item__text';
    text.textContent = previewOf(entry.text);
    // The full clip on hover - the preview is lossy by design.
    text.title = entry.text;
    li.append(text);

    const actions = document.createElement('span');
    actions.className = 'clip-item__actions';

    const inject = document.createElement('button');
    inject.className = 'port-btn';
    inject.textContent = '⚡';
    inject.title = t('clip.inject');
    inject.addEventListener('click', () => {
      window.lunacore.pastePrompt(entry.text, false);
      pulse(inject);
      term.focus();
    });

    const copy = document.createElement('button');
    copy.className = 'port-btn';
    copy.textContent = '⧉';
    copy.title = t('clip.copy');
    copy.addEventListener('click', async () => {
      await window.lunacore.copyClipboardEntry(entry.text);
      pulse(copy);
    });

    const drop = document.createElement('button');
    drop.className = 'port-btn';
    drop.textContent = '✕';
    drop.title = t('clip.remove');
    drop.addEventListener('click', async () => {
      const next = await window.lunacore.removeClipboardEntry(entry.text);
      entries = Array.isArray(next) ? next : entries;
      render();
    });

    actions.append(inject, copy, drop);
    li.append(actions);
    els.list.append(li);
  }
}

function render() {
  if (!els) return;
  els.enabled.checked = enabled;
  els.count.textContent = entries.length ? String(entries.length) : '';
  // Three states, and they are genuinely different: off (we are not reading),
  // on-but-nothing-yet (we are reading, you have not copied), and a list.
  // Collapsing the first two into one empty message would hide the fact that
  // the watcher is running.
  els.off.style.display = enabled ? 'none' : '';
  els.empty.style.display = enabled && entries.length === 0 ? '' : 'none';
  els.clear.disabled = entries.length === 0;
  els.off.textContent = t('clip.off');
  els.empty.textContent = t('clip.empty');
  renderRows();
}

defineWidget({
  id: 'clipboard',
  titleKey: 'clip.title',
  template: 'w-clipboard',
  mount(root) {
    els = {
      list: root.querySelector('#clip-list'),
      count: root.querySelector('#clip-count'),
      enabled: root.querySelector('#clip-enabled'),
      off: root.querySelector('#clip-off'),
      empty: root.querySelector('#clip-empty'),
      clear: root.querySelector('#clip-clear'),
    };

    const offClip = onClipboardUpdate((list) => {
      entries = Array.isArray(list) ? list : [];
      render();
    });
    const offLang = onLangChange(render);

    els.enabled.addEventListener('change', async () => {
      const state = await window.lunacore.setClipboardEnabled(els.enabled.checked);
      if (state) {
        enabled = state.enabled === true;
        entries = Array.isArray(state.entries) ? state.entries : [];
      }
      render();
    });

    els.clear.addEventListener('click', async () => {
      const next = await window.lunacore.clearClipboard();
      entries = Array.isArray(next) ? next : [];
      render();
    });

    // The watcher pushes only when something is copied, so a mount has to ask
    // for the current state rather than wait for a tick that may never come.
    window.lunacore
      .getClipboardState()
      .then((state) => {
        if (!els || !state) return;
        enabled = state.enabled === true;
        entries = Array.isArray(state.entries) ? state.entries : [];
        render();
      })
      .catch(() => {});

    render();

    return () => {
      offClip();
      offLang();
      els = null;
    };
  },
});
