// ============================================================================
// LunaCore - notification hub: the source groups a user can switch off
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N6 ("per-source on / off - a friend without
// Life turns it off"). Settings (Ctrl+L -> Notification hub) shows one switch
// per GROUP; each group covers one or more collectors (src/hubcollect.js and
// src/hubpeers.js). The choice is stored as hubSources: {group: false} in
// ui.local.json (src/uiprefs.js) - a missing group is on.
//
// Tiny and dependency-free on purpose: uiprefs.js validates against it and
// test/hubsettings.test.js pins the renderer's switch list to it.
// ============================================================================

'use strict';

/** Group -> the collector (source) names it switches. */
const HUB_SOURCE_GROUPS = Object.freeze({
  godmode: Object.freeze(['godmode', 'peers', 'approval']),
  power: Object.freeze(['power', 'planwait']),
  life: Object.freeze(['checkin', 'goals', 'bills', 'weekly']),
  mail: Object.freeze(['mail']),
  accounts: Object.freeze(['cloud', 'google', 'gmail', 'host']),
  todo: Object.freeze(['todo']),
  update: Object.freeze(['update']),
});

const GROUP_NAMES = Object.freeze(Object.keys(HUB_SOURCE_GROUPS));

/** Stored hubSources -> {group: false} for the known groups that are off. */
function cleanHubSources(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const group of GROUP_NAMES) if (raw[group] === false) out[group] = false;
  return out;
}

/** Whether collector `name` runs under the stored hubSources (unknown collectors always run). */
function isCollectorOn(name, hubSources) {
  const off = cleanHubSources(hubSources);
  return !GROUP_NAMES.some((group) => off[group] === false && HUB_SOURCE_GROUPS[group].includes(name));
}

module.exports = { HUB_SOURCE_GROUPS, GROUP_NAMES, cleanHubSources, isCollectorOn };
