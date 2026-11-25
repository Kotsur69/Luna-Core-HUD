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
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capture-outside-'));
  t.after(() => fs.promises.rm(outsideDir, { recursive: true, force: true, maxRetries: 5 }));
  const outside = path.join(outsideDir, 'luna-capture-outside.jsonl');
  fs.writeFileSync(outside, session('somewhere else'));
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

// ---- Antigravity (agy) sessions ------------------------------------------------

const { transcriptKind, sessionTranscriptOf } = require('../src/memorycapture.js');
const { readNote } = require('../src/memorynote.js');

const AGY_CONV = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AGY_STATUS = 'The agy capture is wired; nothing is in progress and the next step is a release.';

let agyStep = 0;
/** One agy step line, with its own index and time. */
const agyLine = (type, over = {}) => {
  const index = agyStep++;
  return JSON.stringify({ step_index: index, type, status: 'DONE', created_at: new Date(NOW - 3600000 + index * 1000).toISOString(), ...over });
};
/** An agy session long enough to be worth a model call; `calls` = [name, args] of the reply's tool calls. */
const agySession = (topic, calls = []) =>
  `${[
    agyLine('USER_INPUT', { content: `<USER_REQUEST>\nplease look at ${topic} ${'detail '.repeat(60)}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>` }),
    agyLine('PLANNER_RESPONSE', { content: `I looked at ${topic}. ${'finding '.repeat(60)}`, tool_calls: calls.map(([name, args]) => ({ name, args })) }),
  ].join('\n')}\n`;

/** A capture whose Claude and agy roots are two temp folders of their own. */
function agySetup(t) {
  const temp = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    return dir;
  };
  const configDir = temp('luna-capture-agy-cfg-');
  const claudeDir = temp('luna-capture-agy-claude-');
  const agyDir = temp('luna-capture-agy-app-');
  const elsewhere = temp('luna-capture-agy-else-');
  setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const clock = { at: NOW };
  const calls = [];
  const state = { reply: answer(), live: [] };
  const capture = createCapture({
    configDir,
    machine: 'PC1',
    transcriptsDir: claudeDir,
    agyDir,
    now: () => clock.at,
    live: () => state.live,
    log: createLog(logPath(configDir), { now: () => clock.at }),
    run: async (job) => {
      calls.push(job.prompt);
      return typeof state.reply === 'function' ? state.reply() : state.reply;
    },
  });
  const logsDir = (root, id) => path.join(root, 'brain', id, '.system_generated', 'logs');
  const touch = (file, ageMs) => {
    const when = new Date(clock.at - ageMs);
    fs.utimesSync(file, when, when);
  };
  /** Writes an agy transcript last touched `ageMs` before the clock. */
  const transcript = (text, { id = AGY_CONV, name = 'transcript_full.jsonl', root = agyDir, ageMs = SETTLE_MS + 1000 } = {}) => {
    fs.mkdirSync(logsDir(root, id), { recursive: true });
    const file = path.join(logsDir(root, id), name);
    fs.writeFileSync(file, text);
    touch(file, ageMs);
    return file;
  };
  const memories = () => scan(memoryPaths(configDir).dir).records.map(([, r]) => r);
  const ledger = () => readLedger(path.join(configDir, LEDGER_FILE));
  const note = () => readNote(memoryPaths(configDir).dir, PROJECT);
  const roots = { claude: path.resolve(claudeDir), agy: path.resolve(agyDir) };
  return { configDir, claudeDir, agyDir, elsewhere, roots, capture, clock, calls, state, transcript, touch, logsDir, memories, ledger, note };
}

test('agy: a finished session gives inbox candidates and the where-we-stopped note', async (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('the agy capture'));
  s.state.reply = { ok: true, answer: { ...answer('Agy logs a step again when its status moves on').answer, status: AGY_STATUS } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.equal(s.calls.length, 1);
  // The digest the model read is agy's prompt, without the metadata agy wraps around it.
  assert.match(s.calls[0], /please look at the agy capture/);
  assert.doesNotMatch(s.calls[0], /ADDITIONAL_METADATA|USER_REQUEST|current local time/);
  const [memory] = s.memories();
  assert.equal(memory.title, 'Agy logs a step again when its status moves on');
  assert.equal(memory.confidence, 'observed');
  assert.equal(memory.source, `captured from session ${AGY_CONV.slice(0, 8)} on PC1`);
  assert.equal(listInbox(memoryPaths(s.configDir).dir).items.length, 1);
  const note = s.note();
  assert.equal(note.text, AGY_STATUS);
  // The session is agy's conversation id, not the transcript's file name.
  assert.equal(note.session, AGY_CONV);
  assert.deepEqual(s.ledger().files[file], { project: PROJECT, done: fs.statSync(file).size, fails: 0, at: NOW });
});

test('agy: the ledger moves on, so only what was appended is read next time', async (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('the first topic'));
  s.capture.track({ file, project: PROJECT });
  await s.capture.tick();
  await s.capture.tick();
  assert.equal(s.calls.length, 1);

  fs.appendFileSync(file, agySession('the second topic'));
  s.touch(file, SETTLE_MS + 1000);
  await s.capture.tick();

  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1], /the second topic/);
  assert.doesNotMatch(s.calls[1], /the first topic/);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);
});

test('agy: an open tab is tracked from live() and captured once it has been idle', async (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('a live agy tab'), { ageMs: 60 * 1000 });
  s.state.live = [{ file, project: PROJECT }];

  await s.capture.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger().files[file].done, 0);

  s.clock.at += IDLE_MS;
  await s.capture.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);
});

test('agy: a session that read outside content notes it and leaves the note alone', async (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('a web search', [
    ['search_web', { Query: 'agy flags' }],
    ['call_mcp_tool', { ServerName: 'github', ToolName: 'get_issue' }],
    ['call_mcp_tool', { ServerName: 'lunacore-s1', ToolName: 'memory_search' }],
    ['run_command', { CommandLine: 'npm test' }],
  ]));
  s.state.reply = { ok: true, answer: { ...answer('Agy help never exits').answer, status: AGY_STATUS } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  const [memory] = s.memories();
  assert.equal(memory.source, `captured from session ${AGY_CONV.slice(0, 8)} on PC1, read 2 outside source(s)`);
  assert.equal(s.note(), null);
});

test('agy: only a transcript under agy\'s or Claude\'s own folder is tracked', (t) => {
  const s = agySetup(t);
  const good = s.transcript(agySession('good'));
  const plain = s.transcript(agySession('plain'), { name: 'transcript.jsonl' });
  const refused = [
    // the right shape under another app data folder
    s.transcript(agySession('elsewhere'), { root: s.elsewhere }),
    // the wrong file name or extension in a conversation's logs
    s.transcript(agySession('wrong name'), { name: 'notes.jsonl' }),
    s.transcript(agySession('wrong ext'), { name: 'transcript_full.json' }),
    // a folder that is not a conversation id
    s.transcript(agySession('not a uuid'), { id: 'not-a-conversation' }),
    // `..` is refused even where it resolves back inside the root
    `${s.logsDir(s.agyDir, AGY_CONV)}${path.sep}..${path.sep}logs${path.sep}transcript_full.jsonl`,
    `${s.agyDir}${path.sep}..${path.sep}${path.basename(s.agyDir)}${path.sep}brain${path.sep}${AGY_CONV}${path.sep}.system_generated${path.sep}logs${path.sep}transcript_full.jsonl`,
    // relative, or not a string
    path.join('brain', AGY_CONV, '.system_generated', 'logs', 'transcript_full.jsonl'),
    42,
  ];
  for (const file of refused) s.capture.track({ file, project: PROJECT });
  assert.deepEqual(s.ledger().files, {});

  s.capture.track({ file: good, project: PROJECT });
  s.capture.track({ file: plain, project: PROJECT });
  assert.deepEqual(Object.keys(s.ledger().files).sort(), [good, plain].sort());
});

test('agy: a hand-edited ledger cannot point capture at another file', async (t) => {
  const s = agySetup(t);
  const outside = s.transcript(agySession('outside the root'), { root: s.elsewhere });
  const climbing = `${s.logsDir(s.agyDir, AGY_CONV)}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}${path.basename(s.elsewhere)}${path.sep}brain${path.sep}${AGY_CONV}${path.sep}.system_generated${path.sep}logs${path.sep}transcript_full.jsonl`;
  const entry = { project: PROJECT, done: 0, fails: 0, at: 0 };
  fs.writeFileSync(path.join(s.configDir, LEDGER_FILE), JSON.stringify({ files: { [outside]: entry, [climbing]: entry } }));

  await s.capture.tick();

  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.ledger().files, {});
});

test('agy: a conversation folder that is a link out of the root is refused', async (t) => {
  const s = agySetup(t);
  // The real transcript lives elsewhere; brain/<id> under the root links to it.
  const target = s.transcript(agySession('through a junction'), { root: s.elsewhere });
  fs.mkdirSync(path.join(s.agyDir, 'brain'), { recursive: true });
  // A junction needs no privilege on Windows; elsewhere the type is ignored and a dir symlink is made.
  fs.symlinkSync(path.join(s.elsewhere, 'brain', AGY_CONV), path.join(s.agyDir, 'brain', AGY_CONV), 'junction');
  const linked = path.join(s.logsDir(s.agyDir, AGY_CONV), 'transcript_full.jsonl');
  assert.equal(fs.readFileSync(linked, 'utf8'), fs.readFileSync(target, 'utf8'));

  assert.equal(transcriptKind(linked, s.roots), null);
  s.capture.track({ file: linked, project: PROJECT });
  assert.deepEqual(s.ledger().files, {});

  fs.writeFileSync(path.join(s.configDir, LEDGER_FILE), JSON.stringify({ files: { [linked]: { project: PROJECT, done: 0, fails: 0, at: 0 } } }));
  await s.capture.tick();
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.ledger().files, {});
});

test('agy: a symlinked transcript file is refused', (t) => {
  const s = agySetup(t);
  const target = s.transcript(agySession('a symlinked file'), { root: s.elsewhere });
  fs.mkdirSync(s.logsDir(s.agyDir, AGY_CONV), { recursive: true });
  const linked = path.join(s.logsDir(s.agyDir, AGY_CONV), 'transcript_full.jsonl');
  try {
    fs.symlinkSync(target, linked, 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('file symlinks need a privilege on this machine');
    throw err;
  }
  assert.equal(transcriptKind(linked, s.roots), null);
});

test('transcriptKind tells the two kinds apart and refuses everything else', (t) => {
  const s = agySetup(t);
  const agy = s.transcript(agySession('kind'));
  const claude = path.join(s.claudeDir, 'C--repo', 'aaaaaaaa-1111.jsonl');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, session('kind'));

  assert.equal(transcriptKind(agy, s.roots), 'agy');
  assert.equal(transcriptKind(claude, s.roots), 'claude');
  // A session whose file is not written yet passes the shape check; it is checked again before a read.
  assert.equal(transcriptKind(path.join(s.claudeDir, 'C--repo', 'bbbbbbbb-2222.jsonl'), s.roots), 'claude');
  assert.equal(transcriptKind(path.join(s.claudeDir, 'C--repo', 'notes.txt'), s.roots), null);
  assert.equal(transcriptKind(`${s.claudeDir}${path.sep}C--repo${path.sep}..${path.sep}C--repo${path.sep}aaaaaaaa-1111.jsonl`, s.roots), null);
  assert.equal(transcriptKind(path.join(s.elsewhere, 'x.jsonl'), s.roots), null);
  // A folder named like a transcript is not one.
  fs.mkdirSync(path.join(s.claudeDir, 'dir.jsonl'));
  assert.equal(transcriptKind(path.join(s.claudeDir, 'dir.jsonl'), s.roots), null);
  assert.equal(transcriptKind(undefined, s.roots), null);
});

test('agy: extractPiece reads an agy piece with the agy digest', async (t) => {
  const s = agySetup(t);
  const text = agySession('a piece', [['search_web', { Query: 'x' }]]);
  const run = async () => answer('Something learned from agy');
  const res = await extractPiece({ text, project: PROJECT, dir: memoryPaths(s.configDir).dir, source: 'captured from session 0a1b2c3d on PC1', today: '2026-11-11', run, kind: 'agy' });
  assert.equal(res.ok, true);
  assert.equal(res.outside, 1);
  assert.equal(res.records.length, 1);

  // Read as a Claude transcript the same text has no user turn: no model call.
  const asClaude = await extractPiece({ text, project: PROJECT, dir: memoryPaths(s.configDir).dir, source: 's', today: '2026-11-11', run });
  assert.equal(asClaude.reason, 'too-short');
});

test('agy: a ledger path written with forward slashes still works; `..` and stream names do not', (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('slashes'));
  const slashed = file.split(path.sep).join('/');
  assert.equal(transcriptKind(slashed, s.roots), 'agy');
  const claudeFile = path.join(s.claudeDir, 'C--repo', 'cccccccc-3333.jsonl');
  assert.equal(transcriptKind(claudeFile.split(path.sep).join('/'), s.roots), 'claude');
  assert.equal(transcriptKind(`${path.dirname(slashed)}/../logs/transcript_full.jsonl`, s.roots), null);
  if (process.platform === 'win32') {
    assert.equal(transcriptKind(`${claudeFile}:stream.jsonl`, s.roots), null);
    assert.equal(transcriptKind(path.join(s.claudeDir, 'C--repo', 'a.jsonl:x.jsonl'), s.roots), null);
  }
});

test('a transcript the disk cannot check right now is skipped, not forgotten', async (t) => {
  const s = agySetup(t);
  const file = s.transcript(agySession('a locked file'));
  s.capture.track({ file, project: PROJECT });
  const realLstat = fs.lstatSync;
  const lstat = t.mock.method(fs, 'lstatSync', (p, ...rest) => {
    if (p === file) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    return realLstat(p, ...rest);
  });

  await s.capture.tick();
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.ledger().files[file], { project: PROJECT, done: 0, fails: 0, at: NOW });

  lstat.mock.restore();
  await s.capture.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger().files[file].done, fs.statSync(file).size);
});

test('sessionTranscriptOf: an agy tab gives its pinned conversation, a Claude tab its transcript', () => {
  const claudeFileOf = (cwd, id) => path.join('/claude', cwd, `${id}.jsonl`);
  const full = path.join('/agy', 'brain', AGY_CONV, '.system_generated', 'logs', 'transcript_full.jsonl');

  assert.equal(sessionTranscriptOf({ agyWatcher: { pinned: { id: AGY_CONV, full } }, cwd: 'C:/repo' }, claudeFileOf), full);
  // An agy tab that has not picked its conversation yet has none, never a guessed Claude file.
  assert.equal(sessionTranscriptOf({ agyWatcher: { pinned: null }, transcriptId: 'abc', cwd: 'C:/repo' }, claudeFileOf), null);
  assert.equal(sessionTranscriptOf({ watcher: { pinned: '/p.jsonl', currentFile: '/c.jsonl' } }, claudeFileOf), '/p.jsonl');
  assert.equal(sessionTranscriptOf({ watcher: { currentFile: '/c.jsonl' } }, claudeFileOf), '/c.jsonl');
  assert.equal(sessionTranscriptOf({ watcher: { sessionUuid: 'u1' }, transcriptId: 'u2', cwd: 'repo' }, claudeFileOf), claudeFileOf('repo', 'u1'));
  assert.equal(sessionTranscriptOf({ transcriptId: 'u2', cwd: 'repo' }, claudeFileOf), claudeFileOf('repo', 'u2'));
  assert.equal(sessionTranscriptOf({ transcriptId: 'u2' }, claudeFileOf), null);
  assert.equal(sessionTranscriptOf(null, claudeFileOf), null);
});

// ---- the Rejected-Embedding Shield in a capture tick (src/memoryshield.js) ----

const shieldMod = require('../src/memoryshield.js');

test('a capture tick buries a candidate that means what a rejected memory meant; the rest reach the inbox', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capture-shield-'));
  t.after(() => fs.promises.rm(configDir, { recursive: true, force: true, maxRetries: 5 }));
  setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const unitVec = (...xs) => Float32Array.from(xs.map((x) => x / Math.hypot(...xs)));
  const MODEL = 'qwen3-embedding-0.6b';
  const topic = (text) => (/symlink|junction/i.test(text) ? unitVec(1, 0.1, 0) : unitVec(0, 0.1, 1));
  const store = { dir: configDir, model: () => MODEL, vectorFor: () => undefined, embedTexts: async (texts) => ({ model: MODEL, vectors: texts.map(topic) }) };
  shieldMod.addRejected(shieldMod.rejectedVectorsPath(configDir), { model: MODEL, project: PROJECT, title: 'Junction node_modules into worktrees', vec: unitVec(1, 0.1, 0), at: NOW });

  const capture = createCapture({
    configDir,
    machine: 'PC1',
    transcriptsDir: configDir,
    now: () => NOW,
    run: async () => answer('Symlink the dependencies from the main checkout', 'Name the installer asset with dashes'),
    vectors: () => store,
  });
  const file = path.join(configDir, 'abcdef01-shield.jsonl');
  fs.writeFileSync(file, session('the worktree setup'));
  const when = new Date(NOW - SETTLE_MS - 1000);
  fs.utimesSync(file, when, when);
  capture.track({ file, project: PROJECT });

  const res = await capture.tick();
  assert.equal(res.saved, 1);
  assert.deepEqual(listInbox(memoryPaths(configDir).dir).items.map((i) => i.title), ['Name the installer asset with dashes']);
  const buried = readGraveyard(graveyardPath(configDir), NOW);
  assert.deepEqual(buried.map((e) => [e.reason, e.record.title]), [['similar to rejected: Junction node_modules into worktrees', 'Symlink the dependencies from the main checkout']]);
});
