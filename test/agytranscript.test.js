// Tests for the Antigravity (agy) transcript adapter (src/agytranscript.js)
// and its watcher (src/agywatcher.js).
//
// FIXTURE IS ASSUMED, NOT CAPTURED: test/fixtures/agy-transcript.assumed.jsonl
// follows the step format agy documents inside agy.exe 1.5.9 (step_index,
// type, status, created_at, content, tool_calls [{name, args}] with
// JSON-quoted string args, GENERIC results in call order), but no agy
// conversation on the machine it was written on had any steps to copy.

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
  unquoteArg,
  normalizeAgyPath,
  editStatOf,
  parseSteps,
  AgyTranscriptState,
  agyContextMetrics,
  workspacesFromRows,
} = require('../src/agytranscript');
const { AgyTranscriptWatcher, readConversationWorkspaces } = require('../src/agywatcher');
const { TOOL_TILES, usageToMetrics } = require('../src/observer');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-transcript.assumed.jsonl'), 'utf8');
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
  assert.match(skipped[0].reason, /invalid JSON/);
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
  const byId = workspacesFromRows([
    { conversation_id: id.toUpperCase(), workspace_uris: JSON.stringify([uri, 'https://x', 7]) },
    { conversation_id: 'nope', workspace_uris: '[]' },
    { conversation_id: '1b6cd2b4-0b4a-4e4f-9d5b-6d0f1a2b3c4d', workspace_uris: '{broken' },
    null,
  ]);
  assert.deepEqual([...byId.keys()], [id]);
  assert.equal(byId.get(id).length, 1);
  assert.deepEqual(workspacesFromRows('junk'), new Map());
});

// ---- the watcher, against a temporary agy app data folder ---------------------------------

const tmpRoots = [];
test.after(async () => {
  for (const dir of tmpRoots) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** A fake <appData>: summaries rows {id: folder}, transcripts written by the test. */
function makeAppData(workspaces) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-'));
  tmpRoots.push(root);
  if (workspaces) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
    db.exec('create table conversation_summaries (conversation_id text primary key, workspace_uris text not null)');
    const insert = db.prepare('insert into conversation_summaries values (?, ?)');
    for (const [id, folder] of Object.entries(workspaces)) insert.run(id, JSON.stringify([pathToFileURL(folder).href]));
    db.close();
  }
  return root;
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
  const tabDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-tab-'));
  tmpRoots.push(tabDir);
  const root = makeAppData({ [ID_A]: tabDir, [ID_B]: path.join(tabDir, 'elsewhere') });
  const { watcher, out } = makeWatcher(root, tabDir);
  watcher.safeTick();
  assert.equal(out.metrics.length, 0, 'nothing to read yet');

  writeTranscript(root, ID_B, FIXTURE); // another folder's conversation
  const mine = writeTranscript(root, ID_A, FIXTURE);
  watcher.safeTick();
  assert.equal(watcher.pinned, mine);
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
  const tabDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-agy-tab-'));
  tmpRoots.push(tabDir);
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
  assert.notEqual(two.watcher.pinned, one.watcher.pinned);
  one.watcher.stop();
  two.watcher.stop();
});

test('watcher: a resumed conversation replays no history, only what comes after', () => {
  const root = makeAppData({ [ID_A]: CWD });
  const file = writeTranscript(root, ID_A, FIXTURE, 'transcript_full.jsonl');
  const { watcher, out } = makeWatcher(root, CWD, { conversationId: ID_A.toUpperCase() });
  watcher.safeTick();
  assert.equal(watcher.pinned, file);
  assert.equal(out.tools.length, 0, 'history is not live activity');
  assert.equal(out.metrics.length, 1, 'but its context still counts');
  assert.ok(out.metrics[0].tokens > 0);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 9, tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:/repo/z.js' } }] })}\n`);
  watcher.safeTick();
  assert.deepEqual(out.tools.map((e) => e.phase), ['start']);
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
  assert.equal(watcher.pinned, file);
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
  assert.match(ws.reason, /conversation_summaries\.db unreadable/);
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
