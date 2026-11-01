// ============================================================================
// LunaCore - Luna's Work asset pipeline, games only (docs/LUNAS_WORK_PLAN.md
// idea #15, LW 3.37)
// ----------------------------------------------------------------------------
// design/ASSETS.md is the single source of truth for a game's assets: one
// table row per asset (name, type, prompt/spec, source, file, status, hash,
// ref). The asset step runs at the start of every iteration, before the
// Director (createAssetStep().beforeDirecting, called from src/lunaswork.js):
//
//   dedupe     parseAssetList / dedupeAssets: a planned row whose name or
//              spec hash an earlier row already has becomes `duplicate` and
//              is never generated. This runs before ANY card - and a card is
//              the only way a generation starts - so nothing is made twice.
//   cards      selectBatch / assetCard: every planned row becomes one builder
//              card (kind `missing`, tag `asset`) the Director schedules like
//              any other. The card tells the builder to generate through a
//              generation API (e.g. Higgsfield, image-to-3D), Blender MCP or an
//              asset library, then import it into the Unity project. Its
//              `files` name the asset's prefab, so src/lunasworkScene.js routes
//              the card to the scene worker (the only one with the editor).
//   cost gate  costDecision: a batch over the list's "Batch limit" goes to the
//              decision queue (lunasworkDecisions via the controller's ask).
//              The capped batch goes on at once - the default answer is
//              `capped` - and the rest is held: `all` cards it right away,
//              `capped` defers it to later batches, never asked again.
//   style      runStyleCheck: the Critic's style check. One read-only
//              `claude -p --json-schema` call compares each new asset's render
//              (design/asset-renders/<slug>.png, saved by the builder) with the
//              art-direction images in design/references/ and scores it 0-10.
//              Below STYLE_PASS_SCORE the asset gets a `feel` card with both
//              images in its files; otherwise its row is `approved`. It lives
//              here, not in src/lunasworkCritic.js, which is at its size limit;
//              it reuses the Critic's runner, card writer and model choice.
//
// Row status: planned -> queued (card filed) -> done (card closed, or the
// builder set it) -> approved | restyle (feel card) -> done -> ... A held row
// waits for a cost decision; deferred = `capped` answer, carded in a later
// batch. Unknown statuses are left alone and never generated.
//
// The step never blocks or throws: a failure is one run-log line and the run
// goes on. Model output only scores; it never names a file this module writes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pack = require('./lunasworkPack');
const { pickModel } = require('./lunasworkRules');
const { parsePlannerOutput } = require('./orchestraPlan');
const { execClaude, applyCards } = require('./lunasworkCritic');
const { slugify } = require('./lunasworkResearch');
const { checkCwd } = require('./projects');
const { normalizeTodos, runTag, MAX_DETAILS_CHARS } = require('./todorows');
const { MAX_TASKS_PER_CALL } = require('./intake');

const ASSETS_FILE = 'ASSETS.md';
const RENDERS_DIR = 'asset-renders';
const REFERENCES_DIR = 'references';
const ASSET_TAG = 'asset';
// The prefab the scene worker makes; a *.prefab in a card's files routes it there.
const UNITY_ART_DIR = 'Assets/Art';

const TYPES = ['sprite', 'texture', 'model', 'material', 'animation', 'audio', 'ui', 'vfx', 'other'];
const SOURCES = ['generated', 'blender', 'library'];
const PLANNED = 'planned';
const HELD = 'held';
const DEFERRED = 'deferred';
const QUEUED = 'queued';
const DONE = 'done';
const APPROVED = 'approved';
const RESTYLE = 'restyle';
const DUPLICATE = 'duplicate';
// Statuses past `planned`: a changed spec sends these back to planned, once.
const STARTED = [HELD, DEFERRED, QUEUED, DONE, APPROVED, RESTYLE];

// Cost gate answers (lunasworkDecisions: neither holds cards).
const CAPPED = 'capped';
const ALL = 'all';
const DEFAULT_BATCH_LIMIT = 5;
const MAX_BATCH_LIMIT = 50;

const STYLE_PASS_SCORE = 7;
const STYLE_EFFORT = 'medium';
const STYLE_BUDGET_USD = 1;
const STYLE_TIMEOUT_MS = 6 * 60 * 1000;
const STYLE_TOOLS = 'Read';
const FALLBACK_MODEL = 'opus';
const MAX_STYLE_PER_CALL = 8;
const MAX_REFERENCE_IMAGES = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LOOK_CHARS = 3000;
const MAX_NOTES_CHARS = 600;

const MAX_LIST_CHARS = 200000;
const MAX_NAME_CHARS = 80;
const MAX_SPEC_CHARS = 500;
const MAX_FILE_CHARS = 200;
const MAX_STATUS_CHARS = 30;
const MAX_NAMES_IN_LOG = 8;
const HASH_CHARS = 12;

const COLUMNS = ['name', 'type', 'spec', 'source', 'file', 'status', 'hash', 'ref'];
const TITLES = ['Name', 'Type', 'Spec', 'Source', 'File', 'Status', 'Hash', 'Ref'];
const HEADER_ALIASES = Object.freeze({
  name: 'name', type: 'type', spec: 'spec', prompt: 'spec', 'prompt/spec': 'spec', 'prompt / spec': 'spec',
  source: 'source', file: 'file', 'file path': 'file', path: 'file', status: 'status', hash: 'hash', ref: 'ref',
});
const IMAGE_RE = /\.(png|jpe?g)$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const errText = (err) => (err && err.message ? err.message : String(err));
const posix = (p) => p.split(path.sep).join('/');

// ---- ASSETS.md ------------------------------------------------------------------------

/** The dedupe hash of an asset: its type and spec (its name when there is no spec). */
function specHash(type, spec, name = '') {
  const text = oneLine(spec || name, MAX_SPEC_CHARS).toLowerCase();
  return crypto.createHash('sha256').update(`${type}\n${text}`).digest('hex').slice(0, HASH_CHARS);
}

/** "card 123" / "decision 456" -> {kind, id}, else null. */
function refOf(raw) {
  const m = oneLine(raw, 40).match(/^(card|decision)\s*#?(\d{1,16})$/i);
  return m ? { kind: m[1].toLowerCase(), id: Number(m[2]) } : null;
}

const refText = (ref) => (ref ? `${ref.kind} ${ref.id}` : '');

/** "| a | b \| c |" -> ['a', 'b | c'] */
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** Column index per known key, from the header cells. */
function headerMap(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const key = HEADER_ALIASES[c.toLowerCase()];
    if (key && map[key] === undefined) map[key] = i;
  });
  return map.name === undefined ? null : map;
}

/** One table row as an asset; a row without a name is kept verbatim (raw). */
function cleanRow(line, map) {
  const cells = splitRow(line);
  const get = (key) => (map[key] === undefined ? '' : cells[map[key]] || '');
  const name = oneLine(get('name'), MAX_NAME_CHARS);
  if (!name) return { raw: line };
  const typeText = get('type').toLowerCase();
  const sourceText = get('source').toLowerCase();
  const type = TYPES.includes(typeText) ? typeText : 'other';
  const spec = oneLine(get('spec'), MAX_SPEC_CHARS);
  const row = {
    name,
    type,
    spec,
    source: SOURCES.includes(sourceText) ? sourceText : 'generated',
    file: oneLine(get('file'), MAX_FILE_CHARS),
    status: oneLine(get('status').toLowerCase(), MAX_STATUS_CHARS) || PLANNED,
    hash: specHash(type, spec, name),
    ref: refOf(get('ref')),
  };
  const stored = get('hash').toLowerCase();
  // A changed spec is a different asset: one already started is planned again.
  if (stored && stored !== row.hash && STARTED.includes(row.status)) return { ...row, status: PLANNED, ref: null };
  return row;
}

/** Per line: true when it sits inside an <!-- --> comment. */
function commentMask(lines) {
  let inside = false;
  return lines.map((line) => {
    const was = inside;
    for (const m of line.matchAll(/<!--|-->/g)) inside = m[0] === '<!--';
    return was || (inside && line.trim().startsWith('<!--'));
  });
}

/**
 * The asset table of ASSETS.md, plus its batch limit ("Batch limit: N").
 * @returns {{rows:object[], limit:number|null, lines:string[], table:{start:number, end:number}|null}}
 */
function parseAssetList(md) {
  const lines = (typeof md === 'string' ? md : '').replace(/\r\n/g, '\n').split('\n');
  const hidden = commentMask(lines);
  let limit = null;
  let table = null;
  let rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (hidden[i]) continue;
    const lim = lines[i].match(/^\s*batch limit\s*:\s*(\d{1,3})\s*$/i);
    if (lim) limit = Math.min(MAX_BATCH_LIMIT, Math.max(1, Number(lim[1])));
    const map = !table && /^\s*\|/.test(lines[i]) && isSeparator(lines[i + 1] || '') ? headerMap(splitRow(lines[i])) : null;
    if (!map) continue;
    let end = i + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    table = { start: i, end };
    rows = lines.slice(i + 2, end).map((line) => cleanRow(line, map));
    i = end - 1;
  }
  return { rows, limit, lines, table };
}

const cell = (v) => String(v || '').replace(/\|/g, '\\|');

function formatRow(row) {
  if (row.raw) return row.raw;
  const values = { ...row, ref: refText(row.ref) };
  return `| ${COLUMNS.map((k) => cell(values[k])).join(' | ')} |`;
}

/** ASSETS.md with its table rewritten from `rows`; text around the table is kept. */
function formatAssetList(parsed, rows) {
  const table = [`| ${TITLES.join(' | ')} |`, `|${TITLES.map(() => '---').join('|')}|`, ...rows.map(formatRow)];
  if (!parsed.table) {
    const base = parsed.lines.join('\n').replace(/\s*$/, '');
    return `${base ? `${base}\n\n` : ''}${table.join('\n')}\n`;
  }
  const { start, end } = parsed.table;
  return [...parsed.lines.slice(0, start), ...table, ...parsed.lines.slice(end)].join('\n');
}

const isAsset = (row) => !row.raw;

/**
 * A planned row whose name or spec hash an earlier row has is a duplicate and
 * is never generated. Rows past `planned` are what already happened: kept.
 */
function dedupeAssets(rows) {
  const names = new Set();
  const hashes = new Set();
  return rows.map((row) => {
    if (!isAsset(row)) return row;
    const key = row.name.toLowerCase();
    const dup = names.has(key) || hashes.has(row.hash);
    names.add(key);
    hashes.add(row.hash);
    return dup && row.status === PLANNED ? { ...row, status: DUPLICATE, ref: null } : row;
  });
}

// ---- rows against the run ---------------------------------------------------------------

/**
 * Moves rows on from what the run knows: a held row by its cost decision
 * (gone -> planned, `all` -> carded now, else deferred), a queued / restyle
 * row whose card is closed -> done.
 * @param {object[]} rows
 * @param {{decisions:object[], cards:object[]}} ctx the run's queue, the to-do list
 */
function settleRows(rows, { decisions, cards }) {
  const decisionById = new Map((Array.isArray(decisions) ? decisions : []).filter(isObj).map((d) => [d.id, d]));
  const cardByAt = new Map((Array.isArray(cards) ? cards : []).map((c) => [c.at, c]));
  return rows.map((row) => {
    if (!isAsset(row)) return row;
    if (row.status === HELD) {
      const d = row.ref && row.ref.kind === 'decision' ? decisionById.get(row.ref.id) : null;
      if (!d) return { ...row, status: PLANNED, ref: null };
      if (d.status === 'pending') return row;
      return d.answer === ALL ? { ...row, status: DEFERRED, ref: null, now: true } : { ...row, status: DEFERRED, ref: null };
    }
    if ((row.status === QUEUED || row.status === RESTYLE) && row.ref && row.ref.kind === 'card') {
      const card = cardByAt.get(row.ref.id);
      if (card && card.done === true) return { ...row, status: DONE };
    }
    return row;
  });
}

/**
 * This iteration's batch: rows released by an `all` answer, then planned and
 * deferred rows in list order up to `limit`. Planned rows past the limit go
 * to the cost gate; deferred ones just wait for a later batch.
 * @returns {{take:object[], ask:object[]}}
 */
function selectBatch(rows, limit) {
  const assets = rows.filter(isAsset);
  const now = assets.filter((r) => r.now);
  const ready = assets.filter((r) => !r.now && (r.status === PLANNED || r.status === DEFERRED));
  return {
    take: [...now, ...ready.slice(0, limit)],
    ask: ready.slice(limit).filter((r) => r.status === PLANNED),
  };
}

/** The cost gate's question: the capped batch already goes on; the default keeps it capped. */
function costDecision(rows, limit) {
  const names = rows.slice(0, MAX_NAMES_IN_LOG).map((r) => r.name).join(', ');
  return {
    kind: 'other',
    question: `Generate ${rows.length} more game asset(s) now? The batch is over the limit of ${limit} per iteration; ${limit} are being made already.`,
    detail: `${ALL} = generate them all now; ${CAPPED} = at most ${limit} per iteration (default). ${names}${rows.length > MAX_NAMES_IN_LOG ? ', ...' : ''}`,
    options: [CAPPED, ALL],
    defaultAnswer: CAPPED,
  };
}

// ---- asset cards ------------------------------------------------------------------------

const slugOf = (row) => slugify(row.name) || `asset-${row.hash}`;
const renderBase = (row) => `${pack.DESIGN_DIR}/${RENDERS_DIR}/${slugOf(row)}`;

const HOW = Object.freeze({
  generated: 'Generate it with an available generation API (for example Higgsfield, or image-to-3D for a model). Use the spec as the prompt.',
  blender: 'Make it in Blender through the Blender MCP (generate_3d, or model it with execute_blender_code), then export it (FBX or GLB for a model).',
  library: 'Take it from an asset library (Blender MCP search_assets / import_asset: Poly Haven, Sketchfab, Poly Pizza). Check that its license allows use in the game.',
});

/** The builder card for one asset row (Critic card shape, lunasworkCritic.applyCards). */
function assetCard(row) {
  const slug = slugOf(row);
  const prefab = `${UNITY_ART_DIR}/${slug}/${slug}.prefab`;
  const details = [
    `Make the game asset "${row.name}" from design/${ASSETS_FILE} (hash ${row.hash}).`,
    `Type: ${row.type}. Source: ${row.source}. Spec: ${row.spec || row.name}`,
    HOW[row.source],
    `Generate it once: before any generation call, read design/${ASSETS_FILE}. If a row with hash ${row.hash} or the name "${row.name}" is already done or approved with a file, reuse that file instead.`,
    `Import it into the Unity project under ${UNITY_ART_DIR}/${slug}/ with a prefab ${prefab}.`,
    `Save a render or screenshot of it to ${renderBase(row)}.png for the art-direction style check.`,
    `Last, in design/${ASSETS_FILE} set this row's File to the imported path and its Status to done.`,
  ].join('\n\n');
  return {
    kind: 'missing',
    severity: 'medium',
    text: `Asset: ${row.name} (${row.type})`,
    details: details.slice(0, MAX_DETAILS_CHARS),
    acceptance: [
      `The asset is imported under ${UNITY_ART_DIR}/${slug}/ with a prefab`,
      `${renderBase(row)}.png shows it`,
      `Its design/${ASSETS_FILE} row is done, with the file path`,
    ],
    files: [prefab, `design/${ASSETS_FILE}`, ...(row.file ? [row.file] : [])],
    updatesCardId: null,
    splitsCardId: null,
    extraTags: [ASSET_TAG],
  };
}

/** An open card of this run with this text (filed before a crash, or still being worked on). */
const openCardOf = (list, tag, text) => list.find((c) => !c.done && Array.isArray(c.tags) && c.tags.includes(tag) && c.text === text) || null;

/**
 * Files the cards no open card covers yet, in chunks of what one store add
 * takes. A card the full list had no room for is simply not in `ats`.
 * @returns {{ats:Map<string, number>, error?:string}} card `at` per card text
 */
function fileCards(store, tag, cards) {
  const list = normalizeTodos(store.read());
  const ats = new Map();
  const fresh = [];
  for (const card of cards) {
    const open = openCardOf(list, tag, card.text);
    if (open) ats.set(card.text, open.at);
    else fresh.push(card);
  }
  for (let i = 0; i < fresh.length; i += MAX_TASKS_PER_CALL) {
    const res = applyCards(store, fresh.slice(i, i + MAX_TASKS_PER_CALL), tag);
    for (const c of res.created) ats.set(c.text, c.at);
    if (res.error) return { ats, error: res.error };
  }
  return { ats };
}

// ---- style check ------------------------------------------------------------------------

function isImageFile(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_IMAGE_BYTES || !IMAGE_RE.test(abs)) return false;
    const fd = fs.openSync(abs, 'r');
    try {
      const head = Buffer.alloc(PNG_MAGIC.length);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      return (n === PNG_MAGIC.length && head.equals(PNG_MAGIC)) || head.subarray(0, 3).equals(JPEG_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function dirEntries(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * The art-direction images: design/references/*.png|jpg and one folder down
 * (the research step's <slug>/ folders), as repo-relative paths. No links.
 * @returns {string[]}
 */
function referenceImages(repoDir) {
  const root = path.join(path.resolve(repoDir), pack.DESIGN_DIR, REFERENCES_DIR);
  const found = [];
  for (const e of dirEntries(root)) {
    if (e.isFile()) found.push(path.join(root, e.name));
    else if (e.isDirectory()) for (const f of dirEntries(path.join(root, e.name))) if (f.isFile()) found.push(path.join(root, e.name, f.name));
  }
  return found.filter(isImageFile).slice(0, MAX_REFERENCE_IMAGES).map((abs) => posix(path.relative(path.resolve(repoDir), abs)));
}

const isLinkPath = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The render the builder saved for a row, repo-relative, or null. Never through a linked folder. */
function renderOf(repoDir, row) {
  if (isLinkPath(path.join(path.resolve(repoDir), pack.DESIGN_DIR, RENDERS_DIR))) return null;
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const rel = `${renderBase(row)}${ext}`;
    if (isImageFile(path.join(path.resolve(repoDir), rel))) return rel;
  }
  return null;
}

/** The "## Look and feel" section of DESIGN.md, capped; '' when there is none. */
function lookAndFeel(design) {
  const md = String(design || '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = md.match(/^##\s+Look and feel\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
  return m ? m[1].trim().slice(0, MAX_LOOK_CHARS) : '';
}

/** JSON schema handed to `--json-schema`. Mirrors validateStyle() below. */
const STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      maxItems: MAX_STYLE_PER_CALL,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'score', 'reference', 'notes'],
        properties: { name: { type: 'string' }, score: { type: 'number' }, reference: { type: 'string' }, notes: { type: 'string' } },
      },
    },
  },
};

/** argv for the style check - read-only, never a shell string; the prompt goes on stdin. */
function buildStyleArgs({ model = FALLBACK_MODEL, budgetUsd = STYLE_BUDGET_USD } = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(STYLE_SCHEMA),
    '--model', model,
    '--effort', STYLE_EFFORT,
    '--tools', STYLE_TOOLS,
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

function buildStylePrompt({ assets, references, look }) {
  return [
    "You are the Critic of Luna's Work, running the art-direction style check of a game's new assets.",
    '',
    'Art-direction references - open every one with Read:',
    ...references.map((r) => `- ${r}`),
    ...(look ? ['', 'Look and feel, from design/DESIGN.md:', '<<<', look, '>>>'] : []),
    '',
    'New assets - open every render with Read:',
    ...assets.map((a) => `- "${a.name}" (${a.type}): ${a.spec || a.name}. Render: ${a.render}`),
    '',
    'Score every asset from 0 to 10 for how consistent it is with the art direction: palette, shape language, level of detail, rendering style, proportions.',
    `10 = it could come from the reference game; below ${STYLE_PASS_SCORE} = it would look out of place.`,
    'Answer with JSON. scores: one entry per asset - name (exactly as listed), score, reference (the path of the reference image it should look closest to, from the list above), notes (what differs and what to change, one or two sentences).',
  ].join('\n');
}

/**
 * The trust boundary: one score per asked asset, the reference one of the
 * listed images (else the first), notes capped. Unknown names are dropped.
 * @returns {{name:string, score:number, reference:string, notes:string}[]}
 */
function validateStyle(raw, assets, references) {
  const asked = new Set(assets.map((a) => a.name));
  const seen = new Set();
  const out = [];
  for (const s of isObj(raw) && Array.isArray(raw.scores) ? raw.scores : []) {
    if (!isObj(s) || !asked.has(s.name) || seen.has(s.name) || !Number.isFinite(s.score)) continue;
    seen.add(s.name);
    const reference = references.includes(s.reference) ? s.reference : references[0];
    out.push({ name: s.name, score: Math.round(Math.min(10, Math.max(0, s.score))), reference, notes: oneLine(s.notes, MAX_NOTES_CHARS) });
  }
  return out;
}

/**
 * One style-check call. Always resolves.
 * @param {{repoDir:string, assets:{name:string, type:string, spec:string, render:string}[], references:string[],
 *   model?:string, runClaude?:Function, env?:object, timeoutMs?:number, budgetUsd?:number}} opts
 * @returns {Promise<{ok:boolean, scores:object[], costUsd:number|null, error?:string, detail?:string}>}
 */
async function runStyleCheck(opts) {
  const o = isObj(opts) ? opts : {};
  const fail = (error, detail) => ({ ok: false, scores: [], costUsd: null, error, ...(detail ? { detail: oneLine(detail, 300) } : {}) });
  try {
    if (!checkCwd(o.repoDir).ok) return fail('noRepo');
    const assets = (Array.isArray(o.assets) ? o.assets : []).slice(0, MAX_STYLE_PER_CALL);
    const references = Array.isArray(o.references) ? o.references : [];
    if (!assets.length || !references.length) return fail('nothingToCompare');
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildStyleArgs({ model: o.model, budgetUsd: o.budgetUsd }),
      prompt: buildStylePrompt({ assets, references, look: lookAndFeel(pack.readPackFile(o.repoDir, 'DESIGN.md')) }),
      cwd: o.repoDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || STYLE_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    return { ok: true, scores: validateStyle(parsed.raw, assets, references), costUsd: parsed.costUsd };
  } catch (err) {
    return fail('failed', errText(err));
  }
}

/** The `feel` card for an off-style asset: its render and the reference both in `files`. */
function styleCard(row, s) {
  const details = [
    `The art-direction style check scored the asset "${row.name}" ${s.score}/10 against design/${REFERENCES_DIR}/.`,
    s.notes,
    `Asset render: ${row.render}`,
    `Art reference: ${s.reference}`,
    `Rework or regenerate it to match the reference. This redo is planned, not a duplicate: keep its design/${ASSETS_FILE} row and hash, import it again, replace the render, then set its Status back to done.`,
  ].filter(Boolean).join('\n\n');
  return {
    kind: 'feel',
    severity: 'medium',
    text: `Asset off-style: ${row.name} (${s.score}/10 against the art direction)`,
    details: details.slice(0, MAX_DETAILS_CHARS),
    acceptance: ['The new render matches the art reference in palette, shape and detail', `Its design/${ASSETS_FILE} row is done again`],
    files: [row.render, s.reference],
    updatesCardId: null,
    splitsCardId: null,
    extraTags: [ASSET_TAG],
  };
}

// ---- controller seam --------------------------------------------------------------------

/**
 * The step lunaswork.js runs at the start of every iteration, before the
 * Director. Nothing happens without design/ASSETS.md; a Unity run gets the
 * empty template.
 * @param {{todoStore:(projectId:string)=>{read:Function, write:Function, now?:Function},
 *   ask:(spec:object)=>{ok:boolean, id?:number, reason?:string},
 *   styleCheck?:(opts:object)=>Promise<object>, batchLimit?:number,
 *   logEvent:(text:string)=>void, logModel?:(role:string, model:string, reason:string)=>void}} deps
 */
function createAssetStep(deps) {
  const logEvent = (text) => deps.logEvent(`assets: ${text}`);
  const defaultLimit = Number.isInteger(deps.batchLimit) && deps.batchLimit > 0 ? Math.min(MAX_BATCH_LIMIT, deps.batchLimit) : DEFAULT_BATCH_LIMIT;

  /** Asks about the rows over the limit; they are held under the decision. */
  function gate(rows, ask, limit) {
    if (!ask.length) return rows;
    const res = deps.ask(costDecision(ask, limit));
    if (!isObj(res) || !res.ok) {
      logEvent(`the batch question was not queued (${oneLine(res && res.reason, 60) || 'failed'}) - ${ask.length} asset(s) wait for the next batch`);
      return rows;
    }
    const held = new Set(ask);
    logEvent(`${ask.length} asset(s) over the batch limit of ${limit} held for decision ${res.id}`);
    return rows.map((r) => (held.has(r) ? { ...r, status: HELD, ref: { kind: 'decision', id: res.id } } : r));
  }

  /** Files the batch's cards; carded rows become queued. */
  function card(rows, take, store, tag) {
    if (!take.length) return rows;
    const cards = new Map(take.map((r) => [r, assetCard(r)]));
    const { ats, error } = fileCards(store, tag, [...cards.values()]);
    if (error) logEvent(`cards not saved (${oneLine(error, 120)}) - those assets stay planned`);
    const carded = take.filter((r) => ats.has(cards.get(r).text));
    if (carded.length) logEvent(`${carded.length} asset card(s): ${carded.slice(0, MAX_NAMES_IN_LOG).map((r) => r.name).join(', ')}`);
    return rows.map((r) => {
      const at = cards.has(r) ? ats.get(cards.get(r).text) : undefined;
      return at === undefined ? r : { ...r, status: QUEUED, ref: { kind: 'card', id: at } };
    });
  }

  /** The Critic's style check over done rows with a render; low scores file feel cards. */
  async function styleCheck(run, rows, store, tag) {
    if (typeof deps.styleCheck !== 'function') return rows;
    const due = rows.filter((r) => isAsset(r) && r.status === DONE).map((r) => ({ row: r, render: renderOf(run.repoPath, r) })).filter((x) => x.render);
    if (!due.length) return rows;
    const references = referenceImages(run.repoPath);
    if (!references.length) return rows;
    const batch = due.slice(0, MAX_STYLE_PER_CALL).map((x) => ({ ...x.row, render: x.render }));
    const pick = pickModel('critic', run.models) || { model: FALLBACK_MODEL, reason: 'default' };
    const res = await deps.styleCheck({ repoDir: run.repoPath, assets: batch, references, model: pick.model });
    if (typeof deps.logModel === 'function') deps.logModel('critic', pick.model, `${pick.reason}; asset style check`);
    if (!isObj(res) || !res.ok) {
      logEvent(`style check failed (${oneLine(res && res.error, 40) || 'failed'}) - tried again next iteration`);
      return rows;
    }
    const byName = new Map((Array.isArray(res.scores) ? res.scores : []).map((s) => [s.name, s]));
    const checked = new Map(batch.filter((a) => byName.has(a.name)).map((a) => [a.name, a]));
    const low = [...checked.values()].filter((a) => byName.get(a.name).score < STYLE_PASS_SCORE);
    const cards = new Map(low.map((a) => [a.name, styleCard(a, byName.get(a.name))]));
    const { ats, error } = cards.size ? fileCards(store, tag, [...cards.values()]) : { ats: new Map() };
    if (error) logEvent(`style cards not saved (${oneLine(error, 120)})`);
    logEvent(`style check: ${checked.size} asset(s) scored, ${low.length} off-style`);
    return rows.map((r) => {
      if (!isAsset(r) || r.status !== DONE || !checked.has(r.name)) return r;
      if (!cards.has(r.name)) return { ...r, status: APPROVED };
      const at = ats.get(cards.get(r.name).text);
      // A feel card that was not saved leaves the row done: checked again next time.
      return at === undefined ? r : { ...r, status: RESTYLE, ref: { kind: 'card', id: at } };
    });
  }

  function readList(run) {
    const md = pack.readPackFile(run.repoPath, ASSETS_FILE);
    if (md !== null || !isObj(run.profile) || run.profile.adapter !== 'unity') return md;
    // A Unity run without the list gets the template to fill; nothing to do yet.
    pack.applyWrite(run.repoPath, { file: ASSETS_FILE, update: (current) => current || pack.GAME_TEMPLATES[ASSETS_FILE] });
    return null;
  }

  /** @returns {Promise<object|null>} row counts after the pass, null when nothing ran */
  async function beforeDirecting(run) {
    if (!isObj(run) || !run.repoPath) return null;
    try {
      const md = readList(run);
      if (md === null || md.length > MAX_LIST_CHARS) return null;
      const parsed = parseAssetList(md);
      if (!parsed.rows.some(isAsset)) return null;
      const tag = runTag(run.id);
      const store = deps.todoStore(run.projectId);
      if (!tag || !store) return null;
      const limit = parsed.limit || defaultLimit;
      let rows = dedupeAssets(settleRows(parsed.rows, { decisions: run.decisions, cards: normalizeTodos(store.read()) }));
      const { take, ask } = selectBatch(rows, limit);
      rows = card(gate(rows, ask, limit), take, store, tag);
      rows = await styleCheck(run, rows, store, tag);
      // `now` is this pass's own flag (an `all` answer), never written.
      rows = rows.map(({ now, ...r }) => r);
      const next = formatAssetList(parsed, rows);
      if (next !== parsed.lines.join('\n')) {
        const written = pack.applyWrite(run.repoPath, { file: ASSETS_FILE, update: () => next });
        if (!written.ok) logEvent(`design/${ASSETS_FILE} not updated (${oneLine(written.error, 120)})`);
      }
      const count = (status) => rows.filter((r) => isAsset(r) && r.status === status).length;
      return { queued: count(QUEUED), held: count(HELD), deferred: count(DEFERRED), duplicates: count(DUPLICATE), restyle: count(RESTYLE), approved: count(APPROVED) };
    } catch (err) {
      logEvent(`failed (${oneLine(errText(err), 150)}) - the run went on without it`);
      return null;
    }
  }

  return { beforeDirecting };
}

module.exports = {
  ASSETS_FILE,
  ASSET_TAG,
  TYPES,
  SOURCES,
  CAPPED,
  ALL,
  DEFAULT_BATCH_LIMIT,
  STYLE_PASS_SCORE,
  STYLE_SCHEMA,
  specHash,
  parseAssetList,
  formatAssetList,
  dedupeAssets,
  settleRows,
  selectBatch,
  costDecision,
  assetCard,
  referenceImages,
  buildStyleArgs,
  buildStylePrompt,
  validateStyle,
  runStyleCheck,
  styleCard,
  createAssetStep,
};
