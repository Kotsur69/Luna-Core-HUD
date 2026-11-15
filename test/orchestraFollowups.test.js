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

test('the per-call and per-package caps hold', () => {
  const { channel } = newChannel();
  const store = memoryStore();
  const many = (n, prefix) => Array.from({ length: n }, (_v, i) => ({ text: `${prefix} ${i}`, kind: 'idea' }));
  assert.match(addVia(channel, store, many(F.MAX_FOLLOWUPS_PER_CALL + 1, 'x')).text, /at most 5 follow-up cards per call/);
  for (let round = 0; round < F.MAX_FOLLOWUPS_PER_PACKAGE / F.MAX_FOLLOWUPS_PER_CALL; round += 1) {
    assert.equal(addVia(channel, store, many(F.MAX_FOLLOWUPS_PER_CALL, `r${round}`)).isError, false);
  }
  const over = addVia(channel, store, many(1, 'over'));
  assert.match(over.text, /at most 20 follow-up cards \(20 already\)/);
  // Another package of the same run has its own allowance.
  assert.equal(addVia(channel, store, many(1, 'other'), { ...WORKER, packageId: 'data-model' }).isError, false);
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
