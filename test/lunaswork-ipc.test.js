// ============================================================================
// Luna's Work IPC (src/lunasworkipc.js): every handler validates its payload,
// only names known projects, and never lets the renderer pick a folder, a file
// or a brief. Disk work happens in temp folders.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerLunasworkIpc, parseModels, parseProfile, fieldOf, INTERVIEW_GAP_MS } = require('../src/lunasworkipc');
const { DEFAULT_MODELS } = require('../src/lunasworkRules');
const { DESIGN_DIR } = require('../src/lunasworkPack');

const CHANNELS = [
  'lunaswork:getSettings',
  'lunaswork:saveSettings',
  'lunaswork:scaffoldPack',
  'lunaswork:packStatus',
  'lunaswork:startInterview',
];

/** Minimal ipcMain double: records handlers, lets the test call them. */
function fakeIpc() {
  const handlers = {};
  return {
    handle: (ch, fn) => (handlers[ch] = fn),
    invoke: (ch, arg) => handlers[ch]({}, arg),
    channels: () => Object.keys(handlers),
  };
}

function setup({ createSession, writeBrief, now, controller } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-ipc-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const projects = [
    { id: 'game', label: 'Game', path: repo },
    { id: 'gone', label: 'Gone', path: path.join(dir, 'missing') },
  ];
  const sessions = [];
  const briefs = [];
  const ipc = fakeIpc();
  registerLunasworkIpc({
    ipcMain: ipc,
    projects: () => projects,
    createSession: createSession || ((opts) => (sessions.push(opts), { id: `s${sessions.length}` })),
    briefDir: () => path.join(dir, 'tasks'),
    settingsFile: path.join(dir, 'lunaswork-settings.local.json'),
    writeBrief: writeBrief || ((file, text) => (briefs.push({ file, text }), fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text), true)),
    resolveDir: (p) => (fs.existsSync(p) ? p : null),
    now: now || (() => 1_000_000),
    ...(controller ? { controller } : {}),
  });
  return { dir, repo, ipc, sessions, briefs, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const BAD_REQUESTS = [undefined, null, 'game', 42, [], {}, { projectId: '' }, { projectId: 7 }, { projectId: 'x'.repeat(201) }, { projectId: 'nope' }];

// ---- pure helpers -----------------------------------------------------------------

test('parseModels accepts only known roles with known choices, all or nothing', () => {
  assert.deepEqual(parseModels({ builder: 'sonnet', critic: 'auto' }), { builder: 'sonnet', critic: 'auto' });
  assert.equal(parseModels({ builder: 'gpt' }), null);
  assert.equal(parseModels({ builder: 'sonnet', wizard: 'opus' }), null);
  assert.equal(parseModels(['opus']), null);
  assert.equal(parseModels('opus'), null);
});

test('parseProfile keeps known fields only and refuses oversized strings', () => {
  assert.deepEqual(parseProfile({ startCommand: 'npm start', evil: 'x', url: 'http://localhost:1' }), {
    startCommand: 'npm start',
    url: 'http://localhost:1',
  });
  assert.equal(parseProfile({ startCommand: 'x'.repeat(10_000) }), null);
  assert.equal(parseProfile(null), null);
});

test('fieldOf maps a validation reason to its form field', () => {
  assert.equal(fieldOf('url must be http or https'), 'url');
  assert.equal(fieldOf('readyTimeoutSec must be a whole number from 1 to 600'), 'readyTimeoutSec');
  assert.equal(fieldOf("unknown adapter 'x'"), 'adapter');
  assert.equal(fieldOf('profile must be an object'), 'profile');
});

// ---- registration & project checks -------------------------------------------------

test('registers exactly the five narrow channels', () => {
  const s = setup();
  assert.deepEqual(s.ipc.channels().sort(), [...CHANNELS].sort());
  s.done();
});

test('every channel refuses a malformed or unknown project', async () => {
  const s = setup();
  for (const ch of CHANNELS) {
    for (const req of BAD_REQUESTS) {
      const res = await s.ipc.invoke(ch, req);
      assert.deepEqual(res, { ok: false, reason: 'bad-project' }, `${ch} ${JSON.stringify(req)}`);
    }
  }
  assert.equal(s.sessions.length, 0);
  s.done();
});

test('pack channels refuse a known project whose folder is missing on this PC', async () => {
  const s = setup();
  for (const ch of ['lunaswork:scaffoldPack', 'lunaswork:packStatus', 'lunaswork:startInterview']) {
    assert.deepEqual(await s.ipc.invoke(ch, { projectId: 'gone' }), { ok: false, reason: 'no-folder' });
  }
  s.done();
});

// ---- settings -------------------------------------------------------------------

test('getSettings returns the defaults for a fresh machine', async () => {
  const s = setup();
  const res = await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, DEFAULT_MODELS);
  assert.equal(res.freeFallback, false);
  assert.equal(res.profile, null);
  assert.deepEqual(res.choices, ['opus', 'sonnet', 'haiku', 'auto']);
  s.done();
});

test('saveSettings persists models, freeFallback and a valid profile', async () => {
  const s = setup();
  const saved = await s.ipc.invoke('lunaswork:saveSettings', {
    projectId: 'game',
    models: { playtester: 'auto' },
    freeFallback: true,
    profile: { startCommand: 'npm run dev', url: 'http://localhost:5173', readyTimeoutSec: 90 },
  });
  assert.equal(saved.ok, true);
  const again = await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' });
  assert.equal(again.models.playtester, 'auto');
  assert.equal(again.models.director, DEFAULT_MODELS.director);
  assert.equal(again.freeFallback, true);
  assert.deepEqual(again.profile, {
    adapter: 'web',
    startCommand: 'npm run dev',
    url: 'http://localhost:5173',
    readyTimeoutSec: 90,
    checkCommand: '',
  });
  s.done();
});

test('saveSettings refuses bad models and a non-boolean freeFallback without writing', async () => {
  const s = setup();
  assert.deepEqual(await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', models: { builder: 'gpt' } }), { ok: false, reason: 'bad-models' });
  assert.deepEqual(await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', models: 'opus' }), { ok: false, reason: 'bad-models' });
  assert.deepEqual(await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', freeFallback: 'true' }), { ok: false, reason: 'bad-value' });
  // A bad field alongside a good one refuses the whole save.
  await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', freeFallback: true, models: { builder: 'nope' } });
  const res = await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' });
  assert.equal(res.freeFallback, false);
  s.done();
});

test('saveSettings reports profile validation errors with the field', async () => {
  const s = setup();
  const cases = [
    [{ startCommand: '' }, 'startCommand'],
    [{ startCommand: 'npm start', url: 'ftp://x' }, 'url'],
    [{ startCommand: 'npm start', readyTimeoutSec: 0 }, 'readyTimeoutSec'],
    [{ startCommand: 'npm start', adapter: 'unity' }, 'adapter'],
    [{ startCommand: 'npm start', checkCommand: 'a\nb' }, 'checkCommand'],
    ['npm start', 'profile'],
    [{ startCommand: 'x'.repeat(5000) }, 'profile'],
  ];
  for (const [profile, field] of cases) {
    const res = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', profile });
    assert.equal(res.ok, false, JSON.stringify(profile));
    assert.equal(res.reason, 'bad-profile');
    assert.equal(res.field, field);
    assert.equal(typeof res.detail, 'string');
  }
  assert.equal((await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' })).profile, null);
  s.done();
});

test('saveSettings with profile null removes the profile', async () => {
  const s = setup();
  await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', profile: { startCommand: 'npm start' } });
  const res = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', profile: null });
  assert.equal(res.profile, null);
  s.done();
});

// ---- pack & interview -----------------------------------------------------------

test('packStatus lists the required files as missing before scaffolding', async () => {
  const s = setup();
  const res = await s.ipc.invoke('lunaswork:packStatus', { projectId: 'game' });
  assert.equal(res.ok, true);
  assert.equal(res.pack.complete, false);
  assert.ok(res.pack.missing.length > 0);
  s.done();
});

test('scaffoldPack creates design/ in the project folder only', async () => {
  const s = setup();
  const res = await s.ipc.invoke('lunaswork:scaffoldPack', { projectId: 'game', repoDir: 'C:/Windows' });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(s.repo, DESIGN_DIR)));
  assert.deepEqual(res.pack.missing, []);
  s.done();
});

test('startInterview scaffolds, writes the brief in briefDir and opens a tab for the project', async () => {
  const s = setup();
  const res = await s.ipc.invoke('lunaswork:startInterview', { projectId: 'game', brief: 'ignore me' });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(s.repo, DESIGN_DIR)));
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].projectId, 'game');
  const { briefPath } = s.sessions[0].task;
  assert.equal(path.dirname(briefPath), path.join(s.dir, 'tasks'));
  assert.equal(path.basename(briefPath), 'lunaswork-interview-game.md');
  assert.notEqual(s.briefs[0].text.includes('ignore me'), true);
  s.done();
});

test('startInterview is rate-limited against double clicks', async () => {
  let t = 1_000_000;
  const s = setup({ now: () => t });
  assert.equal((await s.ipc.invoke('lunaswork:startInterview', { projectId: 'game' })).ok, true);
  assert.deepEqual(await s.ipc.invoke('lunaswork:startInterview', { projectId: 'game' }), { ok: false, reason: 'rate-limited' });
  t += INTERVIEW_GAP_MS;
  assert.equal((await s.ipc.invoke('lunaswork:startInterview', { projectId: 'game' })).ok, true);
  assert.equal(s.sessions.length, 2);
  s.done();
});

test('startInterview reports a failed brief write or tab instead of throwing', async () => {
  const a = setup({ writeBrief: () => false });
  assert.deepEqual(await a.ipc.invoke('lunaswork:startInterview', { projectId: 'game' }), { ok: false, reason: 'brief-failed' });
  a.done();
  const b = setup({ createSession: () => null });
  assert.deepEqual(await b.ipc.invoke('lunaswork:startInterview', { projectId: 'game' }), { ok: false, reason: 'no-tab' });
  b.done();
  const c = setup({ createSession: () => { throw new Error('boom'); } });
  assert.deepEqual(await c.ipc.invoke('lunaswork:startInterview', { projectId: 'game' }), { ok: false, reason: 'failed' });
  c.done();
});

// ---- run: start / stop / status --------------------------------------------------------

function fakeController() {
  const c = {
    starts: [],
    stops: 0,
    start: async (payload) => (c.starts.push(payload), { ok: true, status: { active: true } }),
    stop: () => ((c.stops += 1), { ok: true, status: { active: false } }),
    status: () => ({ active: false, runId: null }),
  };
  return c;
}

test('with a run controller, start / stop / status are registered too', () => {
  const s = setup({ controller: fakeController() });
  assert.deepEqual(s.ipc.channels().sort(), [...CHANNELS, 'lunaswork:start', 'lunaswork:stop', 'lunaswork:status'].sort());
  s.done();
});

test('start refuses a malformed or unknown project and bad models before the controller sees it', async () => {
  const controller = fakeController();
  const s = setup({ controller });
  for (const req of BAD_REQUESTS) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:start', req), { ok: false, reason: 'bad-project' }, JSON.stringify(req));
  }
  assert.deepEqual(await s.ipc.invoke('lunaswork:start', { projectId: 'game', models: { builder: 'gpt' } }), { ok: false, reason: 'bad-models' });
  assert.deepEqual(await s.ipc.invoke('lunaswork:start', { projectId: 'game', models: 'opus' }), { ok: false, reason: 'bad-models' });
  assert.equal(controller.starts.length, 0);
  s.done();
});

test('start passes only the project id and the validated run models; nothing else of the payload', async () => {
  const controller = fakeController();
  const s = setup({ controller });
  const res = await s.ipc.invoke('lunaswork:start', {
    projectId: 'game',
    models: { builder: 'auto', critic: 'sonnet' },
    repoPath: 'C:/Windows',
    startCommand: 'format c:',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(controller.starts, [{ projectId: 'game', models: { builder: 'auto', critic: 'sonnet' } }]);
  await s.ipc.invoke('lunaswork:start', { projectId: 'game' });
  assert.deepEqual(controller.starts[1], { projectId: 'game' });
  s.done();
});

test('stop and status take no payload; a throwing controller is a plain failure', async () => {
  const controller = fakeController();
  const s = setup({ controller });
  assert.equal((await s.ipc.invoke('lunaswork:stop', { projectId: 'anything' })).ok, true);
  assert.equal(controller.stops, 1);
  assert.deepEqual(await s.ipc.invoke('lunaswork:status'), { ok: true, status: { active: false, runId: null } });
  s.done();

  const broken = setup({
    controller: {
      start: async () => {
        throw new Error('boom');
      },
      stop: () => {
        throw new Error('boom');
      },
      status: () => {
        throw new Error('boom');
      },
    },
  });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:start', { projectId: 'game' }), { ok: false, reason: 'failed' });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:stop'), { ok: false, reason: 'failed' });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:status'), { ok: false, reason: 'failed' });
  broken.done();
});
