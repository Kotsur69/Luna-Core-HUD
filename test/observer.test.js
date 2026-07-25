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
  assert.deepEqual(detectTools('Bash(ls -la)'), ['Bash']);
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
  assert.deepEqual(detectTools('BashOutput(id)'), ['Bash']);
});

test('detectTools deduplikuje powtorzenia', () => {
  assert.deepEqual(detectTools('Read(a) Read(b) Read(c)'), ['Read']);
});

test('detectTools zwraca wiele kafelkow z jednej porcji danych', () => {
  const tiles = detectTools('Read(a) then Bash(ls) then Write(b)');
  assert.deepEqual(tiles.sort(), ['Bash', 'Read', 'Write']);
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
  assert.deepEqual(detectTools('Bash(ls)'), ['Bash']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Bash']);
  assert.deepEqual(detectTools('Bash(ls)'), ['Bash']);
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

test('toolsFromLines maps aliases onto their shared tile', () => {
  assert.deepEqual(toolsFromLines(toolLine('MultiEdit')), ['Edit']);
  assert.deepEqual(toolsFromLines(toolLine('WebSearch')), ['Web']);
});

test('toolsFromLines deduplicates and handles several calls in one line', () => {
  assert.deepEqual(toolsFromLines(toolLine('Read', 'Read', 'Bash')), ['Read', 'Bash']);
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
  assert.deepEqual(toolsFromLines(text), ['Bash']);
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
