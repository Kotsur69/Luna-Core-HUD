// ============================================================================
// LunaCore - memory tools on the MCP server (src/memorytools.js)
// ----------------------------------------------------------------------------
// The tool logic against a real mirror folder of synthetic memories, and the
// tools as the lunacore MCP server (src/intake.js) serves them.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MEMORY_TOOLS,
  isMemoryTool,
  callMemoryTool,
  createMemoryReader,
  trustOf,
  MAX_SEARCH_LIMIT,
  DATA_NOTE,
  UNREVIEWED_WARNING,
} = require('../src/memorytools.js');
const { writeRecord, removeRecord } = require('../src/memorystore.js');
const { handleRpc, TOOLS } = require('../src/intake.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';

const rec = (id, title, body, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body,
  ...over,
});

const RECORDS = [
  rec('worktree-junction', 'Do not junction node_modules into a worktree', 'git worktree remove follows the junction and empties node_modules.', {
    last_verified: '2026-11-02',
    source: 'session 7f3a',
    links: ['asar-lock'],
  }),
  rec('asar-lock', 'EBUSY on default_app.asar means the app holds it', 'Install in a sibling temp folder and move the entries in.', {
    confidence: 'observed',
  }),
  rec('old-release', 'Upload the installer with spaces in its name', 'This was the rule before the auto-update fix.'),
  rec('release-names', 'Name the installer asset with dashes', 'The auto-update download breaks on spaces.', { supersedes: ['old-release'], type: 'how-to' }),
  rec('prisma-pool', 'Prisma connection pool exhausts under next dev', 'Reuse one PrismaClient on globalThis.', { project: OTHER }),
  rec('english-comments', 'Code comments are always English', 'Polish UI strings are written without diacritics.', { project: 'global', type: 'preference' }),
];

function mirror(t, records = RECORDS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memtools-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const record of records) writeRecord(dir, record);
  return dir;
}

/** The day the fixtures were written: the tests must not start failing as they age. */
const FIXED_NOW = Date.parse('2026-11-11T12:00:00Z');

function memoryOf(t, project = PROJECT, opts, records) {
  const reader = createMemoryReader(mirror(t, records), { now: () => FIXED_NOW, ...opts });
  t.after(() => reader.close());
  return { search: reader.search, get: reader.get, project };
}

// ---- phase 5: staleness, memory_verify, the usage log ---------------------------

test('a stale memory says since when it is unverified, in search and in get', (t) => {
  const old = rec('old-gotcha', 'Packaging hangs on battery', 'The packaging step hangs on battery.', { created: '2026-01-05' });
  const memory = memoryOf(t, PROJECT, undefined, [old]);

  const [hit] = callMemoryTool('memory_search', { query: 'packaging battery' }, memory).payload.results;
  const got = callMemoryTool('memory_get', { key: 'old-gotcha' }, memory).payload;

  assert.equal(hit.trust, 'confirmed, not verified since 2026-01-05');
  assert.equal(got.trust, 'confirmed, not verified since 2026-01-05');
  assert.equal(trustOf({ confidence: 'observed', stale: true }), 'observed, not verified');
});

test('memory_verify hands a valid report to the store and answers in words', (t) => {
  const reports = [];
  const memory = {
    ...memoryOf(t),
    verify: (report) => {
      reports.push(report);
      return { ok: true, key: report.key, status: report.outcome === 'wrong' ? 'flagged' : 'verified', changed: report.outcome === 'holds' };
    },
  };

  const held = callMemoryTool('memory_verify', { key: 'worktree-junction', outcome: 'holds' }, memory);
  const wrong = callMemoryTool('memory_verify', { key: `${PROJECT}/release-names`, outcome: 'wrong', note: 'spaces work again' }, memory);

  assert.deepEqual(reports, [
    { key: `${PROJECT}/worktree-junction`, outcome: 'holds', note: '' },
    { key: `${PROJECT}/release-names`, outcome: 'wrong', note: 'spaces work again' },
  ]);
  assert.equal(held.ok, true);
  assert.match(held.payload.result, /verification date is now today/);
  assert.match(wrong.payload.result, /Flagged for the user to review/);
});

test('memory_verify refuses a bad report before anything is written', (t) => {
  let called = 0;
  const memory = { ...memoryOf(t), verify: () => ++called && { ok: true, status: 'verified' } };
  const call = (args) => callMemoryTool('memory_verify', args, memory);

  assert.match(call({ key: '../x', outcome: 'holds' }).error, /key must be/);
  assert.match(call({ key: 'worktree-junction', outcome: 'delete' }).error, /outcome must be/);
  assert.match(call({ key: 'worktree-junction', outcome: 'wrong' }).error, /say in `note`/);
  assert.match(call({ key: 'worktree-junction', outcome: 'wrong', note: '   ' }).error, /say in `note`/);
  assert.match(call({ key: 'worktree-junction', outcome: 'holds', note: 'x'.repeat(301) }).error, /at most 300/);
  assert.match(call({ key: 'no-such-memory', outcome: 'holds' }).error, /no memory with that key/);
  assert.equal(called, 0);
  assert.match(callMemoryTool('memory_verify', { key: 'worktree-junction', outcome: 'holds' }, memoryOf(t)).error, /not available/);
});

test('a failed report is a tool error, never a stack', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const refused = { ...memoryOf(t), verify: () => ({ ok: false, reason: 'not-found' }) };
  const broken = {
    ...memoryOf(t),
    verify: () => {
      throw new Error('EACCES: C:\\secret\\path');
    },
  };

  assert.deepEqual(callMemoryTool('memory_verify', { key: 'worktree-junction', outcome: 'holds' }, refused), { ok: false, error: 'the report could not be saved' });
  assert.deepEqual(callMemoryTool('memory_verify', { key: 'worktree-junction', outcome: 'holds' }, broken), { ok: false, error: 'memory is unavailable right now' });
  assert.equal(quiet.mock.callCount(), 1);
});

test('a successful search and read are logged, a failed call is not, and a broken log fails nothing', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const events = [];
  const memory = { ...memoryOf(t), log: (event) => events.push(event) };

  callMemoryTool('memory_search', { query: 'worktree junction', limit: 1 }, memory);
  callMemoryTool('memory_get', { key: 'worktree-junction' }, memory);
  callMemoryTool('memory_get', { key: 'no-such-memory' }, memory);
  const stillWorks = callMemoryTool('memory_get', { key: 'worktree-junction' }, {
    ...memory,
    log: () => {
      throw new Error('disk full');
    },
  });

  assert.deepEqual(events, [
    { ev: 'search', project: PROJECT, hits: [`${PROJECT}/worktree-junction`] },
    { ev: 'get', key: `${PROJECT}/worktree-junction` },
  ]);
  assert.equal(stillWorks.ok, true);
  assert.equal(quiet.mock.callCount(), 1);
});

// ---- memory_search -------------------------------------------------------------

test('memory_search returns short entries with key, trust label and the data note', (t) => {
  const out = callMemoryTool('memory_search', { query: 'worktree junction' }, memoryOf(t));

  assert.equal(out.ok, true);
  assert.equal(out.payload.note, DATA_NOTE);
  assert.equal(out.payload.project, PROJECT);
  const [first] = out.payload.results;
  assert.equal(first.key, `${PROJECT}/worktree-junction`);
  assert.equal(first.trust, 'confirmed, last verified 2026-11-02');
  assert.equal(first.source, 'session 7f3a');
  assert.deepEqual(first.links, ['asar-lock']);
  assert.equal('body' in first, false);
});

test('memory_search finds another project and labels an observed memory as not verified', (t) => {
  const memory = memoryOf(t);

  const other = callMemoryTool('memory_search', { query: 'prisma pool' }, memory).payload.results;
  const observed = callMemoryTool('memory_search', { query: 'EBUSY asar' }, memory).payload.results;

  assert.equal(other[0].key, `${OTHER}/prisma-pool`);
  assert.equal(observed[0].trust, 'observed, not verified');
});

// ---- unreviewed memories (security review of 2026-11-11) ------------------------

test('memory_search leaves the snippet out of an unreviewed memory and marks it', (t) => {
  const [hit] = callMemoryTool('memory_search', { query: 'EBUSY asar' }, memoryOf(t)).payload.results;

  assert.equal(hit.key, `${PROJECT}/asar-lock`);
  assert.equal('snippet' in hit, false);
  assert.equal(hit.unreviewed, true);
  assert.equal(hit.title, 'EBUSY on default_app.asar means the app holds it');
  assert.equal(hit.type, 'gotcha');
  assert.equal(hit.trust, 'observed, not verified');
  assert.equal(hit.created, '2026-10-21');
});

test('memory_search keeps the snippet of a confirmed memory and does not mark it', (t) => {
  const [hit] = callMemoryTool('memory_search', { query: 'worktree junction' }, memoryOf(t)).payload.results;

  assert.equal(typeof hit.snippet, 'string');
  assert.match(hit.snippet, /node_modules/);
  assert.equal('unreviewed' in hit, false);
});

test('memory_get returns an unreviewed memory with its body and a warning', (t) => {
  const out = callMemoryTool('memory_get', { key: 'asar-lock' }, memoryOf(t));

  assert.equal(out.ok, true);
  assert.equal(out.payload.body, 'Install in a sibling temp folder and move the entries in.');
  assert.equal(out.payload.warning, UNREVIEWED_WARNING);
  assert.match(out.payload.warning, /nobody has reviewed it/);
  assert.equal('supersededBy' in out.payload, false);
});

test('memory_get joins the superseded and the unreviewed warning for an unreviewed, replaced memory', (t) => {
  const records = [
    rec('old-guess', 'The build cache lives in the temp folder', 'Clear the temp folder to rebuild.', { confidence: 'observed' }),
    rec('cache-dir', 'The build cache lives in .cache', 'Delete .cache to rebuild.', { supersedes: ['old-guess'] }),
  ];

  const out = callMemoryTool('memory_get', { key: 'old-guess' }, memoryOf(t, PROJECT, undefined, records));

  assert.equal(out.payload.supersededBy, `${PROJECT}/cache-dir`);
  assert.equal(out.payload.warning, `This memory was replaced; read the one that supersedes it. ${UNREVIEWED_WARNING}`);
  assert.equal(out.payload.body, 'Clear the temp folder to rebuild.');
});

test('memory_get adds no warning to a confirmed memory', (t) => {
  const out = callMemoryTool('memory_get', { key: 'worktree-junction' }, memoryOf(t));

  assert.equal('warning' in out.payload, false);
});

test('the memory_search description says unreviewed entries come without a snippet', () => {
  const search = MEMORY_TOOLS.find((tool) => tool.name === 'memory_search');

  assert.match(search.description, /Unreviewed entries come without a snippet, and memory_get shows them with a warning\./);
});

test('memory_search leaves a superseded memory out', (t) => {
  const keys = callMemoryTool('memory_search', { query: 'installer name' }, memoryOf(t)).payload.results.map((r) => r.key);

  assert.deepEqual(keys, [`${PROJECT}/release-names`]);
});

test('memory_search thisProjectOnly keeps this project and global, and needs a switched-on project', (t) => {
  const here = callMemoryTool('memory_search', { query: 'prisma english comments', thisProjectOnly: true }, memoryOf(t));
  const nowhere = callMemoryTool('memory_search', { query: 'prisma', thisProjectOnly: true }, memoryOf(t, null));

  assert.deepEqual(
    here.payload.results.map((r) => r.key),
    ['global/english-comments'],
  );
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.error, /no memory switched on/);
});

test('memory_search works in a tab whose project has no memory switched on', (t) => {
  const out = callMemoryTool('memory_search', { query: 'worktree junction' }, memoryOf(t, null));

  assert.equal(out.payload.project, null);
  assert.equal(out.payload.results[0].key, `${PROJECT}/worktree-junction`);
});

test('memory_search respects limit and rejects bad arguments', (t) => {
  const memory = memoryOf(t);
  const search = (args) => callMemoryTool('memory_search', args, memory);

  assert.equal(search({ query: 'installer asar worktree prisma comments', limit: 2 }).payload.results.length, 2);
  for (const args of [
    {},
    { query: '   ' },
    { query: 7 },
    { query: 'x'.repeat(501) },
    { query: 'a', limit: 0 },
    { query: 'a', limit: MAX_SEARCH_LIMIT + 1 },
    { query: 'a', limit: 1.5 },
    { query: 'a', limit: '3' },
    { query: 'a', thisProjectOnly: 'yes' },
  ]) {
    assert.equal(search(args).ok, false, JSON.stringify(args));
  }
  assert.equal(callMemoryTool('memory_search', null, memory).ok, false);
  assert.equal(callMemoryTool('memory_search', ['worktree'], memory).ok, false);
});

test('memory_search treats search syntax in the query as plain words', (t) => {
  const out = callMemoryTool('memory_search', { query: 'title:worktree" OR NEAR(* ) AND --' }, memoryOf(t));

  assert.equal(out.ok, true);
  assert.equal(out.payload.results[0].key, `${PROJECT}/worktree-junction`);
});

// ---- memory_get ----------------------------------------------------------------

test('memory_get returns the full memory by key', (t) => {
  const out = callMemoryTool('memory_get', { key: `${PROJECT}/worktree-junction` }, memoryOf(t));

  assert.equal(out.ok, true);
  assert.equal(out.payload.note, DATA_NOTE);
  assert.equal(out.payload.title, 'Do not junction node_modules into a worktree');
  assert.match(out.payload.body, /empties node_modules/);
  assert.equal(out.payload.trust, 'confirmed, last verified 2026-11-02');
  assert.equal('supersededBy' in out.payload, false);
});

test('memory_get resolves a bare id in this project first, then in global', (t) => {
  const memory = memoryOf(t);

  assert.equal(callMemoryTool('memory_get', { key: 'asar-lock' }, memory).payload.key, `${PROJECT}/asar-lock`);
  assert.equal(callMemoryTool('memory_get', { key: 'english-comments' }, memory).payload.key, 'global/english-comments');
  // Another project's memory needs its full key.
  assert.equal(callMemoryTool('memory_get', { key: 'prisma-pool' }, memory).ok, false);
  assert.equal(callMemoryTool('memory_get', { key: `${OTHER}/prisma-pool` }, memory).ok, true);
});

test('memory_get accepts a padded or upper-case key', (t) => {
  const out = callMemoryTool('memory_get', { key: `  ${PROJECT}/Worktree-Junction 
` }, memoryOf(t));

  assert.equal(out.payload.key, `${PROJECT}/worktree-junction`);
});

test('the tab project is read once per call', (t) => {
  const base = memoryOf(t);
  let reads = 0;
  const memory = {
    search: base.search,
    get: base.get,
    get project() {
      reads += 1;
      return PROJECT;
    },
  };

  callMemoryTool('memory_search', { query: 'worktree', thisProjectOnly: true }, memory);
  callMemoryTool('memory_get', { key: 'asar-lock' }, memory);

  assert.equal(reads, 2);
});

test('memory_get says when a memory was superseded', (t) => {
  const out = callMemoryTool('memory_get', { key: 'old-release' }, memoryOf(t));

  assert.equal(out.payload.supersededBy, `${PROJECT}/release-names`);
  assert.match(out.payload.warning, /replaced/);
});

test('memory_get rejects keys that are not memory keys, without touching a path', (t) => {
  const memory = memoryOf(t);

  for (const key of [undefined, '', 5, '../../etc/passwd', 'global/../x', 'C:\\Windows\\win.ini', `${PROJECT}/..`, 'x'.repeat(201), 'no such id!']) {
    const out = callMemoryTool('memory_get', { key }, memory);
    assert.equal(out.ok, false, String(key));
  }
  assert.match(callMemoryTool('memory_get', { key: 'missing-one' }, memory).error, /no memory with that key/);
});

// ---- the reader ----------------------------------------------------------------

test('the reader serves a cached index, then sees new and removed files after the window', (t) => {
  let now = 1000;
  const dir = mirror(t);
  const reader = createMemoryReader(dir, { now: () => now, ttlMs: 5000 });
  t.after(() => reader.close());
  assert.equal(reader.search('vitest').length, 0);

  writeRecord(dir, rec('vitest-pool', 'Vitest needs pool forks on Windows', 'Threads hang with native modules.'));
  removeRecord(dir, `${PROJECT}/asar-lock`);
  now += 4999;
  assert.equal(reader.search('vitest').length, 0);
  assert.notEqual(reader.get(`${PROJECT}/asar-lock`), null);

  now += 1;
  assert.equal(reader.search('vitest')[0].id, 'vitest-pool');
  assert.equal(reader.get(`${PROJECT}/asar-lock`), null);
});

test('the reader answers with nothing when the mirror folder does not exist', (t) => {
  const reader = createMemoryReader(path.join(os.tmpdir(), 'luna-memtools-missing-folder'));
  t.after(() => reader.close());

  assert.deepEqual(reader.search('anything'), []);
  assert.equal(reader.get('global/anything'), null);
});

test('a failing reader becomes a short tool error, not a throw', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const broken = {
    project: null,
    search: () => {
      throw new Error('disk on fire at C:\\secret\\path');
    },
    get: () => null,
  };

  const out = callMemoryTool('memory_search', { query: 'anything' }, broken);

  assert.deepEqual(out, { ok: false, error: 'memory is unavailable right now' });
  assert.equal(errors.mock.callCount(), 1);
});

test('trustOf labels each confidence', () => {
  assert.equal(trustOf({ confidence: 'confirmed' }), 'confirmed, never re-verified');
  assert.equal(trustOf({ confidence: 'inferred', last_verified: '2026-11-01' }), 'inferred, not verified');
});

// ---- through the MCP server ----------------------------------------------------

const rpc = (method, params, store) => handleRpc({ jsonrpc: '2.0', id: 1, method, params }, store);
const todoStore = (memory) => ({ read: () => [], write: () => true, ...(memory ? { memory } : {}) });

test('tools/list adds the memory tools only for a store that has memory', (t) => {
  const withMemory = rpc('tools/list', {}, todoStore(memoryOf(t))).result.tools.map((tool) => tool.name);
  const without = rpc('tools/list', {}, todoStore()).result.tools.map((tool) => tool.name);

  assert.deepEqual(withMemory, [...TOOLS.map((tool) => tool.name), 'memory_search', 'memory_get', 'memory_verify']);
  assert.deepEqual(without, TOOLS.map((tool) => tool.name));
  assert.equal(MEMORY_TOOLS.every((tool) => isMemoryTool(tool.name) && tool.inputSchema.type === 'object'), true);
});

test('tools/call runs a memory tool and marks a bad call as a tool error', (t) => {
  const store = todoStore(memoryOf(t));

  const good = rpc('tools/call', { name: 'memory_search', arguments: { query: 'worktree junction' } }, store).result;
  const bad = rpc('tools/call', { name: 'memory_get', arguments: { key: '../x' } }, store).result;

  assert.equal(good.isError, undefined);
  assert.equal(JSON.parse(good.content[0].text).results[0].key, `${PROJECT}/worktree-junction`);
  assert.equal(bad.isError, true);
});

test('a memory tool is an unknown tool for a store without memory, and to-do tools still work beside it', (t) => {
  assert.equal(rpc('tools/call', { name: 'memory_search', arguments: { query: 'a' } }, todoStore()).error.code, -32602);

  const listed = rpc('tools/call', { name: 'luna_todo_list', arguments: {} }, todoStore(memoryOf(t))).result;
  assert.deepEqual(JSON.parse(listed.content[0].text), []);
});
