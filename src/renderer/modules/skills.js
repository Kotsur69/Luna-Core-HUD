// ============================================================================
// LunaCore - skill cheatsheet by category (7A) + filter box (B7)
// ----------------------------------------------------------------------------
// An auto-scan of the skill directories, grouped into categories. Clicking an
// entry copies its name to the clipboard.
//
// B7: the scan result is kept in memory, so filtering is a local re-render -
// no IPC, no re-scan. A query matches the name AND the description, because
// half of what you remember about a skill is what it does, not its slug.
//
// A2: converted to the widget contract. The state question here is sharper than
// in its two siblings, because the filter query is not a preference - it is
// something you TYPED. A2b's rule is that a disposer cancels effects but commits
// user intent, so the query lives at module scope and the input is restored from
// it on mount; a remount finds the same 12 skills on screen you had narrowed to.
// It also means currentQuery() no longer reads the DOM, which used to make it
// answer "" whenever the box was not on screen.
//
// The <details> open state needs no such treatment: unlike cheatsheets/prompts
// it is derived (`open = Boolean(q)`), not chosen, so it rebuilds itself.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

let allCategories = [];
let total = 0;

/** What the user typed, normalised. Empty string = show everything. */
let query = '';

export async function initSkills() {
  let data;
  try {
    data = await window.lunacore.getSkills();
  } catch {
    return;
  }
  allCategories = (data && data.categories) || [];
  total = (data && data.total) || 0;
  renderSkills();
}

function renderSkills() {
  if (!els) return;
  const q = query;
  els.list.innerHTML = '';
  let shown = 0;

  for (const cat of allCategories) {
    const skills = q
      ? cat.skills.filter((s) => `${s.name} ${s.description || ''}`.toLowerCase().includes(q))
      : cat.skills;
    if (!skills.length) continue; // a category with no hits is not worth a row
    shown += skills.length;

    const details = document.createElement('details');
    details.className = 'cheat';
    // While filtering, every surviving group is open: you asked to see them, and
    // a list of collapsed headers is not an answer.
    details.open = Boolean(q);

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    // cat.id is a language-neutral slug; the label comes from the dictionary.
    summary.textContent = `${t(`skills.cat.${cat.id}`)} · ${skills.length}`;
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'skill-cat';
    for (const s of skills) {
      const item = document.createElement('button');
      item.className = 'skill-entry';
      item.textContent = s.name;
      item.title = s.description || s.name; // full description in the tooltip
      item.dataset.name = s.name;
      list.appendChild(item);
    }
    details.appendChild(list);
    els.list.appendChild(details);
  }

  if (q && shown === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('skills.search.empty');
    els.list.appendChild(empty);
  }

  // The counter doubles as filter feedback: "12/339" says both how much matched
  // and that you are looking at a subset.
  if (!total) els.count.textContent = '';
  else els.count.textContent = q ? `(${shown}/${total})` : `(${total})`;
}

defineWidget({
  id: 'skills',
  titleKey: 'skills.title',
  template: 'w-skills',
  mount(root) {
    els = {
      list: root.querySelector('#skills'),
      count: root.querySelector('#skills-count'),
      search: root.querySelector('#skills-search'),
    };

    if (els.search) {
      // Restore what was typed - see the header. Setting .value fires no input
      // event, so `query` and the box cannot drift apart here.
      els.search.value = query;
      els.search.addEventListener('input', () => {
        query = els.search.value.trim().toLowerCase();
        renderSkills();
      });
      els.search.addEventListener('keydown', (e) => {
        // Escape clears rather than closing anything - there is nothing to close.
        if (e.key === 'Escape' && els.search.value) {
          e.preventDefault();
          e.stopPropagation();
          els.search.value = '';
          query = '';
          renderSkills();
        }
      });
    }

    // Clicking a skill copies its name to the clipboard (to paste / invoke).
    els.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.skill-entry');
      if (!btn) return;
      navigator.clipboard.writeText(btn.dataset.name).catch(() => {});
      pulse(btn);
    });

    // Only the "no matches" line and the category labels are translated, but
    // both have to follow the language.
    const offLang = onLangChange(renderSkills);

    renderSkills();

    return () => {
      offLang();
      els = null;
    };
  },
});
