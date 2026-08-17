// Tests for the pure functions extracting text to read aloud (§11.2).
// Zero I/O - works on JSONL fragments, same as the rest of observer.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSpokenText,
  stripMarkdown,
  findTurnEndMessage,
  capLength,
  MAX_SPOKEN_CHARS,
} = require('../src/ttsExtract');

const TS = '2026-08-12T10:00:00.000Z';

const assistantLine = (stopReason, content) =>
  JSON.stringify({ timestamp: TS, message: { role: 'assistant', stop_reason: stopReason, content } });

const textBlock = (text) => ({ type: 'text', text });
const toolUseBlock = (name) => ({ type: 'tool_use', id: 't0', name, input: {} });

// ---- findTurnEndMessage -----------------------------------------------------

test('findTurnEndMessage finds a message with a terminal stop_reason', () => {
  const line = assistantLine('end_turn', [textBlock('done')]);
  const msg = findTurnEndMessage(line);
  assert.equal(msg.stop_reason, 'end_turn');
});

test('findTurnEndMessage ignores stop_reason "tool_use" (turn not actually done)', () => {
  const line = assistantLine('tool_use', [toolUseBlock('Read')]);
  assert.equal(findTurnEndMessage(line), null);
});

test('findTurnEndMessage returns the LAST matching message in a multi-line fragment', () => {
  const text = [assistantLine('end_turn', [textBlock('first')]), assistantLine('end_turn', [textBlock('second')])].join(
    '\n'
  );
  const msg = findTurnEndMessage(text);
  assert.equal(msg.content[0].text, 'second');
});

test('findTurnEndMessage survives a torn line mid-write', () => {
  assert.equal(findTurnEndMessage('{"message":{"stop_reason":"end_'), null);
});

// ---- stripMarkdown ------------------------------------------------------------

test('stripMarkdown drops fenced code blocks entirely', () => {
  const out = stripMarkdown('before\n```js\nconst x = 1;\n```\nafter');
  assert.ok(!out.includes('const x'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('stripMarkdown keeps the text inside inline code spans', () => {
  assert.equal(stripMarkdown('run `npm test` now'), 'run npm test now');
});

test('stripMarkdown keeps link text, drops the URL', () => {
  assert.equal(stripMarkdown('see [the docs](https://example.com)'), 'see the docs');
});

test('stripMarkdown strips header hashes and list/quote markers', () => {
  const out = stripMarkdown('# Title\n- one\n- two\n> quoted');
  assert.equal(out, 'Title\none\ntwo\nquoted');
});

test('stripMarkdown strips bold/italic markers', () => {
  assert.equal(stripMarkdown('**bold** and *italic* and __also bold__'), 'bold and italic and also bold');
});

// ---- capLength ----------------------------------------------------------------

test('capLength leaves short text untouched', () => {
  assert.equal(capLength('short text', 100), 'short text');
});

test('capLength cuts at the last sentence boundary past the halfway point', () => {
  const text = `${'a'.repeat(40)}. ${'b'.repeat(40)}. ${'c'.repeat(40)}.`;
  const out = capLength(text, 60);
  assert.ok(out.endsWith('…'));
  assert.ok(out.includes('a'.repeat(40)));
  assert.ok(!out.includes('c'.repeat(40)));
});

test('capLength hard-cuts when no sentence boundary exists past halfway', () => {
  const text = 'x'.repeat(200);
  const out = capLength(text, 50);
  assert.equal(out.length, 51); // 50 chars + ellipsis
});

// ---- extractSpokenText (end to end) --------------------------------------------

test('extractSpokenText returns "" when no turn-ending message is present', () => {
  assert.equal(extractSpokenText(assistantLine('tool_use', [toolUseBlock('Read')])), '');
});

test('extractSpokenText returns "" when the closing message has no text content', () => {
  assert.equal(extractSpokenText(assistantLine('end_turn', [toolUseBlock('Read')])), '');
});

test('extractSpokenText joins multiple text blocks and strips markdown', () => {
  const line = assistantLine('end_turn', [textBlock('**Done.**'), textBlock('See `file.js`.')]);
  const out = extractSpokenText(line);
  assert.equal(out, 'Done.\n\nSee file.js.');
});

test('extractSpokenText caps pathologically long output at MAX_SPOKEN_CHARS + 1', () => {
  const long = `${'word '.repeat(2000)}.`;
  const line = assistantLine('end_turn', [textBlock(long)]);
  const out = extractSpokenText(line);
  assert.ok(out.length <= MAX_SPOKEN_CHARS + 1);
});
