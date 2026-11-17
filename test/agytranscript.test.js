// Tests for the Antigravity (agy) transcript adapter (src/agytranscript.js)
// and its watcher (src/agywatcher.js).
//
// TWO FIXTURES, ONE ASSUMED AND ONE CAPTURED:
// * test/fixtures/agy-transcript.assumed.jsonl follows the step format agy
//   documents inside agy.exe 1.5.9 (step_index, type, status, created_at,
//   content, tool_calls [{name, args}] with JSON-quoted string args, GENERIC
//   results in call order). Its tool calls and results were NOT seen live.
// * test/fixtures/agy-transcript.captured-user-input.jsonl is a real line
//   agy 1.5.9 wrote on 2026-11-17 (a run Google's quota refused before the
//   model answered, so it holds the user step only).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  AGY_CONTEXT_LIMIT,
  AGY_TOOL_TILES,
  MAX_EVENTS_PER_STEP,
  unquoteArg,
  normalizeAgyPath,
  editStatOf,
  modelFromUserInput,
  parseSteps,
  AgyTranscriptState,
  agyContextMetrics,
  workspacesFromRows,
  workspaceMatch,
} = require('../src/agytranscript');
const { AgyTranscriptWatcher, readConversationWorkspaces } = require('../src/agywatcher');
const { TOOL_TILES, usageToMetrics } = require('../src/observer');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.assumed.jsonl'), 'utf8');
const CAPTURED = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.captured-user-input.jsonl'), 'utf8');
const CAPTURED_MODEL = 'Gemini 4 Argon (Medium)';
const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';
/** The fixture's agy paths (C:/repo/...) the way the adapter reports them on this platform. */
const fixturePath = (p) => normalizeAgyPath(p, CWD);

// ---- parsing ------------------------------------------------------------------

test('parseSteps reads every step of the fixture and skips nothing', () => {
  const { steps, skipped } = parseSteps(FIXTURE);
  assert.equal(steps.length, 9);
  assert.deepEqual(skipped, []);
  assert.deepEqual(steps.map((s) => s.type), [
    'USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'GENERIC', 'PLANNER_RESPONSE', 'GENERIC', 'GENERIC', 'GENERIC', 'PLANNER_RESPONSE',
  ]);
  assert.equal(steps[1].toolCalls.length, 2);
  assert.equal(steps[1].at, Date.parse('2026-11-17T08:00:05Z'));
});

test('the line a real agy run wrote parses, and names the model', () => {
  const { steps, skipped } = parseSteps(CAPTURED);
  assert.deepEqual(skipped, []);
  assert.equal(steps.length, 1);
  assert.deepEqual([steps[0].index, steps[0].type, steps[0].status], [0, 'USER_INPUT', 'DONE']);
  assert.equal(steps[0].at, Date.parse('2026-11-17T09:17:27Z'));
  const state = new AgyTranscriptState({ cwd: CWD });
  assert.deepEqual(state.apply(steps), []);
  assert.equal(state.model, CAPTURED_MODEL);
  assert.equal(state.contextChars, steps[0].content.length);
});

test('modelFromUserInput takes the model only from agy\'s settings line', () => {
  assert.equal(modelFromUserInput('The user changed setting `Model Selection` from A to B 2.'), 'B 2');
  assert.equal(modelFromUserInput('please use model X.'), '');
  assert.equal(modelFromUserInput('setting `Model Selection` from A to ' + 'x'.repeat(200) + '.'), '');
  assert.equal(modelFromUserInput(undefined), '');
});

test('parseSteps accepts the full enum name of a step type', () => {
  const { steps } = parseSteps(JSON.stringify({ type: 'CORTEX_STEP_TYPE_GENERIC', status: 'DONE' }));
  assert.equal(steps[0].type, 'GENERIC');
});

test('unquoteArg undoes agy\'s JSON quoting and leaves other values alone', () => {
  assert.equal(unquoteArg('"C:/repo/a.js"'), 'C:/repo/a.js');
  assert.equal(unquoteArg('plain'), 'plain');
  assert.equal(unquoteArg('"broken\\"'), 'broken\\');
  assert.equal(unquoteArg(42), 42);
});

test('normalizeAgyPath gives absolute paths and rejects junk', () => {
  assert.equal(normalizeAgyPath('"src/a.js"', CWD), path.resolve(CWD, 'src/a.js'));
  assert.equal(normalizeAgyPath(pathToFileURL(path.join(CWD, 'b.js')).href, CWD), path.join(CWD, 'b.js'));
  assert.equal(normalizeAgyPath('relative.js', ''), '');
  assert.equal(normalizeAgyPath('a\0b', CWD), '');
  assert.equal(normalizeAgyPath('x'.repeat(5000), CWD), '');
  assert.equal(normalizeAgyPath(null, CWD), '');
});

test('normalizeAgyPath never yields a network path (a stat of one would leak NTLM credentials)', () => {
  assert.equal(normalizeAgyPath('\\\\evil\\share\\x.js', CWD), '');
  assert.equal(normalizeAgyPath('"//evil/share/x.js"', CWD), '');
  assert.equal(normalizeAgyPath('\\\\?\\C:\\repo\\x.js', CWD), '');
  assert.equal(normalizeAgyPath('file://evil/share/x.js', CWD), '');
  // Decoding can produce a NUL the raw string did not have.
  assert.equal(normalizeAgyPath(`${pathToFileURL(path.join(CWD, 'a')).href}%00b`, CWD), '');
});

test('editStatOf counts replace chunks exactly, in both chunk forms', () => {
  const chunks = JSON.stringify([
    { TargetContent: 'a\nb', ReplacementContent: 'a\nB\nc' },
    { TargetContent: 'x', ReplacementContent: '' },
  ]);
  assert.deepEqual(editStatOf('Edit', { ReplacementChunks: chunks }), { added: 2, removed: 2 });
  assert.deepEqual(editStatOf('Edit', { TargetContent: '"one"', ReplacementContent: '"two"' }), { added: 1, removed: 1 });
  assert.deepEqual(editStatOf('Edit', { ReplacementChunks: 'not json' }), { added: 0, removed: 0 });
  assert.deepEqual(editStatOf('Write', { CodeContent: 'a\nb\n' }), { added: 2, removed: 0 });
  assert.deepEqual(editStatOf('Read', { CodeContent: 'a' }), { added: 0, removed: 0 });
});

// ---- file events ----------------------------------------------------------------

test('the fixture yields balanced start/end pairs with files, stats and read sizes', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const events = state.apply(parseSteps(FIXTURE).steps);
  const appJs = fixturePath('C:/repo/src/app.js');
  const helperJs = fixturePath('C:/repo/src/helper.js');

  assert.equal(events.filter((e) => e.phase === 'start').length, events.filter((e) => e.phase === 'end').length);
  assert.deepEqual(
    events.map((e) => `${e.phase}:${e.tile}`),
    ['start:Read', 'start:Grep', 'end:Read', 'end:Grep', 'start:Edit', 'start:Write', 'start:Shell', 'end:Edit', 'end:Write', 'end:Shell'],
  );
  const readEnd = events.find((e) => e.phase === 'end' && e.tile === 'Read');
  assert.equal(readEnd.file, appJs);
  assert.equal(readEnd.contextChars, 'const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n'.length);
  assert.ok(readEnd.contextTokens > 0);

  const editEnd = events.find((e) => e.phase === 'end' && e.tile === 'Edit');
  assert.deepEqual([editEnd.file, editEnd.added, editEnd.removed], [appJs, 2, 1]);
  // The write's result is an ERROR: the file was touched, nothing changed.
  const writeEnd = events.find((e) => e.phase === 'end' && e.tile === 'Write');
  assert.deepEqual([writeEnd.file, writeEnd.added, writeEnd.removed], [helperJs, 0, 0]);
  // A shell call and a folder search carry no file identity.
  assert.equal(events.find((e) => e.tile === 'Grep').file, '');
  assert.equal(events.find((e) => e.tile === 'Shell').file, '');
  assert.equal(state.pending.length, 0);
});

test('a call and its result in different fragments still pair up', () => {
  const lines = FIXTURE.trim().split('\n');
  const state = new AgyTranscriptState({ cwd: CWD });
  const first = state.apply(parseSteps(lines.slice(0, 2).join('\n')).steps);
  assert.deepEqual(first.map((e) => e.phase), ['start', 'start']);
  assert.equal(state.pending.length, 2);
  const second = state.apply(parseSteps(lines.slice(2, 4).join('\n')).steps);
  assert.deepEqual(second.map((e) => `${e.phase}:${e.id}`), [`end:${first[0].id}`, `end:${first[1].id}`]);
});

test('a new planner step ends the calls that never got a result', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const step = (type, extra = {}) => JSON.stringify({ type, status: 'DONE', ...extra });
  const text = [
    step('PLANNER_RESPONSE', { step_index: 1, tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"C:/repo/a.js"' } }] }),
    step('PLANNER_RESPONSE', { step_index: 2 }),
  ].join('\n');
  const events = state.apply(parseSteps(text).steps);
  assert.deepEqual(events.map((e) => e.phase), ['start', 'end']);
  assert.equal(events[1].contextChars, 0);
  assert.equal(state.unresolved, 1);
});

test('a step logged again under the same step_index counts once and shifts no result', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const read = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });
  const text = [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [read('a.js'), read('b.js')] }),
    JSON.stringify({ type: 'GENERIC', step_index: 2, status: 'RUNNING', content: 'aaa' }),
    JSON.stringify({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'aaa' }),
    JSON.stringify({ type: 'GENERIC', step_index: 3, status: 'DONE', content: 'bb' }),
  ].join('\n');
  const steps = parseSteps(text).steps;
  const events = state.apply(steps);
  const ends = events.filter((e) => e.phase === 'end');
  assert.deepEqual(ends.map((e) => [path.basename(e.file), e.contextChars]), [['a.js', 3], ['b.js', 2]]);
  assert.equal(state.contextChars, steps[0].chars + steps[1].chars + steps[3].chars);
});

test('a planner step logged first without its tool calls opens them when logged again', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const text = [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, status: 'RUNNING', content: 'Looking.' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Looking.',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:/repo/a.js' } }],
    }),
    JSON.stringify({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'abc' }),
  ].join('\n');
  const steps = parseSteps(text).steps;
  const events = state.apply(steps);
  assert.deepEqual(events.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read']);
  // The second version replaces the first in the window, it does not add to it.
  assert.equal(state.contextChars, steps[1].chars + steps[2].chars);
  // A third copy opens nothing again.
  assert.deepEqual(state.apply([steps[1]]), []);
});

test('event ids never collide, even across conversations restarted from step 0', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const first = state.apply(parseSteps(FIXTURE).steps);
  state.lastIndex = -1; // as after a restart of the same state
  const second = state.apply(parseSteps(FIXTURE).steps);
  const starts = [...first, ...second].filter((e) => e.phase === 'start').map((e) => e.id);
  assert.equal(new Set(starts).size, starts.length);
});

test('one step lights at most MAX_EVENTS_PER_STEP tools, and the results still pair up', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const calls = Array.from({ length: MAX_EVENTS_PER_STEP + 50 }, (_, i) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/f${i}.js` } }));
  const lines = [JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: calls })];
  for (let i = 0; i < calls.length; i++) lines.push(JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'x' }));
  const events = state.apply(parseSteps(lines.join('\n')).steps);
  assert.equal(events.filter((e) => e.phase === 'start').length, MAX_EVENTS_PER_STEP);
  assert.equal(events.filter((e) => e.phase === 'end').length, MAX_EVENTS_PER_STEP);
  assert.equal(state.pending.length, 0);
});

test('tools without a tile (MCP, browser) still take their place in the result order', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const text = [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'mcp_thing', args: {} }, { name: 'view_file', args: { AbsolutePath: 'C:/repo/a.js' } }] }),
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'mcp output' }),
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'abc' }),
  ].join('\n');
  const events = state.apply(parseSteps(text).steps);
  assert.deepEqual(events.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read']);
  assert.equal(events[1].contextChars, 3);
});

test('every agy tile is a Skill Tracker tile the Claude path already has', () => {
  for (const tile of Object.keys(AGY_TOOL_TILES)) assert.ok(TOOL_TILES[tile], `unknown tile ${tile}`);
});

// ---- context metrics -------------------------------------------------------------

test('agyContextMetrics has usageToMetrics\' shape plus the estimated flag', () => {
  const m = agyContextMetrics(36000, { file: 'x.jsonl', elapsedMs: 5 });
  for (const key of Object.keys(usageToMetrics({}, ''))) assert.ok(key in m, `missing ${key}`);
  assert.equal(m.estimated, true);
  assert.equal(m.limit, AGY_CONTEXT_LIMIT);
  assert.equal(m.tokens, 10000);
  assert.equal(m.percent, 0.01);
  assert.equal(m.model, 'agy');
  assert.equal(agyContextMetrics(1, { model: CAPTURED_MODEL }).modelLabel, CAPTURED_MODEL);
  assert.equal(agyContextMetrics(1e12).percent, 1);
  assert.equal(agyContextMetrics(-5).tokens, 0);
  assert.equal(agyContextMetrics('junk').tokens, 0);
});

test('context chars grow with every step and a checkpoint resets them', () => {
  const state = new AgyTranscriptState();
  state.apply(parseSteps(FIXTURE).steps);
  const before = state.contextChars;
  assert.ok(before > 0);
  state.apply(parseSteps(JSON.stringify({ type: 'CHECKPOINT', content: 'summary' })).steps);
  assert.equal(state.contextChars, 'summary'.length);
});

test('thinking is not counted as context', () => {
  const plain = new AgyTranscriptState();
  const thinking = new AgyTranscriptState();
  plain.apply(parseSteps(JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'hi' })).steps);
  thinking.apply(parseSteps(JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'hi', thinking: 'x'.repeat(1000) })).steps);
  assert.equal(thinking.contextChars, plain.contextChars);
});

// ---- malformed input ----------------------------------------------------------------

test('malformed lines give no steps and a reason each, never a throw', () => {
  const text = ['{not json', '[1,2]', '"text"', '{"no":"type"}', '', '   '].join('\n');
  const { steps, skipped } = parseSteps(text);
  assert.deepEqual(steps, []);
  assert.equal(skipped.length, 4);
  // A reason never quotes the line: transcripts hold the user's prompts.
  assert.equal(skipped[0].reason, 'invalid JSON');
  assert.equal(skipped[1].reason, 'not a JSON object');
  assert.equal(skipped[3].reason, 'step has no type');
  assert.deepEqual(parseSteps(undefined), { steps: [], skipped: [] });
});

test('garbage tool calls are dropped, the step survives', () => {
  const line = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    tool_calls: [null, 7, { name: 5 }, { name: '' }, { name: 'x'.repeat(300) }, { name: 'view_file', args: 'not json' }],
  });
  const { steps } = parseSteps(line);
  assert.deepEqual(steps[0].toolCalls.map((c) => [c.name, c.args]), [['view_file', {}]]);
  // No path: the Read lights the tile, but no file row is keyed on it.
  const events = new AgyTranscriptState({ cwd: CWD }).apply(steps);
  assert.deepEqual(events.map((e) => [e.tile, e.file]), [['Read', '']]);
});

test('workspacesFromRows keeps valid rows only', () => {
  const id = '0b6cd2b4-0b4a-4e4f-9d5b-6d0f1a2b3c4d';
  const uri = pathToFileURL(CWD).href;
  const { byId, skipped } = workspacesFromRows([
    { conversation_id: id.toUpperCase(), workspace_uris: JSON.stringify([uri, 'https://x', 7, '\\\\evil\\share', CWD]) },
    { conversation_id: 'nope', workspace_uris: '[]' },
    { conversation_id: '1b6cd2b4-0b4a-4e4f-9d5b-6d0f1a2b3c4d', workspace_uris: '{broken' },
    null,
  ]);
  assert.deepEqual([...byId.keys()], [id]);
  // The file URL and the plain absolute path; no URL, number or network share.
  assert.equal(byId.get(id).length, 2);
  assert.equal(skipped, 3);
  assert.deepEqual(workspacesFromRows('junk'), { byId: new Map(), skipped: 0 });
});

test('workspaceMatch tells an exact folder from a containing one', () => {
  const { byId } = workspacesFromRows([
    { conversation_id: '0b6cd2b4-0b4a-4e4f-9d5b-6d0f1a2b3c4d', workspace_uris: JSON.stringify([pathToFileURL(CWD).href]) },
  ]);
  const folders = [...byId.values()][0];
  assert.equal(workspaceMatch(folders, CWD), 'exact');
  assert.equal(workspaceMatch(folders, path.join(CWD, 'sub')), 'contains');
  assert.equal(workspaceMatch(folders, `${CWD}-other`), null, 'a sibling with a common prefix is not inside');
  assert.equal(workspaceMatch(undefined, CWD), null);
  assert.equal(workspaceMatch(folders, ''), null);
});

// ---- the watcher, against a temporary agy app data folder ---------------------------------

const tmpRoots = [];
test.after(async () => {
  for (const dir of tmpRoots) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Writes agy's summaries database into `root`: rows {id: folder}. */
function writeSummaries(root, workspaces) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
  db.exec('create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)');
  const insert = db.prepare('insert into conversation_summaries values (?, ?)');
  for (const [id, folder] of Object.entries(workspaces)) insert.run(id, JSON.stringify([pathToFileURL(folder).href]));
  db.close();
}

/** A fake <appData>: summaries rows {id: folder}, transcripts written by the test. */
function makeAppData(workspaces) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-'));
  tmpRoots.push(root);
  if (workspaces) writeSummaries(root, workspaces);
  return root;
}

/** A temporary folder standing in for a tab's cwd. */
function makeTabDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-tab-'));
  tmpRoots.push(dir);
  return dir;
}

/** Ticks until the watcher has read everything there is (chunked reads take several). */
function drain(watcher, ticks = 50) {
  for (let i = 0; i < ticks; i++) watcher.safeTick();
}

function writeTranscript(root, id, text, name = 'transcript.jsonl') {
  const dir = path.join(root, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

/** A watcher driven by hand (no timer), recording what it emits. */
function makeWatcher(root, cwd, extra = {}) {
  const out = { metrics: [], tools: [], logs: [] };
  const watcher = new AgyTranscriptWatcher((m) => out.metrics.push(m), {
    cwd,
    appDataDir: root,
    onTools: (events) => out.tools.push(...events),
    log: (msg) => out.logs.push(msg),
    ...extra,
  });
  watcher.snapshotBaseline();
  return { watcher, out };
}

test('watcher: picks the new conversation in its own folder and emits events + estimated metrics', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir, [ID_B]: path.join(tabDir, 'elsewhere') });
  const { watcher, out } = makeWatcher(root, tabDir);
  watcher.safeTick();
  assert.equal(out.metrics.length, 0, 'nothing to read yet');

  writeTranscript(root, ID_B, FIXTURE); // another folder's conversation
  const mine = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(watcher.pinned.full, mine);
  assert.equal(out.tools.length, 10);
  assert.equal(out.metrics.length, 1);
  assert.equal(out.metrics[0].estimated, true);
  assert.equal(out.metrics[0].file, mine);
  assert.ok(out.metrics[0].tokens > 0);

  // Appended lines arrive on the next tick; an unchanged file emits nothing.
  fs.appendFileSync(mine, `${JSON.stringify({ type: 'USER_INPUT', content: 'x'.repeat(3600) })}\n`);
  watcher.safeTick();
  watcher.safeTick();
  assert.equal(out.metrics.length, 2);
  assert.ok(out.metrics[1].tokens >= out.metrics[0].tokens + 1000);
  assert.deepEqual(out.logs, []);
  watcher.stop();
});

test('watcher: two tabs on one folder never share a conversation', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir, [ID_B]: tabDir });
  const one = makeWatcher(root, tabDir);
  const two = makeWatcher(root, tabDir);
  writeTranscript(root, ID_A, FIXTURE);
  one.watcher.safeTick();
  two.watcher.safeTick();
  assert.ok(one.watcher.pinned);
  assert.equal(two.watcher.pinned, null);
  writeTranscript(root, ID_B, FIXTURE);
  two.watcher.safeTick();
  assert.ok(two.watcher.pinned);
  assert.notEqual(two.watcher.pinned.full, one.watcher.pinned.full);
  one.watcher.stop();
  two.watcher.stop();
});

test('watcher: a claim is per conversation, not per file name', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir });
  const one = makeWatcher(root, tabDir);
  const two = makeWatcher(root, tabDir);
  writeTranscript(root, ID_A, FIXTURE, 'transcript.jsonl');
  one.watcher.safeTick();
  assert.ok(one.watcher.pinned);
  // agy adds the full transcript later: still the conversation tab one shows.
  writeTranscript(root, ID_A, FIXTURE, 'transcript_full.jsonl');
  two.watcher.safeTick();
  assert.equal(two.watcher.pinned, null);
  one.watcher.stop();
  two.watcher.stop();
});

test('watcher: stop() releases the conversation for another tab', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir });
  const one = makeWatcher(root, tabDir);
  const two = makeWatcher(root, tabDir);
  const file = writeTranscript(root, ID_A, FIXTURE);
  one.watcher.safeTick();
  two.watcher.safeTick();
  assert.equal(two.watcher.pinned, null);
  one.watcher.stop();
  two.watcher.safeTick();
  assert.equal(two.watcher.pinned.full, file);
  two.watcher.stop();
});

test('watcher: a resume id another tab already shows is not read twice', () => {
  const root = makeAppData({ [ID_A]: CWD });
  writeTranscript(root, ID_A, FIXTURE);
  const one = makeWatcher(root, CWD, { conversationId: ID_A });
  const two = makeWatcher(root, CWD, { conversationId: ID_A });
  one.watcher.safeTick();
  two.watcher.safeTick();
  two.watcher.safeTick();
  assert.ok(one.watcher.pinned);
  assert.equal(two.watcher.pinned, null);
  assert.equal(two.out.logs.length, 1);
  assert.match(two.out.logs[0], /already shown by another tab/);
  one.watcher.stop();
  two.watcher.stop();
});

test('watcher: an exact folder match beats a newer conversation in a parent folder', () => {
  const tabDir = makeTabDir();
  const sub = path.join(tabDir, 'sub');
  const root = makeAppData({ [ID_A]: tabDir, [ID_B]: sub });
  const { watcher } = makeWatcher(root, sub);
  const parentFile = writeTranscript(root, ID_A, FIXTURE);
  const exactFile = writeTranscript(root, ID_B, FIXTURE);
  const now = Date.now() / 1000;
  fs.utimesSync(exactFile, now - 60, now - 60);
  fs.utimesSync(parentFile, now, now);
  watcher.safeTick();
  assert.equal(watcher.pinned.full, exactFile);
  watcher.stop();
});

test('watcher: with no exact match, a conversation whose workspace contains the tab\'s folder is used', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir });
  const { watcher, out } = makeWatcher(root, path.join(tabDir, 'packages', 'app'));
  const file = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(watcher.pinned.full, file);
  assert.deepEqual(out.logs, []);
  watcher.stop();
});

test('watcher: a conversation in another folder only is not taken, and that is logged once', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: path.join(tabDir, 'other') });
  const { watcher, out } = makeWatcher(root, tabDir);
  writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  watcher.safeTick();
  assert.equal(watcher.pinned, null);
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /none recorded for/);
  watcher.stop();
});

test('watcher: a summaries database agy holds locked is retried, not bypassed', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir });
  const { DatabaseSync } = require('node:sqlite');
  const agy = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
  agy.exec('BEGIN EXCLUSIVE');
  agy.exec(`insert into conversation_summaries values ('${ID_B}', '[]')`);
  try {
    assert.equal(readConversationWorkspaces(root).retry, true);
    const { watcher, out } = makeWatcher(root, tabDir);
    const file = writeTranscript(root, ID_A, FIXTURE);
    watcher.safeTick();
    assert.equal(watcher.pinned, null, 'no folder check, no pick');
    assert.equal(out.logs.length, 1);
    assert.match(out.logs[0], /busy \(database is locked\); trying again/);
    agy.exec('COMMIT');
    watcher.safeTick();
    assert.equal(watcher.pinned.full, file);
    watcher.stop();
  } finally {
    agy.close();
  }
});

test('watcher: a broken summaries database is not retried forever: it matches by time', () => {
  const root = makeAppData(null);
  fs.writeFileSync(path.join(root, 'conversation_summaries.db'), 'this is not sqlite');
  const { watcher, out } = makeWatcher(root, CWD);
  const file = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(watcher.pinned.full, file);
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /unreadable \(file is not a database\); matching agy conversations to this tab by time only/);
  watcher.stop();
});

test('watcher: a resumed conversation replays no history, only what comes after', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const file = writeTranscript(root, ID_A, FIXTURE, 'transcript_full.jsonl');
  const { watcher, out } = makeWatcher(root, CWD, { conversationId: ID_A.toUpperCase() });
  watcher.safeTick();
  assert.equal(watcher.pinned.full, file);
  assert.equal(out.tools.length, 0, 'history is not live activity');
  assert.equal(out.metrics.length, 1, 'but its context still counts');
  assert.ok(out.metrics[0].tokens > 0);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 9, tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:/repo/z.js' } }] })}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => e.phase), ['start']);
  watcher.stop();
});

test('watcher: history ends exactly where the file ended when it was pinned', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const lines = FIXTURE.trim().split('\n');
  // History stops after a planner step whose calls never got a result.
  const file = writeTranscript(root, ID_A, `${lines.slice(0, 2).join('\n')}\n`);
  const { watcher, out } = makeWatcher(root, CWD, { conversationId: ID_A });
  watcher.pin({ id: ID_A, full: file }, true);
  // More lines land before the first read: they are live, history is not.
  fs.appendFileSync(file, `${lines.slice(4, 8).join('\n')}\n`);
  watcher.safeTick();
  assert.deepEqual(
    out.tools.map((e) => `${e.phase}:${e.tile}`),
    ['start:Edit', 'start:Write', 'start:Shell', 'end:Edit', 'end:Write', 'end:Shell'],
  );
  watcher.stop();
});

test('watcher: a line still being written is read once it is complete', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const lines = FIXTURE.trim().split('\n');
  const half = Math.floor(lines[1].length / 2);
  const { watcher, out } = makeWatcher(root, CWD);
  const file = writeTranscript(root, ID_A, `${lines[0]}\n${lines[1].slice(0, half)}`);
  watcher.safeTick();
  assert.deepEqual(out.tools, []);
  assert.equal(out.metrics.length, 1);
  watcher.safeTick();
  assert.equal(out.metrics.length, 1, 'an unchanged file is not read again');
  fs.appendFileSync(file, `${lines[1].slice(half)}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'start:Grep']);
  assert.deepEqual(out.logs, []);
  watcher.stop();
});

test('watcher: a line longer than a read is skipped whole and logged, the next ones still count', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const { watcher, out } = makeWatcher(root, CWD, { chunkBytes: 128 });
  writeTranscript(root, ID_A, [
    JSON.stringify({ type: 'USER_INPUT', content: 'x'.repeat(400) }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: {} }] }),
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'abc' }),
    '',
  ].join('\n'));
  drain(watcher);
  assert.deepEqual(out.tools.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read']);
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /longer than 128 bytes/);
  watcher.stop();
});

test('watcher: a skipped long line ends the open batch instead of shifting its results', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const { watcher, out } = makeWatcher(root, CWD, { chunkBytes: 256 });
  const read = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });
  writeTranscript(root, ID_A, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [read('a.js'), read('b.js')] }),
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'y'.repeat(1000) }), // a's result, too long
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'bb' }), // b's result, must not end a
    '',
  ].join('\n'));
  drain(watcher);
  assert.deepEqual(out.tools.map((e) => `${e.phase}:${path.basename(e.file)}`), ['start:a.js', 'start:b.js', 'end:a.js', 'end:b.js']);
  assert.ok(out.tools.filter((e) => e.phase === 'end').every((e) => e.contextChars === 0), 'no result is pinned on the wrong call');
  watcher.stop();
});

test('watcher: a listener that throws does not make the next tick fold the same lines again', () => {
  const root = makeAppData({ [ID_A]: CWD });
  let calls = 0;
  const { watcher, out } = makeWatcher(root, CWD, {
    onTools: (events) => {
      calls++;
      if (calls === 1) throw new Error('renderer gone');
      out.tools.push(...events);
    },
  });
  // Without step_index nothing dedupes a second fold, so one would show.
  const unindexed = FIXTURE.replace(/"step_index":\d+,/g, '');
  const file = writeTranscript(root, ID_A, unindexed);
  watcher.safeTick();
  watcher.safeTick();
  const once = new AgyTranscriptState({ cwd: CWD });
  once.apply(parseSteps(unindexed).steps);
  assert.equal(watcher.state.contextChars, once.contextChars, 'counted once');
  assert.deepEqual(out.tools, [], 'nothing replayed');
  assert.match(out.logs.join('\n'), /tick failed: renderer gone/);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 9, tool_calls: [{ name: 'view_file', args: {} }] })}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => e.phase), ['start']);
  watcher.stop();
});

test('watcher: chunked reads never split a multibyte character, and CRLF lines read the same', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const contents = ['żółć'.repeat(60), '\u{1F600}\u{1F680}'.repeat(40), '中文'.repeat(70)];
  const text = contents.map((content) => JSON.stringify({ type: 'USER_INPUT', content })).join('\r\n') + '\r\n';
  const crlf = text + FIXTURE.replace(/\n/g, '\r\n');
  // Big enough for every line, small enough that most reads end inside one,
  // and odd, so a read often ends inside a 2- or 4-byte character.
  const longest = Math.max(...crlf.split('\n').map((line) => Buffer.byteLength(line)));
  const { watcher, out } = makeWatcher(root, CWD, { chunkBytes: longest + 7 });
  writeTranscript(root, ID_A, crlf);
  drain(watcher, 200);
  const whole = new AgyTranscriptState({ cwd: CWD });
  whole.apply(parseSteps(text + FIXTURE).steps);
  assert.equal(watcher.state.contextChars, whole.contextChars);
  assert.equal(out.tools.length, 10);
  assert.deepEqual(out.logs, []);
  watcher.stop();
});

test('watcher: a file that got shorter is read again as history', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const lines = FIXTURE.trim().split('\n');
  const { watcher, out } = makeWatcher(root, CWD);
  const file = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(out.tools.length, 10);
  fs.writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
  watcher.safeTick();
  assert.equal(out.tools.length, 10, 'the rewritten content is not replayed');
  assert.ok(out.metrics.at(-1).tokens < out.metrics[0].tokens);
  assert.match(out.logs.join('\n'), /got shorter/);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, tool_calls: [{ name: 'view_file', args: {} }] })}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.slice(10).map((e) => e.phase), ['start'], 'the calls history left open stay dark');
  watcher.stop();
});

test('watcher: calls still lit when the file gets shorter end there, with fresh ids after', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const lines = FIXTURE.trim().split('\n');
  const { watcher, out } = makeWatcher(root, CWD);
  const file = writeTranscript(root, ID_A, `${lines.slice(0, 2).join('\n')}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => e.phase), ['start', 'start']);
  fs.writeFileSync(file, `${lines[0]}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => e.phase), ['start', 'start', 'end', 'end']);
  assert.deepEqual(out.tools.slice(2).map((e) => e.id), out.tools.slice(0, 2).map((e) => e.id));
  fs.appendFileSync(file, `${lines[1]}\n`);
  watcher.safeTick();
  const startIds = out.tools.filter((e) => e.phase === 'start').map((e) => e.id);
  assert.equal(startIds.length, 4);
  assert.equal(new Set(startIds).size, 4, 'no id is reused');
  watcher.stop();
});

test('watcher: metrics carry the model the real agy line names', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const { watcher, out } = makeWatcher(root, CWD);
  writeTranscript(root, ID_A, CAPTURED);
  watcher.safeTick();
  assert.equal(out.metrics.length, 1);
  assert.equal(out.metrics[0].model, CAPTURED_MODEL);
  assert.equal(out.metrics[0].estimated, true);
  assert.deepEqual(out.logs, []);
  watcher.stop();
});

test('watcher: a symlinked transcript is ignored', (t) => {
  const root = makeAppData({ [ID_A]: CWD });
  const target = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(target, FIXTURE);
  const dir = path.join(root, 'brain', ID_A, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.symlinkSync(target, path.join(dir, 'transcript.jsonl'), 'file');
  } catch (err) {
    t.skip(`cannot create a symlink here (${err.code})`);
    return;
  }
  const { watcher, out } = makeWatcher(root, CWD, { conversationId: ID_A });
  watcher.safeTick();
  assert.equal(watcher.pinned, null);
  assert.deepEqual([out.metrics, out.tools], [[], []]);
  watcher.stop();
});

test('watcher: a broken transcript gives no events, a logged reason and no throw', () => {
  const root = makeAppData({ [ID_A]: CWD });
  writeTranscript(root, ID_A, '{oops\n\u0000\u0001garbage\n[]\n');
  const { watcher, out } = makeWatcher(root, CWD, { conversationId: ID_A });
  assert.doesNotThrow(() => watcher.safeTick());
  assert.deepEqual(out.tools, []);
  assert.equal(out.metrics.length, 1);
  assert.equal(out.metrics[0].tokens, 0);
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /skipped 3 unreadable line\(s\).*invalid JSON/);
  watcher.stop();
});

test('watcher: without agy\'s summaries database it says so and matches by time', () => {
  const root = makeAppData(null);
  const { watcher, out } = makeWatcher(root, CWD);
  const file = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(watcher.pinned.full, file);
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /conversation_summaries\.db not found; matching agy conversations to this tab by time only/);
  watcher.stop();
});

test('watcher: no agy folder at all is simply nothing to show', () => {
  const { watcher, out } = makeWatcher(path.join(os.tmpdir(), 'lunacore-agy-missing-dir'), CWD);
  watcher.safeTick();
  assert.deepEqual([out.metrics, out.tools, out.logs], [[], [], []]);
  watcher.stop();
});

test('readConversationWorkspaces reports an unreadable database instead of throwing', () => {
  const root = makeAppData(null);
  fs.writeFileSync(path.join(root, 'conversation_summaries.db'), 'this is not sqlite');
  const ws = readConversationWorkspaces(root);
  assert.equal(ws.ok, false);
  assert.equal(ws.retry, false, 'a broken file does not mend itself');
  assert.match(ws.reason, /conversation_summaries\.db unreadable \(file is not a database\)/);
  const missing = readConversationWorkspaces(makeAppData(null));
  assert.deepEqual([missing.ok, missing.retry], [false, false]);
  assert.match(missing.reason, /not found/);
});

// ---- the renderer labels the estimate --------------------------------------------

test('the Context widget shows an agy reading as approximate, a Claude one as before', async () => {
  const { ctxPercentText, ctxTokensKey } = require('../src/renderer/modules/context.js');
  const agy = agyContextMetrics(360000);
  assert.equal(ctxPercentText(agy), '≈10%');
  assert.equal(ctxTokensKey(agy), 'ctx.tokens.estimated');
  const claude = usageToMetrics({ input_tokens: 20000 }, 'claude-sonnet-4-5');
  assert.equal(ctxPercentText(claude), '10%');
  assert.equal(ctxTokensKey(claude), 'ctx.tokens');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  assert.equal((i18n.match(/'ctx\.tokens\.estimated':/g) || []).length, 2, 'pl + en');
  assert.equal((i18n.match(/'ctx\.estimated\.title':/g) || []).length, 2, 'pl + en');
});
