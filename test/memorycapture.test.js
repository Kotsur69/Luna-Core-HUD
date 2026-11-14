// ============================================================================
// LunaCore - memory capture: the ledger, the pieces, the ticks (src/memorycapture.js)
// ----------------------------------------------------------------------------
// The model is a stub: these tests never start `claude`.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCapture, extractPiece, readPiece, readLedger, droppedEvents, LEDGER_FILE, IDLE_MS, SETTLE_MS, MAX_FAILS, MAX_PENDING } = require('../src/memorycapture.js');
const { listInbox } = require('../src/memoryinbox.js');
const { memoryPaths } = require('../src/memorysync.js');
const { setEnabled } = require('../src/memoryprojects.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { runJob } = require('../src/missionrunner.js');
const { createLog, logPath } = require('../src/memorylog.js');
const { readGraveyard, graveyardPath } = require('../src/memorygraveyard.js');

const PROJECT = 'github.com/acme/hud';
const NOW = Date.parse('2026-11-11T12:00:00Z');

const line = (role, content) => JSON.stringify({ type: role, message: { role, content } });
/** A session long enough to be worth a model call. */
const session = (topic) => `${[line('user', `please look at ${topic} ${'detail '.repeat(60)}`), line('assistant', `I looked at ${topic}. ${'finding '.repeat(60)}`)].join('\n')}\n`;

const answer = (...titles) => ({ ok: true, answer: { candidates: titles.map((title) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. Unique body.` })) } });

function setup(t, { enabled = true } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capture-'));
  t.after(() => fs.promises.rm(configDir, { recursive: true, force: true, maxRetries: 5 }));
  if (enabled) setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const clock = { at: NOW };
  const calls = [];
  const state = { reply: answer(), live: [] };
  const log = createLog(logPath(configDir), { now: () => clock.at });
  const capture = createCapture({
    configDir,
    machine: 'PC1',
    transcriptsDir: configDir,
    now: () => clock.at,
    live: () => state.live,
    log,
    run: async (job) => {
      calls.push(job.prompt);
      return typeof state.reply === 'function' ? state.reply() : state.reply;
    },
  });
  /** Writes a transcript last touched `ageMs` before the clock. */
  const transcript = (name, text, ageMs = SETTLE_MS + 1000) => {
    const file = path.join(configDir, `${name}.jsonl`);
    fs.writeFileSync(file, text);
    const when = new Date(clock.at - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const memories = () => scan(memoryPaths(configDir).dir).records.map(([, r]) => r);
  const ledger = () => readLedger(path.join(configDir, LEDGER_FILE));
  return { configDir, capture, clock, calls, state, transcript, memories, ledger, log };
}

test('a capture is logged with what it proposed and what the filter dropped', async (t) => {
  const s = setup(t);
  const file = s.transcript('eeeeeeee-5555', session('the sync'));
  s.state.reply = answer('Name the installer asset with dashes', 'Name the installer asset with dashes');
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.deepEqual(
    s.log.read().map(({ at, ...event }) => event),
    [
      { ev: 'proposed', key: `${PROJECT}/name-the-installer-asset-with-dashes`, type: 'gotcha' },
      { ev: 'capture', project: PROJECT, reason: 'saved', kept: 1, dropped: { duplicate: 1 } },
    ],
  );
});

test('a session too short for a model call is not logged as a capture', async (t) => {
  const s = setup(t);
  const file = s.transcript('ffffffff-6666', `${line('user', 'hi')}\n`);
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.log.read(), []);
});

test('the titles rejected for the project go to the extractor as not wanted', async (t) => {
  const s = setup(t);
  s.log.add({ ev: 'rejected', key: `${PROJECT}/changelog`, type: 'project-fact', title: 'Fixed the login bug today' });
  s.log.add({ ev: 'rejected', key: 'github.com/acme/other/x', type: 'gotcha', title: 'From another project' });
  const file = s.transcript('abababab-7777', session('the inbox'));
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.match(s.calls[0], /REJECTED these proposals lately[\s\S]*\n- "Fixed the login bug today"\n/);
  assert.doesNotMatch(s.calls[0], /From another project/);
});

test('a finished session becomes observed memories and is not read twice', async (t) => {
  const s = setup(t);
  const file = s.transcript('aaaaaaaa-1111', session('the release script'));
  s.state.reply = answer('Name the installer asset with dashes');
  s.capture.track({ file, project: PROJECT });

  assert.deepEqual(await s.capture.tick(), { processed: 1, saved: 1 });

  const [memory] = s.memories();
  assert.equal(memory.confidence, 'observed');
  assert.equal(memory.project, PROJECT);
  assert.equal(memory.source, 'captured from session aaaaaaaa on PC1');
  assert.equal(memory.created, '2026-11-11');
  assert.match(s.calls[0], /please look at the release script/);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);

  assert.deepEqual(await s.capture.tick(), { processed: 0, saved: 0 });
  assert.equal(s.calls.length, 1);
});

test('only what was appended since the last capture goes to the model', async (t) => {
  const s = setup(t);
  const file = s.transcript('bbbbbbbb-1', session('the first topic'));
  s.capture.track({ file, project: PROJECT });
  await s.capture.tick();

  s.transcript('bbbbbbbb-1', session('the first topic') + session('the second topic'));
  await s.capture.tick();

  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1], /the second topic/);
  assert.doesNotMatch(s.calls[1], /the first topic/);
});

test('a session whose tab is still open waits until it has been idle', async (t) => {
  const s = setup(t);
  const file = s.transcript('cccccccc-1', session('a live tab'), SETTLE_MS + 1000);
  s.state.live = [{ file, project: PROJECT }];

  assert.equal((await s.capture.tick()).processed, 0);

  s.clock.at += IDLE_MS;
  assert.equal((await s.capture.tick()).processed, 1);
});

test('a session that just ended is left alone until its file has settled', async (t) => {
  const s = setup(t);
  const file = s.transcript('dddddddd-1', session('a fresh end'), 1000);
  s.capture.track({ file, project: PROJECT });

  assert.equal((await s.capture.tick()).processed, 0);
  assert.equal(s.calls.length, 0);
});

test('a short session costs no model call and is marked read', async (t) => {
  const s = setup(t);
  const file = s.transcript('eeeeeeee-1', `${line('user', 'hi')}\n${line('assistant', 'hello')}\n`);
  s.capture.track({ file, project: PROJECT });

  assert.deepEqual(await s.capture.tick(), { processed: 1, saved: 0 });

  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);
  assert.equal(s.ledger().last.reason, 'too-short');
});

test('a failed model call is retried and given up after MAX_FAILS', async (t) => {
  const s = setup(t);
  const file = s.transcript('ffffffff-1', session('a flaky run'));
  s.state.reply = { ok: false, reason: 'timeout' };
  s.capture.track({ file, project: PROJECT });

  for (let i = 1; i < MAX_FAILS; i++) {
    await s.capture.tick();
    assert.deepEqual([s.ledger().files[file].done, s.ledger().files[file].fails], [0, i]);
  }
  await s.capture.tick();

  assert.equal(s.calls.length, MAX_FAILS);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);
  assert.equal(s.ledger().last.reason, 'model-timeout');
  assert.deepEqual(s.memories(), []);
});

test('nothing is captured for a project with memory switched off', async (t) => {
  const s = setup(t, { enabled: false });
  const file = s.transcript('11111111-1', session('a private repo'));
  s.capture.track({ file, project: PROJECT });

  assert.deepEqual(await s.capture.tick(), { processed: 0, saved: 0 });

  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.ledger().files, {});
});

test('a full inbox pauses capture for the project without losing the session', async (t) => {
  const s = setup(t);
  const dir = memoryPaths(s.configDir).dir;
  for (let i = 0; i < MAX_PENDING; i++) {
    writeRecord(dir, { id: `waiting-${i}`, type: 'gotcha', project: PROJECT, title: `Distinct${i} topic${i} lesson${i}`, created: '2026-11-01', confidence: 'observed', supersedes: [], links: [], body: `Text${i} only${i}.` });
  }
  const file = s.transcript('22222222-1', session('one more thing'));
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger().files[file].done, 0);
  assert.equal(s.ledger().last, null);
});

test('a transcript that is gone is forgotten, and track() refuses what is not a session', async (t) => {
  const s = setup(t);
  s.capture.track({ file: path.join(s.configDir, 'gone.jsonl'), project: PROJECT });
  s.capture.track({ file: 'relative.jsonl', project: PROJECT });
  s.capture.track({ file: path.join(s.configDir, 'x.jsonl'), project: '../evil' });
  s.capture.track(null);
  assert.equal(Object.keys(s.ledger().files).length, 1);

  await s.capture.tick();

  assert.deepEqual(s.ledger().files, {});
});

test('onSaved fires with the number of new memories', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capture-'));
  t.after(() => fs.promises.rm(configDir, { recursive: true, force: true, maxRetries: 5 }));
  setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const file = path.join(configDir, '33333333.jsonl');
  fs.writeFileSync(file, session('two lessons'));
  const seen = [];
  const capture = createCapture({
    configDir,
    machine: 'PC1',
    transcriptsDir: configDir,
    now: () => Date.now() + SETTLE_MS + 5000,
    run: async () => answer('Alpha lesson about printers', 'Bravo lesson about batteries'),
    onSaved: (n) => seen.push(n),
  });
  capture.track({ file, project: PROJECT });

  await capture.tick();

  assert.deepEqual(seen, [2]);
});

test('a broken ledger file reads as empty and status() reports the last run', async (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.configDir, LEDGER_FILE), '{not json');

  assert.deepEqual(s.capture.status(), { tracked: 0, last: null });

  const file = s.transcript('44444444-1', session('after the break'));
  s.capture.track({ file, project: PROJECT });
  await s.capture.tick();
  assert.deepEqual(s.capture.status(), { tracked: 1, last: { at: NOW, saved: 0, reason: 'nothing' } });
});

test('readPiece stops at the last complete line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-piece-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'one\ntwo\nthr');

  assert.deepEqual(readPiece(file, 0, 11), { text: 'one\ntwo\n', end: 8 });
  assert.deepEqual(readPiece(file, 8, 11), { text: '', end: 8 });
});

test('runJob can pipe a long prompt through stdin instead of the command line', async () => {
  const seen = {};
  const exec = (cmd, args, opts, cb) => {
    seen.args = args;
    setImmediate(() => cb(null, JSON.stringify({ result: '{"candidates":[]}' })));
    return { stdin: { on: () => {}, end: (text) => (seen.stdin = text) } };
  };

  const res = await runJob({ prompt: 'a very long prompt', model: 'haiku', lean: true, stdin: true, env: {}, exec });

  assert.deepEqual(res.answer, { candidates: [] });
  assert.equal(seen.stdin, 'a very long prompt');
  assert.equal(seen.args[0], '-p');
  assert.equal(seen.args.includes('a very long prompt'), false);
  assert.ok(seen.args.includes('--strict-mcp-config'));
});

test('a session tracked while a tick is waiting for the model is not lost', async (t) => {
  const s = setup(t);
  const first = s.transcript('55555555-1', session('the first tab'));
  const second = s.transcript('66666666-1', session('the second tab'), 1000);
  s.capture.track({ file: first, project: PROJECT });
  s.state.reply = () => {
    s.capture.track({ file: second, project: PROJECT });
    return answer();
  };

  await s.capture.tick();

  assert.deepEqual(Object.keys(s.ledger().files).sort(), [first, second].sort());
});

test('a skipped transcript does not use up the model-call budget of a tick', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i++) s.capture.track({ file: s.transcript(`7777777${i}-1`, 'no complete line yet'), project: PROJECT });
  const real = s.transcript('88888888-1', session('the real one'));
  s.capture.track({ file: real, project: PROJECT });

  assert.deepEqual(await s.capture.tick(), { processed: 1, saved: 0 });
  assert.equal(s.calls.length, 1);
});

test('only a transcript under the transcripts folder is ever tracked or read', async (t) => {
  const s = setup(t);
  const outside = path.join(os.tmpdir(), 'luna-capture-outside.jsonl');
  fs.writeFileSync(outside, session('somewhere else'));
  t.after(() => fs.promises.rm(outside, { force: true }));
  s.capture.track({ file: outside, project: PROJECT });
  s.capture.track({ file: path.join(s.configDir, 'notes.txt'), project: PROJECT });
  assert.deepEqual(s.ledger().files, {});

  // A ledger edited by hand cannot point capture at another file either.
  fs.writeFileSync(path.join(s.configDir, LEDGER_FILE), JSON.stringify({ files: { [outside]: { project: PROJECT, done: 0, fails: 0, at: 0 } } }));
  await s.capture.tick();

  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.ledger().files, {});
});

// ---- outside content (security review of 2026-11-11) -----------------------------

/** A session that also called these tools from the assistant turn. */
const sessionWithTools = (topic, tools) =>
  `${[
    line('user', `please look at ${topic} ${'detail '.repeat(60)}`),
    line('assistant', [
      { type: 'text', text: `I looked at ${topic}. ${'finding '.repeat(60)}` },
      ...tools.map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: { query: topic } })),
    ]),
  ].join('\n')}\n`;

test('a session that read outside content notes the count in the source of its memories', async (t) => {
  const s = setup(t);
  const file = s.transcript('bbbbbbbb-2222', sessionWithTools('the release script', ['WebFetch', 'mcp__github__get_issue', 'Bash', 'mcp__lunacore__luna_todo_add']));
  s.state.reply = answer('Name the installer asset with dashes');
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  const [memory] = s.memories();
  assert.equal(memory.source, 'captured from session bbbbbbbb on PC1, read 2 outside source(s)');
  const [item] = listInbox(memoryPaths(s.configDir).dir).items;
  assert.equal(item.outside, 2);
  assert.equal(item.suggestedGlobal, false);
});

test('the outside note comes before the suggested-global note in a captured source', async (t) => {
  const s = setup(t);
  const file = s.transcript('cccccccc-3333', sessionWithTools('comment style', ['WebSearch']));
  s.state.reply = { ok: true, answer: { candidates: [{ type: 'preference', scope: 'global', title: 'Comments are written in English', body: 'Every code comment is English.' }] } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  const [memory] = s.memories();
  assert.equal(memory.project, PROJECT);
  assert.equal(memory.source, 'captured from session cccccccc on PC1, read 1 outside source(s), suggested global');
  const [item] = listInbox(memoryPaths(s.configDir).dir).items;
  assert.deepEqual([item.outside, item.suggestedGlobal], [1, true]);
});

test('a session that used only local tools gets no outside note', async (t) => {
  const s = setup(t);
  const file = s.transcript('dddddddd-4444', sessionWithTools('the release script', ['Bash', 'Read', 'mcp__lunacore__memory_search']));
  s.state.reply = answer('Name the installer asset with dashes');
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  const [memory] = s.memories();
  assert.equal(memory.source, 'captured from session dddddddd on PC1');
  assert.equal(listInbox(memoryPaths(s.configDir).dir).items[0].outside, 0);
});

test('extractPiece reports the outside count it noted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capture-piece-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  const res = await extractPiece({
    text: sessionWithTools('the release script', ['Agent', 'Task']),
    project: PROJECT,
    dir,
    source: 'captured from session eeeeeeee on PC1',
    today: '2026-11-11',
    run: async () => answer('Name the installer asset with dashes'),
  });

  assert.equal(res.outside, 2);
  assert.equal(res.records[0].source, 'captured from session eeeeeeee on PC1, read 2 outside source(s)');
});

test('a candidate under the usefulness floor never reaches the inbox and is logged with its score', async (t) => {
  const s = setup(t);
  const file = s.transcript('ffffffff-6666', session('the release'));
  const scored = (title, usefulness) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. Unique body.`, usefulness });
  s.state.reply = { ok: true, answer: { candidates: [scored('Name the installer asset with dashes', 82), scored('The window was resized once', 12)] } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.deepEqual(
    listInbox(memoryPaths(s.configDir).dir).items.map((i) => [i.title, i.usefulness]),
    [['Name the installer asset with dashes', 82]],
  );
  assert.deepEqual(
    s.log.read().map(({ at, ...event }) => event),
    [
      { ev: 'proposed', key: `${PROJECT}/name-the-installer-asset-with-dashes`, type: 'gotcha', usefulness: 82 },
      { ev: 'dropped', project: PROJECT, reason: 'low usefulness', type: 'gotcha', title: 'The window was resized once', usefulness: 12 },
      { ev: 'capture', project: PROJECT, reason: 'saved', kept: 1, dropped: { 'low usefulness': 1 } },
    ],
  );
});

test('droppedEvents logs only the low-usefulness drops', () => {
  const rejected = [
    { title: 'Dup', reason: 'duplicate' },
    { title: 'Weak', reason: 'low usefulness', type: 'how-to', usefulness: 3 },
  ];

  assert.deepEqual(droppedEvents(rejected, PROJECT), [{ ev: 'dropped', project: PROJECT, reason: 'low usefulness', type: 'how-to', title: 'Weak', usefulness: 3 }]);
});

test('a candidate under the usefulness floor lands in the graveyard with its whole body', async (t) => {
  const s = setup(t);
  const file = s.transcript('abababab-7777', session('the release'));
  const scored = (title, usefulness) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. The full body is kept.`, usefulness });
  s.state.reply = { ok: true, answer: { candidates: [scored('Name the installer asset with dashes', 82), scored('The window was resized once', 12)] } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  const graves = readGraveyard(graveyardPath(s.configDir), s.clock.at);
  assert.equal(graves.length, 1);
  assert.equal(graves[0].reason, 'low usefulness');
  assert.equal(graves[0].score, 12);
  assert.equal(graves[0].at, s.clock.at);
  assert.equal(graves[0].record.title, 'The window was resized once');
  assert.equal(graves[0].record.body, 'The window was resized once. The full body is kept.');
  assert.equal(graves[0].record.project, PROJECT);
  assert.equal(graves[0].record.source, 'captured from session abababab on PC1');
  // The kept candidate is not buried.
  assert.ok(!graves.some((g) => g.record.title === 'Name the installer asset with dashes'));
});

// ---- the score thresholds (src/memoryextract.js) through a real session capture ----------

const auto = require('../src/memoryautoaccept.js');

/** A capture whose model scores three candidates 40, 70 and 95. */
function scoredCapture(t, name) {
  const s = setup(t);
  const file = s.transcript(name, session('the thresholds'));
  const scored = (title, usefulness) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. Unique body for ${title}.`, usefulness });
  s.state.reply = {
    ok: true,
    answer: { candidates: [scored('The window was resized once', 40), scored('Name the installer asset with dashes', 70), scored('Retry says busy after a sleep', 95)] },
  };
  s.capture.track({ file, project: PROJECT });
  return s;
}

test('acceptance: 40 goes to the graveyard; 70 and 95 wait in the inbox while the score switch is off (the default)', async (t) => {
  const s = scoredCapture(t, 'cdcdcdcd-8888');
  // Plenty of evidence for the type: only the switch keeps the 95 waiting.
  for (let i = 0; i < auto.AUTO_MIN_DECISIONS; i++) s.log.add({ ev: 'approved', key: `${PROJECT}/a${i}`, type: 'gotcha' });

  await s.capture.tick();

  assert.equal(auto.readScoreAuto(memoryPaths(s.configDir).autoAccept), false, 'off by default');
  assert.deepEqual(
    readGraveyard(graveyardPath(s.configDir), s.clock.at).map((g) => [g.record.title, g.score]),
    [['The window was resized once', 40]],
  );
  assert.deepEqual(
    s.memories().map((r) => [r.title, r.usefulness, r.confidence, auto.isAutoAccepted(r)]).sort(),
    [
      ['Name the installer asset with dashes', 70, 'observed', false],
      ['Retry says busy after a sleep', 95, 'observed', false],
    ],
  );
  assert.equal(s.log.read().filter((e) => e.ev === 'auto-accepted').length, 0);
});

test('acceptance: with the score switch on, the 95 is auto-accepted with Undo; the 70 still waits', async (t) => {
  const s = scoredCapture(t, 'efefefef-9999');
  for (let i = 0; i < auto.AUTO_MIN_DECISIONS; i++) s.log.add({ ev: 'approved', key: `${PROJECT}/a${i}`, type: 'gotcha' });
  auto.setScoreAuto(memoryPaths(s.configDir).autoAccept, true);

  await s.capture.tick();

  const byTitle = Object.fromEntries(s.memories().map((r) => [r.title, r]));
  assert.equal(byTitle['Retry says busy after a sleep'].confidence, 'confirmed');
  assert.equal(auto.isAutoAccepted(byTitle['Retry says busy after a sleep']), true);
  assert.equal(byTitle['Name the installer asset with dashes'].confidence, 'observed');
  assert.equal(byTitle['The window was resized once'], undefined, 'the 40 is in the graveyard');
  const key = `${PROJECT}/retry-says-busy-after-a-sleep`;
  assert.deepEqual(
    s.log.read().filter((e) => e.key === key).map((e) => [e.ev, e.usefulness]),
    [
      ['proposed', 95],
      ['auto-accepted', 95],
    ],
  );
  // It is on the memory window's existing 'auto-accepted, Undo' list.
  const today = new Date(s.clock.at).toISOString().slice(0, 10);
  assert.deepEqual(auto.recentAutoAccepted(scan(memoryPaths(s.configDir).dir).records, today).map((r) => r.key), [key]);
  assert.equal(auto.undoAutoAccept(memoryPaths(s.configDir).dir, key, today).ok, true);
});
