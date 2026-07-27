// ============================================================================
// LunaCore - action cheatsheets (7C)
// ----------------------------------------------------------------------------
// Collapsible groups of one-click commands from config/cheatsheets.json.
// A click injects the command into the pty (Action Injector).
// ============================================================================

'use strict';

import { pulse, loc } from './util.js';
import { term } from './terminals.js';
import { onLangChange } from './bus.js';

const cheatsContainer = document.getElementById('cheatsheets');

// The loaded config is kept so a language switch is a re-render, not a re-read.
// Group titles and notes may be localized (see src/localized.js); the commands
// themselves never are - `!npm test` is the same in every language.
let lastGroups = [];

export async function initCheatsheets() {
  let data;
  try {
    data = await window.lunacore.getCheatsheets();
  } catch {
    return; // no config - the section stays empty
  }
  lastGroups = (data && data.groups) || [];
  renderCheatsheets();
}

function renderCheatsheets() {
  const groups = lastGroups;
  // Keep which groups the user opened - a language switch must not collapse
  // them back to "first one only".
  const open = [...cheatsContainer.querySelectorAll('.cheat')].map((d) => d.open);
  cheatsContainer.innerHTML = '';
  groups.forEach((group, i) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    // Restore the previous open state; on the very first render only the first
    // group is expanded.
    details.open = open.length ? !!open[i] : i === 0;

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = loc(group.title);
    details.appendChild(summary);

    const noteText = loc(group.note);
    if (noteText) {
      const note = document.createElement('p');
      note.className = 'cheat__note';
      note.textContent = noteText;
      details.appendChild(note);
    }

    const cmds = document.createElement('div');
    cmds.className = 'cheat__cmds';
    for (const c of group.commands) {
      const btn = document.createElement('button');
      btn.className = 'cheat__btn';
      btn.textContent = loc(c.label);
      btn.title = c.command; // full command in the tooltip - never translated
      btn.dataset.cmd = c.command;
      cmds.appendChild(btn);
    }
    details.appendChild(cmds);
    cheatsContainer.appendChild(details);
  });
}

// Titles, notes and button labels all come from config and may be localized.
onLangChange(renderCheatsheets);

// Delegated: a click injects the command into the pty (Action Injector).
cheatsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.cheat__btn');
  if (!btn) return;
  window.lunacore.runCommand(btn.dataset.cmd);
  pulse(btn);
  term.focus();
});
