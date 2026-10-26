// ============================================================================
// LunaCore - Luna's Work web quality budgets (docs/LUNAS_WORK_PLAN.md, B7,
// slice 2.19b)
// ----------------------------------------------------------------------------
// A separate headless `claude -p --json-schema` step whose ONLY allowed tools
// are chrome-devtools MCP tools: it runs Lighthouse (performance,
// accessibility, best practices, SEO) on every given route, desktop and
// mobile, and answers with the scores and each report's JSON path. The
// routes are an input - the caller derives them from TEST_PLAN.md.
//
// Budgets: a score below its budget, or a fall of more than `dropPoints` vs
// the last green iteration, becomes a card - `bug` for accessibility, `feel`
// for performance, `missing` for best practices and SEO - with the report
// path as evidence. Cards pass the Critic's trust boundary (validateCritique
// in src/lunasworkCritic.js) and come back tagged run:<id>, kind:<x>, sev:<x>
// and lighthouse. Results are kept per iteration, immutably, for the
// dashboard trend. Nothing is written here - the controller stores and files.
//
// A failing run resolves to {results: [], notes: ['lighthouse failed: ...']}
// and never throws.
//
// Exports
//   CATEGORIES        string[]  ['performance', 'accessibility', 'bestPractices', 'seo']
//   DEVICES           string[]  ['desktop', 'mobile']
//   DEFAULT_BUDGETS   {performance:80, accessibility:90, bestPractices:90, seo:90}
//   DEFAULT_DROP_POINTS number  5
//   LIGHTHOUSE_TAG    string    'lighthouse'
//   LIGHTHOUSE_SCHEMA object    JSON schema handed to --json-schema ({results})
//   lighthouseTools(server?:string) -> string[]
//       The allowed MCP tool names, all 'mcp__<server>__*' (default server 'chrome-devtools').
//   buildLighthouseArgs({model?, budgetUsd?, server?, mcpConfig?}) -> string[]
//       argv (no shell string; prompt on stdin). Built-in tools off (--tools ''),
//       --strict-mcp-config with only the chrome-devtools server.
//   buildLighthousePrompt({routes:string[], reportDir:string}) -> string
//   validateLighthouse(raw:unknown, {routes?:string[]}?) -> {results:Result[], errors:object[]}
//       Pure. Result = {route, device, scores:{[category]:number 0-100}, reportPath}
//   budgetsFrom(settings:unknown) -> Budgets
//       Pure. settings.lighthouseBudgets merged over DEFAULT_BUDGETS; bad values keep the default.
//   budgetCards({results, lastGreen?, budgets?, dropPoints?, runId}) -> {cards, breaches, warnings, errors}
//       Pure. lastGreen: Result[] or a history entry {results}.
//   appendResult(history:Entry[], iteration:number, results:Result[]) -> Entry[]
//       Pure; returns a new frozen list sorted by iteration (same iteration replaced).
//       Entry = {iteration, results}
//   trend(history:Entry[]) -> {iteration, scores:{[category]:number|null}}[]
//       Pure. Per iteration, the worst score of each category across routes and devices.
//   runLighthouse({routes, repoPath, reportDir, model?, runClaude?, env?, log?,
//       timeoutMs?, budgetUsd?, server?, mcpConfig?}) -> Promise<{results, notes, costUsd}>
//     runClaude({args, prompt, cwd, env, timeoutMs}) -> Promise<{stdout}|{error, detail?}>
//         (default: lunasworkCritic.execClaude)
//     log(message:string, detail?:unknown) -> void (default: no-op)
// ============================================================================

'use strict';

const { parsePlannerOutput } = require('./orchestraPlan');
const { DEFAULT_MODELS } = require('./lunasworkRules');
const { runTag, cleanTags } = require('./todorows');
const { validateCritique, execClaude } = require('./lunasworkCritic');

const CATEGORIES = ['performance', 'accessibility', 'bestPractices', 'seo'];
const DEVICES = ['desktop', 'mobile'];
const DEFAULT_BUDGETS = Object.freeze({ performance: 80, accessibility: 90, bestPractices: 90, seo: 90 });
const DEFAULT_DROP_POINTS = 5;
const LIGHTHOUSE_TAG = 'lighthouse';
const CATEGORY_KIND = Object.freeze({ performance: 'feel', accessibility: 'bug', bestPractices: 'missing', seo: 'missing' });
const CATEGORY_LABEL = Object.freeze({
  performance: 'Performance', accessibility: 'Accessibility', bestPractices: 'Best practices', seo: 'SEO',
});
// A score this many points under budget is a high-severity card.
const HIGH_SEVERITY_GAP = 20;

const DEFAULT_SERVER = 'chrome-devtools';
// chrome-devtools-mcp tool names: navigate to a route, then audit it.
const MCP_TOOL_NAMES = ['navigate_page', 'lighthouse_audit'];
const DEFAULT_MCP_CONFIG = Object.freeze({
  mcpServers: { [DEFAULT_SERVER]: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'] } },
});
// A measurement, not a judgement: the playtester's model is enough.
const LIGHTHOUSE_ROLE = 'playtester';
const LIGHTHOUSE_EFFORT = 'low';
const LIGHTHOUSE_BUDGET_USD = 1;
const LIGHTHOUSE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ROUTES = 20;
const MAX_ROUTE_CHARS = 500;
const MAX_PATH_CHARS = 1000;
const MAX_NOTE_CHARS = 300;
const SERVER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const scoreSchema = { type: 'number', minimum: 0, maximum: 100 };

/** JSON schema handed to `--json-schema`. Mirrors validateLighthouse() below. */
const LIGHTHOUSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      maxItems: MAX_ROUTES * DEVICES.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['route', 'device', 'scores', 'reportPath'],
        properties: {
          route: { type: 'string' },
          device: { type: 'string', enum: DEVICES },
          scores: {
            type: 'object',
            additionalProperties: false,
            required: CATEGORIES,
            properties: Object.fromEntries(CATEGORIES.map((c) => [c, scoreSchema])),
          },
          reportPath: { type: 'string' },
        },
      },
    },
  },
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => String(s === undefined || s === null ? '' : s).slice(0, max);
const isScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const noop = () => {};

// ---- the headless step -----------------------------------------------------------------

/** The allowed tool names - chrome-devtools MCP tools only. */
function lighthouseTools(server = DEFAULT_SERVER) {
  const name = SERVER_RE.test(server) ? server : DEFAULT_SERVER;
  return MCP_TOOL_NAMES.map((t) => `mcp__${name}__${t}`);
}

/** argv for the headless Lighthouse call - never a shell string; the prompt goes on stdin. */
function buildLighthouseArgs({
  model = DEFAULT_MODELS[LIGHTHOUSE_ROLE],
  budgetUsd = LIGHTHOUSE_BUDGET_USD,
  server = DEFAULT_SERVER,
  mcpConfig = DEFAULT_MCP_CONFIG,
} = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(LIGHTHOUSE_SCHEMA),
    '--model', model,
    '--effort', LIGHTHOUSE_EFFORT,
    // No built-in tool at all (no Bash, Read, Edit...): only the MCP tools below.
    '--tools', '',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--allowedTools', lighthouseTools(server).join(','),
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

function cleanRoutes(routes) {
  if (!Array.isArray(routes)) return [];
  const list = routes
    .filter((r) => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r && r.length <= MAX_ROUTE_CHARS && !/\s/.test(r));
  return [...new Set(list)].slice(0, MAX_ROUTES);
}

/** The Lighthouse prompt: routes, devices, categories, and where reports go. */
function buildLighthousePrompt({ routes, reportDir }) {
  const list = cleanRoutes(routes);
  return [
    "You are the Lighthouse step of Luna's Work. Use ONLY the chrome-devtools tools.",
    `For EVERY route below, run a Lighthouse audit for each device (${DEVICES.join(', ')}), covering`,
    'performance, accessibility, best practices and SEO. Navigate to the route first when the audit needs it.',
    `Save each JSON report under ${reportDir || 'the default report directory'} and give its file path.`,
    'Answer ONLY with JSON {"results": [...]}. Each result: route (as given), device, scores',
    '{performance, accessibility, bestPractices, seo} as numbers 0-100 (Lighthouse score x 100), reportPath.',
    'If a route cannot be audited, leave it out - never invent a score.',
    '',
    '## Routes',
    ...list.map((r) => `- ${r}`),
  ].join('\n');
}

/**
 * Validates the step's reply. Never throws. A reply without a results list is
 * malformed as a whole; a bad single result is dropped with an error entry.
 * @param {unknown} raw
 * @param {{routes?:string[]}} [ctx] when given, only these routes are kept
 */
function validateLighthouse(raw, ctx = {}) {
  if (!isObj(raw) || !Array.isArray(raw.results)) return { results: [], errors: [{ code: 'badLighthouse' }] };
  const allowed = isObj(ctx) && Array.isArray(ctx.routes) ? new Set(cleanRoutes(ctx.routes)) : null;
  const errors = [];
  const seen = new Set();
  const results = [];
  for (const r of raw.results.slice(0, MAX_ROUTES * DEVICES.length)) {
    const route = isObj(r) && typeof r.route === 'string' ? r.route.trim() : '';
    const ok = route && route.length <= MAX_ROUTE_CHARS && DEVICES.includes(r.device) && isObj(r.scores)
      && CATEGORIES.every((c) => isScore(r.scores[c])) && typeof r.reportPath === 'string' && r.reportPath.trim();
    if (!ok) { errors.push({ code: 'badResult', route }); continue; }
    if (allowed && !allowed.has(route)) { errors.push({ code: 'unknownRoute', route }); continue; }
    const key = `${route}\n${r.device}`;
    if (seen.has(key)) { errors.push({ code: 'duplicateResult', route }); continue; }
    seen.add(key);
    results.push(Object.freeze({
      route,
      device: r.device,
      scores: Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c, Math.round(r.scores[c])]))),
      reportPath: clip(r.reportPath.trim(), MAX_PATH_CHARS),
    }));
  }
  return { results, errors };
}

// ---- budgets -----------------------------------------------------------------------------

/** settings.lighthouseBudgets merged over the defaults; a bad value keeps its default. */
function budgetsFrom(settings) {
  const src = isObj(settings) && isObj(settings.lighthouseBudgets) ? settings.lighthouseBudgets : {};
  return Object.freeze(Object.fromEntries(
    CATEGORIES.map((c) => [c, isScore(src[c]) ? src[c] : DEFAULT_BUDGETS[c]]),
  ));
}

const resultsOf = (v) => {
  if (Array.isArray(v)) return v;
  return isObj(v) && Array.isArray(v.results) ? v.results : [];
};

function goodDrop(points) {
  return typeof points === 'number' && Number.isFinite(points) && points >= 0 ? points : DEFAULT_DROP_POINTS;
}

/** Every budget breach: one per result and category that is below budget or dropped. */
function findBreaches(results, lastGreen, budgets, dropPoints) {
  const before = new Map(
    resultsOf(lastGreen).filter((r) => isObj(r) && isObj(r.scores)).map((r) => [`${r.route}\n${r.device}`, r.scores]),
  );
  return results.flatMap((r) => CATEGORIES.flatMap((category) => {
    const score = r.scores[category];
    const prev = before.get(`${r.route}\n${r.device}`);
    const last = prev && isScore(prev[category]) ? prev[category] : null;
    const below = score < budgets[category];
    const dropped = last !== null && last - score > dropPoints;
    if (!below && !dropped) return [];
    return [{ route: r.route, device: r.device, category, score, budget: budgets[category], last, below, dropped, reportPath: r.reportPath }];
  }));
}

function breachLine(b) {
  const parts = [`${b.device}: ${b.score}`];
  if (b.below) parts.push(`budget ${b.budget}`);
  if (b.dropped) parts.push(`was ${b.last} at the last green iteration`);
  return `- ${parts.join(', ')} (report: ${b.reportPath})`;
}

/** One card per route and category; both devices listed in it. */
function breachCard(group) {
  const { route, category } = group[0];
  const worst = Math.min(...group.map((b) => b.score));
  const gap = Math.max(...group.map((b) => b.budget - b.score));
  const below = group.some((b) => b.below);
  const label = CATEGORY_LABEL[category];
  const reports = [...new Set(group.map((b) => b.reportPath))];
  return {
    kind: CATEGORY_KIND[category],
    severity: below && gap >= HIGH_SEVERITY_GAP ? 'high' : 'medium',
    text: below
      ? `${label} ${worst} on ${route} is below its budget of ${group[0].budget}`
      : `${label} on ${route} dropped to ${worst} since the last green iteration`,
    details: [
      `Lighthouse ${label.toLowerCase()} on ${route}:`,
      ...group.map(breachLine),
      `Evidence: ${reports.join(', ')}`,
      'Read the failing audits in the report and fix their causes.',
    ].join('\n'),
    acceptance: [`Lighthouse ${label.toLowerCase()} on ${route} is at least ${group[0].budget} on desktop and mobile`],
    files: reports,
  };
}

/**
 * Pure. Budget breaches and drops as cards.
 * @param {{results:object[], lastGreen?:object[]|{results:object[]}, budgets?:object,
 *   dropPoints?:number, runId:string}} input
 */
function budgetCards({ results, lastGreen, budgets, dropPoints, runId } = {}) {
  const tag = runTag(runId);
  if (!tag) return { cards: [], breaches: [], warnings: [], errors: [{ code: 'badRunId' }] };
  const { results: clean } = validateLighthouse({ results: resultsOf(results) });
  const breaches = findBreaches(clean, lastGreen, budgetsFrom({ lighthouseBudgets: budgets }), goodDrop(dropPoints));
  const groups = new Map();
  for (const b of breaches) {
    const key = `${b.route}\n${b.category}`;
    groups.set(key, [...(groups.get(key) || []), b]);
  }
  const critique = validateCritique(
    { cards: [...groups.values()].map(breachCard), logEntry: {}, architecture: '', decisions: [], newJourneys: [], verdict: 'CONTINUE' },
    { ideasAllowed: false, allPassed: false },
  );
  const cards = critique.cards.map((c) => ({
    ...c,
    tags: cleanTags([tag, `kind:${c.kind}`, `sev:${c.severity}`, LIGHTHOUSE_TAG]),
    // lunasworkCritic.applyCards adds run/kind/sev itself and keeps these.
    extraTags: [LIGHTHOUSE_TAG],
  }));
  return { cards, breaches, warnings: critique.warnings, errors: critique.errors };
}

// ---- history -----------------------------------------------------------------------------

/** Pure: a new frozen history with this iteration's results (replacing an earlier entry). */
function appendResult(history, iteration, results) {
  const list = Array.isArray(history) ? history.filter((e) => isObj(e) && Number.isInteger(e.iteration)) : [];
  if (!Number.isInteger(iteration) || iteration < 0) return Object.freeze([...list]);
  const entry = Object.freeze({ iteration, results: Object.freeze(validateLighthouse({ results: resultsOf(results) }).results) });
  return Object.freeze([...list.filter((e) => e.iteration !== iteration), entry].sort((a, b) => a.iteration - b.iteration));
}

/** Pure: per iteration, the worst score of each category (null when not measured). */
function trend(history) {
  const list = Array.isArray(history) ? history.filter((e) => isObj(e) && Number.isInteger(e.iteration)) : [];
  return [...list]
    .sort((a, b) => a.iteration - b.iteration)
    .map((e) => {
      const rs = resultsOf(e).filter((r) => isObj(r) && isObj(r.scores));
      const worst = (c) => {
        const vals = rs.map((r) => r.scores[c]).filter(isScore);
        return vals.length ? Math.min(...vals) : null;
      };
      return { iteration: e.iteration, scores: Object.fromEntries(CATEGORIES.map((c) => [c, worst(c)])) };
    });
}

// ---- run ---------------------------------------------------------------------------------

/**
 * The B7 step. Never rejects: any failure becomes {results: [], notes: ['lighthouse failed: ...']}.
 * @param {object} opts see the header
 */
async function runLighthouse(opts) {
  const o = isObj(opts) ? opts : {};
  const log = typeof o.log === 'function' ? o.log : noop;
  const failed = (reason, detail) => {
    log(`lighthouse failed: ${reason}`, detail);
    const why = detail ? `${reason} (${clip(detail, MAX_NOTE_CHARS)})` : reason;
    return { results: [], notes: [`lighthouse failed: ${why}`], costUsd: null };
  };
  try {
    const routes = cleanRoutes(o.routes);
    if (!routes.length) return failed('noRoutes');
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildLighthouseArgs({ model: o.model, budgetUsd: o.budgetUsd, server: o.server, mcpConfig: o.mcpConfig }),
      prompt: buildLighthousePrompt({ routes, reportDir: o.reportDir }),
      cwd: o.repoPath,
      env: o.env,
      timeoutMs: o.timeoutMs || LIGHTHOUSE_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return failed((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return failed(parsed.error, parsed.detail);
    const { results, errors } = validateLighthouse(parsed.raw, { routes });
    if (!results.length) return failed(errors.length ? errors[0].code : 'noResults');
    const notes = errors.length ? [`lighthouse: ${errors.length} result(s) dropped as invalid`] : [];
    return { results, notes, costUsd: parsed.costUsd };
  } catch (err) {
    return failed('crashed', err && err.message);
  }
}

module.exports = {
  CATEGORIES,
  DEVICES,
  DEFAULT_BUDGETS,
  DEFAULT_DROP_POINTS,
  LIGHTHOUSE_TAG,
  LIGHTHOUSE_SCHEMA,
  lighthouseTools,
  buildLighthouseArgs,
  buildLighthousePrompt,
  validateLighthouse,
  budgetsFrom,
  budgetCards,
  appendResult,
  trend,
  runLighthouse,
};
