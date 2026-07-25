// ============================================================================
// LunaCore - skill cheatsheet by category (7A)
// ----------------------------------------------------------------------------
// An auto-scan of the skill directories, grouped into categories. Clicking an
// entry copies its name to the clipboard.
// ============================================================================

'use strict';

import { pulse } from './util.js';

const skillsContainer = document.getElementById('skills');
const skillsCount = document.getElementById('skills-count');

export async function initSkills() {
  let data;
  try {
    data = await window.lunacore.getSkills();
  } catch {
    return;
  }
  const categories = (data && data.categories) || [];
  skillsCount.textContent = data && data.total ? `(${data.total})` : '';
  skillsContainer.innerHTML = '';

  for (const cat of categories) {
    const details = document.createElement('details');
    details.className = 'cheat';

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = `${cat.name} · ${cat.skills.length}`;
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'skill-cat';
    for (const s of cat.skills) {
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
}

// Clicking a skill copies its name to the clipboard (to paste / invoke).
skillsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.skill-entry');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.name).catch(() => {});
  pulse(btn);
});
