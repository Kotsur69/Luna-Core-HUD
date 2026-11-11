// ============================================================================
// LunaCore - which projects have memory switched on (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decision 13. Memory is opt-in per
// project: nothing is captured or loaded for a repository until it is switched
// on. The switch is synced, so one decision holds on every PC:
//
//   memory-projects.local.json = {projects: ["github.com/owner/repo", ...]}
//   config-scope unit            memory-on:<project> = {on: true}
//
// Switching a project off deletes its unit (a tombstone, like every delete).
// The memories already stored stay where they are; this list only gates
// capture, the project card and the import.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { projectFromRepoKey } = require('./memoryrecord');

const PREFIX = 'memory-on:';
const MAX_PROJECTS = 500;

const projectOf = (k) => (typeof k === 'string' && k.startsWith(PREFIX) ? projectFromRepoKey(k.slice(PREFIX.length)) : null);

/** The switched-on projects, sorted; throws when the file exists but is unreadable. */
function readEnabledStrict(file) {
  const doc = readDoc(file);
  const list = Array.isArray(doc && doc.projects) ? doc.projects : [];
  return [...new Set(list.map(projectFromRepoKey).filter(Boolean))].sort().slice(0, MAX_PROJECTS);
}

/** The switched-on projects; an unreadable file reads as none (nothing is captured). */
function readEnabled(file) {
  try {
    return readEnabledStrict(file);
  } catch {
    return [];
  }
}

function writeEnabled(file, projects) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ projects }) + '\n');
}

/**
 * Switches memory on or off for one project.
 * @returns {string[]} the list afterwards
 */
function setEnabled(file, project, on) {
  const clean = projectFromRepoKey(project);
  if (!clean) throw new Error('bad-project');
  const rest = readEnabledStrict(file).filter((p) => p !== clean);
  const next = on ? [...rest, clean].sort() : rest;
  writeEnabled(file, next);
  return next;
}

/** The list as a configsync.js provider (scope `config`). */
function createMemoryProjectsProvider(file) {
  return {
    name: 'memory-projects',
    // Canonical keys only: `memory-on:git:host/o/r` would be rewritten on the next read.
    owns: (k) => projectOf(k) !== null && k === PREFIX + projectOf(k),
    valid: (k, v) => (projectOf(k) && k === PREFIX + projectOf(k) && v && v.on === true ? { on: true } : null),
    read(now) {
      const fresh = !fs.existsSync(file);
      const base = fresh ? 0 : Math.floor(Math.min(fs.statSync(file).mtimeMs, now));
      // A missing file is a fresh PC, not "every project switched off".
      return { units: readEnabledStrict(file).map((p) => [PREFIX + p, { on: true }]), base, fresh };
    },
    write(units) {
      writeEnabled(file, units.map(([k]) => projectOf(k)).filter(Boolean).sort());
    },
  };
}

module.exports = { readEnabled, setEnabled, createMemoryProjectsProvider, PREFIX };
