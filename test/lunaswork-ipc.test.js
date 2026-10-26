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

const { registerLunasworkIpc, parseModels, parseProfile, parseSteerText, parseWheelRequest, fieldOf, INTERVIEW_GAP_MS } = require('../src/lunasworkipc');
const { publicStatus, publicEvent, evidenceDirOf } = require('../src/lunasworkStatus');
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

function setup({ createSession, writeBrief, now, controller, extra } = {}) {
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
    ...(typeof extra === 'function' ? extra(dir) : extra || {}),
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

test('LW 2.25: the design-variants and mockup-first toggles are off by default, per project, booleans only', async () => {
  const s = setup();
  const fresh = await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' });
  assert.equal(fresh.designVariants, false);
  assert.equal(fresh.mockupFirst, false);
  const saved = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', designVariants: true, mockupFirst: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.designVariants, true);
  assert.equal(saved.mockupFirst, true);
  assert.deepEqual(await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', mockupFirst: 'false' }), { ok: false, reason: 'bad-value' });
  const off = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', designVariants: false });
  assert.equal(off.designVariants, false);
  assert.equal(off.mockupFirst, true, 'a refused save changed nothing');
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

// ---- HUD panel (slice 1.7): public status, event push, steer, evidence -----------------

const RAW_STATUS = {
  active: true,
  runId: 'abc123',
  projectId: 'game',
  repoPath: 'C:/secret/repo',
  iteration: 3,
  phase: 'building',
  role: 'builder',
  models: { builder: 'sonnet', critic: 'gpt-9', wizard: 'opus' },
  modelSources: { builder: 'run', critic: 'hacked' },
  verdict: 'ship',
  phaseStartedAt: 5000,
  waitUntil: 9000,
  scores: { m1: [{ n: 1, score: 40 }, { n: 2, score: 'x' }, { n: 3, score: 55 }] },
  evidenceDir: 'C:/runs/lunaswork-abc123/iter-3',
  profile: { startCommand: 'npm start' },
  pendingDecisions: 2,
};

test('publicStatus keeps known roles, models, phases and projects only, and hides paths', () => {
  const out = publicStatus(RAW_STATUS, (id) => id === 'game');
  assert.deepEqual(out.models, { builder: 'sonnet' });
  assert.deepEqual(out.modelSources, { builder: 'run' });
  assert.equal(out.phase, 'building');
  assert.equal(out.role, 'builder');
  assert.equal(out.projectId, 'game');
  assert.equal(out.waitUntil, 9000);
  assert.deepEqual(out.scores, { m1: [{ n: 1, score: 40 }, { n: 3, score: 55 }] });
  assert.equal(out.hasEvidence, true);
  assert.equal(out.pendingDecisions, 2);
  for (const key of ['evidenceDir', 'repoPath', 'profile']) assert.equal(key in out, false, key);

  const odd = publicStatus(
    { ...RAW_STATUS, phase: 'hacking', role: 'god', verdict: 'win', projectId: 'nope', pendingDecisions: undefined },
    () => false,
  );
  assert.equal(odd.phase, null);
  assert.equal(odd.role, null);
  assert.equal(odd.verdict, null);
  assert.equal(odd.projectId, null);
  assert.equal('pendingDecisions' in odd, false);
  assert.deepEqual(publicStatus({ runId: '../x' }, () => true), { active: false, runId: null });
  assert.deepEqual(publicStatus(null, () => true), { active: false, runId: null });
});

test('publicEvent passes known event types only', () => {
  assert.equal(publicEvent({ type: 'phase', status: RAW_STATUS }, () => true).type, 'phase');
  assert.equal(publicEvent({ type: 'evil', status: RAW_STATUS }, () => true), null);
  assert.equal(publicEvent('phase', () => true), null);
});

test('evidenceDirOf only allows a folder inside the current run folder', () => {
  const root = path.resolve(os.tmpdir(), 'lw-runs');
  const inside = path.join(root, 'lunaswork-abc123', 'iter-3');
  const yes = () => true;
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: inside }, root, yes), inside);
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: path.join(root, 'lunaswork-abc123', '..', '..', 'x') }, root, yes), null);
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: path.join(root, 'lunaswork-other', 'i') }, root, yes), null);
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: path.join(root, 'lunaswork-abc123') }, root, yes), null);
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: inside }, 'relative/root', yes), null);
  assert.equal(evidenceDirOf({ runId: 'abc123', evidenceDir: inside }, root, () => false), null);
});

test('parseSteerText takes one trimmed line within the limit', () => {
  assert.equal(parseSteerText('  fix the menu  '), 'fix the menu');
  for (const bad of [undefined, 42, '', '   ', 'a\nb', 'x'.repeat(1001)]) {
    assert.equal(parseSteerText(bad), null, JSON.stringify(bad));
  }
});

function panelSetup({ controller, list = [], write } = {}) {
  const sent = [];
  const writes = [];
  const changed = [];
  const opened = [];
  const ctl = controller || fakeController();
  let listener = null;
  ctl.subscribe = (fn) => (listener = fn);
  const s = setup({
    controller: ctl,
    extra: (dir) => ({
      send: (ch, payload) => sent.push({ ch, payload }),
      todos: {
        read: () => list,
        write: write || ((id, next) => (writes.push({ id, next }), true)),
        changed: (id) => changed.push(id),
      },
      runsRoot: () => path.join(dir, 'runs'),
      openPath: (p) => (opened.push(p), ''),
    }),
  });
  return { ...s, ctl, sent, writes, changed, opened, emit: (e) => listener(e) };
}

test('with the panel deps, steer and openEvidence are registered and events push on lunaswork:event', () => {
  const s = panelSetup();
  assert.ok(s.ipc.channels().includes('lunaswork:steer'));
  assert.ok(s.ipc.channels().includes('lunaswork:openEvidence'));
  s.emit({ type: 'phase', status: RAW_STATUS });
  s.emit({ type: 'bogus', status: RAW_STATUS });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].ch, 'lunaswork:event');
  assert.equal(s.sent[0].payload.status.projectId, 'game');
  assert.equal('evidenceDir' in s.sent[0].payload.status, false);
  s.done();
});

test('start / stop / status answers carry the public status only', async () => {
  const controller = fakeController();
  controller.start = async () => ({ ok: true, status: RAW_STATUS });
  controller.status = () => RAW_STATUS;
  const s = panelSetup({ controller });
  const started = await s.ipc.invoke('lunaswork:start', { projectId: 'game' });
  assert.equal('repoPath' in started.status, false);
  assert.deepEqual(started.status.models, { builder: 'sonnet' });
  assert.equal('evidenceDir' in (await s.ipc.invoke('lunaswork:status')).status, false);
  s.done();
});

test('steer validates project and text, then appends one steer card with a fresh id', async () => {
  const s = panelSetup({ list: [{ text: 'old', done: false, at: 1_000_000 }] });
  for (const req of BAD_REQUESTS) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:steer', req), { ok: false, reason: 'bad-project' }, JSON.stringify(req));
  }
  assert.deepEqual(await s.ipc.invoke('lunaswork:steer', { projectId: 'game', text: 'a\nb' }), { ok: false, reason: 'bad-text' });
  assert.equal(s.writes.length, 0);
  const res = await s.ipc.invoke('lunaswork:steer', { projectId: 'game', text: ' fix the menu ', tags: ['evil'], at: 1 });
  assert.deepEqual(res, { ok: true });
  assert.equal(s.writes.length, 1);
  assert.deepEqual(s.writes[0].next[1], { text: 'fix the menu', done: false, at: 1_000_001, tags: ['steer'] });
  assert.deepEqual(s.changed, ['game']);
  s.done();
});

test('steer refuses a full list and reports a failed write', async () => {
  const full = panelSetup({ list: Array.from({ length: 100 }, (_, i) => ({ text: `t${i}`, done: false, at: i })) });
  assert.deepEqual(await full.ipc.invoke('lunaswork:steer', { projectId: 'game', text: 'x' }), { ok: false, reason: 'list-full' });
  full.done();
  const broken = panelSetup({ write: () => false });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:steer', { projectId: 'game', text: 'x' }), { ok: false, reason: 'write-failed' });
  assert.deepEqual(broken.changed, []);
  broken.done();
});

test('openEvidence opens only the current run folder inside the runs root', async () => {
  const controller = fakeController();
  const s = panelSetup({ controller });
  assert.deepEqual(await s.ipc.invoke('lunaswork:openEvidence'), { ok: false, reason: 'no-evidence' });
  const inside = path.join(s.dir, 'runs', 'lunaswork-abc123', 'iter-3');
  fs.mkdirSync(inside, { recursive: true });
  controller.status = () => ({ ...RAW_STATUS, evidenceDir: inside });
  assert.deepEqual(await s.ipc.invoke('lunaswork:openEvidence', { dir: 'C:/Windows' }), { ok: true });
  assert.deepEqual(s.opened, [inside]);
  controller.status = () => ({ ...RAW_STATUS, evidenceDir: s.dir });
  assert.deepEqual(await s.ipc.invoke('lunaswork:openEvidence'), { ok: false, reason: 'no-evidence' });
  controller.status = () => ({ ...RAW_STATUS, projectId: 'nope', evidenceDir: inside });
  assert.deepEqual(await s.ipc.invoke('lunaswork:openEvidence'), { ok: false, reason: 'no-evidence' });
  assert.equal(s.opened.length, 1);
  s.done();
});

test('saveSettings stores a project model override from the start dialog; null clears it', async () => {
  const s = setup();
  const saved = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', projectModels: { critic: 'haiku' } });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.projectModels, { critic: 'haiku' });
  assert.deepEqual((await s.ipc.invoke('lunaswork:getSettings', { projectId: 'game' })).projectModels, { critic: 'haiku' });
  assert.deepEqual(
    await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', projectModels: { critic: 'gpt' } }),
    { ok: false, reason: 'bad-models' },
  );
  const cleared = await s.ipc.invoke('lunaswork:saveSettings', { projectId: 'game', projectModels: null });
  assert.deepEqual(cleared.projectModels, {});
  s.done();
});

// ---- hand me the wheel (C11) --------------------------------------------------------

test('parseWheelRequest: nothing, or {runId} naming a run - anything else is refused', () => {
  assert.deepEqual(parseWheelRequest(undefined), {});
  assert.deepEqual(parseWheelRequest(null), {});
  assert.deepEqual(parseWheelRequest({}), {});
  assert.deepEqual(parseWheelRequest({ runId: 'lwabc123' }), { runId: 'lwabc123' });
  for (const bad of ['lwabc', 42, [], { runId: '' }, { runId: 'LW-1' }, { runId: 'x'.repeat(41) }, { runId: 7 }, { runId: 'lwa', projectId: 'game' }, { repoPath: 'C:/' }]) {
    assert.equal(parseWheelRequest(bad), null, JSON.stringify(bad));
  }
});

function wheelController() {
  const c = {
    ...fakeController(),
    wheel: [],
    handOver: async (payload) => (c.wheel.push(['handOver', payload]), { ok: true, status: { active: true, runId: 'lwabc123', wheel: 'requested', evidenceDir: 'C:/secret' } }),
    handBack: async (payload) => (c.wheel.push(['handBack', payload]), { ok: false, reason: 'notHanded', message: 'The run has the wheel.' }),
  };
  return c;
}

test('handOver / handBack are registered with a controller that has them', () => {
  const s = setup({ controller: wheelController() });
  assert.ok(s.ipc.channels().includes('lunaswork:handOver'));
  assert.ok(s.ipc.channels().includes('lunaswork:handBack'));
  s.done();
});

test('handOver / handBack refuse a malformed payload before the controller sees it', async () => {
  const controller = wheelController();
  const s = setup({ controller });
  for (const ch of ['lunaswork:handOver', 'lunaswork:handBack']) {
    for (const req of ['lwabc', 7, [], { runId: '../x' }, { runId: 'lwa', repoPath: 'C:/' }]) {
      assert.deepEqual(await s.ipc.invoke(ch, req), { ok: false, reason: 'bad-run' }, `${ch} ${JSON.stringify(req)}`);
    }
  }
  assert.equal(controller.wheel.length, 0);
  s.done();
});

test('handOver / handBack pass only the run id; the answer carries the public status only', async () => {
  const controller = wheelController();
  const s = setup({ controller });
  const res = await s.ipc.invoke('lunaswork:handOver', { runId: 'lwabc123' });
  assert.equal(res.ok, true);
  assert.equal(res.status.wheel, 'requested');
  assert.equal('evidenceDir' in res.status, false, 'the evidence folder never leaves main');
  await s.ipc.invoke('lunaswork:handOver');
  assert.deepEqual(controller.wheel, [['handOver', { runId: 'lwabc123' }], ['handOver', {}]]);
  assert.deepEqual(await s.ipc.invoke('lunaswork:handBack', {}), { ok: false, reason: 'notHanded', message: 'The run has the wheel.' });
  s.done();

  const broken = setup({ controller: { ...fakeController(), handOver: async () => { throw new Error('boom'); }, handBack: () => { throw new Error('boom'); } } });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:handOver'), { ok: false, reason: 'failed' });
  assert.deepEqual(await broken.ipc.invoke('lunaswork:handBack'), { ok: false, reason: 'failed' });
  broken.done();
});

test('publicStatus: the wheel only from its known states, handedAt only as a time; the wheel event is pushed', () => {
  const base = { runId: 'lwabc123', active: true };
  assert.equal(publicStatus({ ...base, wheel: 'handed', handedAt: 5 }, () => true).wheel, 'handed');
  assert.equal(publicStatus({ ...base, wheel: 'handed', handedAt: 5 }, () => true).handedAt, 5);
  assert.equal(publicStatus({ ...base, wheel: '<img>', handedAt: 'soon' }, () => true).wheel, 'running');
  assert.equal(publicStatus({ ...base, handedAt: -1 }, () => true).handedAt, null);
  assert.equal(publicEvent({ type: 'wheel', status: base }, () => true).type, 'wheel');
});

// ---- LW 2.17a: dashboard + screenshot evidence IPC --------------------------------------

const { screenshotFile, readScreenshot, dashboardView, MAX_SCREENSHOT_BYTES } = require('../src/lunasworkDashboardView');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** <runsRoot>/lunaswork-abc123/iter-1/home.png, plus files outside the run folder. */
function evidenceTree(dir) {
  const runsRoot = path.join(dir, 'runs');
  const iter = path.join(runsRoot, 'lunaswork-abc123', 'iter-1');
  fs.mkdirSync(iter, { recursive: true });
  fs.writeFileSync(path.join(iter, 'home.png'), PNG);
  fs.writeFileSync(path.join(iter, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(runsRoot, 'lunaswork-other1'), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, 'lunaswork-other1', 'x.png'), PNG);
  fs.writeFileSync(path.join(dir, 'secret.png'), PNG);
  return { runsRoot, iter };
}

test('screenshotFile serves an image inside the run folder only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-shot-'));
  try {
    const { runsRoot, iter } = evidenceTree(dir);
    const ok = screenshotFile({ runId: 'abc123', file: 'iter-1/home.png' }, runsRoot);
    assert.equal(ok.mime, 'image/png');
    assert.equal(ok.file, fs.realpathSync(path.join(iter, 'home.png')));
    // Windows separators are fine as long as the path stays inside.
    assert.ok(screenshotFile({ runId: 'abc123', file: 'iter-1\\home.png' }, runsRoot));
    const refused = [
      { runId: 'abc123', file: '../secret.png' },
      { runId: 'abc123', file: 'iter-1/../../secret.png' },
      { runId: 'abc123', file: '../lunaswork-other1/x.png' },
      { runId: 'abc123', file: '..\\..\\secret.png' },
      { runId: 'abc123', file: path.join(dir, 'secret.png') },
      { runId: 'abc123', file: '/etc/passwd.png' },
      { runId: 'abc123', file: 'C:secret.png' },
      { runId: 'abc123', file: 'iter-1/notes.txt' },
      { runId: 'abc123', file: 'iter-1/missing.png' },
      { runId: 'abc123', file: 'iter-1' },
      { runId: 'abc123', file: 'iter-1/home.png\u0000.png' },
      { runId: 'abc123', file: '' },
      { runId: 'abc123', file: 7 },
      { runId: '../runs', file: 'x.png' },
      { runId: 'ABC123', file: 'iter-1/home.png' },
      { runId: 'abc/123', file: 'iter-1/home.png' },
      { runId: 'nope99', file: 'iter-1/home.png' },
      null,
      'iter-1/home.png',
    ];
    for (const req of refused) assert.equal(screenshotFile(req, runsRoot), null, JSON.stringify(req));
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/home.png' }, 'relative/runs'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshotFile refuses symlinks and junctions, even ones pointing inside', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-shot-link-'));
  try {
    const { runsRoot, iter } = evidenceTree(dir);
    // A folder junction leading out of the run folder (no admin rights needed on Windows).
    fs.symlinkSync(dir, path.join(iter, 'out'), 'junction');
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/out/secret.png' }, runsRoot), null);
    try {
      fs.symlinkSync(path.join(dir, 'secret.png'), path.join(iter, 'leak.png'));
      fs.symlinkSync(path.join(iter, 'home.png'), path.join(iter, 'alias.png'));
    } catch {
      // File symlinks need Developer Mode or admin rights on Windows.
      t.diagnostic('file symlinks not available here; the junction case was checked');
      return;
    }
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/leak.png' }, runsRoot), null);
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/alias.png' }, runsRoot), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshotFile refuses NTFS streams and hardlinks; readScreenshot wants real image bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-shot-hard-'));
  try {
    const { runsRoot, iter } = evidenceTree(dir);
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/notes.txt:x.png' }, runsRoot), null);
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/home.png::$DATA' }, runsRoot), null);
    fs.linkSync(path.join(dir, 'secret.png'), path.join(iter, 'hard.png'));
    assert.equal(screenshotFile({ runId: 'abc123', file: 'iter-1/hard.png' }, runsRoot), null);
    // A text file named .png is no screenshot.
    fs.writeFileSync(path.join(iter, 'fake.png'), 'not an image');
    assert.ok(screenshotFile({ runId: 'abc123', file: 'iter-1/fake.png' }, runsRoot), 'the path itself is fine');
    assert.equal(readScreenshot({ runId: 'abc123', file: 'iter-1/fake.png' }, runsRoot), null);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    fs.writeFileSync(path.join(iter, 'shot.jpg'), jpeg);
    assert.equal(readScreenshot({ runId: 'abc123', file: 'iter-1/shot.jpg' }, runsRoot), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
    // Over the size cap.
    fs.writeFileSync(path.join(iter, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    assert.equal(readScreenshot({ runId: 'abc123', file: 'iter-1/huge.png' }, runsRoot), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lunaswork:screenshot returns a data URL for an image of the current run and refuses anything else', async () => {
  const controller = fakeController();
  const s = panelSetup({ controller });
  const { iter } = evidenceTree(s.dir);
  assert.ok(s.ipc.channels().includes('lunaswork:screenshot'));
  const req = { runId: 'abc123', file: 'iter-1/home.png' };
  assert.deepEqual(await s.ipc.invoke('lunaswork:screenshot', req), { ok: false, reason: 'bad-file' }, 'no run -> nothing served');
  controller.snapshot = () => ({ id: 'abc123', projectId: 'game' });
  const res = await s.ipc.invoke('lunaswork:screenshot', req);
  assert.equal(res.ok, true);
  assert.equal(res.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  const refused = [
    undefined,
    {},
    { runId: 'abc123', file: '../../secret.png' },
    { runId: 'abc123', file: path.join(iter, 'home.png') },
    // Another (older) run's folder, though it exists and holds a PNG.
    { runId: 'other1', file: 'x.png' },
  ];
  for (const r of refused) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:screenshot', r), { ok: false, reason: 'bad-file' }, JSON.stringify(r));
  }
  // The current run of a project that is no longer registered.
  controller.snapshot = () => ({ id: 'abc123', projectId: 'nope' });
  assert.deepEqual(await s.ipc.invoke('lunaswork:screenshot', req), { ok: false, reason: 'bad-file' });
  s.done();
});

test('lunaswork:dashboard: the run view with usage, timeline, cards and in-run screenshots only', async () => {
  const controller = fakeController();
  const s = panelSetup({ controller });
  assert.deepEqual(await s.ipc.invoke('lunaswork:dashboard'), { ok: true, dashboard: null }, 'no snapshot seam -> no run');
  const runDir = path.join(s.dir, 'runs', 'lunaswork-abc123');
  controller.snapshot = () => ({
    id: 'abc123',
    projectId: 'game',
    phase: 'building',
    iteration: 2,
    milestone: 'm1',
    history: [{ n: 1, milestone: 'm1', score: 40 }, { n: 2, milestone: 'm1', score: 55 }],
    laps: [{
      n: 1, milestone: 'm1', score: 40, cardsOpened: 2, cardsClosed: [5], selfCheck: 'green', criticVerdict: 'continue', rolledBack: true,
      screens: [
        { name: 'home-desktop', screenshot: path.join(runDir, 'iter-1', 'home.png') },
        { name: 'leak-desktop', screenshot: path.join(s.dir, 'secret.png') },
      ],
    }],
    usage: {
      total: { calls: 1, inputTokens: 10, costUsd: 0.1 },
      byRole: { director: { calls: 1, inputTokens: 10, costUsd: 0.1 } },
      iterations: [{ n: 1, byRole: {}, phases: { building: 1000 } }],
    },
    lighthouse: [{ iteration: 1, results: [] }],
    evidenceDir: runDir,
  });
  const res = await s.ipc.invoke('lunaswork:dashboard');
  assert.equal(res.ok, true);
  const d = res.dashboard;
  assert.equal(d.runId, 'abc123');
  assert.equal(d.projectId, 'game');
  assert.deepEqual(d.scores, { m1: [{ n: 1, score: 40 }, { n: 2, score: 55 }] });
  assert.equal(d.usage.byRole.director.inputTokens, 10);
  assert.deepEqual(d.cards, { series: [{ n: 1, opened: 2, closed: 1 }], opened: 2, closed: 1 });
  assert.equal(d.timeline[0].rolledBack, true);
  assert.deepEqual(d.timeline[0].phases, { building: 1000 });
  assert.deepEqual(d.screenshots, [{ name: 'home', n: 1, file: 'iter-1/home.png' }], 'a shot outside the run folder never leaves main');
  assert.equal(d.shipEstimate, null);
  assert.equal(JSON.stringify(d).includes(s.dir), false, 'no absolute path reaches the renderer');
  controller.snapshot = () => {
    throw new Error('boom');
  };
  assert.deepEqual(await s.ipc.invoke('lunaswork:dashboard'), { ok: false, reason: 'failed' });
  s.done();
});

test('dashboardView: no view for a malformed run; unknown project, phase and verdict dropped', () => {
  assert.equal(dashboardView(null, { isKnownProject: () => true }), null);
  assert.equal(dashboardView({ id: '../x' }, { isKnownProject: () => true }), null);
  const v = dashboardView({ id: 'abc', projectId: 'secret', phase: 'evil', verdict: 'nope' }, { isKnownProject: () => false });
  assert.equal(v.projectId, null);
  assert.equal(v.phase, null);
  assert.equal(v.verdict, null);
  assert.deepEqual(v.screenshots, [], 'no runs root -> no screenshots');
});

test('dashboardView: the time-to-SHIP estimate fills the KPI slot (LW 2.22b)', () => {
  const v = dashboardView({ id: 'abc', phase: 'building' }, { isKnownProject: () => true, shipEstimate: { iterations: 3, hours: 2.5, low: 2, high: 4 } });
  assert.equal(v.shipEstimate, 2.5 * 3600 * 1000);
  assert.deepEqual(v.ship, { iterations: 3, hours: 2.5, low: 2, high: 4 });
  const iterOnly = dashboardView({ id: 'abc' }, { isKnownProject: () => true, shipEstimate: { iterations: 2, hours: null, low: null, high: null } });
  assert.equal(iterOnly.shipEstimate, null);
  assert.equal(iterOnly.ship.iterations, 2);
  const none = dashboardView({ id: 'abc' }, { isKnownProject: () => true });
  assert.equal(none.shipEstimate, null);
  assert.equal(none.ship, null);
  assert.equal(dashboardView({ id: 'abc' }, { isKnownProject: () => true, shipEstimate: { iterations: -1 } }).ship, null);
});

// ---- LW 2.27: "Ask Luna about the run" ------------------------------------------

const { parseAskRequest } = require('../src/lunasworkipc');

test('parseAskRequest: exactly {question}, one trimmed line of 1..500 chars', () => {
  assert.deepEqual(parseAskRequest({ question: '  why did you roll back iteration 14?  ' }), { question: 'why did you roll back iteration 14?' });
  assert.deepEqual(parseAskRequest({ question: 'two\nlines' }), { question: 'two lines' });
  assert.equal(parseAskRequest({ question: 'x'.repeat(500) }).question.length, 500);
  for (const bad of [
    undefined, null, 'why?', 42, [], {}, { question: '' }, { question: '   ' }, { question: 7 },
    { question: 'x'.repeat(501) }, { question: 'x'.repeat(5000) }, { question: 'ok', projectId: 'game' }, { question: ['why'] },
  ]) {
    assert.equal(parseAskRequest(bad), null, JSON.stringify(bad));
  }
});

test('lunaswork:ask validates the payload before the service sees it, and passes its answer through', async () => {
  const calls = [];
  const ask = {
    ask: async (question, opts) => {
      calls.push({ question, opts });
      return question === 'limit?' ? { ok: false, reason: 'rate-limited', retryAt: 123 } : { ok: true, item: { id: 1, question, answer: 'because', sources: [{ file: 'rollbacks', iteration: 14 }] } };
    },
  };
  const s = setup({ extra: { ask } });
  assert.ok(s.ipc.channels().includes('lunaswork:ask'));
  for (const bad of [undefined, 'why', { question: '' }, { question: 'x'.repeat(501) }, { question: 'ok', evil: 1 }]) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:ask', bad), { ok: false, reason: 'bad-question' });
  }
  assert.equal(calls.length, 0, 'a bad payload never reaches the service');
  const res = await s.ipc.invoke('lunaswork:ask', { question: '  why roll back?  ' });
  assert.deepEqual(calls[0], { question: 'why roll back?', opts: { from: 'hud' } });
  assert.equal(res.ok, true);
  assert.equal(res.item.answer, 'because');
  assert.deepEqual(await s.ipc.invoke('lunaswork:ask', { question: 'limit?' }), { ok: false, reason: 'rate-limited', retryAt: 123 });
  s.done();
});

test('lunaswork:ask turns a throwing service into a plain failure; no service, no channel', async () => {
  const s = setup({ extra: { ask: { ask: async () => { throw new Error('boom'); } } } });
  assert.deepEqual(await s.ipc.invoke('lunaswork:ask', { question: 'why?' }), { ok: false, reason: 'failed' });
  s.done();
  const none = setup();
  assert.equal(none.ipc.channels().includes('lunaswork:ask'), false);
  none.done();
});
