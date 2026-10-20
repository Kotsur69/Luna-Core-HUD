// ============================================================================
// LunaCore - Luna sync: Claude setup -> Codex/Gemini overlay (pure builders)
// ----------------------------------------------------------------------------
// docs/FREE_PROVIDERS_SYNC_PLAN.md, S2. A Codex/Gemini tab with "Use my Luna
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
 * @returns {Object}
 */
function geminiSettings(existing, servers) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const context = base.context && typeof base.context === 'object' ? base.context : {};
  return {
    ...base,
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

/** One neutral server -> a Codex inline table, or null (no SSE in Codex). */
function toCodexServer(server) {
  if (server.kind === 'stdio') {
    const env = Object.keys(server.env).length ? `, env = ${tomlInlineTable(server.env)}` : '';
    return `{ command = ${tomlString(server.command)}, args = ${tomlArray(server.args)}${env} }`;
  }
  if (server.kind === 'http') {
    const headers = Object.keys(server.headers).length ? `, http_headers = ${tomlInlineTable(server.headers)}` : '';
    return `{ url = ${tomlString(server.url)}${headers} }`;
  }
  return null;
}

/** True when any string of a server still carries a `${VAR}` placeholder Codex would pass literally. */
function hasEnvPlaceholder(server) {
  const values = [server.command, server.url, ...(server.args || []), ...Object.values(server.env || {}), ...Object.values(server.headers || {})];
  return values.some((v) => typeof v === 'string' && v.includes('${'));
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

  const ours = [TOML_HEADER, 'project_doc_fallback_filenames = ["CLAUDE.md"]'];
  const written = [];
  const skipped = [];
  for (const [name, server] of Object.entries(servers)) {
    const table = toCodexServer(server);
    if (!table) skipped.push({ name, reason: 'sse-unsupported' });
    else if (hasEnvPlaceholder(server)) skipped.push({ name, reason: 'env-placeholder' });
    else if (taken.has(name)) skipped.push({ name, reason: 'name-taken' });
    else {
      ours.push(`mcp_servers.${tomlKey(name)} = ${table}`);
      written.push(name);
    }
  }
  const rest = kept.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return { text: `${ours.join('\n')}\n${rest ? `\n${rest}\n` : ''}`, written, skipped };
}

module.exports = {
  buildInstructions,
  upsertManagedBlock,
  normalizeMcpServers,
  geminiSettings,
  codexConfigMerge,
  isSafeSkillName,
  stripBom,
  GEMINI_CONTEXT_FILES,
};
