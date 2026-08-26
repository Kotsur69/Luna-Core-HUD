// Tests for the pure functions of the Passive Observer (no I/O, no PTY).
// TranscriptWatcher is deliberately NOT tested here - it touches the filesystem.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectTools,
  detectApprovalPrompt,
  encodeProjectDir,
  usageToMetrics,
  sumUsageLines,
  sumUsageByModel,
  toolsFromLines,
  toolEventsFromLines,
  foldToolEvents,
  mcpEventsFromLines,
  foldMcpEvents,
  hasTurnEnd,
  hasUserPromptStart,
  isLongTurn,
  CONTEXT_LIMIT,
} = require('../src/observer');

// ---- usageToMetrics ---------------------------------------------------------

test('usageToMetrics sums input + both kinds of cache', () => {
  const m = usageToMetrics({
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 1000,
  });
  assert.equal(m.tokens, 2000);
  assert.equal(m.limit, CONTEXT_LIMIT);
  assert.equal(m.percent, 2000 / CONTEXT_LIMIT);
});

test('usageToMetrics treats missing fields as zero', () => {
  assert.equal(usageToMetrics({}).tokens, 0);
  assert.equal(usageToMetrics({}).percent, 0);
  assert.equal(usageToMetrics({ input_tokens: 5 }).tokens, 5);
});

test('usageToMetrics promotes the window instead of pinning the bar at 100% (B2)', () => {
  // The limit used to be a constant 200k, so 600k tokens produced a dead 100%.
  // Now the observation itself proves the window is bigger.
  const m = usageToMetrics({ input_tokens: 600000 });
  assert.equal(m.limit, 1000000);
  assert.equal(m.percent, 0.6);
});

test('usageToMetrics still clamps percent to 1 above the largest known window', () => {
  const m = usageToMetrics({ input_tokens: 5000000 });
  assert.equal(m.percent, 1);
  // tokens stays raw - we only clamp the value that draws the bar.
  assert.equal(m.tokens, 5000000);
});

test('usageToMetrics carries the model and its label into the metrics (B3)', () => {
  const m = usageToMetrics({ input_tokens: 1000 }, 'claude-opus-4-8');
  assert.equal(m.model, 'claude-opus-4-8');
  assert.equal(m.modelLabel, 'Opus 4.8');
  // 1M, not 200k: Opus 4.8 really does have a 1M window. The earlier 200k
  // assertion here was the bug, not the fix.
  assert.equal(m.limit, 1000000);
});

test('usageToMetrics without a model keeps the default 200k window', () => {
  const m = usageToMetrics({ input_tokens: 1000 });
  assert.equal(m.limit, CONTEXT_LIMIT);
  assert.equal(m.modelLabel, '');
});

// ---- encodeProjectDir -------------------------------------------------------
// This is the crux of multi-session support: a wrong directory name = someone else's session metrics.

test('encodeProjectDir replaces every non-alphanumeric character with a hyphen', () => {
  assert.equal(encodeProjectDir('C:\\Users\\mmazur\\.local\\bin'), 'C--Users-mmazur--local-bin');
});

test('encodeProjectDir handles a POSIX path', () => {
  assert.equal(encodeProjectDir('/home/mati/repos/Luna-Core-HUD'), '-home-mati-repos-Luna-Core-HUD');
});

test('encodeProjectDir does not choke on empty/invalid input', () => {
  assert.equal(encodeProjectDir(''), '');
  assert.equal(encodeProjectDir(null), '');
  assert.equal(encodeProjectDir(undefined), '');
});

// ---- detectTools ------------------------------------------------------------

test('detectTools detects a tool in raw stdout', () => {
  assert.deepEqual(detectTools('Bash(ls -la)'), ['Shell']);
});

test('detectTools strips ANSI sequences before matching', () => {
  // This is what a real TUI stream looks like - the tool name is colored.
  assert.deepEqual(detectTools('\x1b[32mGrep(pattern)'), ['Grep']);
  assert.deepEqual(detectTools('\x1b[1m\x1b[38;5;208mRead(file.js)'), ['Read']);
});

test('detectTools maps aliases onto a shared tile', () => {
  assert.deepEqual(detectTools('MultiEdit(a)'), ['Edit']);
  assert.deepEqual(detectTools('NotebookEdit(a)'), ['Edit']);
  assert.deepEqual(detectTools('WebFetch(url)'), ['Web']);
  assert.deepEqual(detectTools('WebSearch(q)'), ['Web']);
  assert.deepEqual(detectTools('BashOutput(id)'), ['Shell']);
});

test('detectTools deduplicates repeats', () => {
  assert.deepEqual(detectTools('Read(a) Read(b) Read(c)'), ['Read']);
});

test('detectTools returns multiple tiles from one chunk of data', () => {
  const tiles = detectTools('Read(a) then Bash(ls) then Write(b)');
  assert.deepEqual(tiles.sort(), ['Read', 'Shell', 'Write']);
});

test('detectTools requires a parenthesis - a bare name in a sentence does not light a tile', () => {
  assert.deepEqual(detectTools('I will read the file and write a summary'), []);
  assert.deepEqual(detectTools('Bash'), []);
});

test('detectTools does not choke on empty input', () => {
  assert.deepEqual(detectTools(''), []);
  assert.deepEqual(detectTools(null), []);
});

test('detectTools is resilient to repeated calls (the /g regex has state)', () => {
  // TOOL_RE lives at module scope - without resetting lastIndex, a second call
  // would drop matches. This test guards exactly that.
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
});

// ---- detectApprovalPrompt (§4.2) --------------------------------------------

const APPROVAL_PATTERNS = [
  'Do you want to proceed',
  'Do you want to make this edit',
  'Do you want to create',
  'Do you trust the files in this folder',
];

test('detectApprovalPrompt detects a literal substring match', () => {
  assert.equal(
    detectApprovalPrompt('│ Do you want to proceed?          │', APPROVAL_PATTERNS),
    true,
  );
});

test('detectApprovalPrompt strips ANSI sequences before matching', () => {
  assert.equal(
    detectApprovalPrompt('\x1b[1mDo you want to make this edit\x1b[0m to file.js?', APPROVAL_PATTERNS),
    true,
  );
});

test('detectApprovalPrompt checks every pattern in the list', () => {
  assert.equal(detectApprovalPrompt('Do you want to create foo.js?', APPROVAL_PATTERNS), true);
  assert.equal(
    detectApprovalPrompt('Do you trust the files in this folder?', APPROVAL_PATTERNS),
    true,
  );
});

test('detectApprovalPrompt returns false when nothing matches', () => {
  assert.equal(detectApprovalPrompt('Reading file.js...', APPROVAL_PATTERNS), false);
});

test('detectApprovalPrompt does not choke on empty/missing input', () => {
  assert.equal(detectApprovalPrompt('', APPROVAL_PATTERNS), false);
  assert.equal(detectApprovalPrompt(null, APPROVAL_PATTERNS), false);
  assert.equal(detectApprovalPrompt('Do you want to proceed?', null), false);
  assert.equal(detectApprovalPrompt('Do you want to proceed?', []), false);
  assert.equal(detectApprovalPrompt('Do you want to proceed?', undefined), false);
});

test('detectApprovalPrompt ignores patterns that are not strings', () => {
  assert.equal(detectApprovalPrompt('Do you want to proceed?', ['Do you want to proceed', 42, null]), true);
});

test('detectApprovalPrompt is case-sensitive (deliberately - a literal substring)', () => {
  assert.equal(detectApprovalPrompt('do you want to proceed?', APPROVAL_PATTERNS), false);
});

// ---- sumUsageByModel / sumUsageLines (B4) -----------------------------------

/** Builds one transcript line the way Claude Code writes it. */
const line = (model, usage) => JSON.stringify({ message: { model, usage } });

test('sumUsageByModel keeps each model in its own bucket', () => {
  const text = [
    line('claude-opus-5', { input_tokens: 100, output_tokens: 10 }),
    line('claude-sonnet-5', { input_tokens: 200, output_tokens: 20 }),
    line('claude-opus-5', { input_tokens: 5, output_tokens: 1 }),
  ].join('\n');

  const byModel = sumUsageByModel(text);
  assert.equal(byModel.size, 2);
  assert.equal(byModel.get('claude-opus-5').input, 105);
  assert.equal(byModel.get('claude-opus-5').output, 11);
  assert.equal(byModel.get('claude-sonnet-5').input, 200);
});

test('sumUsageByModel counts both kinds of cache tokens per model', () => {
  const text = line('claude-opus-5', {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
  });
  const bucket = sumUsageByModel(text).get('claude-opus-5');
  assert.deepEqual(bucket, { input: 1, output: 2, cacheRead: 300, cacheWrite: 40 });
});

test('sumUsageByModel files an entry without a model under the empty key', () => {
  // A local backend may not report a model at all. It still burns tokens, so it
  // must be counted - it simply cannot be priced later.
  const byModel = sumUsageByModel(line(undefined, { input_tokens: 7 }));
  assert.equal(byModel.get('').input, 7);
});

test('sumUsageByModel skips malformed lines instead of throwing', () => {
  const text = [
    line('claude-opus-5', { input_tokens: 10 }),
    '{"message":{"usage":', // torn write, mid-flush
    '',
    line('claude-opus-5', { input_tokens: 5 }),
  ].join('\n');
  assert.equal(sumUsageByModel(text).get('claude-opus-5').input, 15);
});

// ---- toolsFromLines (Skill Tracker from the transcript) ---------------------

/** Builds an assistant line carrying tool_use blocks, as the CLI writes them. */
const toolLine = (...names) =>
  JSON.stringify({
    message: {
      role: 'assistant',
      content: names.map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: {} })),
    },
  });

test('toolsFromLines reads a tool call from structured transcript data', () => {
  // The stdout scan missed these because it matched the TUI's "Name(" shape.
  assert.deepEqual(toolsFromLines(toolLine('Read')), ['Read']);
});

test('toolsFromLines lights the Shell tile for PowerShell, not just Bash', () => {
  // The tile map predated the PowerShell tool, so on Windows the shell tile
  // never lit at all: counted across recent transcripts on this machine it was
  // PowerShell 49 vs Bash 19. Nothing in the suite noticed, because every test
  // fed it the name it already knew.
  assert.deepEqual(toolsFromLines(toolLine('PowerShell')), ['Shell']);
  assert.deepEqual(toolsFromLines(toolLine('Bash')), ['Shell']);
});

test('toolsFromLines maps aliases onto their shared tile', () => {
  assert.deepEqual(toolsFromLines(toolLine('MultiEdit')), ['Edit']);
  assert.deepEqual(toolsFromLines(toolLine('WebSearch')), ['Web']);
});

test('toolsFromLines deduplicates and handles several calls in one line', () => {
  assert.deepEqual(toolsFromLines(toolLine('Read', 'Read', 'Bash')), ['Read', 'Shell']);
});

test('toolsFromLines ignores tools with no tile, such as MCP servers', () => {
  assert.deepEqual(toolsFromLines(toolLine('mcp__shadcn__search_items')), []);
});

test('toolsFromLines ignores lines that are not tool calls', () => {
  const text = [
    JSON.stringify({ message: { role: 'user', content: 'Read the file please' } }),
    line('claude-opus-5', { input_tokens: 10 }),
  ].join('\n');
  assert.deepEqual(toolsFromLines(text), []);
});

test('toolsFromLines survives a torn line mid-write', () => {
  const text = [toolLine('Bash'), '{"message":{"content":[{"type":"tool_'].join('\n');
  assert.deepEqual(toolsFromLines(text), ['Shell']);
});

test('toolsFromLines returns nothing for empty input', () => {
  assert.deepEqual(toolsFromLines(''), []);
  assert.deepEqual(toolsFromLines(null), []);
});

test('sumUsageLines still returns the flat aggregate across models', () => {
  // Guards the older contract: per-model bucketing must not change this number.
  const text = [
    line('claude-opus-5', { input_tokens: 100, output_tokens: 10 }),
    line('claude-sonnet-5', { input_tokens: 200, output_tokens: 20 }),
  ].join('\n');
  assert.deepEqual(sumUsageLines(text), {
    input: 300,
    output: 30,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

// ---- toolEventsFromLines / foldToolEvents (B8: duration, not a blink) -------

const TS = '2026-01-01T00:00:00.000Z';

/** Assistant line opening one or more tool calls, as the CLI writes them.
 *  Each pair is [id, name] or [id, name, input] when a file_path matters. */
const useLine = (...pairs) =>
  JSON.stringify({
    timestamp: TS,
    message: {
      role: 'assistant',
      content: pairs.map(([id, name, input]) => ({ type: 'tool_use', id, name, input: input || {} })),
    },
  });

/** User line closing tool calls. Note it carries NO tool name - only the id. */
const resLine = (...ids) =>
  JSON.stringify({
    timestamp: TS,
    message: {
      role: 'user',
      content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
    },
  });

/** User line closing exactly ONE tool call, carrying the entry's top-level
 *  `toolUseResult` (the CLI's diff-stat payload) - only ever single-id,
 *  since toolEventsFromLines() only reads toolUseResult when the entry
 *  holds exactly one tool_result block (plan §2.5). */
const resLineWithResult = (id, toolUseResult) =>
  JSON.stringify({
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult,
  });

test('toolEventsFromLines pairs a tool_use with the tool_result that closes it', () => {
  const events = toolEventsFromLines([useLine(['t0', 'Bash']), resLine('t0')].join('\n'));
  assert.deepEqual(
    events.map((e) => [e.phase, e.id, e.tile]),
    [
      ['start', 't0', 'Shell'],
      ['end', 't0', undefined],
    ]
  );
});

test('toolEventsFromLines takes the time from the entry, not from when we read it', () => {
  // The watcher polls every 1.5 s, so read time is far too coarse to time a tool.
  const [start] = toolEventsFromLines(useLine(['t0', 'Read']));
  assert.equal(start.at, Date.parse(TS));
});

test('toolEventsFromLines skips a start with no tile, so its end is an orphan', () => {
  const text = [useLine(['t0', 'mcp__shadcn__search_items']), resLine('t0')].join('\n');
  assert.deepEqual(
    toolEventsFromLines(text).map((e) => e.phase),
    ['end']
  );
  // ...and the fold drops that orphan rather than inventing a tile for it.
  assert.deepEqual(foldToolEvents(new Map(), toolEventsFromLines(text)), []);
});

test('toolEventsFromLines survives a torn line mid-write', () => {
  const text = [useLine(['t0', 'Grep']), '{"message":{"content":[{"type":"tool_'].join('\n');
  assert.equal(toolEventsFromLines(text).length, 1);
});

test('foldToolEvents resolves an end tile from the id that opened it', () => {
  const open = new Map();
  const out = foldToolEvents(open, toolEventsFromLines(useLine(['t0', 'MultiEdit'])));
  assert.deepEqual(out, [{ phase: 'start', id: 't0', tile: 'Edit', at: Date.parse(TS), file: '' }]);

  const closed = foldToolEvents(open, toolEventsFromLines(resLine('t0')));
  assert.equal(closed[0].tile, 'Edit'); // the alias still maps to the Edit tile
  assert.equal(open.size, 0);
});

test('foldToolEvents keeps a tool open ACROSS chunks', () => {
  // The whole point: a long Bash starts in one appended chunk and ends in a
  // later one. If the map did not survive the tick, the tile could never stay
  // lit for the tool's real duration.
  const open = new Map();
  foldToolEvents(open, toolEventsFromLines(useLine(['t0', 'Bash'])));
  foldToolEvents(open, toolEventsFromLines(''));
  assert.equal(open.size, 1, 'still running after an empty tick');
  foldToolEvents(open, toolEventsFromLines(resLine('t0')));
  assert.equal(open.size, 0);
});

test('foldToolEvents drops a duplicate start and an end for an unknown id', () => {
  const open = new Map();
  const starts = toolEventsFromLines(useLine(['t0', 'Read']));
  assert.equal(foldToolEvents(open, starts).length, 1);
  assert.equal(foldToolEvents(open, starts).length, 0, 're-read of the same line');
  assert.equal(foldToolEvents(open, toolEventsFromLines(resLine('nope'))).length, 0);
  assert.equal(open.size, 1);
});

test('foldToolEvents tracks concurrent tools sharing one tile', () => {
  // Edit / MultiEdit / NotebookEdit all light the Edit tile, so the tile may
  // only go dark when the LAST of them closes.
  const open = new Map();
  foldToolEvents(open, toolEventsFromLines(useLine(['t0', 'Edit'], ['t1', 'NotebookEdit'])));
  assert.equal(open.size, 2);
  assert.deepEqual(
    [...open.values()],
    [
      { tile: 'Edit', file: '' },
      { tile: 'Edit', file: '' },
    ]
  );

  foldToolEvents(open, toolEventsFromLines(resLine('t0')));
  assert.equal(open.size, 1, 'one Edit call is still outstanding');
  foldToolEvents(open, toolEventsFromLines(resLine('t1')));
  assert.equal(open.size, 0);
});

test('foldToolEvents handles a tool that starts and ends inside one tick', () => {
  // Fast tools do this constantly; both events arrive in the same chunk and the
  // renderer needs the pair, not a silent no-op.
  const open = new Map();
  const out = foldToolEvents(
    open,
    toolEventsFromLines([useLine(['t0', 'Read']), resLine('t0')].join('\n'))
  );
  assert.deepEqual(
    out.map((e) => e.phase),
    ['start', 'end']
  );
  assert.equal(open.size, 0);
});

// ---- file identity + diff stats (Active-Files Heatmap, ACTIVE_FILES_HEATMAP_PLAN.md §3.2) --

test('toolEventsFromLines carries input.file_path onto the start event', () => {
  const [start] = toolEventsFromLines(useLine(['t0', 'Edit', { file_path: 'C:\\repo\\a.js' }]));
  assert.equal(start.file, 'C:\\repo\\a.js');
});

test('toolEventsFromLines yields file: "" for a tool with no file_path (Bash)', () => {
  const [start] = toolEventsFromLines(useLine(['t0', 'Bash', { command: 'ls' }]));
  assert.equal(start.file, '');
});

test('toolEventsFromLines carries added/removed onto the end event from toolUseResult', () => {
  const toolUseResult = {
    filePath: 'C:\\repo\\a.js',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+one', '+two', '-three'] }],
  };
  const [end] = toolEventsFromLines(resLineWithResult('t0', toolUseResult));
  assert.equal(end.file, 'C:\\repo\\a.js');
  assert.equal(end.added, 2);
  assert.equal(end.removed, 1);
});

test('toolEventsFromLines does not attribute toolUseResult when the entry holds two tool_result blocks (§2.5 guard)', () => {
  const line = JSON.stringify({
    timestamp: TS,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't0', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      ],
    },
    toolUseResult: { filePath: 'C:\\repo\\a.js', structuredPatch: [{ lines: ['+x'] }] },
  });
  const events = toolEventsFromLines(line);
  assert.deepEqual(
    events.map((e) => [e.file, e.added, e.removed]),
    [
      ['', 0, 0],
      ['', 0, 0],
    ]
  );
});

test("foldToolEvents resolves the end event's file from the id that opened it, across chunks", () => {
  const open = new Map();
  foldToolEvents(open, toolEventsFromLines(useLine(['t0', 'Edit', { file_path: 'C:\\repo\\a.js' }])));
  const toolUseResult = { filePath: 'C:\\repo\\a.js', structuredPatch: [{ lines: ['+one'] }] };
  const [end] = foldToolEvents(open, toolEventsFromLines(resLineWithResult('t0', toolUseResult)));
  assert.equal(end.file, 'C:\\repo\\a.js');
  assert.equal(end.added, 1);
  assert.equal(end.removed, 0);
});

test('foldToolEvents drops an orphan end, stat and all', () => {
  const open = new Map();
  const toolUseResult = { filePath: 'C:\\repo\\a.js', structuredPatch: [{ lines: ['+one'] }] };
  const out = foldToolEvents(open, toolEventsFromLines(resLineWithResult('nope', toolUseResult)));
  assert.deepEqual(out, []);
});

// ---- mcpEventsFromLines / foldMcpEvents (CONCEPT_MCP_DEBUGGER.md safe half) --

/** User line closing one MCP tool call with a specific result payload and
 *  error flag - resLine() above always writes content:'ok', ok:true. */
const mcpResLine = (id, content, isError) =>
  JSON.stringify({
    timestamp: TS,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
    },
  });

test('mcpEventsFromLines splits an mcp__ name into server/tool, non-greedy on the first __', () => {
  const [start] = mcpEventsFromLines(useLine(['t0', 'mcp__codebase-memory-mcp__list_projects', { a: 1 }]));
  assert.deepEqual(start, {
    phase: 'start',
    id: 't0',
    server: 'codebase-memory-mcp',
    tool: 'list_projects',
    input: { a: 1 },
    at: Date.parse(TS),
  });
});

test('mcpEventsFromLines ignores a non-mcp tool_use (toolEventsFromLines already covers those)', () => {
  assert.deepEqual(mcpEventsFromLines(useLine(['t0', 'Bash'])), []);
});

test('mcpEventsFromLines emits every tool_result as an end candidate, mcp or not', () => {
  // No 'mcp__' prefilter on the whole line - a result line never repeats the
  // call's name, so this must not be gated on that substring.
  const events = mcpEventsFromLines(resLine('t0'));
  assert.deepEqual(events, [{ phase: 'end', id: 't0', at: Date.parse(TS), content: 'ok', ok: true }]);
});

test('mcpEventsFromLines reads is_error onto the end candidate', () => {
  const [end] = mcpEventsFromLines(mcpResLine('t0', 'boom', true));
  assert.equal(end.ok, false);
  assert.equal(end.content, 'boom');
});

test('foldMcpEvents pairs a start with the end that closes it, computing latency', () => {
  const open = new Map();
  const text = [useLine(['t0', 'mcp__shadcn__search_items', { q: 'button' }]), mcpResLine('t0', '{"n":3}')].join(
    '\n'
  );
  const out = foldMcpEvents(open, mcpEventsFromLines(text));
  assert.deepEqual(out, [
    { phase: 'start', id: 't0', server: 'shadcn', tool: 'search_items', input: { q: 'button' }, at: Date.parse(TS) },
    {
      phase: 'end',
      id: 't0',
      server: 'shadcn',
      tool: 'search_items',
      input: { q: 'button' },
      at: Date.parse(TS),
      ms: 0, // same fixture timestamp on both lines
      ok: true,
      content: '{"n":3}',
    },
  ]);
  assert.equal(open.size, 0);
});

test('foldMcpEvents keeps a call open ACROSS chunks (starts in one appended fragment, ends in the next)', () => {
  const open = new Map();
  foldMcpEvents(open, mcpEventsFromLines(useLine(['t0', 'mcp__x__y'])));
  assert.equal(open.size, 1);
  const closed = foldMcpEvents(open, mcpEventsFromLines(mcpResLine('t0', 'ok')));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].phase, 'end');
  assert.equal(open.size, 0);
});

test('foldMcpEvents drops a tool_result that closes some other (non-MCP) tool as an orphan', () => {
  const open = new Map();
  // Bash's own tool_result never opened anything in openMcp.
  const out = foldMcpEvents(open, mcpEventsFromLines(resLine('bash-id')));
  assert.deepEqual(out, []);
});

test('foldMcpEvents drops a duplicate start (re-read of the same appended line)', () => {
  const open = new Map();
  const starts = mcpEventsFromLines(useLine(['t0', 'mcp__x__y']));
  assert.equal(foldMcpEvents(open, starts).length, 1);
  assert.equal(foldMcpEvents(open, starts).length, 0);
});

// ---- hasTurnEnd / hasUserPromptStart / isLongTurn (SOUNDS_IMPLEMENTATION_PLAN.md §3) --

const endLine = (reason) =>
  JSON.stringify({ timestamp: TS, message: { role: 'assistant', stop_reason: reason } });

const promptLine = (text) => JSON.stringify({ timestamp: TS, message: { role: 'user', content: text } });

const promptBlocksLine = (...types) =>
  JSON.stringify({
    timestamp: TS,
    message: { role: 'user', content: types.map((type) => ({ type })) },
  });

test('hasTurnEnd is false when stop_reason is tool_use (turn still has a pending tool call)', () => {
  assert.equal(hasTurnEnd(endLine('tool_use')), false);
});

test('hasTurnEnd is true for a terminal stop_reason', () => {
  assert.equal(hasTurnEnd(endLine('end_turn')), true);
});

test('hasTurnEnd is false with no stop_reason at all', () => {
  assert.equal(hasTurnEnd(useLine(['t0', 'Read'])), false);
});

test('hasTurnEnd survives a torn line mid-write', () => {
  assert.equal(hasTurnEnd('{"message":{"stop_reason":"end_'), false);
});

test('hasUserPromptStart is true for a plain string prompt', () => {
  assert.equal(hasUserPromptStart(promptLine('fix the bug')), true);
});

test('hasUserPromptStart is true for a text content block', () => {
  assert.equal(hasUserPromptStart(promptBlocksLine('text')), true);
});

test('hasUserPromptStart is false for a tool_result-only user line (CLI re-injecting tool output)', () => {
  assert.equal(hasUserPromptStart(resLine('t0')), false);
});

test('hasUserPromptStart is true when real text is mixed with a tool_result in one content array', () => {
  const line = JSON.stringify({
    timestamp: TS,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't0', content: 'ok' },
        { type: 'text', text: 'also do X' },
      ],
    },
  });
  assert.equal(hasUserPromptStart(line), true);
});

test('hasUserPromptStart is false for a blank string prompt', () => {
  assert.equal(hasUserPromptStart(promptLine('   ')), false);
});

test('hasUserPromptStart is false for an assistant line', () => {
  assert.equal(hasUserPromptStart(useLine(['t0', 'Read'])), false);
});

test('isLongTurn is false with no observed start (unknown duration)', () => {
  assert.equal(isLongTurn(0, Date.now(), 10), false);
});

test('isLongTurn is false when the turn ran under the threshold', () => {
  const start = 1_000_000;
  assert.equal(isLongTurn(start, start + 5 * 60000, 10), false);
});

test('isLongTurn is true when the turn ran at/over the threshold', () => {
  const start = 1_000_000;
  assert.equal(isLongTurn(start, start + 10 * 60000, 10), true);
});

test('isLongTurn treats a 0-minute threshold as "announce every turn"', () => {
  const start = 1_000_000;
  assert.equal(isLongTurn(start, start + 1, 0), true);
});

test('isLongTurn is false if endedAt is before startedAt (clock oddity)', () => {
  assert.equal(isLongTurn(2000, 1000, 10), false);
});
