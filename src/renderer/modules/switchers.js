// ============================================================================
// LunaCore - profile and project (working directory) switchers
// ----------------------------------------------------------------------------
// Twins: both restart THIS tab with new settings and leave every other session
// untouched. Options come from config/profiles.json and config/projects.json.
//
// A2: two widgets (`profile`, `project`) - each <select> is its own
// .panel__section, and a widget template holds exactly one root, so they
// cannot share a single definition. `currentProfileId` / `currentProjectId`
// track whichever tab is ACTIVE right now (updated by both a user's own
// change and by syncSwitchers() on a tab switch); a remount repaints from
// them, not from `lastProfiles.activeId`, which only ever reflects the config
// file's default and would otherwise reset the pick on every remount.
// ============================================================================

'use strict';

import { getActiveSessionId } from './terminals.js';
import { loc } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// Kept so a language switch (and a remount) relabels the options without
// re-reading config. Labels may be localized ("Sama powloka" / "Bare shell");
// ids never are.
let lastProfiles = null;
let lastProjects = null;

// Whichever tab is active right now - must survive a remount (see header).
let currentProfileId = null;
let currentProjectId = null;

// Elements of the current mount, or null when that widget is not on screen.
let profileEls = null;
let projectEls = null;

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

function renderProfileSwitcher() {
  if (!profileEls || !lastProfiles) return;
  fillSelect(profileEls.select, lastProfiles.items, currentProfileId ?? lastProfiles.activeId);
}

function renderProjectSwitcher() {
  if (!projectEls || !lastProjects) return;
  fillSelect(projectEls.select, lastProjects.items, currentProjectId ?? lastProjects.activeId);
}

export async function initProfiles() {
  try {
    const { profiles, activeProfile } = await window.lunacore.getProfiles();
    lastProfiles = { items: profiles, activeId: activeProfile };
    currentProfileId = activeProfile;
    renderProfileSwitcher();
  } catch (err) {
    // Could not read the profiles - leave the switcher empty (non-blocking).
  }
}

export async function initProjects() {
  try {
    const { projects, activeProject } = await window.lunacore.getProjects();
    lastProjects = { items: projects, activeId: activeProject };
    currentProjectId = activeProject;
    renderProjectSwitcher();
  } catch (err) {
    // Could not read the projects - leave the switcher empty (non-blocking).
  }
}

/** Points both switchers at the ACTIVE tab's values. */
export function syncSwitchers(meta) {
  if (!meta) return;
  if (meta.profileId) {
    currentProfileId = meta.profileId;
    if (profileEls) profileEls.select.value = meta.profileId;
  }
  if (meta.projectId) {
    currentProjectId = meta.projectId;
    if (projectEls) projectEls.select.value = meta.projectId;
  }
}

defineWidget({
  id: 'profile',
  titleKey: 'profile.title',
  template: 'w-profile',
  mount(root) {
    profileEls = { select: root.querySelector('#profile-switcher') };
    renderProfileSwitcher();

    // Profile change -> restart THIS tab; the other sessions are left alone.
    profileEls.select.addEventListener('change', () => {
      currentProfileId = profileEls.select.value;
      window.lunacore.switchProfile(currentProfileId, getActiveSessionId());
    });

    const offLang = onLangChange(renderProfileSwitcher);

    return () => {
      offLang();
      profileEls = null;
    };
  },
});

/**
 * "+" button: native folder picker -> persist to projects.local.json -> pick
 * the new entry in the switcher -> restart THIS tab into it. Disabled for
 * the round trip so a slow dialog/write cannot be double-fired by an
 * impatient second click.
 */
async function addProjectFromDialog(button) {
  if (!window.lunacore || button.disabled) return;
  button.disabled = true;
  try {
    const dir = await window.lunacore.pickProjectFolder();
    if (!dir) return; // cancelled

    const result = await window.lunacore.addProject({ path: dir });
    if (!result) return; // e.g. blank path - should not happen from a real dialog pick

    lastProjects = { items: result.projects, activeId: result.activeProject };
    currentProjectId = result.addedId;
    renderProjectSwitcher();
    window.lunacore.switchProject(result.addedId, getActiveSessionId());
  } finally {
    button.disabled = false;
  }
}

defineWidget({
  id: 'project',
  titleKey: 'project.title',
  template: 'w-project',
  mount(root) {
    projectEls = {
      select: root.querySelector('#project-switcher'),
      addBtn: root.querySelector('#project-add-btn'),
    };
    renderProjectSwitcher();

    // Directory change -> restart the pty in the new folder (same profile).
    projectEls.select.addEventListener('change', () => {
      currentProjectId = projectEls.select.value;
      window.lunacore.switchProject(currentProjectId, getActiveSessionId());
    });

    projectEls.addBtn.addEventListener('click', () => addProjectFromDialog(projectEls.addBtn));

    const offLang = onLangChange(renderProjectSwitcher);

    return () => {
      offLang();
      projectEls = null;
    };
  },
});
