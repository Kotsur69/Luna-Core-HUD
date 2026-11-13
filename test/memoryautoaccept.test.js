// ============================================================================
// LunaCore - opt-in auto-accept per memory type (src/memoryautoaccept.js),
// its capture landing step, its IPC, its hub item and its log lines
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auto = require('../src/memoryautoaccept.js');
const { registerMemoryIpc } = require('../src/memoryipc.js');
const { createRunCapture } = require('../src/memoryruncapture.js');
const { memoryPaths } = require('../src/memorysync.js');
const { setEnabled } = require('../src/memoryprojects.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { listInbox } = require('../src/memoryinbox.js');
const { createLog, logPath, cleanEvent, DAY_MS } = require('../src/memorylog.js');
const { COLLECTORS } = require('../src/hubcollect.js');

const PROJECT = 'github.com/acme/hud';
const NOW = Date.parse('2026-11-13T08:00:00Z');
const TODAY = '2026-11-13';
const RUN_ID = 'pmabc123';
const REPO = path.resolve('/repos/hud');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: TODAY,
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

/** Log events as memorylog.readLog() returns them. */
const ev = (ev, key, type = 'gotcha', at = NOW - DAY_MS) => ({ at, ev, key, type });
/** `approved` approvals and `rejected` rejections of one type, a day ago. */
function decisions(approved, rejected, { type = 'gotcha', at = NOW - DAY_MS } = {}) {
  return [
    ...Array.from({ length: approved }, (_, i) => ev('approved', `${PROJECT}/a${i}`, type, at)),
    ...Array.from({ length: rejected }, (_, i) => ev('rejected', `${PROJECT}/r${i}`, type, at)),
  ];
}

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A log file filled with `events` (their own times kept). */
function logWith(configDir, events) {
  fs.writeFileSync(logPath(configDir), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return createLog(logPath(configDir), { now: () => NOW });
}

// ---- the eligibility bar ------------------------------------------------------------

test('a type is offered at 20 decisions in 28 days with at least 90% approved', () => {
  const offered = (events) => auto.isOffered(auto.typeStats(events, NOW).gotcha);
  assert.equal(auto.AUTO_MIN_DECISIONS, 20);
  assert.equal(auto.AUTO_WINDOW_DAYS, 28);
  assert.equal(auto.AUTO_ON_RATE, 0.9);

  assert.equal(offered(decisions(18, 2)), true, '20 decisions, 90%');
  assert.equal(offered(decisions(19, 0)), false, 'only 19 decisions');
  assert.equal(offered(decisions(17, 3)), false, '85%');
  // Decisions older than the window do not count.
  const old = decisions(20, 0, { at: NOW - 29 * DAY_MS });
  assert.equal(offered(old), false);
  assert.equal(offered([...old, ...decisions(20, 0)]), true);
  // Another type's numbers do not help.
  assert.equal(offered(decisions(20, 0, { type: 'how-to' })), false);
});

test('an approval after an edit counts as approved and is counted apart', () => {
  const events = [ev('edited', `${PROJECT}/a0`, 'gotcha', NOW - 40 * DAY_MS), ev('edited', `${PROJECT}/a1`), ...decisions(18, 2)];
  const s = auto.typeStats(events, NOW).gotcha;

  assert.equal(s.approved, 18);
  assert.equal(s.edited, 2, 'an edit older than the window still marks its approval');
  assert.equal(s.rejected, 2);
  assert.equal(s.decisions, 20);
  assert.equal(s.rate, 0.9);
});

test('autoStatus lists offered and switched-on types only, switch state included', () => {
  const stats = auto.typeStats([...decisions(20, 0), ...decisions(5, 5, { type: 'decision' })], NOW);
  const rows = auto.autoStatus(['how-to'], stats);

  assert.deepEqual(
    rows.map((r) => [r.type, r.on, r.offered]),
    [
      ['gotcha', false, true],
      ['how-to', true, false],
    ],
  );
  assert.equal(rows[1].rate, null);
});

// ---- exclusions ---------------------------------------------------------------------

test('a candidate is never auto-accepted when it supersedes, is global, read outside sources or repeats a waiting entry', () => {
  const pending = [rec('waiting', { title: 'Retry says busy after a sleep', body: 'Retry says busy after a sleep: restart LunaCore.' })];
  const ctx = { enabled: ['gotcha'], stats: auto.typeStats(decisions(20, 0), NOW), pending };
  const why = (r) => auto.decide(r, ctx).reason;

  assert.deepEqual(auto.decide(rec('fresh'), ctx), { accept: true, reason: 'auto' });
  assert.equal(why(rec('fresh', { supersedes: ['old'] })), 'supersedes');
  assert.equal(why(rec('fresh', { project: 'global' })), 'global');
  assert.equal(why(rec('fresh', { source: 'captured from session abc on PC1, suggested global' })), 'global');
  assert.equal(why(rec('fresh', { source: 'captured from session abc on PC1, read 2 outside source(s)' })), 'outside');
  assert.equal(why(rec('twin', { title: 'Retry says busy after a sleep', body: 'Retry says busy after a sleep: restart LunaCore.' })), 'duplicate');
  // A global waiting entry counts as a twin too; another project's does not.
  const globalTwin = { ...ctx, pending: [{ ...pending[0], project: 'global' }] };
  assert.equal(auto.decide(rec('twin', { title: 'Retry says busy after a sleep', body: 'Retry says busy after a sleep: restart LunaCore.' }), globalTwin).reason, 'duplicate');
  const elsewhere = { ...ctx, pending: [{ ...pending[0], project: 'github.com/acme/other' }] };
  assert.equal(auto.decide(rec('twin', { title: 'Retry says busy after a sleep', body: 'Retry says busy after a sleep: restart LunaCore.' }), elsewhere).reason, 'auto');
});

test('a switched-off type, one whose rate fell, or one this PC has too few decisions for is never auto-accepted', () => {
  const on = auto.typeStats(decisions(20, 0), NOW);
  assert.equal(auto.decide(rec('x'), { enabled: [], stats: on, pending: [] }).reason, 'off');
  assert.equal(auto.decide(rec('x', { type: 'how-to' }), { enabled: ['gotcha'], stats: on, pending: [] }).reason, 'off');
  const falling = auto.typeStats(decisions(15, 5), NOW);
  assert.equal(auto.decide(rec('x'), { enabled: ['gotcha'], stats: falling, pending: [] }).reason, 'failing');
  // The switch synced in from another PC, but this PC's own log is thin: the candidate waits.
  for (const events of [[], decisions(19, 0)]) {
    assert.equal(auto.decide(rec('x'), { enabled: ['gotcha'], stats: auto.typeStats(events, NOW), pending: [] }).reason, 'no-evidence');
  }
});

test('retiring an auto-accepted memory counts like an undo; retiring a hand-approved one does not count', () => {
  const key = `${PROJECT}/x`;
  const s = auto.typeStats([ev('auto-accepted', key), ev('retired', key), ev('retired', `${PROJECT}/hand`)], NOW).gotcha;
  assert.deepEqual([s.auto, s.rejected, s.undone, s.decisions], [0, 1, 1, 1]);
});

// ---- labelling, through the real capture landing step ---------------------------------

function runCapture(t, { events = decisions(20, 0), on = ['gotcha'], candidates, log: useLog = true } = {}) {
  const configDir = tmp(t, 'luna-auto-cap-');
  setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  for (const type of on) auto.setAuto(memoryPaths(configDir).autoAccept, type, true);
  const log = logWith(configDir, events);
  const capture = createRunCapture({
    configDir,
    machine: 'PC1',
    now: () => NOW,
    log: useLog ? log : null,
    projectOf: (repo) => (repo === REPO ? `git:${PROJECT}` : null),
    countOutside: async () => 0,
    run: async () => ({ ok: true, answer: { candidates } }),
  });
  const view = { id: RUN_ID, packages: [{ id: 'pkg-a', title: 'A', state: 'pushed', startedAt: 10, lastWords: 'LUNA_DONE pkg-a' }] };
  const dir = memoryPaths(configDir).dir;
  return { configDir, dir, log, go: () => capture.capture({ runId: RUN_ID, repoPath: REPO, view }) };
}

const candidate = (title, over = {}) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. Unique body for ${title}.`, usefulness: 70, ...over });

test('an auto-accepted memory lands confirmed, labelled in its source and logged as such', async (t) => {
  const s = runCapture(t, { candidates: [candidate('Do not junction node_modules into a worktree')] });

  assert.equal((await s.go()).saved, 1);

  const [[key, record]] = scan(s.dir).records;
  assert.equal(record.confidence, 'confirmed');
  assert.equal(record.last_verified, TODAY);
  assert.equal(record.source, `captured from God Mode run ${RUN_ID} on PC1${auto.AUTO_SUFFIX}`);
  assert.equal(auto.isAutoAccepted(record), true);
  assert.equal(listInbox(s.dir).total, 0, 'nothing waits');
  const lines = s.log.read().filter((e) => e.at === NOW && e.key === key).map((e) => e.ev);
  assert.deepEqual(lines, ['proposed', 'auto-accepted']);
});

test('with the switch on, an excluded candidate and another type still wait in the inbox', async (t) => {
  const s = runCapture(t, {
    candidates: [candidate('Suggested as global for everyone', { scope: 'global' }), candidate('A how-to that is not switched on', { type: 'how-to' })],
  });

  await s.go();

  const records = scan(s.dir).records.map(([, r]) => r);
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.confidence, 'observed');
    assert.equal(auto.isAutoAccepted(r), false);
  }
  assert.equal(s.log.read().filter((e) => e.ev === 'auto-accepted').length, 0);
});

test('a switch that came from another PC does nothing here until this PC has its own 20 decisions', async (t) => {
  const s = runCapture(t, { events: decisions(10, 0), candidates: [candidate('Synced switch but a thin local log')] });

  await s.go();

  assert.equal(scan(s.dir).records[0][1].confidence, 'observed');
  // A thin log is no reason to turn the other PC's switch off either.
  assert.deepEqual(auto.readAuto(memoryPaths(s.configDir).autoAccept), ['gotcha']);
});

test('nothing is auto-accepted while the switch is off (the default), or without a log', async (t) => {
  const off = runCapture(t, { on: [], candidates: [candidate('Off by default for every type')] });
  await off.go();
  assert.equal(scan(off.dir).records[0][1].confidence, 'observed');

  const blind = runCapture(t, { log: false, candidates: [candidate('No numbers no auto accept')] });
  await blind.go();
  assert.equal(scan(blind.dir).records[0][1].confidence, 'observed');
});

test('a broken switch file means every switch is off and the candidate waits', async (t) => {
  const s = runCapture(t, { on: [], candidates: [candidate('Broken settings file means waiting')] });
  fs.writeFileSync(memoryPaths(s.configDir).autoAccept, '{not json');
  const quiet = t.mock.method(console, 'error', () => {});

  await s.go();

  assert.equal(scan(s.dir).records[0][1].confidence, 'observed');
  assert.ok(quiet.mock.callCount() >= 1);
});

// ---- the undo window ----------------------------------------------------------------

const label = (id, created, over = {}) => [`${PROJECT}/${id}`, rec(id, { created, confidence: 'confirmed', source: `captured on PC1${auto.AUTO_SUFFIX}`, ...over })];

test('the recent list holds the last 7 calendar days of auto-accepts, newest first, and nothing else', () => {
  assert.equal(auto.AUTO_UNDO_DAYS, 7);
  const records = [
    label('week', '2026-11-07'),
    label('today', TODAY),
    label('eight-days', '2026-11-06'),
    label('by-hand', TODAY, { source: 'captured on PC1' }),
    label('waiting', TODAY, { confidence: 'observed' }),
  ];

  assert.deepEqual(
    auto.recentAutoAccepted(records, TODAY).map((r) => r.key),
    [`${PROJECT}/today`, `${PROJECT}/week`],
  );
});

test('the recent list is capped', () => {
  const many = Array.from({ length: auto.MAX_RECENT + 5 }, (_, i) => label(`m${i}`, TODAY));
  assert.equal(auto.recentAutoAccepted(many, TODAY).length, auto.MAX_RECENT);
});

function ipcSetup(t, records, events = decisions(20, 0)) {
  const base = tmp(t, 'luna-auto-ipc-');
  const dir = path.join(base, 'memory');
  for (const r of records) writeRecord(dir, r);
  const file = memoryPaths(base).autoAccept;
  const log = logWith(base, events);
  const handlers = {};
  let settings = 0;
  let changed = 0;
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => dir,
    onChanged: () => changed++,
    now: () => NOW,
    log,
    autoFile: () => file,
    onSettingsChanged: () => settings++,
  });
  return {
    dir,
    file,
    log,
    invoke: (channel, arg) => handlers[channel]({}, arg),
    settings: () => settings,
    changed: () => changed,
    stored: () => Object.fromEntries(scan(dir).records),
  };
}

const autoRec = (id, created = TODAY) => rec(id, { created, confidence: 'confirmed', last_verified: created, source: `captured on PC1${auto.AUTO_SUFFIX}` });

test('Undo rejects a recent auto-accept: deleted, logged as a rejection, title kept for the extractor', (t) => {
  const s = ipcSetup(t, [autoRec('fresh')]);

  assert.deepEqual(s.invoke('memory:auto-undo', `${PROJECT}/fresh`), { ok: true, key: `${PROJECT}/fresh` });

  assert.deepEqual(s.stored(), {});
  const last = s.log.read().at(-1);
  assert.equal(last.ev, 'rejected');
  assert.equal(last.title, 'Title of fresh');
  assert.equal(s.changed(), 1);
});

test('Undo refuses an old auto-accept, a hand-approved memory, a waiting one and junk keys', (t) => {
  const s = ipcSetup(t, [autoRec('old', '2026-11-05'), rec('hand', { confidence: 'confirmed' }), rec('waiting')]);
  const before = s.stored();

  assert.deepEqual(s.invoke('memory:auto-undo', `${PROJECT}/old`), { ok: false, reason: 'not-auto' });
  assert.deepEqual(s.invoke('memory:auto-undo', `${PROJECT}/hand`), { ok: false, reason: 'not-auto' });
  assert.deepEqual(s.invoke('memory:auto-undo', `${PROJECT}/waiting`), { ok: false, reason: 'not-auto' });
  assert.deepEqual(s.invoke('memory:auto-undo', `${PROJECT}/nope`), { ok: false, reason: 'not-found' });
  for (const key of [undefined, null, 5, {}, '', '../../x', 'C:\\Windows\\win.ini', 'x'.repeat(500)]) {
    assert.deepEqual(s.invoke('memory:auto-undo', key), { ok: false, reason: 'bad-key' });
  }
  assert.deepEqual(s.stored(), before);
  assert.equal(s.changed(), 0);
});

// ---- the switch -----------------------------------------------------------------------

test('a switch turns on only when offered; off always works; junk is refused', (t) => {
  const s = ipcSetup(t, [], [...decisions(20, 0), ...decisions(10, 0, { type: 'how-to' })]);

  assert.deepEqual(s.invoke('memory:auto-set', { type: 'gotcha', on: true }), { ok: true, type: 'gotcha', on: true });
  assert.deepEqual(auto.readAuto(s.file), ['gotcha']);
  assert.deepEqual(s.invoke('memory:auto-set', { type: 'how-to', on: true }), { ok: false, reason: 'not-offered' });
  for (const req of [undefined, null, 'gotcha', {}, { type: 'gotcha' }, { type: 'gotcha', on: 'yes' }, { type: 'digest', on: true }, { type: '__proto__', on: true }, { type: 'nope', on: false }]) {
    assert.deepEqual(s.invoke('memory:auto-set', req), { ok: false, reason: 'bad-request' });
  }
  assert.deepEqual(s.invoke('memory:auto-set', { type: 'gotcha', on: false }), { ok: true, type: 'gotcha', on: false });
  assert.deepEqual(auto.readAuto(s.file), []);
  assert.equal(s.settings(), 2, 'each change is synced');
});

test('memory:inbox carries the switches, the bar and the recent auto-accepts', (t) => {
  const s = ipcSetup(t, [autoRec('fresh'), rec('waiting')]);

  const res = s.invoke('memory:inbox');

  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.deepEqual(res.auto.types.map((r) => [r.type, r.on, r.offered]), [['gotcha', false, true]]);
  assert.deepEqual(res.auto.recent.map((r) => r.key), [`${PROJECT}/fresh`]);
  assert.deepEqual(res.auto.bar, { min: 20, days: 28, on: 0.9, off: 0.8, undoDays: 7 });
});

test('the switches sync as memory-auto:<type> config units, like memory-on:<project>', (t) => {
  const file = path.join(tmp(t, 'luna-auto-sync-'), 'memory-autoaccept.local.json');
  const provider = auto.createAutoAcceptProvider(file);

  assert.deepEqual(provider.read(NOW), { units: [], base: 0, fresh: true });
  auto.setAuto(file, 'gotcha', true);
  assert.deepEqual(provider.read(NOW).units, [['memory-auto:gotcha', { on: true }]]);
  assert.equal(provider.owns('memory-auto:gotcha'), true);
  assert.equal(provider.owns('memory-auto:digest'), false, 'capture never proposes a digest');
  assert.equal(provider.owns('memory-auto:nope'), false);
  assert.equal(provider.owns('memory-on:github.com/acme/hud'), false);
  assert.equal(provider.valid('memory-auto:gotcha', { on: false }), null);
  assert.deepEqual(provider.valid('memory-auto:how-to', { on: true, extra: 1 }), { on: true });
  provider.write([['memory-auto:how-to', { on: true }], ['memory-auto:nope', { on: true }]]);
  assert.deepEqual(auto.readAuto(file), ['how-to']);
  assert.throws(() => auto.setAuto(file, 'nope', true), /bad-type/);
  assert.match(read('src/configsync.js'), /createAutoAcceptProvider\(memoryPaths\(paths\.userDir\(\)\)\.autoAccept\)/);
});

// ---- auto-off under 80% -----------------------------------------------------------------

test('a switched-on type whose rate falls under 80% turns itself off and logs it', (t) => {
  assert.equal(auto.AUTO_OFF_RATE, 0.8);
  const base = tmp(t, 'luna-auto-off-');
  const file = memoryPaths(base).autoAccept;
  auto.setAuto(file, 'gotcha', true);
  auto.setAuto(file, 'how-to', true);
  auto.setAuto(file, 'decision', true);
  const log = logWith(base, []);
  // gotcha: 6 of 8 (75%) goes off; how-to: exactly 80% stays on;
  // decision: 1 of 3 is too small a sample (AUTO_OFF_MIN_DECISIONS) to judge.
  assert.equal(auto.AUTO_OFF_MIN_DECISIONS, 5);
  const events = [...decisions(6, 2), ...decisions(4, 1, { type: 'how-to' }), ...decisions(1, 2, { type: 'decision' })];

  assert.deepEqual(auto.enforceAutoOff({ file, events, now: NOW, log }), [{ type: 'gotcha', rate: 0.75 }]);
  assert.deepEqual(auto.readAuto(file), ['decision', 'how-to']);
  assert.deepEqual(log.read().map(({ ev: e, type, rate }) => [e, type, rate]), [['auto-off', 'gotcha', 0.75]]);
  // Nothing more to turn off the second time.
  assert.deepEqual(auto.enforceAutoOff({ file, events, now: NOW, log }), []);
});

test('undone auto-accepts count against the type until it switches itself off, and the hub says so', (t) => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => `${PROJECT}/${id}`);
  const autos = keys.map((key) => ev('auto-accepted', key));
  const s = ipcSetup(t, [autoRec('h')], [...autos, ev('rejected', keys[0]), ev('rejected', keys[1])]);
  auto.setAuto(s.file, 'gotcha', true);
  // 6 kept of 8 auto-accepts is 75% after two undos: the inbox read turns it off.
  const stats = auto.typeStats(s.log.read(), NOW).gotcha;
  assert.deepEqual([stats.auto, stats.undone, stats.rejected], [6, 2, 2]);

  s.invoke('memory:inbox');

  assert.deepEqual(auto.readAuto(s.file), []);
  assert.equal(s.settings(), 1);
  const notices = auto.recentAutoOffs(s.log.read(), NOW);
  assert.deepEqual(notices.map((n) => [n.type, n.rate]), [['gotcha', 0.75]]);
  const items = COLLECTORS.memory({ count: 0, now: NOW, autoOff: notices });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'hub.item.memoryAutoOff');
  assert.deepEqual(items[0].vars, { type: 'gotcha', rate: 75 });
  assert.deepEqual(items[0].primary, { action: 'openMemoryInbox' });
});

test('an undo can be what turns the switch off', (t) => {
  const keys = ['a', 'b', 'c', 'd', 'e'].map((id) => `${PROJECT}/${id}`);
  const s = ipcSetup(t, [autoRec('e')], [...keys.map((key) => ev('auto-accepted', key)), ev('rejected', keys[0])]);
  auto.setAuto(s.file, 'gotcha', true);

  // 4 of 5 kept = 80%: still on. Undoing a second one makes it 60%.
  assert.equal(s.invoke('memory:auto-undo', `${PROJECT}/e`).ok, true);

  assert.deepEqual(auto.readAuto(s.file), []);
  assert.equal(s.log.read().at(-1).ev, 'auto-off');
});

test('the hub item list ignores junk and the notices expire after a week', () => {
  const at = NOW - DAY_MS;
  const junk = [null, 'x', { type: 'gotcha' }, { type: 'Bad Type', rate: 0.5, at }, { type: 'gotcha', rate: 'x', at }, { type: 'gotcha', rate: 0.5, at: -1 }];
  assert.deepEqual(COLLECTORS.memory({ count: 0, now: NOW, autoOff: junk }), []);
  assert.equal(COLLECTORS.memory({ count: 2, now: NOW, autoOff: [{ type: 'gotcha', rate: 0.7, at }] }).length, 2);
  const events = [{ at: NOW - 8 * DAY_MS, ev: 'auto-off', type: 'gotcha', rate: 0.7 }, { at, ev: 'auto-off', type: 'how-to', rate: 0.6 }];
  assert.deepEqual(auto.recentAutoOffs(events, NOW).map((n) => n.type), ['how-to']);
});

test('the log keeps auto-accepted and auto-off lines, rebuilt field by field', () => {
  assert.deepEqual(cleanEvent({ at: 1, ev: 'auto-accepted', key: `${PROJECT}/x`, type: 'gotcha', usefulness: 70, extra: 1 }), { at: 1, ev: 'auto-accepted', key: `${PROJECT}/x`, type: 'gotcha', usefulness: 70 });
  assert.deepEqual(cleanEvent({ at: 1, ev: 'auto-off', type: 'gotcha', rate: 0.75, note: 'x' }), { at: 1, ev: 'auto-off', type: 'gotcha', rate: 0.75 });
  for (const bad of [{ at: 1, ev: 'auto-off', type: 'gotcha' }, { at: 1, ev: 'auto-off', type: 'gotcha', rate: 2 }, { at: 1, ev: 'auto-off', type: 'nope', rate: 0.5 }]) {
    assert.equal(cleanEvent(bad), null);
  }
});

// ---- the renderer ------------------------------------------------------------------------

test('the window offers the switches and Undo through channels preload exposes, in pl and en', () => {
  const panel = read('src/renderer/modules/memoryinbox.js');
  const section = read('src/renderer/modules/memoryautopanel.js');
  const preload = read('src/preload.js');
  const i18n = read('src/renderer/i18n.js');

  for (const fn of ['memoryAutoSet', 'memoryAutoUndo']) {
    assert.ok(panel.includes(`'${fn}'`), `${fn} is not called`);
    assert.match(preload, new RegExp(`\\b${fn}:`), `${fn} is missing in preload`);
  }
  for (const channel of ['memory:auto-set', 'memory:auto-undo']) assert.ok(preload.includes(`'${channel}'`), channel);
  assert.doesNotMatch(section, /innerHTML|outerHTML|insertAdjacentHTML/);
  const keys = new Set([...`${section}\n${panel}`.matchAll(/'(mem\.auto\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size >= 8);
  for (const key of [...keys, 'hub.item.memoryAutoOff']) {
    const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(lines.length, 2, `${key} must exist once in pl and once in en`);
    assert.doesNotMatch(lines[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: Polish UI strings carry no diacritics`);
  }
});
