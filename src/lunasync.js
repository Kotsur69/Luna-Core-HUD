// ============================================================================
// LunaCore - Luna sync: Claude setup -> Codex/Gemini overlay (pure builders)
// ----------------------------------------------------------------------------
// docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md, S2. A Codex/Gemini tab with "Use my Luna
// setup" on runs against an overlay home LunaCore owns (CODEX_HOME /
// GEMINI_CLI_HOME) - the user's own ~/.codex and ~/.gemini are never written.
// This module only TRANSLATES; src/lunasyncio.js reads the sources and writes
// the overlay.
//
// The overlay files are shared with the other CLI, which writes them too
// (Gemini stores its auth choice in settings.json, Codex appends project trust
// to config.toml, `/memory add` appends to GEMINI.md). So every builder here
// replaces only what LunaCore owns: a marked block in text files, and the
// `mcpServers`/`context.fileName` keys in Gemini's JSON.
// ============================================================================

'use strict';

/** A skill folder name we are willing to create inside an overlay skills dir. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** MCP server names, same charset - they become TOML/JSON keys. */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** TOML bare keys; anything else gets quoted. */
const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Context file names Gemini should pick up, in the overlay home AND in projects. */
const GEMINI_CONTEXT_FILES = ['GEMINI.md', 'CLAUDE.md', 'AGENTS.md'];

const MD_START = '<!-- lunacore:start (managed by LunaCore Luna sync - edits here are overwritten) -->';
const MD_END = '<!-- lunacore:end -->';
/** Line-anchored marker matches, so a marker quoted mid-line in user text never counts. */
const MD_START_RE = /^<!-- lunacore:start\b.*$/m;
const MD_END_RE = /^<!-- lunacore:end -->[ \t]*$/m;

/** Heading comment over LunaCore's lines in config.toml. Codex rewrites the
 *  file and re-attaches comments (verified live, plan S2 review), so TOML
 *  ownership is tracked by server NAME, never by a start/end comment pair. */
const TOML_HEADER = '# lunacore: the lines below up to the first [table] are managed by LunaCore Luna sync';
const TOML_OWNED_COMMENT_RE = /^# lunacore[:\s]/;
const TOML_FALLBACK_KEY_RE = /^project_doc_fallback_filenames\s*=/;

const INSTRUCTIONS_HEADER = [
  '# Luna setup',
  '',
  'Synced by LunaCore from the user\'s Claude Code setup (~/.claude). These',
  'instructions were written for Claude Code: where they name Claude Code tools',
  '(Read, Edit, Bash, Agent/subagents, slash commands, hooks), use your own',
  'equivalent tool or skip the step. Everything else applies to you as written,',
  'including who you are and how to address the user.',
].join('\n');

/** True for a folder name that cannot escape the skills dir it is created in. */
function isSafeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name) && !/^\.+$/.test(name);
}

/**
 * The instructions file (Gemini GEMINI.md / Codex AGENTS.md) body.
 * @param {{globalMd?:string, inlineRules?:Array<{rel:string,text:string}>,
 *   referencedRules?:Array<{rel:string,path:string}>}} input
 * @returns {string}
 */
function buildInstructions({ globalMd = '', inlineRules = [], referencedRules = [] } = {}) {
  const parts = [INSTRUCTIONS_HEADER];
  if (typeof globalMd === 'string' && globalMd.trim()) {
    parts.push('## Global instructions (~/.claude/CLAUDE.md)', globalMd.trim());
  }
  for (const rule of inlineRules) {
    if (rule && typeof rule.text === 'string' && rule.text.trim()) {
      parts.push(`## Rule: ${rule.rel}`, rule.text.trim());
    }
  }
  const refs = referencedRules.filter((r) => r && typeof r.path === 'string');
  if (refs.length) {
    parts.push(
      '## More rules (read the file before working in that area)',
      refs.map((r) => `- ${r.rel}: ${r.path}`).join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/** Drops a leading UTF-8 BOM (Windows editors add one; mid-file it breaks parsers). */
function stripBom(text) {
  return typeof text === 'string' ? text.replace(/^﻿/, '') : '';
}

/**
 * Puts `body` inside LunaCore's marked block at the top of a Markdown file,
 * replacing a previous block and keeping everything outside it (e.g. Gemini's
 * `/memory add` section). Null when the file has a start marker without an
 * end marker - someone edited the block, and guessing where it ends could
 * delete their text, so the caller must refuse to write.
 * @param {string|undefined} existing current file content
 * @param {string} body
 * @returns {string|null}
 */
function upsertManagedBlock(existing, body) {
  // An end marker quoted inside the body would cut the block short next run.
  const safeBody = body.replace(/\s+$/, '').split('lunacore:end').join('lunacore-end');
  const block = `${MD_START}\n${safeBody}\n${MD_END}\n`;
  const text = stripBom(existing);
  const start = MD_START_RE.exec(text);
  if (!start) {
    return text.trim() ? `${block}\n${text.replace(/^(?:\r?\n)+/, '')}` : block;
  }
  MD_END_RE.lastIndex = 0;
  const afterStart = text.slice(start.index);
  const end = MD_END_RE.exec(afterStart);
  if (!end) return null;
  const rest = (text.slice(0, start.index) + afterStart.slice(end.index + end[0].length)).replace(/^(?:\r?\n)+/, '');
  return rest ? `${block}\n${rest}` : block;
}

/** String-valued entries of a plain object, or {}. */
function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
}

/** One Claude MCP server entry -> our neutral shape, or null. */
function normalizeServer(raw, pluginRoot) {
  if (!raw || typeof raw !== 'object') return null;
  const sub = (s) => (pluginRoot ? s.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot) : s);
  const type = typeof raw.type === 'string' ? raw.type : raw.url ? 'http' : 'stdio';
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return null;
    const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string').map(sub) : [];
    const env = Object.fromEntries(Object.entries(stringMap(raw.env)).map(([k, v]) => [k, sub(v)]));
    return { kind: 'stdio', command: sub(raw.command), args, env };
  }
  if (type === 'http' || type === 'sse') {
    if (typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url)) return null;
    return { kind: type, url: raw.url, headers: stringMap(raw.headers) };
  }
  return null;
}

/**
 * Claude's `mcpServers` map (~/.claude.json or a plugin's .mcp.json) -> a
 * validated map of `{kind:'stdio',command,args,env}` / `{kind:'http'|'sse',url,headers}`.
 * @param {unknown} raw
 * @param {{pluginRoot?:string}} [opts] substitutes ${CLAUDE_PLUGIN_ROOT}
 * @returns {Object<string,Object>}
 */
function normalizeMcpServers(raw, { pluginRoot } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!SERVER_NAME_RE.test(name)) continue;
    const server = normalizeServer(entry, pluginRoot);
    if (server) out[name] = server;
  }
  return out;
}

/** One neutral server -> Gemini settings.json shape. */
function toGeminiServer(server) {
  if (server.kind === 'stdio') {
    return {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length ? { env: server.env } : {}),
    };
  }
  const headers = Object.keys(server.headers).length ? { headers: server.headers } : {};
  return server.kind === 'http' ? { httpUrl: server.url, ...headers } : { url: server.url, ...headers };
}

/**
 * A new Gemini settings object: LunaCore's mcpServers and context file names
 * on top of whatever Gemini itself stored there (auth choice, UI prefs).
 * @param {Object|null} existing parsed overlay settings.json
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @param {{authType?:string}} [opts] pins security.auth.selectedType - a
 *   gateway home must use its API key; Gemini ignores GEMINI_DEFAULT_AUTH_TYPE
 *   and even a system-level enforcedType once a home has a saved choice
 *   (verified live, plan S1)
 * @returns {Object}
 */
function geminiSettings(existing, servers, { authType } = {}) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const context = base.context && typeof base.context === 'object' ? base.context : {};
  const security = base.security && typeof base.security === 'object' ? base.security : {};
  const auth = security.auth && typeof security.auth === 'object' ? security.auth : {};
  return {
    ...base,
    ...(authType ? { security: { ...security, auth: { ...auth, selectedType: authType } } } : {}),
    context: { ...context, fileName: [...GEMINI_CONTEXT_FILES] },
    mcpServers: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, toGeminiServer(s)])),
  };
}

/** A TOML basic string. */
function tomlString(value) {
  const escaped = String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '"') return '\\"';
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

function tomlKey(key) {
  return TOML_BARE_KEY_RE.test(key) ? key : tomlString(key);
}

function tomlInlineTable(map) {
  const entries = Object.entries(map).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return entries.length ? `{ ${entries.join(', ')} }` : '{}';
}

function tomlArray(items) {
  return `[${items.map(tomlString).join(', ')}]`;
}

/** A value that is exactly one `${NAME}` placeholder (no default, nothing around it). */
const WHOLE_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_PLACEHOLDER_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const hasPlaceholder = (v) => typeof v === 'string' && v.includes('${');

/**
 * Splits a map into literal entries and the ones Codex can read from the tab's
 * own environment instead. Codex has no `${VAR}` expansion, but it can pass a
 * named env var through (`env_vars`, `env_http_headers`, `bearer_token_env_var`),
 * so a secret the source keeps as a placeholder never lands in config.toml.
 */
function splitPlaceholders(map, match) {
  const literal = {};
  const fromEnv = {};
  let unsupported = false;
  for (const [key, value] of Object.entries(map)) {
    const name = match(key, value);
    if (name) fromEnv[key] = name;
    else if (hasPlaceholder(value)) unsupported = true;
    else literal[key] = value;
  }
  return { literal, fromEnv, unsupported };
}

/** `KEY: "${KEY}"` = pass the tab's own KEY through; a renamed var cannot be expressed in Codex. */
function passThroughEnvName(key, value) {
  const m = WHOLE_PLACEHOLDER_RE.exec(value);
  return m && m[1] === key ? key : null;
}

function codexStdioEntry(server) {
  if ([server.command, ...server.args].some(hasPlaceholder)) return { reason: 'env-placeholder' };
  const env = splitPlaceholders(server.env, passThroughEnvName);
  if (env.unsupported) return { reason: 'env-placeholder' };
  const literal = Object.keys(env.literal).length ? `, env = ${tomlInlineTable(env.literal)}` : '';
  const passed = Object.keys(env.fromEnv);
  const envVars = passed.length ? `, env_vars = ${tomlArray(passed)}` : '';
  return { table: `{ command = ${tomlString(server.command)}, args = ${tomlArray(server.args)}${literal}${envVars} }` };
}

function codexHttpEntry(server) {
  if (hasPlaceholder(server.url)) return { reason: 'env-placeholder' };
  let bearer = null;
  const headers = splitPlaceholders(server.headers, (key, value) => {
    const auth = key.toLowerCase() === 'authorization' ? BEARER_PLACEHOLDER_RE.exec(value) : null;
    if (auth) {
      bearer = auth[1];
      return auth[1];
    }
    const m = WHOLE_PLACEHOLDER_RE.exec(value);
    return m ? m[1] : null;
  });
  if (headers.unsupported) return { reason: 'env-placeholder' };
  const fromEnv = Object.fromEntries(Object.entries(headers.fromEnv).filter(([key]) => !(bearer && key.toLowerCase() === 'authorization')));
  const parts = [`url = ${tomlString(server.url)}`];
  if (bearer) parts.push(`bearer_token_env_var = ${tomlString(bearer)}`);
  if (Object.keys(headers.literal).length) parts.push(`http_headers = ${tomlInlineTable(headers.literal)}`);
  if (Object.keys(fromEnv).length) parts.push(`env_http_headers = ${tomlInlineTable(fromEnv)}`);
  return { table: `{ ${parts.join(', ')} }` };
}

/**
 * One neutral server -> `{table}` (a Codex inline table) or `{reason}` when
 * Codex cannot run it as the source describes it (no SSE; a `${VAR}` Codex
 * cannot read from the environment by name).
 */
function codexServerEntry(server) {
  if (server.kind === 'stdio') return codexStdioEntry(server);
  if (server.kind === 'http') return codexHttpEntry(server);
  return { reason: 'sse-unsupported' };
}

/**
 * `mcp_servers.<name> = {...}` lines for the servers Codex can run.
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @param {Set<string>} [taken] names that must not be written (a table Codex owns)
 * @returns {{lines:string[], written:string[], skipped:Array<{name:string, reason:string}>}}
 */
function codexServerLines(servers, taken = new Set()) {
  const lines = [];
  const written = [];
  const skipped = [];
  for (const [name, server] of Object.entries(servers)) {
    const entry = codexServerEntry(server);
    if (entry.reason) skipped.push({ name, reason: entry.reason });
    else if (taken.has(name)) skipped.push({ name, reason: 'name-taken' });
    else {
      lines.push(`mcp_servers.${tomlKey(name)} = ${entry.table}`);
      written.push(name);
    }
  }
  return { lines, written, skipped };
}

/** Escapes a string for use inside a RegExp. */
function reEscape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a top-level `mcp_servers.<name> = ...` line for one server name (bare or quoted key). */
function ownedServerLineRe(name) {
  return new RegExp(`^mcp_servers\\.(?:${reEscape(name)}|"${reEscape(name)}")\\s*=`);
}

/** Names of `[mcp_servers.<name>]` tables Codex (or the user) wrote into the file. */
function codexTableServers(lines) {
  const names = new Set();
  for (const line of lines) {
    const m = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/.exec(line.trim());
    if (m) names.add(m[1] || m[2]);
  }
  return names;
}

/**
 * Merges LunaCore's entries into the overlay's config.toml. Everything LunaCore
 * writes is ONE top-level line (`project_doc_fallback_filenames`, dotted
 * `mcp_servers.<name> = {...}`), placed above the first `[table]`, so a
 * top-level key can never land inside a Codex table. Ownership is by NAME
 * (`ownedNames` = what the previous sync wrote): those lines are removed and
 * re-emitted; every other line - Codex's own `[mcp_servers.x]` tables, project
 * trust - is kept as-is. A server whose name Codex already has as a table
 * yields to it.
 * @param {string|undefined} existing current config.toml
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @param {string[]} ownedNames server names the previous sync wrote
 * @returns {{text:string, written:string[], skipped:Array<{name:string, reason:string}>}}
 */
function codexConfigMerge(existing, servers, ownedNames) {
  const lines = stripBom(existing).split(/\r?\n/);
  const removable = [...new Set([...(ownedNames || []), ...Object.keys(servers)])].map(ownedServerLineRe);
  const kept = lines.filter(
    (line) => !TOML_OWNED_COMMENT_RE.test(line) && !TOML_FALLBACK_KEY_RE.test(line) && !removable.some((re) => re.test(line)),
  );
  const taken = codexTableServers(kept);

  const { lines: serverLines, written, skipped } = codexServerLines(servers, taken);
  const ours = [TOML_HEADER, 'project_doc_fallback_filenames = ["CLAUDE.md"]', ...serverLines];
  const rest = kept.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return { text: `${ours.join('\n')}\n${rest ? `\n${rest}\n` : ''}`, written, skipped };
}

/**
 * A whole Codex profile file (`<CODEX_HOME>/<name>.config.toml`, layered by
 * `codex --profile <name>`) holding one project's servers. Codex merges its
 * `mcp_servers` by name over config.toml's, the profile winning - the same
 * precedence Claude gives a project server over a user one (verified live,
 * Codex 0.146). The file is LunaCore's alone, so it is rewritten whole.
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @returns {{text:string, written:string[], skipped:Array<{name:string, reason:string}>}}
 */
function codexProfileText(servers) {
  const { lines, written, skipped } = codexServerLines(servers);
  const header = '# lunacore: this whole file is managed by LunaCore Luna sync (project MCP servers) - edits here are overwritten';
  return { text: `${[header, ...lines].join('\n')}\n`, written, skipped };
}

/**
 * A Gemini extension manifest (`gemini-extension.json`) carrying one project's
 * servers. Gemini expands `${VAR}` in extension configs from the environment
 * itself, so placeholders are copied as-is and no secret is resolved here.
 * @param {string} name extension (and folder) name
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @returns {Object}
 */
function geminiProjectExtension(name, servers) {
  return {
    name,
    version: '1.0.0',
    description: 'Project MCP servers synced by LunaCore from the Claude Code setup - managed, edits are overwritten',
    mcpServers: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, toGeminiServer(s)])),
  };
}

/** A folder as Gemini's enablement rules spell it: forward slashes, leading and trailing `/` (0.60 loader). */
function geminiRulePath(dir) {
  let rule = String(dir).replace(/\\/g, '/');
  if (!rule.startsWith('/')) rule = `/${rule}`;
  return rule.endsWith('/') ? rule : `${rule}/`;
}

/**
 * Gemini's extension-enablement.json with one extension switched on for one
 * folder only: `!/*` disables it everywhere, the folder rule (last match wins)
 * enables it there. Rules are matched case-sensitively, so a Windows drive
 * letter gets both spellings. Every other entry - Gemini's own - is kept.
 * @param {Object|null} existing parsed extension-enablement.json
 * @param {string} name LunaCore's extension
 * @param {string|null} projectDir null removes LunaCore's entry
 * @returns {Object}
 */
function geminiExtensionEnablement(existing, name, projectDir) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const { [name]: _previous, ...rest } = base;
  if (!projectDir) return rest;
  const rule = geminiRulePath(projectDir);
  const drive = /^\/([A-Za-z]):/.exec(rule);
  const spellings = drive
    ? [...new Set([`/${drive[1].toUpperCase()}${rule.slice(2)}`, `/${drive[1].toLowerCase()}${rule.slice(2)}`])]
    : [rule];
  return { ...rest, [name]: { overrides: ['!/*', ...spellings] } };
}

module.exports = {
  buildInstructions,
  upsertManagedBlock,
  normalizeMcpServers,
  geminiSettings,
  codexConfigMerge,
  codexProfileText,
  geminiProjectExtension,
  geminiExtensionEnablement,
  isSafeSkillName,
  stripBom,
  GEMINI_CONTEXT_FILES,
};
