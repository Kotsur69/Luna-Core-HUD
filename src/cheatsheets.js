// ============================================================================
// LunaCore - Action cheat-sheets (7C)
// ----------------------------------------------------------------------------
// Loads command groups from config/cheatsheets.json (+ an optional override
// config/cheatsheets.local.json, gitignored). Each group is a collapsible with a
// row of buttons; clicking one sends the command through the Action Injector
// (pty:command).
//
// Convention: a command prefixed with "!" = a shell (bash) command in the Claude
// session; without the prefix it is typed verbatim (slash commands like
// /compact, /code-review).
//
// Validation at the boundary: groups/commands missing required fields are
// rejected. An empty or broken config => an empty list (the panel simply shows
// nothing).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText, mergeKey } = require('./localized');

// The shipped cheat-sheets are read from the bundled directory; the user's
// override lives in the WRITABLE directory and is resolved lazily, since this
// module is required before app.whenReady(). Details in paths.js.
const BASE_FILE = paths.bundled('cheatsheets.json');
const localFile = () => paths.local('cheatsheets.local.json');

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validates a single command. Returns { label, command } or null.
 * `label` may be a string or a { pl, en } object - see src/localized.js.
 * `command` itself is NOT translated: `!npm test` means the same in every language.
 */
function normalizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.command !== 'string' || !c.command) return null;
  const label = hasText(c.label) ? normalizeText(c.label) : c.command;
  return { label, command: c.command };
}

/** Validates a group. Returns { title, note, commands } or null (when there are no commands). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (!hasText(g.title)) return null;
  const commands = Array.isArray(g.commands)
    ? g.commands.map(normalizeCommand).filter(Boolean)
    : [];
  if (commands.length === 0) return null;
  const note = hasText(g.note) ? normalizeText(g.note) : '';
  return { title: normalizeText(g.title), note, commands };
}

/**
 * Loads cheat-sheet groups: base merged with local (local overrides base by
 * title, extra groups are appended at the end).
 * @returns {{groups: Array}}
 */
function loadCheatsheets() {
  const base = readJson(BASE_FILE);
  const local = readJson(localFile());

  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.groups)) return;
    for (const raw of src.groups) {
      const g = normalizeGroup(raw);
      // Keyed through mergeKey(): a localized title is an OBJECT, and objects in
      // a Map compare by identity - every group would look unique and the
      // override from *.local.json would silently stop working.
      if (g) byTitle.set(mergeKey(g.title), g);
    }
  };
  collect(base);
  collect(local);

  return { groups: [...byTitle.values()] };
}

module.exports = { loadCheatsheets };
