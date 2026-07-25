// ============================================================================
// LunaCore - skill cheatsheet by category (7A) + filter box (B7)
// ----------------------------------------------------------------------------
// An auto-scan of the skill directories, grouped into categories. Clicking an
// entry copies its name to the clipboard.
//
// B7: the scan result is kept in memory, so filtering is a local re-render -
// no IPC, no re-scan. A query matches the name AND the description, because
// half of what you remember about a skill is what it does, not its slug.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';

const skillsContainer = document.getElementById('skills');
const skillsCount = document.getElementById('skills-count');
const skillsSearch = document.getElementById('skills-search');

let allCategories = [];
let total = 0;

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

/** Current query, normalised. Empty string = show everything. */
function currentQuery() {
  return skillsSearch ? skillsSearch.value.trim().toLowerCase() : '';
}

function renderSkills() {
  const q = currentQuery();
  skillsContainer.innerHTML = '';
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
    summary.textContent = `${cat.name} · ${skills.length}`;
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
    skillsContainer.appendChild(details);
  }

  if (q && shown === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('skills.search.empty');
    skillsContainer.appendChild(empty);
  }

  // The counter doubles as filter feedback: "12/339" says both how much matched
  // and that you are looking at a subset.
  if (!total) skillsCount.textContent = '';
  else skillsCount.textContent = q ? `(${shown}/${total})` : `(${total})`;
}

if (skillsSearch) {
  skillsSearch.addEventListener('input', renderSkills);
  skillsSearch.addEventListener('keydown', (e) => {
    // Escape clears rather than closing anything - there is nothing to close.
    if (e.key === 'Escape' && skillsSearch.value) {
      e.preventDefault();
      e.stopPropagation();
      skillsSearch.value = '';
      renderSkills();
    }
  });
}

// Clicking a skill copies its name to the clipboard (to paste / invoke).
skillsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.skill-entry');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.name).catch(() => {});
  pulse(btn);
});

// Only the "no matches" line is translated, but it has to follow the language.
onLangChange(renderSkills);
