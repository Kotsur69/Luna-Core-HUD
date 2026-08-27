// ============================================================================
// LunaCore - diagnostics tile (consolidated self-checks)
// ----------------------------------------------------------------------------
// One list of the degraded states LunaCore otherwise only mentions in passing:
// mpv missing (so every cue and every readout is silently dead), a wall of MCP
// servers that have never once been called, `claude` nowhere on PATH. The
// verdict for each row is decided in the pure main-process core
// (src/diagnostics.js); this widget only resolves the keys and paints them.
//
// Same two rules every A2 conversion follows (see ports.js):
//
//   * STATE THAT IS NOT THE DOM STAYS AT MODULE SCOPE. `report` is the last
//     answer from main; keeping it here means a remount (layout switch, panel
//     fold) repaints instantly instead of flashing "checking..." and waiting on
//     another IPC round trip.
//   * DOM HANDLES BELONG TO THE MOUNT. `els` is null while unmounted and every
//     render checks it; mount() returns a cleanup that undoes the one bus
//     subscription (the list/refresh listeners die with the subtree).
//
// PASSIVE OBSERVER: the tile reads state and never remediates. An action only
// points somewhere - the install docs, the clipboard, the MCP widget.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// null = no report yet, so the static "checking..." hint stays put. A failed
// refresh deliberately leaves the previous report in place (claudecheck.js's
// rule: a check that failed is not evidence of anything).
let report = null;
let loading = false;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

const STATUSES = ['ok', 'warn', 'fail', 'unknown'];

// Row id -> its label and (where it has one) action-button key. The core tags
// every row with an `id`; these are the only per-row strings the renderer owns.
const LABEL_KEY = {
  sound: 'diag.sound.label',
  claude: 'diag.claude.label',
  mcp: 'diag.mcp.label',
};
const ACTION_KEY = {
  sound: 'diag.sound.action',
  claude: 'diag.claude.action',
  mcp: 'diag.mcp.action',
};

/** Builds one check row: a status dot + label on top, the detail line under it,
 *  and one action button when the core attached an `action`. Mirrors the
 *  two-line shape of .mcp-item so the density matches. */
function buildRow(row) {
  const li = document.createElement('li');
  li.className = 'diag-item';

  const head = document.createElement('span');
  head.className = 'diag-item__head';

  const status = STATUSES.includes(row && row.status) ? row.status : 'unknown';
  const dot = document.createElement('span');
  dot.className = `diag-item__dot diag-item__dot--${status}`;
  dot.title = t('diag.unknown');

  const label = document.createElement('span');
  label.className = 'diag-item__label';
  label.textContent = t(LABEL_KEY[row.id] || 'diag.unknown');

  head.append(dot, label);

  if (row.action && typeof row.action.kind === 'string') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diag-item__action';
    btn.textContent = t(ACTION_KEY[row.id] || 'diag.unknown');
    btn.dataset.kind = row.action.kind;
    btn.dataset.value = row.action.value || '';
    head.appendChild(btn);
  }

  const detail = document.createElement('span');
  detail.className = 'diag-item__detail';
  detail.textContent = t(row.detailKey || 'diag.unknown', row.detailParams || {});

  li.append(head, detail);
  return li;
}

/** Repaints from `report`. Guarded on `els` - a no-op while unmounted. */
function render() {
  if (!els) return;

  if (!report) {
    els.list.innerHTML = '';
    els.summary.textContent = '';
    els.empty.style.display = '';
    els.empty.textContent = t('diag.checking');
    return;
  }

  els.empty.style.display = 'none';
  els.summary.textContent =
    report.status === 'ok' ? t('diag.allClear') : t('diag.issues', { n: report.issues });

  els.list.innerHTML = '';
  for (const row of Array.isArray(report.rows) ? report.rows : []) {
    els.list.appendChild(buildRow(row));
  }
}

/**
 * Pulls a fresh report from main. `rescan` forces the MCP usage scan to
 * re-stream every transcript (~1s) - the refresh button passes it, the first
 * load does not.
 */
async function refresh({ rescan = false } = {}) {
  if (loading) return;
  loading = true;
  try {
    const data = await window.lunacore.getDiagnostics({ rescan });
    if (data && Array.isArray(data.rows)) report = data;
  } catch {
    /* keep the last report - a failed refresh is not evidence of anything */
  } finally {
    loading = false;
    render();
  }
}

/**
 * First load. Called once from renderer.js and NOT awaited: it is an IPC round
 * trip and nothing downstream depends on the answer. A no-op repaint if the
 * widget is not mounted yet - render() checks `els`.
 */
export async function initDiagnostics() {
  await refresh();
}

defineWidget({
  id: 'diagnostics',
  titleKey: 'diag.title',
  template: 'w-diagnostics',
  mount(root) {
    els = {
      list: root.querySelector('#diag-list'),
      empty: root.querySelector('#diag-empty'),
      summary: root.querySelector('#diag-summary'),
      refresh: root.querySelector('#diag-refresh'),
    };

    const offLang = onLangChange(render);

    if (els.refresh) {
      els.refresh.addEventListener('click', () => {
        pulse(els.refresh);
        refresh({ rescan: true });
      });
    }

    // Delegated: the tile's job ends at pointing somewhere. No remediation.
    els.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.diag-item__action');
      if (!btn) return;
      const { kind, value } = btn.dataset;
      if (kind === 'docs' && value === 'claude') {
        window.lunacore.openClaudeDocs();
      } else if (kind === 'docs' && value === 'mpv') {
        window.lunacore.openMpvDocs();
      } else if (kind === 'copy') {
        navigator.clipboard.writeText(value || '').catch(() => {});
        pulse(btn);
      } else if (kind === 'focus' && value === 'mcp') {
        document
          .getElementById('mcp-list')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Module-scope `report` survives remount, so this paints the current answer
    // at once; only the very first mount of the session waits on IPC.
    render();

    return () => {
      offLang();
      els = null;
    };
  },
});
