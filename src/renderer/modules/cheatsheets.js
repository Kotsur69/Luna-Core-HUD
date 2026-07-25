// ============================================================================
// LunaCore - action cheatsheets (7C)
// ----------------------------------------------------------------------------
// Collapsible groups of one-click commands from config/cheatsheets.json.
// A click injects the command into the pty (Action Injector).
// ============================================================================

'use strict';

import { pulse } from './util.js';
import { term } from './terminals.js';

const cheatsContainer = document.getElementById('cheatsheets');

export async function initCheatsheets() {
  let data;
  try {
    data = await window.lunacore.getCheatsheets();
  } catch {
    return; // no config - the section stays empty
  }
  const groups = (data && data.groups) || [];
  cheatsContainer.innerHTML = '';
  groups.forEach((group, i) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    if (i === 0) details.open = true; // first group expanded

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = group.title;
    details.appendChild(summary);

    if (group.note) {
      const note = document.createElement('p');
      note.className = 'cheat__note';
      note.textContent = group.note;
      details.appendChild(note);
    }

    const cmds = document.createElement('div');
    cmds.className = 'cheat__cmds';
    for (const c of group.commands) {
      const btn = document.createElement('button');
      btn.className = 'cheat__btn';
      btn.textContent = c.label;
      btn.title = c.command; // full command in the tooltip
      btn.dataset.cmd = c.command;
      cmds.appendChild(btn);
    }
    details.appendChild(cmds);
    cheatsContainer.appendChild(details);
  });
}

// Delegated: a click injects the command into the pty (Action Injector).
cheatsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.cheat__btn');
  if (!btn) return;
  window.lunacore.runCommand(btn.dataset.cmd);
  pulse(btn);
  term.focus();
});
