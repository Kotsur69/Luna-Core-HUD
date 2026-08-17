// Tests for the pure half of the MCP health panel: reading config into rows,
// mining usage out of transcript lines, and joining the two.
//
// The rule most of these defend: A MENTION IS NOT A CALL. A transcript is full
// of server names that were never invoked - the tool definitions themselves, the
// deferred-tool listing, and documentation that spells the pattern out
// literally. Counting those made every server on a real machine look "used
// today", which is precisely the wrong answer from a panel whose entire job is
// finding the ones nothing uses.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  spawnPlan,
  collectServers,
  normalizeServer,
  parseUsageLine,
  foldUsage,
  mergeUsage,
  classifyIdle,
  FRESH_DAYS,
  IDLE_DAYS,
} = require('../src/mcphealth.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const daysAgo = (n) => NOW - n * DAY;

// ---- normalizeServer --------------------------------------------------------

test('normalizeServer reads a stdio spec', () => {
  const s = normalizeServer('ctx', { command: 'npx', args: ['-y', 'ctx'] }, 'global', '', true);
  assert.equal(s.transport, 'stdio');
  assert.equal(s.command, 'npx');
  assert.deepEqual(s.args, ['-y', 'ctx']);
});

test('normalizeServer treats anything with a url as remote', () => {
  assert.equal(normalizeServer('a', { url: 'https://x/mcp' }, 'global', '', true).transport, 'http');
  assert.equal(
    normalizeServer('b', { type: 'sse', url: 'https://x/sse' }, 'global', '', true).transport,
    'sse'
  );
});

// The one that would leak a credential onto a HUD panel.
test('normalizeServer keeps env KEY NAMES and never their values', () => {
  const s = normalizeServer(
    'replicate',
    { command: 'x', env: { REPLICATE_API_TOKEN: 'r8_supersecret', PORT: '1' } },
    'global',
    '',
    true
  );
  assert.deepEqual(s.envKeys, ['REPLICATE_API_TOKEN', 'PORT']);
  assert.equal(JSON.stringify(s).includes('r8_supersecret'), false);
});

// ---- collectServers ---------------------------------------------------------

test('collectServers reads global and per-project scopes', () => {
  const rows = collectServers({
    mcpServers: { gmail: { command: 'python' } },
    projects: {
      'C:/repos/app': { mcpServers: { postgres: { command: 'npx' } } },
    },
  });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.gmail.scope, 'global');
  assert.equal(byName.postgres.scope, 'project');
  assert.equal(byName.postgres.scopeLabel, 'app');
});

test('collectServers honours both disable lists', () => {
  const rows = collectServers({
    projects: {
      'C:/repos/app': {
        mcpServers: { a: { command: 'x' }, b: { command: 'x' } },
        disabledMcpServers: ['a'],
        disabledMcpjsonServers: ['b'],
      },
    },
  });
  assert.equal(rows.find((r) => r.name === 'a').enabled, false);
  assert.equal(rows.find((r) => r.name === 'b').enabled, false);
});

// A server configured in five projects is still ONE server in the context
// window, and counting it five times would overstate what it costs.
test('collectServers counts a repeated server once, globally scoped', () => {
  const rows = collectServers({
    mcpServers: { ctx: { command: 'npx' } },
    projects: {
      'C:/a': { mcpServers: { ctx: { command: 'npx' } } },
      'C:/b': { mcpServers: { ctx: { command: 'npx' } } },
    },
  });
  assert.equal(rows.filter((r) => r.name === 'ctx').length, 1);
  assert.equal(rows[0].scope, 'global');
});

test('collectServers picks up a repo-committed .mcp.json', () => {
  const rows = collectServers(
    { projects: { 'C:/repos/app': {} } },
    { projectMcpJson: { 'C:/repos/app': { mcpServers: { shared: { command: 'node' } } } } }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'shared');
});

test('collectServers survives junk', () => {
  assert.deepEqual(collectServers(null), []);
  assert.deepEqual(collectServers({ mcpServers: 'nope', projects: 7 }), []);
});

// ---- parseUsageLine ---------------------------------------------------------

test('parseUsageLine reads a real tool_use call', () => {
  const line =
    '{"timestamp":"2026-08-12T09:00:00.000Z","message":{"content":[{"type":"tool_use","name":"mcp__context7__query-docs","input":{}}]}}';
  assert.deepEqual(parseUsageLine(line), {
    names: ['context7'],
    at: Date.parse('2026-08-12T09:00:00.000Z'),
  });
});

// Names with single underscores of their own: the delimiter is the DOUBLE one.
test('parseUsageLine splits on the double underscore, not the first one', () => {
  const line = '{"name":"mcp__claude_ai_Bigdata_com__bigdata_search"}';
  assert.deepEqual(parseUsageLine(line).names, ['claude_ai_Bigdata_com']);
});

// The regression that made every server on a real machine read as "used today".
test('parseUsageLine ignores a server merely MENTIONED in prose', () => {
  assert.equal(parseUsageLine('use mcp__firecrawl__firecrawl_scrape to fetch a page'), null);
  assert.equal(parseUsageLine('{"text":"tools are named mcp__server__tool"}'), null);
});

// The same bug invented a server called "<server>" out of documentation.
test('parseUsageLine rejects a name that is not an identifier', () => {
  assert.equal(parseUsageLine('{"name":"mcp__<server>__<tool>"}'), null);
});

test('parseUsageLine reports a missing timestamp rather than guessing', () => {
  assert.equal(parseUsageLine('{"name":"mcp__gmail__search"}').at, null);
});

test('parseUsageLine returns null for lines with no mcp reference', () => {
  assert.equal(parseUsageLine('{"name":"Read"}'), null);
  assert.equal(parseUsageLine(''), null);
  assert.equal(parseUsageLine(null), null);
});

// ---- foldUsage --------------------------------------------------------------

test('foldUsage counts calls and keeps the newest timestamp', () => {
  const usage = foldUsage([
    { names: ['a'], at: daysAgo(9) },
    { names: ['a', 'b'], at: daysAgo(2) },
    { names: ['a'], at: daysAgo(30) },
  ]);
  assert.equal(usage.a.calls, 3);
  assert.equal(usage.a.lastUsed, daysAgo(2));
  assert.equal(usage.b.calls, 1);
});

// ---- classifyIdle -----------------------------------------------------------

test('classifyIdle names the four states', () => {
  assert.equal(classifyIdle(null, NOW), 'never');
  assert.equal(classifyIdle(daysAgo(1), NOW), 'fresh');
  assert.equal(classifyIdle(daysAgo(FRESH_DAYS), NOW), 'fresh');
  assert.equal(classifyIdle(daysAgo(FRESH_DAYS + 1), NOW), 'idle');
  assert.equal(classifyIdle(daysAgo(IDLE_DAYS), NOW), 'idle');
  assert.equal(classifyIdle(daysAgo(IDLE_DAYS + 1), NOW), 'stale');
});

// ---- mergeUsage -------------------------------------------------------------

test('mergeUsage joins config to usage', () => {
  const servers = collectServers({ mcpServers: { gmail: { command: 'python' } } });
  const rows = mergeUsage(servers, { gmail: { lastUsed: daysAgo(3), calls: 12 } }, NOW);
  assert.equal(rows[0].calls, 12);
  assert.equal(rows[0].status, 'fresh');
});

test('mergeUsage marks a configured but uncalled server as never', () => {
  const servers = collectServers({ mcpServers: { redis: { command: 'x' } } });
  const rows = mergeUsage(servers, {}, NOW);
  assert.equal(rows[0].status, 'never');
  assert.equal(rows[0].calls, 0);
});

// Plugin and connector servers never appear in ~/.claude.json. Dropping them
// would hide real context-window cost behind an empty config.
test('mergeUsage adds servers usage knows about that config does not', () => {
  const rows = mergeUsage(
    [],
    {
      plugin_ecc_chrome: { lastUsed: daysAgo(1), calls: 4 },
      claude_ai_Google_Drive: { lastUsed: daysAgo(1), calls: 9 },
      mystery: { lastUsed: daysAgo(1), calls: 2 },
    },
    NOW
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.plugin_ecc_chrome.scope, 'plugin');
  assert.equal(byName.claude_ai_Google_Drive.scope, 'connector');
  assert.equal(byName.mystery.scope, 'external');
});

// The list is read top-down and acted on top-down.
test('mergeUsage sorts the most neglected first', () => {
  const servers = collectServers({
    mcpServers: {
      fresh: { command: 'x' },
      stale: { command: 'x' },
      never: { command: 'x' },
      idle: { command: 'x' },
    },
  });
  const rows = mergeUsage(
    servers,
    {
      fresh: { lastUsed: daysAgo(1), calls: 1 },
      idle: { lastUsed: daysAgo(FRESH_DAYS + 2), calls: 1 },
      stale: { lastUsed: daysAgo(IDLE_DAYS + 5), calls: 1 },
    },
    NOW
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['never', 'stale', 'idle', 'fresh']
  );
});

// ---- spawnPlan --------------------------------------------------------------
//
// The probe originally ran with `shell: true`, which is the one way to start a
// Windows .cmd shim - and also the way an args array stops being argv and
// becomes a concatenated command line nobody escaped. Node deprecated exactly
// that pairing (DEP0190), and these args can arrive from a .mcp.json inside a
// cloned repo. These tests pin the replacement.

test('spawnPlan runs a Windows shim through cmd.exe', () => {
  assert.deepEqual(spawnPlan('npx', ['-y', 'pkg'], 'win32'), {
    file: 'cmd.exe',
    args: ['/c', 'npx', '-y', 'pkg'],
  });
});

// A real executable needs no wrapper, and wrapping it anyway would put a
// process between us and the server's stdio for no reason.
test('spawnPlan leaves an explicit executable alone', () => {
  assert.deepEqual(spawnPlan('node.exe', ['x'], 'win32'), { file: 'node.exe', args: ['x'] });
  assert.deepEqual(spawnPlan('C:/py/python.exe', [], 'win32'), {
    file: 'C:/py/python.exe',
    args: [],
  });
});

test('spawnPlan does nothing on platforms that can spawn a bare command', () => {
  assert.deepEqual(spawnPlan('npx', ['-y'], 'linux'), { file: 'npx', args: ['-y'] });
  assert.deepEqual(spawnPlan('uvx', [], 'darwin'), { file: 'uvx', args: [] });
});

// The argv stays an ARRAY at every step - that is what makes Node escape each
// entry instead of pasting them into a command line.
test('spawnPlan keeps a hostile argument as one argument', () => {
  const plan = spawnPlan('npx', ['x & echo PWNED'], 'win32');
  assert.deepEqual(plan.args, ['/c', 'npx', 'x & echo PWNED']);
  assert.equal(Array.isArray(plan.args), true);
});

test('spawnPlan tolerates missing or junk args', () => {
  assert.deepEqual(spawnPlan('npx', undefined, 'linux'), { file: 'npx', args: [] });
  assert.deepEqual(spawnPlan('npx', 'nope', 'linux'), { file: 'npx', args: [] });
});

test('mergeUsage does not mutate the rows it was given', () => {
  const servers = collectServers({ mcpServers: { gmail: { command: 'x' } } });
  mergeUsage(servers, { gmail: { lastUsed: daysAgo(1), calls: 5 } }, NOW);
  assert.equal(servers[0].calls, 0);
  assert.equal(servers[0].status, 'never');
});
