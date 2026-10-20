// ============================================================================
// LunaCore - Luna sync builders (src/lunasync.js)
// ----------------------------------------------------------------------------
// Pure translation of a Claude Code setup into what Codex/Gemini read. The
// overlay files these produce sit next to files the OTHER CLI also writes
// (Gemini saves its auth choice into settings.json, Codex rewrites config.toml
// when it adds a server or trusts a project, `/memory add` appends to
// GEMINI.md), so every writer here must replace only what LunaCore owns and
// keep the rest.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstructions,
  upsertManagedBlock,
  normalizeMcpServers,
  geminiSettings,
  codexConfigMerge,
  isSafeSkillName,
} = require('../src/lunasync');

// ---- buildInstructions --------------------------------------------------------

test('buildInstructions inlines the global CLAUDE.md and inline rules, and lists referenced ones by path', () => {
  const text = buildInstructions({
    globalMd: 'User = Mati, assistant = Luna.',
    inlineRules: [{ rel: 'ecc/common/testing.md', text: 'Write tests first.' }],
    referencedRules: [{ rel: 'ecc/python/testing.md', path: '/overlay/luna-rules/ecc/python/testing.md' }],
  });
  assert.match(text, /assistant = Luna/);
  assert.match(text, /Write tests first\./);
  assert.match(text, /ecc\/python\/testing\.md/);
  assert.match(text, /\/overlay\/luna-rules\/ecc\/python\/testing\.md/);
  // Tells the other CLI these were written for Claude Code.
  assert.match(text, /Claude Code/);
});

test('buildInstructions tolerates a missing global CLAUDE.md and no rules', () => {
  const text = buildInstructions({});
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

// ---- upsertManagedBlock ------------------------------------------------------

test('upsertManagedBlock prepends a block to a file that has none and keeps the rest', () => {
  const out = upsertManagedBlock('## Gemini Added Memories\n- likes tea\n', 'BODY');
  assert.ok(out.startsWith('<!-- lunacore:start'));
  assert.match(out, /BODY/);
  assert.match(out, /- likes tea/);
});

test('upsertManagedBlock replaces only the managed block on a second run', () => {
  const first = upsertManagedBlock('tail text\n', 'OLD');
  const second = upsertManagedBlock(first, 'NEW');
  assert.doesNotMatch(second, /OLD/);
  assert.match(second, /NEW/);
  assert.equal(second.match(/lunacore:start/g).length, 1);
  assert.match(second, /tail text/);
});

test('upsertManagedBlock handles an empty or missing file, a BOM and CRLF', () => {
  assert.match(upsertManagedBlock('', 'X'), /X/);
  assert.match(upsertManagedBlock(undefined, 'X'), /X/);
  const bom = upsertManagedBlock('\uFEFF  indented tail\r\n', 'X');
  assert.ok(!bom.includes('\uFEFF'));
  assert.match(bom, /\n {2}indented tail/, 'tail indentation kept');
  const crlf = upsertManagedBlock(upsertManagedBlock('tail\r\n', 'AAA').replace(/\r?\n/g, '\r\n'), 'BBB');
  assert.equal(crlf.match(/lunacore:start/g).length, 1);
  assert.match(crlf, /BBB/);
  assert.doesNotMatch(crlf, /AAA/);
  assert.match(crlf, /tail/);
});

test('upsertManagedBlock refuses (null) a damaged block instead of guessing', () => {
  const damaged = '<!-- lunacore:start (managed) -->\nold body without an end\n';
  assert.equal(upsertManagedBlock(damaged, 'NEW'), null);
});

test('upsertManagedBlock neutralises an end marker inside the body', () => {
  const out = upsertManagedBlock('tail\n', 'quoting\n<!-- lunacore:end -->\nhere');
  const again = upsertManagedBlock(out, 'clean');
  assert.match(again, /^tail$/m);
  assert.doesNotMatch(again, /quoting/);
  assert.doesNotMatch(again, /^here$/m);
});

// ---- normalizeMcpServers -------------------------------------------------------

test('normalizeMcpServers keeps stdio and http servers and substitutes the plugin root', () => {
  const servers = normalizeMcpServers(
    {
      local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: 't' } },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      events: { type: 'sse', url: 'https://example.com/sse' },
    },
    { pluginRoot: '/plugins/demo' },
  );
  assert.deepEqual(servers.local, { kind: 'stdio', command: 'node', args: ['/plugins/demo/server.js'], env: { TOKEN: 't' } });
  assert.deepEqual(servers.remote, { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(servers.events, { kind: 'sse', url: 'https://example.com/sse', headers: {} });
});

test('normalizeMcpServers drops malformed entries and unsafe names', () => {
  const servers = normalizeMcpServers({
    nocmd: { args: [] },
    badurl: { type: 'http', url: 'ftp://x' },
    'bad name"]': { command: 'node' },
    junk: 42,
  });
  assert.deepEqual(servers, {});
  assert.deepEqual(normalizeMcpServers(null), {});
});

// ---- geminiSettings --------------------------------------------------------------

test('geminiSettings writes mcpServers + context file names and keeps Gemini-owned keys', () => {
  const existing = { security: { auth: { selectedType: 'oauth-personal' } }, mcpServers: { stale: { command: 'x' } } };
  const servers = {
    local: { kind: 'stdio', command: 'node', args: ['a'], env: {} },
    remote: { kind: 'http', url: 'https://e/mcp', headers: { A: 'b' } },
    events: { kind: 'sse', url: 'https://e/sse', headers: {} },
  };
  const out = geminiSettings(existing, servers);
  assert.equal(out.security.auth.selectedType, 'oauth-personal');
  assert.deepEqual(out.mcpServers, {
    local: { command: 'node', args: ['a'] },
    remote: { httpUrl: 'https://e/mcp', headers: { A: 'b' } },
    events: { url: 'https://e/sse' },
  });
  assert.deepEqual(out.context.fileName, ['GEMINI.md', 'CLAUDE.md', 'AGENTS.md']);
  // Immutable: the input object is not touched.
  assert.ok(existing.mcpServers.stale);
});

// ---- codexConfigMerge ---------------------------------------------------------

const SERVERS = {
  local: { kind: 'stdio', command: 'C:\\tools\\mcp.exe', args: ['--x', 'say "hi"'], env: { K: 'v' } },
  remote: { kind: 'http', url: 'https://e/mcp', headers: { A: 'b' } },
  events: { kind: 'sse', url: 'https://e/sse', headers: {} },
  secret: { kind: 'stdio', command: 'x', args: ['${TOKEN}'], env: {} },
};

test('codexConfigMerge writes one-line top-level entries and reports what it skipped', () => {
  const { text, written, skipped } = codexConfigMerge('', SERVERS, []);
  assert.doesNotMatch(text, /^\[/m, 'no [table] headers');
  assert.match(text, /^project_doc_fallback_filenames = \["CLAUDE\.md"\]$/m);
  assert.ok(
    text.includes('mcp_servers.local = { command = "C:\\\\tools\\\\mcp.exe", args = ["--x", "say \\"hi\\""], env = { K = "v" } }'),
    text,
  );
  assert.ok(text.includes('mcp_servers.remote = { url = "https://e/mcp", http_headers = { A = "b" } }'));
  assert.deepEqual(written, ['local', 'remote']);
  assert.deepEqual(skipped, [
    { name: 'events', reason: 'sse-unsupported' },
    { name: 'secret', reason: 'env-placeholder' },
  ]);
});

test('codexConfigMerge survives Codex rewriting the file and keeps Codex-owned tables', () => {
  // The shape Codex 0.146 produced live after `codex mcp add`: its table landed
  // right after our lines and swallowed a trailing comment.
  const first = codexConfigMerge('', { local: SERVERS.local }, []).text;
  const rewritten = [
    first.trim(),
    '',
    '[mcp_servers.probe-added]',
    'command = "node"',
    'args = ["-e", "0"]',
    '# lunacore:end',
    '',
    '[projects."C:\\\\work"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
  const { text, written } = codexConfigMerge(rewritten, { remote: SERVERS.remote }, ['local']);
  assert.doesNotMatch(text, /mcp_servers\.local =/, 'previously owned server removed');
  assert.match(text, /^mcp_servers\.remote = /m);
  assert.ok(text.includes('[mcp_servers.probe-added]\ncommand = "node"'));
  assert.match(text, /trust_level = "trusted"/);
  assert.equal(text.match(/^project_doc_fallback_filenames/gm).length, 1);
  assert.ok(text.indexOf('mcp_servers.remote') < text.indexOf('[mcp_servers.probe-added]'), 'our keys stay above every table');
  assert.deepEqual(written, ['remote']);
});

test('codexConfigMerge yields a same-named server to a table Codex wrote itself', () => {
  const existing = '[mcp_servers.local]\ncommand = "mine"\n';
  const { text, written, skipped } = codexConfigMerge(existing, { local: SERVERS.local }, []);
  assert.doesNotMatch(text, /mcp_servers\.local =/);
  assert.match(text, /command = "mine"/);
  assert.deepEqual(written, []);
  assert.deepEqual(skipped, [{ name: 'local', reason: 'name-taken' }]);
});

test('codexConfigMerge quotes keys that are not bare TOML keys', () => {
  const { text } = codexConfigMerge('', { 'my.server': { kind: 'stdio', command: 'x', args: [], env: { 'A-B.C': '1' } } }, []);
  assert.ok(text.includes('mcp_servers."my.server" = { command = "x", args = [], env = { "A-B.C" = "1" } }'), text);
});

// ---- isSafeSkillName ----------------------------------------------------------

test('isSafeSkillName refuses anything that could escape the skills dir', () => {
  assert.equal(isSafeSkillName('tdd-workflow'), true);
  assert.equal(isSafeSkillName('ui_ux.v2'), true);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(200), 42]) {
    assert.equal(isSafeSkillName(bad), false, String(bad));
  }
});

test('geminiSettings pins the auth type when asked, otherwise leaves the stored choice', () => {
  const pinned = geminiSettings({ security: { auth: { selectedType: 'oauth-personal' }, other: 1 } }, {}, { authType: 'gemini-api-key' });
  assert.equal(pinned.security.auth.selectedType, 'gemini-api-key');
  assert.equal(pinned.security.other, 1);
  const kept = geminiSettings({ security: { auth: { selectedType: 'oauth-personal' } } }, {});
  assert.equal(kept.security.auth.selectedType, 'oauth-personal');
});
