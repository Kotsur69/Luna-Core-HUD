// ============================================================================
// LunaCore - Prompt library (§5.5 shortlist, priority #1)
// ----------------------------------------------------------------------------
// The same idea as cheat-sheets (7C), but for MULTI-LINE, reusable prompts.
// Loads config/prompts.json (+ an optional, gitignored override
// config/prompts.local.json for private prompts).
//
// Prompt format:
//   { "label": "Button name", "text": "prompt\ncontent", "note": "description" }
// The `text` field may also be an array of lines - we join it with "\n" (more
// readable in JSON).
//
// Validation at the boundary: groups/prompts missing required fields are
// rejected. An empty or broken config => an empty list (the section simply
// shows nothing).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText, mergeKey, isLocalized, LANGS } = require('./localized');

// The shipped prompts are read from the bundled directory; the private ones
// (gitignored) live in the WRITABLE directory and are resolved lazily, since
// this module is required before app.whenReady(). Details in paths.js.
const BASE_FILE = paths.bundled('prompts.json');
const localFile = () => paths.local('prompts.local.json');

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validates a single prompt. Returns { label, text, note } or null.
 * `text` accepts a string or an array of lines (more convenient to write in JSON).
 */
function normalizePrompt(p) {
  if (!p || typeof p !== 'object') return null;

  // normalizeText() joins an array of lines into a string - separately for each
  // language when the content is localized. The renderer picks the language later.
  const text = normalizeText(p.text);
  if (!text) return null;

  const label = hasText(p.label) ? normalizeText(p.label) : fallbackLabel(text);
  const note = hasText(p.note) ? normalizeText(p.note) : '';
  return { label, text, note };
}

/**
 * Fallback label when a prompt has none: the start of its content. For
 * localized content we truncate PER LANGUAGE - otherwise the EN button would
 * show the Polish start of the prompt.
 */
function fallbackLabel(text) {
  if (!isLocalized(text)) return text.slice(0, 40);
  const out = {};
  for (const l of LANGS) {
    if (typeof text[l] === 'string') out[l] = text[l].slice(0, 40);
  }
  return out;
}

/** Validates a group. Returns { title, note, prompts } or null (when there are no prompts). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (!hasText(g.title)) return null;
  const prompts = Array.isArray(g.prompts)
    ? g.prompts.map(normalizePrompt).filter(Boolean)
    : [];
  if (prompts.length === 0) return null;
  const note = hasText(g.note) ? normalizeText(g.note) : '';
  return { title: normalizeText(g.title), note, prompts };
}

/**
 * Loads prompt groups: base merged with local (local overrides base by title,
 * extra groups are appended at the end).
 * @returns {{groups: Array<{title:string,note:string,prompts:Array}>}}
 */
function loadPrompts() {
  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.groups)) return;
    for (const raw of src.groups) {
      const g = normalizeGroup(raw);
      // See the comment in src/cheatsheets.js: a localized title is an object,
      // so the merge key must be a string.
      if (g) byTitle.set(mergeKey(g.title), g);
    }
  };
  collect(readJson(BASE_FILE));
  collect(readJson(localFile()));

  return { groups: [...byTitle.values()] };
}

module.exports = { loadPrompts };
