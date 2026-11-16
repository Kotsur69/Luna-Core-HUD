// ============================================================================
// LunaCore - the task intake MCP server in Antigravity (`agy`) tabs
// ----------------------------------------------------------------------------
// A `claude` tab gets its intake server (src/intake.js) through
// `--mcp-config <file>`. agy has no such flag: it reads MCP servers only from
// ~/.gemini/config/mcp_config.json (and from plugins), a file the user owns
// and agy's own /mcp panel edits. So an agy tab gets ONE LunaCore-owned entry
// in that file while it runs:
//
//   "lunacore-<sessionId>": { "url": "http://127.0.0.1:<port>/mcp",
//                             "headers": { "Authorization": "Bearer <token>" } }
//
// The entry is a copy of the tab's own `lunacore` server from the per-tab
// config main's prepareIntake already wrote (src/intake.js mcpConfigFor, or a
// God Mode session's scoped one from src/orchestraFollowupsLaunch.js), so the
// token, its scope and its revocation stay exactly what a Claude tab gets;
// the intake server's loopback / Host / Origin / bearer checks are untouched.
// `url` + `headers` are agy's own keys for a Streamable HTTP server
// (confirmed from the mcp_config.json schema built into agy.exe 1.5.9).
//
// Never clobbering the user's file:
//   - a file that is not plain JSON (agy also accepts comments and trailing
//     commas) or not the expected shape is left untouched: the tab simply gets
//     no tools (the to-do widget's ✨ says so);
//   - only our own key changes; every other key and server is written back as
//     it was read (formatting and key order aside);
//   - writes go to a temp file that is renamed over the original, so agy never
//     reads a half-written file;
//   - an entry is removed only while it still carries the token this process
//     wrote, so an older tab's exit never removes a newer launch's entry, nor
//     another LunaCore instance's.
//
// Known limit: the file is global, so every agy session of this OS user sees
// every LunaCore agy tab's entry while those tabs run. The token stops other
// OS users, browsers and stale entries, not processes of the same user - the
// same limit the per-tab config files in the user dir already have. The ✨
// prompt names the tab's own server so the model picks the right one.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SERVER_NAME } = require('./intake');

/** Prefix of every entry LunaCore writes; the rest is the tab's session id. */
const AGY_SERVER_PREFIX = `${SERVER_NAME}-`;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The intake server's own URL shape (src/intake.js url()). */
const INTAKE_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
/** An intake token: 32 random bytes in hex (src/intake.js issueToken). */
const BEARER_RE = /^Bearer [0-9a-f]{64}$/;
/** A bigger agy config is not something LunaCore rewrites. */
const MAX_CONFIG_BYTES = 1024 * 1024;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errCode = (err) => (err && (err.code || err.message)) || 'error';

/** agy's global MCP config file. */
function agyMcpConfigPath(home = os.homedir()) {
  return path.join(home, '.gemini', 'config', 'mcp_config.json');
}

/**
 * The entry name of one tab's server, or null for a session id that is not
 * LunaCore's own shape.
 * @param {unknown} sessionId
 * @returns {string|null}
 */
function agyServerName(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? `${AGY_SERVER_PREFIX}${sessionId}` : null;
}

/**
 * agy's entry for a tab's lunacore server, from the per-tab config file
 * prepareIntake wrote. Validated, because it is copied into a file another
 * program trusts: only a loopback intake URL and an intake bearer token pass.
 * @param {string|null} configPath
 * @param {object} [fsImpl]
 * @returns {{url:string, headers:{Authorization:string}}|null}
 */
function intakeEntryFrom(configPath, fsImpl = fs) {
  if (typeof configPath !== 'string' || !configPath) return null;
  const doc = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  const server = isObj(doc) && isObj(doc.mcpServers) ? doc.mcpServers[SERVER_NAME] : null;
  if (!isObj(server) || typeof server.url !== 'string' || !INTAKE_URL_RE.test(server.url)) return null;
  const auth = isObj(server.headers) ? server.headers.Authorization : null;
  if (typeof auth !== 'string' || !BEARER_RE.test(auth)) return null;
  return { url: server.url, headers: { Authorization: auth } };
}

/**
 * Reads agy's config for a rewrite.
 * @returns {{ok:true, doc:object}|{ok:false, error:string}}
 */
function readAgyConfig(file, fsImpl = fs) {
  let text;
  try {
    const size = fsImpl.statSync(file).size;
    if (size > MAX_CONFIG_BYTES) return { ok: false, error: 'tooLarge' };
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: {} };
    return { ok: false, error: `unreadable (${errCode(err)})` };
  }
  if (!text.trim()) return { ok: true, doc: {} };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // Comments or trailing commas (agy accepts both): rewriting would lose them.
    return { ok: false, error: 'notPlainJson' };
  }
  if (!isObj(doc) || (doc.mcpServers !== undefined && !isObj(doc.mcpServers))) return { ok: false, error: 'unexpectedShape' };
  return { ok: true, doc };
}

/** Writes `doc` through a temp file in the same folder, renamed over `file`. */
function writeAgyConfig(file, doc, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.lunacore-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmp);
    } catch (cleanupErr) {
      // The rename failure below is the error that matters; note the leftover.
      err.message = `${err.message} (temp file left: ${errCode(cleanupErr)})`;
    }
    throw err;
  }
}

/**
 * Adds (or replaces) one tab's entry. Never touches another key.
 * @param {{file:string, sessionId:string, entry:{url:string, headers:object}, fsImpl?:object}} args
 * @returns {{ok:true, name:string}|{ok:false, error:string}}
 */
function addAgyServer({ file, sessionId, entry, fsImpl = fs }) {
  const name = agyServerName(sessionId);
  if (!name) return { ok: false, error: 'badSessionId' };
  const read = readAgyConfig(file, fsImpl);
  if (!read.ok) return read;
  const servers = isObj(read.doc.mcpServers) ? read.doc.mcpServers : {};
  const next = { ...read.doc, mcpServers: { ...servers, [name]: { url: entry.url, headers: { ...entry.headers } } } };
  try {
    writeAgyConfig(file, next, fsImpl);
  } catch (err) {
    return { ok: false, error: `notWritten (${errCode(err)})` };
  }
  return { ok: true, name };
}

/**
 * Removes one tab's entry, only while it still carries `entry`'s token.
 * @param {{file:string, sessionId:string, entry:{headers:{Authorization:string}}, fsImpl?:object}} args
 * @returns {{ok:true, removed:boolean}|{ok:false, error:string}}
 */
function removeAgyServer({ file, sessionId, entry, fsImpl = fs }) {
  const name = agyServerName(sessionId);
  if (!name) return { ok: false, error: 'badSessionId' };
  const read = readAgyConfig(file, fsImpl);
  if (!read.ok) return read;
  const servers = isObj(read.doc.mcpServers) ? read.doc.mcpServers : {};
  const current = servers[name];
  const ours = isObj(current) && isObj(current.headers) && current.headers.Authorization === entry.headers.Authorization;
  if (!ours) return { ok: true, removed: false };
  const { [name]: _gone, ...kept } = servers;
  try {
    writeAgyConfig(file, { ...read.doc, mcpServers: kept }, fsImpl);
  } catch (err) {
    return { ok: false, error: `notWritten (${errCode(err)})` };
  }
  return { ok: true, removed: true };
}

/**
 * main's handle on agy entries: which tab holds which one, so a tab's exit,
 * close or restart and the app's quit remove exactly what was written.
 * Every failure is logged (never the token) and leaves the tab without tools.
 * @param {{file?:string, fsImpl?:object, log?:(line:string) => void}} [opts]
 */
function createAgyIntake({ file = agyMcpConfigPath(), fsImpl = fs, log = () => {} } = {}) {
  /** sessionId -> the entry written for it */
  const written = new Map();

  /**
   * Copies the tab's lunacore server into agy's config.
   * @param {string} sessionId
   * @param {string|null} configPath what prepareIntake returned
   * @returns {string|null} the server's entry name, or null (no tools for this tab)
   */
  function register(sessionId, configPath) {
    unregister(sessionId);
    if (!configPath) return null;
    let entry;
    try {
      entry = intakeEntryFrom(configPath, fsImpl);
    } catch (err) {
      log(`[agy-intake] session ${sessionId}: tab MCP config unreadable (${errCode(err)})`);
      return null;
    }
    if (!entry) {
      log(`[agy-intake] session ${sessionId}: tab MCP config holds no valid lunacore server`);
      return null;
    }
    const res = addAgyServer({ file, sessionId, entry, fsImpl });
    if (!res.ok) {
      log(`[agy-intake] session ${sessionId}: ${file} not updated (${res.error})`);
      return null;
    }
    written.set(sessionId, entry);
    return res.name;
  }

  /** Removes a tab's entry, if this process wrote one. */
  function unregister(sessionId) {
    const entry = written.get(sessionId);
    if (!entry) return;
    written.delete(sessionId);
    const res = removeAgyServer({ file, sessionId, entry, fsImpl });
    if (!res.ok) log(`[agy-intake] session ${sessionId}: entry not removed from ${file} (${res.error})`);
  }

  /** Removes every entry this process wrote (app quit). */
  function unregisterAll() {
    for (const sessionId of [...written.keys()]) unregister(sessionId);
  }

  return { register, unregister, unregisterAll, has: (sessionId) => written.has(sessionId) };
}

module.exports = {
  AGY_SERVER_PREFIX,
  agyMcpConfigPath,
  agyServerName,
  intakeEntryFrom,
  readAgyConfig,
  addAgyServer,
  removeAgyServer,
  createAgyIntake,
};
