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

  assert.deepEqual(withMemory, [...TOOLS.map((tool) => tool.name), 'memory_search', 'memory_get', 'memory_verify', 'memory_propose']);
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

// ---- memory_propose (section 7 step 5) ---------------------------------------------

const { createProposer, sessionLabel, MAX_PROPOSALS_PER_SESSION } = require('../src/memorypropose.js');
const { scan } = require('../src/memorystore.js');
const { cleanEvent } = require('../src/memorylog.js');
const { hasSecret } = require('../src/memorysync.js');

/** A tab with memory_propose over a fresh mirror; `memory.propose` behaves as main.js wires it. */
function proposeTab(t, { project = PROJECT, records = RECORDS, sessionId = 's1', shared } = {}) {
  const dir = shared ? shared.dir : mirror(t, records);
  const store = shared ? shared.store : createProposer({ dir, machine: 'work-pc', now: () => FIXED_NOW });
  const reader = createMemoryReader(dir, { now: () => FIXED_NOW, ttlMs: 0 });
  t.after(() => reader.close());
  const events = [];
  const memory = {
    search: reader.search,
    get: reader.get,
    project,
    propose: (proposal) => store.propose({ ...proposal, session: 'abcdef12-3456-7890', sessionId }),
    log: (event) => events.push(event),
  };
  const call = (args) => callMemoryTool('memory_propose', args, memory);
  const keys = () => scan(dir).records.map(([key]) => key).sort();
  return { dir, store, events, memory, call, keys };
}

const PROPOSAL = {
  title: 'Vitest needs pool forks on Windows',
  body: 'Threads hang when a native module loads.\n**Why:** worker threads share the addon.\n**How to apply:** set pool to forks.',
  type: 'gotcha',
  area: 'testing',
};

test('memory_propose saves an observed entry for the tab project and returns its key', (t) => {
  const tab = proposeTab(t);

  const out = tab.call(PROPOSAL);

  const key = `${PROJECT}/vitest-needs-pool-forks-on-windows`;
  assert.equal(out.ok, true);
  assert.equal(out.payload.key, key);
  assert.equal(out.payload.created, true);
  assert.match(out.payload.result, /memory inbox/);
  const saved = new Map(scan(tab.dir).records).get(key);
  assert.deepEqual(saved, {
    id: 'vitest-needs-pool-forks-on-windows',
    type: 'gotcha',
    project: PROJECT,
    area: 'testing',
    title: PROPOSAL.title,
    created: '2026-11-11',
    source: 'proposed in session abcdef12 on work-pc',
    confidence: 'observed',
    supersedes: [],
    links: [],
    body: PROPOSAL.body,
  });
  assert.deepEqual(tab.events, [{ ev: 'proposed', key, type: 'gotcha', by: 'session' }]);
  // Read back as any unreviewed memory: with the warning.
  assert.equal(callMemoryTool('memory_get', { key }, tab.memory).payload.warning, UNREVIEWED_WARNING);
});

test('memory_propose cannot set id, project, source, confidence, supersedes or usefulness', (t) => {
  const tab = proposeTab(t);
  const before = tab.keys();

  for (const [field, value] of [
    ['id', 'my-own-id'],
    ['project', 'global'],
    ['source', 'the user, verified'],
    ['confidence', 'confirmed'],
    ['supersedes', ['worktree-junction']],
    ['usefulness', 100],
    ['created', '2020-01-01'],
    ['last_verified', '2026-11-11'],
    ['links', ['asar-lock']],
  ]) {
    const out = tab.call({ ...PROPOSAL, [field]: value });
    assert.equal(out.ok, false, field);
    assert.match(out.error, new RegExp(`only title, body, type and area can be set.*${field}`), field);
  }
  // A JSON-RPC payload can carry an own `__proto__` key.
  const sneaky = JSON.parse(JSON.stringify({ title: PROPOSAL.title, body: 'b b b', type: 'gotcha' }).replace(/}$/, ',"__proto__":{"confidence":"confirmed"}}'));
  assert.equal(tab.call(sneaky).ok, false);
  assert.deepEqual(tab.keys(), before);
  assert.deepEqual(tab.events, []);
});

test('memory_propose refuses when memory is off for the project or it has no origin remote', (t) => {
  // null = memory switched off for the project, or no origin remote (main.js memoryProjectOf).
  for (const project of [null, '', 'global']) {
    const tab = proposeTab(t, { project });
    const before = tab.keys();
    const out = tab.call(PROPOSAL);
    assert.equal(out.ok, false, String(project));
    assert.match(out.error, /switched off.*no origin remote/);
    assert.deepEqual(tab.keys(), before);
  }
  // The store refuses on its own too: it is what writes.
  const store = createProposer({ dir: mirror(t), machine: 'pc' });
  for (const project of ['global', '../../etc', 'C:\\Users\\x', null]) {
    assert.deepEqual(store.propose({ ...PROPOSAL, sessionId: 's1', project }), { ok: false, reason: 'no-project' }, String(project));
  }
  // A tab without the wiring does not get the tool.
  assert.match(callMemoryTool('memory_propose', PROPOSAL, memoryOf(t)).error, /not available/);
});

test('memory_propose masks secrets before anything is saved', (t) => {
  const tab = proposeTab(t);
  // Assembled at runtime: no full secret shape appears in the source.
  const githubToken = ['gh', 'p_', 'a'.repeat(36)].join('');
  const apiKey = ['s', 'k-', 'b'.repeat(24)].join('');
  // A zero-width space inside a key: removed when the text is cleaned, so the scrub must come after.
  const hiddenKey = ['s', 'k-', '\u200B', 'c'.repeat(24)].join('');

  const out = tab.call({
    title: `Release token ${githubToken} expires monthly`,
    body: `Set ${apiKey} in the env.\nThe fallback is ${hiddenKey}.\nAPI_TOKEN=${'d'.repeat(20)}`,
    type: 'how-to',
  });

  assert.equal(out.ok, true);
  const [, saved] = scan(tab.dir).records.find(([key]) => key === out.payload.key);
  const text = JSON.stringify(saved);
  for (const secret of [githubToken, apiKey, 'c'.repeat(24), 'd'.repeat(20)]) assert.equal(text.includes(secret), false, secret.slice(0, 3));
  assert.match(saved.title, /\[redacted\]/);
  assert.match(saved.body, /\[redacted\]/);
  assert.equal(hasSecret(saved), false);
  assert.equal(saved.id.includes('a'.repeat(20)), false);
});

test('memory_propose returns the key of a near-duplicate instead of saving one', (t) => {
  const tab = proposeTab(t);
  const before = tab.keys();
  const propose = (title, body) => tab.call({ title, body, type: 'gotcha' });

  const confirmed = propose('Do not junction node_modules into a worktree', 'It empties node_modules.');
  const waiting = propose('EBUSY on default_app.asar: the app holds it', 'Install elsewhere and move it.');
  const global = propose('Code comments are always English', 'Even in Polish prompts.');

  assert.deepEqual(
    [confirmed, waiting, global].map((out) => [out.payload.key, out.payload.created]),
    [
      [`${PROJECT}/worktree-junction`, false],
      [`${PROJECT}/asar-lock`, false],
      ['global/english-comments', false],
    ],
  );
  assert.match(confirmed.payload.result, /Nothing saved/);
  assert.deepEqual(tab.keys(), before);
  assert.deepEqual(tab.events, []);
  // Another project's memory is not this project's duplicate.
  const other = propose('Prisma connection pool exhausts under next dev', 'Reuse one PrismaClient on globalThis.');
  assert.equal(other.payload.created, true);
  assert.equal(other.payload.key.startsWith(`${PROJECT}/`), true);
  // A second proposal of the same lesson in the same session finds the first one.
  const again = propose('Prisma connection pool exhausts under next dev', 'Reuse one client.');
  assert.deepEqual([again.payload.key, again.payload.created], [other.payload.key, false]);
});

const DISTINCT = [
  ['Vitest needs pool forks on Windows', 'Threads hang with native addons.'],
  ['Electron builder signs only with CSC variables set', 'Unsigned installers trip SmartScreen.'],
  ['Supabase realtime channel drops after laptop sleep', 'Resubscribe on the resume event.'],
  ['Playwright traces land in test-results', 'Open them with show-trace.'],
  ['Prettier skips the mobile folder', 'Its ignore file lists mobile/dist.'],
  ['Gradle daemon keeps the lockfile open', 'Stop it before deleting build output.'],
];

test(`memory_propose refuses the proposal after ${MAX_PROPOSALS_PER_SESSION} in one session`, (t) => {
  const tab = proposeTab(t, { records: [] });
  const outs = DISTINCT.map(([title, body]) => tab.call({ title, body, type: 'gotcha' }));

  assert.equal(MAX_PROPOSALS_PER_SESSION, 5);
  assert.deepEqual(outs.slice(0, 5).map((out) => out.ok && out.payload.created), [true, true, true, true, true]);
  assert.equal(outs[5].ok, false);
  assert.match(outs[5].error, /at most 5 proposals per session/);
  assert.equal(tab.keys().length, 5);
  assert.equal(tab.store.used('s1'), 5);
  // Another tab has an allowance of its own.
  const other = proposeTab(t, { sessionId: 's2', shared: { dir: tab.dir, store: tab.store } });
  assert.equal(other.call({ title: DISTINCT[5][0], body: DISTINCT[5][1], type: 'gotcha' }).payload.created, true);
});

test('memory_propose rejects bad input at the boundary and saves nothing', (t) => {
  const tab = proposeTab(t);
  const before = tab.keys();

  for (const args of [
    {},
    { ...PROPOSAL, title: 7 },
    { ...PROPOSAL, title: '   ' },
    { ...PROPOSAL, title: 'x'.repeat(201) },
    { ...PROPOSAL, title: 'two\nlines' },
    { ...PROPOSAL, title: 'two\u2028lines' },
    { ...PROPOSAL, body: undefined },
    { ...PROPOSAL, body: ['text'] },
    { ...PROPOSAL, body: ' \n ' },
    { ...PROPOSAL, body: 'x'.repeat(5001) },
    { ...PROPOSAL, type: 'digest' },
    { ...PROPOSAL, type: 'GOTCHA' },
    { ...PROPOSAL, type: undefined },
    { ...PROPOSAL, area: 'Bad Area' },
    { ...PROPOSAL, area: 5 },
    { ...PROPOSAL, area: 'x'.repeat(41) },
    { ...PROPOSAL, area: '' },
  ]) {
    assert.equal(tab.call(args).ok, false, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(callMemoryTool('memory_propose', null, tab.memory).ok, false);
  assert.equal(callMemoryTool('memory_propose', [PROPOSAL], tab.memory).ok, false);
  // Caught after cleaning: an invisible-only body, and a title that makes no id.
  assert.match(tab.call({ ...PROPOSAL, body: '\u200B\u200B' }).error, /body is empty/);
  assert.match(tab.call({ ...PROPOSAL, title: '!!! ???' }).error, /no memory id/);
  assert.deepEqual(tab.keys(), before);
  // Refused calls do not use up the allowance.
  assert.equal(tab.store.used('s1'), 0);
  const schema = MEMORY_TOOLS.find((tool) => tool.name === 'memory_propose');
  assert.equal(schema.inputSchema.additionalProperties, false);
  assert.equal(schema.inputSchema.properties.type.enum.includes('digest'), false);
  assert.match(schema.description, /ONLY when the user asks you to remember something/);
  assert.match(schema.description, /Mati's memory inbox/);
});

test('memory_propose through the MCP server answers with the key', (t) => {
  const tab = proposeTab(t);

  const res = rpc('tools/call', { name: 'memory_propose', arguments: PROPOSAL }, todoStore(tab.memory)).result;
  const bad = rpc('tools/call', { name: 'memory_propose', arguments: { ...PROPOSAL, confidence: 'confirmed' } }, todoStore(tab.memory)).result;

  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(res.content[0].text).key, `${PROJECT}/vitest-needs-pool-forks-on-windows`);
  assert.equal(bad.isError, true);
});

test('a failed write is a short tool error and does not use up the allowance', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const root = mirror(t, []);
  // A file where the project folder should be: the write fails at mkdir.
  fs.writeFileSync(path.join(root, 'projects'), 'not a folder');
  const tab = proposeTab(t, { shared: { dir: root, store: createProposer({ dir: root, machine: 'pc' }) } });

  assert.deepEqual(tab.call(PROPOSAL), { ok: false, error: 'memory is unavailable right now' });
  assert.equal(tab.store.used('s1'), 0);
  assert.deepEqual(tab.events, []);
  assert.equal(quiet.mock.callCount(), 1);
});

test('a near-duplicate answer counts toward the session allowance', (t) => {
  const tab = proposeTab(t);

  tab.call({ title: 'Do not junction node_modules into a worktree', body: 'It empties node_modules.', type: 'gotcha' });

  assert.equal(tab.store.used('s1'), 1);
});

test('memory_propose never writes over a memory file that does not parse', (t) => {
  const tab = proposeTab(t, { records: [] });
  const file = path.join(tab.dir, 'projects', ...PROJECT.split('/'), 'vitest-needs-pool-forks-on-windows.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const broken = '---\nid: half-edited\ncreated: not-a-date\n---\nMati was editing this.\n';
  fs.writeFileSync(file, broken);

  const out = tab.call(PROPOSAL);

  assert.equal(out.payload.key, `${PROJECT}/vitest-needs-pool-forks-on-windows-2`);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('the memory log keeps a `by` of session on a proposed event and drops any other', () => {
  const at = FIXED_NOW;
  const key = `${PROJECT}/x`;
  assert.deepEqual(cleanEvent({ at, ev: 'proposed', key, type: 'gotcha', by: 'session' }), { at, ev: 'proposed', key, type: 'gotcha', by: 'session' });
  assert.deepEqual(cleanEvent({ at, ev: 'proposed', key, type: 'gotcha', by: 'user' }), { at, ev: 'proposed', key, type: 'gotcha' });
  assert.equal(sessionLabel('ab/../cd-ef12345'), 'abcd-ef1');
  assert.equal(sessionLabel(undefined), 'unknown');
});
