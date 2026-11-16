// ============================================================================
// LunaCore - God Mode follow-up channel: workers file To-do cards
// ----------------------------------------------------------------------------
// God Mode runs at night. A bug, a dependency / build problem or a "you should
// also build X" a session finds would stay in a terminal nobody reads; with
// the run option `plan.followups === true` the session files it as a card.
//
// The channel is the to-do half of a SCOPED intake token (src/intake.js
// issueToken(sessionId, {scope, runId, packageId})):
//   'worker'   followups on: luna_todo_add + luna_todo_list, nothing else of
//              the to-do tools (no update, no done)
//   'godmode'  followups off: no to-do tool at all
// Memory and asset tools are not the channel's business: intake.js keeps
// them exactly as the session's store grants them (the store already limits
// what a God Mode worker may do there).
//
// A worker's add is untrusted model output. The server, not the session,
// decides: `kind` must be gap | bug | deps | idea; tags are forced to
// gm-followup + gm-<kind> + run:<runId>; manual is forced false; the details
// end with "Filed by God Mode package <packageId>"; dependsOn ids that are
// not cards of this project are dropped; a title equal to an open card's
// (trim, lowercase, collapsed whitespace) is refused as "duplicate of <at>".
// Only text, details, acceptance, size and dependsOn come from the session:
// never verify (a later run runs it in a shell), files, model or effort.
// Caps per call, per package and per run, and a few list slots always stay
// free for the user's own cards.
// Every add is recorded per run + package in the ledger, stored with the run
// (orchestra.js noteFollowups) so the run report can list it after a restart.
//
// Launch wiring (which session gets which token / flags) is in
// src/orchestraFollowupsLaunch.js.
// ============================================================================

'use strict';

const { TOOLS: INTAKE_TOOLS, applyAdd, listView, toolText } = require('./intake');
const { normalizeTodos, runTag, MAX_DETAILS_CHARS, MAX_ITEMS } = require('./todo');

const FOLLOWUP_KINDS = Object.freeze(['gap', 'bug', 'deps', 'idea']);
const FOLLOWUP_TAG = 'gm-followup';
/** Cards one luna_todo_add call of a God Mode session may file. */
const MAX_FOLLOWUPS_PER_CALL = 5;
/** Cards one package (or fix-up) may file over the whole run: a runaway session cannot flood the list. */
const MAX_FOLLOWUPS_PER_PACKAGE = 10;
/** Cards all sessions of one run may file together. */
const MAX_FOLLOWUPS_PER_RUN = 30;
/** List slots a follow-up never takes: the user's own adds keep working on a near-full list. */
const LIST_HEADROOM = 20;
/** Entries one run's record keeps (the oldest go first); above MAX_FOLLOWUPS_PER_RUN, so the caps never reset. */
const MAX_LEDGER_ENTRIES = 500;
/** A recorded title is for the report, not the card: capped. */
const MAX_LEDGER_TITLE_CHARS = 200;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/**
 * Card fields a God Mode session may set itself; everything else is decided
 * here or dropped. Never `verify` (a later run executes it in a shell), nor
 * `files` / `model` / `effort` (they steer a later worker): the card is
 * untrusted model output that reaches the next run's planner.
 */
const SESSION_CARD_KEYS = Object.freeze(['text', 'acceptance', 'size']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error) => ({ ok: false, error });

// --- tool definitions -----------------------------------------------------------

const intakeAdd = INTAKE_TOOLS.find((t) => t.name === 'luna_todo_add');
const intakeList = INTAKE_TOOLS.find((t) => t.name === 'luna_todo_list');
const intakeItem = intakeAdd.inputSchema.properties.tasks.items.properties;

const FOLLOWUP_ADD_TOOL = Object.freeze({
  name: 'luna_todo_add',
  description:
    "File a follow-up card on this project's LunaCore To-do list: a bug, a dependency or build problem, a gap " +
    'in what you were asked to build, or an idea worth building - something you found but should NOT fix in this ' +
    'task. Check luna_todo_list first; a card whose title matches an open one is refused. Does not implement anything.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_FOLLOWUPS_PER_CALL,
        items: {
          type: 'object',
          properties: {
            text: intakeItem.text,
            kind: {
              type: 'string',
              enum: [...FOLLOWUP_KINDS],
              description: 'bug = something broken; deps = dependency / build / tooling problem; gap = missing part of the feature; idea = worth building next.',
            },
            details: intakeItem.details,
            acceptance: intakeItem.acceptance,
            size: intakeItem.size,
            dependsOn: intakeItem.dependsOn,
          },
          required: ['text', 'kind'],
        },
      },
    },
    required: ['tasks'],
  },
});

/** The tools a scope's channel serves (memory / asset tools are added by intake.js). */
function channelTools(scope) {
  return scope && scope.scope === 'worker' ? [FOLLOWUP_ADD_TOOL, intakeList] : [];
}

// --- pure add rules -------------------------------------------------------------

/** A title as the duplicate check sees it: trimmed, lowercase, whitespace collapsed. */
function normalizeTitle(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** dependsOn with every reference dropped that is neither another task of this batch nor a card of this project. */
function knownDeps(raw, selfIndex, count, existingAts) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((ref) => {
    if (typeof ref !== 'number' || !Number.isFinite(ref)) return false;
    const isIndex = Number.isInteger(ref) && ref >= 0 && ref < count;
    return isIndex ? ref !== selfIndex : existingAts.has(ref);
  });
}

/** One session task as the server files it: only SESSION_CARD_KEYS kept, the rest forced. */
function forcedTask(task, index, count, existingAts, scope, runLabel) {
  const own = Object.fromEntries(SESSION_CARD_KEYS.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
  const source = `Filed by God Mode package ${scope.packageId}`;
  // Cut first, so the card's own length cap never cuts the source line away.
  const details = typeof task.details === 'string' ? task.details.trim().slice(0, MAX_DETAILS_CHARS - source.length - 2) : '';
  return {
    ...own,
    details: details ? `${details}\n\n${source}` : source,
    tags: [FOLLOWUP_TAG, `gm-${task.kind}`, runLabel],
    manual: false,
    dependsOn: knownDeps(task.dependsOn, index, count, existingAts),
  };
}

/**
 * Checks and rewrites a God Mode session's luna_todo_add tasks. Never mutates.
 * @param {Array} list the project's normalized to-do list
 * @param {unknown} tasks the tool's `tasks` argument (untrusted)
 * @param {{runId:string, packageId:string}} scope
 * @param {{byPackage?:number, byRun?:number}} [filed] cards this package / this run filed earlier
 * @returns {{ok:true, tasks:object[], kinds:string[]}|{ok:false, error:string}}
 */
function prepareFollowups(list, tasks, scope, filed = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return fail('tasks must be a non-empty array');
  if (tasks.length > MAX_FOLLOWUPS_PER_CALL) return fail(`at most ${MAX_FOLLOWUPS_PER_CALL} follow-up cards per call`);
  const byPackage = filed.byPackage || 0;
  const byRun = filed.byRun || 0;
  if (byPackage + tasks.length > MAX_FOLLOWUPS_PER_PACKAGE) {
    return fail(`a God Mode package may file at most ${MAX_FOLLOWUPS_PER_PACKAGE} follow-up cards (${byPackage} already)`);
  }
  if (byRun + tasks.length > MAX_FOLLOWUPS_PER_RUN) {
    return fail(`a God Mode run may file at most ${MAX_FOLLOWUPS_PER_RUN} follow-up cards (${byRun} already)`);
  }
  if (list.length + tasks.length > MAX_ITEMS - LIST_HEADROOM) {
    return fail(`the to-do list is nearly full (${list.length} of ${MAX_ITEMS}): follow-up cards keep ${LIST_HEADROOM} slots free`);
  }
  const runLabel = runTag(scope.runId);
  if (!runLabel) return fail('this session has no valid run id');
  const openTitles = new Map();
  for (const card of list) {
    const title = normalizeTitle(card.text);
    if (!card.done && !openTitles.has(title)) openTitles.set(title, card.at);
  }
  const existingAts = new Set(list.map((card) => card.at));
  const seen = new Map();
  const out = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (!isObj(task)) return fail(`tasks[${i}] must be an object`);
    if (!FOLLOWUP_KINDS.includes(task.kind)) return fail(`tasks[${i}].kind must be one of ${FOLLOWUP_KINDS.join(', ')}`);
    if (typeof task.text !== 'string' || !task.text.trim()) return fail(`tasks[${i}].text must be a non-empty string`);
    const title = normalizeTitle(task.text);
    if (openTitles.has(title)) return fail(`tasks[${i}] is a duplicate of ${openTitles.get(title)}`);
    if (seen.has(title)) return fail(`tasks[${i}] is a duplicate of tasks[${seen.get(title)}]`);
    seen.set(title, i);
    out.push(forcedTask(task, i, tasks.length, existingAts, scope, runLabel));
  }
  return { ok: true, tasks: out, kinds: tasks.map((t) => t.kind) };
}

// --- the per-run record -------------------------------------------------------------

/**
 * One run's record, validated (a stored run is read back through this too).
 * @param {unknown} raw
 * @param {string} runId
 * @returns {Array<{runId:string, packageId:string, kind:string, title:string, at:number}>}
 */
function normalizeFollowupEntries(raw, runId) {
  if (!Array.isArray(raw) || typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return [];
  return raw
    .filter((e) => isObj(e) && typeof e.packageId === 'string' && PACKAGE_ID_RE.test(e.packageId))
    .filter((e) => FOLLOWUP_KINDS.includes(e.kind) && typeof e.title === 'string' && e.title && Number.isFinite(e.at))
    .map((e) => ({ runId, packageId: e.packageId, kind: e.kind, title: e.title.slice(0, MAX_LEDGER_TITLE_CHARS), at: e.at }))
    .slice(-MAX_LEDGER_ENTRIES);
}

/**
 * Which cards God Mode sessions filed, per run. In memory while LunaCore
 * runs; `persist` stores a run's whole record with the run, `load` reads it
 * back after a restart (the in-memory copy wins while it exists).
 * @param {{load?:(runId:string) => unknown, persist?:(runId:string, entries:object[]) => boolean,
 *   log?:(line:string) => void}} [opts]
 */
function createFollowupLedger({ load = null, persist = null, log = () => {} } = {}) {
  const memory = new Map();

  function stored(runId) {
    if (typeof load !== 'function') return [];
    try {
      return normalizeFollowupEntries(load(runId), runId);
    } catch (err) {
      log(`[followups] could not read the record of run ${runId}: ${errText(err)}`);
      return [];
    }
  }

  /** @returns {Array<object>} copies, filing order; only `packageId`'s when given */
  function list(runId, packageId) {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return [];
    const all = memory.has(runId) ? memory.get(runId) : stored(runId);
    return all.filter((e) => packageId === undefined || e.packageId === packageId).map((e) => ({ ...e }));
  }

  /** @returns {boolean} false when the record could not be stored with its run (it stays in memory) */
  function record(runId, entries) {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return false;
    const next = normalizeFollowupEntries([...list(runId), ...entries], runId);
    memory.set(runId, next);
    if (typeof persist !== 'function') return true;
    try {
      if (persist(runId, next.map((e) => ({ ...e }))) === true) return true;
      log(`[followups] run ${runId}: no stored run to keep the record with`);
    } catch (err) {
      log(`[followups] run ${runId}: record not stored: ${errText(err)}`);
    }
    return false;
  }

  return { list, record };
}

/**
 * A ledger stored with the God Mode run it belongs to: the registry finds the
 * run by its plan id (orchestra.js followupsFiled / noteFollowups).
 * @param {() => {byPlanId:(id:string) => ({controller:object}|null)}} registry read lazily
 */
function runStoredLedger(registry, log) {
  const controllerOf = (runId) => {
    const owner = registry().byPlanId(runId);
    return owner && owner.controller ? owner.controller : null;
  };
  return createFollowupLedger({
    load: (runId) => {
      const c = controllerOf(runId);
      return c && typeof c.followupsFiled === 'function' ? c.followupsFiled(runId) : null;
    },
    persist: (runId, entries) => {
      const c = controllerOf(runId);
      return !!c && typeof c.noteFollowups === 'function' && c.noteFollowups(runId, entries) === true;
    },
    log,
  });
}

// --- the brief section ------------------------------------------------------------

/**
 * What a God Mode session is told about the channel when its run has the
 * option on. Worker, plan-run, merge fix-up and self-check briefs share it.
 */
const FOLLOWUP_BRIEF_LINES = Object.freeze([
  '## Follow-up to-dos',
  "This run lets you file new To-do cards for what you discover. They go to the project's normal To-do list for Mati to triage: they are never added to this run and never started automatically.",
  'While you work, and before you end with LUNA_DONE or LUNA_BLOCKED, file a card with `mcp__lunacore__luna_todo_add` (set `kind` on every card) when you find:',
  '- `gap`: something the feature needs to be fully complete that your task does not cover.',
  '- `bug`: a defect, even outside your package. File it; do not fix it outside your scope.',
  '- `deps`: a dependency, build, tooling or flaky-test problem, even one you worked around.',
  '- `idea`: the "you should also build X" point you would otherwise only put in your final message.',
  'Every card must be self-contained, readable by someone who never saw this session: what you saw; where (files, command, error excerpt); why it matters; the acceptance criteria (`acceptance`); how to verify it. Put the evidence in `details`.',
  'Call `mcp__lunacore__luna_todo_list` first and do not file what is already listed (a duplicate title is refused anyway).',
  'Filing a card never replaces finishing your own task.',
  'In your final message, list every card you filed (title + `at`).',
]);

/**
 * The brief lines for the follow-up channel: none unless the run has the
 * option on, so a brief without it stays byte-identical.
 * @param {unknown} followups the run's plan.followups
 * @returns {string[]} the section plus a trailing blank line, or []
 */
function followupBriefLines(followups) {
  return followups === true ? [...FOLLOWUP_BRIEF_LINES, ''] : [];
}

/** The heading the self-check and merge fix-up briefs end with: their end-marker rule is in it. */
const RULES_HEADING = '\n## Rules\n';

/**
 * A finished brief (fix-up, self-check) with the section when the option is
 * on: before its last "## Rules" block, so the LUNA_DONE / LUNA_BLOCKED rule
 * stays the brief's last line; appended to a brief without one. The brief
 * itself when the option is off.
 * @param {string} brief
 * @param {unknown} followups
 * @returns {string}
 */
function withFollowupBrief(brief, followups) {
  if (followups !== true) return brief;
  const base = String(brief);
  const section = followupBriefLines(true).join('\n');
  const rules = base.lastIndexOf(RULES_HEADING);
  if (rules >= 0) return `${base.slice(0, rules + 1)}${section}\n${base.slice(rules + 1)}`;
  return `${base}${base.endsWith('\n') ? '' : '\n'}\n${section}`;
}

// --- the channel ------------------------------------------------------------------

/**
 * The to-do half of scoped intake tokens (IntakeServer's `channel`).
 * @param {{ledger:ReturnType<typeof createFollowupLedger>, now?:() => number}} opts
 */
function createFollowupChannel({ ledger, now = Date.now }) {
  function add(args, store, scope) {
    const list = normalizeTodos(store.read());
    const runFiled = ledger.list(scope.runId);
    const filed = { byRun: runFiled.length, byPackage: runFiled.filter((e) => e.packageId === scope.packageId).length };
    const prepared = prepareFollowups(list, args.tasks, scope, filed);
    if (!prepared.ok) return toolText(prepared.error, true);
    const outcome = applyAdd(list, prepared.tasks, store.now ? store.now() : now());
    if (!outcome.ok) return toolText(outcome.error, true);
    // The record pairs each card with its kind by position: applyAdd is all-or-nothing and keeps order.
    if (outcome.added.length !== prepared.kinds.length) return toolText('internal error: cards and kinds do not line up', true);
    if (!store.write(outcome.list)) return toolText('could not save the to-do list', true);
    // The cards are saved: a record that cannot be stored is logged by the ledger, never undone.
    ledger.record(
      scope.runId,
      outcome.added.map((card, i) => ({ packageId: scope.packageId, kind: prepared.kinds[i], title: card.text, at: card.at })),
    );
    return toolText({ added: outcome.added });
  }

  /** @returns {object|null} a tool result, or null = not this scope's tool (intake.js refuses it) */
  function call(name, args, store, scope) {
    if (!scope || scope.scope !== 'worker') return null;
    const a = isObj(args) ? args : {};
    if (name === 'luna_todo_list') return toolText(listView(normalizeTodos(store.read()), a.includeDone, a.tag));
    if (name === 'luna_todo_add') return add(a, store, scope);
    return null;
  }

  return { tools: channelTools, call, followupsFor: (runId, packageId) => ledger.list(runId, packageId) };
}

module.exports = {
  FOLLOWUP_KINDS,
  FOLLOWUP_TAG,
  FOLLOWUP_ADD_TOOL,
  MAX_FOLLOWUPS_PER_CALL,
  MAX_FOLLOWUPS_PER_PACKAGE,
  MAX_FOLLOWUPS_PER_RUN,
  LIST_HEADROOM,
  MAX_LEDGER_ENTRIES,
  RUN_ID_RE,
  PACKAGE_ID_RE,
  channelTools,
  followupBriefLines,
  withFollowupBrief,
  normalizeTitle,
  prepareFollowups,
  normalizeFollowupEntries,
  createFollowupLedger,
  runStoredLedger,
  createFollowupChannel,
};
