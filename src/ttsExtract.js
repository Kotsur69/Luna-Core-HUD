// ============================================================================
// LunaCore - spoken-text extraction for the read-output-aloud feature (§11.2)
// ----------------------------------------------------------------------------
// Turns a JSONL transcript fragment into the prose worth speaking aloud.
// Mirrors observer.js's hasTurnEnd() line-scan exactly (same "stop_reason"
// check, same "not tool_use" condition) but keeps the message instead of a
// boolean - same fragment TranscriptWatcher already tails for turn-end
// detection, no new file I/O.
//
// ZERO EXTRA TOKENS: this is plain regex/string stripping, never a
// "summarize this turn" model call - see SOUNDS_IMPLEMENTATION_PLAN.md
// #11.2. Whatever comes out is a pure substring of what Claude already
// wrote; no rephrasing, no LLM-in-the-loop.
// ============================================================================

'use strict';

// Hard cap on spoken length. Not from the plan doc - added so a huge turn
// cannot queue the narration channel indefinitely; the bar is "understandable
// TTS reading Claude's own words", not "read every character no matter how
// long", and there is no way to skip ahead once SAPI starts speaking.
const MAX_SPOKEN_CHARS = 1500;

/**
 * Finds the LAST assistant message in `text` whose turn is fully done
 * (stop_reason present and not "tool_use") - same signal as
 * observer.js's hasTurnEnd(), kept as the object instead of a boolean.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {object|null} the message object, or null if none found
 */
function findTurnEndMessage(text) {
  let found = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"stop_reason"')) continue;
    try {
      const obj = JSON.parse(line);
      const message = obj && obj.message;
      const reason = message && message.stop_reason;
      if (reason && reason !== 'tool_use') found = message;
    } catch {
      /* incomplete line - skip */
    }
  }
  return found;
}

/**
 * Concatenates the `type: 'text'` content blocks of an assistant message.
 * tool_use/thinking blocks are skipped - narrating a tool call's raw args
 * would be unlistenable.
 * @param {object} message
 * @returns {string}
 */
function textBlocks(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n');
}

/**
 * Strips markdown syntax down to plain prose. Pure string ops, no
 * rephrasing - fenced code blocks are dropped entirely (unlistenable);
 * everything else keeps its inner text.
 * @param {string} raw
 * @returns {string}
 */
function stripMarkdown(raw) {
  return String(raw || '')
    // fenced code blocks, including the language tag
    .replace(/```[\s\S]*?```/g, ' ')
    // inline code spans - keep the text inside the backticks
    .replace(/`([^`]+)`/g, '$1')
    // markdown links [text](url) - keep just the text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // headers, blockquotes, list markers at line start
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // bold/italic markers (order matters: *** before ** before *)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // horizontal rules
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
    // collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Hard-caps text at MAX_SPOKEN_CHARS, cutting at the nearest earlier sentence
 * boundary when one exists past the halfway point - a mid-word cut is worse
 * to listen to than a slightly early one.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function capLength(text, max = MAX_SPOKEN_CHARS) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  const cut = lastStop > max * 0.5 ? slice.slice(0, lastStop + 1) : slice;
  return `${cut.trim()}…`;
}

/**
 * Extracts the prose worth speaking aloud from a JSONL transcript fragment.
 * @param {string} text fragment of the JSONL file (whole lines)
 * @returns {string} '' when the fragment has no closing assistant message,
 *   or that message has no text content (e.g. a turn that only ran tools).
 */
function extractSpokenText(text) {
  const message = findTurnEndMessage(text);
  if (!message) return '';
  const prose = stripMarkdown(textBlocks(message));
  if (!prose) return '';
  return capLength(prose);
}

module.exports = { extractSpokenText, stripMarkdown, findTurnEndMessage, capLength, MAX_SPOKEN_CHARS };
