// ============================================================================
// LunaCore - prompt library (multi-line, pasted)
// ----------------------------------------------------------------------------
// The main button pastes a prompt WITHOUT sending it, so you can still add
// details; the small one pastes and sends immediately.
//
// A2: converted to the widget contract. Same shape as cheatsheets.js, including
// the open-groups fix described in its header - a remount must not collapse the
// library back to its first group.
//
// One thing here that cheatsheets does not have: `promptIndex` is derived state,
// not DOM. It maps a button's key to the RESOLVED prompt body, and it is what
// actually gets pasted. It is rebuilt by every render and kept at module scope,
// so an unmount does not have to clear it - a click can only come from a button
// that the same render created.
// ============================================================================

'use strict';

import { pulse, loc, t } from './util.js';
import { term } from './terminals.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// Kept so a language switch re-renders from memory instead of re-reading config.
let lastGroups = [];

// Which groups the user has expanded, by index. Survives a remount.
let openGroups = [];

// Prompt bodies live here (a DOM dataset does not take multi-line text well);
// the button only carries a "group:prompt" index.
const promptIndex = new Map();

export async function initPrompts() {
  let data;
  try {
    data = await window.lunacore.getPrompts();
  } catch {
    return; // no config - the section stays empty
  }
  lastGroups = (data && data.groups) || [];
  renderPrompts();
}

function renderPrompts() {
  if (!els) return;
  const groups = lastGroups;
  els.list.innerHTML = '';
  promptIndex.clear();

  groups.forEach((group, gi) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    details.open = gi < openGroups.length ? Boolean(openGroups[gi]) : gi === 0;
    openGroups[gi] = details.open;
    // `toggle` does not bubble - bound per group, inside root.
    details.addEventListener('toggle', () => {
      openGroups[gi] = details.open;
    });

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = loc(group.title);
    details.appendChild(summary);

    const groupNote = loc(group.note);
    if (groupNote) {
      const note = document.createElement('p');
      note.className = 'cheat__note';
      note.textContent = groupNote;
      details.appendChild(note);
    }

    const list = document.createElement('div');
    list.className = 'prompt-list';

    group.prompts.forEach((p, pi) => {
      const key = `${gi}:${pi}`;
      // Resolve the body ONCE per render and index the resolved string: this is
      // what actually gets pasted, so switching to EN must paste the English
      // prompt, not merely relabel the button.
      const text = loc(p.text);
      promptIndex.set(key, text);

      const row = document.createElement('div');
      row.className = 'prompt-row';

      // Main button: pastes the prompt WITHOUT sending it.
      const insert = document.createElement('button');
      insert.className = 'prompt-btn';
      insert.textContent = loc(p.label);
      const promptNote = loc(p.note);
      insert.title = promptNote ? `${promptNote}\n\n${text}` : text;
      insert.dataset.key = key;
      insert.dataset.act = 'insert';

      // Small button: paste and send right away.
      const send = document.createElement('button');
      send.className = 'prompt-send';
      send.textContent = '⏎';
      send.title = t('prompts.send.title');
      send.dataset.key = key;
      send.dataset.act = 'send';

      row.append(insert, send);
      list.appendChild(row);
    });

    details.appendChild(list);
    els.list.appendChild(details);
  });
}

defineWidget({
  id: 'prompts',
  titleKey: 'prompts.title',
  template: 'w-prompts',
  mount(root) {
    els = { list: root.querySelector('#prompts') };

    // Delegated: paste the prompt into the session (bracketed paste).
    els.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.prompt-btn, .prompt-send');
      if (!btn) return;
      const text = promptIndex.get(btn.dataset.key);
      if (typeof text !== 'string') return;
      window.lunacore.pastePrompt(text, btn.dataset.act === 'send');
      pulse(btn);
      term.focus();
    });

    // Titles, notes, labels AND the prompt bodies themselves are localized, so a
    // language switch has to rebuild the index, not just the labels.
    const offLang = onLangChange(renderPrompts);

    renderPrompts();

    return () => {
      offLang();
      els = null;
    };
  },
});
