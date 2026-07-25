// Testy czystych funkcji Passive Observera (bez I/O, bez PTY).
// TranscriptWatcher celowo NIE jest tu testowany - dotyka systemu plikow.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectTools,
  encodeProjectDir,
  usageToMetrics,
  sumUsageLines,
  sumUsageByModel,
  toolsFromLines,
  toolEventsFromLines,
  foldToolEvents,
  CONTEXT_LIMIT,
} = require('../src/observer');

// ---- usageToMetrics ---------------------------------------------------------

test('usageToMetrics sumuje input + oba rodzaje cache', () => {
  const m = usageToMetrics({
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 1000,
  });
  assert.equal(m.tokens, 2000);
  assert.equal(m.limit, CONTEXT_LIMIT);
  assert.equal(m.percent, 2000 / CONTEXT_LIMIT);
});

test('usageToMetrics traktuje brakujace pola jako zero', () => {
  assert.equal(usageToMetrics({}).tokens, 0);
  assert.equal(usageToMetrics({}).percent, 0);
  assert.equal(usageToMetrics({ input_tokens: 5 }).tokens, 5);
});

test('usageToMetrics awansuje okno zamiast przypinac pasek do 100% (B2)', () => {
  // Dawniej limit byl stala 200k, wiec 600k tokenow dawalo martwe 100%.
  // Teraz sama obserwacja dowodzi, ze okno jest wieksze.
  const m = usageToMetrics({ input_tokens: 600000 });
  assert.equal(m.limit, 1000000);
  assert.equal(m.percent, 0.6);
});

test('usageToMetrics nadal przycina percent do 1 powyzej najwiekszego znanego okna', () => {
  const m = usageToMetrics({ input_tokens: 5000000 });
  assert.equal(m.percent, 1);
  // tokens zostaja surowe - przycinamy tylko to, co rysuje pasek.
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

test('usageToMetrics bez modelu zachowuje domyslne okno 200k', () => {
  const m = usageToMetrics({ input_tokens: 1000 });
  assert.equal(m.limit, CONTEXT_LIMIT);
  assert.equal(m.modelLabel, '');
});

// ---- encodeProjectDir -------------------------------------------------------
// To jest sedno wielosesyjnosci: zla nazwa katalogu = metryki cudzej sesji.

test('encodeProjectDir zamienia kazdy znak niealfanumeryczny na mysinik', () => {
  assert.equal(encodeProjectDir('C:\\Users\\mmazur\\.local\\bin'), 'C--Users-mmazur--local-bin');
});

test('encodeProjectDir radzi sobie ze sciezka POSIX', () => {
  assert.equal(encodeProjectDir('/home/mati/repos/Luna-Core-HUD'), '-home-mati-repos-Luna-Core-HUD');
});

test('encodeProjectDir nie wywraca sie na pustym/niepoprawnym wejsciu', () => {
  assert.equal(encodeProjectDir(''), '');
  assert.equal(encodeProjectDir(null), '');
  assert.equal(encodeProjectDir(undefined), '');
});

// ---- detectTools ------------------------------------------------------------

test('detectTools wykrywa narzedzie w surowym stdout', () => {
  assert.deepEqual(detectTools('Bash(ls -la)'), ['Shell']);
});

test('detectTools zdejmuje sekwencje ANSI przed dopasowaniem', () => {
  // Tak wyglada realny strumien z TUI - nazwa narzedzia jest pokolorowana.
  assert.deepEqual(detectTools('\x1b[32mGrep(wzor)'), ['Grep']);
  assert.deepEqual(detectTools('\x1b[1m\x1b[38;5;208mRead(plik.js)'), ['Read']);
});

test('detectTools mapuje aliasy na wspolny kafelek', () => {
  assert.deepEqual(detectTools('MultiEdit(a)'), ['Edit']);
  assert.deepEqual(detectTools('NotebookEdit(a)'), ['Edit']);
  assert.deepEqual(detectTools('WebFetch(url)'), ['Web']);
  assert.deepEqual(detectTools('WebSearch(q)'), ['Web']);
  assert.deepEqual(detectTools('BashOutput(id)'), ['Shell']);
});

test('detectTools deduplikuje powtorzenia', () => {
  assert.deepEqual(detectTools('Read(a) Read(b) Read(c)'), ['Read']);
});

test('detectTools zwraca wiele kafelkow z jednej porcji danych', () => {
  const tiles = detectTools('Read(a) then Bash(ls) then Write(b)');
  assert.deepEqual(tiles.sort(), ['Read', 'Shell', 'Write']);
});

test('detectTools wymaga nawiasu - sama nazwa w zdaniu nie zapala kafelka', () => {
  assert.deepEqual(detectTools('I will read the file and write a summary'), []);
  assert.deepEqual(detectTools('Bash'), []);
});

test('detectTools nie wywraca sie na pustym wejsciu', () => {
  assert.deepEqual(detectTools(''), []);
  assert.deepEqual(detectTools(null), []);
});

test('detectTools jest odporny na powtorne wywolania (regex /g ma stan)', () => {
  // TOOL_RE zyje na poziomie modulu - bez resetu lastIndex drugie wywolanie
  // gubiloby trafienia. Ten test pilnuje wlasnie tego.
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Shell']);
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

/** Assistant line opening one or more tool calls, as the CLI writes them. */
const useLine = (...pairs) =>
  JSON.stringify({
    timestamp: TS,
    message: {
      role: 'assistant',
      content: pairs.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })),
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
  assert.deepEqual(out, [{ phase: 'start', id: 't0', tile: 'Edit', at: Date.parse(TS) }]);

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
  assert.deepEqual([...open.values()], ['Edit', 'Edit']);

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
