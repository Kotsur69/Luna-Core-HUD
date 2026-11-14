// ============================================================================
// LunaCore - Free God Mode v2 plan runs: the pure core (slice F1a + F1d)
// ----------------------------------------------------------------------------
// A plan run does not build code: it writes a plan. The planner answers with
// 2-6 research topics; each topic becomes one parallel package that writes
// docs/plans/<run>/<topic>.md, a `critique` package reads them all and lists
// what is weak, and a `synthesis` package answers the critique in PLAN.md.
//
//   topic-a ─┐
//   topic-b ─┼─> critique (CRITIQUE.md) ─> synthesis (PLAN.md)
//   topic-c ─┘
//
// THE TRUST BOUNDARY IS validateTopics() / validateRunSlug(): the topics are
// model output, and their slugs end up in folder, file and branch names, so
// they are re-slugged, capped and checked against reserved names here.
//
// planRunFinishCheck() is the finish guard (enforced by config, not by the
// prompt): a plan-run worker may only leave changes under its own plan folder,
// and a topic doc must cite its sources. orchestraFinish.js runs the git side.
//
// Pure: no Electron, no fs, no child processes. Every function returns data.
// ============================================================================

'use strict';

const { MAX_TASK_FILES, MAX_TOUCHED_LINES } = require('./planTasks');

const PLANS_DIR = 'docs/plans';

const MIN_TOPICS = 2;
const MAX_TOPICS = 6;
// Topic slugs double as package ids (orchestraPlan.js caps those at 24).
const MAX_TOPIC_SLUG_CHARS = 24;
const MAX_RUN_SLUG_CHARS = 40;
const MAX_QUESTION_CHARS = 300;
// The goal is Mati's plan-run request verbatim (orchestraPlanRunStart.js).
const MAX_GOAL_CHARS = 20000;

const ROLE_TOPIC = 'topic';
const ROLE_CRITIQUE = 'critique';
const ROLE_SYNTHESIS = 'synthesis';
const ROLES = [ROLE_TOPIC, ROLE_CRITIQUE, ROLE_SYNTHESIS];

const CRITIQUE_ID = 'critique';
const SYNTHESIS_ID = 'synthesis';
const CRITIQUE_FILE = 'CRITIQUE.md';
const PLAN_FILE = 'PLAN.md';

// Model pool the topic writers and the critic are drawn from; the critic
// should be a different model than the writers it critiques.
const EASY_MODEL_POOL = 'auto:easy';

// Stall reasons of the finish guard.
const STALL_OUTSIDE = 'outsidePlanFolder';
const STALL_NO_SOURCES = 'noSources';
// A package that carries a planRun flag the guard cannot read: stalled, never
// finished like a build package (fail closed).
const STALL_BAD_PLAN_RUN = 'badPlanRun';

// Names a topic slug can never take: the critique / synthesis package ids and
// files (Windows folders are case-insensitive: `plan.md` IS `PLAN.md`), and
// the device names Windows refuses as a file name.
const RESERVED_SLUGS = new Set([
  CRITIQUE_ID,
  SYNTHESIS_ID,
  'plan',
  'readme',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** JSON schema for the planner's topic answer. Mirrors validateTopics(). */
const TOPICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      minItems: MIN_TOPICS,
      maxItems: MAX_TOPICS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'question'],
        properties: {
          slug: { type: 'string', pattern: `^[a-z0-9][a-z0-9-]{0,${MAX_TOPIC_SLUG_CHARS - 1}}$` },
          question: { type: 'string', maxLength: MAX_QUESTION_CHARS },
        },
      },
    },
  },
};

const RESEARCH_TOOLS = [
  'Research tools you may use:',
  '- WebSearch to find sources, WebFetch to read them.',
  '- The Playwright MCP, read-only: navigate, snapshot and evaluate only - never fill forms, log in or submit anything.',
  '- When WebFetch cannot read a page, fetch it through Jina Reader: WebFetch `https://r.jina.ai/<url>`.',
];

/** One trimmed line ('' when unusable): newlines and runs of space collapse. */
function oneLine(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max).trim();
}

/** Lower-case a-z0-9 with single dashes, capped, no edge dashes. */
function kebab(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/**
 * A run slug, safe as a folder name (docs/plans/<slug>/) and inside a branch
 * name. Strict: it is checked, not repaired - the caller derives it.
 * @param {unknown} raw
 * @returns {{ok:true, slug:string} | {ok:false, error:'empty'|'tooLong'|'notKebab'|'reserved'}}
 */
function validateRunSlug(raw) {
  const slug = typeof raw === 'string' ? raw.trim() : '';
  if (!slug) return { ok: false, error: 'empty' };
  if (slug.length > MAX_RUN_SLUG_CHARS) return { ok: false, error: 'tooLong' };
  if (!KEBAB_RE.test(slug)) return { ok: false, error: 'notKebab' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'reserved' };
  return { ok: true, slug };
}

/** The run slug, or a thrown TypeError for a caller that skipped validation. */
function requireRunSlug(runSlug) {
  const res = validateRunSlug(runSlug);
  if (!res.ok) throw new TypeError(`invalid plan run slug (${res.error})`);
  return res.slug;
}

/**
 * Validates and normalizes the planner's topic answer: slugs re-slugged and
 * capped, questions one line and capped, duplicates / reserved names / empty
 * questions dropped with a warning, the list capped at MAX_TOPICS. Fewer than
 * MIN_TOPICS usable topics is an error.
 * @param {unknown} raw `{topics:[{slug, question}]}` or the bare array
 * @returns {{topics:Array<{slug:string, question:string}>, warnings:Array<object>, errors:Array<object>}}
 */
function validateTopics(raw) {
  const warnings = [];
  const errors = [];
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.topics) ? raw.topics : [];
  const topics = [];
  const seen = new Set();

  for (const t of list) {
    if (!t || typeof t !== 'object') {
      warnings.push({ code: 'badTopic' });
      continue;
    }
    const slug = kebab(t.slug, MAX_TOPIC_SLUG_CHARS);
    if (!slug) {
      warnings.push({ code: 'badSlug', slug: oneLine(String(t.slug ?? ''), 60) });
      continue;
    }
    if (RESERVED_SLUGS.has(slug)) {
      warnings.push({ code: 'reservedSlug', slug });
      continue;
    }
    if (seen.has(slug)) {
      warnings.push({ code: 'dupSlug', slug });
      continue;
    }
    const question = oneLine(t.question, MAX_QUESTION_CHARS);
    if (!question) {
      warnings.push({ code: 'emptyQuestion', slug });
      continue;
    }
    if (topics.length >= MAX_TOPICS) {
      warnings.push({ code: 'tooMany', slug });
      continue;
    }
    seen.add(slug);
    topics.push({ slug, question });
  }

  if (topics.length < MIN_TOPICS) errors.push({ code: 'tooFew', count: topics.length, min: MIN_TOPICS });
  return { topics, warnings, errors };
}

/** docs/plans/<run>/ (with the trailing slash). */
function planFolder(runSlug) {
  return `${PLANS_DIR}/${requireRunSlug(runSlug)}/`;
}

function topicDocPath(runSlug, topicSlug) {
  return `${planFolder(runSlug)}${topicSlug}.md`;
}

function critiquePath(runSlug) {
  return `${planFolder(runSlug)}${CRITIQUE_FILE}`;
}

function planPath(runSlug) {
  return `${planFolder(runSlug)}${PLAN_FILE}`;
}

/** Rules every plan-run brief carries. */
function commonRules(runSlug) {
  const folder = planFolder(runSlug);
  return [
    '## Rules for this plan run',
    '- Write in English only, whatever language the request is in.',
    '- Read the whole repo first - code, assets, configs and docs - so every idea fits what already exists. Name real files and modules.',
    `- No code. Do not edit, create or delete anything outside \`${folder}\`: LunaCore reverts any change outside that folder and stalls the package.`,
    '- Write the document in one go with the exact section outline below, in that order. Do not rename, merge or skip sections.',
    '- Commit only your document.',
  ];
}

function goalSection(goal) {
  const text = typeof goal === 'string' ? goal.trim().slice(0, MAX_GOAL_CHARS) : '';
  return ['## Goal of the plan', text || '(no goal text given - infer it from the topic list below)'];
}

function topicList(runSlug, topics) {
  return topics.map((t) => `- \`${topicDocPath(runSlug, t.slug)}\` - ${t.question}`);
}

/** Section outline of a topic doc. */
const TOPIC_OUTLINE = ['Question', 'Context in this repo', 'Findings', 'Options', 'Recommendation', 'Sources'];
/** Section outline of CRITIQUE.md. */
const CRITIQUE_OUTLINE = ['Holes', 'Contradictions', 'Unproven assumptions', 'Missing sources'];
/** Section outline of PLAN.md. */
const PLAN_OUTLINE = ['Summary', 'Decisions', 'Critique answered', 'Milestones', 'Tasks', 'Risks', 'Open questions'];

const outlineLines = (title, sections) => [`# ${title}`, ...sections.map((s) => `## ${s}`)];

/**
 * Brief of one topic package.
 * @param {{runSlug:string, goal?:string, topic:{slug:string, question:string}}} args
 */
function buildTopicBrief({ runSlug, goal, topic }) {
  const out = topicDocPath(runSlug, topic.slug);
  return [
    `You research ONE topic of a plan and write it up as a document. Output file: \`${out}\` (exactly this path).`,
    '',
    ...goalSection(goal),
    '',
    '## Your topic',
    topic.question,
    '',
    ...commonRules(runSlug),
    '- Research: answer the question with evidence - from this repo and from the web. Say what you checked, not what you guess.',
    '- Do not write the plan itself: other packages critique the topics and write the plan.',
    '- The document MUST end with a `## Sources` section listing every source as a full URL (https://...), one per line. A topic doc without at least one URL there is refused.',
    '',
    ...RESEARCH_TOOLS,
    '',
    '## Section outline',
    '```markdown',
    ...outlineLines(topic.question, TOPIC_OUTLINE),
    '```',
  ].join('\n');
}

/**
 * Brief of the critique package: it reads every topic doc and lists what is
 * weak. It does NOT propose the plan.
 * @param {{runSlug:string, goal?:string, topics:Array<{slug:string, question:string}>}} args
 */
function buildCritiqueBrief({ runSlug, goal, topics }) {
  const out = critiquePath(runSlug);
  return [
    `You are the critic of a plan run. Read every topic document below and write a critique to \`${out}\` (exactly this path).`,
    '',
    ...goalSection(goal),
    '',
    '## Topic documents to critique',
    ...topicList(runSlug, topics),
    '',
    ...commonRules(runSlug),
    '- Find holes (questions the goal raises that no topic answers), contradictions between or inside the topics, unproven assumptions, and claims without a source.',
    '- Check claims against the repo and the cited sources yourself. Quote the doc and the line you mean.',
    '- Do NOT propose the plan and do not rewrite the topics: the synthesis package writes the plan and answers each of your points.',
    '- Number every point (H1, C1, A1, S1, ...) so the plan can answer it by number.',
    '',
    ...RESEARCH_TOOLS,
    '',
    '## Section outline',
    '```markdown',
    ...outlineLines('Critique', CRITIQUE_OUTLINE),
    '```',
  ].join('\n');
}

/**
 * Brief of the synthesis package: the plan, answering the critique.
 * @param {{runSlug:string, goal?:string, topics:Array<{slug:string, question:string}>}} args
 */
function buildSynthesisBrief({ runSlug, goal, topics }) {
  const out = planPath(runSlug);
  return [
    `You write the final plan of a plan run to \`${out}\` (exactly this path), from the topic documents and the critique.`,
    '',
    ...goalSection(goal),
    '',
    '## Inputs',
    ...topicList(runSlug, topics),
    `- \`${critiquePath(runSlug)}\` - the critique you must answer`,
    '',
    ...commonRules(runSlug),
    '- `## Critique answered`: every numbered critique point, each either fixed (say how the plan changed) or accepted with a reason.',
    '- `## Tasks`: a checkbox list (`- [ ] ...`). Under each task, two nested lines:',
    '  `- Files: path/one.js, path/two.js (new)` - repo-relative paths; mark files that do not exist yet with `(new)`.',
    '  `- Acceptance: npm test -- test/foo.test.js` - a command, or one concrete check (what to open, what must show).',
    `- Keep tasks small: at most ${MAX_TASK_FILES} files, one top-level folder, roughly ${MAX_TOUCHED_LINES} lines of existing code touched. Split anything bigger.`,
    '',
    '## Section outline',
    '```markdown',
    ...outlineLines('Plan', PLAN_OUTLINE),
    '```',
  ].join('\n');
}

/**
 * The package graph of a plan run: one parallel package per topic, a
 * critique depending on ALL of them, a synthesis depending on the critique.
 * Packages have the shape validatePlan() produces, plus `planRun` - the
 * explicit kind flag the finish guard keys on - and a `modelHint`.
 * @param {string} runSlug a slug validateRunSlug() accepts
 * @param {Array<{slug:string, question:string}>} topics validateTopics() output
 * @param {{goal?:string}} [opts]
 * @returns {Array<object>}
 */
function buildPlanRunPackages(runSlug, topics, opts = {}) {
  const slug = requireRunSlug(runSlug);
  if (!Array.isArray(topics) || topics.length < MIN_TOPICS || topics.length > MAX_TOPICS) {
    throw new TypeError(`a plan run needs ${MIN_TOPICS}-${MAX_TOPICS} topics`);
  }
  const goal = opts.goal;
  const base = { todoAts: [], verify: '', model: null, effort: null };

  const topicPkgs = topics.map((topic) => ({
    ...base,
    id: topic.slug,
    title: `Plan topic: ${topic.question}`.slice(0, 120),
    prompt: buildTopicBrief({ runSlug: slug, goal, topic }),
    files: [topicDocPath(slug, topic.slug)],
    dependsOn: [],
    planRun: { runSlug: slug, role: ROLE_TOPIC, topic: topic.slug, outputPath: topicDocPath(slug, topic.slug) },
    modelHint: { pool: EASY_MODEL_POOL },
  }));
  const topicIds = topicPkgs.map((p) => p.id);

  const critique = {
    ...base,
    id: CRITIQUE_ID,
    title: 'Plan critique',
    prompt: buildCritiqueBrief({ runSlug: slug, goal, topics }),
    files: [critiquePath(slug)],
    dependsOn: [...topicIds],
    planRun: { runSlug: slug, role: ROLE_CRITIQUE, outputPath: critiquePath(slug) },
    // A second opinion: prefer a different easy model than the writers had.
    modelHint: { pool: EASY_MODEL_POOL, avoidModelsOf: [...topicIds] },
  };

  const synthesis = {
    ...base,
    id: SYNTHESIS_ID,
    title: 'Plan synthesis',
    prompt: buildSynthesisBrief({ runSlug: slug, goal, topics }),
    files: [planPath(slug)],
    dependsOn: [CRITIQUE_ID],
    planRun: { runSlug: slug, role: ROLE_SYNTHESIS, outputPath: planPath(slug) },
    modelHint: null,
  };

  return [...topicPkgs, critique, synthesis];
}

/** True only for a package explicitly flagged as part of a plan run. */
function isPlanRunPackage(pkg) {
  const pr = pkg && typeof pkg === 'object' ? pkg.planRun : null;
  if (!pr || typeof pr !== 'object' || !ROLES.includes(pr.role) || !validateRunSlug(pr.runSlug).ok) return false;
  // A topic package must name its doc: the guard reads <topic>.md.
  return pr.role !== ROLE_TOPIC || (typeof pr.topic === 'string' && KEBAB_RE.test(pr.topic));
}

// ---------------------------------------------------------------------------
// Finish guard (F1d)
// ---------------------------------------------------------------------------

/**
 * Parses `git status --porcelain=v1 -z` output. Renames / copies (in either
 * column) carry the original path in `origPath`.
 * @param {string} stdout
 * @returns {Array<{x:string, y:string, path:string, origPath?:string}>}
 */
function parseStatusZ(stdout) {
  const parts = String(stdout || '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const entry = { x, y, path: rec.slice(3) };
    if ('RC'.includes(x) || 'RC'.includes(y)) {
      entry.origPath = parts[i + 1] || '';
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Parses `git diff --name-status -z --no-renames` output.
 * @param {string} stdout
 * @returns {Array<{status:string, path:string}>}
 */
function parseNameStatusZ(stdout) {
  const parts = String(stdout || '').split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].trim();
    if (!status) continue;
    entries.push({ status: status[0], path: parts[i + 1] });
  }
  return entries;
}

/**
 * True when `p` is a plain repo-relative path inside docs/plans/<run>/.
 * Anything unusual - absolute, `..` / `.` segments, backslashes, empty
 * segments, a sibling run's folder - counts as outside. One trailing slash
 * (git's form for an untracked nested repo) is allowed.
 */
function isInsidePlanFolder(p, runSlug) {
  if (typeof p !== 'string' || !p) return false;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\') || p.includes('\0')) return false;
  const bare = p.endsWith('/') ? p.slice(0, -1) : p;
  const segments = bare.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  const folder = planFolder(runSlug);
  return bare.startsWith(folder) && bare.length > folder.length;
}

/**
 * How to undo one UNCOMMITTED status entry outside the plan folder:
 *   remove      - untracked: `git clean -f`
 *   rmIndexed   - added to the index (or intent-to-add) but not in HEAD: `git rm -f`
 *   checkout    - tracked: `git checkout HEAD --`
 * A rename yields two actions (drop the new path, restore the old one).
 */
function revertActions(entry, runSlug) {
  const actions = [];
  const outside = (p) => !isInsidePlanFolder(p, runSlug);
  if (entry.x === '?' && entry.y === '?') {
    if (outside(entry.path)) actions.push({ path: entry.path, action: 'remove' });
    return actions;
  }
  const renamed = entry.x === 'R' || entry.y === 'R';
  if (entry.x === 'A' || entry.y === 'A' || renamed || entry.x === 'C' || entry.y === 'C') {
    if (outside(entry.path)) actions.push({ path: entry.path, action: 'rmIndexed' });
    if (renamed && entry.origPath && outside(entry.origPath)) {
      actions.push({ path: entry.origPath, action: 'checkout' });
    }
    return actions;
  }
  if (outside(entry.path)) actions.push({ path: entry.path, action: 'checkout' });
  return actions;
}

/**
 * How to undo one COMMITTED change (base..HEAD) outside the plan folder:
 *   dropAdded   - added since the base: `git rm -f`
 *   restoreBase - changed or deleted since the base: `git checkout <base> --`
 * orchestraFinish.js commits these reverts, so the next finish sees a clean tree.
 */
function committedRevertActions(entry, runSlug) {
  if (isInsidePlanFolder(entry.path, runSlug)) return [];
  return [{ path: entry.path, action: entry.status === 'A' ? 'dropAdded' : 'restoreBase' }];
}

/** Lines outside ``` fences. */
function unfencedLines(markdown) {
  let fenced = false;
  return markdown.split(/\r?\n/).filter((l) => {
    if (l.trim().startsWith('```')) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** True when the markdown has a `## Sources` section with at least one URL. */
function hasSourcesSection(markdown) {
  if (typeof markdown !== 'string') return false;
  const lines = unfencedLines(markdown);
  const start = lines.findIndex((l) => /^##\s+sources\s*:?\s*#*\s*$/i.test(l.trim()));
  if (start < 0) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l.trim()));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  return /https?:\/\/[^\s)>\]]+\.[^\s)>\]]+/i.test(body);
}

/**
 * The finish guard of a plan-run package. Decides only - orchestraFinish.js
 * runs the reverts.
 * @param {{planRun:{runSlug:string, role:string, topic?:string},
 *          status:string|Array<object>, committed?:string|Array<object>, topicDoc?:string|null}} args
 *   status: `git status --porcelain=v1 -z --untracked-files=all` output, or
 *   parseStatusZ() entries; committed: `git diff --name-status -z
 *   --no-renames <base>..HEAD` output, or parseNameStatusZ() entries;
 *   topicDoc: the topic document's text (topics only)
 * @returns {{ok:true}
 *   | {ok:false, reason:'outsidePlanFolder', outside:string[], revert:Array<{path:string, action:string}>,
 *      revertCommitted:Array<{path:string, action:string}>, detail:string}
 *   | {ok:false, reason:'noSources', detail:string}}
 */
function planRunFinishCheck({ planRun, status, committed, topicDoc }) {
  const runSlug = requireRunSlug(planRun && planRun.runSlug);
  const entries = Array.isArray(status) ? status : parseStatusZ(status);
  const commits = Array.isArray(committed) ? committed : parseNameStatusZ(committed);
  const revert = entries.flatMap((e) => revertActions(e, runSlug));
  const revertCommitted = commits.flatMap((e) => committedRevertActions(e, runSlug));
  if (revert.length || revertCommitted.length) {
    const outside = [...new Set([...revert, ...revertCommitted].map((r) => r.path))];
    return {
      ok: false,
      reason: STALL_OUTSIDE,
      outside,
      revert,
      revertCommitted,
      detail: `changes outside ${planFolder(runSlug)} were reverted: ${outside.join(', ')}`.slice(0, 600),
    };
  }
  if (planRun.role === ROLE_TOPIC && !hasSourcesSection(topicDoc)) {
    const where = planRun.topic ? topicDocPath(runSlug, planRun.topic) : 'the topic doc';
    return {
      ok: false,
      reason: STALL_NO_SOURCES,
      detail:
        typeof topicDoc === 'string'
          ? `${where} has no "## Sources" section with at least one URL`
          : `${where} is missing`,
    };
  }
  return { ok: true };
}

module.exports = {
  PLANS_DIR,
  MIN_TOPICS,
  MAX_TOPICS,
  MAX_TOPIC_SLUG_CHARS,
  MAX_RUN_SLUG_CHARS,
  MAX_QUESTION_CHARS,
  MAX_GOAL_CHARS,
  ROLE_TOPIC,
  ROLE_CRITIQUE,
  ROLE_SYNTHESIS,
  CRITIQUE_ID,
  SYNTHESIS_ID,
  EASY_MODEL_POOL,
  STALL_OUTSIDE,
  STALL_NO_SOURCES,
  STALL_BAD_PLAN_RUN,
  TOPICS_SCHEMA,
  TOPIC_OUTLINE,
  CRITIQUE_OUTLINE,
  PLAN_OUTLINE,
  validateRunSlug,
  validateTopics,
  planFolder,
  topicDocPath,
  critiquePath,
  planPath,
  buildTopicBrief,
  buildCritiqueBrief,
  buildSynthesisBrief,
  buildPlanRunPackages,
  isPlanRunPackage,
  parseStatusZ,
  parseNameStatusZ,
  isInsidePlanFolder,
  hasSourcesSection,
  planRunFinishCheck,
};
