// ============================================================================
// LunaCore - action cheatsheets (7C)
// ----------------------------------------------------------------------------
// Collapsible groups of one-click commands from config/cheatsheets.json.
// A click injects the command into the pty (Action Injector).
//
// A2: converted to the widget contract. This is the first of the three LIST
// BUILDERS (cheatsheets / prompts / skills), and they share one trap the earlier
// conversions did not have: the render reads state back OUT of the DOM it is
// about to destroy. Here it was which <details> the user had expanded - read
// from the live nodes, then rebuilt from them. That works for a language switch,
// where the old nodes are still there to read, and silently loses everything on
// a remount, where they are not: every group would snap back to "first one
// only". The open state is app state, so it lives at module scope now and the
// DOM only reflects it.
// ============================================================================

'use strict';

import { pulse, loc } from './util.js';
import { term } from './terminals.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// The loaded config is kept so a language switch is a re-render, not a re-read.
// Group titles and notes may be localized (see src/localized.js); the commands
// themselves never are - `!npm test` is the same in every language.
let lastGroups = [];

// Which groups the user has expanded, by index. Survives both a language switch
// and an unmount (see the header).
let openGroups = [];

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
  if (!els) return;
  const groups = lastGroups;
  els.list.innerHTML = '';
  groups.forEach((group, i) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    // Remembered state wins; on the very first render only the first group is
    // expanded.
    details.open = i < openGroups.length ? Boolean(openGroups[i]) : i === 0;
    openGroups[i] = details.open;
    // `toggle` does not bubble, so it is bound per group rather than delegated.
    // Bound INSIDE root, so the host removes it with the subtree.
    details.addEventListener('toggle', () => {
      openGroups[i] = details.open;
    });

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
    els.list.appendChild(details);
  });
}

defineWidget({
  id: 'cheatsheets',
  titleKey: 'cheats.title',
  template: 'w-cheatsheets',
  mount(root) {
    els = { list: root.querySelector('#cheatsheets') };

    // Delegated: a click injects the command into the pty (Action Injector).
    els.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.cheat__btn');
      if (!btn) return;
      window.lunacore.runCommand(btn.dataset.cmd);
      pulse(btn);
      term.focus();
    });

    // Titles, notes and button labels all come from config and may be localized.
    const offLang = onLangChange(renderCheatsheets);

    // Paint whatever initCheatsheets() already loaded, rather than an empty
    // section: on a remount the config is long since in memory.
    renderCheatsheets();

    return () => {
      offLang();
      els = null;
    };
  },
});
