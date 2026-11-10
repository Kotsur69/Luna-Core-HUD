// ============================================================================
// LunaCore - God Mode v2 planner (DONE_ORCHESTRATOR_PLAN.md, build slice 3)
// ----------------------------------------------------------------------------
// Turns a project's open to-dos into work packages with ONE headless call:
// `claude -p --output-format json --json-schema <PLAN_SCHEMA>`, run in the
// project root with read-only tools. Planning is a single structured answer,
// not a conversation - no tab, no TUI scraping.
//
// THE TRUST BOUNDARY IS validatePlan(). The schema makes a well-formed reply
// likely, not guaranteed, and the reply is model output either way: ids are
// re-slugged, strings capped, to-do references checked against the list THIS
// process read, unknown dependencies dropped. Nothing in a plan can name a
// folder, a branch or a command that LunaCore runs - the worktree path and
// branch are derived from the package id in main, `verify` is only shown and
// handed to the worker as text.
//
// Same "always resolves, never rejects" shape as ask.js's runAsk().
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const { isUsageLimitText } = require('./orchestraPlanWait');
const { checkCwd } = require('./projects');
const { EFFORTS, normalizeEffort } = require('./efforts');
const { CLAUDE_MODELS } = require('./claudeModels');
const { usageFromEnvelope } = require('./orchestraUsage');
const { FREE_PLANNER_MODEL, planContextLines } = require('./orchestraPlanBuild');

const PLANNER_MODEL = 'opus';
// The Claude CLI model aliases Mati may pick for the planner in the to-do
// picker (and Luna's Work passes for its builds). Anything else plans on
// PLANNER_MODEL. The spend cap and timeout stay per effort (PLANNER_CAPS).
const PLANNER_MODELS = CLAUDE_MODELS;
// Planning reads code across the repo and weighs grouping: one notch above
// routine by default. Mati can pick another level per plan in the to-do picker.
const PLANNER_EFFORT = 'high';
// Spend cap and wall-clock timeout per planner effort. Opus at high effort over
// a big to-do set (e.g. 9 packages, ~$2.3) can run past 8 min; a timeout throws
// the whole plan away, so every level leaves headroom. A headless session's
// startup context alone (hooks, plugins, MCP tool schemas) can cost ~$1.5-2
// before the first file is read, so the caps sit well above that floor.
// Keys = src/efforts.js EFFORTS.
const PLANNER_CAPS = Object.freeze({
  medium: Object.freeze({ budgetUsd: 4, timeoutMs: 10 * 60 * 1000 }),
  high: Object.freeze({ budgetUsd: 6, timeoutMs: 15 * 60 * 1000 }),
  xhigh: Object.freeze({ budgetUsd: 8, timeoutMs: 20 * 60 * 1000 }),
  max: Object.freeze({ budgetUsd: 12, timeoutMs: 30 * 60 * 1000 }),
});
// Read-only: the planner may look at the code, never change it.
const PLANNER_TOOLS = 'Read,Grep,Glob';

const MAX_PACKAGES = 12;
const MAX_ID_CHARS = 24;
const MAX_TITLE_CHARS = 120;
const MAX_PROMPT_CHARS = 8000;
const MAX_NOTES_CHARS = 2000;
const MAX_FILES = 50;
const MAX_FILE_CHARS = 300;
const MAX_VERIFY_CHARS = 300;

// Default parallel workers (DONE_ORCHESTRATOR_PLAN.md "Max parallel").
const MAX_PARALLEL = 3;

// Rough wall-clock minutes per card size, for the pre-launch estimate (idea
// #3). A card without a size counts as M. Deliberately coarse: the point is
// "about an hour" vs "most of the night", not a schedule.
const SIZE_MINUTES = { S: 20, M: 45, L: 90 };
const DEFAULT_MINUTES = SIZE_MINUTES.M;

const MODELS = ['sonnet', 'opus'];
// What a validated package may carry. The planner is only ever OFFERED MODELS
// (schema enum + prompt, both pinned by test/orchestraPlan.test.js): 'fable'
// is a manual choice - Luna's Work sets it on a package from its builder model
// (lunasworkBuild.wrapPlanner) - and must survive validatePlan().
const PACKAGE_MODELS = [...MODELS, 'fable'];

/** JSON schema handed to `--json-schema`. Mirrors validatePlan() below. */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['packages', 'notes'],
  properties: {
    packages: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PACKAGES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'todoAts', 'prompt', 'files', 'dependsOn', 'verify', 'model', 'effort'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,23}$' },
          title: { type: 'string', maxLength: MAX_TITLE_CHARS },
          todoAts: { type: 'array', items: { type: 'number' } },
          prompt: { type: 'string', maxLength: MAX_PROMPT_CHARS },
          files: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          verify: { type: 'string' },
          model: { type: 'string', enum: MODELS },
          effort: { type: 'string', enum: EFFORTS },
        },
      },
    },
    notes: { type: 'string' },
  },
};

// Hybrid runs (FREE_GODMODE_V2_PLAN.md F6): "Plan with free models in mind"
// adds "free" to the per-package model. A Claude-only run never sees it.
const HYBRID_MODELS = [...MODELS, 'free'];
const HYBRID_PLAN_SCHEMA = (() => {
  const items = PLAN_SCHEMA.properties.packages.items;
  return {
    ...PLAN_SCHEMA,
    properties: {
      ...PLAN_SCHEMA.properties,
      packages: {
        ...PLAN_SCHEMA.properties.packages,
        items: { ...items, properties: { ...items.properties, model: { type: 'string', enum: HYBRID_MODELS } } },
      },
    },
  };
})();

/** The schema for a run: hybrid adds "free" to the model enum. */
function planSchemaFor(hybrid) {
  return hybrid === true ? HYBRID_PLAN_SCHEMA : PLAN_SCHEMA;
}

// The planner's rule for "free" (F6), only in a hybrid prompt.
const HYBRID_MODEL_RULES = [
  '- "model": "free" is also allowed in this run. Free models are much weaker than Claude: use "free" ONLY for small, mechanical, low-risk changes - styling, layout, copy, i18n strings, a config value - in 1-2 files, with no logic, state, IPC, security, data or build changes. When in doubt: "sonnet".',
  '- A "free" package must list its files and have a "verify" command. Never mark a package "free" when it touches an entry point, preload, IPC handlers, auth / keys / secrets, migrations, package.json / lockfiles, build config, CI or test infrastructure.',
];

/** Trimmed, capped string ('' when unusable). */
function clean(raw, max) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/** Package id: lower-case a-z0-9 and single dashes, like worktrees.slugify. */
function slugId(raw) {
  return clean(raw, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_ID_CHARS)
    .replace(/^-+|-+$/g, '');
}

/**
 * The open to-dos Mati ticked in the picker. No selection (null / not an
 * array) means all of them - the pre-picker behaviour. Only `at` values of
 * the list THIS process read count; anything else the renderer sent is ignored.
 * @param {Array<{at:number}>} openTodos
 * @param {unknown} todoAts
 * @returns {Array<object>}
 */
function pickTodos(openTodos, todoAts) {
  if (!Array.isArray(todoAts)) return openTodos;
  const picked = new Set(todoAts.filter(Number.isFinite));
  return openTodos.filter((t) => picked.has(t.at));
}

/**
 * The to-do fields the planner sees - the card, minus nothing it needs.
 * @param {Array<object>} openTodos
 */
function todoBrief(openTodos) {
  return openTodos.map((t) => {
    const out = { at: t.at, text: t.text };
    for (const key of ['details', 'acceptance', 'files', 'verify', 'size', 'model', 'effort', 'dependsOn']) {
      if (t[key] !== undefined) out[key] = t[key];
    }
    return out;
  });
}

/**
 * The planner's prompt. The rules are the plan's "Rules given to the
 * planner"; the worker never sees anything but its own package prompt, so
 * that prompt has to stand on its own.
 * @param {Array<object>} openTodos
 * @returns {string}
 */
function buildPlannerPrompt(openTodos, opts = {}) {
  // Free God Mode v2 (orchestraPlanBuild.js): an approved plan as context,
  // and a follow-up request (re-size, auto-split). Without them the prompt
  // is exactly what it always was.
  const context = planContextLines(opts.planDocs);
  const extra = typeof opts.extraPrompt === 'string' && opts.extraPrompt.trim() ? ['', opts.extraPrompt.trim()] : [];
  return [
    'You are the planner for LunaCore God Mode. Split the open to-dos below into work packages.',
    'Each package is done by a separate Claude Code session in its own git worktree, in parallel with the others.',
    '',
    'Rules:',
    '- Read the code only as much as you need to name the files each package touches. Do not change anything.',
    '- Group to-dos that touch the same files into ONE package - file overlap between parallel packages causes merge conflicts.',
    '- Cover every open to-do exactly once (todoAts holds the to-dos\' "at" values).',
    '- "prompt" must be self-contained: the worker has no other context. State what to change, where, and end with a concrete definition of done.',
    '- Tell the worker to run the verify command, fix until it passes, and commit its work on the current branch. It must not push, merge or switch branches.',
    '- "dependsOn" lists other package ids that must be finished first. Mark real dependencies only.',
    '- "verify" is the command that proves the package works (e.g. "npm test"); use the to-do\'s own verify when it has one.',
    '- "model": "opus" for hard or cross-cutting work, "sonnet" otherwise.',
    ...(opts.hybrid === true ? HYBRID_MODEL_RULES : []),
    '- "effort": the to-do\'s own effort when it has one; otherwise "medium" for routine work, "high" or "xhigh" for hard or cross-cutting work, "max" only for the heaviest.',
    '- "id": short kebab-case, unique. "notes": one short paragraph on why you grouped it this way.',
    '',
    'Open to-dos (JSON):',
    JSON.stringify(todoBrief(openTodos), null, 2),
    ...context,
    ...extra,
  ].join('\n');
}

/**
 * argv for the headless planner call - never a shell string. The prompt goes
 * in on stdin, not here: a list of full task cards can outgrow the Windows
 * command-line limit (32k chars).
 */
/**
 * The planner effort to use: one of the four levels, else the default (high).
 * @param {unknown} effort
 * @returns {string}
 */
function plannerEffortOf(effort) {
  return normalizeEffort(effort) || PLANNER_EFFORT;
}

/**
 * Budget and timeout for a planner effort (an unknown level gets high's).
 * @param {unknown} effort
 * @returns {{budgetUsd:number, timeoutMs:number}}
 */
function plannerCaps(effort) {
  return PLANNER_CAPS[plannerEffortOf(effort)];
}

/**
 * The planner model to use: one of PLANNER_MODELS, else the default (opus).
 * This is the allow-list in front of the planner's `--model` flag.
 * @param {unknown} model
 * @returns {string}
 */
function plannerModelOf(model) {
  return PLANNER_MODELS.includes(model) ? model : PLANNER_MODEL;
}

function buildPlannerArgs({ model = PLANNER_MODEL, effort = PLANNER_EFFORT, budgetUsd, planner = 'claude', hybrid = false } = {}) {
  // The free planner (D1): the same call on the coding profile. The model is
  // the coding chain; no effort and no dollar cap (the CLI's cost estimate
  // means nothing on a free gateway).
  if (planner === 'free') {
    return [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(PLAN_SCHEMA),
      '--model',
      FREE_PLANNER_MODEL,
      '--tools',
      PLANNER_TOOLS,
      '--no-session-persistence',
    ];
  }
  const level = plannerEffortOf(effort);
  const budget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : plannerCaps(level).budgetUsd;
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    // Hybrid (F6) is a Claude-planned run only; the free planner never gets it.
    JSON.stringify(planSchemaFor(hybrid)),
    '--model',
    plannerModelOf(model),
    '--effort',
    level,
    '--tools',
    PLANNER_TOOLS,
    '--max-budget-usd',
    String(budget),
    '--no-session-persistence',
  ];
}

/**
 * Reads the CLI's JSON envelope. `structured_output` is where --json-schema
 * puts the answer; `result` (a JSON string) is the fallback.
 * A successful answer also carries `usage` (tokens in / out / cache, per
 * model - src/orchestraUsage.js) when the envelope reports any: additive, and
 * absent on an envelope without token counts.
 * @param {string} stdout
 * @param {string} [model] the --model of the call, for a usage without a per-model split
 * @returns {{ok:true, raw:unknown, costUsd:number|null, usage?:object} | {ok:false, error:string, detail?:string}}
 */
function parsePlannerOutput(stdout, model) {
  let env;
  try {
    env = JSON.parse(String(stdout || ''));
  } catch {
    return { ok: false, error: 'badJson' };
  }
  if (!env || typeof env !== 'object') return { ok: false, error: 'badJson' };
  const costUsd = Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : null;
  if (env.is_error) {
    const text = String(env.result || '');
    // An account usage limit (5 h / weekly) is not the planner's dollar cap:
    // orchestraPlanWait.js turns it into a wait for the reset.
    const limit = isUsageLimitText(text);
    const budget = /budget/i.test(String(env.subtype || '')) || /budget/i.test(text);
    const error = limit ? 'limit' : budget ? 'budget' : 'failed';
    return { ok: false, error, detail: clean(String(env.result || env.subtype || ''), 300) };
  }
  // Only an envelope that reports tokens adds the key: a cost alone is costUsd
  // already, and every result without token data keeps its old shape.
  const usage = usageFromEnvelope(env, model);
  const tokens = usage && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0 ? { usage } : {};
  if (env.structured_output && typeof env.structured_output === 'object') {
    return { ok: true, raw: env.structured_output, costUsd, ...tokens };
  }
  try {
    return { ok: true, raw: JSON.parse(env.result), costUsd, ...tokens };
  } catch {
    return { ok: false, error: 'badJson' };
  }
}

/** Ids reachable from `id` through dependsOn (excluding itself unless cyclic). */
function reachable(id, depsOf) {
  const seen = new Set();
  const stack = [...(depsOf.get(id) || [])];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(depsOf.get(next) || []));
  }
  return seen;
}

/**
 * Package ids in dependency order (Kahn), plus the ids stuck in a cycle.
 * @param {Array<{id:string, dependsOn:string[]}>} packages
 */
function topoOrder(packages) {
  const pending = new Map(packages.map((p) => [p.id, new Set(p.dependsOn)]));
  const order = [];
  let progressed = true;
  while (pending.size && progressed) {
    progressed = false;
    for (const [id, deps] of pending) {
      if ([...deps].every((d) => !pending.has(d))) {
        order.push(id);
        pending.delete(id);
        progressed = true;
      }
    }
  }
  return { order, cyclic: [...pending.keys()] };
}

/**
 * Validates and normalizes the planner's reply against the to-do list this
 * process read. Problems the user can judge (an uncovered to-do, two parallel
 * packages touching one file) are warnings; a dependency cycle is an error,
 * because no launch order exists.
 *
 * @param {unknown} raw planner output
 * @param {Array<{at:number, text:string}>} openTodos
 * @returns {{packages:Array<object>, notes:string, warnings:Array<object>, errors:Array<object>}}
 */
function validatePlan(raw, openTodos, { hybrid = false } = {}) {
  // "free" is a valid pick only in a hybrid plan (F6).
  const models = hybrid === true ? [...HYBRID_MODELS, 'fable'] : PACKAGE_MODELS;
  const warnings = [];
  const errors = [];
  const openAts = new Set(openTodos.map((t) => t.at));
  const claimed = new Set();
  const seenIds = new Set();
  const packages = [];

  const list = raw && typeof raw === 'object' && Array.isArray(raw.packages) ? raw.packages : [];
  for (const p of list.slice(0, MAX_PACKAGES)) {
    if (!p || typeof p !== 'object') continue;
    const id = slugId(p.id) || slugId(p.title);
    if (!id || seenIds.has(id)) {
      warnings.push({ code: 'dupPackage', id: id || '?' });
      continue;
    }
    const prompt = clean(p.prompt, MAX_PROMPT_CHARS);
    if (!prompt) {
      warnings.push({ code: 'emptyPrompt', id });
      continue;
    }
    seenIds.add(id);

    const todoAts = [];
    for (const at of Array.isArray(p.todoAts) ? p.todoAts : []) {
      if (!openAts.has(at)) warnings.push({ code: 'unknownTodo', id, at });
      else if (claimed.has(at)) warnings.push({ code: 'duplicateTodo', id, at });
      else {
        claimed.add(at);
        todoAts.push(at);
      }
    }
    if (!todoAts.length) warnings.push({ code: 'noTodos', id });

    packages.push({
      id,
      title: clean(p.title, MAX_TITLE_CHARS) || id,
      todoAts,
      prompt,
      files: (Array.isArray(p.files) ? p.files : [])
        .map((f) => clean(f, MAX_FILE_CHARS))
        .filter(Boolean)
        .slice(0, MAX_FILES),
      dependsOn: (Array.isArray(p.dependsOn) ? p.dependsOn : []).map(slugId).filter(Boolean),
      verify: clean(p.verify, MAX_VERIFY_CHARS),
      model: models.includes(p.model) ? p.model : null,
      effort: normalizeEffort(p.effort),
    });
  }

  if (!packages.length) errors.push({ code: 'empty' });

  // Dependencies on packages that do not exist (or on itself) are dropped.
  for (const p of packages) {
    const kept = [];
    for (const dep of p.dependsOn) {
      if (dep === p.id || !seenIds.has(dep)) warnings.push({ code: 'unknownDep', id: p.id, dep });
      else if (!kept.includes(dep)) kept.push(dep);
    }
    p.dependsOn = kept;
  }

  const uncovered = openTodos.filter((t) => !claimed.has(t.at));
  if (uncovered.length) warnings.push({ code: 'uncovered', texts: uncovered.map((t) => t.text.slice(0, 80)) });

  const { order, cyclic } = topoOrder(packages);
  if (cyclic.length) errors.push({ code: 'cycle', ids: cyclic });
  const rank = new Map([...order, ...cyclic].map((id, i) => [id, i]));
  packages.sort((a, b) => rank.get(a.id) - rank.get(b.id));

  // File overlap between packages that may run at the same time.
  const depsOf = new Map(packages.map((p) => [p.id, p.dependsOn]));
  for (let i = 0; i < packages.length; i += 1) {
    for (let j = i + 1; j < packages.length; j += 1) {
      const a = packages[i];
      const b = packages[j];
      if (reachable(a.id, depsOf).has(b.id) || reachable(b.id, depsOf).has(a.id)) continue;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length) warnings.push({ code: 'overlap', a: a.id, b: b.id, files: shared });
    }
  }

  return { packages, notes: clean(raw && raw.notes, MAX_NOTES_CHARS), warnings, errors };
}

/** Minutes one package is expected to take, from its to-dos' card sizes. */
function packageMinutes(pkg, todosByAt) {
  if (!pkg.todoAts.length) return DEFAULT_MINUTES;
  return pkg.todoAts.reduce((sum, at) => {
    const todo = todosByAt.get(at);
    return sum + (SIZE_MINUTES[todo && todo.size] || DEFAULT_MINUTES);
  }, 0);
}

/**
 * Pre-launch estimate (idea #3): simulates the run - at most `maxParallel`
 * packages at once, each starting when its dependencies are done - and
 * reports the wall-clock length alongside the total work.
 * @param {Array<{id:string, todoAts:number[], dependsOn:string[]}>} packages
 * @param {Array<{at:number, size?:string}>} todos
 * @param {number} [maxParallel]
 * @returns {{workers:number, wallMinutes:number, workMinutes:number}}
 */
function estimatePlan(packages, todos, maxParallel = MAX_PARALLEL) {
  const todosByAt = new Map(todos.map((t) => [t.at, t]));
  const minutes = new Map(packages.map((p) => [p.id, packageMinutes(p, todosByAt)]));
  const finishAt = new Map();
  const running = []; // [{id, end}]
  let clock = 0;
  const pending = packages.filter((p) => p.dependsOn.every((d) => minutes.has(d)));

  while (pending.length || running.length) {
    let started = true;
    while (started && running.length < maxParallel) {
      started = false;
      const idx = pending.findIndex((p) => p.dependsOn.every((d) => finishAt.has(d)));
      if (idx >= 0) {
        const [p] = pending.splice(idx, 1);
        running.push({ id: p.id, end: clock + minutes.get(p.id) });
        started = true;
      }
    }
    if (!running.length) break; // the rest waits on a cycle - not estimable
    running.sort((a, b) => a.end - b.end);
    const done = running.shift();
    clock = done.end;
    finishAt.set(done.id, clock);
  }

  const workMinutes = [...minutes.values()].reduce((a, b) => a + b, 0);
  const workers = Math.min(maxParallel, packages.filter((p) => !p.dependsOn.length).length || 1);
  return { workers, wallMinutes: clock, workMinutes };
}

/**
 * Runs the headless planner in `cwd`. Always resolves.
 * @param {{cwd:string, env:object, openTodos:Array<object>, effort?:string, execImpl?:Function, timeoutMs?:number}} args
 *   effort: the planner's --effort level (invalid/missing -> high); it also
 *   picks the budget and the timeout from PLANNER_CAPS.
 *   model: the planner's --model, one of PLANNER_MODELS (invalid/missing -> opus).
 *   planner: 'free' runs the same call on model auto:coding (the caller
 *   passes the coding profile's env); planDocs / extraPrompt extend the prompt.
 * @returns {Promise<{ok:true, raw:unknown, costUsd:number|null, durationMs:number}
 *   | {ok:false, error:'noClaude'|'timeout'|'failed'|'budget'|'badJson', detail?:string}>}
 */
function runPlanner({
  cwd,
  env,
  openTodos,
  effort = PLANNER_EFFORT,
  model = PLANNER_MODEL,
  execImpl = execFile,
  timeoutMs,
  isDirImpl = undefined,
  planner = 'claude',
  planDocs = null,
  extraPrompt = null,
  hybrid = false,
}) {
  // Hybrid (F6) only with the Claude planner: the free planner plans free-only runs.
  const hybridRun = hybrid === true && planner !== 'free';
  const level = plannerEffortOf(effort);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : plannerCaps(level).timeoutMs;
  // A missing cwd fails execFile with ENOENT - that is a missing project
  // folder, not a missing `claude`.
  if (!checkCwd(cwd, isDirImpl).ok) return Promise.resolve({ ok: false, error: 'noRepo', detail: String(cwd || '') });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execImpl(
      'claude',
      buildPlannerArgs({
        effort: level,
        // Allow-listed again here: the free planner ignores it (its model is the coding chain).
        model: plannerModelOf(model),
        planner: planner === 'free' ? 'free' : 'claude',
        ...(hybridRun ? { hybrid: true } : {}),
      }),
      { cwd, env, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error && error.code === 'ENOENT') return resolve({ ok: false, error: 'noClaude' });
        if (error && error.killed) return resolve({ ok: false, error: 'timeout' });
        // A non-zero exit still prints the JSON envelope (is_error: true),
        // which says more than the exit code - parse it when it is there.
        if (error && !stdout) {
          const detail = clean(error.message, 300);
          return resolve({ ok: false, error: isUsageLimitText(detail) ? 'limit' : 'failed', detail });
        }
        const parsed = parsePlannerOutput(stdout, planner === 'free' ? FREE_PLANNER_MODEL : plannerModelOf(model));
        resolve(parsed.ok ? { ...parsed, durationMs: Date.now() - started } : parsed);
      },
    );
    if (child && child.stdin) {
      child.stdin.on('error', () => {}); // a child that died early must not crash main
      child.stdin.end(buildPlannerPrompt(openTodos, { planDocs, extraPrompt, ...(hybridRun ? { hybrid: true } : {}) }));
    }
  });
}

module.exports = {
  PLAN_SCHEMA,
  HYBRID_PLAN_SCHEMA,
  planSchemaFor,
  PLANNER_MODEL,
  PLANNER_MODELS,
  PACKAGE_MODELS,
  plannerModelOf,
  PLANNER_EFFORT,
  PLANNER_CAPS,
  plannerEffortOf,
  plannerCaps,
  MAX_PARALLEL,
  MAX_PROMPT_CHARS,
  SIZE_MINUTES,
  slugId,
  pickTodos,
  buildPlannerPrompt,
  buildPlannerArgs,
  parsePlannerOutput,
  validatePlan,
  topoOrder,
  estimatePlan,
  runPlanner,
};
