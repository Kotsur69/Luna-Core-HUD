// Tests for the pure functions behind "Export session to Markdown"
// (src/sessionExport.js). Zero DOM, zero disk: classifyEntry / truncateResult /
// stripInjectedNoise / slashCommand / buildFrontmatter / transcriptToMarkdown
// are all pure text -> text. The button wiring and save dialog live behind a
// manual check (LUNA_HUD_SPECIFICATION.md export section).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  transcriptToMarkdown,
  classifyEntry,
  truncateResult,
  stripInjectedNoise,
  slashCommand,
  buildFrontmatter,
  MAX_RESULT_LINES,
} = require('../src/sessionExport.js');

// ---- fixtures --------------------------------------------------------------

const TS = '2026-08-27T08:00:00.000Z';

const userPrompt = (text, extra = {}) => ({
  type: 'user',
  timestamp: TS,
  message: { role: 'user', content: text },
  cwd: 'C:\\Users\\mmazur\\source\\repos\\Luna-Core-HUD',
  gitBranch: 'main',
  sessionId: 'sess-abc',
  ...extra,
});

const assistantText = (text, extra = {}) => ({
  type: 'assistant',
  timestamp: TS,
  message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }] },
  ...extra,
});

const assistantToolUse = (id, name, input) => ({
  type: 'assistant',
  timestamp: TS,
  message: {
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id, name, input }],
  },
});

const toolResult = (id, content, isError = false) => ({
  type: 'user',
  timestamp: TS,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// ---- classifyEntry ------------------------------------------------------

test('classifyEntry skips CLI-bookkeeping entry types', () => {
  for (const type of ['system', 'summary', 'file-history-snapshot', 'mode', 'queue-operation']) {
    assert.equal(classifyEntry({ type }).kind, 'skip', type);
  }
});

test('classifyEntry skips isMeta entries even when they look like prompts', () => {
  assert.equal(classifyEntry(userPrompt('hello', { isMeta: true })).kind, 'skip');
});

test('classifyEntry treats a plain string user message as a prompt and strips injected noise', () => {
  const c = classifyEntry(userPrompt('real question<system-reminder>ignore me</system-reminder>'));
  assert.equal(c.kind, 'prompt');
  assert.equal(c.text, 'real question');
  assert.equal(c.sidechain, false);
});

test('classifyEntry recognises a slash-command invocation', () => {
  const raw = '<command-name>low-priority</command-name>\n<command-message>low-priority</command-message>\n<command-args></command-args>';
  const c = classifyEntry(userPrompt(raw));
  assert.equal(c.kind, 'command');
  assert.equal(c.command, '/low-priority');
});

test('classifyEntry skips a user entry that is only tool_result blocks', () => {
  assert.equal(classifyEntry(toolResult('t1', 'output')).kind, 'skip');
});

test('classifyEntry keeps a user entry that mixes tool_result with real text', () => {
  const e = {
    type: 'user',
    timestamp: TS,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'text', text: 'and also this' },
      ],
    },
  };
  const c = classifyEntry(e);
  assert.equal(c.kind, 'prompt');
  assert.match(c.text, /and also this/);
});

test('classifyEntry flags an API-error assistant entry', () => {
  const c = classifyEntry({ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: '529', timestamp: TS });
  assert.equal(c.kind, 'error');
  assert.equal(c.status, '529');
});

test('classifyEntry propagates the sidechain flag', () => {
  assert.equal(classifyEntry(userPrompt('sub task', { isSidechain: true })).sidechain, true);
  assert.equal(classifyEntry(assistantText('sub reply', { isSidechain: true })).sidechain, true);
});

// ---- stripInjectedNoise / slashCommand --------------------------------

test('stripInjectedNoise removes system-reminder and caveat blocks', () => {
  const input = 'keep\n<system-reminder>a\nb</system-reminder>\n<local-command-caveat>c</local-command-caveat>\nkeep2';
  assert.equal(stripInjectedNoise(input), 'keep\n\nkeep2');
});

test('slashCommand returns null for ordinary prose', () => {
  assert.equal(slashCommand('just a normal sentence'), null);
});

test('slashCommand includes args when present', () => {
  const raw = '<command-name>/model</command-name><command-args>opus</command-args>';
  assert.equal(slashCommand(raw), '/model opus');
});

// ---- truncateResult ---------------------------------------------------

test('truncateResult leaves a short body untouched', () => {
  const r = truncateResult('one\ntwo\nthree');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'one\ntwo\nthree');
});

test('truncateResult cuts a body past the line cap and reports the remainder', () => {
  const body = Array.from({ length: MAX_RESULT_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
  const r = truncateResult(body);
  assert.equal(r.truncated, true);
  assert.equal(r.text.split('\n').length, MAX_RESULT_LINES);
  assert.equal(r.omittedLines, 10);
});

test('truncateResult stringifies non-string tool_result content', () => {
  const r = truncateResult([{ type: 'text', text: 'from a block' }]);
  assert.equal(r.text, 'from a block');
});

// ---- transcriptToMarkdown -------------------------------------------

test('transcriptToMarkdown renders Mati and Luna section headers', () => {
  const md = transcriptToMarkdown(jsonl(userPrompt('hi luna'), assistantText('hello Mati')));
  assert.match(md, /## 🧑 Mati · \d{2}:\d{2}:\d{2}\n\nhi luna/);
  assert.match(md, /## 🌙 Luna · \d{2}:\d{2}:\d{2}\n\nhello Mati/);
});

test('transcriptToMarkdown folds a tool call and its result into one <details> block', () => {
  const md = transcriptToMarkdown(
    jsonl(
      userPrompt('read it'),
      assistantToolUse('tu1', 'Read', { file_path: 'src/main.js' }),
      toolResult('tu1', '1  // first line\n2  // second line'),
      assistantText('done'),
    ),
  );
  assert.match(md, /<details><summary>🔧 Read · src\/main\.js<\/summary>/);
  assert.match(md, /result:\n```\n1  \/\/ first line/);
  assert.equal((md.match(/<details>/g) || []).length, 1);
});

test('transcriptToMarkdown coalesces a run of assistant entries under one Luna header', () => {
  const md = transcriptToMarkdown(
    jsonl(
      userPrompt('do the thing'),
      assistantToolUse('a1', 'Read', { file_path: 'a.js' }),
      toolResult('a1', 'contents of a'),
      assistantToolUse('a2', 'Read', { file_path: 'b.js' }),
      toolResult('a2', 'contents of b'),
      assistantText('all done'),
    ),
  );
  assert.equal((md.match(/## 🌙 Luna/g) || []).length, 1);
  assert.equal((md.match(/<details>/g) || []).length, 2);
  assert.match(md, /all done/);
});

test('transcriptToMarkdown starts a fresh Luna header after an intervening prompt', () => {
  const md = transcriptToMarkdown(
    jsonl(userPrompt('one'), assistantText('first'), userPrompt('two'), assistantText('second')),
  );
  assert.equal((md.match(/## 🌙 Luna/g) || []).length, 2);
});

test('transcriptToMarkdown marks an errored tool result and drops orphan results', () => {
  const withError = transcriptToMarkdown(
    jsonl(assistantToolUse('e1', 'Bash', { command: 'git push' }), toolResult('e1', 'denied', true)),
  );
  assert.match(withError, /<details><summary>⚠️ Bash/);
  assert.match(withError, /error:\n```\ndenied/);

  const orphan = transcriptToMarkdown(jsonl(userPrompt('hi'), toolResult('nope', 'stray output')));
  assert.doesNotMatch(orphan, /<details>/);
  assert.doesNotMatch(orphan, /stray output/);
});

test('transcriptToMarkdown omits meta / system / summary lines from the body', () => {
  const md = transcriptToMarkdown(
    jsonl(
      { type: 'summary', summary: 'old compaction' },
      { type: 'system', subtype: 'x', isMeta: true, timestamp: TS },
      userPrompt('the only real prompt'),
    ),
  );
  assert.doesNotMatch(md, /old compaction/);
  assert.match(md, /the only real prompt/);
});

test('transcriptToMarkdown wraps sub-agent turns in a marked section', () => {
  const md = transcriptToMarkdown(
    jsonl(
      userPrompt('spawn a helper'),
      assistantText('starting a sub-agent'),
      userPrompt('sidechain task', { isSidechain: true }),
      assistantText('sidechain answer', { isSidechain: true }),
      assistantText('back on the main thread'),
    ),
  );
  assert.match(md, /### ⤷ Sub-agent/);
  assert.match(md, /### ⤷ End sub-agent/);
  assert.match(md, /sidechain task/);
  // the sub-agent section closes before the main thread resumes
  assert.ok(md.indexOf('### ⤷ End sub-agent') < md.indexOf('back on the main thread'));
});

test('transcriptToMarkdown renders a slash command as a one-liner without its stdout', () => {
  const raw =
    '<command-name>low-priority</command-name>\n<command-args></command-args>\n<local-command-stdout>lots of noise here</local-command-stdout>';
  const md = transcriptToMarkdown(jsonl(userPrompt(raw)));
  assert.match(md, /> ⚡ `\/low-priority`/);
  assert.doesNotMatch(md, /lots of noise here/);
});

test('transcriptToMarkdown tolerates a truncated trailing JSON line', () => {
  const good = jsonl(userPrompt('hi'), assistantText('there'));
  const broken = good + '{"type":"assistant","message":{"content":[{"type":"tex';
  assert.doesNotThrow(() => transcriptToMarkdown(broken));
  assert.match(transcriptToMarkdown(broken), /## 🌙 Luna/);
});

// ---- buildFrontmatter -----------------------------------------------

test('buildFrontmatter carries session id, project, branch and prompt count', () => {
  const text = jsonl(userPrompt('q1'), assistantText('a1'), userPrompt('q2'), assistantText('a2'));
  const fm = buildFrontmatter(text, text.trim().split('\n').map((l) => JSON.parse(l)));
  assert.match(fm, /^---\n/);
  assert.match(fm, /session: sess-abc/);
  assert.match(fm, /project: Luna-Core-HUD/);
  assert.match(fm, /branch: main/);
  assert.match(fm, /prompts: 2/);
  assert.match(fm, /model: claude-sonnet-5/);
  assert.match(fm, /\n---$/);
});

test('buildFrontmatter dedupes and lists every model used in the session', () => {
  const a2 = assistantText('with opus');
  a2.message.model = 'claude-opus-5';
  const text = jsonl(userPrompt('q'), assistantText('with sonnet'), userPrompt('q2'), a2);
  const fm = buildFrontmatter(text, text.trim().split('\n').map((l) => JSON.parse(l)));
  assert.match(fm, /model: claude-sonnet-5, claude-opus-5/);
});

test('buildFrontmatter meta overrides win over transcript-derived values', () => {
  const text = jsonl(userPrompt('q'));
  const fm = buildFrontmatter(text, [JSON.parse(text.trim())], { project: 'Renamed', sessionId: 'override' });
  assert.match(fm, /project: Renamed/);
  assert.match(fm, /session: override/);
});
