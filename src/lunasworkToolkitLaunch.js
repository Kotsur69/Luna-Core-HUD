// ============================================================================
// LunaCore - Luna's Work tool kit, launch side (src/lunasworkToolkit.js is the
// pure half)
// ----------------------------------------------------------------------------
// createToolsFor(deps) -> toolsFor({projectId, repoPath, role, capped})
//
// What one God Mode worker of a Luna's Work build is started with, from the
// project's kit (lunasworkSettings.toolkitFor) and the PC's toolServers:
//
//   mcpConfigPath     a --mcp-config file with the kit's servers that have a
//                     launch definition (null when there are none). The file
//                     never holds a secret: env / headers carry only ${VAR}
//                     references (checked again before the write), so a key
//                     reaches the server from LunaCore's environment
//   allowedTools      the kit's MCP servers, CLIs and built-ins
//   disallowedTools   the guardrails (no force-push / history rewrite, no
//                     writes in ~/.claude, ~/.ssh, ...) and every tool out of
//                     the kit or past its spend cap
//   addDirs           the kit's art folders
//   note              the lines the worker's brief gets
//
// Never throws: a failure is logged and the worker gets no kit extras (the
// guard rules still come with a result whenever the kit could be read).
// ============================================================================

'use strict';

const crypto = require('crypto');
const path = require('path');
const settingsStore = require('./lunasworkSettings');
const { roleLaunch, hasSecretShape } = require('./lunasworkToolkit');

const TOOLS_DIR = 'lunaswork-tools';
const ENV_REF_RE = /^\$\{[A-Z_][A-Z0-9_]{0,63}\}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * True when a server could carry a key in the file: an env / headers value that
 * is not a ${VAR} reference, a URL with a query string, or a key-shaped arg.
 */
function hasLiteralSecret(mcpConfig) {
  const servers = isObj(mcpConfig) && isObj(mcpConfig.mcpServers) ? Object.values(mcpConfig.mcpServers) : [];
  return servers.some((s) => !isObj(s)
    || ['env', 'headers'].some((k) => isObj(s[k]) && Object.values(s[k]).some((v) => typeof v !== 'string' || !ENV_REF_RE.test(v)))
    || (typeof s.url === 'string' && /[?#]/.test(s.url))
    || (Array.isArray(s.args) && s.args.some(hasSecretShape)));
}

/** One file per project and role: the name never carries the project id itself. */
function configFileName(projectId, role) {
  const hash = crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 16);
  return `${role}-${hash}.local.json`;
}

/**
 * @param {{readSettings:()=>object, dir:()=>string, fs?:object, log?:(line:string)=>void}} deps
 *   dir: the folder the --mcp-config files go to (LunaCore's user dir)
 */
function createToolsFor(deps) {
  const fs = deps.fs || require('fs');
  const log = deps.log || (() => {});

  const readOrNull = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null; // missing: written below
    }
  };

  function writeConfig(projectId, role, mcpConfig) {
    if (hasLiteralSecret(mcpConfig)) {
      log(`[lunaswork-tools] ${role}: a server definition holds a literal env / header value - not written`);
      return null;
    }
    try {
      const file = path.join(deps.dir(), TOOLS_DIR, configFileName(projectId, role));
      const body = JSON.stringify(mcpConfig, null, 2);
      if (readOrNull(file) === body) return file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A tab starting right now must never read a half-written file: tmp + rename.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return file;
    } catch (err) {
      log(`[lunaswork-tools] ${role}: --mcp-config not written (${errText(err)})`);
      return null;
    }
  }

  /**
   * @param {{projectId:string, repoPath?:string, role:string, capped?:string[]}} req
   * @returns {null|{role:string, tools:string[], skills:string[], fromClaudeSetup:string[], mcpConfigPath:string|null,
   *   allowedTools:string[], disallowedTools:string[], addDirs:string[], note:string}}
   */
  return function toolsFor(req) {
    try {
      const r = isObj(req) ? req : {};
      const settings = settingsStore.normalizeSettings(deps.readSettings());
      const kit = settingsStore.toolkitFor(settings, r.projectId);
      const launch = roleLaunch(kit, r.role, {
        toolServers: settings.toolServers,
        capped: r.capped,
        repoPath: r.repoPath,
        spendCaps: settingsStore.spendCapsFor(settings, r.projectId),
      });
      if (!launch) return null;
      const servers = Object.keys(launch.mcpConfig.mcpServers);
      const mcpConfigPath = servers.length ? writeConfig(r.projectId, r.role, launch.mcpConfig) : null;
      if (launch.fromClaudeSetup.length) {
        log(`[lunaswork-tools] ${r.role}: ${launch.fromClaudeSetup.join(', ')} come from the Claude setup (no toolServers entry on this PC)`);
      }
      const { mcpConfig: _config, ...rest } = launch;
      return { ...rest, mcpConfigPath };
    } catch (err) {
      log(`[lunaswork-tools] kit not applied: ${errText(err)}`);
      return null;
    }
  };
}

module.exports = { TOOLS_DIR, createToolsFor, configFileName, hasLiteralSecret };
