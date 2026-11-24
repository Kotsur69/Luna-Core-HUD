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
  isAgyTurnEndStep,
  agyTurnEndLine,
  AgyTranscriptState,
  agyContextMetrics,
  workspacesFromRows,
  workspaceMatch,
} = require('../src/agytranscript');
const { AgyTranscriptWatcher, readConversationWorkspaces } = require('../src/agywatcher');
const { markerFrom, openBackgroundTasks, normalizeStoredPlan } = require('../src/orchestraSupervisor');
const { lastWordsFrom } = require('../src/orchestraDiagnose');
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
  assert.deepEqual(editStatOf('Edit', { Target: 'a\nb', Replacement: 'a\nB\nc' }), { added: 2, removed: 1 });
  assert.deepEqual(editStatOf('Edit', { Target: 'a\nb', Replacement: '' }), { added: 0, removed: 2 });
  assert.deepEqual(editStatOf('Edit', { Target: '', Replacement: 'x\ny' }), { added: 2, removed: 0 });
  assert.deepEqual(editStatOf('Edit', { Target: '""', Replacement: '"x\\ny"' }), { added: 2, removed: 0 });
  assert.deepEqual(editStatOf('Edit', { ReplacementChunks: 'not json' }), { added: 0, removed: 0 });
  assert.deepEqual(editStatOf('Write', { CodeContent: 'a\nb\n' }), { added: 2, removed: 0 });
  assert.deepEqual(editStatOf('Write', { Content: 'a\nb\n' }), { added: 2, removed: 0 });
  assert.deepEqual(editStatOf('Read', { CodeContent: 'a' }), { added: 0, removed: 0 });
});

test('edit_file step yields file edit stats after read_file', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const text = [
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        { name: 'read_file', args: { Path: '"C:/repo/src/mod.js"' } },
        { name: 'edit_file', args: { Path: '"C:/repo/src/mod.js"', Target: '"const x = 1;"', Replacement: '"const x = 2;\\nconst y = 3;"' } },
      ],
    }),
    JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'const x = 1;\n' }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Edited' }),
  ].join('\n');
  const events = state.apply(parseSteps(text).steps);
  const editEnd = events.find((e) => e.phase === 'end' && e.tile === 'Edit');
  assert.ok(editEnd);
  assert.equal(editEnd.file, fixturePath('C:/repo/src/mod.js'));
  assert.deepEqual([editEnd.added, editEnd.removed], [2, 1]);
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

test('event ids never collide, even when step_index starts again from 0', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const first = state.apply(parseSteps(FIXTURE).steps);
  // The same indices again, an hour later: new steps, not updates.
  const later = FIXTURE.replace(/"created_at":"2026-11-17T08:/g, '"created_at":"2026-11-17T09:');
  const second = state.apply(parseSteps(later).steps);
  const starts = [...first, ...second].filter((e) => e.phase === 'start').map((e) => e.id);
  assert.equal(second.filter((e) => e.phase === 'start').length, first.filter((e) => e.phase === 'start').length);
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
  assert.deepEqual(workspacesFromRows('junk'), { byId: new Map(), parents: new Map(), skipped: 0 });
});

test('workspacesFromRows maps a subagent conversation to its parent', () => {
  const parent = 'f89cc211-d3a8-4ee2-aee3-8c1167b8c661';
  const child = '46b451cb-5636-4ca6-a6a8-c656f3d5fcaa';
  const ws = JSON.stringify([pathToFileURL(CWD).href]);
  const { parents } = workspacesFromRows([
    { conversation_id: parent, workspace_uris: ws, parent_conversation_id: '' },
    { conversation_id: child, workspace_uris: ws, parent_conversation_id: parent.toUpperCase() },
    { conversation_id: '1b6cd2b4-0b4a-4e4f-9d5b-6d0f1a2b3c4d', workspace_uris: ws, parent_conversation_id: 'not-a-uuid' },
  ]);
  assert.deepEqual([...parents], [[child, parent]]);
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
  // The very step it already reported, appended again: not replayed.
  fs.appendFileSync(file, `${lines[1]}\n`);
  watcher.safeTick();
  assert.equal(out.tools.length, 4, 'a step already reported is not reported twice');
  // A new step after the restart is live, with fresh ids.
  fs.appendFileSync(file, `${JSON.stringify({
    type: 'PLANNER_RESPONSE', step_index: 7, created_at: '2026-11-17T08:30:00Z',
    tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:/repo/a.js' } }, { name: 'view_file', args: { AbsolutePath: 'C:/repo/b.js' } }],
  })}\n`);
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

// ---- turn-end events for LUNA_DONE / LUNA_BLOCKED & lastWords -----------------------

test('AgyTranscriptState: turn start/end emit once per finished PLANNER_RESPONSE without tool calls', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const t1 = Date.parse('2026-11-17T08:00:00Z');
  const t2 = Date.parse('2026-11-17T08:01:00Z');
  const steps = parseSteps([
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-17T08:00:00Z', content: 'Go' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: '2026-11-17T08:00:10Z', content: '' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:00:12Z', content: 'Reading.', tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:/repo/a.js' } }] }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'code' }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: '2026-11-17T08:00:50Z', content: 'All good.' }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:01:00Z', content: 'All good.\nLUNA_DONE pkg-1' }),
    // Repeating step 3 again must not emit a duplicate turn end.
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:01:00Z', content: 'All good.\nLUNA_DONE pkg-1' }),
  ].join('\n')).steps;

  const toolEvents = state.apply(steps);
  assert.deepEqual(toolEvents.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read']);
  const turns = state.takeTurns();
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { type: 'start', at: t1 });
  assert.equal(turns[1].type, 'end');
  assert.equal(turns[1].startedAt, t1);
  assert.equal(turns[1].endedAt, t2);
  assert.deepEqual(markerFrom(turns[1].text, 'pkg-1'), { kind: 'done' });
  assert.deepEqual(state.takeTurns(), []);
  assert.equal(isAgyTurnEndStep({ type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok', toolCalls: [] }), true);
  assert.equal(isAgyTurnEndStep({ type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'err', toolCalls: [] }), false);
});

test('watcher: emits onTurnStart / onTurnEnd for live LUNA_DONE and LUNA_BLOCKED, skipping history', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const turnsStarted = [];
  const turnsEnded = [];
  // Pre-existing history includes an old LUNA_DONE that must NOT fire on resume.
  const file = writeTranscript(root, ID_A, [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-17T07:00:00Z', content: 'Old' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T07:01:00Z', content: 'LUNA_DONE old' }),
    '',
  ].join('\n'));
  const { watcher } = makeWatcher(root, CWD, {
    conversationId: ID_A,
    onTurnStart: (t) => turnsStarted.push(t),
    onTurnEnd: (t) => turnsEnded.push(t),
  });
  watcher.safeTick();
  assert.deepEqual([turnsStarted, turnsEnded], [[], []], 'resumed history fires no turns');

  fs.appendFileSync(file, [
    JSON.stringify({ step_index: 2, type: 'USER_INPUT', created_at: '2026-11-17T08:00:00Z', content: 'Task' }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:00:30Z', content: 'Working on it\nLUNA_BLOCKED a: Cannot find module \'chalk\'' }),
    '',
  ].join('\n'));
  watcher.safeTick();
  assert.equal(turnsStarted.length, 1);
  assert.equal(turnsEnded.length, 1);
  assert.deepEqual(markerFrom(turnsEnded[0].text, 'a'), { kind: 'blocked', reason: "Cannot find module 'chalk'" });
  assert.match(lastWordsFrom(turnsEnded[0].text), /Cannot find module 'chalk'/);

  // Truncated / rewritten file re-enters as history: no duplicate turn end.
  fs.writeFileSync(file, `${agyTurnEndLine('LUNA_DONE stale')}\n`);
  watcher.safeTick();
  assert.equal(turnsEnded.length, 1);
  watcher.stop();
});

test('orchestraSupervisor handles agy prose and preserves buildPlanner agy', () => {
  const quoted = JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Saw "Command running in background with ID: fake-1"' });
  assert.deepEqual(openBackgroundTasks(quoted, []), []);
  const stored = normalizeStoredPlan({
    id: 'p-agy',
    repoPath: path.resolve('repo'),
    buildPlanner: 'agy',
    workers: 'agy',
    agyProfileId: 'agy-1',
    packages: [{ id: 'a', todoAts: [1], prompt: 'do a' }],
  });
  assert.equal(stored.buildPlanner, 'agy');
});

test('AgyTranscriptState: statusless PLANNER_RESPONSE does not fire early and allows later DONE update to fire', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const streaming = parseSteps([
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-17T08:00:00Z', content: 'Go' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: '', created_at: '2026-11-17T08:00:05Z', content: 'Partial without marker' }),
  ].join('\n')).steps;
  state.apply(streaming);
  const firstTurns = state.takeTurns();
  assert.deepEqual(firstTurns.map((t) => t.type), ['start']);

  const done = parseSteps(
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T08:00:10Z', content: 'Partial without marker\nLUNA_DONE pkg-1' }),
  ).steps;
  state.apply(done);
  const nextTurns = state.takeTurns();
  assert.equal(nextTurns.length, 1);
  assert.equal(nextTurns[0].type, 'end');
  assert.deepEqual(markerFrom(nextTurns[0].text, 'pkg-1'), { kind: 'done' });
});

test('watcher: conversation claimed when snapshotBaseline ran stays ignored after old watcher stops', () => {
  const tabDir = makeTabDir();
  const root = makeAppData({ [ID_A]: tabDir, [ID_B]: tabDir });
  const w1 = makeWatcher(root, tabDir);
  const fileA = writeTranscript(root, ID_A, FIXTURE);
  w1.watcher.safeTick();
  assert.equal(w1.watcher.pinned.full, fileA);

  // Reopened watcher snapshots baseline while w1 still claims ID_A.
  const w2 = makeWatcher(root, tabDir);
  // Old watcher stops, then dying process flushes another line to ID_A.
  w1.watcher.stop();
  fs.appendFileSync(fileA, `${agyTurnEndLine('LUNA_DONE stale-from-dying-tab')}\n`);
  w2.watcher.safeTick();
  assert.equal(w2.watcher.pinned, null, 'reopened tab must not adopt a conversation claimed at start');

  const fileB = writeTranscript(root, ID_B, FIXTURE);
  w2.watcher.safeTick();
  assert.equal(w2.watcher.pinned.full, fileB, 'new conversation for reopened tab is adopted');
  w2.watcher.stop();
});

// ---- captured agy 1.5.12 runs (2026-11-22) -----------------------------------------
// Three real transcripts, with local paths replaced by C:\repo, the user name
// by "dev" and the model's thinking text dropped; nothing else changed:
// * captured-edit:         gemini-4-neon-low, the COMPACT transcript.jsonl
//                          (every argument JSON-quoted): read_file, edit_file
//                          {Path, Target, Replacement}, write_file and a
//                          run_command headless mode refused (ERROR result);
// * captured-orchestrator: "Orchestrator (Neon)" in plan mode, the _full
//                          transcript: reads, exit_plan_mode, "Plan mode is
//                          off.", a SYSTEM_MESSAGE, then the executor model's
//                          edit_file / write_file / invoke_subagent;
// * captured-subagent:     the subagent that invoke_subagent started.

const CAPTURED_EDIT = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.captured-edit.jsonl'), 'utf8');
const CAPTURED_ORCH = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.captured-orchestrator.jsonl'), 'utf8');
const CAPTURED_SUB = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.captured-subagent.jsonl'), 'utf8');
const ORCH_ID = 'f89cc211-d3a8-4ee2-aee3-8c1167b8c661';
const SUB_ID = '46b451cb-5636-4ca6-a6a8-c656f3d5fcaa';
const { MAX_CHILD_CONVERSATIONS } = require('../src/agywatcher');
const { stationForMcp } = require('../src/renderer/modules/workmapmodel.js');
const { MAX_DETAIL_CHARS } = require('../src/tooldetail');

const startsOf = (events) => events.filter((e) => e.phase === 'start');
const endOf = (events, tile) => events.find((e) => e.phase === 'end' && e.tile === tile);
const line = (obj) => JSON.stringify(obj);

test('captured: edit_file reports its Target/Replacement as real +added/-removed, from quoted arguments', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const { tools } = state.fold(parseSteps(CAPTURED_EDIT).steps);
  assert.deepEqual(
    tools.map((e) => `${e.phase}:${e.tile}`),
    ['start:Read', 'end:Read', 'start:Edit', 'start:Write', 'start:Shell', 'end:Edit', 'end:Write', 'end:Shell'],
  );
  const notes = normalizeAgyPath('C:\\repo\\notes.txt', CWD);
  const readEnd = endOf(tools, 'Read');
  assert.equal(readEnd.file, notes);
  assert.ok(readEnd.contextChars > 0, 'the read put text into the window');
  const editEnd = endOf(tools, 'Edit');
  assert.deepEqual([editEnd.file, editEnd.added, editEnd.removed], [notes, 2, 2]);
  const writeEnd = endOf(tools, 'Write');
  assert.deepEqual([writeEnd.file, writeEnd.added, writeEnd.removed], [normalizeAgyPath('C:\\repo\\out.txt', CWD), 2, 0]);
  assert.equal(startsOf(tools).find((e) => e.tile === 'Shell').detail, 'node -e');
  assert.equal(state.model, 'Gemini 4 Neon (Low)', 'the planner step names the model');
  assert.deepEqual(state.usage, { input: 2513, cacheRead: 6838, output: 555 });
});

test('editStatOf reads edit_file Target/Replacement, its Edits list and a delete', () => {
  assert.deepEqual(editStatOf('Edit', { Path: 'C:/r/a.js', Target: 'a\nb', Replacement: 'a\nB\nc' }), { added: 2, removed: 1 });
  assert.deepEqual(editStatOf('Edit', { Target: '"one"', Replacement: '"two"' }), { added: 1, removed: 1 });
  assert.deepEqual(editStatOf('Edit', { Target: 'one\ntwo' }), { added: 0, removed: 2 }, 'no Replacement deletes the target');
  const edits = [{ Target: 'x', Replacement: 'y' }, { Target: 'p\nq', Replacement: '' }];
  assert.deepEqual(editStatOf('Edit', { Path: 'C:/r/a.js', Edits: edits }), { added: 1, removed: 3 });
  assert.deepEqual(editStatOf('Edit', { Edits: JSON.stringify(edits) }), { added: 1, removed: 3 }, 'Edits as a JSON string');
  assert.deepEqual(editStatOf('Write', { Path: 'C:/r/b.txt', Content: '"alpha\\nbeta\\n"' }), { added: 2, removed: 0 });
});

test('an edit result that states its own diff beats counting from the arguments', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const tools = state.apply(parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'edit_file', args: { Path: 'C:/repo/a.js', Target: 'x', Replacement: 'y', AllowMultiple: true } }] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'Made 3 replacements in C:/repo/a.js starting at line 2 (+3/-3 lines).' }),
  ].join('\n')).steps);
  const end = endOf(tools, 'Edit');
  assert.deepEqual([end.added, end.removed], [3, 3]);
});

test('captured Orchestrator plan -> execute: the executor\'s steps after exit_plan_mode all count', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const out = state.fold(parseSteps(CAPTURED_ORCH).steps);
  const starts = startsOf(out.tools);
  assert.deepEqual(starts.map((e) => e.tile), ['Read', 'Read', 'Task', 'Edit', 'Write', 'Read', 'Read', 'Task']);
  assert.equal(out.tools.filter((e) => e.phase === 'end').length, starts.length, 'balanced pairs');
  assert.equal(starts[2].detail, 'exit_plan_mode');
  assert.equal(starts[7].detail, 'research: List Line Counter');
  const editEnd = endOf(out.tools, 'Edit');
  assert.deepEqual([editEnd.file, editEnd.added, editEnd.removed], [normalizeAgyPath('C:\\repo\\notes.txt', CWD), 1, 1]);
  assert.deepEqual(out.children, [SUB_ID], 'the subagent invoke_subagent started');
  assert.equal(state.unresolved, 0);
  // The planner ran on Neon, the executor on Hydrogen: the newest step wins.
  assert.equal(state.model, 'Gemini 4 Hydrogen (XHigh)');
  assert.deepEqual(state.usage, { input: 6432, cacheRead: 10036, output: 416 });
  const m = agyContextMetrics(state.contextChars, { model: state.model, usage: state.usage });
  assert.deepEqual([m.tokens, m.tokensExact, m.estimated, m.modelLabel], [6432 + 10036, true, true, 'Gemini 4 Hydrogen (XHigh)']);
  // Without real counts the estimate stays, and says so.
  assert.equal(agyContextMetrics(4000).tokensExact, false);
});

test('captured subagent: its read and its message to the parent are tool events', () => {
  const state = new AgyTranscriptState({ cwd: CWD, idPrefix: `agy:${SUB_ID}:` });
  const tools = state.apply(parseSteps(CAPTURED_SUB).steps);
  assert.deepEqual(tools.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read', 'start:Task', 'end:Task']);
  assert.equal(startsOf(tools)[1].detail, 'send_message');
  assert.ok(tools.every((e) => e.id.startsWith(`agy:${SUB_ID}:`)), 'a child\'s ids never collide with its parent\'s');
});

test('a step_index that starts again after the hand-off is new steps, not repeats', () => {
  const lines = CAPTURED_ORCH.trim().split('\n');
  const handoff = lines.findIndex((l) => JSON.parse(l).type === 'SYSTEM_MESSAGE');
  // The executor's steps renumbered from 0, as a reset index would log them.
  const reset = lines.map((l, i) => {
    if (i <= handoff) return l;
    const obj = JSON.parse(l);
    return line({ ...obj, step_index: obj.step_index - (handoff + 1) });
  });
  const plain = new AgyTranscriptState({ cwd: CWD }).apply(parseSteps(CAPTURED_ORCH).steps);
  const renumbered = new AgyTranscriptState({ cwd: CWD }).apply(parseSteps(reset.join('\n')).steps);
  assert.deepEqual(renumbered.map((e) => `${e.phase}:${e.tile}:${e.added}`), plain.map((e) => `${e.phase}:${e.tile}:${e.added}`));
  assert.equal(startsOf(renumbered).filter((e) => e.tile === 'Edit').length, 1, 'the executor\'s edit is there');
});

test('a planner step logged again with more tool calls opens the new ones, in result order', () => {
  const read = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });
  const at = '2026-11-22T20:00:00Z';
  const state = new AgyTranscriptState({ cwd: CWD });
  const tools = state.apply(parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [read('a.js')] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'aa' }),
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [read('a.js'), read('b.js')] }),
    line({ type: 'GENERIC', step_index: 3, status: 'DONE', content: 'bbb' }),
  ].join('\n')).steps);
  assert.deepEqual(tools.map((e) => `${e.phase}:${path.basename(e.file)}:${e.contextChars ?? ''}`), [
    'start:a.js:', 'end:a.js:2', 'start:b.js:', 'end:b.js:3',
  ]);
  assert.equal(state.unresolved, 0);
});

test('calls added to a planner step whose batch is already over still light, and end at once', () => {
  const read = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });
  const at = '2026-11-22T20:00:00Z';
  const state = new AgyTranscriptState({ cwd: CWD });
  const tools = state.apply(parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [read('a.js')] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'aa' }),
    line({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: '2026-11-22T20:00:05Z', tool_calls: [read('c.js')] }),
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [read('a.js'), read('b.js')] }),
    line({ type: 'GENERIC', step_index: 4, status: 'DONE', content: 'cccc' }),
  ].join('\n')).steps);
  assert.deepEqual(tools.map((e) => `${e.phase}:${path.basename(e.file)}:${e.contextChars ?? ''}`), [
    'start:a.js:', 'end:a.js:2', 'start:c.js:', 'start:b.js:', 'end:b.js:0', 'end:c.js:4',
  ]);
  assert.equal(state.unresolved, 1);
});

test('call_mcp_tool, read_resource and list_resources become balanced MCP events that keep the result order', () => {
  const server = 'lunacore-s12';
  const state = new AgyTranscriptState({ cwd: CWD });
  const out = state.fold(parseSteps([
    line({
      type: 'PLANNER_RESPONSE', step_index: 1, created_at: '2026-11-22T20:00:00Z', tool_calls: [
        { name: 'call_mcp_tool', args: { ServerName: `"${server}"`, ToolName: '"memory_search"', Arguments: '{"query":"agy"}' } },
        { name: 'view_file', args: { AbsolutePath: 'C:/repo/a.js' } },
        { name: 'read_resource', args: { ServerName: 'docs', Uri: 'https://docs.example/x?token=abc123' } },
        { name: 'list_resources', args: { ServerName: 'docs' } },
        { name: 'call_mcp_tool', args: { ToolName: 'no_server' } },
      ],
    }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', created_at: '2026-11-22T20:00:02Z', content: 'Created At: x\nCompleted At: y\n[{"id":"m1"}]' }),
    line({ type: 'GENERIC', step_index: 3, status: 'DONE', content: 'abc' }),
    line({ type: 'GENERIC', step_index: 4, status: 'ERROR', error: 'resource not found', content: 'Encountered error' }),
    line({ type: 'GENERIC', step_index: 5, status: 'DONE', content: 'r1' }),
    line({ type: 'GENERIC', step_index: 6, status: 'DONE', content: 'x' }),
  ].join('\n')).steps);
  const starts = startsOf(out.mcp);
  assert.deepEqual(starts.map((e) => [e.server, e.tool]), [[server, 'memory_search'], ['docs', 'read_resource'], ['docs', 'list_resources']]);
  assert.deepEqual(starts[0].input, { query: 'agy' });
  assert.doesNotMatch(JSON.stringify(starts[1].input), /abc123/, 'a URI query is scrubbed');
  const ends = out.mcp.filter((e) => e.phase === 'end');
  assert.deepEqual(ends.map((e) => [e.id, e.ok]), starts.map((e, i) => [e.id, i !== 1]));
  assert.equal(ends[0].content, '[{"id":"m1"}]', 'agy\'s Created/Completed header is not the result');
  assert.equal(ends[0].ms, 2000);
  assert.equal(ends[1].content, 'resource not found');
  // The MCP slots keep the read's result where it belongs.
  assert.deepEqual(out.tools.map((e) => `${e.phase}:${e.tile}:${e.contextChars ?? ''}`), ['start:Read:', 'end:Read:3']);
  // An agy tab's memory server lands on the Memory station.
  assert.equal(stationForMcp(starts[0].server, starts[0].tool), 'memory');
});

test('a tool call\'s detail is short and never carries a token or an env value', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const state = new AgyTranscriptState({ cwd: CWD });
  const tools = state.apply(parseSteps(line({
    type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [
      { name: 'run_command', args: { CommandLine: `GITHUB_TOKEN=${token} gh pr create --title "x"` } },
      { name: 'run_command', args: { CommandLine: '"curl -H \\"Authorization: Bearer sk-abcdefghijklmnopqrstuv\\" https://api.x"' } },
      { name: 'grep_search', args: { Query: `api_key=sk-abcdefghijklmnopqrstuv ${'x'.repeat(200)}` } },
      { name: 'run_command', args: { CommandLine: '$env:API_KEY="hunter2"; npm test' } },
    ],
  })).steps);
  const details = startsOf(tools).map((e) => e.detail);
  // Up to three plain arguments; the first quoted one ends the summary.
  assert.deepEqual([details[0], details[1], details[3]], ['gh pr create --title', 'curl -H', 'npm test']);
  for (const d of details) {
    assert.ok(d.length <= MAX_DETAIL_CHARS, d);
    assert.doesNotMatch(d, /ghp_|sk-abc|hunter2/);
  }
});

/** Writes agy's summaries database with parent links: [{id, folder, parent?}]. */
function writeSummaryRows(root, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
  db.exec("create table conversation_summaries (conversation_id text primary key, workspace_uris text not null, parent_conversation_id text not null default '')");
  const insert = db.prepare('insert into conversation_summaries values (?, ?, ?)');
  for (const { id, folder, parent = '' } of rows) insert.run(id, JSON.stringify([pathToFileURL(folder).href]), parent);
  db.close();
}

/** A watcher that also records MCP events. */
function makeFullWatcher(root, cwd, extra = {}) {
  const made = makeWatcher(root, cwd, extra);
  made.out.mcp = [];
  made.watcher.onMcp = (events) => made.out.mcp.push(...events);
  return made;
}

test('watcher: follows the subagent a result names, and its events count for the tab', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: ORCH_ID, folder: tabDir }, { id: SUB_ID, folder: tabDir, parent: ORCH_ID }]);
  const { watcher, out } = makeFullWatcher(root, tabDir);
  writeTranscript(root, SUB_ID, CAPTURED_SUB, 'transcript_full.jsonl');
  writeTranscript(root, ORCH_ID, CAPTURED_ORCH, 'transcript_full.jsonl');
  drain(watcher, 5);
  assert.equal(watcher.pinned.id, ORCH_ID, 'the subagent, newer and in the same folder, is not the tab\'s own');
  const childEvents = out.tools.filter((e) => e.id.startsWith(`agy:${SUB_ID}:`));
  assert.deepEqual(childEvents.map((e) => `${e.phase}:${e.tile}`), ['start:Read', 'end:Read', 'start:Task', 'end:Task']);
  assert.equal(childEvents[0].file, normalizeAgyPath('C:\\repo\\list.txt', tabDir));
  assert.equal(new Set(out.tools.map((e) => `${e.phase}:${e.id}`)).size, out.tools.length, 'no id twice');
  assert.equal(startsOf(out.tools).length, 8 + 2);
  assert.match(out.logs.join('\n'), new RegExp(`following agy subagent conversation ${SUB_ID}`));
  // Claimed while followed: another tab cannot show it too.
  const other = makeWatcher(root, tabDir, { conversationId: SUB_ID });
  other.watcher.safeTick();
  assert.equal(other.watcher.pinned, null);
  watcher.stop();
  other.watcher.safeTick();
  assert.equal(other.watcher.pinned.id, SUB_ID, 'stop() released it');
  other.watcher.stop();
});

// Subagent ids are remembered process-wide (no tab picks one as its own), so
// the tests below that make subagents use ids no other test needs as a tab's.
const PARENT_C = 'cccccccc-3333-4333-8333-cccccccccccc';
const CHILD_D = 'dddddddd-4444-4444-8444-dddddddddddd';
const CHILD_E = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const CHILD_F = 'ffffffff-6666-4666-8666-ffffffffffff';

test('watcher: a subagent found through the summaries database while an agent call runs', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: PARENT_C, folder: tabDir }, { id: CHILD_D, folder: tabDir, parent: PARENT_C }]);
  const { watcher, out } = makeFullWatcher(root, tabDir);
  // The workflow call is still running: no result names its agents yet.
  writeTranscript(root, PARENT_C, `${line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'run_workflow', args: { Name: 'review' } }] })}\n`);
  writeTranscript(root, CHILD_D, `${line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'read_file', args: { Path: 'C:/repo/x.js' } }] })}\n`);
  drain(watcher, 3);
  assert.equal(startsOf(out.tools)[0].detail, 'review');
  assert.deepEqual(out.tools.filter((e) => e.id.startsWith(`agy:${CHILD_D}:`)).map((e) => e.tile), ['Read']);
  watcher.stop();
});

test('watcher: follows at most MAX_CHILD_CONVERSATIONS subagents', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: ID_A, folder: tabDir }]);
  const { watcher, out } = makeFullWatcher(root, tabDir);
  const ids = Array.from({ length: MAX_CHILD_CONVERSATIONS + 8 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const id of ids) writeTranscript(root, id, `${line({ type: 'USER_INPUT', content: 'hi' })}\n`);
  const result = (list) => list.map((id) => `"conversationId": "${id}"`).join('\n');
  writeTranscript(root, ID_A, [
    line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'invoke_subagent', args: {} }, { name: 'invoke_subagent', args: {} }] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: result(ids.slice(0, 20)) }),
    line({ type: 'GENERIC', step_index: 3, status: 'DONE', content: result(ids.slice(20)) }),
    '',
  ].join('\n'));
  drain(watcher, 5);
  assert.equal(watcher.children.size, MAX_CHILD_CONVERSATIONS);
  assert.match(out.logs.join('\n'), /following at most \d+ agy subagent conversations/);
  watcher.stop();
});

test('watcher: a subagent transcript that is a symlink is not followed', (t) => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: ORCH_ID, folder: tabDir }]);
  const target = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(target, CAPTURED_SUB);
  const dir = path.join(root, 'brain', SUB_ID, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.symlinkSync(target, path.join(dir, 'transcript_full.jsonl'));
  } catch (err) {
    t.skip(`cannot create a symlink here (${err.code})`);
    return;
  }
  const { watcher, out } = makeFullWatcher(root, tabDir);
  writeTranscript(root, ORCH_ID, CAPTURED_ORCH, 'transcript_full.jsonl');
  drain(watcher, 5);
  assert.equal(watcher.children.size, 0);
  assert.equal(out.tools.filter((e) => e.id.startsWith(`agy:${SUB_ID}:`)).length, 0);
  watcher.stop();
});

test('watcher: a transcript agy rewrote is read again, and the steps it now holds are not swallowed', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const { watcher, out } = makeWatcher(root, CWD);
  const read = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });
  const first = [
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: '2026-11-22T20:00:00Z', tool_calls: [read('a.js')] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', created_at: '2026-11-22T20:00:01Z', content: 'aa' }),
  ];
  const file = writeTranscript(root, ID_A, `${first.join('\n')}\n`);
  watcher.safeTick();
  assert.equal(out.tools.length, 2);
  // Rewritten in place (a byte before the read position changed), with the
  // executor's next step already in it.
  fs.writeFileSync(file, `${[
    first[0],
    first[1].replace('"aa"', '"zz"'),
    line({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: '2026-11-22T20:00:09Z', tool_calls: [read('b.js')] }),
    line({ type: 'GENERIC', step_index: 4, status: 'DONE', created_at: '2026-11-22T20:00:10Z', content: 'bbb' }),
  ].join('\n')}\n`);
  watcher.safeTick();
  assert.match(out.logs.join('\n'), /was rewritten; reading it again/);
  assert.deepEqual(out.tools.slice(2).map((e) => `${e.phase}:${path.basename(e.file)}`), ['start:b.js', 'end:b.js'], 'only the new step, and it is not lost');
  watcher.stop();
});

test('watcher: MCP events reach onMcp, and metrics carry the planner\'s real token counts', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const { watcher, out } = makeFullWatcher(root, CWD);
  writeTranscript(root, ID_A, [
    line({
      type: 'PLANNER_RESPONSE', step_index: 1, model: 'gemini-4-neon-high', input_tokens: 1200, cache_read_tokens: 800, output_tokens: 50,
      tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'lunacore-s1', ToolName: 'memory_get', Arguments: { key: 'x' } } }],
    }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: '{"ok":true}' }),
    '',
  ].join('\n'));
  watcher.safeTick();
  assert.deepEqual(out.mcp.map((e) => `${e.phase}:${e.server}:${e.tool}`), ['start:lunacore-s1:memory_get', 'end:lunacore-s1:memory_get']);
  assert.deepEqual(out.tools, [], 'an MCP call lights no Skill Tracker tile, as on the Claude path');
  const m = out.metrics.at(-1);
  assert.deepEqual([m.tokens, m.tokensExact, m.estimated, m.model], [2000, true, true, 'Gemini 4 Neon (High)']);
  watcher.stop();
});

// ---- review follow-ups (2026-11-22) --------------------------------------------------

const readCall = (file) => ({ name: 'view_file', args: { AbsolutePath: `C:/repo/${file}` } });

test('a planner step logging only output_tokens says nothing about the window', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  state.apply(parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 900, cache_read_tokens: 100, output_tokens: 5 }),
    line({ type: 'PLANNER_RESPONSE', step_index: 2, output_tokens: 40 }),
  ].join('\n')).steps);
  assert.deepEqual(state.usage, { input: 900, cacheRead: 100, output: 5 }, 'the last real prompt size stays');
  const only = new AgyTranscriptState({ cwd: CWD });
  only.apply(parseSteps(line({ type: 'PLANNER_RESPONSE', step_index: 1, output_tokens: 40 })).steps);
  assert.equal(only.usage, null);
  assert.equal(agyContextMetrics(4000, { usage: only.usage }).tokensExact, false, 'no exact 0 %');
});

test('an old planner step with no calls, logged again with some, does not take over the newer batch', () => {
  const at = '2026-11-22T20:00:00Z';
  const state = new AgyTranscriptState({ cwd: CWD });
  const tools = state.apply(parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, content: 'thinking' }),
    line({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: '2026-11-22T20:00:05Z', tool_calls: [readCall('c.js')] }),
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, content: 'thinking', tool_calls: [readCall('b.js')] }),
    line({ type: 'GENERIC', step_index: 3, status: 'DONE', content: 'cccc' }),
  ].join('\n')).steps);
  assert.deepEqual(tools.map((e) => `${e.phase}:${path.basename(e.file)}:${e.contextChars ?? ''}`), [
    'start:c.js:', 'start:b.js:', 'end:b.js:0', 'end:c.js:4',
  ]);
});

test('a second restart during a re-read does not replay what the first state reported', () => {
  const steps = parseSteps([
    line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: '2026-11-22T20:00:00Z', tool_calls: [readCall('a.js')] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', created_at: '2026-11-22T20:00:01Z', content: 'aa' }),
    line({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: '2026-11-22T20:00:02Z', tool_calls: [readCall('b.js')] }),
    line({ type: 'GENERIC', step_index: 4, status: 'DONE', created_at: '2026-11-22T20:00:03Z', content: 'bb' }),
  ].join('\n')).steps;
  const first = new AgyTranscriptState({ cwd: CWD });
  assert.equal(first.apply(steps).length, 4);
  const second = first.restarted();
  assert.deepEqual(second.apply(steps.slice(0, 1)), [], 'rewritten again after one line');
  const third = second.restarted();
  assert.deepEqual(third.apply(steps), [], 'nothing the first state reported comes back');
  third.endReplay();
  const fresh = third.apply(parseSteps(line({ type: 'PLANNER_RESPONSE', step_index: 5, created_at: '2026-11-22T20:00:09Z', tool_calls: [readCall('c.js')] })).steps);
  assert.deepEqual(fresh.map((e) => e.phase), ['start']);
  assert.ok(Number(fresh[0].id.split(':')[1]) > 2, 'ids keep counting across restarts');
});

test('after a restart a planner step reports only the calls it gained since', () => {
  const at = '2026-11-22T20:00:00Z';
  const before = new AgyTranscriptState({ cwd: CWD });
  assert.deepEqual(before.apply(parseSteps(line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at })).steps), []);
  const after = before.restarted();
  const tools = after.apply(parseSteps(line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [readCall('a.js')] })).steps);
  assert.deepEqual(tools.map((e) => `${e.phase}:${path.basename(e.file)}`), ['start:a.js'], 'never reported before: live now');
  const again = after.restarted();
  assert.deepEqual(again.apply(parseSteps(line({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [readCall('a.js')] })).steps), []);
});

test('editStatOf counts at most 64 chunks, and diffs exactly only what fits its line budget', () => {
  const many = Array.from({ length: 200 }, () => ({ Target: 'x', Replacement: 'y' }));
  assert.deepEqual(editStatOf('Edit', { Edits: many }), { added: 64, removed: 64 });
  const old = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
  const changed = old.replace('line 300', 'LINE 300');
  // 1200 lines do not fit: counted whole rather than with a 600x600 table.
  assert.deepEqual(editStatOf('Edit', { Target: old, Replacement: changed }), { added: 600, removed: 600 });
  const small = old.split('\n').slice(0, 100).join('\n');
  assert.deepEqual(editStatOf('Edit', { Target: small, Replacement: small.replace('line 50', 'LINE 50') }), { added: 1, removed: 1 });
});

test('watcher: a subagent that goes idle is let go, and taken up again where it was when it grows', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: PARENT_C, folder: tabDir }]);
  let clock = Date.parse('2026-11-22T20:00:00Z');
  const { watcher, out } = makeFullWatcher(root, tabDir, { now: () => clock });
  const named = (step) => [
    line({ type: 'PLANNER_RESPONSE', step_index: step, tool_calls: [{ name: 'invoke_subagent', args: { Role: 'helper' } }] }),
    line({ type: 'GENERIC', step_index: step + 1, status: 'DONE', content: `{"conversationId": "${CHILD_E}"}` }),
  ].join('\n');
  writeTranscript(root, CHILD_E, `${line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [readCall('one.js')] })}\n`);
  const parent = writeTranscript(root, PARENT_C, `${named(1)}\n`);
  drain(watcher, 3);
  assert.ok(watcher.children.has(CHILD_E));
  const childStarts = () => startsOf(out.tools).filter((e) => e.id.startsWith(`agy:${CHILD_E}:`)).map((e) => path.basename(e.file));
  assert.deepEqual(childStarts(), ['one.js']);
  clock += 11 * 60 * 1000;
  watcher.safeTick();
  assert.equal(watcher.children.has(CHILD_E), false, 'idle for 11 minutes: let go');
  assert.ok(out.tools.some((e) => e.phase === 'end' && e.id.startsWith(`agy:${CHILD_E}:`)), 'what it lit went dark');
  // It wakes up and is named again: only what is new is reported.
  fs.appendFileSync(path.join(root, 'brain', CHILD_E, '.system_generated', 'logs', 'transcript.jsonl'), `${line({ type: 'PLANNER_RESPONSE', step_index: 2, tool_calls: [readCall('two.js')] })}\n`);
  fs.appendFileSync(parent, `${named(3)}\n`);
  drain(watcher, 3);
  assert.deepEqual(childStarts(), ['one.js', 'two.js']);
  watcher.stop();
});

test('watcher: a subagent that cannot be read does not stop the tab or the other subagents', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: PARENT_C, folder: tabDir }]);
  const { watcher, out } = makeFullWatcher(root, tabDir);
  for (const id of [CHILD_E, CHILD_F]) writeTranscript(root, id, `${line({ type: 'USER_INPUT', content: 'go' })}\n`);
  const parent = writeTranscript(root, PARENT_C, [
    line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'invoke_subagent', args: {} }] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: `"conversationId": "${CHILD_E}" "conversationId": "${CHILD_F}"` }),
    '',
  ].join('\n'));
  drain(watcher, 3);
  assert.equal(watcher.children.size, 2);
  watcher.children.get(CHILD_E).tail.poll = () => {
    throw new Error('EIO');
  };
  fs.appendFileSync(path.join(root, 'brain', CHILD_F, '.system_generated', 'logs', 'transcript.jsonl'), `${line({ type: 'PLANNER_RESPONSE', step_index: 2, tool_calls: [readCall('f.js')] })}\n`);
  fs.appendFileSync(parent, `${line({ type: 'PLANNER_RESPONSE', step_index: 3, tool_calls: [readCall('p.js')] })}\n`);
  const metricsBefore = out.metrics.length;
  watcher.safeTick();
  assert.deepEqual(startsOf(out.tools).slice(-2).map((e) => path.basename(e.file)).sort(), ['f.js', 'p.js']);
  assert.equal(out.metrics.length, metricsBefore + 1, 'the tab still gets its reading');
  assert.match(out.logs.join('\n'), /cannot read .*: EIO/);
  watcher.stop();
});

test('watcher: a named subagent is never another tab\'s own conversation, even without the database', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null); // no summaries database: matched by time only
  const a = makeFullWatcher(root, tabDir);
  const b = makeFullWatcher(root, tabDir);
  writeTranscript(root, PARENT_C, [
    line({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'invoke_subagent', args: {} }] }),
    line({ type: 'GENERIC', step_index: 2, status: 'DONE', content: `{"conversationId": "${CHILD_F}"}` }),
    '',
  ].join('\n'));
  a.watcher.safeTick(); // pins the parent and learns of the subagent, whose transcript is not there yet
  writeTranscript(root, CHILD_F, `${line({ type: 'USER_INPUT', content: 'go' })}\n`);
  b.watcher.safeTick();
  assert.equal(b.watcher.pinned, null, 'the subagent is new and unclaimed, but not a tab\'s own');
  a.watcher.safeTick();
  assert.ok(a.watcher.children.has(CHILD_F));
  a.watcher.stop();
  b.watcher.stop();
});

// ---- agyTranscriptConversation: which paths are an agy transcript ---------------

const { agyTranscriptConversation, AGY_TRANSCRIPT_FILES } = require('../src/agytranscript');
const { TRANSCRIPT_FILES: WATCHER_TRANSCRIPT_FILES } = require('../src/agywatcher');

const AGY_ROOT = path.resolve(os.tmpdir(), 'agy-root');
const CONV = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const logsOf = (id = CONV) => path.join(AGY_ROOT, 'brain', id, '.system_generated', 'logs');

test('agyTranscriptConversation accepts both transcript files of a conversation', () => {
  assert.deepEqual([...AGY_TRANSCRIPT_FILES], ['transcript_full.jsonl', 'transcript.jsonl']);
  assert.equal(WATCHER_TRANSCRIPT_FILES, AGY_TRANSCRIPT_FILES);
  for (const name of AGY_TRANSCRIPT_FILES) {
    assert.equal(agyTranscriptConversation(path.join(logsOf(), name), AGY_ROOT), CONV);
  }
  // The id comes back lowercase, as the watcher keys conversations.
  assert.equal(agyTranscriptConversation(path.join(logsOf(CONV.toUpperCase()), 'transcript.jsonl'), AGY_ROOT), CONV);
});

test('agyTranscriptConversation refuses anything that is not exactly a transcript path', () => {
  const refused = [
    path.join(logsOf(), 'transcript.json'),
    path.join(logsOf(), 'transcript.jsonl.bak'),
    path.join(logsOf(), 'other.jsonl'),
    path.join(logsOf(), 'sub', 'transcript.jsonl'),
    path.join(AGY_ROOT, 'brain', CONV, 'logs', 'transcript.jsonl'),
    path.join(AGY_ROOT, 'brains', CONV, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(logsOf('not-a-uuid'), 'transcript.jsonl'),
    // `..` is refused even when it would resolve to a valid transcript.
    `${logsOf()}${path.sep}..${path.sep}logs${path.sep}transcript.jsonl`,
    `${AGY_ROOT}${path.sep}..${path.sep}agy-root${path.sep}brain${path.sep}${CONV}${path.sep}.system_generated${path.sep}logs${path.sep}transcript.jsonl`,
    path.join(path.resolve(os.tmpdir(), 'elsewhere'), 'brain', CONV, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join('brain', CONV, '.system_generated', 'logs', 'transcript.jsonl'),
    `${path.join(logsOf(), 'transcript.jsonl')}\0`,
  ];
  for (const file of refused) assert.equal(agyTranscriptConversation(file, AGY_ROOT), null, file);
  assert.equal(agyTranscriptConversation(path.join(logsOf(), 'transcript.jsonl'), ''), null);
  assert.equal(agyTranscriptConversation(path.join(logsOf(), 'transcript.jsonl'), 'relative/root'), null);
  assert.equal(agyTranscriptConversation(null, AGY_ROOT), null);
  assert.equal(agyTranscriptConversation(42, AGY_ROOT), null);
});

// ---- real token counts per model, booked for God Mode (src/agytokens.js) ------------------

const { usageFromTranscript } = require('../src/orchestraUsage');
const { estimateSessionCost } = require('../src/observer');
const { AgyUsageBook, sumAgyByModel } = require('../src/agytokens');

// Summed by hand from the captured fixtures' PLANNER_RESPONSE steps.
const ORCH_USAGE = {
  'gemini-4-neon-xhigh': { input: 13681, output: 4878, cacheRead: 8533, cacheWrite: 0 },
  'gemini-4-hydrogen-xhigh': { input: 25802, output: 1822, cacheRead: 35465, cacheWrite: 0 },
};
const SUB_USAGE = { 'gemini-4-hydrogen-xhigh': { input: 8308, output: 728, cacheRead: 3011, cacheWrite: 0 } };

const plannerLine = (index, at, usage, model = 'gemini-4-argon-medium') => line({
  step_index: index, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, model,
  input_tokens: usage[0], cache_read_tokens: usage[1], output_tokens: usage[2], content: 'ok',
});

test('usage: a captured transcript reports input/output/cacheRead totals per model', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  state.fold(parseSteps(CAPTURED_ORCH).steps);
  assert.deepEqual(state.usageByModel(), ORCH_USAGE);
});

test('usage: a step logged again is counted once, with its newest counts', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const at = '2026-11-22T20:00:00Z';
  // Streaming first (no counts yet), then DONE twice, the second time with final counts.
  const streaming = line({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: at, model: 'gemini-4-argon-medium', content: '' });
  state.fold(parseSteps([streaming, plannerLine(1, at, [100, 10, 5]), plannerLine(1, at, [100, 10, 5])].join('\n')).steps);
  assert.deepEqual(state.usageByModel(), { 'gemini-4-argon-medium': { input: 100, output: 5, cacheRead: 10, cacheWrite: 0 } });
  state.fold(parseSteps(plannerLine(1, at, [120, 10, 7])).steps);
  assert.deepEqual(state.usageByModel(), { 'gemini-4-argon-medium': { input: 120, output: 7, cacheRead: 10, cacheWrite: 0 } });
  // The same index with another time is a NEW step, and counts on top.
  state.fold(parseSteps(plannerLine(1, '2026-11-22T20:05:00Z', [1, 2, 3])).steps);
  assert.deepEqual(state.usageByModel(), { 'gemini-4-argon-medium': { input: 121, output: 10, cacheRead: 12, cacheWrite: 0 } });
  // A rewritten file read again from the start books nothing twice: the
  // restarted state keeps what was booked, before and after the re-read.
  const before = state.usageByModel();
  const next = state.restarted();
  assert.notEqual(next.usageBook, state.usageBook, 'a copy, not the same book');
  assert.deepEqual(next.usageByModel(), before, 'kept across the restart');
  next.fold(parseSteps(plannerLine(1, at, [120, 10, 7])).steps);
  assert.deepEqual(next.usageByModel(), before);
});

test('usage: a planner step without a model of its own is booked under the model named before it', () => {
  const state = new AgyTranscriptState({ cwd: CWD });
  const bare = line({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T20:00:02Z', input_tokens: 5, cache_read_tokens: 0, output_tokens: 1 });
  state.fold(parseSteps([plannerLine(1, '2026-11-22T20:00:01Z', [10, 0, 2], 'gemini-4-neon-low'), bare].join('\n')).steps);
  assert.deepEqual(state.usageByModel(), { 'gemini-4-neon-low': { input: 15, output: 3, cacheRead: 0, cacheWrite: 0 } });
});

test('usage: with no model known, or an unsafe one, a step is booked under "agy"', () => {
  const book = new AgyUsageBook();
  const step = (index, usage) => ({ index, type: 'PLANNER_RESPONSE', at: index, usage });
  book.book(step(1, { input: 1, cacheRead: 0, output: 1 }), '');
  book.book(step(2, { input: 2, cacheRead: 0, output: 2 }), '__proto__');
  book.book(step(4, { input: 0, cacheRead: 0, output: 0 }), 'constructor');
  book.book({ index: 3, type: 'USER_INPUT', at: 3, usage: { input: 9, cacheRead: 9, output: 9 } }, 'x');
  assert.deepEqual(book.byModel(), { agy: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(sumAgyByModel([{ a: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { a: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } }]),
    { a: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } });
  // An Object.prototype name is never looked up as an inherited member (that summed to NaN).
  const proto = { constructor: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, toString: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  assert.deepEqual(sumAgyByModel([proto, proto]), {});
});

test('usage: the watcher emits the tab\'s totals with its subagents\', and no price is invented for agy models', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: ORCH_ID, folder: tabDir }, { id: SUB_ID, folder: tabDir, parent: ORCH_ID }]);
  const { watcher, out } = makeFullWatcher(root, tabDir);
  writeTranscript(root, SUB_ID, CAPTURED_SUB, 'transcript_full.jsonl');
  writeTranscript(root, ORCH_ID, CAPTURED_ORCH, 'transcript_full.jsonl');
  drain(watcher, 5);
  const last = out.metrics[out.metrics.length - 1];
  assert.deepEqual(last.byModel, sumAgyByModel([ORCH_USAGE, SUB_USAGE]));
  assert.deepEqual(last.byModel['gemini-4-hydrogen-xhigh'], { input: 34110, output: 2550, cacheRead: 38476, cacheWrite: 0 });
  assert.equal(last.estimated, true);
  assert.equal('cost' in last, false, 'no cost on an agy reading');
  // What God Mode books from it: tokens, at no cost; the price table knows no agy model.
  const booked = usageFromTranscript(last.byModel);
  assert.equal(booked.costUsd, 0);
  assert.equal(booked.inputTokens, 13681 + 34110);
  assert.equal(booked.cacheReadTokens, 8533 + 38476);
  assert.equal(estimateSessionCost(new Map(Object.entries(last.byModel))), null);
  // Nothing new: no repeat of the same reading.
  const count = out.metrics.length;
  drain(watcher, 3);
  assert.equal(out.metrics.length, count);
  watcher.stop();
});

const PARENT_G = 'abababab-7777-4777-8777-abababababab';
const CHILD_H = 'cdcdcdcd-8888-4888-8888-cdcdcdcdcdcd';

test('usage: a subagent let go keeps its tokens, and taken up again is not counted twice', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: PARENT_G, folder: tabDir }]);
  let clock = Date.parse('2026-11-22T20:00:00Z');
  const { watcher, out } = makeFullWatcher(root, tabDir, { now: () => clock });
  const named = (step) => [
    line({ type: 'PLANNER_RESPONSE', step_index: step, tool_calls: [{ name: 'invoke_subagent', args: { Role: 'helper' } }] }),
    line({ type: 'GENERIC', step_index: step + 1, status: 'DONE', content: `{"conversationId": "${CHILD_H}"}` }),
  ].join('\n');
  const childFile = writeTranscript(root, CHILD_H, `${plannerLine(1, '2026-11-22T20:00:01Z', [100, 0, 10])}\n`);
  const parent = writeTranscript(root, PARENT_G, `${named(1)}\n`);
  drain(watcher, 3);
  const child = () => out.metrics[out.metrics.length - 1].byModel['gemini-4-argon-medium'];
  assert.deepEqual(child(), { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  clock += 11 * 60 * 1000;
  watcher.safeTick();
  assert.equal(watcher.children.has(CHILD_H), false, 'let go');
  assert.deepEqual(watcher.usageByModel()['gemini-4-argon-medium'], { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  fs.appendFileSync(childFile, `${plannerLine(2, '2026-11-22T20:12:00Z', [50, 5, 1])}\n`);
  fs.appendFileSync(parent, `${named(3)}\n`);
  drain(watcher, 3);
  assert.ok(watcher.children.has(CHILD_H), 'taken up again');
  assert.deepEqual(child(), { input: 150, output: 11, cacheRead: 5, cacheWrite: 0 });
  watcher.stop();
});

/** Whether no model's input, output or cacheRead ever drops from one reading to the next. */
function neverDrops(readings) {
  for (let i = 1; i < readings.length; i++) {
    for (const [model, before] of Object.entries(readings[i - 1])) {
      const now = readings[i][model];
      if (!now || ['input', 'output', 'cacheRead'].some((k) => now[k] < before[k])) return false;
    }
  }
  return true;
}

const PARENT_I = 'efefefef-9999-4999-8999-efefefefefef';
const CHILD_J = '12121212-aaaa-4aaa-8aaa-121212121212';
const RESUMED_K = '34343434-bbbb-4bbb-8bbb-343434343434';

test('usage: a subagent taken up again (even out of `retired`) and read back in small chunks is neither lowered nor counted twice', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  writeSummaryRows(root, [{ id: PARENT_I, folder: tabDir }]);
  let clock = Date.parse('2026-11-22T20:00:00Z');
  // One step line per read: the re-read takes several ticks.
  const { watcher, out } = makeFullWatcher(root, tabDir, { now: () => clock, chunkBytes: 400 });
  const named = (step) => [
    line({ type: 'PLANNER_RESPONSE', step_index: step, tool_calls: [{ name: 'invoke_subagent', args: {} }] }),
    line({ type: 'GENERIC', step_index: step + 1, status: 'DONE', content: `{"conversationId": "${CHILD_J}"}` }),
  ].join('\n');
  const steps = [1, 2, 3, 4].map((i) => plannerLine(i, `2026-11-22T20:00:0${i}Z`, [100, 10, 1]));
  const childFile = writeTranscript(root, CHILD_J, `${steps.join('\n')}\n`);
  const parent = writeTranscript(root, PARENT_I, `${named(1)}\n`);
  drain(watcher, 10);
  clock += 11 * 60 * 1000;
  watcher.safeTick();
  assert.equal(watcher.children.has(CHILD_J), false, 'let go');
  // Pushed out of `retired` (past MAX_RETIRED_CHILDREN): its new reader starts at byte 0.
  watcher.retired.delete(CHILD_J);
  fs.appendFileSync(childFile, `${plannerLine(5, '2026-11-22T20:12:00Z', [7, 0, 0])}\n`);
  fs.appendFileSync(parent, `${named(3)}\n`);
  drain(watcher, 10);
  const readings = out.metrics.filter((m) => m.byModel).map((m) => m.byModel);
  assert.ok(neverDrops(readings), 'a part-way re-read must not read as a transcript that started over');
  assert.deepEqual(readings[readings.length - 1]['gemini-4-argon-medium'], { input: 407, output: 4, cacheRead: 40, cacheWrite: 0 });
  watcher.stop();
});

test('usage: a resumed conversation sends no byModel until its history is read', () => {
  const tabDir = makeTabDir();
  const root = makeAppData(null);
  const steps = [1, 2, 3, 4].map((i) => plannerLine(i, `2026-11-22T20:00:0${i}Z`, [100, 0, 10]));
  writeTranscript(root, RESUMED_K, `${steps.join('\n')}\n`);
  const { watcher, out } = makeFullWatcher(root, tabDir, { conversationId: RESUMED_K, chunkBytes: 400 });
  drain(watcher, 10);
  assert.equal(watcher.pinned.id, RESUMED_K);
  const withUsage = out.metrics.filter((m) => m.byModel);
  assert.equal(withUsage.length, 1, 'one reading, once caught up');
  assert.deepEqual(withUsage[0].byModel, { 'gemini-4-argon-medium': { input: 400, output: 40, cacheRead: 0, cacheWrite: 0 } });
  watcher.stop();
});
