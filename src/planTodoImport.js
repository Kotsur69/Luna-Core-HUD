// ============================================================================
// LunaCore - Free God Mode v2: approved PLAN.md tasks -> to-dos (slice F4a)
// ----------------------------------------------------------------------------
// "Approve plan" turns every UNCHECKED task of docs/plans/<slug>/PLAN.md into
// one card in the project's existing to-do store (src/todo.js):
//
//   text        the task line
//   details     the task's nested notes / subtasks, then a link to PLAN.md
//               (`Plan: docs/plans/<slug>/PLAN.md`) - the build planner reads
//               the plan through that link (orchestraPlanBuild.js)
//   files       the task's `Files:` list, `(new)` kept
//   acceptance  the task's acceptance test; `verify` too when it is a command
//   tags        `plan:<slug>` (shortened to fit the to-do tag cap, see planTag)
//   original    the task line as PLAN.md wrote it - the import's identity
//
// IDEMPOTENT: a card is only added when no card (open OR done) of the same
// plan tag already carries the task, matched on the normalized task text
// against both `original` and `text`. Approving twice adds nothing.
//
// Pure: no fs. The caller reads PLAN.md and writes the list.
// ============================================================================

'use strict';

const { cleanTags, MAX_ITEMS, MAX_TEXT_CHARS, MAX_DETAILS_CHARS } = require('./todorows');
const { parsePlanTasks, acceptanceKind } = require('./planTasks');
const { validateRunSlug, planPath } = require('./orchestraPlanRun');

const PLAN_TAG_PREFIX = 'plan:';
// todorows.js TAG_RE: at most 40 characters in all.
const MAX_TAG_CHARS = 40;
const MAX_TAG_SLUG_CHARS = MAX_TAG_CHARS - PLAN_TAG_PREFIX.length;
const MAX_ENTRY_CHARS = 300;
const MAX_FILES = 50;
const PLAN_LINK_LABEL = 'Plan:';
// The link line the importer writes; strict, so a hand-edited card never
// points the planner anywhere but docs/plans/<slug>/PLAN.md.
const PLAN_LINK_RE = /^Plan:\s+docs\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\/PLAN\.md\s*$/m;

/**
 * The to-do tag of a plan: `plan:<slug>`. A slug too long for the tag cap is
 * shortened from the FRONT - run slugs end in their unique time stamp
 * (orchestraPlanRunStart.deriveRunSlug), so the tail is what tells them apart.
 * @param {string} runSlug a slug validateRunSlug() accepts
 * @returns {string|null}
 */
function planTag(runSlug) {
  if (!validateRunSlug(runSlug).ok) return null;
  const tail = runSlug.length > MAX_TAG_SLUG_CHARS ? runSlug.slice(-MAX_TAG_SLUG_CHARS).replace(/^-+/, '') : runSlug;
  const tags = cleanTags([`${PLAN_TAG_PREFIX}${tail}`]);
  return tags ? tags[0] : null;
}

/** True for a `plan:...` tag. */
const isPlanTag = (tag) => typeof tag === 'string' && tag.startsWith(PLAN_TAG_PREFIX) && tag.length > PLAN_TAG_PREFIX.length;

/**
 * The plan a to-do card came from: the slug of its `Plan:` link when that
 * agrees with its plan tag, else the tag's own slug when it is a full run
 * slug. Null for any other card.
 * @param {{tags?:string[], details?:string}} todo
 * @returns {string|null}
 */
function planSlugOf(todo) {
  const tags = todo && Array.isArray(todo.tags) ? todo.tags.filter(isPlanTag) : [];
  if (!tags.length) return null;
  const m = typeof todo.details === 'string' ? todo.details.match(PLAN_LINK_RE) : null;
  if (m && validateRunSlug(m[1]).ok && tags.includes(planTag(m[1]))) return m[1];
  const fromTag = tags[0].slice(PLAN_TAG_PREFIX.length);
  return validateRunSlug(fromTag).ok ? fromTag : null;
}

/** Collapsed, lower-cased text: the identity of a task across imports. */
function identityOf(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const cap = (s, max) => String(s || '').trim().slice(0, max);

/** A `Files:` entry back as the card stores it: `path` or `path (new)`. */
const fileEntry = (f) => cap(f.isNew ? `${f.path} (new)` : f.path, MAX_ENTRY_CHARS);

// PLAN.md is LLM-written and orchestraFinish runs a verify through a shell,
// so an imported verify is only a backticked TEST command: a known runner
// (with the listed first argument; null = any) and no shell syntax at all.
// Anything else stays acceptance text for the worker to check by hand.
const SHELL_META_RE = /[;&|<>$`()%^!\r\n]/;
const VERIFY_RUNNERS = Object.freeze({
  npm: ['test', 't', 'run', 'run-script'],
  pnpm: ['test', 't', 'run'],
  yarn: ['test', 'run'],
  node: ['--test'],
  npx: ['tsc', 'eslint', 'jest', 'vitest', 'mocha', 'playwright'],
  pytest: null,
  tsc: null,
  eslint: null,
  jest: null,
  vitest: null,
  cargo: ['test', 'check'],
  go: ['test', 'vet'],
});

/** True for a one-line test command from VERIFY_RUNNERS without shell syntax. */
function isSafeVerify(cmd) {
  if (!cmd || cmd.length > MAX_ENTRY_CHARS || SHELL_META_RE.test(cmd)) return false;
  const [runner, first] = cmd.split(/\s+/);
  if (!Object.prototype.hasOwnProperty.call(VERIFY_RUNNERS, runner)) return false;
  const allowed = VERIFY_RUNNERS[runner];
  return allowed === null || allowed.includes(first);
}

/** The backticked acceptance command (a leading "run" dropped), or null. */
function verifyOf(acceptance) {
  if (acceptanceKind(acceptance) !== 'command') return null;
  const tick = String(acceptance).match(/`([^`]+)`/);
  if (!tick) return null;
  const cmd = tick[1].replace(/^run\s+/i, '').trim();
  return isSafeVerify(cmd) ? cmd : null;
}

/**
 * The card one task becomes.
 * @param {ReturnType<typeof parsePlanTasks>[number]} task
 * @param {{runSlug:string, tag:string, at:number}} opts
 */
function taskTodo(task, { runSlug, tag, at }) {
  const link = `${PLAN_LINK_LABEL} ${planPath(runSlug)}`;
  const body = [
    ...task.notes.map((n) => `- ${n}`),
    ...task.subtasks.map((s) => `- [${s.checked ? 'x' : ' '}] ${s.text}`),
  ].join('\n');
  // The link always survives the cap: the build planner reads the plan by it.
  const room = MAX_DETAILS_CHARS - link.length - 2;
  const details = body ? `${body.slice(0, Math.max(0, room))}\n\n${link}` : link;
  const verify = verifyOf(task.acceptance);
  const files = task.files.slice(0, MAX_FILES).map(fileEntry).filter(Boolean);
  return {
    text: cap(task.text, MAX_TEXT_CHARS),
    done: false,
    at,
    details,
    ...(files.length ? { files } : {}),
    ...(task.acceptance ? { acceptance: [cap(task.acceptance, MAX_ENTRY_CHARS)] } : {}),
    ...(verify ? { verify } : {}),
    tags: [tag],
    original: cap(task.text, MAX_TEXT_CHARS),
  };
}

/**
 * Adds PLAN.md's unchecked tasks to a to-do list. Never mutates `list`.
 * @param {Array<object>} list the project's current to-dos
 * @param {string} markdown PLAN.md
 * @param {{runSlug:string, now:number}} opts
 * @returns {{ok:true, list:Array<object>, created:number, skipped:number, checked:number, full:number}
 *   | {ok:false, error:'badSlug'|'noTasks'}}
 *   skipped: already on the list; checked: ticked in PLAN.md; full: no room
 *   left under the list's MAX_ITEMS cap
 */
function importPlanTodos(list, markdown, { runSlug, now }) {
  const tag = planTag(runSlug);
  if (!tag) return { ok: false, error: 'badSlug' };
  const tasks = parsePlanTasks(markdown).filter((t) => t.text);
  if (!tasks.length) return { ok: false, error: 'noTasks' };
  const current = Array.isArray(list) ? list : [];
  const known = new Set();
  for (const t of current) {
    if (!t || !Array.isArray(t.tags) || !t.tags.includes(tag)) continue;
    known.add(identityOf(t.original));
    known.add(identityOf(t.text));
  }
  known.delete('');
  // Fresh `at` values, unique and above every existing one.
  let at = Math.max(Number(now) || 0, ...current.map((t) => (t && Number.isFinite(t.at) ? t.at + 1 : 0)));
  const added = [];
  let skipped = 0;
  let full = 0;
  const open = tasks.filter((t) => !t.checked);
  for (const task of open) {
    const id = identityOf(cap(task.text, MAX_TEXT_CHARS));
    if (known.has(id)) {
      skipped += 1;
      continue;
    }
    if (current.length + added.length >= MAX_ITEMS) {
      full += 1;
      continue;
    }
    known.add(id);
    added.push(taskTodo(task, { runSlug, tag, at }));
    at += 1;
  }
  return { ok: true, list: [...current, ...added], created: added.length, skipped, checked: tasks.length - open.length, full };
}

module.exports = {
  PLAN_TAG_PREFIX,
  planTag,
  isPlanTag,
  isSafeVerify,
  planSlugOf,
  importPlanTodos,
};
