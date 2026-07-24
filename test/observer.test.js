// Testy czystych funkcji Passive Observera (bez I/O, bez PTY).
// TranscriptWatcher celowo NIE jest tu testowany - dotyka systemu plikow.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectTools, encodeProjectDir, usageToMetrics, CONTEXT_LIMIT } = require('../src/observer');

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
