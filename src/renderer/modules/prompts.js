// ============================================================================
// LunaCore - prompt library (multi-line, pasted)
// ----------------------------------------------------------------------------
// The main button pastes a prompt WITHOUT sending it, so you can still add
// details; the small one pastes and sends immediately.
// ============================================================================

'use strict';

import { pulse } from './util.js';
import { term } from './terminals.js';

const promptsContainer = document.getElementById('prompts');

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
  const groups = (data && data.groups) || [];
  promptsContainer.innerHTML = '';
  promptIndex.clear();

  groups.forEach((group, gi) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    if (gi === 0) details.open = true;

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

    const list = document.createElement('div');
    list.className = 'prompt-list';

    group.prompts.forEach((p, pi) => {
      const key = `${gi}:${pi}`;
      promptIndex.set(key, p.text);

      const row = document.createElement('div');
      row.className = 'prompt-row';

      // Main button: pastes the prompt WITHOUT sending it.
      const insert = document.createElement('button');
      insert.className = 'prompt-btn';
      insert.textContent = p.label;
      insert.title = p.note ? `${p.note}\n\n${p.text}` : p.text;
      insert.dataset.key = key;
      insert.dataset.act = 'insert';

      // Small button: paste and send right away.
      const send = document.createElement('button');
      send.className = 'prompt-send';
      send.textContent = '⏎';
      send.title = 'Paste and send immediately';
      send.dataset.key = key;
      send.dataset.act = 'send';

      row.append(insert, send);
      list.appendChild(row);
    });

    details.appendChild(list);
    promptsContainer.appendChild(details);
  });
}

// Delegated: paste the prompt into the session (bracketed paste).
promptsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.prompt-btn, .prompt-send');
  if (!btn) return;
  const text = promptIndex.get(btn.dataset.key);
  if (typeof text !== 'string') return;
  window.lunacore.pastePrompt(text, btn.dataset.act === 'send');
  pulse(btn);
  term.focus();
});
