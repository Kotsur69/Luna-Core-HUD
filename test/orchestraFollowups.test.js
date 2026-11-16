// Tests for the God Mode follow-up channel (src/orchestraFollowups.js) and its
// launch wiring (src/orchestraFollowupsLaunch.js): the server-side add rules,
// the per-run record, which God Mode session gets which token / config /
// allow rules, and the revocation hooks of the run controller.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleRpc, IntakeServer } = require('../src/intake.js');
const { normalizeTodo } = require('../src/todo.js');
const F = require('../src/orchestraFollowups.js');
const L = require('../src/orchestraFollowupsLaunch.js');
const { withTaskBrief } = require('../src/launch.js');
const { planWorkerTask, withPlanLockdown, planMcpConfig } = require('../src/orchestraPlanRunLaunch.js');
const { createFixupRunner } = require('../src/orchestraFixup.js');
const { createOrchestra } = require('../src/orchestra.js');
const sup = require('../src/orchestraSupervisor.js');

const NOW = 1_800_000_000_000;
const RUN = 'pabc123';
const WORKER = { scope: 'worker', runId: RUN, packageId: 'auth-flow' };
const TODO_RULES = ['mcp__lunacore__luna_todo_add', 'mcp__lunacore__luna_todo_list'];

function memoryStore(initial = []) {
  let list = initial;
  return {
    read: () => list,
    write: (next) => {
      list = next;
      return true;
    },
    now: () => NOW,
    get list() {
      return list;
    },
  };
}

/** One luna_todo_add through the dispatcher as a worker-scoped token sends it. */
function addVia(channel, store, tasks, scope = WORKER) {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'luna_todo_add', arguments: { tasks } } };
  const result = handleRpc(msg, store, '1.0.0', { scope, channel }).result;
  return { isError: result.isError === true, text: result.content[0].text };
}

const newChannel = (ledgerOpts) => {
  const ledger = F.createFollowupLedger(ledgerOpts);
  return { ledger, channel: F.createFollowupChannel({ ledger, now: () => NOW }) };
};

// ---- the add rules ---------------------------------------------------------------

test('the server forces tags, manual=false and the source line, whatever the session sends', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  const res = addVia(channel, store, [
    { text: 'Fix the flaky login test', kind: 'bug', details: 'Fails one run in five.', tags: ['steer', 'urgent'], manual: true, done: true, state: 'building' },
  ]);
  assert.equal(res.isError, false, res.text);
  const [card] = store.list;
  assert.deepEqual(card.tags, ['gm-followup', 'gm-bug', `run:${RUN}`]);
  assert.notEqual(card.manual, true);
  assert.equal(card.done, false);
  assert.equal(card.state ?? null, null);
  assert.equal(card.details, 'Fails one run in five.\n\nFiled by God Mode package auth-flow');
});

test('a card without details still names the package that filed it', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  addVia(channel, store, [{ text: 'Upgrade electron-builder', kind: 'deps' }]);
  assert.equal(store.list[0].details, 'Filed by God Mode package auth-flow');
  assert.deepEqual(store.list[0].tags, ['gm-followup', 'gm-deps', `run:${RUN}`]);
});

test('a missing or invalid kind rejects the whole call', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  for (const kind of [undefined, 'chore', 'BUG', 3]) {
    const res = addVia(channel, store, [{ text: 'ok', kind: 'idea' }, { text: 'second', kind }]);
    assert.equal(res.isError, true);
    assert.match(res.text, /tasks\[1\]\.kind must be one of gap, bug, deps, idea/);
  }
  assert.equal(store.list.length, 0);
});

test('a title equal to an open card (trim, case, whitespace) is refused as "duplicate of <at>"', () => {
  const { channel } = newChannel();
  const open = normalizeTodo({ text: 'Fix the  Login test', done: false, at: 4242 });
  const closed = normalizeTodo({ text: 'Old thing', done: true, at: 4243 });
  const store = memoryStore([open, closed]);
  const res = addVia(channel, store, [{ text: '  fix the login\ttest ', kind: 'bug' }]);
  assert.equal(res.isError, true);
  assert.match(res.text, /duplicate of 4242/);
  // A done card's title is free again; a repeat inside one call is refused too.
  assert.equal(addVia(channel, store, [{ text: 'old thing', kind: 'idea' }]).isError, false);
  const twice = addVia(channel, store, [{ text: 'A', kind: 'gap' }, { text: 'a', kind: 'gap' }]);
  assert.match(twice.text, /tasks\[1\] is a duplicate of tasks\[0\]/);
});

test('dependsOn keeps project cards and batch indexes, drops everything else', () => {
  const { channel } = newChannel();
  const store = memoryStore([normalizeTodo({ text: 'base', done: false, at: 100 })]);
  const res = addVia(channel, store, [
    { text: 'first', kind: 'gap', dependsOn: [100, 999, 'x', 0, -1] },
    { text: 'second', kind: 'gap', dependsOn: [0, 7777] },
  ]);
  assert.equal(res.isError, false, res.text);
  const [, first, second] = store.list;
  assert.deepEqual(first.dependsOn, [100]);
  assert.deepEqual(second.dependsOn, [first.at]);
});

const many = (n, prefix) => Array.from({ length: n }, (_v, i) => ({ text: `${prefix} ${i}`, kind: 'idea' }));
const fill = (channel, store, packageId, n) => {
  for (let i = 0; i < n; i += F.MAX_FOLLOWUPS_PER_CALL) {
    const res = addVia(channel, store, many(Math.min(F.MAX_FOLLOWUPS_PER_CALL, n - i), `${packageId}-${i}`), { ...WORKER, packageId });
    assert.equal(res.isError, false, res.text);
  }
};

test('the per-call and per-package caps hold', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  assert.match(addVia(channel, store, many(F.MAX_FOLLOWUPS_PER_CALL + 1, 'x')).text, /at most 5 follow-up cards per call/);
  fill(channel, store, 'auth-flow', F.MAX_FOLLOWUPS_PER_PACKAGE);
  const over = addVia(channel, store, many(1, 'over'));
  assert.match(over.text, /package may file at most 10 follow-up cards \(10 already\)/);
  // Another package of the same run has its own allowance.
  assert.equal(addVia(channel, store, many(1, 'other'), { ...WORKER, packageId: 'data-model' }).isError, false);
});

test('the per-run cap holds across packages', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  fill(channel, store, 'pkg-a', 10);
  fill(channel, store, 'pkg-b', 10);
  fill(channel, store, 'pkg-c', 10);
  const over = addVia(channel, store, many(1, 'over'), { ...WORKER, packageId: 'pkg-d' });
  assert.match(over.text, /run may file at most 30 follow-up cards \(30 already\)/);
  assert.equal(store.list.length, F.MAX_FOLLOWUPS_PER_RUN);
});

test('follow-ups keep the last list slots free for the user', () => {
  const { channel } = newChannel();
  const full = Array.from({ length: 80 }, (_v, i) => normalizeTodo({ text: `user ${i}`, done: false, at: i + 1 }));
  const store = memoryStore(full);
  const res = addVia(channel, store, many(1, 'one more'));
  assert.equal(res.isError, true);
  assert.match(res.text, /nearly full \(80 of 100\)/);
  assert.equal(store.list.length, 80);
});

test('verify, files, model and effort never come from a God Mode session', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  const res = addVia(channel, store, [
    { text: 'Add lint', kind: 'idea', verify: 'powershell -c evil', files: ['C:/Windows/x'], model: 'opus', effort: 'max', acceptance: ['lint passes'], size: 'S' },
  ]);
  assert.equal(res.isError, false, res.text);
  const [card] = store.list;
  for (const key of ['verify', 'files', 'model', 'effort']) assert.equal(card[key] ?? null, null, key);
  assert.deepEqual(card.acceptance, ['lint passes']);
  assert.equal(card.size, 'S');
  const props = F.FOLLOWUP_ADD_TOOL.inputSchema.properties.tasks.items.properties;
  assert.deepEqual(Object.keys(props).sort(), ['acceptance', 'dependsOn', 'details', 'kind', 'size', 'text']);
});

test('luna_todo_list answers through the channel; any other to-do tool is not the channel\'s', () => {
  const { channel } = newChannel();
  const store = memoryStore([normalizeTodo({ text: 'open', done: false, at: 1 }), normalizeTodo({ text: 'done', done: true, at: 2 })]);
  const listed = JSON.parse(channel.call('luna_todo_list', {}, store, WORKER).content[0].text);
  assert.deepEqual(listed.map((c) => c.at), [1]);
  assert.equal(channel.call('luna_todo_update', { at: 1, patch: {} }, store, WORKER), null);
  assert.equal(channel.call('luna_todo_add', { tasks: [] }, store, { ...WORKER, scope: 'godmode' }), null);
});

// ---- the per-run record ------------------------------------------------------------

test('every successful add is recorded per run and package and readable via followupsFor', () => {
  const ledger = F.createFollowupLedger();
  const server = new IntakeServer({ storeFor: () => null, channel: F.createFollowupChannel({ ledger, now: () => NOW }) });
  const store = memoryStore();
  const channel = server.channel;
  addVia(channel, store, [{ text: 'Bug one', kind: 'bug' }, { text: 'Idea two', kind: 'idea' }]);
  addVia(channel, store, [{ text: 'Selfcheck gap', kind: 'gap' }], { ...WORKER, packageId: 'selfcheck' });
  addVia(channel, store, [{ text: 'Bug one', kind: 'bug' }]); // refused: not recorded
  const all = server.followupsFor(RUN);
  assert.deepEqual(all.map((e) => [e.packageId, e.kind, e.title]), [
    ['auth-flow', 'bug', 'Bug one'],
    ['auth-flow', 'idea', 'Idea two'],
    ['selfcheck', 'gap', 'Selfcheck gap'],
  ]);
  assert.deepEqual(all.map((e) => e.at), store.list.map((c) => c.at));
  assert.ok(all.every((e) => e.runId === RUN));
  assert.equal(server.followupsFor(RUN, 'selfcheck').length, 1);
  assert.deepEqual(server.followupsFor('pother'), []);
});

test('the record is stored with the run and read back after a restart', () => {
  const stored = new Map();
  const opts = {
    load: (runId) => stored.get(runId) || null,
    persist: (runId, entries) => (stored.set(runId, entries), true),
  };
  const before = newChannel(opts);
  addVia(before.channel, memoryStore(), [{ text: 'Survives', kind: 'deps' }]);
  assert.equal(stored.get(RUN).length, 1);

  // A new LunaCore: an empty in-memory ledger reads the stored record.
  const after = newChannel(opts);
  assert.deepEqual(after.ledger.list(RUN).map((e) => e.title), ['Survives']);
  addVia(after.channel, memoryStore(), [{ text: 'Later', kind: 'idea' }]);
  assert.deepEqual(stored.get(RUN).map((e) => e.title), ['Survives', 'Later']);
});

test('a record that cannot be stored stays in memory and is logged, never thrown', () => {
  const lines = [];
  const ledger = F.createFollowupLedger({ persist: () => { throw new Error('disk gone'); }, log: (l) => lines.push(l) });
  assert.equal(ledger.record(RUN, [{ packageId: 'a', kind: 'bug', title: 't', at: 1 }]), false);
  assert.equal(ledger.list(RUN).length, 1);
  assert.match(lines[0], /disk gone/);
});

test('a stored run keeps the option and its record; junk entries are dropped', () => {
  const raw = {
    id: RUN,
    repoPath: path.resolve('/repo'),
    packages: [{ id: 'auth-flow', title: 'A', prompt: 'p', state: 'pushed', todoAts: [1], dependsOn: [], files: [] }],
    followups: true,
    followupsFiled: [
      { runId: 'spoofed', packageId: 'auth-flow', kind: 'bug', title: 'Real', at: 5 },
      { packageId: '../x', kind: 'bug', title: 'bad id', at: 6 },
      { packageId: 'auth-flow', kind: 'chore', title: 'bad kind', at: 7 },
      'junk',
    ],
  };
  const plan = sup.normalizeStoredPlan(raw);
  assert.equal(plan.followups, true);
  assert.deepEqual(plan.followupsFiled, [{ runId: RUN, packageId: 'auth-flow', kind: 'bug', title: 'Real', at: 5 }]);
  const off = sup.normalizeStoredPlan({ ...raw, followups: 'yes', followupsFiled: [] });
  assert.equal('followups' in off, false);
  assert.equal('followupsFiled' in off, false);
});

// ---- launch wiring -----------------------------------------------------------------

const BRIEF = 'C:/cfg/tasks/auth-flow.md';
const workerTask = (allowedTools = []) => ({ briefPath: BRIEF, model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions', allowedTools });
const fakeServer = () => {
  const issued = [];
  return { issued, revoked: [], issueToken(sessionId, scope) { issued.push({ sessionId, scope }); return `tok${issued.length}`; }, revoke(id) { this.revoked.push(id); } };
};

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-followups-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test('followups off: a worker gets a godmode-scoped config and no lunacore to-do rule', (t) => {
  const dir = tmpDir(t);
  const task = L.godModeTask(workerTask(['Bash(npm test)', TODO_RULES[0]]), { runId: RUN, packageId: 'auth-flow', followups: false });
  assert.deepEqual(task.allowedTools, ['Bash(npm test)'], 'a learned to-do rule is stripped too');
  const command = withTaskBrief('claude', task);
  assert.doesNotMatch(command, /luna_todo/);

  const server = fakeServer();
  const file = L.writeGodModeConfig({ dir, sessionId: 's3', url: 'http://127.0.0.1:1/mcp', server, task });
  assert.deepEqual(server.issued, [{ sessionId: 's3', scope: { scope: 'godmode', runId: RUN, packageId: 'auth-flow' } }]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['lunacore']);
  assert.equal(L.withGodModeMcp(command, file, task), `${command} --mcp-config '${file}'`);
});

test('followups on: a worker gets exactly the worker-scoped config and the two allow rules', (t) => {
  const dir = tmpDir(t);
  const task = L.godModeTask(workerTask(['Bash(npm test)']), { runId: RUN, packageId: 'auth-flow', followups: true });
  assert.deepEqual(task.allowedTools, ['Bash(npm test)', ...TODO_RULES]);
  const command = withTaskBrief('claude', task);
  assert.match(command, /--allowedTools 'Bash\(npm test\)' 'mcp__lunacore__luna_todo_add' 'mcp__lunacore__luna_todo_list'/);

  const server = fakeServer();
  const file = L.writeGodModeConfig({ dir, sessionId: 's4', url: 'http://127.0.0.1:1/mcp', server, task });
  assert.equal(server.issued[0].scope.scope, 'worker');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.mcpServers, { lunacore: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok1' } } });
  // One --mcp-config for lunacore: the scoped one, never the tab's full one next to it.
  const launched = L.withGodModeMcp(command, file, task);
  assert.equal(launched.match(/--mcp-config/g).length, 1);
});

test('followups off: a plan-run worker gets no lunacore server and no to-do rule', (t) => {
  const dir = tmpDir(t);
  const shared = path.join(dir, 'luna-plan-mcp.json');
  fs.writeFileSync(shared, JSON.stringify(planMcpConfig()));
  const task = L.godModeTask(planWorkerTask({ briefPath: BRIEF, runSlug: 'plan-x', mcpConfigPath: shared }), { runId: RUN, packageId: 'topic-a', followups: false });
  const command = withPlanLockdown('claude', task);
  assert.doesNotMatch(command, /lunacore/);
  const server = fakeServer();
  assert.equal(L.writeGodModeConfig({ dir, sessionId: 's5', url: 'http://x/mcp', server, task }), null);
  assert.equal(server.issued.length, 0);
  assert.equal(L.withGodModeMcp(command, null, task), command);
});

test('followups on: a plan-run worker keeps Playwright, gains lunacore and the two rules', (t) => {
  const dir = tmpDir(t);
  const shared = path.join(dir, 'luna-plan-mcp.json');
  fs.writeFileSync(shared, JSON.stringify(planMcpConfig()));
  const task = L.godModeTask(planWorkerTask({ briefPath: BRIEF, runSlug: 'plan-x', mcpConfigPath: shared }), { runId: RUN, packageId: 'topic-a', followups: true });
  const command = withPlanLockdown('claude', task);
  assert.match(command, /'Edit\(docs\/plans\/plan-x\/\*\*\)' 'mcp__lunacore__luna_todo_add' 'mcp__lunacore__luna_todo_list' --disallowedTools/);

  const server = fakeServer();
  const file = L.writeGodModeConfig({ dir, sessionId: 's6', url: 'http://127.0.0.1:1/mcp', server, task });
  assert.equal(server.issued[0].scope.scope, 'worker');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['lunacore', 'playwright']);
  assert.deepEqual(doc.mcpServers.playwright, planMcpConfig().mcpServers.playwright);

  const launched = L.withGodModeMcp(command, file, task);
  assert.match(launched, new RegExp(`--strict-mcp-config --mcp-config '${file.replace(/[\\.]/g, '\\$&')}'`));
  assert.ok(!launched.includes(`'${shared}'`), 'the shared Playwright-only file is replaced, not added to');
  assert.equal(launched.match(/--mcp-config/g).length, 1);
});

test('a plan worker whose own MCP config cannot be read keeps its original launch', (t) => {
  const dir = tmpDir(t);
  const lines = [];
  const task = L.godModeTask(planWorkerTask({ briefPath: BRIEF, runSlug: 'plan-x', mcpConfigPath: path.join(dir, 'missing.json') }), { runId: RUN, packageId: 'topic-a', followups: true });
  const server = fakeServer();
  assert.equal(L.writeGodModeConfig({ dir, sessionId: 's8', url: 'http://x/mcp', server, task, log: (l) => lines.push(l) }), null);
  assert.equal(server.issued.length, 0);
  assert.match(lines[0], /unreadable/);
});

test('an invalid God Mode marker gets no lunacore server at all', (t) => {
  const dir = tmpDir(t);
  const server = fakeServer();
  const task = { ...workerTask(), godMode: { runId: '../evil', packageId: 'a', followups: true } };
  assert.equal(L.writeGodModeConfig({ dir, sessionId: 's9', url: 'http://x/mcp', server, task }), null);
  assert.equal(server.issued.length, 0);
  assert.equal(L.withGodModeMcp('claude', null, task), 'claude');
});

test('fix-up and self-check workers carry the marker with their own package id and the rules', () => {
  for (const [followups, packageId, rules] of [[true, 'selfcheck', TODO_RULES], [true, 'fixup', TODO_RULES], [false, 'selfcheck', []]]) {
    const sessions = [];
    const runner = createFixupRunner({
      getPlan: () => ({ id: RUN, profileId: 'p', projectId: 'proj', allowedTools: ['Read'], followups }),
      createSession: (opts) => (sessions.push(opts), { id: 's1' }),
      writeBrief: () => true,
      briefDir: () => '/cfg/tasks',
      closeSession: () => {},
      sessionAlive: () => false,
      model: () => 'opus',
      permissionMode: () => 'bypassPermissions',
      setTimer: () => null,
      clearTimer: () => {},
    });
    runner.run({ root: '/wt', brief: 'fix it', ...(packageId === 'fixup' ? { packageId } : {}) });
    const { task } = sessions[0];
    assert.deepEqual(task.godMode, { runId: RUN, packageId, followups });
    assert.deepEqual(task.allowedTools, ['Read', ...rules]);
    runner.abort();
  }
});

test('a settled fix-up revokes its token', () => {
  const revoked = [];
  const runner = createFixupRunner({
    getPlan: () => ({ id: RUN, profileId: 'p', projectId: 'proj', followups: true }),
    createSession: () => ({ id: 's11' }),
    writeBrief: () => true,
    briefDir: () => '/cfg/tasks',
    closeSession: () => {},
    sessionAlive: () => false,
    model: () => null,
    permissionMode: () => null,
    setTimer: () => null,
    clearTimer: () => {},
    revokeFollowups: (list) => revoked.push(...list),
  });
  runner.run({ root: '/wt', brief: 'b', packageId: 'fixup' });
  assert.equal(revoked.length, 0, 'a running fix-up keeps its token');
  assert.equal(runner.onSessionClosed('s11'), true);
  assert.deepEqual(revoked, [{ sessionId: 's11', runId: RUN, packageId: 'fixup' }]);
});

// ---- the run controller -----------------------------------------------------------

/** A God Mode run with recording deps (same shape as test/memoryinject.test.js). */
function godMode(extra = {}) {
  const sessions = [];
  const revoked = [];
  const runsRevoked = [];
  const saved = [];
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [{ id: 'auth-flow', title: 'Auth', prompt: 'p', files: [], todoAts: [1], dependsOn: [], model: 'sonnet' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => (sessions.push(opts), { id: `s${sessions.length}` }),
    revokeFollowups: (list) => revoked.push(...list),
    revokeRunFollowups: (runId) => runsRevoked.push(runId),
    saveState: (s) => saved.push(s),
    ...extra,
  });
  return { orch, sessions, revoked, runsRevoked, saved, ctx: { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} } };
}

test('a run defaults followups off: its worker carries the marker without the to-do rules', async () => {
  const { orch, sessions, ctx } = godMode();
  const { plan } = await orch.makePlan(ctx);
  await orch.launch({ planId: plan.id });
  assert.deepEqual(sessions[0].task.godMode, { runId: plan.id, packageId: 'auth-flow', followups: false });
  assert.ok(!sessions[0].task.allowedTools.some((r) => r.includes('luna_todo')));
});

test('a run made with followups on hands its worker the two rules', async () => {
  const { orch, sessions, ctx } = godMode();
  const { plan } = await orch.makePlan({ ...ctx, followups: true });
  await orch.launch({ planId: plan.id });
  assert.equal(sessions[0].task.godMode.followups, true);
  assert.deepEqual(sessions[0].task.allowedTools.slice(-2), TODO_RULES);
});

test('a settled package revokes its token; a restored or discarded run revokes the whole run', async () => {
  const { orch, revoked, runsRevoked, ctx } = godMode();
  const { plan } = await orch.makePlan({ ...ctx, followups: true });
  await orch.launch({ planId: plan.id });
  assert.equal(revoked.length, 0, 'a launched worker keeps its token');
  orch.kill();
  // createSession answered { id: 's1' } for the first worker tab.
  assert.deepEqual(revoked.at(-1), { sessionId: 's1', runId: plan.id, packageId: 'auth-flow' });
  assert.equal(orch.discard().ok, true);
  assert.deepEqual(runsRevoked, [plan.id]);
});

test('restart recovery revokes every token of the restored run', () => {
  const raw = {
    id: RUN,
    repoPath: path.resolve('/repo'),
    projectId: 'p1',
    packages: [{ id: 'auth-flow', title: 'A', prompt: 'p', state: 'launched', sessionId: 's3', todoAts: [1], dependsOn: [], files: [] }],
  };
  const { orch, runsRevoked } = godMode({ loadState: () => raw });
  assert.equal(orch.restore(), true);
  assert.deepEqual(runsRevoked, [RUN]);
});

test('the run stores its follow-up record and hands it back by run id only', async () => {
  const { orch, saved, ctx } = godMode();
  const { plan } = await orch.makePlan(ctx);
  const entry = { packageId: 'auth-flow', kind: 'bug', title: 'x', at: 9 };
  assert.equal(orch.noteFollowups('pother', [entry]), false);
  assert.equal(orch.noteFollowups(plan.id, [entry]), true);
  assert.deepEqual(saved.at(-1).followupsFiled, [{ runId: plan.id, ...entry }]);
  assert.deepEqual(orch.followupsFiled(plan.id), [{ runId: plan.id, ...entry }]);
  assert.equal(orch.followupsFiled('pother'), null);
});

test('settledSessions lists only settled packages that still have a tab', () => {
  const plan = {
    id: RUN,
    packages: [
      { id: 'a', state: 'launched', sessionId: 's1' },
      { id: 'b', state: 'pushed', sessionId: 's2' },
      { id: 'c', state: 'stalled', sessionId: null },
      { id: 'd', state: 'killed', sessionId: 's4' },
    ],
  };
  assert.deepEqual(L.settledSessions(plan, sup.SETTLED_STATES), [
    { sessionId: 's2', runId: RUN, packageId: 'b' },
    { sessionId: 's4', runId: RUN, packageId: 'd' },
  ]);
});

// ---- the run option: briefs ---------------------------------------------------------
// test/fixtures/gm-briefs-followups-off.json holds every brief kind as it was
// BEFORE the option existed: with the option off they must not change a byte.

const { briefText } = require('../src/orchestra.js');
const { fixupBrief } = require('../src/orchestraSelfCheck.js');
const { mergeFixupBrief } = require('../src/orchestraMergeFixup.js');
const { buildReport, renderRunReportHtml } = require('../src/orchestraReport.js');
const { registerOrchestraIpc } = require('../src/orchestraIpc.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');
const R = require('../src/orchestraFollowupsReport.js');
const uiprefs = require('../src/uiprefs.js');
const paths = require('../src/paths.js');

const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gm-briefs-followups-off.json'), 'utf8')).cases;
const SECTION = '## Follow-up to-dos';

/** A fix-up runner's written brief for `brief` under a plan with `followups`. */
function runnerBrief(brief, packageId, followups) {
  let written = null;
  const runner = createFixupRunner({
    getPlan: () => ({ id: RUN, profileId: 'p', projectId: 'proj', ...(followups === undefined ? {} : { followups }) }),
    createSession: () => ({ id: 's1' }),
    writeBrief: (_p, text) => ((written = text), true),
    briefDir: () => '/cfg/tasks',
    closeSession: () => {},
    sessionAlive: () => false,
    model: () => null,
    permissionMode: () => null,
    setTimer: () => null,
    clearTimer: () => {},
  });
  runner.run({ root: '/wt', brief, packageId });
  runner.abort();
  return written;
}

/** One snapshot case rendered today, with the run option set to `followups`. */
function render(c, followups) {
  if (c.kind === 'worker') return briefText(c.pkg, c.branch, followups === undefined ? c.opts : { ...c.opts, followups });
  if (c.kind === 'selfcheck') return runnerBrief(fixupBrief(c.result, c.checkCommand), 'selfcheck', followups);
  if (c.kind === 'mergeFixup') return runnerBrief(mergeFixupBrief(c.args), 'fixup', followups);
  return runnerBrief(c.brief, c.packageId, followups);
}

test('option off: worker, plan-run, self-check and merge fix-up briefs are byte-identical to before', () => {
  assert.equal(SNAPSHOT.length, 8);
  for (const c of SNAPSHOT) {
    // The fixture's self-check / merge fix-up texts are the builders' own output; through the runner they must not change.
    if (c.kind === 'selfcheck') assert.equal(fixupBrief(c.result, c.checkCommand), c.text);
    if (c.kind === 'mergeFixup') assert.equal(mergeFixupBrief(c.args), c.text);
    for (const off of [undefined, false, 'true', 1]) {
      assert.equal(render(c, off), c.text, `${c.name} with followups=${String(off)}`);
    }
  }
});

test('option on: every brief kind gets the section with all four kinds and the card rules', () => {
  for (const c of SNAPSHOT) {
    const text = render(c, true);
    assert.notEqual(text, c.text, c.name);
    assert.equal(text.split(SECTION).length, 2, `${c.name}: the section exactly once`);
    for (const kind of F.FOLLOWUP_KINDS) assert.match(text, new RegExp(`- \`${kind}\`: `), `${c.name}: ${kind}`);
    assert.match(text, /mcp__lunacore__luna_todo_add/);
    assert.match(text, /Call `mcp__lunacore__luna_todo_list` first/);
    assert.match(text, /self-contained/);
    assert.match(text, /what you saw; where \(files, command, error excerpt\); why it matters; the acceptance criteria/);
    assert.match(text, /how to verify it/);
    assert.match(text, /never added to this run and never started automatically/);
    assert.match(text, /do not fix it outside your scope/);
    assert.match(text, /never replaces finishing your own task/);
    assert.match(text, /list every card you filed \(title \+ `at`\)/);
    // Nothing of the brief without the option is lost.
    for (const line of c.text.split('\n').filter(Boolean)) assert.ok(text.includes(line), `${c.name} keeps: ${line}`);
  }
});

test('a worker brief puts the section before Verify; the end marker stays the last line', () => {
  const c = SNAPSHOT.find((x) => x.name === 'worker-plain');
  const text = render(c, true);
  assert.ok(text.indexOf(SECTION) < text.indexOf('## Verify'));
  assert.match(text.trimEnd().split('\n').at(-1), /^- End your final message with the line `LUNA_DONE auth-flow`/);
});

test('the run controller writes briefs with the run option: on for an opted-in run only', async () => {
  for (const followups of [false, true]) {
    const briefs = [];
    const { orch, ctx } = godMode({ writeBrief: (_p, text) => (briefs.push(text), true) });
    const { plan } = await orch.makePlan(followups ? { ...ctx, followups } : ctx);
    await orch.launch({ planId: plan.id });
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].includes(SECTION), followups, `followups=${followups}`);
  }
});

// ---- the run option: IPC, prefs and the stored run -------------------------------------

function planIpc() {
  const handlers = new Map();
  const calls = [];
  const registry = createOrchestraRegistry({
    makeController: () => ({
      view: () => null,
      planWait: () => null,
      makePlan: async (planCtx) => (calls.push(planCtx), { ok: true, plan: { id: 'p1', packages: [] } }),
    }),
  });
  registerOrchestraIpc({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, {
    registry,
    projects: () => [{ id: 'alpha', path: '/repo/alpha' }],
    activeProjectId: () => 'alpha',
    resolveSession: (id) => (id === 'tab-a' ? { id, projectId: 'alpha', profileId: 'claude' } : null),
    repoFor: () => '/repo/alpha',
    toolEnv: () => ({ PATH: 'x' }),
    maxTodoItems: 5,
    godModeBlock: () => null,
    send: () => {},
    playCue: () => {},
    openExternal: () => {},
    openPath: async () => '',
    runsDir: () => os.tmpdir(),
    readUiPrefs: () => ({}),
    writeUiPrefs: () => {},
  });
  const plan = (followups) => handlers.get('orchestra:plan')({}, 'tab-a', [1], 'high', 'claude', 'claude', 'opus', followups);
  return { plan, calls };
}

test('orchestra:plan turns the option on for the boolean true only', async () => {
  const { plan, calls } = planIpc();
  const sent = [true, false, 'true', 1, { followups: true }, [true], null, undefined];
  for (const value of sent) assert.equal((await plan(value)).ok, true);
  assert.deepEqual(calls.map((c) => c.followups === true), [true, false, false, false, false, false, false, false]);
  // Off passes no key at all: the makePlan call is the one from before the option.
  assert.ok(calls.slice(1).every((c) => !('followups' in c)));
});

test('ui pref orchestraFollowups: off by default, booleans only, the last choice kept', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-followups-pref-'));
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(async () => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  assert.equal(uiprefs.readUiPrefs().orchestraFollowups, false, 'missing file -> off');
  assert.equal(uiprefs.writeUiPrefs({ orchestraFollowups: true }).orchestraFollowups, true);
  for (const bad of ['true', 1, null, {}]) {
    assert.equal(uiprefs.writeUiPrefs({ orchestraFollowups: bad }).orchestraFollowups, true, `ignores ${String(bad)}`);
  }
  assert.equal(uiprefs.readUiPrefs().orchestraFollowups, true);
  assert.equal(uiprefs.writeUiPrefs({ orchestraFollowups: false }).orchestraFollowups, false);
  const file = path.join(dir, 'ui.local.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), orchestraFollowups: 'yes' }), 'utf8');
  assert.equal(uiprefs.readUiPrefs().orchestraFollowups, false, 'a hand-edited non-boolean reads as off');
});

test('plan.followups survives a store round-trip: the restored run keeps the option and its record', async () => {
  const { orch, saved, ctx } = godMode();
  const { plan } = await orch.makePlan({ ...ctx, repoPath: path.resolve('/repo'), followups: true });
  orch.noteFollowups(plan.id, [{ packageId: 'auth-flow', kind: 'bug', title: 'Login crashes', at: 7 }]);
  const stored = JSON.parse(JSON.stringify(saved.at(-1)));
  assert.equal(stored.followups, true);

  const briefs = [];
  const after = godMode({ loadState: () => stored, writeBrief: (_p, text) => (briefs.push(text), true) });
  assert.equal(after.orch.restore(), true);
  const view = after.orch.view();
  assert.equal(view.followups, true);
  assert.deepEqual(view.followupsFiled.map((e) => [e.packageId, e.kind, e.title, e.at]), [['auth-flow', 'bug', 'Login crashes', 7]]);
  // The restored run still launches its workers with the option.
  await after.orch.launch({ planId: plan.id });
  assert.ok(briefs.length >= 1 && briefs.every((b) => b.includes(SECTION)));
  assert.equal(after.sessions[0].task.godMode.followups, true);
});

// ---- the run option: report and notification --------------------------------------------

const ENTRIES = [
  { packageId: 'auth-flow', kind: 'bug', title: 'Login crashes on empty password', at: 11 },
  { packageId: 'data-model', kind: 'idea', title: 'Add an export button', at: 12 },
  { packageId: 'auth-flow', kind: 'idea', title: 'Remember the last user', at: 13 },
  { packageId: 'data-model', kind: 'bug', title: 'Migration drops <b>index</b>', at: 14 },
  { packageId: 'auth-flow', kind: 'bug', title: 'Token\nnever expires', at: 15 },
  { packageId: 'selfcheck', kind: 'deps', title: 'electron-builder warns on Node 24', at: 16 },
];
const reportView = (entries) => ({
  id: RUN,
  repoPath: '/repo',
  workerModel: 'sonnet',
  permissionMode: 'bypassPermissions',
  packages: [],
  integration: {},
  followupsFiled: entries,
});

test('report: grouped by kind, then by package, with title and to-do at', () => {
  const groups = R.groupFollowups(F.normalizeFollowupEntries(ENTRIES, RUN));
  assert.deepEqual(groups.map((g) => [g.kind, g.count]), [['bug', 3], ['deps', 1], ['idea', 2]]);
  assert.deepEqual(groups[0].packages, [
    { packageId: 'auth-flow', cards: [{ title: 'Login crashes on empty password', at: 11 }, { title: 'Token never expires', at: 15 }] },
    { packageId: 'data-model', cards: [{ title: 'Migration drops <b>index</b>', at: 14 }] },
  ]);

  const md = buildReport(reportView(ENTRIES), { now: NOW, suggestions: [] });
  const section = md.slice(md.indexOf('## New to-dos from this run'), md.indexOf('## What went wrong'));
  assert.equal(section, [
    '## New to-dos from this run',
    '',
    '### Bugs (3)',
    '',
    '- `auth-flow`',
    '  - Login crashes on empty password (to-do at 11)',
    '  - Token never expires (to-do at 15)',
    '- `data-model`',
    '  - Migration drops \\<b\\>index\\</b\\> (to-do at 14)',
    '',
    '### Dependency / build (1)',
    '',
    '- `selfcheck`',
    '  - electron-builder warns on Node 24 (to-do at 16)',
    '',
    '### Ideas (2)',
    '',
    // Packages in the order they first filed a card of this kind.
    '- `data-model`',
    '  - Add an export button (to-do at 12)',
    '- `auth-flow`',
    '  - Remember the last user (to-do at 13)',
    '',
    '',
  ].join('\n'));
  assert.ok(md.indexOf('## Needs you') < md.indexOf('## New to-dos from this run'));

  const html = renderRunReportHtml(reportView(ENTRIES), { now: NOW });
  assert.match(html, /<h2>New to-dos from this run<\/h2>/);
  assert.match(html, /Migration drops &lt;b&gt;index&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>index<\/b>/);
});

test('report: a title cannot form a link, image, tag or reordered text in the markdown', () => {
  const rlo = String.fromCodePoint(0x202e);
  const zwsp = String.fromCodePoint(0x200b);
  const emoji = String.fromCodePoint(0x1f41b);
  const evil = [
    { packageId: 'a', kind: 'bug', title: '![x](https://evil.example/p.png) [Click](javascript:alert(1)) <img src=x> **bold** `code`', at: 1 },
    { packageId: 'a', kind: 'idea', title: `left${rlo}right${zwsp}end`, at: 2 },
    { packageId: 'a', kind: 'gap', title: `${'x'.repeat(159)}${emoji}`, at: 3 },
  ];
  const md = buildReport(reportView(evil), { now: NOW, suggestions: [] });
  assert.ok(
    md.includes('  - \\!\\[x\\]\\(https://evil.example/p.png\\) \\[Click\\]\\(javascript:alert\\(1\\)\\) \\<img src=x\\> \\*\\*bold\\*\\* \\`code\\` (to-do at 1)'),
    md,
  );
  assert.doesNotMatch(md, /[^\\]\]\(/, 'no unescaped "](" survives');
  assert.ok(md.includes('  - left right end (to-do at 2)'), 'bidi override and zero-width space are stripped');
  // A 160 code-point cap never splits the emoji's surrogate pair.
  const capped = R.groupFollowups(F.normalizeFollowupEntries(evil, RUN)).find((g) => g.kind === 'gap').packages[0].cards[0].title;
  assert.equal(Array.from(capped).length, 160);
  assert.ok(capped.endsWith(emoji));
});

test('option on: a fix-up brief keeps its end-marker rule as the last line', () => {
  for (const c of SNAPSHOT.filter((x) => x.kind === 'selfcheck' || x.kind === 'mergeFixup')) {
    const on = render(c, true);
    assert.equal(on.trimEnd().split('\n').at(-1), c.text.trimEnd().split('\n').at(-1), c.name);
    assert.ok(on.indexOf(SECTION) < on.lastIndexOf('## Rules'), `${c.name}: the section comes before the rules`);
  }
});

test('report: no section when the run filed nothing', () => {
  for (const entries of [[], undefined, [{ packageId: '../x', kind: 'bug', title: 't', at: 1 }]]) {
    assert.doesNotMatch(buildReport(reportView(entries), { now: NOW, suggestions: [] }), /New to-dos/);
    assert.doesNotMatch(renderRunReportHtml(reportView(entries), { now: NOW }), /New to-dos/);
  }
});

test('notification: counts per kind in English and Polish, nothing when nothing was filed', () => {
  const counts = R.followupCounts(F.normalizeFollowupEntries(ENTRIES, RUN));
  assert.deepEqual(counts, { bug: 3, deps: 1, idea: 2 });
  assert.equal(R.followupCountText({ bug: 2, deps: 1, idea: 3 }, 'en'), '2 bugs, 1 deps, 3 ideas');
  assert.equal(R.followupCountText({ gap: 1, bug: 1, idea: 1 }, 'en'), '1 gap, 1 bug, 1 idea');
  assert.equal(R.followupCountText({ bug: 2, deps: 1, idea: 3 }, 'pl'), '2 bugi, 1 deps, 3 pomysly');
  assert.equal(R.followupCountText({ gap: 5, bug: 1, idea: 12 }, 'pl'), '5 brakow, 1 bug, 12 pomyslow');
  assert.equal(R.followupCountText({ gap: 22 }, 'pl'), '22 braki');
  assert.equal(R.followupCountText({}, 'en'), '');
  assert.equal(R.followupCountText({ bug: 0, idea: -1, deps: 'x' }, 'pl'), '');

  assert.equal(R.runToastBody({ pushed: 3, total: 4, failed: false, followups: { bug: 2, deps: 1, idea: 3 } }, 'en'), '3/4 pushed - New to-dos: 2 bugs, 1 deps, 3 ideas');
  assert.equal(R.runToastBody({ pushed: 3, total: 4, failed: true, followups: { bug: 2 } }, 'pl'), '3/4 pushed - integration needs you - Nowe to-do: 2 bugi');
  // Nothing filed (or an older caller without the key): the toast as before.
  assert.equal(R.runToastBody({ pushed: 4, total: 4, failed: false, followups: {} }, 'en'), '4/4 pushed');
  assert.equal(R.runToastBody({ pushed: 1, total: 2, failed: true }, 'pl'), '1/2 pushed - integration needs you');
});
