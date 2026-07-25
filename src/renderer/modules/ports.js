// ============================================================================
// LunaCore - localhost port tracker (7B) + system-noise filter (B5)
// ----------------------------------------------------------------------------
// A passive scan in the main process lists listening ports; here they become
// rows with open / copy / kill actions.
//
// B5: the scan tags every row with `system` (see src/ports.js). This module
// only decides whether to SHOW them. The full list is always kept in memory, so
// flipping the toggle is a re-render rather than a re-scan, and the line under
// the list always states how many rows were folded away - a filter that hides
// things silently is worse than no filter.
//
// A2: this is the first block converted to a widget. Two rules came out of it
// and hold for every conversion after it:
//
//   * STATE THAT IS NOT THE DOM STAYS AT MODULE SCOPE. The scan result and the
//     remembered toggle belong to the app, not to one mount; keeping them here
//     means a remounted widget paints the current list at once instead of
//     falling back to "scanning...".
//   * DOM HANDLES BELONG TO THE MOUNT. `els` is null while unmounted, and every
//     render checks it. Ids still live in the markup, which is safe because the
//     host refuses to mount the same widget twice.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange, onPortsUpdate } from './bus.js';
import { defineWidget } from './registry.js';

// null = no scan has landed yet, so the static "scanning..." hint stays put.
let lastPorts = null;
let hideSystem = true; // persisted in config/ui.local.json

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

/** Builds one action button (safely, without injecting HTML). */
function portButton(label, act, title, dataset) {
  const b = document.createElement('button');
  b.className = act === 'kill' ? 'port-btn port-btn--kill' : 'port-btn';
  b.textContent = label;
  b.title = title;
  b.dataset.act = act;
  Object.assign(b.dataset, dataset);
  return b;
}

/** Draws the current list through the filter and reports what it folded. */
function renderPorts() {
  if (!els || !lastPorts) return;

  const rows = hideSystem ? lastPorts.filter((p) => !p.system) : lastPorts;
  const hidden = lastPorts.length - rows.length;

  els.list.innerHTML = '';
  for (const p of rows) {
    const li = document.createElement('li');
    // A system row is dimmed rather than styled like a dev server - when the
    // filter is off you still want your own processes to stand out.
    li.className = p.system ? 'port-item port-item--system' : 'port-item';

    const port = document.createElement('span');
    port.className = 'port-item__port';
    port.textContent = p.port;

    const proc = document.createElement('span');
    proc.className = 'port-item__proc';
    proc.textContent = `${p.name} · ${p.procId}`;
    proc.title = `PID ${p.procId}`;

    const actions = document.createElement('span');
    actions.className = 'port-item__actions';
    actions.appendChild(portButton('↗', 'open', t('ports.open.title'), { port: p.port }));
    actions.appendChild(portButton('⧉', 'copy', t('ports.copy.title'), { port: p.port }));
    actions.appendChild(
      portButton('✕', 'kill', t('ports.kill.title'), { pid: p.procId, name: p.name, port: p.port })
    );

    li.append(port, proc, actions);
    els.list.appendChild(li);
  }

  // One line carrying the whole truth: nothing is listening, everything visible
  // was filtered, or N rows are hidden behind the toggle.
  let note = '';
  if (!lastPorts.length) note = t('ports.empty');
  else if (!rows.length) note = t('ports.allHidden', { n: hidden });
  else if (hidden) note = t('ports.hidden', { n: hidden });

  els.empty.textContent = note;
  els.empty.style.display = note ? '' : 'none';
}

/** Keeps the toggle's glyph and pressed state in sync with the flag. */
function syncFilterButton() {
  if (!els || !els.filter) return;
  els.filter.setAttribute('aria-pressed', hideSystem ? 'true' : 'false');
  els.filter.classList.toggle('is-on', hideSystem);
  els.filter.textContent = hideSystem ? '◉' : '◎';
}

/**
 * Restores the remembered toggle state.
 *
 * Stays outside mount(): the preference is read once per app launch, not once
 * per mount, and it is fine for it to land after the first paint - the default
 * (filtered) is what it usually turns out to be anyway.
 */
export async function initPorts() {
  try {
    const prefs = await window.lunacore.getUiPrefs();
    if (prefs && typeof prefs.hideSystemPorts === 'boolean') hideSystem = prefs.hideSystemPorts;
  } catch {
    /* no preferences - keep the default (filtered) */
  }
  syncFilterButton();
  renderPorts();
}

defineWidget({
  id: 'ports',
  titleKey: 'ports.title',
  template: 'w-ports',
  mount(root) {
    els = {
      list: root.querySelector('#ports-list'),
      empty: root.querySelector('#ports-empty'),
      filter: root.querySelector('#ports-filter'),
    };

    // The scan arrives through feeds.js rather than straight off IPC: that
    // subscription can be disposed, this one could not (see feeds.js). It also
    // replays, so a remount repaints from the last scan immediately.
    const offPorts = onPortsUpdate((ports) => {
      lastPorts = ports;
      renderPorts();
    });

    // Button titles and the hidden-count line are dynamic strings.
    const offLang = onLangChange(renderPorts);

    if (els.filter) {
      els.filter.addEventListener('click', () => {
        hideSystem = !hideSystem;
        syncFilterButton();
        renderPorts();
        window.lunacore.setUiPrefs({ hideSystemPorts: hideSystem });
      });
    }

    // Delegated actions: open / copy / kill.
    els.list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.port-btn');
      if (!btn) return;
      const { act, port, pid, name } = btn.dataset;
      if (act === 'open') {
        window.lunacore.openPort(Number(port));
      } else if (act === 'copy') {
        navigator.clipboard.writeText(`http://localhost:${port}`).catch(() => {});
        pulse(btn);
      } else if (act === 'kill') {
        if (!confirm(t('ports.kill.confirm', { name, pid, port }))) return;
        await window.lunacore.killPort(Number(pid));
      }
    });

    syncFilterButton();
    renderPorts();

    // Only the bus subscriptions need undoing - the listeners above are bound
    // to elements inside root, which the host removes with the subtree.
    return () => {
      offPorts();
      offLang();
      els = null;
    };
  },
});
