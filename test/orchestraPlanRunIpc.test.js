'use strict';

// Free God Mode v2 plan runs - the two IPC handlers (orchestra:planRun:start /
// orchestra:planRun:openDoc). The renderer is untrusted: everything is checked
// in main before a controller is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerOrchestraIpc } = require('../src/orchestraIpc.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');

function fakeController(state) {
  return {
    calls: [],
    view: () => state.view,
    planWait: () => null,
    isRunning: () => false,
    isBusy: () => false,
    repoPath: () => null,
    planningRepo: () => null,
    ownsSession: () => false,
    async makePlanRun(ctx) {
      this.calls.push(ctx);
      if (state.fail) return { ok: false, error: state.fail };
      state.view = { id: 'run1', projectId: ctx.projectId, packages: [], planRun: { docs: [] } };
      return { ok: true, plan: state.view };
    },
  };
}

function setup({ planRunEnv = () => ({ ANTHROPIC_MODEL: 'auto:easy' }), fail = null, withGit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-planrun-ipc-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  if (withGit) fs.mkdirSync(path.join(repo, '.git'));
  const runsDir = path.join(root, 'runs');
  fs.mkdirSync(runsDir);

  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const state = { view: null, fail };
  const controllers = {};
  const registry = createOrchestraRegistry({
    makeController: (projectId) => {
      controllers[projectId] = fakeController(state);
      return controllers[projectId];
    },
  });
  const out = { sent: [], opened: [], cues: [] };
  const sessions = { 'tab-a': { id: 'tab-a', projectId: 'alpha', repo } };
  registerOrchestraIpc(ipcMain, {
    registry,
    projects: () => [{ id: 'alpha', path: repo }],
    activeProjectId: () => 'alpha',
    resolveSession: (id) => (typeof id === 'string' && sessions[id]) || null,
    // Same as main's orchestraRepoFor: the project's folder, else the tab cwd.
    repoFor: (session) => (session.projectId === 'alpha' ? repo : session.cwd || null),
    toolEnv: () => ({ PATH: 'tool' }),
    planRunEnv,
    maxTodoItems: 5,
    godModeBlock: () => null,
    send: (channel, payload) => out.sent.push([channel, payload]),
    playCue: (key) => out.cues.push(key),
    openExternal: () => {},
    openPath: async (file) => {
      out.opened.push(file);
      return '';
    },
    runsDir: () => runsDir,
    readUiPrefs: () => ({}),
    writeUiPrefs: () => {},
  });
  const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { invoke, controllers, state, out, repo, runsDir, cleanup };
}

test('start: a bad payload never reaches a controller', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:planRun:start', null), { ok: false, error: 'badPayload' });
  assert.equal((await s.invoke('orchestra:planRun:start', { request: 'x'.repeat(5000), planner: 'claude', sessionId: 'tab-a' })).error, 'requestTooLong');
  assert.equal((await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'gpt', sessionId: 'tab-a' })).error, 'badPlanner');
  assert.equal((await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'claude', repoPath: os.tmpdir() })).error, 'unknownRepo');
  assert.equal((await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'claude', sessionId: 'ghost' })).error, 'noTab');
  assert.deepEqual(Object.keys(s.controllers), []);
});

test('start: a folder without .git is refused (D4: plan only never creates a repo)', async (t) => {
  const s = setup({ withGit: false });
  t.after(s.cleanup);
  assert.equal((await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'claude', sessionId: 'tab-a' })).error, 'noRepo');
});

test('start: claude planner runs on the tool env, free planner on the plan profile env', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const res = await s.invoke('orchestra:planRun:start', { request: '  plan auth  ', planner: 'claude', sessionId: 'tab-a' });
  assert.equal(res.ok, true);
  const [ctx] = s.controllers.alpha.calls;
  assert.deepEqual(ctx, { projectId: 'alpha', repoPath: s.repo, env: { PATH: 'tool' }, request: 'plan auth', planner: 'claude', planRunRequest: true });
  assert.deepEqual(s.out.cues, ['sfx.terminalNew']);
  assert.ok(s.out.sent.some(([ch]) => ch === 'orchestra:changed'));

  await s.invoke('orchestra:planRun:start', { request: 'plan more', planner: 'free', repoPath: s.repo });
  assert.deepEqual(s.controllers.alpha.calls[1].env, { ANTHROPIC_MODEL: 'auto:easy' });
});

test('start: free planner without the plan profile is refused', async (t) => {
  const s = setup({ planRunEnv: () => null });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'free', sessionId: 'tab-a' }), { ok: false, error: 'noPlanProfile' });
});

test('start: a controller refusal is passed back without a cue', async (t) => {
  const s = setup({ fail: 'busy' });
  t.after(s.cleanup);
  assert.deepEqual(await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'claude', sessionId: 'tab-a' }), { ok: false, error: 'busy' });
  assert.deepEqual(s.out.cues, []);
});

test('openDoc: only a doc of the run view, as a plain file in the run copy folder', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.invoke('orchestra:planRun:start', { request: 'plan it', planner: 'claude', sessionId: 'tab-a' });
  s.state.view.planRun.docs = [{ id: 'auth-flow', file: 'auth-flow.md', path: 'docs/plans/r/auth-flow.md', branch: null }];
  const opts = { projectId: 'alpha' };

  assert.equal((await s.invoke('orchestra:planRun:openDoc', '../x', 'auth-flow', opts)).error, 'badId');
  assert.equal((await s.invoke('orchestra:planRun:openDoc', 'run1', 42, opts)).error, 'badId');
  // Copy not saved yet.
  assert.equal((await s.invoke('orchestra:planRun:openDoc', 'run1', 'auth-flow', opts)).error, 'noDoc');
  // Not a doc of this run.
  assert.equal((await s.invoke('orchestra:planRun:openDoc', 'run1', 'synthesis', opts)).error, 'noDoc');

  const dir = path.join(s.runsDir, 'run1-plan');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'auth-flow.md'), '# Auth\n');
  assert.deepEqual(await s.invoke('orchestra:planRun:openDoc', 'run1', 'auth-flow', opts), { ok: true });
  assert.deepEqual(s.out.opened, [path.join(dir, 'auth-flow.md')]);

  // A directory in place of the file is never opened.
  s.state.view.planRun.docs.push({ id: 'critique', file: 'CRITIQUE.md', path: 'docs/plans/r/CRITIQUE.md', branch: null });
  fs.mkdirSync(path.join(dir, 'CRITIQUE.md'));
  assert.equal((await s.invoke('orchestra:planRun:openDoc', 'run1', 'critique', opts)).error, 'noDoc');
  assert.equal(s.out.opened.length, 1);
});
