// ============================================================================
// LunaCore - Luna's Work asset licenses: the rules, the ledger, the credits
// ----------------------------------------------------------------------------
// Every file of a game under Assets/**/Art/ needs a row in the game repo's
// design/ASSET_LICENSES.md (name, source URL, author, license, path). The
// asset tools write the rows themselves (src/lunasworkFreeAssets.js for
// library assets, src/lunasworkAssetPipeline.js for generated ones); the
// Critic files a card for any art file without one (ledgerCards).
//
//   license    classifyLicense: CC0, CC-BY (any version), an explicit
//              free-for-commercial license or the named BlenderKit Royalty
//              Free license pass; NC, ND, SA, Sampling+,
//              editorial, GPL and anything unknown are refused with the reason
//   rips       ripReason: a search result whose title or tags name a
//              commercial game (or say it was ripped) is refused. The art
//              references of a game (Katana Zero, Zenless Zone Zero,
//              Kurumi, Black Rock Shooter) are references, never sources
//   ledger     parseLedger / withLedgerRows: the markdown table, created with
//              its header when missing; a row for a path already listed is
//              replaced, never doubled
//   credits    creditsText: the CC-BY rows as the in-game credits list
//              (CREDITS_FILE, rewritten from the ledger on every change)
//   critic     unledgeredArt / ledgerCards: art files no ledger row covers
//
// Pure, except unledgeredArt (a read-only walk of Assets/ that never follows
// a link). The ledger is written by the callers through their guarded repo
// writer, one write at a time per repo (withLedgerLock).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_FILE = 'design/ASSET_LICENSES.md';
// StreamingAssets ships with the build as-is, so the game can read the list at runtime.
const CREDITS_FILE = 'Assets/StreamingAssets/CREDITS.txt';
const LEDGER_TITLES = Object.freeze(['Name', 'Source URL', 'Author', 'License', 'Path']);
const LEDGER_KEYS = Object.freeze(['name', 'source', 'author', 'license', 'path']);
const LEDGER_HEADER = [
  '# Asset licenses',
  '',
  'One row per asset under Assets/**/Art/. LunaCore\'s asset tools add the rows; add one by hand for anything else.',
  `Allowed: CC0, CC-BY or an explicit free-for-commercial license. CC-BY rows feed the in-game credits (${CREDITS_FILE}).`,
  'Never assets ripped from existing games: the games named in the art direction are references, not sources.',
  '',
].join('\n');
// What a generated asset's row says: it is this project's own work.
const GENERATED_LICENSE = 'Own work (generated)';
const FREE_COMMERCIAL = 'Free for commercial use';
// BlenderKit's royalty-free license, as src/lunasworkFreeSources.js names it:
// commercial use without credit, sale of higher-level derivative works (a
// game) allowed, resale of the asset itself barred (blenderkit.com/docs/licenses).
const BLENDERKIT_ROYALTY_FREE = 'BlenderKit Royalty Free';

const MAX_CELL_CHARS = 300;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20000;
const MAX_WALK_DEPTH = 16;
const MAX_LISTED_FILES = 25;
const LEDGER_CARD_HEAD = 'Asset license:';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);

// ---- licenses -------------------------------------------------------------------------

/** Lower case, accents dropped, every run of other characters one space, padded: " cc by 4 0 ". */
function normalized(text) {
  return ` ${String(text == null ? '' : text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

const has = (norm, words) => words.some((w) => norm.includes(` ${w} `));

// Checked FIRST, before any allowed form: "CC BY-NC 4.0" contains "by" too.
const REFUSED_TERMS = Object.freeze([
  { words: ['nc', 'noncommercial', 'non commercial', 'no commercial', 'personal use', 'personal'], reason: 'non-commercial (NC) / personal-use license' },
  { words: ['nd', 'noderivs', 'noderivatives', 'no derivatives', 'no derivs'], reason: 'no-derivatives (ND) license' },
  { words: ['sa', 'sharealike', 'share alike'], reason: 'share-alike (SA) license, not on the allowed list (CC0, CC-BY, free for commercial use)' },
  { words: ['sampling', 'sampling plus'], reason: 'Sampling+ license' },
  { words: ['editorial'], reason: 'editorial-only license' },
  { words: ['gpl', 'lgpl', 'agpl'], reason: 'GPL license, not on the allowed list' },
]);
// The allowed forms, matched against the WHOLE normalized text: free text that
// merely contains "attribution" ("Attribution, personal use only") is not CC-BY.
const CC0_RE = /^ (?:cc0(?: 1 0)?(?: universal)?|cc0 public domain|cc zero|creative commons 0|creative commons zero(?: 1 0)?|https? (?:www )?creativecommons org publicdomain zero 1 0(?: legalcode)?) $/;
const CC_BY_RE = /^ (?:(?:cc )?by|cc attribution|(?:creative commons )?attribution|https? (?:www )?creativecommons org licenses by)(?: (\d) (\d))?(?: international| legalcode| deed en)? $/;

/**
 * Whether an asset's license allows it in the game.
 * @param {unknown} raw a license name, slug or URL as the source states it
 * @param {{library?:boolean}} [opts] library: the text came from a library API, so
 *   LunaCore's own labels (generated, free for commercial use) are not taken from it
 * @returns {{ok:true, license:string, attribution:boolean}|{ok:false, reason:string}}
 */
function classifyLicense(raw, opts = {}) {
  const text = oneLine(raw, MAX_CELL_CHARS);
  const quoted = `"${text.slice(0, 60)}"`;
  if (!text) return { ok: false, reason: 'refused: no license stated' };
  if (opts.library !== true && text === GENERATED_LICENSE) return { ok: true, license: GENERATED_LICENSE, attribution: false };
  if (opts.library !== true && text === FREE_COMMERCIAL) return { ok: true, license: FREE_COMMERCIAL, attribution: false };
  // A named, checked library license: allowed from library text too (exact match only).
  if (text === BLENDERKIT_ROYALTY_FREE) return { ok: true, license: BLENDERKIT_ROYALTY_FREE, attribution: false };
  const norm = normalized(text);
  for (const term of REFUSED_TERMS) if (has(norm, term.words)) return { ok: false, reason: `refused: ${term.reason} (${quoted})` };
  if (CC0_RE.test(norm)) return { ok: true, license: 'CC0', attribution: false };
  const m = norm.match(CC_BY_RE);
  if (m) return { ok: true, license: `CC-BY${m[1] ? ` ${m[1]}.${m[2]}` : ''}`, attribution: true };
  return { ok: false, reason: `refused: license not on the allowed list (CC0, CC-BY, free for commercial use): ${quoted}` };
}

// ---- rips -----------------------------------------------------------------------------

// The art references of the current game first, then commercial games and
// franchises that fan rips are commonly taken from. Whole words only; names
// that are also everyday words (halo, portal, celeste, hades, doom) are left
// out on purpose, so a "halo" VFX is not refused.
const REFERENCE_GAMES = Object.freeze(['katana zero', 'zenless zone zero', 'zzz', 'kurumi', 'tokisaki', 'date a live', 'black rock shooter']);
const COMMERCIAL_GAMES = Object.freeze([
  'genshin', 'genshin impact', 'honkai', 'star rail', 'wuthering waves', 'arknights', 'blue archive', 'nikke', 'azur lane',
  'fate grand order', 'final fantasy', 'kingdom hearts', 'persona 5', 'nier automata', 'devil may cry', 'bayonetta',
  'metal gear', 'resident evil', 'monster hunter', 'street fighter', 'tekken', 'mortal kombat', 'guilty gear', 'dark souls',
  'elden ring', 'bloodborne', 'sekiro', 'zelda', 'super mario', 'mario kart', 'pokemon', 'metroid', 'splatoon', 'smash bros',
  'sonic the hedgehog', 'overwatch', 'valorant', 'league of legends', 'fortnite', 'apex legends', 'call of duty',
  'gears of war', 'minecraft', 'roblox', 'world of warcraft', 'starcraft', 'hollow knight', 'cuphead', 'undertale',
  'touhou', 'team fortress', 'half life', 'counter strike', 'dota', 'grand theft auto', 'gta v', 'the witcher',
  'cyberpunk 2077', 'skyrim', 'fallout 4', 'fallout new vegas', 'god of war', 'the last of us', 'hatsune miku',
]);
// Words that say the asset was taken out of a game, whatever the game.
const RIP_TERMS = Object.freeze(['ripped', 'rip from', 'game rip', 'model rip', 'ripped from', 'extracted from', 'xnalara', 'xps', 'game ripped']);

/**
 * Why a search result must not be used: its title, tags or description name a
 * commercial game or say it was ripped. Null when nothing matched. Best effort:
 * a rip under a neutral title and tags is not caught here.
 * @param {{name?:string, tags?:string[], description?:string}} item
 * @returns {string|null}
 */
function ripReason(item) {
  const i = isObj(item) ? item : {};
  const tags = Array.isArray(i.tags) ? i.tags.slice(0, 100).map((t) => oneLine(t, 80)) : [];
  // Each field on its own: the tags "katana" and "zero gravity" must not read as "katana zero".
  const fields = [oneLine(i.name, 300), oneLine(i.description, 2000), ...tags].map(normalized);
  const named = (words) => words.find((w) => fields.some((f) => f.includes(` ${w} `)));
  const reference = named(REFERENCE_GAMES);
  if (reference) return `refused: "${reference}" is an art reference of this game, never a source (no fan rips of commercial games)`;
  const game = named(COMMERCIAL_GAMES);
  if (game) return `refused: "${game}" names a commercial game - likely a fan rip, never a source`;
  const rip = named(RIP_TERMS);
  if (rip) return `refused: "${rip}" - assets ripped from games are never a source`;
  return null;
}

// ---- the ledger -----------------------------------------------------------------------

/** "| a | b \| c |" -> ['a', 'b | c'] */
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
// Text from a library API: no markdown links / images, no HTML or rich-text tags
// (the credits file may be shown with TextMeshPro rich text), pipes escaped.
const plainText = (v, max) => oneLine(v, max).replace(/[<>[\]`!]/g, '');
const cell = (v) => plainText(v, MAX_CELL_CHARS).replace(/\|/g, '\\|');
const cleanPath = (p) => oneLine(p, MAX_CELL_CHARS).replace(/\\/g, '/').replace(/^`|`$/g, '').replace(/^\.\//, '');

/** Column index per ledger key, from the header cells; null when it is not the ledger's table. */
function ledgerColumns(cells) {
  const lower = cells.map((c) => c.toLowerCase());
  const map = {};
  LEDGER_TITLES.forEach((title, i) => {
    const at = lower.indexOf(title.toLowerCase());
    if (at >= 0) map[LEDGER_KEYS[i]] = at;
  });
  return map.path === undefined || map.name === undefined ? null : map;
}

/**
 * The ledger table of ASSET_LICENSES.md. `entries` keeps every table line, with
 * its cells and (when it has a path) its row, so a rewrite keeps hand-written
 * columns and rows.
 * @returns {{rows:{name:string, source:string, author:string, license:string, path:string}[],
 *   lines:string[], eol:string, table:{start:number, end:number, map:object, width:number,
 *   entries:{line:string, cells:string[], row:object|null}[]}|null}}
 */
function parseLedger(md) {
  const text = typeof md === 'string' ? md : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !isSeparator(lines[i + 1])) continue;
    const header = splitRow(lines[i]);
    const map = ledgerColumns(header);
    if (!map) continue;
    let end = i + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    const entries = lines.slice(i + 2, end).map((line) => {
      const cells = splitRow(line);
      const get = (k) => (map[k] === undefined ? '' : oneLine(cells[map[k]], MAX_CELL_CHARS));
      const row = { name: get('name'), source: get('source'), author: get('author'), license: get('license'), path: cleanPath(get('path')) };
      return { line, cells, row: row.path ? row : null };
    });
    return { rows: entries.map((e) => e.row).filter(Boolean), lines, eol, table: { start: i, end, map, width: header.length, entries } };
  }
  return { rows: [], lines, eol, table: null };
}

/**
 * The ledger row that describes `rel` itself: its own row, else the deepest
 * folder row above it (a path that `rel` continues with "/", as isCovered
 * reads it). A same-stem row is not taken: it describes a file made from
 * `rel`, not where `rel` came from.
 * @param {{path:string}[]} rows parseLedger(...).rows
 * @param {string} rel repo-relative posix path
 * @returns {object|null}
 */
function ledgerRowFor(rows, rel) {
  const want = cleanPath(rel);
  if (!want) return null;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => isObj(r) && typeof r.path === 'string' && r.path);
  const own = list.find((r) => r.path === want);
  if (own) return own;
  const folders = list.filter((r) => want.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`));
  return folders.reduce((best, r) => (!best || r.path.length > best.path.length ? r : best), null);
}

/** One row in the table's own column order; columns LunaCore does not know keep `base`'s cells. */
function formatRow(r, map, width, base = []) {
  const cells = Array.from({ length: width }, (_, i) => cell(base[i]));
  for (const k of LEDGER_KEYS) if (map[k] !== undefined) cells[map[k]] = cell(k === 'path' ? cleanPath(r[k]) : r[k]);
  return `| ${cells.join(' | ')} |`;
}

const DEFAULT_MAP = Object.freeze(Object.fromEntries(LEDGER_KEYS.map((k, i) => [k, i])));

/**
 * ASSET_LICENSES.md with `rows` added. A row whose path is listed already is
 * replaced in place; every other line of the table (rows without a path,
 * columns LunaCore does not know) and the text around it is kept as written.
 * A file without the table gets the header and a new table.
 * @param {string|null} md the current file, null when there is none
 * @param {{name:string, source:string, author:string, license:string, path:string}[]} rows
 * @returns {string}
 */
function withLedgerRows(md, rows) {
  const parsed = parseLedger(md || '');
  const fresh = (Array.isArray(rows) ? rows : []).filter((r) => isObj(r) && cleanPath(r.path));
  const byPath = new Map(fresh.map((r) => [cleanPath(r.path), r]));
  if (!parsed.table) {
    const table = [`| ${LEDGER_TITLES.join(' | ')} |`, `|${LEDGER_TITLES.map(() => '---').join('|')}|`, ...[...byPath.values()].map((r) => formatRow(r, DEFAULT_MAP, LEDGER_KEYS.length))];
    const base = (md || '').replace(/\r\n/g, '\n').replace(/\s*$/, '');
    return `${base ? `${base}\n\n` : LEDGER_HEADER}${table.join('\n')}\n`.replace(/\n/g, parsed.eol);
  }
  const { start, end, map, width, entries } = parsed.table;
  const placed = new Set();
  const body = entries.map((e) => {
    const next = e.row && byPath.get(e.row.path);
    if (!next) return e.line;
    // A second row of a replaced path would keep its stale license (and credit): it goes.
    if (placed.has(e.row.path)) return null;
    placed.add(e.row.path);
    return formatRow(next, map, width, e.cells);
  }).filter((line) => line !== null);
  const added = [...byPath.entries()].filter(([p]) => !placed.has(p)).map(([, r]) => formatRow(r, map, width));
  return [...parsed.lines.slice(0, start + 2), ...body, ...added, ...parsed.lines.slice(end)].join(parsed.eol);
}

// One ledger write at a time per repo: two imports must not lose each other's row.
const ledgerQueues = new Map();

/**
 * Runs `fn` after every earlier ledger update of the same repo has settled.
 * @template T
 * @param {string} key the repo path
 * @param {()=>Promise<T>|T} fn
 * @returns {Promise<T>}
 */
function withLedgerLock(key, fn) {
  const prev = ledgerQueues.get(key) || Promise.resolve();
  const next = prev.then(() => fn());
  const settled = next.then(() => {}, () => {});
  ledgerQueues.set(key, settled);
  settled.then(() => {
    if (ledgerQueues.get(key) === settled) ledgerQueues.delete(key);
  });
  return next;
}

// ---- credits --------------------------------------------------------------------------

/**
 * The in-game credits list: one line per CC-BY row of the ledger. Null when
 * the ledger has none.
 * @param {{name:string, source:string, author:string, license:string}[]} rows
 * @returns {string|null}
 */
function creditsText(rows) {
  const lines = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const lic = isObj(r) ? classifyLicense(r.license) : { ok: false };
    if (!lic.ok || !lic.attribution) continue;
    const line = `"${plainText(r.name, 120) || 'Untitled'}" by ${plainText(r.author, 120) || 'unknown author'} - ${lic.license}${r.source ? ` - ${plainText(r.source, 300)}` : ''}`;
    if (!lines.includes(line)) lines.push(line);
  }
  if (!lines.length) return null;
  return ['Third-party assets', `Generated by LunaCore from ${LEDGER_FILE}; edit the ledger, not this file.`, '', ...lines, ''].join('\n');
}

// ---- unledgered art (Critic) ----------------------------------------------------------

const stemOf = (p) => p.replace(/\.[^./]+$/, '');

/** True when a ledger path covers `rel`: the same file, a listed folder, or the same stem (prefab / material made from it). */
function isCovered(rel, ledgerPaths) {
  return ledgerPaths.some((p) => {
    if (!p) return false;
    if (p === rel || rel.startsWith(p.endsWith('/') ? p : `${p}/`)) return true;
    return !p.endsWith('/') && stemOf(p) === stemOf(rel);
  });
}

/**
 * Repo-relative files under Assets/ with an Art folder in their path; never
 * through a link. truncated: the walk hit its depth or entry cap, so files may
 * be missing from the list.
 * @returns {{files:string[], truncated:boolean}}
 */
function scanArt(repoDir) {
  const root = path.resolve(repoDir);
  const out = [];
  let seen = 0;
  let truncated = false;
  const walk = (dir, rel, depth, inArt) => {
    if (depth > MAX_WALK_DEPTH || seen > MAX_WALK_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable folder is skipped; the rest is still checked
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      seen += 1;
      if (seen > MAX_WALK_ENTRIES) {
        truncated = true;
        break;
      }
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel, depth + 1, inArt || e.name.toLowerCase() === 'art');
      else if (e.isFile() && inArt && !e.name.endsWith('.meta')) out.push(childRel);
    }
  };
  try {
    if (!fs.lstatSync(path.join(root, 'Assets')).isDirectory()) return { files: [], truncated: false };
  } catch {
    return { files: [], truncated: false };
  }
  walk(path.join(root, 'Assets'), 'Assets', 0, false);
  return { files: out, truncated };
}

/** The art files scanArt found (see there). */
const artFiles = (repoDir) => scanArt(repoDir).files;

/** The ledger's rows, read from the repo (capped); [] when there is no ledger. */
function readLedgerRows(repoDir) {
  const abs = path.join(path.resolve(repoDir), ...LEDGER_FILE.split('/'));
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > MAX_LEDGER_BYTES) return [];
    return parseLedger(fs.readFileSync(abs, 'utf8')).rows;
  } catch {
    return [];
  }
}

/**
 * Art files of a Unity repo that no ledger row covers.
 * @param {string} repoDir
 * @returns {string[]} repo-relative posix paths
 */
function unledgeredArt(repoDir) {
  return unledgeredScan(repoDir).missing;
}

/** The unledgered art files, and whether the scan was cut off (then more may be missing). */
function unledgeredScan(repoDir) {
  const { files, truncated } = scanArt(repoDir);
  if (!files.length) return { missing: [], truncated };
  const ledgerPaths = readLedgerRows(repoDir).map((r) => r.path);
  return { missing: files.filter((rel) => !isCovered(rel, ledgerPaths)), truncated };
}

/**
 * The Critic's card for art files without a ledger row (lunasworkCritic card
 * shape). An open card about it is updated, not doubled. [] when all is ledgered.
 * @param {string} repoDir
 * @param {{at:number, text:string}[]} [openCards]
 * @returns {object[]}
 */
function ledgerCards(repoDir, openCards = []) {
  const { missing, truncated } = unledgeredScan(repoDir);
  // A cut-off scan proves nothing: it holds SHIP like a missing row would.
  if (!missing.length && !truncated) return [];
  const open = (Array.isArray(openCards) ? openCards : []).find((c) => isObj(c) && typeof c.text === 'string' && c.text.startsWith(LEDGER_CARD_HEAD));
  const listed = missing.slice(0, MAX_LISTED_FILES);
  return [{
    kind: 'missing',
    severity: 'high',
    text: missing.length
      ? `${LEDGER_CARD_HEAD} ${missing.length}${truncated ? '+' : ''} art file(s) have no row in ${LEDGER_FILE}`
      : `${LEDGER_CARD_HEAD} the art scan of Assets/ was cut off (over ${MAX_WALK_ENTRIES} entries or ${MAX_WALK_DEPTH} folders deep)`,
    details: [
      ...(truncated ? [`The Critic's scan of Assets/ stopped at its cap, so some art was not checked. Check the rest against ${LEDGER_FILE} by hand, or move third-party packs out of Assets/**/Art/ folders.`, ''] : []),
      `These files under Assets/**/Art/ have no row in ${LEDGER_FILE} (columns: ${LEDGER_TITLES.join(', ')}):`,
      ...listed.map((p) => `- ${p}`),
      ...(missing.length > listed.length ? [`- ... and ${missing.length - listed.length} more`] : []),
      '',
      `For each one, add its row: where it came from, who made it and its license. Allowed: CC0, CC-BY or an explicit free-for-commercial license; a generated asset is "${GENERATED_LICENSE}". An asset whose source or license is unknown or non-free, or that was ripped from an existing game, must be deleted and replaced (luna_asset_search / luna_asset_import write the row themselves).`,
      'One row can cover a whole pack: a path ending in "/" (e.g. Assets/ThirdParty/Art/SomePack/) covers every file under it, and a row for a model also covers the prefab / material made from it (same name).',
      `CC-BY rows need their credit: ${CREDITS_FILE} is rewritten from the ledger by the next luna_asset_import.`,
    ].join('\n'),
    acceptance: [`Every file under Assets/**/Art/ has a row in ${LEDGER_FILE}`, 'No asset with an unknown or non-free license is left in the project'],
    files: [LEDGER_FILE, ...listed.slice(0, 10)],
    updatesCardId: open ? open.at : null,
  }];
}

module.exports = {
  LEDGER_FILE,
  CREDITS_FILE,
  LEDGER_TITLES,
  GENERATED_LICENSE,
  FREE_COMMERCIAL,
  BLENDERKIT_ROYALTY_FREE,
  REFERENCE_GAMES,
  classifyLicense,
  ripReason,
  MAX_CELL_CHARS,
  MAX_LEDGER_BYTES,
  parseLedger,
  ledgerRowFor,
  withLedgerRows,
  withLedgerLock,
  creditsText,
  isCovered,
  artFiles,
  unledgeredArt,
  ledgerCards,
};
