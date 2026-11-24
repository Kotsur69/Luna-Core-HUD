// ============================================================================
// LunaCore - Luna's Work asset casting: the Director picks the source per asset
// ----------------------------------------------------------------------------
// A design/ASSETS.md row whose Source is empty or "auto" is cast before its
// builder card is filed (src/lunasworkAssets.js createAssetStep, through
// castAutoRows). One read-only `claude -p --json-schema` call per batch of
// auto rows, as the Director role (its model choice: lunasworkRules.pickModel
// 'director'), picks for each asset:
//
//   primary     {source, librarySources[] | comfyWorkflow | higgsfieldModel}
//   fallbacks   a ladder, cheapest first: free library, then local ComfyUI /
//               Blender, then paid Higgsfield
//   candidates  1 to 4
//   reason      one line
//
// The prompt gets the auto rows, the asset catalog (src/lunasworkAssetCatalog.js),
// the art direction rule, the file names in design/references/, which library
// keys are stored (booleans only, never a key value), the ComfyUI workflows in
// art/comfyui/ and the run's remaining Higgsfield budget.
//
// validateCasting is the trust boundary: nothing the model says reaches a card
// unless it names a catalog source for the row's kind, a stored key, an
// existing workflow file and a known Higgsfield model. An invalid primary, a
// failed, timed-out or malformed call: the row keeps today's behaviour
// (source `generated`), one run-log line, and the run goes on.
//
// The cast is a pass-only field of the row (`casting`): ASSETS.md keeps
// "auto" (uncast). The step caches valid casts per run and row hash, so a
// held or re-planned row keeps its pick (and its approved price) without a
// new call. A plan is priced at its costliest rung (a paid fallback counts as
// paid spend). At most MAX_CAST_PER_PASS rows are cast per pass.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const pack = require('./lunasworkPack');
const { pickModel } = require('./lunasworkRules');
const { parsePlannerOutput } = require('./orchestraPlan');
const { execClaude } = require('./lunasworkCritic');
const { checkCwd } = require('./projects');
const { SOURCE_IDS } = require('./lunasworkFreeSources');
const { ART_DIRECTION_RULE, AMD_GPU_RULE, COMFY_WORKFLOW_DIR } = require('./lunasworkAssetPipeline');
const { loadCatalog, sourcesForKind, isKnownHiggsfieldModel } = require('./lunasworkAssetCatalog');
const { remainingHiggsfieldUsd } = require('./lunasworkAssetCost');

const AUTO = 'auto';
// Today's behaviour for a row without a usable cast.
const FALLBACK_SOURCE = 'generated';
const RUNG_SOURCES = Object.freeze(['library', 'comfyui', 'blender', 'higgsfield']);
// Cheapest first: free library, local ComfyUI / Blender, paid Higgsfield.
const COST_RANK = Object.freeze({ library: 0, comfyui: 1, blender: 1, higgsfield: 2 });
// The cast's class in the Asset Manifest Estimate's words (src/lunasworkAssetCost.js costClass).
const COST_CLASS = Object.freeze({ library: 'library', comfyui: 'local', blender: 'local', higgsfield: 'paid' });
// The ASSETS.md source a cast stands for on the card (HOW / unityAssetBrief).
const LEGACY_SOURCE = Object.freeze({ library: 'library', blender: 'blender', comfyui: 'generated', higgsfield: 'generated' });

const MIN_CANDIDATES = 1;
const MAX_CANDIDATES = 4;
const MAX_FALLBACKS = 4;
const MAX_LIBRARIES_PER_RUNG = 4;
const MAX_CAST_PER_CALL = 8;
// At most two calls per pass: the other auto rows wait for the next pass, uncast and uncarded.
const MAX_CAST_PER_PASS = 2 * MAX_CAST_PER_CALL;
const MAX_CACHED_CASTS = 500;
const MAX_REFERENCE_NAMES = 30;
const MAX_WORKFLOWS = 30;
const MAX_FILE_NAME_CHARS = 80;
const MAX_REASON_CHARS = 200;
const MAX_LOG_DETAIL = 120;
// A paid primary while a free or local rung exists needs a reason this long that names the cheaper option.
const MIN_PAID_REASON_CHARS = 20;
const CHEAPER_WORDS_RE = new RegExp(`\\b(free|librar\\w*|local|comfy\\w*|blender|${SOURCE_IDS.join('|')})\\b`, 'i');
const WORKFLOW_FILE_RE = /^[\w-]{1,80}\.json$/;

const CASTING_EFFORT = 'medium';
const CASTING_BUDGET_USD = 0.5;
const CASTING_TIMEOUT_MS = 4 * 60 * 1000;
// No tools: everything the Director needs is in the prompt.
const CASTING_TOOLS = '';
const FALLBACK_MODEL = 'opus';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const errText = (err) => (err && err.message ? err.message : String(err));

// ---- what the repo has --------------------------------------------------------------------

/** Directory entries, sorted; [] for a missing folder or a linked one. */
function dirEntries(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The ComfyUI workflow files in art/comfyui/: plain .json files only, no links, no sub-folders. */
function listComfyWorkflows(repoDir) {
  const root = path.resolve(repoDir);
  if (isLink(path.join(root, 'art'))) return [];
  return dirEntries(path.join(root, ...COMFY_WORKFLOW_DIR.split('/')))
    .filter((e) => e.isFile() && WORKFLOW_FILE_RE.test(e.name))
    .map((e) => e.name)
    .slice(0, MAX_WORKFLOWS);
}

/** The file names in design/references/ and one folder down (the research step's <slug>/ folders). */
function listReferenceNames(repoDir) {
  const root = path.join(path.resolve(repoDir), pack.DESIGN_DIR, 'references');
  const names = [];
  for (const e of dirEntries(root)) {
    if (e.isFile()) names.push(e.name);
    else if (e.isDirectory()) for (const f of dirEntries(path.join(root, e.name))) if (f.isFile()) names.push(`${e.name}/${f.name}`);
  }
  return names.map((n) => oneLine(n, MAX_FILE_NAME_CHARS)).filter(Boolean).slice(0, MAX_REFERENCE_NAMES);
}

/**
 * Which library keys are stored: booleans only, from the key store's status().
 * A value that is not exactly `true` (a key string included) reads as false,
 * so a key value can never travel further than this function.
 * @param {()=>{keys?:Record<string, unknown>}} [keyStatus]
 * @returns {Record<string, boolean>}
 */
function keyFlags(keyStatus) {
  let keys = {};
  try {
    const st = typeof keyStatus === 'function' ? keyStatus() : null;
    keys = isObj(st) && isObj(st.keys) ? st.keys : {};
  } catch {
    keys = {};
  }
  return Object.fromEntries(SOURCE_IDS.map((id) => [id, own(keys, id) && keys[id] === true]));
}

let cachedCatalog = null;
const defaultCatalog = () => {
  if (!cachedCatalog) cachedCatalog = loadCatalog();
  return cachedCatalog;
};

const catalogSource = (catalog, id) => (isObj(catalog) && Array.isArray(catalog.sources) ? catalog.sources.find((s) => s && s.id === id) || null : null);

// ---- the trust boundary -------------------------------------------------------------------

/** Library rung: the listed ids that are catalog libraries for `kind` and usable (key stored when needed). */
function libraryRung(raw, kind, ctx) {
  const served = sourcesForKind(ctx.catalog, kind);
  const asked = Array.isArray(raw.librarySources) ? raw.librarySources.filter((id) => typeof id === 'string') : [];
  const unknown = asked.filter((id) => !SOURCE_IDS.includes(id) || !served.includes(id));
  if (unknown.length) return { why: `library ${oneLine(unknown[0], 40)} is not in the catalog for ${kind}` };
  const unkeyed = asked.filter((id) => catalogSource(ctx.catalog, id).needsKey && ctx.keys[id] !== true);
  if (unkeyed.length) return { why: `library ${unkeyed[0]} needs a key that is not stored` };
  const ids = [...new Set(asked)].slice(0, MAX_LIBRARIES_PER_RUNG);
  return ids.length ? { rung: { source: 'library', librarySources: ids } } : { why: 'library without librarySources' };
}

/**
 * One rung (primary or fallback), checked against the catalog and the repo.
 * @returns {{rung?:object, why?:string}} why = the reason it is rejected
 */
function checkRung(raw, kind, ctx) {
  if (!isObj(raw) || typeof raw.source !== 'string' || !RUNG_SOURCES.includes(raw.source)) {
    return { why: `unknown source ${JSON.stringify(oneLine(isObj(raw) ? String(raw.source) : '', 40))}` };
  }
  const { source } = raw;
  if (source === 'library') return libraryRung(raw, kind, ctx);
  if (!sourcesForKind(ctx.catalog, kind).includes(source)) return { why: `${source} is not in the catalog for ${kind}` };
  if (source === 'blender') return { rung: { source } };
  if (source === 'comfyui') {
    const name = typeof raw.comfyWorkflow === 'string' ? raw.comfyWorkflow.replace(/^art\/comfyui\//, '') : '';
    // The name pattern has no separator and no "..": a workflow can only be a file directly in art/comfyui/.
    if (!WORKFLOW_FILE_RE.test(name) || !ctx.workflows.includes(name)) return { why: `workflow ${JSON.stringify(oneLine(name, 80))} is not a file in ${COMFY_WORKFLOW_DIR}/` };
    return { rung: { source, comfyWorkflow: name } };
  }
  const model = typeof raw.higgsfieldModel === 'string' ? raw.higgsfieldModel : '';
  const entry = isKnownHiggsfieldModel(ctx.catalog, model) ? catalogSource(ctx.catalog, 'higgsfield').models.find((m) => m.id === model) : null;
  if (!entry) return { why: `unknown Higgsfield model ${JSON.stringify(oneLine(model, 60))}` };
  if (!entry.kinds.includes(kind)) return { why: `Higgsfield model ${model} does not make ${kind}` };
  return { rung: { source, higgsfieldModel: model } };
}

/** True when a free library (keyless or keyed) or a local tool can make `kind` here. */
function cheaperRungExists(kind, ctx) {
  return sourcesForKind(ctx.catalog, kind).some((id) => {
    if (id === 'blender') return true;
    if (id === 'comfyui') return ctx.workflows.length > 0;
    const s = catalogSource(ctx.catalog, id);
    return SOURCE_IDS.includes(id) && (!s.needsKey || ctx.keys[id] === true);
  });
}

const sameRung = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function clampCandidates(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : MIN_CANDIDATES;
  return Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, n));
}

/**
 * One cast entry -> a plan, or the reason it is rejected.
 * @returns {{plan?:object, why?:string}}
 */
function checkCast(c, kind, ctx) {
  const primary = checkRung(c.primary, kind, ctx);
  if (!primary.rung) return { why: `primary: ${primary.why}` };
  const reason = oneLine(c.reason, MAX_REASON_CHARS);
  if (primary.rung.source === 'higgsfield' && cheaperRungExists(kind, ctx)
    && (reason.length < MIN_PAID_REASON_CHARS || !CHEAPER_WORDS_RE.test(reason))) {
    return { why: 'paid Higgsfield primary while a free or local option exists, and the reason does not say why that option does not fit' };
  }
  const fallbacks = [];
  for (const raw of Array.isArray(c.fallbacks) ? c.fallbacks : []) {
    const f = checkRung(raw, kind, ctx);
    if (f.rung && !sameRung(f.rung, primary.rung) && !fallbacks.some((x) => sameRung(x, f.rung))) fallbacks.push(f.rung);
  }
  // The ladder is cheapest first whatever order the model gave; a stable sort keeps its order within a class.
  const ladder = fallbacks.sort((a, b) => COST_RANK[a.source] - COST_RANK[b.source]).slice(0, MAX_FALLBACKS);
  // Priced at the costliest rung: a paid fallback is spend the builder may make, so the spend gate counts it.
  const costliest = [primary.rung, ...ladder].reduce((a, b) => (COST_RANK[b.source] > COST_RANK[a.source] ? b : a));
  const paid = [primary.rung, ...ladder].find((r) => r.source === 'higgsfield');
  return {
    plan: {
      primary: primary.rung,
      fallbacks: ladder,
      candidates: clampCandidates(c.candidates),
      reason,
      costClass: COST_CLASS[costliest.source],
      paidModel: paid ? paid.higgsfieldModel : null,
    },
  };
}

/**
 * The trust boundary of the casting call. Unknown names, a second entry for a
 * name and invalid primaries are dropped (their rows keep the fallback);
 * invalid fallback rungs are dropped from the ladder.
 * @param {unknown} raw the model's structured output
 * @param {{rows:{name:string, type:string}[], catalog:object, keys:Record<string, boolean>, workflows:string[]}} ctx
 * @returns {{plans:Map<string, object>, rejected:{name:string, why:string}[]}}
 */
function validateCasting(raw, ctx) {
  const c = isObj(ctx) ? ctx : {};
  const check = {
    catalog: c.catalog,
    keys: isObj(c.keys) ? c.keys : {},
    workflows: Array.isArray(c.workflows) ? c.workflows : [],
  };
  const kindOf = new Map((Array.isArray(c.rows) ? c.rows : []).filter(isObj).map((r) => [r.name, r.type]));
  const plans = new Map();
  const rejected = [];
  const seen = new Set();
  for (const entry of isObj(raw) && Array.isArray(raw.casts) ? raw.casts : []) {
    if (!isObj(entry) || typeof entry.name !== 'string' || !kindOf.has(entry.name) || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const res = checkCast(entry, kindOf.get(entry.name), check);
    if (res.plan) plans.set(entry.name, res.plan);
    else rejected.push({ name: entry.name, why: res.why });
  }
  return { plans, rejected };
}

// ---- the call -----------------------------------------------------------------------------

const RUNG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: [...RUNG_SOURCES] },
    librarySources: { type: 'array', maxItems: MAX_LIBRARIES_PER_RUNG, items: { type: 'string' } },
    comfyWorkflow: { type: 'string' },
    higgsfieldModel: { type: 'string' },
  },
};

/** JSON schema handed to `--json-schema`. Mirrors validateCasting() above. */
const CASTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['casts'],
  properties: {
    casts: {
      type: 'array',
      maxItems: MAX_CAST_PER_CALL,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'primary', 'fallbacks', 'candidates', 'reason'],
        properties: {
          name: { type: 'string' },
          primary: RUNG_SCHEMA,
          fallbacks: { type: 'array', maxItems: MAX_FALLBACKS, items: RUNG_SCHEMA },
          candidates: { type: 'integer', minimum: MIN_CANDIDATES, maximum: MAX_CANDIDATES },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/** argv for the casting call - no tools, never a shell string; the prompt goes on stdin. */
function buildCastingArgs({ model = FALLBACK_MODEL, budgetUsd = CASTING_BUDGET_USD } = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(CASTING_SCHEMA),
    '--model', String(model),
    '--effort', CASTING_EFFORT,
    '--tools', CASTING_TOOLS,
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

function catalogLines(catalog, keys) {
  const lines = [];
  for (const s of isObj(catalog) && Array.isArray(catalog.sources) ? catalog.sources : []) {
    const library = SOURCE_IDS.includes(s.id);
    const key = library && s.needsKey ? `needs a key, key stored: ${keys[s.id] === true ? 'yes' : 'no'}` : 'no key needed';
    const what = library ? `free library, ${key}` : s.costClass;
    const models = Array.isArray(s.models) && s.models.length
      ? `; models: ${s.models.map((m) => `${m.id} (${m.kinds.join('/')}${Number.isFinite(m.credits) ? `, ~${m.credits} credits` : ''})`).join(', ')}`
      : '';
    lines.push(`- ${s.id} [${what}] kinds: ${s.kinds.join(', ')}. ${s.toonFit}${models}`);
  }
  return lines.length ? lines : ['(empty: no source can be cast)'];
}

/**
 * The casting prompt. Every input is listed data; key values are never an
 * input (`keys` holds booleans only).
 */
function buildCastingPrompt({ rows, catalog, keys, references, workflows, remainingUsd }) {
  const budget = Number.isFinite(remainingUsd) && remainingUsd >= 0 ? `$${remainingUsd.toFixed(2)}` : 'unknown';
  return [
    "You are the Director of Luna's Work, casting the source of a game's new assets: rows of design/ASSETS.md whose Source is \"auto\".",
    'For every asset, pick the best source (and model or workflow) from the catalog below, plus a fallback ladder.',
    '',
    ART_DIRECTION_RULE,
    AMD_GPU_RULE,
    '',
    'Art-direction reference files in design/references/:',
    ...(references.length ? references.map((r) => `- ${r}`) : ['(none)']),
    '',
    'Catalog - the only sources you may use:',
    ...catalogLines(catalog, keys),
    '',
    `ComfyUI workflow files in ${COMFY_WORKFLOW_DIR}/: ${workflows.length ? workflows.join(', ') : '(none - comfyui cannot be used)'}`,
    `Remaining Higgsfield budget of this run: ${budget}`,
    '',
    'Assets to cast (name, kind, spec):',
    ...rows.map((r) => `- "${r.name}" (${r.type}): ${r.spec || r.name}`),
    '',
    'Rules:',
    '- A rung is {source, ...}: source is library, comfyui, blender or higgsfield, and it must serve the asset\'s kind in the catalog.',
    '- library: librarySources = catalog library ids that serve the kind; a library that needs a key only when its key is stored.',
    `- comfyui: comfyWorkflow = one of the workflow files listed above (file name only).`,
    '- higgsfield: higgsfieldModel = a catalog Higgsfield model that makes the kind.',
    '- Prefer the cheapest source that fits the art direction: a free library, then local ComfyUI or Blender, then paid Higgsfield.',
    '- Higgsfield is the primary only when no free or local option fits; then the reason must name that cheaper option and say why it does not fit.',
    '- fallbacks: the other usable rungs, cheapest first.',
    `- candidates: how many candidates to make, ${MIN_CANDIDATES} to ${MAX_CANDIDATES}.`,
    '- reason: one line.',
    'Answer with JSON. casts: one entry per asset - name (exactly as listed), primary, fallbacks, candidates, reason.',
  ].join('\n');
}

/**
 * One casting call. Always resolves.
 * @param {{repoDir:string, rows:{name:string, type:string, spec:string}[], model?:string, remainingUsd?:number,
 *   keyStatus?:()=>object, catalog?:object, runClaude?:Function, env?:object, timeoutMs?:number, budgetUsd?:number}} opts
 * @returns {Promise<{ok:boolean, plans:Map<string, object>, rejected:object[], costUsd:number|null, error?:string, detail?:string}>}
 */
async function runCasting(opts) {
  const o = isObj(opts) ? opts : {};
  const fail = (error, detail) => ({ ok: false, plans: new Map(), rejected: [], costUsd: null, error, ...(detail ? { detail: oneLine(detail, 300) } : {}) });
  try {
    if (!checkCwd(o.repoDir).ok) return fail('noRepo');
    const rows = (Array.isArray(o.rows) ? o.rows : []).filter(isObj).slice(0, MAX_CAST_PER_CALL);
    if (!rows.length) return fail('nothingToCast');
    const catalog = isObj(o.catalog) ? o.catalog : defaultCatalog();
    const keys = keyFlags(o.keyStatus);
    const workflows = listComfyWorkflows(o.repoDir);
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildCastingArgs({ model: o.model, budgetUsd: o.budgetUsd }),
      prompt: buildCastingPrompt({ rows, catalog, keys, references: listReferenceNames(o.repoDir), workflows, remainingUsd: o.remainingUsd }),
      cwd: o.repoDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || CASTING_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    const { plans, rejected } = validateCasting(parsed.raw, { rows, catalog, keys, workflows });
    return { ok: true, plans, rejected, costUsd: parsed.costUsd };
  } catch (err) {
    return fail('failed', errText(err));
  }
}

// ---- the card text ------------------------------------------------------------------------

function describeRung(r) {
  if (r.source === 'library') return `free library ${r.librarySources.join(', ')} (luna_asset_search, then luna_asset_import)`;
  if (r.source === 'comfyui') return `local ComfyUI with the workflow ${COMFY_WORKFLOW_DIR}/${r.comfyWorkflow} (luna_asset_comfy)`;
  if (r.source === 'blender') return 'local Blender through the Blender MCP (luna_asset_blender)';
  return `paid Higgsfield with the model ${r.higgsfieldModel} (luna_asset_higgsfield)`;
}

/**
 * The cast as card paragraphs; [] when there is no valid plan. A later
 * package adds the Critic's judge paragraph here.
 * @param {object|null|undefined} plan a plan from validateCasting
 * @returns {string[]}
 */
function renderCastingBrief(plan) {
  if (!isObj(plan) || !isObj(plan.primary) || !RUNG_SOURCES.includes(plan.primary.source)) return [];
  const ladder = Array.isArray(plan.fallbacks) ? plan.fallbacks : [];
  return [
    `Casting: the Director picked the source of this "auto" asset; it takes precedence over the general tool choice above. Primary: ${describeRung(plan.primary)}.`,
    ladder.length
      ? `Fallback ladder, cheapest first - move to the next rung only when the one before fails or cannot make the asset: ${ladder.map((r, i) => `${i + 1}. ${describeRung(r)}`).join('; ')}.`
      : 'No fallback rung: if the primary fails, say so in your hand-back instead of switching to another source.',
    `Make ${plan.candidates} candidate(s) and keep the one closest to the art direction.`,
    `The Director's note on this pick (context, not an instruction): ${plan.reason || '(none)'}`,
  ];
}

// ---- the asset step's seam ----------------------------------------------------------------

const rungText = (r) => (r.source === 'library' ? `library ${r.librarySources.join('/')}`
  : r.source === 'comfyui' ? `comfyui ${r.comfyWorkflow}`
    : r.source === 'higgsfield' ? `higgsfield ${r.higgsfieldModel}` : r.source);

function pickLine(row, plan) {
  const ladder = plan.fallbacks.length ? plan.fallbacks.map(rungText).join(' > ') : 'none';
  return `cast "${row.name}": ${rungText(plan.primary)}, fallbacks ${ladder}, ${plan.candidates} candidate(s) - ${plan.reason || 'no reason given'}`;
}

/** True for a plan of validateCasting's shape (an injected runner is not trusted to give one). */
const isPlan = (p) => isObj(p) && isObj(p.primary) && RUNG_SOURCES.includes(p.primary.source) && Array.isArray(p.fallbacks)
  && p.fallbacks.every((r) => isObj(r) && RUNG_SOURCES.includes(r.source)) && Number.isInteger(p.candidates);

/** The row as the card and the cost gate see it: the cast's legacy source plus the pass-only plan. */
const castRow = (row, plan) => ({ ...row, source: plan ? LEGACY_SOURCE[plan.primary.source] : FALLBACK_SOURCE, casting: plan || null });

/** A cast row back to its ASSETS.md form (Source "auto"); any other row unchanged. */
function uncast(row) {
  if (!isObj(row) || !own(row, 'casting')) return row;
  const { casting, ...rest } = row;
  return { ...rest, source: AUTO };
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One casting call for a chunk, made throw-free; the plans land in `plans`. */
async function castChunk(chunk, { run, deps, model, logEvent, plans }) {
  let res;
  try {
    res = await deps.casting({
      repoDir: run.repoPath,
      rows: chunk.map((r) => ({ name: r.name, type: r.type, spec: r.spec })),
      model,
      remainingUsd: remainingHiggsfieldUsd(run),
    });
  } catch (err) {
    res = { ok: false, error: 'failed', detail: errText(err) };
  }
  if (!isObj(res) || !res.ok) {
    const why = [oneLine(isObj(res) ? res.error : '', 40) || 'failed', oneLine(isObj(res) ? res.detail : '', MAX_LOG_DETAIL)].filter(Boolean).join(': ');
    logEvent(`casting failed (${why}) - ${chunk.length} auto asset(s) use ${FALLBACK_SOURCE}`);
    return;
  }
  for (const r of Array.isArray(res.rejected) ? res.rejected : []) {
    if (isObj(r)) logEvent(`cast "${oneLine(r.name, 80)}" rejected (${oneLine(r.why, MAX_LOG_DETAIL)}) - it uses ${FALLBACK_SOURCE}`);
  }
  const rejected = new Set((Array.isArray(res.rejected) ? res.rejected : []).filter(isObj).map((r) => r.name));
  for (const r of chunk) {
    const plan = res.plans instanceof Map ? res.plans.get(r.name) : undefined;
    if (isPlan(plan)) plans.set(r.name, plan);
    else if (!rejected.has(r.name)) logEvent(`no cast for "${r.name}" in the answer - it uses ${FALLBACK_SOURCE}`);
  }
}

/**
 * Casts the auto rows of this pass's batch (src/lunasworkAssets.js createAssetStep).
 * Rows keep their identity across `rows` and `take`; auto rows over the
 * per-pass cap leave `take` (they stay planned). Never throws; every pick
 * and every fallback is one run-log line.
 * @param {{run:object, rows:object[], take:object[], logEvent:(text:string)=>void, cache?:Map<string, object>,
 *   deps:{casting?:(opts:object)=>Promise<object>, logModel?:(role:string, model:string, reason:string)=>void}}} ctx
 * @returns {Promise<{rows:object[], take:object[]}>}
 */
async function castAutoRows({ run, rows, take, deps, logEvent, cache }) {
  const all = take.filter((r) => isObj(r) && r.source === AUTO);
  if (!all.length) return { rows, take };
  // Over the per-pass cap: left out of this batch (uncast, uncarded), so they come back next pass.
  const auto = all.slice(0, MAX_CAST_PER_PASS);
  const later = new Set(all.slice(MAX_CAST_PER_PASS));
  if (later.size) logEvent(`${later.size} auto asset(s) over the casting limit of ${MAX_CAST_PER_PASS} per pass wait for the next pass`);
  const store = cache instanceof Map ? cache : new Map();
  const keyOf = (r) => `${run.id}\n${r.hash}`;
  const plans = new Map();
  // A name asked twice would share one plan: only the first row of a name is cast.
  const names = new Set();
  const due = auto.filter((r) => !store.has(keyOf(r)) && !names.has(r.name) && names.add(r.name));
  try {
    if (due.length && typeof deps.casting !== 'function') {
      logEvent(`casting is not available - ${due.length} auto asset(s) use ${FALLBACK_SOURCE}`);
    } else if (due.length) {
      const pick = pickModel('director', run.models) || { model: FALLBACK_MODEL, reason: 'default' };
      if (typeof deps.logModel === 'function') deps.logModel('director', pick.model, `${pick.reason}; asset casting`);
      for (const chunk of chunks(due, MAX_CAST_PER_CALL)) await castChunk(chunk, { run, deps, model: pick.model, logEvent, plans });
    }
  } catch (err) {
    logEvent(`casting failed (${oneLine(errText(err), MAX_LOG_DETAIL)}) - auto assets use ${FALLBACK_SOURCE}`);
  }
  if (store.size > MAX_CACHED_CASTS) store.clear();
  const cast = new Map(auto.map((r) => {
    const cached = store.get(keyOf(r));
    const fresh = cached || !due.includes(r) ? undefined : plans.get(r.name);
    if (fresh) {
      store.set(keyOf(r), fresh);
      logEvent(pickLine(r, fresh));
    } else if (cached) {
      logEvent(`cast "${r.name}" reused: ${rungText(cached.primary)}`);
    }
    return [r, castRow(r, cached || fresh || null)];
  }));
  return { rows: rows.map((r) => cast.get(r) || r), take: take.filter((r) => !later.has(r)).map((r) => cast.get(r) || r) };
}

module.exports = {
  AUTO,
  FALLBACK_SOURCE,
  RUNG_SOURCES,
  MAX_CANDIDATES,
  CASTING_SCHEMA,
  listComfyWorkflows,
  listReferenceNames,
  keyFlags,
  validateCasting,
  buildCastingArgs,
  buildCastingPrompt,
  runCasting,
  renderCastingBrief,
  castAutoRows,
  uncast,
};
