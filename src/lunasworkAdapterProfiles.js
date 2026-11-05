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
//   unity     {adapter, unityMcpUrl, scene?, readyTimeoutSec, checkCommand}
//             unityMcpUrl = the editor's MCP server (loopback http only);
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

const DEFAULT_UNITY_MCP_URL = 'http://127.0.0.1:8080/mcp';
const MAX_URL_CHARS = 500;
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
 * @param {unknown} raw
 * @returns {{profile:{adapter:'unity', unityMcpUrl:string, scene?:string, readyTimeoutSec:number, checkCommand:string}|null, reason:string|null}}
 */
function validateUnityProfile(raw) {
  if (!isObj(raw)) return invalid('profile must be an object');
  if (raw.adapter !== 'unity') return invalid(`profile adapter is '${String(raw.adapter)}', not 'unity'`);
  const url = raw.unityMcpUrl === undefined ? DEFAULT_UNITY_MCP_URL : raw.unityMcpUrl;
  if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !isLoopbackHttpUrl(url.trim())) {
    return invalid('unityMcpUrl must be an http URL on 127.0.0.1 or localhost');
  }
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
    profile: { adapter: 'unity', unityMcpUrl: url.trim(), ...(scene ? { scene } : {}), ...common.fields },
    reason: null,
  };
}

module.exports = {
  DEFAULT_UNITY_MCP_URL,
  validateElectronProfile,
  validateUnityProfile,
};
