// ============================================================================
// LunaCore - Luna's Work settings (docs/LUNAS_WORK_PLAN.md, slice 1.2b)
// ----------------------------------------------------------------------------
// Per-machine settings in config/lunaswork-settings.local.json (gitignored by
// the config/*.local.* pattern):
//
//   models        global default model per role (lunasworkRules.DEFAULT_MODELS
//                 when unset - the defaults live there, never here)
//   freeFallback  false = on a usage limit the run waits for the reset
//                 (Mati's decision); true = builders and playtester may use the
//                 free providers (orchestraFree.js) while Claude is limited
//   projects      keyed like the to-dos (todo.keyFor): { models, profile }
//                 models  - partial per-role override, merged over the global
//                           models when a run starts
//                 profile - how LunaCore launches the app under test
//
// TRUST BOUNDARY: the project profile (startCommand, checkCommand, url) is only
// ever read from this local file, which only the LunaCore UI writes. It is
// never read from the project repo or from model output, so nothing a model
// writes can change the command LunaCore runs - the same boundary as God
// Mode's planner. Do not add a code path that fills a profile from either.
//
// Contract (same as the other config loaders): a missing or broken file reads
// as defaults, a write returns false on failure, nothing here throws.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { ROLES, MODEL_CHOICES, normalizeModels } = require('./lunasworkRules');
const { keyFor } = require('./todo');

const FILE_NAME = 'lunaswork-settings.local.json';
const defaultFile = () => paths.local(FILE_NAME);

const ADAPTERS = ['web'];
// Planned adapters (plan: "Electron and Unity come after"); rejected until built.
const RESERVED_ADAPTERS = ['electron', 'unity'];
const DEFAULT_ADAPTER = 'web';
const DEFAULT_URL = 'http://localhost:3000';
const DEFAULT_READY_TIMEOUT_SEC = 60;
const MIN_READY_TIMEOUT_SEC = 1;
const MAX_READY_TIMEOUT_SEC = 600;
const MAX_COMMAND_CHARS = 500;
const MAX_URL_CHARS = 500;
const MAX_PROJECTS = 200;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---- project profile ----------------------------------------------------------------

function invalid(reason) {
  return { profile: null, reason };
}

/** @returns {string|null} an error reason, or null when the command is usable */
function commandProblem(cmd, name) {
  if (typeof cmd !== 'string') return `${name} must be a string`;
  if (cmd.length > MAX_COMMAND_CHARS) return `${name} is longer than ${MAX_COMMAND_CHARS} characters`;
  if (CONTROL_CHARS.test(cmd)) return `${name} must be a single line`;
  return null;
}

function urlProblem(url) {
  if (typeof url !== 'string' || !url.trim()) return 'url must be a non-empty string';
  if (url.length > MAX_URL_CHARS) return `url is longer than ${MAX_URL_CHARS} characters`;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'url is not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url must be http or https';
  return null;
}

/**
 * Strict validation of one project profile.
 * @param {unknown} raw
 * @returns {{profile: object|null, reason: string|null}}
 */
function validateProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('profile must be an object');

  const adapter = raw.adapter === undefined ? DEFAULT_ADAPTER : raw.adapter;
  if (RESERVED_ADAPTERS.includes(adapter)) return invalid(`adapter '${adapter}' is not supported yet`);
  if (!ADAPTERS.includes(adapter)) return invalid(`unknown adapter '${String(adapter)}'`);

  const startProblem = commandProblem(raw.startCommand, 'startCommand');
  if (startProblem) return invalid(startProblem);
  const startCommand = raw.startCommand.trim();
  if (!startCommand) return invalid('startCommand must not be empty');

  const url = raw.url === undefined ? DEFAULT_URL : raw.url;
  const badUrl = urlProblem(url);
  if (badUrl) return invalid(badUrl);

  const timeout = raw.readyTimeoutSec === undefined ? DEFAULT_READY_TIMEOUT_SEC : raw.readyTimeoutSec;
  if (!Number.isInteger(timeout) || timeout < MIN_READY_TIMEOUT_SEC || timeout > MAX_READY_TIMEOUT_SEC) {
    return invalid(`readyTimeoutSec must be a whole number from ${MIN_READY_TIMEOUT_SEC} to ${MAX_READY_TIMEOUT_SEC}`);
  }

  const check = raw.checkCommand === undefined ? '' : raw.checkCommand;
  const checkProblem = commandProblem(check, 'checkCommand');
  if (checkProblem) return invalid(checkProblem);

  return {
    profile: { adapter, startCommand, url: url.trim(), readyTimeoutSec: timeout, checkCommand: check.trim() },
    reason: null,
  };
}

// ---- models -----------------------------------------------------------------------

/** Keeps only known roles with a valid choice - a partial override, never filled in. */
function normalizeModelOverride(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const role of ROLES) {
    if (MODEL_CHOICES.includes(src[role])) out[role] = src[role];
  }
  return out;
}

// ---- whole store ------------------------------------------------------------------

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const models = normalizeModelOverride(raw.models);
  const { profile } = validateProfile(raw.profile);
  const out = {};
  if (Object.keys(models).length) out.models = models;
  if (profile) out.profile = profile;
  return Object.keys(out).length ? out : null;
}

/**
 * @param {unknown} raw parsed file content (or anything)
 * @returns {{models: Record<string,string>, freeFallback: boolean, projects: Record<string,object>}}
 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const projects = {};
  const rawProjects = src.projects && typeof src.projects === 'object' ? src.projects : {};
  for (const [key, value] of Object.entries(rawProjects).slice(0, MAX_PROJECTS)) {
    const project = normalizeProject(value);
    // Prototype keys would set the object's prototype instead of an entry.
    if (key && project && !UNSAFE_KEYS.has(key)) projects[key] = project;
  }
  return {
    models: normalizeModels(src.models),
    freeFallback: src.freeFallback === true,
    projects,
  };
}

function defaultSettings() {
  return normalizeSettings({});
}

/** The models a run on `projectId` starts with: project override over the global models. */
function modelsFor(settings, projectId) {
  const s = normalizeSettings(settings);
  const project = s.projects[keyFor(projectId)];
  return normalizeModels({ ...s.models, ...(project && project.models) });
}

/** @returns {object|null} the project's validated profile, null when none is set */
function profileFor(settings, projectId) {
  const project = normalizeSettings(settings).projects[keyFor(projectId)];
  return (project && project.profile) || null;
}

/**
 * Returns new settings with one project's entry replaced (no mutation).
 * A profile that fails validation is reported and nothing changes.
 * @param {object} settings
 * @param {string|null|undefined} projectId
 * @param {{models?: object, profile?: object|null}} patch profile null removes it
 * @returns {{settings: object, reason: string|null}}
 */
function withProject(settings, projectId, patch) {
  const s = normalizeSettings(settings);
  const key = keyFor(projectId);
  const current = s.projects[key] || {};
  const next = { ...current };
  const p = patch && typeof patch === 'object' ? patch : {};

  if (p.models !== undefined) next.models = normalizeModelOverride(p.models);
  if (p.profile === null) {
    delete next.profile;
  } else if (p.profile !== undefined) {
    const { profile, reason } = validateProfile(p.profile);
    if (!profile) return { settings: s, reason };
    next.profile = profile;
  }
  return { settings: normalizeSettings({ ...s, projects: { ...s.projects, [key]: next } }), reason: null };
}

// ---- disk -------------------------------------------------------------------------

/** Reads the settings; defaults when the file is missing or broken. Never throws. */
function readSettings(filePath = defaultFile()) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return defaultSettings();
  }
}

/** Validates and writes the settings. @returns {boolean} whether the write succeeded */
function writeSettings(settings, filePath = defaultFile()) {
  try {
    if (filePath === defaultFile()) paths.ensureUserDir();
    fs.writeFileSync(filePath, JSON.stringify(normalizeSettings(settings), null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ADAPTERS,
  RESERVED_ADAPTERS,
  DEFAULT_URL,
  DEFAULT_READY_TIMEOUT_SEC,
  MIN_READY_TIMEOUT_SEC,
  MAX_READY_TIMEOUT_SEC,
  MAX_COMMAND_CHARS,
  validateProfile,
  normalizeModelOverride,
  normalizeSettings,
  defaultSettings,
  modelsFor,
  profileFor,
  withProject,
  readSettings,
  writeSettings,
};
