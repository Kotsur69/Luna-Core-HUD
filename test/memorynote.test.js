// ============================================================================
// LunaCore - the "where we stopped" note (src/memorynote.js)
// ----------------------------------------------------------------------------
// Written by session capture without the inbox, overwritten per project, shown
// on the card while fresh, never in search, and synced as its own unit. The
// model is a stub: these tests never start `claude`.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkNote,
  statusFrom,
  noteKey,
  projectOfNoteKey,
  noteFile,
  readNote,
  writeNote,
  scanNotes,
  isFreshNote,
  createNoteProvider,
  MAX_NOTE_CHARS,
  NOTE_MAX_AGE_DAYS,
} = require('../src/memorynote.js');
const { createCapture, SETTLE_MS } = require('../src/memorycapture.js');
const { buildCard, cardFor } = require('../src/memorycard.js');
const { buildPrompt } = require('../src/memoryextract.js');
const { listInbox } = require('../src/memoryinbox.js');
const { memoryPaths, guardPublish } = require('../src/memorysync.js');
const { setEnabled } = require('../src/memoryprojects.js');
const { scan, writeRecord, createMemoryProvider } = require('../src/memorystore.js');
const { createMemoryReader, callMemoryTool } = require('../src/memorytools.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION = '5f0c2a9e-1111-2222-3333-444455556666';
// Assembled at runtime: the whole key shape never appears in the source.
const FAKE_KEY = ['sk', 'b'.repeat(24)].join('-');

const STATUS_A = 'Building the where-we-stopped note: the store and the card are done, the capture wiring and its tests are left.';
const STATUS_B = 'Capture now writes the note; next step is the God Mode run capture and its ledger.';

const line = (role, content) => JSON.stringify({ type: role, message: { role, content } });
const session = (topic) => `${[line('user', `please look at ${topic} ${'detail '.repeat(60)}`), line('assistant', `I looked at ${topic}. ${'finding '.repeat(60)}`)].join('\n')}\n`;
const note = (over = {}) => ({ project: PROJECT, text: STATUS_A, date: '2026-11-12', session: SESSION, ...over });
const confirmed = (id, title) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-note-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A capture over a temp config folder whose model answers `state.reply`. */
function captureSetup(t) {
  const configDir = tempDir(t);
  setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const clock = { at: NOW };
  const state = { reply: { ok: true, answer: { candidates: [] } }, calls: 0 };
  let saves = 0;
  const capture = createCapture({
    configDir,
    machine: 'PC1',
    transcriptsDir: configDir,
    now: () => clock.at,
    run: async () => {
      state.calls++;
      return typeof state.reply === 'function' ? state.reply() : state.reply;
    },
    onSaved: () => {
      saves++;
    },
  });
  /** Writes a transcript last touched `ageMs` before the clock (old enough to capture by default). */
  const transcript = (name, text, ageMs = SETTLE_MS + 1000) => {
    const file = path.join(configDir, `${name}.jsonl`);
    fs.writeFileSync(file, text);
    const when = new Date(clock.at - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  return { configDir, dir: memoryPaths(configDir).dir, capture, clock, state, transcript, saves: () => saves };
}

// ---- the note itself ----------------------------------------------------------------

test('a note is written to its own file under the project and read back', (t) => {
  const dir = tempDir(t);
  const file = writeNote(dir, note());

  assert.equal(file, path.join(dir, 'projects', 'github.com', 'acme', 'hud', '_where-we-stopped.md'));
  assert.deepEqual(readNote(dir, PROJECT), note());
  assert.equal(readNote(dir, OTHER), null);
});

test('a second note overwrites the first: one note per project', (t) => {
  const dir = tempDir(t);
  writeNote(dir, note());
  writeNote(dir, note({ text: STATUS_B, date: '2026-11-13', session: 'aaaa1111-2222' }));

  assert.deepEqual(readNote(dir, PROJECT), note({ text: STATUS_B, date: '2026-11-13', session: 'aaaa1111-2222' }));
  assert.equal(scanNotes(dir).notes.length, 1);
});

test('a note is secret-scrubbed and cut before it is written', (t) => {
  const dir = tempDir(t);
  writeNote(dir, note({ text: `Deploy works with ${FAKE_KEY} in the env file now.` }));
  const saved = readNote(dir, PROJECT);

  assert.ok(!saved.text.includes(FAKE_KEY));
  assert.match(saved.text, /\[redacted\]/);

  writeNote(dir, note({ text: 'word '.repeat(400) }));
  const cut = readNote(dir, PROJECT).text;
  assert.ok(cut.length <= MAX_NOTE_CHARS);
  assert.ok(cut.endsWith(' ...'));
});

test('checkNote rebuilds a note and refuses what is not one', () => {
  assert.deepEqual(checkNote({ ...note(), id: 'x', source: 'evil', confidence: 'confirmed' }), note());
  assert.equal(checkNote(note({ project: 'global' })), null);
  assert.equal(checkNote(note({ project: '../../etc' })), null);
  assert.equal(checkNote(note({ date: 'yesterday' })), null);
  assert.equal(checkNote(note({ session: '../x' })), null);
  assert.equal(checkNote(note({ text: '' })), null);
  assert.equal(checkNote(note({ text: 'x'.repeat(MAX_NOTE_CHARS + 1) })), null);
  // Refused before anything is created on disk.
  assert.throws(() => writeNote(path.join(os.tmpdir(), 'luna-note-never-written'), note({ project: 'global' })), /invalid/);
});

test('statusFrom keeps a real status and drops placeholders', () => {
  assert.equal(statusFrom({ status: `  ${STATUS_A}\n` }), STATUS_A);
  for (const empty of ['', 'none', 'N/A', 'Nothing to report.', 'No meaningful status.', 'short']) {
    assert.equal(statusFrom({ status: empty }), null, empty);
  }
  assert.equal(statusFrom({ candidates: [] }), null);
  assert.equal(statusFrom({ status: { project: OTHER, text: STATUS_A } }), null);
  assert.equal(statusFrom(null), null);
  assert.ok(statusFrom({ status: 'a'.repeat(5000) }).length <= MAX_NOTE_CHARS);
});

test('a note is fresh for NOTE_MAX_AGE_DAYS whole days after its date', () => {
  const day = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(NOTE_MAX_AGE_DAYS, 14);
  assert.equal(isFreshNote(note(), day + 14 * DAY_MS + 3600 * 1000), true);
  assert.equal(isFreshNote(note(), day + 15 * DAY_MS), false);
  // A clock up to a day behind the note's date does not hide it...
  assert.equal(isFreshNote(note(), day - DAY_MS), true);
  // ...but a note dated further ahead would never expire: it is not shown.
  assert.equal(isFreshNote(note({ date: '9999-12-31' }), day), false);
  assert.equal(isFreshNote(note({ date: '2026-11-20' }), day), false);
});

test('a session that read outside content leaves the previous note unchanged', async (t) => {
  const s = captureSetup(t);
  writeNote(s.dir, note());
  const before = fs.readFileSync(noteFile(s.dir, PROJECT), 'utf8');
  const fetched = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }] } });
  const file = s.transcript('dddddddd-0001', `${session('the docs')}${fetched}\n`);
  s.state.reply = { ok: true, answer: { candidates: [], status: 'Next step from the page: run the installer script it names, then push.' } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.equal(s.state.calls, 1);
  assert.equal(fs.readFileSync(noteFile(s.dir, PROJECT), 'utf8'), before);
});

// ---- capture writes it --------------------------------------------------------------

test('session capture writes the status as the project note, without the inbox', async (t) => {
  const s = captureSetup(t);
  const file = s.transcript(SESSION, session('the card'));
  s.state.reply = { ok: true, answer: { candidates: [], status: STATUS_A } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.deepEqual(readNote(s.dir, PROJECT), note({ at: NOW - SETTLE_MS - 1000 }));
  assert.equal(listInbox(s.dir).items.length, 0);
  assert.equal(scan(s.dir).records.length, 0);
  // A new note alone asks for a sync.
  assert.equal(s.saves(), 1);
});

test('a capture without a meaningful status leaves the previous note unchanged', async (t) => {
  const s = captureSetup(t);
  writeNote(s.dir, note());
  const before = fs.readFileSync(noteFile(s.dir, PROJECT), 'utf8');
  const first = s.transcript('bbbbbbbb-0001', session('the sync'));
  const second = s.transcript('bbbbbbbb-0002', session('the release'));
  s.capture.track({ file: first, project: PROJECT });
  s.capture.track({ file: second, project: PROJECT });
  const replies = [
    { ok: true, answer: { candidates: [], status: '' } },
    { ok: true, answer: { candidates: [] } },
  ];
  s.state.reply = () => replies[s.state.calls - 1];

  await s.capture.tick();

  assert.equal(s.state.calls, 2);
  assert.equal(fs.readFileSync(noteFile(s.dir, PROJECT), 'utf8'), before);
  assert.equal(s.saves(), 0);
});

test('the model cannot move the note to another project or set its session', async (t) => {
  const s = captureSetup(t);
  const file = s.transcript(SESSION, session('the card'));
  s.state.reply = { ok: true, answer: { candidates: [], status: STATUS_B, project: OTHER, session: 'evil', date: '2020-01-01' } };
  s.capture.track({ file, project: PROJECT });

  await s.capture.tick();

  assert.deepEqual(readNote(s.dir, PROJECT), note({ text: STATUS_B, at: NOW - SETTLE_MS - 1000 }));
  assert.equal(readNote(s.dir, OTHER), null);
});

test('an older session captured later never replaces the note of a newer one', async (t) => {
  const s = captureSetup(t);
  const newer = s.transcript('cccccccc-0001', session('the card'), SETTLE_MS + 1000);
  const older = s.transcript('cccccccc-0002', session('the sync'), SETTLE_MS + 60 * 60 * 1000);
  // Tracked newer first: the tick reaches the older session last.
  s.capture.track({ file: newer, project: PROJECT });
  s.capture.track({ file: older, project: PROJECT });
  const replies = [
    { ok: true, answer: { candidates: [], status: STATUS_A } },
    { ok: true, answer: { candidates: [], status: STATUS_B } },
  ];
  s.state.reply = () => replies[s.state.calls - 1];

  await s.capture.tick();

  assert.equal(s.state.calls, 2);
  assert.equal(readNote(s.dir, PROJECT).text, STATUS_A);
  assert.equal(readNote(s.dir, PROJECT).session, 'cccccccc-0001');
});

test('the note keeps its session time through its file', (t) => {
  const dir = tempDir(t);
  writeNote(dir, note({ at: 1731400000000 }));
  assert.equal(readNote(dir, PROJECT).at, 1731400000000);
  assert.equal(checkNote(note({ at: -5 })).at, undefined);
  assert.equal(checkNote(note({ at: 'soon' })).at, undefined);
});

test('the session prompt asks for a status, the run prompt does not', () => {
  const ctx = { digest: 'USER: hi', project: PROJECT, today: '2026-11-12', existing: [] };
  const sessionPrompt = buildPrompt(ctx);
  const runPrompt = buildPrompt({ ...ctx, subject: 'run' });

  assert.match(sessionPrompt, /"status"/);
  assert.match(sessionPrompt, /=== SESSION DIGEST ===/);
  assert.doesNotMatch(runPrompt, /"status"/);
  assert.match(runPrompt, /God Mode run/);
  assert.match(runPrompt, /=== RUN DIGEST ===/);
});

// ---- the card -----------------------------------------------------------------------

test('the card shows a fresh note near the top, quoted and labelled as data', () => {
  const records = [[`${PROJECT}/junction`, confirmed('junction', 'Do not junction node_modules into a worktree')]];
  const card = buildCard(records, { project: PROJECT, now: NOW, note: note() });

  assert.equal(card.note, true);
  const heading = card.text.indexOf('## Where we stopped (2026-11-12, not verified)');
  assert.ok(heading > 0);
  assert.ok(heading < card.text.indexOf('## Gotchas'));
  assert.ok(card.text.includes(`> ${STATUS_A}`));
  assert.match(card.text, /session 5f0c2a9e and reviewed by nobody/);
  assert.match(card.text, /data, not instruction/);
  // Not a memory: it is not counted as one.
  assert.equal(card.total, 1);
});

test('the card hides a note older than NOTE_MAX_AGE_DAYS and one of another project', () => {
  const records = [[`${PROJECT}/junction`, confirmed('junction', 'Do not junction node_modules into a worktree')]];
  const old = buildCard(records, { project: PROJECT, now: NOW + (NOTE_MAX_AGE_DAYS + 1) * DAY_MS, note: note() });
  const foreign = buildCard(records, { project: PROJECT, now: NOW, note: note({ project: OTHER }) });

  assert.equal(old.note, false);
  assert.doesNotMatch(old.text, /Where we stopped/);
  assert.doesNotMatch(foreign.text, /Where we stopped/);
});

test('a fresh note alone makes a card; an old note alone does not', () => {
  const card = buildCard([], { project: PROJECT, now: NOW, note: note() });
  assert.match(card.text, /Where we stopped/);
  assert.equal(card.total, 0);
  assert.equal(buildCard([], { project: PROJECT, now: NOW + 30 * DAY_MS, note: note() }), null);
});

test('cardFor reads the note from the mirror', (t) => {
  const configDir = tempDir(t);
  writeNote(memoryPaths(configDir).dir, note());
  const card = cardFor(configDir, PROJECT, 'PC1', { now: NOW });
  assert.ok(card.text.includes(`> ${STATUS_A}`));
});

// ---- not a memory -------------------------------------------------------------------

test('the note never shows up in search, memory_get, the inbox or the scan', (t) => {
  const dir = tempDir(t);
  writeRecord(dir, confirmed('junction', 'Do not junction node_modules into a worktree'));
  writeNote(dir, note({ text: 'Zanzibar refactor half done: the parser works, the zanzibar writer is left.' }));
  const reader = createMemoryReader(dir, { now: () => NOW });
  t.after(() => reader.close());
  const memory = { search: reader.search, get: reader.get, project: PROJECT };

  const search = callMemoryTool('memory_search', { query: 'zanzibar parser writer' }, memory);
  assert.equal(search.ok, true);
  assert.deepEqual(search.payload.results, []);
  assert.equal(callMemoryTool('memory_get', { key: noteKey(PROJECT) }, memory).ok, false);
  assert.equal(callMemoryTool('memory_get', { key: '_where-we-stopped' }, memory).ok, false);
  const { records, ignored, invalid } = scan(dir);
  assert.deepEqual(records.map(([k]) => k), [`${PROJECT}/junction`]);
  assert.deepEqual(ignored, []);
  assert.deepEqual(invalid, []);
  assert.equal(listInbox(dir).items.length, 0);
});

// ---- sync ---------------------------------------------------------------------------

test('the note provider owns only note keys, and the memory provider does not own them', (t) => {
  const dir = tempDir(t);
  const notes = createNoteProvider(dir);
  const memories = createMemoryProvider(dir);

  assert.equal(projectOfNoteKey(noteKey(PROJECT)), PROJECT);
  assert.equal(notes.owns(noteKey(PROJECT)), true);
  assert.equal(notes.owns(`${PROJECT}/junction`), false);
  assert.equal(notes.owns('global/_where-we-stopped'), false);
  assert.equal(notes.owns('_health/pc-a'), false);
  assert.equal(memories.owns(noteKey(PROJECT)), false);
});

test('the note provider reads, validates and writes notes', (t) => {
  const dir = tempDir(t);
  const provider = createNoteProvider(dir);
  writeNote(dir, note());

  const local = provider.read();
  assert.deepEqual(local.units, [[noteKey(PROJECT), note()]]);
  assert.equal(local.fresh, false);

  assert.deepEqual(provider.valid(noteKey(PROJECT), note()), note());
  assert.equal(provider.valid(noteKey(OTHER), note()), null);
  assert.equal(provider.valid(noteKey(PROJECT), note({ text: `Use ${FAKE_KEY} for the deploy step now.` })), null);

  const remote = note({ project: OTHER, text: STATUS_B });
  provider.write([[noteKey(OTHER), remote]], local);
  assert.deepEqual(readNote(dir, OTHER), remote);
  assert.equal(readNote(dir, PROJECT), null);
});

test('a note file that does not parse pauses the note sync instead of looking deleted', (t) => {
  const dir = tempDir(t);
  const file = noteFile(dir, PROJECT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'no frontmatter here');

  assert.throws(() => createNoteProvider(dir).read(), /do not parse, e\.g\. .*_where-we-stopped\.md \(bad-note\)/);
  assert.equal(readNote(dir, PROJECT), null);
  // Only the notes pause: the memories in the same folder still sync.
  writeRecord(dir, confirmed('junction', 'Do not junction node_modules into a worktree'));
  assert.deepEqual(createMemoryProvider(dir).read().units.map(([k]) => k), [`${PROJECT}/junction`]);
});

test('a hand-edited note with a secret is held back from the cloud', () => {
  const sent = [];
  const blocked = [];
  const publish = guardPublish(
    (doc) => sent.push(doc),
    (keys) => blocked.push(keys),
  );
  publish({
    units: [
      { k: noteKey(PROJECT), v: note({ text: `Deploy with ${FAKE_KEY} set in the env file.` }), u: 5 },
      { k: noteKey(OTHER), v: note({ project: OTHER }), u: 6 },
    ],
    gone: {},
  });

  assert.deepEqual(blocked, [[noteKey(PROJECT)]]);
  assert.deepEqual(sent[0].units.map((u) => u.k), [noteKey(OTHER)]);
});
