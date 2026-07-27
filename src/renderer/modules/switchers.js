// ============================================================================
// LunaCore - profile and project (working directory) switchers
// ----------------------------------------------------------------------------
// Twins: both restart THIS tab with new settings and leave every other session
// untouched. Options come from config/profiles.json and config/projects.json.
// ============================================================================

'use strict';

import { getActiveSessionId } from './terminals.js';
import { loc } from './util.js';
import { onLangChange } from './bus.js';

const profileSwitcher = document.getElementById('profile-switcher');
const projectSwitcher = document.getElementById('project-switcher');

// Kept so a language switch relabels the options without re-reading config.
// Labels may be localized ("Sama powloka" / "Bare shell"); ids never are.
let lastProfiles = null;
let lastProjects = null;

/** Fills a <select> from a list and marks the active entry. */
function fillSelect(select, items, activeId) {
  select.innerHTML = '';
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = loc(item.label);
    if (item.id === activeId) opt.selected = true;
    select.appendChild(opt);
  }
}

export async function initProfiles() {
  try {
    const { profiles, activeProfile } = await window.lunacore.getProfiles();
    lastProfiles = { items: profiles, activeId: activeProfile };
    fillSelect(profileSwitcher, profiles, activeProfile);
  } catch (err) {
    // Could not read the profiles - leave the switcher empty (non-blocking).
  }
}

export async function initProjects() {
  try {
    const { projects, activeProject } = await window.lunacore.getProjects();
    lastProjects = { items: projects, activeId: activeProject };
    fillSelect(projectSwitcher, projects, activeProject);
  } catch (err) {
    // Could not read the projects - leave the switcher empty (non-blocking).
  }
}

// Relabel on a language change, keeping whatever the user currently has
// selected rather than the value config booted with.
onLangChange(() => {
  if (lastProfiles) fillSelect(profileSwitcher, lastProfiles.items, profileSwitcher.value);
  if (lastProjects) fillSelect(projectSwitcher, lastProjects.items, projectSwitcher.value);
});

/** Points both switchers at the ACTIVE tab's values. */
export function syncSwitchers(meta) {
  if (!meta) return;
  if (meta.profileId) profileSwitcher.value = meta.profileId;
  if (meta.projectId) projectSwitcher.value = meta.projectId;
}

// Profile change -> restart THIS tab; the other sessions are left alone.
profileSwitcher.addEventListener('change', () => {
  window.lunacore.switchProfile(profileSwitcher.value, getActiveSessionId());
});

// Directory change -> restart the pty in the new folder (same profile).
projectSwitcher.addEventListener('change', () => {
  window.lunacore.switchProject(projectSwitcher.value, getActiveSessionId());
});
