// ============================================================================
// LunaCore - localhost port tracker (7B)
// ----------------------------------------------------------------------------
// A passive scan in the main process lists listening ports; here they become
// rows with open / copy / kill actions.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';

const portsList = document.getElementById('ports-list');
const portsEmpty = document.getElementById('ports-empty');

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

window.lunacore.onPorts((ports) => {
  portsList.innerHTML = '';
  portsEmpty.style.display = ports.length ? 'none' : '';
  if (!ports.length) {
    portsEmpty.textContent = t('ports.empty');
    return;
  }
  for (const p of ports) {
    const li = document.createElement('li');
    li.className = 'port-item';

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
    portsList.appendChild(li);
  }
});

// Delegated actions: open / copy / kill.
portsList.addEventListener('click', async (e) => {
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
