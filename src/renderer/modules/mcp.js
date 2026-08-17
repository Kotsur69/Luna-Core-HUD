// ============================================================================
// LunaCore - MCP server health panel
// ----------------------------------------------------------------------------
// Rows for every configured MCP server, sorted by how neglected it is, with a
// per-server "test" button that runs a real handshake (src/mcphealth.js).
//
// The scan is LAZY and manual. It streams every session transcript on this
// machine, which takes about a second - cheap enough to ask for, far too much
// to put on a timer for a number that changes maybe once a day. So the first
// mount loads it once, the refresh button reloads it, and nothing else does.
//
// A2: the loaded rows and the probe results live at module scope, so a remount
// (layout switch, panel fold) repaints instantly instead of re-scanning. `els`
// belongs to the mount and is null while unmounted, same rule as ports.js.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// null = never scanned, so the static "scanning..." hint stays put.
let rows = null;
let scanning = false;

// name -> { state: 'running'|'done', ok, reason, tools, ms }
const probes = new Map();

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "never" or a rounded day count - the panel never needs more precision. */
function idleLabel(server) {
  if (!server.lastUsed) return t('mcp.never');
  const days = Math.floor((Date.now() - server.lastUsed) / DAY_MS);
  return days <= 0 ? t('mcp.today') : t('mcp.daysAgo', { n: days });
}

/** One-line verdict for a finished probe. */
function probeLabel(p) {
  if (!p) return '';
  if (p.state === 'running') return t('mcp.probe.running');
  if (p.reason === 'remote') return t('mcp.probe.remote');
  if (!p.ok) return t('mcp.probe.fail', { reason: p.reason || '?' });
  const tools = p.tools === null ? '?' : p.tools;
  return t('mcp.probe.ok', { tools, ms: p.ms });
}

function makeRow(s) {
  const li = document.createElement('li');
  li.className = `mcp-item mcp-item--${s.status}`;
  if (!s.enabled) li.classList.add('mcp-item--off');

  const head = document.createElement('span');
  head.className = 'mcp-item__head';

  const dot = document.createElement('span');
  dot.className = 'mcp-item__dot';
  dot.title = t(`mcp.status.${s.status}`);

  const name = document.createElement('span');
  name.className = 'mcp-item__name';
  name.textContent = s.name;

  const scope = document.createElement('span');
  scope.className = 'mcp-item__scope';
  scope.textContent = t(`mcp.scope.${s.scope}`);
  if (s.scopeLabel) scope.title = s.scopeLabel;

  head.append(dot, name, scope);

  // Only stdio servers can be handshaken from here; the rest say so rather
  // than offering a button that would report something it did not measure.
  if (s.transport === 'stdio' && s.command) {
    const test = document.createElement('button');
    test.className = 'mcp-test';
    test.textContent = '⟳';
    test.title = t('mcp.probe.title');
    test.dataset.probe = s.name;
    head.appendChild(test);
  }

  const meta = document.createElement('span');
  meta.className = 'mcp-item__meta';
  const calls = s.calls ? t('mcp.calls', { n: s.calls }) : t('mcp.noCalls');
  meta.textContent = `${idleLabel(s)} · ${calls}`;
  if (!s.enabled) meta.textContent += ` · ${t('mcp.disabled')}`;

  li.append(head, meta);

  const p = probes.get(s.name);
  if (p) {
    const verdict = document.createElement('span');
    verdict.className = p.ok ? 'mcp-item__probe is-ok' : 'mcp-item__probe is-bad';
    verdict.textContent = probeLabel(p);
    li.appendChild(verdict);
  }
  return li;
}

function render() {
  if (!els) return;

  if (!rows) {
    els.empty.textContent = scanning ? t('mcp.scanning') : t('mcp.idle');
    els.empty.style.display = '';
    els.list.innerHTML = '';
    els.summary.textContent = '';
    return;
  }

  els.list.innerHTML = '';
  for (const s of rows) els.list.appendChild(makeRow(s));

  // The summary is the whole reason to open this panel: how much of the
  // context window is being spent on servers nothing has called.
  const dead = rows.filter((s) => s.status === 'never' || s.status === 'stale').length;
  els.summary.textContent = rows.length
    ? t('mcp.summary', { total: rows.length, dead })
    : '';
  els.empty.textContent = rows.length ? '' : t('mcp.empty');
  els.empty.style.display = rows.length ? 'none' : '';
}

async function load() {
  if (scanning) return;
  scanning = true;
  render();
  try {
    const data = await window.lunacore.getMcpHealth();
    rows = Array.isArray(data && data.servers) ? data.servers : [];
  } catch {
    rows = [];
  } finally {
    scanning = false;
    render();
  }
}

defineWidget({
  id: 'mcp',
  titleKey: 'mcp.title',
  template: 'w-mcp',
  mount(root) {
    els = {
      list: root.querySelector('#mcp-list'),
      empty: root.querySelector('#mcp-empty'),
      summary: root.querySelector('#mcp-summary'),
      refresh: root.querySelector('#mcp-refresh'),
    };

    const offLang = onLangChange(render);

    els.refresh.addEventListener('click', () => {
      pulse(els.refresh);
      load();
    });

    els.list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.mcp-test');
      if (!btn) return;
      const name = btn.dataset.probe;
      const server = (rows || []).find((s) => s.name === name);
      if (!server || probes.get(name)?.state === 'running') return;

      probes.set(name, { state: 'running' });
      render();
      const result = await window.lunacore.probeMcpServer(name);
      probes.set(name, { state: 'done', ...result });
      render();
    });

    // First mount pays for the scan; every later one repaints what is already
    // in memory.
    render();
    if (!rows) load();

    return () => {
      offLang();
      els = null;
    };
  },
});
