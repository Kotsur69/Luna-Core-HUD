// ============================================================================
// LunaCore - Luna's Work project profiles of the electron / unity adapters
// ----------------------------------------------------------------------------
// Same contract and limits as lunasworkSettings.validateProfile (which still
// lists both adapters as reserved): strict validation, {profile, reason},
// never throws. The adapters re-validate with these in start(), exactly as
// the web adapter does with validateProfile.
//
//   electron  {adapter, startCommand, readyTimeoutSec, checkCommand}
//             startCommand starts the app (`npx electron .`, `npm start`);
//             the adapter adds the in-process wrapper to it.
//   unity     {adapter, unityMcpUrl?, unityProjectSubdir?, scene?, readyTimeoutSec, checkCommand}
//             unityMcpUrl absent = the official Unity MCP (com.unity.pipeline),
//             found through the descriptor in the Unity project's Library;
//             set = a legacy MCP for Unity server (loopback http only);
//             unityProjectSubdir = the Unity project's folder inside the repo
//             (relative, no `..`; absent = the repo root);
//             scene = the Assets/... .unity scene to open before play.
//
// TRUST BOUNDARY: like every profile these come only from LunaCore's local
// settings - never from the project repo or from model output.
// ============================================================================

'use strict';

const {
  DEFAULT_READY_TIMEOUT_SEC,
  MIN_READY_TIMEOUT_SEC,
  MAX_READY_TIMEOUT_SEC,
  MAX_COMMAND_CHARS,
} = require('./lunasworkSettings');
const { isLoopbackHttpUrl } = require('../helpers/playtest-bridge/mcp-http');

// No default unityMcpUrl is filled in: a profile without one uses the official Pipeline.
const MAX_URL_CHARS = 500;
const MAX_SUBDIR_CHARS = 260;
const URL_REASON = 'unityMcpUrl must be an http URL on 127.0.0.1 or localhost';
const SUBDIR_REASON = 'unityProjectSubdir must be a relative folder inside the project';
// A project-relative scene: Assets/<folders>/<name>.unity, no `..`.
const SCENE_RE = /^Assets\/(?:[A-Za-z0-9 _.-]+\/)*[A-Za-z0-9 _.-]+\.unity$/;
const MAX_SCENE_CHARS = 260;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (reason) => ({ profile: null, reason });

/** @returns {string|null} an error reason, or null when the command is usable */
function commandProblem(cmd, name) {
  if (typeof cmd !== 'string') return `${name} must be a string`;
  if (cmd.length > MAX_COMMAND_CHARS) return `${name} is longer than ${MAX_COMMAND_CHARS} characters`;
  if (CONTROL_CHARS.test(cmd)) return `${name} must be a single line`;
  return null;
}

/** The fields every adapter shares: readyTimeoutSec and the optional checkCommand. */
function commonFields(raw) {
  const timeout = raw.readyTimeoutSec === undefined ? DEFAULT_READY_TIMEOUT_SEC : raw.readyTimeoutSec;
  if (!Number.isInteger(timeout) || timeout < MIN_READY_TIMEOUT_SEC || timeout > MAX_READY_TIMEOUT_SEC) {
    return { reason: `readyTimeoutSec must be a whole number from ${MIN_READY_TIMEOUT_SEC} to ${MAX_READY_TIMEOUT_SEC}` };
  }
  const check = raw.checkCommand === undefined ? '' : raw.checkCommand;
  const checkProblem = commandProblem(check, 'checkCommand');
  if (checkProblem) return { reason: checkProblem };
  return { fields: { readyTimeoutSec: timeout, checkCommand: check.trim() } };
}

/**
 * @param {unknown} raw
 * @returns {{profile:{adapter:'electron', startCommand:string, readyTimeoutSec:number, checkCommand:string}|null, reason:string|null}}
 */
function validateElectronProfile(raw) {
  if (!isObj(raw)) return invalid('profile must be an object');
  if (raw.adapter !== 'electron') return invalid(`profile adapter is '${String(raw.adapter)}', not 'electron'`);
  const startProblem = commandProblem(raw.startCommand, 'startCommand');
  if (startProblem) return invalid(startProblem);
  const startCommand = raw.startCommand.trim();
  if (!startCommand) return invalid('startCommand must not be empty');
  const common = commonFields(raw);
  if (!common.fields) return invalid(common.reason);
  return { profile: { adapter: 'electron', startCommand, ...common.fields }, reason: null };
}

/**
 * The optional legacy MCP for Unity URL: '' when absent or blank (= Pipeline).
 * @returns {{url?:string, reason?:string}}
 */
function unityUrlField(value) {
  if (value === undefined || value === null) return { url: '' };
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return { reason: URL_REASON };
  const url = value.trim();
  if (url && !isLoopbackHttpUrl(url)) return { reason: URL_REASON };
  return { url };
}

/**
 * The optional Unity project folder inside the repo, normalized to forward
 * slashes without empty or `.` segments: '' when absent or blank (= the repo
 * root). Relative only: no drive, no leading slash, no `..` segment, and no
 * segment ending in a dot or a space - Windows trims those, so `.. ` would
 * act as `..`.
 * @returns {{subdir?:string, reason?:string}}
 */
function unitySubdirField(value) {
  if (value === undefined || value === null) return { subdir: '' };
  if (typeof value !== 'string' || value.length > MAX_SUBDIR_CHARS || CONTROL_CHARS.test(value)) return { reason: SUBDIR_REASON };
  const rel = value.trim().replace(/\\/g, '/');
  if (!rel) return { subdir: '' };
  if (rel.includes(':') || rel.startsWith('/')) return { reason: SUBDIR_REASON };
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p.endsWith('.') || p.endsWith(' '))) return { reason: SUBDIR_REASON };
  return { subdir: parts.join('/') };
}

/**
 * @param {unknown} raw
 * @returns {{profile:{adapter:'unity', unityMcpUrl?:string, unityProjectSubdir?:string, scene?:string, readyTimeoutSec:number, checkCommand:string}|null, reason:string|null}}
 */
function validateUnityProfile(raw) {
  if (!isObj(raw)) return invalid('profile must be an object');
  if (raw.adapter !== 'unity') return invalid(`profile adapter is '${String(raw.adapter)}', not 'unity'`);
  const { url, reason: urlProblem } = unityUrlField(raw.unityMcpUrl);
  if (urlProblem) return invalid(urlProblem);
  const { subdir, reason: subdirProblem } = unitySubdirField(raw.unityProjectSubdir);
  if (subdirProblem) return invalid(subdirProblem);
  let scene;
  if (raw.scene !== undefined && raw.scene !== '') {
    const s = typeof raw.scene === 'string' ? raw.scene.trim().replace(/\\/g, '/') : '';
    if (!s || s.length > MAX_SCENE_CHARS || !SCENE_RE.test(s) || s.split('/').includes('..')) {
      return invalid('scene must be a project path like Assets/Scenes/Main.unity');
    }
    scene = s;
  }
  const common = commonFields(raw);
  if (!common.fields) return invalid(common.reason);
  return {
    profile: {
      adapter: 'unity',
      ...(url ? { unityMcpUrl: url } : {}),
      ...(subdir ? { unityProjectSubdir: subdir } : {}),
      ...(scene ? { scene } : {}),
      ...common.fields,
    },
    reason: null,
  };
}

module.exports = {
  unitySubdirField,
  validateElectronProfile,
  validateUnityProfile,
};
