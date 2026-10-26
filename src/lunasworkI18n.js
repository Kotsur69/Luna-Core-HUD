// ============================================================================
// LunaCore - Luna's Work pl/en completeness (docs/LUNAS_WORK_PLAN.md, B11,
// slice 2.21b)
// ----------------------------------------------------------------------------
// For a project that ships both Polish and English, every key one language
// has must exist - and be non-empty - in the other. Missing keys become
// exactly ONE `bug` card whose repro instruction is a key-parity test. UI
// strings hard-coded in JSX/HTML added by the iteration diff become one
// low-severity `missing` card (a heuristic, so it never blocks anything).
//
// Layouts detected (first hit wins):
//   json        <dir>/pl.json + <dir>/en.json   (locales/, messages/ for
//               next-intl, i18n/, lang/, under the root, src/ or public/)
//   namespaces  <dir>/pl/*.json + <dir>/en/*.json  (i18next resources; the
//               namespace file name prefixes its keys: "common.title")
//   object      one JS/TS file holding a `pl: {...}` and an `en: {...}` map
//               (LunaCore's own src/renderer/i18n.js shape); read by a small
//               literal scanner, never eval'd
// A project with one language or none yields null: the check is skipped.
//
// Cards pass the Critic's trust boundary (validateCritique in
// src/lunasworkCritic.js) and come back tagged run:<id>, kind:<x>, sev:<x>
// and i18n. Nothing is written here - the controller files them.
//
// Exports
//   LANGS            string[]  ['pl', 'en']
//   I18N_TAG         string    'i18n'
//   detectLayout(repoPath:string, {fs?}?) -> Layout|null
//       Layout = {type:'json'|'namespaces'|'object', files:{pl:string[], en:string[]},
//                 keys:{pl:{[key]:string}, en:{[key]:string}}}  (keys flattened "a.b.c")
//       fs: an object with readdirSync(path, {withFileTypes:true}) and
//       readFileSync(path, 'utf8') (default: node's fs). Never throws.
//   flattenKeys(obj:object, prefix?:string) -> {[key]:string}
//       Pure. Nested objects flattened with dots; arrays by index.
//   missingKeys(layout:Layout|null) -> {key:string, missingIn:'pl'|'en', reason:'missing'|'empty'}[]
//       Pure. Sorted by key, then language.
//   hardcodedStrings(diff:string) -> {file:string, line:number, text:string}[]
//       Pure heuristic over a unified diff's added lines in .jsx/.tsx/.html/.vue/.svelte.
//   i18nCards({repoPath, diff?, runId, fs?}) -> {layout:string|null, missing:object[],
//       hardcoded:object[], cards:object[], notes:string[], warnings:object[]}
//       Never throws: any failure yields no cards and one note.
// ============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');
const { runTag, cleanTags } = require('./todorows');
const { validateCritique } = require('./lunasworkCritic');

const LANGS = ['pl', 'en'];
const I18N_TAG = 'i18n';
const MAX_LISTED = 80;
const MAX_NOTE_CHARS = 300;
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const ROOTS = ['', 'src', 'public', 'app', 'assets', 'static'];
const DICT_DIRS = ['locales', 'locale', 'messages', 'i18n', 'lang', 'langs', 'translations'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'release']);
const OBJECT_FILE_RE = /(i18n|locale|translation|localized|messages|lang|strings)[^/\\]*\.(c|m)?(j|t)sx?$/i;
const UI_FILE_RE = /\.(jsx|tsx|html?|vue|svelte)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => String(s === undefined || s === null ? '' : s).slice(0, max);

// ---- reading -----------------------------------------------------------------------

function listDir(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readText(fs, file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return typeof text === 'string' && text.length <= MAX_FILE_BYTES ? text : null;
  } catch {
    return null;
  }
}

function readJson(fs, file) {
  const text = readText(fs, file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pure. Nested objects flattened with dots, arrays by index. Leaf values
 * become strings ('' for null/undefined) so emptiness can be judged.
 */
function flattenKeys(obj, prefix = '') {
  if (!isObj(obj) && !Array.isArray(obj)) return {};
  return Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) || Array.isArray(v)) return { ...acc, ...flattenKeys(v, key) };
    return { ...acc, [key]: v === null || v === undefined ? '' : String(v) };
  }, {});
}

// ---- layout: json and namespaces -----------------------------------------------------

function jsonLayout(fs, dir) {
  const pl = path.join(dir, 'pl.json');
  const en = path.join(dir, 'en.json');
  const plDict = readJson(fs, pl);
  const enDict = readJson(fs, en);
  if (!plDict || !enDict) return null;
  return { type: 'json', files: { pl: [pl], en: [en] }, keys: { pl: flattenKeys(plDict), en: flattenKeys(enDict) } };
}

function namespaceDict(fs, dir) {
  const files = listDir(fs, dir)
    .filter((e) => e.isFile() && /\.json$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const keys = files.reduce((acc, name) => {
    const dict = readJson(fs, path.join(dir, name));
    return dict ? { ...acc, ...flattenKeys(dict, name.replace(/\.json$/i, '')) } : acc;
  }, {});
  return { files: files.map((n) => path.join(dir, n)), keys };
}

function namespacesLayout(fs, dir) {
  const has = (lang) => listDir(fs, dir).some((e) => e.isDirectory() && e.name === lang);
  if (!LANGS.every(has)) return null;
  const pl = namespaceDict(fs, path.join(dir, 'pl'));
  const en = namespaceDict(fs, path.join(dir, 'en'));
  if (!pl.files.length || !en.files.length) return null;
  return { type: 'namespaces', files: { pl: pl.files, en: en.files }, keys: { pl: pl.keys, en: en.keys } };
}

function dictDirLayout(fs, repoPath) {
  for (const root of ROOTS) {
    for (const name of DICT_DIRS) {
      const dir = path.join(repoPath, root, name);
      const hit = jsonLayout(fs, dir) || namespacesLayout(fs, dir);
      if (hit) return hit;
    }
  }
  return null;
}

// ---- layout: a pl/en object map in source ---------------------------------------------

/** Index just past the string literal opening at `i` (quote char at text[i]). */
function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index of the next significant char at or after `i` (skips whitespace and comments). */
function skipBlank(text, i) {
  let j = i;
  for (;;) {
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text.startsWith('//', j)) {
      const end = text.indexOf('\n', j);
      j = end < 0 ? text.length : end + 1;
    } else if (text.startsWith('/*', j)) {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 2;
    } else {
      return j;
    }
  }
}

const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, '$1');

/** Reads a property key at `i`: a quoted string or an identifier. */
function readKey(text, i) {
  if (/['"`]/.test(text[i])) {
    const end = skipString(text, i);
    return { key: unquote(text.slice(i, end)), end };
  }
  const m = /^[A-Za-z_$][\w$-]*/.exec(text.slice(i, i + 200));
  return m ? { key: m[0], end: i + m[0].length } : null;
}

/** Index just past a value that is not an object or a single string (array, call, number...). */
function skipValue(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (/['"`]/.test(ch)) {
      j = skipString(text, j);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return j;
      depth -= 1;
    } else if (ch === ',' && depth === 0) return j;
    j += 1;
  }
  return j;
}

/**
 * Scans an object literal opening at text[i] === '{'. Returns flattened
 * {key: value} (string literals kept; '+'-joined literals concatenated; any
 * other value counts as non-empty) and the index past the closing brace.
 */
function scanObject(text, i, prefix) {
  const out = {};
  let j = i + 1;
  for (;;) {
    j = skipBlank(text, j);
    if (j >= text.length) return { keys: out, end: j };
    if (text[j] === '}') return { keys: out, end: j + 1 };
    if (text[j] === ',') { j += 1; continue; }
    if (text.startsWith('...', j)) { j = skipValue(text, j); continue; }
    const k = readKey(text, j);
    if (!k) { j = skipValue(text, j + 1); continue; }
    j = skipBlank(text, k.end);
    if (text[j] !== ':') { j = skipValue(text, j); continue; }
    j = skipBlank(text, j + 1);
    const key = prefix ? `${prefix}.${k.key}` : k.key;
    if (text[j] === '{') {
      const inner = scanObject(text, j, key);
      Object.assign(out, inner.keys);
      j = inner.end;
      continue;
    }
    const parsed = readStringValue(text, j);
    if (parsed) {
      out[key] = parsed.value;
      j = parsed.end;
      continue;
    }
    const end = skipValue(text, j);
    out[key] = text.slice(j, end).trim() || '';
    j = end;
  }
}

/** A string literal, or literals joined with '+'. null when the value is something else. */
function readStringValue(text, i) {
  if (!/['"`]/.test(text[i])) return null;
  let value = '';
  let j = i;
  for (;;) {
    const end = skipString(text, j);
    value += unquote(text.slice(j, end));
    const next = skipBlank(text, end);
    if (text[next] !== '+') return { value, end: next };
    const after = skipBlank(text, next + 1);
    if (!/['"`]/.test(text[after])) return { value: `${value}?`, end: skipValue(text, after) };
    j = after;
  }
}

/** The `<lang>: {...}` map in a source file, flattened, or null. */
function langMap(text, lang) {
  const re = new RegExp(`(^|[\\s,{(])['"]?${lang}['"]?\\s*:\\s*\\{`, 'g');
  let best = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const { keys } = scanObject(text, open, '');
    if (!best || Object.keys(keys).length > Object.keys(best).length) best = keys;
  }
  return best && Object.keys(best).length ? best : null;
}

function sourceFiles(fs, dir, depth, acc) {
  if (depth > MAX_SCAN_DEPTH || acc.length >= MAX_SCAN_FILES) return acc;
  for (const e of listDir(fs, dir)) {
    if (acc.length >= MAX_SCAN_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) sourceFiles(fs, full, depth + 1, acc);
    } else if (e.isFile() && OBJECT_FILE_RE.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** The source file with the largest pl/en map (a project may hold several, e.g. app + mobile). */
function objectLayout(fs, repoPath) {
  let best = null;
  for (const file of sourceFiles(fs, repoPath, 0, []).sort()) {
    const text = readText(fs, file);
    if (!text || !/\bpl['"]?\s*:\s*\{/.test(text) || !/\ben['"]?\s*:\s*\{/.test(text)) continue;
    const pl = langMap(text, 'pl');
    const en = langMap(text, 'en');
    if (!pl || !en) continue;
    const size = Object.keys(pl).length + Object.keys(en).length;
    if (!best || size > best.size) best = { size, layout: { type: 'object', files: { pl: [file], en: [file] }, keys: { pl, en } } };
  }
  return best ? best.layout : null;
}

/**
 * Detects a pl + en layout. One language or none -> null (skip the check).
 * @param {string} repoPath
 * @param {{fs?:object}} [opts]
 * @returns {object|null}
 */
function detectLayout(repoPath, opts = {}) {
  const fs = isObj(opts) && opts.fs ? opts.fs : nodeFs;
  if (typeof repoPath !== 'string' || !repoPath) return null;
  try {
    return dictDirLayout(fs, repoPath) || objectLayout(fs, repoPath);
  } catch {
    return null;
  }
}

// ---- checks -------------------------------------------------------------------------

/**
 * Pure. Every key of one language must exist and be non-empty in the other.
 * A key empty in BOTH languages is reported for both.
 */
function missingKeys(layout) {
  if (!isObj(layout) || !isObj(layout.keys)) return [];
  const dicts = LANGS.map((l) => (isObj(layout.keys[l]) ? layout.keys[l] : {}));
  const all = [...new Set(dicts.flatMap((d) => Object.keys(d)))].sort();
  return all.flatMap((key) => LANGS.flatMap((lang, i) => {
    const has = Object.prototype.hasOwnProperty.call(dicts[i], key);
    if (!has) return [{ key, missingIn: lang, reason: 'missing' }];
    return String(dicts[i][key]).trim() ? [] : [{ key, missingIn: lang, reason: 'empty' }];
  }));
}

// Text between tags: a word of 2+ letters, no braces (JSX expressions are not
// hard-coded) and no operators, so `a > limit && b < c` is not taken for text.
const TEXT_NODE_RE = />\s*([^<>{}=&|;]*\p{L}{2,}[^<>{}=&|;]*?)\s*</gu;
const ATTR_RE = /\b(placeholder|title|alt|aria-label|label)\s*=\s*"([^"{}]*\p{L}{2,}[^"{}]*)"/gu;
// Lines that already go through a translation helper.
const TRANSLATED_RE = /\bt\(|\bi18n\b|data-i18n|<Trans\b|FormattedMessage|useTranslations|\$t\(/;

/** Added lines per file of a unified diff: [{file, line, text}]. */
function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of String(diff || '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).trim().replace(/^b\//, '');
      file = name === '/dev/null' ? null : name;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line += 1;
    }
  }
  return out;
}

/**
 * Pure heuristic: UI strings hard-coded in JSX/HTML on lines the diff adds.
 * Low severity by design - it flags candidates, it proves nothing.
 */
function hardcodedStrings(diff) {
  const hits = [];
  for (const { file, line, text } of addedLines(diff)) {
    if (!UI_FILE_RE.test(file) || TRANSLATED_RE.test(text) || /^\s*(\/\/|\/?\*|<!--)/.test(text)) continue;
    const found = [...text.matchAll(TEXT_NODE_RE), ...text.matchAll(ATTR_RE)]
      .map((m) => (m[2] !== undefined ? m[2] : m[1]).trim())
      .filter((s) => s && !/^[\w.-]+\.[\w-]+$/.test(s)); // "foo.bar" looks like a key or file
    for (const s of found) hits.push({ file, line, text: clip(s, 120) });
  }
  return hits;
}

// ---- cards --------------------------------------------------------------------------

function listing(items, format) {
  const shown = items.slice(0, MAX_LISTED).map(format);
  const more = items.length - shown.length;
  return more > 0 ? [...shown, `... and ${more} more`] : shown;
}

function missingCard(missing, layout) {
  const files = [...new Set([...layout.files.pl, ...layout.files.en])];
  const lines = listing(missing, (m) => `- ${m.key}: ${m.reason} in ${m.missingIn}`);
  return {
    kind: 'bug',
    severity: 'medium',
    text: `${missing.length} translation key(s) missing or empty in pl/en`,
    details: [
      'Repro test first: write a test asserting key parity - it loads the pl and en dictionaries, flattens nested keys, and asserts both have the same key set with non-empty values. It fails now; add the missing translations until it passes.',
      `Layout: ${layout.type}. Keys:`,
      ...lines,
    ].join('\n'),
    acceptance: [
      'A repro test asserts pl/en key parity (fails before the fix, passes after)',
      'Every listed key exists and is non-empty in both pl and en',
    ],
    files,
  };
}

function hardcodedCard(hardcoded) {
  const lines = listing(hardcoded, (h) => `- ${h.file}:${h.line} "${h.text}"`);
  return {
    kind: 'missing',
    severity: 'low',
    text: `${hardcoded.length} UI string(s) hard-coded instead of translated`,
    details: [
      'Heuristic check: these strings were added in JSX/HTML without the translation helper. Move each into the pl and en dictionaries, or ignore it when it is not user-facing text.',
      ...lines,
    ].join('\n'),
    acceptance: ['Each listed user-facing string comes from the pl/en dictionaries'],
    files: [...new Set(hardcoded.map((h) => h.file))],
  };
}

/** Runs cards through the Critic's trust boundary and tags them. */
function validated(raw, tag) {
  const critique = validateCritique(
    { cards: raw, logEntry: {}, architecture: '', decisions: [], newJourneys: [], verdict: 'CONTINUE' },
    { ideasAllowed: false, allPassed: false },
  );
  const cards = critique.cards.map((c) => ({
    ...c,
    tags: cleanTags([tag, `kind:${c.kind}`, `sev:${c.severity}`, I18N_TAG]),
    // lunasworkCritic.applyCards adds run/kind/sev itself and keeps these.
    extraTags: [I18N_TAG],
  }));
  return { cards, warnings: critique.warnings };
}

/**
 * The B11 check for one iteration. Never throws.
 * @param {{repoPath:string, diff?:string, runId:string, fs?:object}} opts
 */
function i18nCards(opts) {
  const o = isObj(opts) ? opts : {};
  const empty = (notes) => ({ layout: null, missing: [], hardcoded: [], cards: [], notes, warnings: [] });
  try {
    const tag = runTag(o.runId);
    if (!tag) return empty(['i18n check failed: badRunId']);
    const layout = detectLayout(o.repoPath, { fs: o.fs });
    if (!layout) return empty([]);
    const missing = missingKeys(layout);
    const hardcoded = hardcodedStrings(o.diff);
    const raw = [
      ...(missing.length ? [missingCard(missing, layout)] : []),
      ...(hardcoded.length ? [hardcodedCard(hardcoded)] : []),
    ];
    const { cards, warnings } = validated(raw, tag);
    return { layout: layout.type, missing, hardcoded, cards, notes: [], warnings };
  } catch (err) {
    return empty([`i18n check failed: ${clip(err && err.message, MAX_NOTE_CHARS)}`]);
  }
}

module.exports = {
  LANGS,
  I18N_TAG,
  detectLayout,
  flattenKeys,
  missingKeys,
  hardcodedStrings,
  i18nCards,
};
