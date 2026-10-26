// ============================================================================
// LunaCore - Luna's Work realistic seed data (docs/LUNAS_WORK_PLAN.md B10, LW 2.21a)
// ----------------------------------------------------------------------------
// When design/references/ holds data files (csv / tsv / json / xlsx / pdf -
// real prices, real quotes), the Director schedules a "seed data" card so the
// builders turn them into a seed script + fixtures and the Playtester tests
// real cases (lunasworkAdapters runs the profile's seedCommand first).
//
//   files    referenceDataFiles(repoDir) - the data files, bounded walk, no
//            links followed, nothing outside design/references/
//   change   referencesHash(files) - sha256 over names + bytes; the seed card
//            carries `seed:<hash>`, so a new card is due exactly when no card
//            carries the current hash (no run state needed)
//   guard    scanPii(files) - counts emails, phone numbers and tax ids
//            (NIP / PESEL with checksum, EU VAT numbers). Counts only: the
//            values themselves never leave this module. A file that cannot
//            be read through (a PDF, a broken workbook) counts as possible
//            personal data - the safe side.
//   cards    seedCard / piiCard - lunasworkCritic.applyCards card shape. With
//            personal data the seed card says "fake values only"; copying the
//            real ones is a second card that waits for a decision-queue OK.
//
// Pure apart from reading design/references/. Never throws.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REFERENCES_REL = path.join('design', 'references');
const DATA_EXT_RE = /\.(csv|tsv|json|xlsx|pdf)$/i;
const TEXT_EXT_RE = /\.(csv|tsv|json)$/i;
const MAX_FILES = 200;
const MAX_DEPTH = 3;
// Hashed whole up to this size; a bigger file hashes by name, size and mtime.
const MAX_HASH_BYTES = 50 * 1024 * 1024;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_XLSX_ENTRY_BYTES = 20 * 1024 * 1024;
const HASH_CHARS = 12;
const SEED_TAG_PREFIX = 'seed:';
const PII_TAG_PREFIX = 'seed-pii:';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const posix = (p) => p.split(path.sep).join('/');

// ---- files ----------------------------------------------------------------------------

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * The data files under design/references/, sorted by name. Links (and a
 * linked design/ or references/) are skipped: they could point anywhere.
 * @param {string} repoDir absolute
 * @returns {{name:string, path:string, size:number, mtimeMs:number}[]} name = posix path inside references/
 */
function referenceDataFiles(repoDir) {
  if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir)) return [];
  const root = path.join(path.resolve(repoDir), REFERENCES_REL);
  if (isLink(path.dirname(root)) || isLink(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && depth < MAX_DEPTH) walk(full, depth + 1);
      else if (e.isFile() && DATA_EXT_RE.test(e.name)) {
        try {
          const st = fs.statSync(full);
          out.push({ name: posix(path.relative(root, full)), path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone between readdir and stat: not a reference any more
        }
      }
    }
  };
  walk(root, 1);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Short content hash of the reference files: any added, removed, renamed or
 * edited file changes it.
 * @param {{name:string, path:string, size:number, mtimeMs?:number}[]} files
 * @returns {string|null} HASH_CHARS hex chars, null for no files
 */
function referencesHash(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => isObj(f) && typeof f.name === 'string');
  if (!list.length) return null;
  const h = crypto.createHash('sha256');
  for (const f of list) {
    h.update(`${f.name}\u0000${f.size}\u0000`);
    let body = null;
    try {
      body = f.size <= MAX_HASH_BYTES ? fs.readFileSync(f.path) : null;
    } catch {
      body = null;
    }
    h.update(body || `unread:${f.mtimeMs || 0}`);
    h.update('\u0000');
  }
  return h.digest('hex').slice(0, HASH_CHARS);
}

const seedTag = (hash) => `${SEED_TAG_PREFIX}${hash}`;
const piiTag = (hash) => `${PII_TAG_PREFIX}${hash}`;

// ---- personal data ----------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// +48 600 700 800, (022) 123-45-67, 600700800: 9-15 digits with the usual
// separators. A comma may border one (a CSV cell); a "." or "-" may not (a price, an id).
const PHONE_RE = /(?<![\w.-])(?:\+|00)?\(?\d{2,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w.-])/g;
const VAT_RE = /\b(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)\s?[0-9A-Z]{8,12}\b/g;
const NIP_RE = /(?<!\d)(\d{3}-?\d{3}-?\d{2}-?\d{2}|\d{3}-\d{2}-\d{2}-\d{3})(?!\d)/g;
const PESEL_RE = /(?<!\d)\d{11}(?!\d)/g;

const digitsOf = (s) => s.replace(/\D/g, '');

function nipValid(raw) {
  const d = digitsOf(raw);
  if (d.length !== 10) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((acc, x, i) => acc + x * Number(d[i]), 0);
  return sum % 11 === Number(d[9]);
}

function peselValid(d) {
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = w.reduce((acc, x, i) => acc + x * Number(d[i]), 0);
  return (10 - (sum % 10)) % 10 === Number(d[10]);
}

/** Counts per kind in one text. Phone numbers that are really tax ids or dates are not phones. */
function piiCounts(text) {
  const emails = (text.match(EMAIL_RE) || []).length;
  const nips = (text.match(NIP_RE) || []).filter(nipValid);
  const pesels = (text.match(PESEL_RE) || []).filter(peselValid);
  const vats = (text.match(VAT_RE) || []).filter((v) => /\d{6}/.test(v));
  const taxDigits = new Set([...nips, ...pesels].map(digitsOf));
  const phones = (text.match(PHONE_RE) || []).filter((p) => {
    const d = digitsOf(p);
    return d.length >= 9 && d.length <= 15 && !taxDigits.has(d) && !/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(p.trim());
  }).length;
  return { emails, phones, taxIds: nips.length + pesels.length + vats.length };
}

/**
 * Minimal zip reader: the text of an .xlsx's XML parts (shared strings and
 * sheets). Throws on anything it does not understand - the caller treats
 * that as "could not be checked".
 */
function xlsxText(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(sharedStrings|worksheets\/[^/]+)\.xml$/.test(name)) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    const body = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_XLSX_ENTRY_BYTES });
    parts.push(body.toString('utf8').replace(/<[^>]+>/g, ' '));
  }
  if (!parts.length) throw new Error('no sheets');
  return parts.join('\n');
}

/** The scannable text of one file, or null when it cannot be read through. */
function fileText(file) {
  if (file.size > MAX_SCAN_BYTES) return null;
  const buf = fs.readFileSync(file.path);
  if (TEXT_EXT_RE.test(file.name)) return buf.toString('utf8');
  if (/\.xlsx$/i.test(file.name)) return xlsxText(buf);
  // A PDF's text sits in compressed streams with font-specific encodings: it
  // cannot be checked reliably, so it is never assumed clean.
  return null;
}

/**
 * THE GUARD: which reference files hold (or may hold) personal data.
 * @param {{name:string, path:string, size:number}[]} files referenceDataFiles()
 * @returns {{found:boolean, files:{name:string, emails:number, phones:number, taxIds:number, unchecked:boolean}[]}}
 *   files = only the ones with a hit or that could not be checked
 */
function scanPii(files) {
  const hits = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObj(f) || typeof f.path !== 'string') continue;
    let text = null;
    try {
      text = fileText(f);
    } catch {
      text = null;
    }
    if (text === null) {
      hits.push({ name: f.name, emails: 0, phones: 0, taxIds: 0, unchecked: true });
      continue;
    }
    const c = piiCounts(text);
    if (c.emails || c.phones || c.taxIds) hits.push({ name: f.name, ...c, unchecked: false });
  }
  return { found: hits.length > 0, files: hits };
}

/** "clients.csv: 3 emails, 1 phone number; quote.pdf: could not be checked" - counts only, never values. */
function piiSummary(pii) {
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return (isObj(pii) && Array.isArray(pii.files) ? pii.files : []).map((f) => {
    if (f.unchecked) return `${f.name}: could not be checked`;
    const parts = [
      f.emails ? plural(f.emails, 'email') : '',
      f.phones ? plural(f.phones, 'phone number') : '',
      f.taxIds ? plural(f.taxIds, 'tax id') : '',
    ].filter(Boolean);
    return `${f.name}: ${parts.join(', ')}`;
  }).join('; ');
}

// ---- cards ------------------------------------------------------------------------------

const FAKE_PII_RULE =
  'PERSONAL DATA GUARD: the references hold (or may hold) emails, phone numbers or tax ids. Do NOT copy them into fixtures: replace every one with an obviously fake value (name@example.com, +00 000 000 000, tax id 0000000000). Keep everything else real (names of products, prices, quantities, dates). A separate card asks Mati before real contact data may be used.';

/**
 * The 'seed data' card (lunasworkCritic.applyCards shape, its tag in extraTags).
 * @param {{hash:string, files:{name:string}[], pii:{found:boolean}}} input
 */
function seedCard({ hash, files, pii }) {
  const names = files.map((f) => f.name);
  const shown = names.slice(0, 15).join(', ') + (names.length > 15 ? `, and ${names.length - 15} more` : '');
  const details = [
    `Turn the example data in design/references/ (${shown}) into realistic seed data, so the Playtester tests real cases.`,
    '- Write a seed script (e.g. scripts/seed.js or scripts/seed.py) and the fixtures it loads (e.g. fixtures/*.json), built from the reference files.',
    '- Give every fixture record a readable, unique name (a customer, product or quote name taken from the references). design/TEST_PLAN.md journeys may refer to fixture records by that name.',
    "- The seed must be idempotent (running it twice gives the same data) and run with one command, e.g. `npm run seed`. Name that command in design/ARCHITECTURE.md: Mati sets it as seedCommand in the project profile, and Luna's Work runs it before every playtest.",
    '- Add a test that runs the seed and checks the records are there.',
    ...(pii && pii.found ? ['', FAKE_PII_RULE] : []),
  ].join('\n');
  return {
    kind: 'missing',
    severity: 'high',
    text: `Seed data: fixtures from design/references (${names.length} file${names.length === 1 ? '' : 's'})`,
    details,
    acceptance: [
      'A seed script loads fixtures built from every data file in design/references/',
      'A test runs the seed and checks that the named fixture records exist',
      'Running the seed twice leaves the same data',
    ],
    files: [],
    updatesCardId: null,
    extraTags: [seedTag(hash)],
  };
}

/** The card that may copy the real personal data - scheduled only after a decision-queue OK. */
function piiCard({ hash, pii }) {
  return {
    kind: 'missing',
    severity: 'medium',
    text: 'Seed data: use the real contact and tax data from design/references',
    details: [
      'Mati approved this in the decision queue: the fixtures may use the real emails, phone numbers and tax ids from the reference files instead of the fake values.',
      `Found: ${piiSummary(pii) || 'personal data'}.`,
      'Replace the fake values in the fixtures with the real ones. Never log them, never put them in test names or snapshots.',
    ].join('\n'),
    acceptance: ['The fixtures carry the real values from design/references/', 'No personal data appears in logs, test names or snapshots'],
    files: [],
    updatesCardId: null,
    extraTags: [piiTag(hash)],
  };
}

module.exports = {
  REFERENCES_REL,
  SEED_TAG_PREFIX,
  PII_TAG_PREFIX,
  HASH_CHARS,
  FAKE_PII_RULE,
  referenceDataFiles,
  referencesHash,
  seedTag,
  piiTag,
  scanPii,
  piiSummary,
  seedCard,
  piiCard,
};
