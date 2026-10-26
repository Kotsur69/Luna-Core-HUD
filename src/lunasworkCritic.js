// ============================================================================
// LunaCore - Luna's Work Critic (docs/LUNAS_WORK_PLAN.md, slice 1.4a)
// ----------------------------------------------------------------------------
// One `claude -p --output-format json --json-schema <CRITIC_SCHEMA>` call, run
// in the project repo with read-only tools (orchestraPlan.js pattern). It
// reads the playtest report, the design pack, the score history and the
// iteration's git log, and answers with cards, a PLAYTEST_LOG.md entry, the
// new ARCHITECTURE.md, decisions, new journeys and a CONTINUE / SHIP verdict.
//
// Plan "Critic rules":
//   - every card is bug / feel / missing / idea with a severity; bugs and
//     blockers come first
//   - `idea` cards are dropped until the current milestone gate passes
//   - every `bug` card carries a repro-test instruction and the acceptance
//     check "A test reproduces the bug" (idea #3) - added when missing
//   - every STEP_BACK_EVERY-th iteration the prompt opens with BRIEF.md +
//     DESIGN.md and "is this still that product?" (the prompt lives in
//     src/lunasworkCriticPrompt.js, the design-pack writes in
//     src/lunasworkCriticPack.js)
//   - B4: a stuck card (failed STUCK_AFTER iterations, opts.stuckCards) may
//     be split: the pieces carry splitsCardId and become new cards, and the
//     stuck card closes as split. One the Critic leaves alone goes to the
//     decision queue (the controller asks; runCritic returns `split`)
//
// The milestone gate is computed HERE from the Playtester's evidence-backed
// scores, never taken from the model: a criterion passes at GATE_PASS_SCORE
// or more in this iteration's report. A SHIP verdict before every gate passes
// is downgraded to CONTINUE.
//
// THE TRUST BOUNDARY IS validateCritique(). Kind (`kind:<x>`) and severity
// (`sev:<x>`) are stored as card tags next to the run tag, since a to-do card
// has no such fields; cardMeta() reads them back for lunasworkRules.orderCards.
// Only open cards of this run may be updated - never Mati's steer cards.
//
// Always resolves, never rejects. A malformed reply creates no cards and
// writes nothing; the error is logged and returned.
//
// LW 2.16: reviewSkills() is the Critic's accept / reject / edit pass over a
// milestone gate's project-skill proposals (src/lunasworkSkills.js); nothing
// is written without it. LW 2.22a: runCritic passes opts.closedCards on to
// the pack, which appends the iteration's CHANGELOG.md entry. The file runs
// past 800 lines on purpose: both passes share the trust boundary and the
// headless-call plumbing above.
//
// LW 2.19a: a design-match entry (report.designMatch) that scores low or
// dropped since the previous iteration becomes a `feel` card naming both
// images - computed here from the Playtester's evidence, never left to the
// model (lunasworkDesignMatch.designMatchCards).
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const { parsePlannerOutput } = require('./orchestraPlan');
const { isUsageLimitText } = require('./orchestraPlanWait');
const { checkCwd } = require('./projects');
const { gatePassed, isStepBack, pickModel, MAX_TEXT_CHARS } = require('./lunasworkRules');
const { applyAdd, applyUpdate, MAX_TASKS_PER_CALL } = require('./intake');
const { normalizeTodos, runTag, cleanTags, MAX_DETAILS_CHARS, MAX_ITEMS, STEER_TAG, BUILT_STATE } = require('./todorows');
const pack = require('./lunasworkPack');
const {
  GATE_PASS_SCORE, MAX_SPLIT_PIECES, SKILL_VERDICTS, SKILL_REVIEW_SCHEMA, buildCriticPrompt, buildSkillReviewPrompt,
} = require('./lunasworkCriticPrompt');
const { formatLogEntry, writePack } = require('./lunasworkCriticPack');
const { designMatchCards } = require('./lunasworkDesignMatch');

const CRITIC_EFFORT = 'high';
const CRITIC_BUDGET_USD = 3;
const CRITIC_TIMEOUT_MS = 10 * 60 * 1000;
const FALLBACK_MODEL = 'opus';
// Read-only: the Critic reads the code to keep ARCHITECTURE.md true, never changes it.
const CRITIC_TOOLS = 'Read,Grep,Glob';

const KINDS = ['bug', 'feel', 'missing', 'idea'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const VERDICTS = ['CONTINUE', 'SHIP'];
const KIND_RANK = { bug: 0, missing: 1, feel: 2, idea: 3 };
const SEVERITY_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
// The tag a stuck card gets when it closes because the Critic split it (B4).
const SPLIT_TAG = 'split';
// Same value as lunasworkFeedback.FEEDBACK_TAG (that module loads this one's neighbours, not this one).
const FEEDBACK_TAG = 'feedback';

const MAX_CARDS = MAX_TASKS_PER_CALL;
const MAX_RAW_CARDS = 50;
const MAX_LIST_ENTRIES = 20;
const MAX_ENTRY_CHARS = 300;
const MAX_FILES = 50;
const MAX_LOG_ITEMS = 10;
const MAX_LOG_TEXT_CHARS = 2000;
const MAX_DECISIONS = 20;
const MAX_DECISION_CHARS = 500;
const MAX_JOURNEYS = 10;
const MAX_JOURNEY_CHARS = 2000;
const MAX_DOC_CHARS = 20000;

const REPRO_DETAILS =
  'Repro test first: write an automated test that reproduces this bug and fails, then fix the code until it passes. The commit must add or change a test file.';
const REPRO_ACCEPTANCE = 'A test reproduces the bug (fails before the fix, passes after)';
// "repro"/"reproduce" and "test" in one sentence.
const REPRO_TEST_RE = /\b(repro|reproduc\w*)\b[^.\n]{0,80}\btests?\b|\btests?\b[^.\n]{0,80}\b(repro|reproduc\w*)\b/i;
// "no repro test needed" mentions one without asking for it.
const NEGATED_RE = /\b(no|not|without|skip\w*|unnecessary|needless)\b[^.\n]{0,30}\b(repro\w*|tests?)\b/i;
const asksForReproTest = (s) => REPRO_TEST_RE.test(s) && !NEGATED_RE.test(s);

const stringList = { type: 'array', items: { type: 'string' } };

/** JSON schema handed to `--json-schema`. Mirrors validateCritique() below. */
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards', 'logEntry', 'architecture', 'decisions', 'newJourneys', 'verdict'],
  properties: {
    cards: {
      type: 'array',
      maxItems: MAX_CARDS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'severity', 'text', 'details', 'acceptance', 'files'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          severity: { type: 'string', enum: SEVERITIES },
          text: { type: 'string', maxLength: MAX_TEXT_CHARS },
          details: { type: 'string' },
          acceptance: stringList,
          files: stringList,
          updatesCardId: { type: 'number' },
          splitsCardId: { type: 'number' },
        },
      },
    },
    logEntry: {
      type: 'object',
      additionalProperties: false,
      required: ['played', 'good', 'bad', 'broken', 'missing', 'scores', 'verdict'],
      properties: {
        played: { type: 'string' },
        good: stringList,
        bad: stringList,
        broken: stringList,
        missing: stringList,
        scores: { type: 'string' },
        verdict: { type: 'string' },
      },
    },
    architecture: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['choice', 'because'],
        properties: { choice: { type: 'string' }, because: { type: 'string' } },
      },
    },
    newJourneys: stringList,
    verdict: { type: 'string', enum: VERDICTS },
  },
};

// ---- small helpers ----------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Trimmed, capped string ('' when unusable). */
function clean(raw, max) {
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

/** Non-empty trimmed strings, capped in count and length. */
function strings(raw, maxItems, maxChars) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => clean(s, maxChars)).filter(Boolean).slice(0, maxItems);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Whole words only: "milestone 1 skeleton" matches "skeleton" and
// "milestone 1", never "milestone 10".
const sameMilestone = (a, b) => !!a && !!b && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
const rank = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 99);

// ---- milestone gate -----------------------------------------------------------------

/** Lowest evidence-backed score the report gives one criterion, or null. */
function criterionScore(milestone, text, scores) {
  const hits = scores.filter(
    (s) => isObj(s) && Number.isFinite(s.score) && s.score >= 0 && s.score <= 10 && norm(s.criterion) === norm(text)
      && sameMilestone(norm(milestone), norm(s.milestone)),
  );
  return hits.length ? Math.min(...hits.map((s) => s.score)) : null;
}

/**
 * Gate status per milestone of SHIP_CRITERIA.md, from this iteration's
 * playtest scores only. An unscored criterion did not pass: the Playtester
 * checks every criterion every pass, and a gate must still hold.
 * @param {{shipCriteria:string, scores?:object[], milestone?:string|null}} input
 *   milestone = the run's current milestone; defaults to the first gate not passed
 * @returns {{gates:{name:string, passed:boolean, criteria:{text:string, score:number|null, passed:boolean}[]}[],
 *   current:string|null, currentPassed:boolean, next:string|null, allPassed:boolean, score:number|null}}
 */
function gateStatus({ shipCriteria, scores, milestone = null }) {
  const list = Array.isArray(scores) ? scores : [];
  const gates = pack.parseShipCriteria(shipCriteria).map((m) => {
    const criteria = m.criteria.map((c) => {
      const score = criterionScore(m.name, c.text, list);
      return { text: c.text, score, passed: score !== null && score >= GATE_PASS_SCORE };
    });
    return { name: m.name, passed: gatePassed({ criteria }), criteria };
  });
  const firstOpen = gates.find((g) => !g.passed) || null;
  const named = milestone ? gates.find((g) => sameMilestone(norm(g.name), norm(milestone))) : null;
  const current = named || firstOpen || gates[gates.length - 1] || null;
  const scored = current ? current.criteria : [];
  const score = scored.length
    ? Math.round((scored.reduce((sum, c) => sum + (c.score || 0), 0) / scored.length) * 10)
    : null;
  return {
    gates,
    current: current ? current.name : null,
    currentPassed: !!current && current.passed,
    next: firstOpen ? firstOpen.name : null,
    allPassed: gates.length > 0 && !firstOpen,
    score,
  };
}

// ---- cards: tags ------------------------------------------------------------------

const isMetaTag = (t) => t.startsWith('kind:') || t.startsWith('sev:');

/** The run tag first, then kind and severity, then the card's other tags. */
function cardTags(tag, kind, severity, existing = []) {
  const others = (Array.isArray(existing) ? existing : []).filter((t) => t !== tag && !isMetaTag(t));
  return cleanTags([tag, `kind:${kind}`, `sev:${severity}`, ...others]);
}

/**
 * Kind and severity of a stored card, read back from its tags (for
 * lunasworkRules.orderCards). steer = Mati's card; feedback = a card filed
 * from mid-run feedback (B17), scheduled right after the steer cards.
 * @returns {{kind:string|null, severity:string|null, steer:boolean, feedback:boolean}}
 */
function cardMeta(card) {
  const tags = isObj(card) && Array.isArray(card.tags) ? card.tags : [];
  const value = (prefix, allowed) => {
    const hit = tags.find((t) => t.startsWith(prefix) && allowed.includes(t.slice(prefix.length)));
    return hit ? hit.slice(prefix.length) : null;
  };
  return { kind: value('kind:', KINDS), severity: value('sev:', SEVERITIES), steer: tags.includes(STEER_TAG), feedback: tags.includes(FEEDBACK_TAG) };
}

/**
 * Open cards of this run the Critic may rewrite - never a steer card, and
 * never a built one (B1: the next Playtester pass decides about it).
 */
function updatableCards(list, tag) {
  return list.filter(
    (c) => !c.done && c.state !== BUILT_STATE && Array.isArray(c.tags) && c.tags.includes(tag) && !c.tags.includes(STEER_TAG),
  );
}

// ---- validation ---------------------------------------------------------------------

/** Idea #3: a bug card always tells the builder to start from a failing repro test. */
function withReproTest(card, warnings) {
  const hasDetails = asksForReproTest(card.details);
  const hasAcceptance = card.acceptance.some(asksForReproTest);
  if (hasDetails && hasAcceptance) return card;
  warnings.push({ code: 'reproAdded', text: card.text });
  const room = MAX_DETAILS_CHARS - REPRO_DETAILS.length - 2;
  return {
    ...card,
    details: hasDetails ? card.details : [card.details.slice(0, room), REPRO_DETAILS].filter(Boolean).join('\n\n'),
    acceptance: hasAcceptance ? card.acceptance : [REPRO_ACCEPTANCE, ...card.acceptance].slice(0, MAX_LIST_ENTRIES),
  };
}

function cleanCard(c, ctx, warnings) {
  const text = isObj(c) ? clean(c.text, MAX_TEXT_CHARS) : '';
  if (!text || !KINDS.includes(c.kind) || !SEVERITIES.includes(c.severity)) {
    warnings.push({ code: 'badCard', text });
    return null;
  }
  if (c.kind === 'idea' && !ctx.ideasAllowed) {
    warnings.push({ code: 'ideaBeforeGate', text });
    return null;
  }
  const given = (v) => v !== undefined && v !== null;
  // B4: a piece of a stuck card is a new card; it never rewrites another one.
  let splitsCardId = null;
  if (given(c.splitsCardId)) {
    if (ctx.stuck.has(c.splitsCardId)) splitsCardId = c.splitsCardId;
    else warnings.push({ code: 'notStuck', text, at: c.splitsCardId });
  }
  let updatesCardId = null;
  if (given(c.updatesCardId) && splitsCardId === null) {
    if (ctx.updatable.has(c.updatesCardId)) updatesCardId = c.updatesCardId;
    else warnings.push({ code: 'unknownCard', text, at: c.updatesCardId });
  }
  const card = {
    kind: c.kind,
    severity: c.severity,
    text,
    details: clean(c.details, MAX_DETAILS_CHARS),
    acceptance: strings(c.acceptance, MAX_LIST_ENTRIES, MAX_ENTRY_CHARS),
    files: strings(c.files, MAX_FILES, MAX_ENTRY_CHARS),
    updatesCardId,
    splitsCardId,
  };
  return card.kind === 'bug' ? withReproTest(card, warnings) : card;
}

/** Bugs and blockers first, then kind, then severity; reply order on ties. */
function byPriority(a, b) {
  const urgent = (c) => (c.kind === 'bug' || c.severity === 'blocker' ? 0 : 1);
  return urgent(a) - urgent(b)
    || rank(KIND_RANK, a.kind) - rank(KIND_RANK, b.kind)
    || rank(SEVERITY_RANK, a.severity) - rank(SEVERITY_RANK, b.severity);
}

/**
 * B4: a split counts only whole. When a cap cut a piece of one, its other
 * pieces go too, and the stuck card goes to the decision queue instead.
 */
function wholeSplits(kept, cut, warnings) {
  const broken = new Set(cut.map((c) => c.splitsCardId).filter((at) => at !== null));
  if (!broken.size) return kept;
  warnings.push({ code: 'splitCut', ats: [...broken] });
  return kept.filter((c) => c.splitsCardId === null || !broken.has(c.splitsCardId));
}

function cleanCards(list, ctx, warnings) {
  const seen = new Set();
  const pieces = new Map();
  const cards = [];
  for (const raw of list.slice(0, MAX_RAW_CARDS)) {
    const card = cleanCard(raw, ctx, warnings);
    if (!card) continue;
    if (card.updatesCardId !== null && seen.has(card.updatesCardId)) {
      warnings.push({ code: 'duplicateUpdate', at: card.updatesCardId });
      continue;
    }
    if (card.splitsCardId !== null) {
      const count = (pieces.get(card.splitsCardId) || 0) + 1;
      if (count > MAX_SPLIT_PIECES) {
        warnings.push({ code: 'tooManyPieces', at: card.splitsCardId });
        continue;
      }
      pieces.set(card.splitsCardId, count);
    }
    if (card.updatesCardId !== null) seen.add(card.updatesCardId);
    cards.push(card);
  }
  const sorted = [...cards].sort(byPriority);
  if (sorted.length > MAX_CARDS) warnings.push({ code: 'tooManyCards', dropped: sorted.length - MAX_CARDS });
  return wholeSplits(sorted.slice(0, MAX_CARDS), sorted.slice(MAX_CARDS), warnings);
}

function cleanLogEntry(raw) {
  const list = (key) => strings(raw[key], MAX_LOG_ITEMS, MAX_ENTRY_CHARS);
  return {
    played: clean(raw.played, MAX_LOG_TEXT_CHARS),
    good: list('good'),
    bad: list('bad'),
    broken: list('broken'),
    missing: list('missing'),
    scores: clean(raw.scores, MAX_LOG_TEXT_CHARS),
    verdict: clean(raw.verdict, MAX_LOG_TEXT_CHARS),
  };
}

function cleanDecisions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(isObj)
    .map((d) => ({ choice: clean(d.choice, MAX_DECISION_CHARS), because: clean(d.because, MAX_DECISION_CHARS) }))
    .filter((d) => d.choice && d.because)
    .slice(0, MAX_DECISIONS);
}

const CRITIQUE_KEYS = ['cards', 'decisions', 'newJourneys'];

/** The critique a failed run yields: nothing to apply, one error note. */
function emptyCritique(error) {
  return {
    cards: [],
    logEntry: null,
    architecture: '',
    decisions: [],
    newJourneys: [],
    verdict: 'continue',
    warnings: [],
    errors: error ? [error] : [],
  };
}

/**
 * Validates and normalizes the Critic's reply. Never throws. A reply missing
 * a list, the log entry or a known verdict is malformed as a whole (the
 * `result` fallback skips the schema).
 * @param {unknown} raw model output
 * @param {{ideasAllowed?:boolean, allPassed?:boolean, updatable?:Set<number>}} ctx
 * @returns {{cards:object[], logEntry:object|null, architecture:string, decisions:object[],
 *   newJourneys:string[], verdict:'continue'|'ship', warnings:object[], errors:object[]}}
 */
function validateCritique(raw, ctx = {}) {
  const valid = isObj(raw) && CRITIQUE_KEYS.every((k) => Array.isArray(raw[k]))
    && isObj(raw.logEntry) && VERDICTS.includes(raw.verdict);
  if (!valid) return emptyCritique({ code: 'badCritique' });
  const warnings = [];
  const cards = cleanCards(raw.cards, {
    ideasAllowed: ctx.ideasAllowed === true,
    updatable: ctx.updatable instanceof Set ? ctx.updatable : new Set(),
    stuck: ctx.stuck instanceof Set ? ctx.stuck : new Set(),
  }, warnings);
  let verdict = raw.verdict === 'SHIP' ? 'ship' : 'continue';
  if (verdict === 'ship' && ctx.allPassed !== true) {
    warnings.push({ code: 'shipBeforeGates' });
    verdict = 'continue';
  }
  // A reply that ships while filing a bug or a blocker contradicts itself.
  if (verdict === 'ship' && cards.some((c) => c.kind === 'bug' || c.severity === 'blocker')) {
    warnings.push({ code: 'shipWithBugs' });
    verdict = 'continue';
  }
  const architecture = typeof raw.architecture === 'string' ? raw.architecture.replace(/\r\n/g, '\n').trim() : '';
  return {
    cards,
    logEntry: cleanLogEntry(raw.logEntry),
    architecture,
    decisions: cleanDecisions(raw.decisions),
    newJourneys: strings(raw.newJourneys, MAX_JOURNEYS, MAX_JOURNEY_CHARS),
    verdict,
    warnings,
    errors: [],
  };
}

/** argv for the headless Critic call - never a shell string; the prompt goes on stdin. */
function buildCriticArgs({ model = FALLBACK_MODEL, effort = CRITIC_EFFORT, budgetUsd = CRITIC_BUDGET_USD, schema = CRITIC_SCHEMA } = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--model', model,
    '--effort', effort,
    '--tools', CRITIC_TOOLS,
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

// ---- effects ------------------------------------------------------------------------

const taskFields = (card) => ({
  text: card.text,
  details: card.details,
  acceptance: card.acceptance,
  files: card.files,
});

/** Patch for an update: empty fields keep the card's current value. */
function updatePatch(card, current, tag) {
  const fields = taskFields(card);
  const kept = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v)),
  );
  return { ...kept, tags: cardTags(tag, card.kind, card.severity, current.tags) };
}

const splitOf = (card) => (Number.isFinite(card.splitsCardId) ? card.splitsCardId : null);

/** B4: the stuck cards whose pieces were created close, tagged `split`, with a note. */
function closeSplit(list, pieces, at) {
  const count = new Map();
  for (const card of pieces) count.set(card.splitsCardId, (count.get(card.splitsCardId) || 0) + 1);
  return list.map((c) => {
    if (!count.has(c.at)) return c;
    const note = `Split by the Critic into ${count.get(c.at)} smaller cards.`;
    const details = [String(c.details || '').slice(0, MAX_DETAILS_CHARS - note.length - 2), note].filter(Boolean).join('\n\n');
    return { ...c, done: true, doneAt: at, details, tags: cleanTags([...(c.tags || []), SPLIT_TAG]) };
  });
}

/**
 * Creates and updates the run's cards in the to-do store, tagged run:<id>,
 * kind:<x>, sev:<x>. One read, one write. Pieces of a stuck card (B4) are
 * created whole or not at all; their stuck card then closes as split.
 * LW 2.13: with an active ROADMAP epic, every NEW card is tagged
 * `epic:<slug>` so the Director schedules it inside that epic.
 * @param {{read:()=>unknown, write:(list:object[])=>boolean, now?:()=>number}} store
 * @param {{epic?:string|null}} [opts] epic = the active epic's slug
 * @returns {{created:object[], updated:object[], split:number[], warnings:object[], error?:string}}
 */
function applyCards(store, cards, tag, opts = {}) {
  const epic = pack.epicSlug(isObj(opts) ? opts.epic : null);
  const warnings = [];
  let list = normalizeTodos(store.read());
  // Re-checked on this read: Mati may have tagged a card `steer` or closed it
  // while the Critic was thinking.
  const updatable = new Set(updatableCards(list, tag).map((c) => c.at));
  const updated = [];
  for (const card of cards.filter((c) => c.updatesCardId !== null)) {
    if (!updatable.has(card.updatesCardId)) {
      warnings.push({ code: 'notUpdatable', at: card.updatesCardId });
      continue;
    }
    const current = list.find((c) => c.at === card.updatesCardId);
    const outcome = applyUpdate(list, card.updatesCardId, updatePatch(card, current || {}, tag));
    if (!outcome.ok) {
      warnings.push({ code: 'updateFailed', at: card.updatesCardId, detail: outcome.error });
      continue;
    }
    list = outcome.list;
    updated.push(outcome.card);
  }
  // Re-checked here too: the stuck card must still be open and this run's.
  const fresh = cards
    .filter((c) => c.updatesCardId === null)
    .filter((c) => splitOf(c) === null || updatable.has(splitOf(c)) || !warnings.push({ code: 'notSplittable', at: splitOf(c) }));
  const room = Math.max(0, MAX_ITEMS - list.length);
  if (fresh.length > room) warnings.push({ code: 'listFull', dropped: fresh.length - room });
  const kept = wholeSplits(
    fresh.slice(0, room).map((c) => ({ ...c, splitsCardId: splitOf(c) })),
    fresh.slice(room).map((c) => ({ ...c, splitsCardId: splitOf(c) })),
    warnings,
  );
  // extraTags: set only by the controller's own cards (B17 feedback), never by the model's output.
  const epicTags = epic ? [`epic:${epic}`] : [];
  const tasks = kept.map((c) => ({
    ...taskFields(c),
    tags: cardTags(tag, c.kind, c.severity, [...epicTags, ...(Array.isArray(c.extraTags) ? c.extraTags : [])]),
  }));
  const at = store.now ? store.now() : Date.now();
  let created = [];
  if (tasks.length) {
    const outcome = applyAdd(list, tasks, at);
    if (!outcome.ok) return { created: [], updated: [], split: [], warnings, error: outcome.error };
    list = outcome.list;
    created = outcome.added;
  }
  const pieces = kept.filter((c) => c.splitsCardId !== null);
  const split = [...new Set(pieces.map((c) => c.splitsCardId))];
  if (split.length) list = closeSplit(list, pieces, at);
  if ((created.length || updated.length) && !store.write(list)) {
    return { created: [], updated: [], split: [], warnings, error: 'could not save the to-do list' };
  }
  return { created, updated, split, warnings };
}

// ---- run ----------------------------------------------------------------------------

/**
 * Default runner: one `claude` call via execFile. Resolves {stdout} or
 * {error, detail}; never rejects. No MCP servers here, so execFile's own
 * timeout kill is enough (unlike the Playtester's browser tree).
 */
function execClaude({ args, prompt, cwd, env, timeoutMs, execImpl = execFile }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(execImpl, args, { cwd, env, timeoutMs }, resolve);
    } catch (err) {
      resolve({ error: 'failed', detail: clean(err && err.message, 300) });
      return;
    }
    if (child && child.stdin) {
      child.stdin.on('error', () => {}); // a child that died early must not crash main
      child.stdin.end(prompt);
    }
  });
}

function spawnClaude(execImpl, args, { cwd, env, timeoutMs }, resolve) {
  return execImpl(
    'claude',
    args,
    { cwd, env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
    (error, stdout) => {
      if (error && error.code === 'ENOENT') return resolve({ error: 'noClaude' });
      if (error && error.killed) return resolve({ error: 'timeout' });
      // A non-zero exit still prints the JSON envelope (is_error: true).
      if (error && !stdout) {
        const detail = clean(error.message, 300);
        return resolve({ error: isUsageLimitText(detail) ? 'limit' : 'failed', detail });
      }
      resolve({ stdout });
    },
  );
}

/** applyCards that turns a throwing store into an error, so the pack is still written. */
function safeApplyCards(store, cards, tag, opts) {
  try {
    return applyCards(store, cards, tag, opts);
  } catch (err) {
    return { created: [], updated: [], split: [], warnings: [], error: clean(err && err.message, 300) || 'store failed' };
  }
}

const readDoc = (repoDir, file) => clean(pack.readPackFile(repoDir, file) || '', MAX_DOC_CHARS);

const defaultLog = (message, detail) => console.error('[lunaswork-critic]', message, detail === undefined ? '' : detail);

const isStore = (s) => isObj(s) && typeof s.read === 'function' && typeof s.write === 'function';

function loadDocs(repoDir) {
  const architectureFull = (pack.readPackFile(repoDir, 'ARCHITECTURE.md') || '').trim();
  return {
    architectureCut: architectureFull.length > MAX_DOC_CHARS,
    brief: readDoc(repoDir, 'BRIEF.md'),
    design: readDoc(repoDir, 'DESIGN.md'),
    shipCriteria: readDoc(repoDir, 'SHIP_CRITERIA.md'),
    testPlan: readDoc(repoDir, 'TEST_PLAN.md'),
    architecture: readDoc(repoDir, 'ARCHITECTURE.md'),
    decisions: readDoc(repoDir, 'DECISIONS.md'),
    playtestLog: pack.readPackFile(repoDir, 'PLAYTEST_LOG.md') || '',
  };
}

const openCardBrief = (c) => ({ at: c.at, text: c.text, ...cardMeta(c), acceptance: c.acceptance || [] });
// The Critic splits a stuck card from what it asked for, not just its title.
const MAX_STUCK_DETAILS_CHARS = 1500;
const stuckCardBrief = (c) => ({ ...openCardBrief(c), details: clean(c.details, MAX_STUCK_DETAILS_CHARS), files: c.files || [] });

/**
 * Runs one Critic pass for a finished iteration and applies it: cards into
 * the to-do store, PLAYTEST_LOG / ARCHITECTURE / DECISIONS / TEST_PLAN into
 * design/. Always resolves. On failure nothing is applied and the verdict is
 * CONTINUE - an error never ships.
 *
 * @param {{repoDir:string, runId:string, iteration:number, milestone?:string|null,
 *   report:object, history?:object[], gitLog?:string, models?:object, env?:object,
 *   stuckCards?:number[], todoStore:{read:Function, write:Function, now?:Function},
 *   closedCards?:{text:string, kind?:string|null}[],
 *   runClaude?:(call:{args:string[], prompt:string, cwd:string, env:object, timeoutMs:number})=>Promise<object>,
 *   log?:(message:string, detail?:unknown)=>void, now?:()=>number, timeoutMs?:number, budgetUsd?:number}} opts
 * @returns {Promise<{ok:boolean, verdict:'continue'|'ship', model:string|null, modelReason:string|null,
 *   stepBack:boolean, gates:object[], milestone:object|null, next:string|null, allPassed:boolean,
 *   cards:{created:object[], updated:object[]}, split:number[], written:string[], warnings:object[],
 *   errors:object[], costUsd:number|null, durationMs:number, error?:string, detail?:string}>}
 *   split = the stuck cards (opts.stuckCards) the Critic split and closed
 *   closedCards = the cards the Playtester closed this iteration (LW 2.22a CHANGELOG.md entry)
 */
async function runCritic(opts) {
  const o = isObj(opts) ? opts : {};
  const now = o.now || Date.now;
  const log = typeof o.log === 'function' ? o.log : defaultLog;
  const started = now();
  const base = {
    verdict: 'continue',
    model: null,
    modelReason: null,
    stepBack: isStepBack(o.iteration),
    gates: [],
    milestone: null,
    next: null,
    allPassed: false,
    cards: { created: [], updated: [] },
    split: [],
    written: [],
    warnings: [],
    errors: [],
    costUsd: null,
  };
  let state = base;
  const fail = (error, detail) => {
    log(`critic failed: ${error}`, detail);
    const note = { code: error, ...(detail ? { detail } : {}) };
    return { ...state, ok: false, error, ...(detail ? { detail } : {}), errors: [...state.errors, note], durationMs: now() - started };
  };

  try {
    const tag = runTag(o.runId);
    if (!tag) return fail('badRunId', clean(String(o.runId), 100));
    if (!Number.isInteger(o.iteration) || o.iteration < 1) return fail('badIteration', String(o.iteration));
    if (!checkCwd(o.repoDir).ok) return fail('noRepo', clean(String(o.repoDir || ''), 300));
    if (!isStore(o.todoStore)) return fail('badStore');

    const docs = loadDocs(o.repoDir);
    const report = isObj(o.report) ? o.report : {};
    const gate = gateStatus({ shipCriteria: docs.shipCriteria, scores: report.scores, milestone: o.milestone || null });
    const pick = pickModel('critic', o.models, { gate: gate.currentPassed, stepBack: base.stepBack })
      || { model: FALLBACK_MODEL, reason: 'default' };
    state = {
      ...base,
      model: pick.model,
      modelReason: pick.reason,
      gates: gate.gates,
      milestone: gate.current ? { name: gate.current, passed: gate.currentPassed, score: gate.score } : null,
      next: gate.next,
      allPassed: gate.allPassed,
    };

    const open = updatableCards(normalizeTodos(o.todoStore.read()), tag);
    const stuckAts = new Set(Array.isArray(o.stuckCards) ? o.stuckCards : []);
    const stuck = open.filter((c) => stuckAts.has(c.at));
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildCriticArgs({ model: pick.model, budgetUsd: o.budgetUsd }),
      prompt: buildCriticPrompt({
        iteration: o.iteration,
        docs,
        report,
        history: o.history,
        gitLog: o.gitLog,
        openCards: open.map(openCardBrief),
        stuckCards: stuck.map(stuckCardBrief),
        gate,
      }),
      cwd: o.repoDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || CRITIC_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    state = { ...state, costUsd: parsed.costUsd };

    const critique = validateCritique(parsed.raw, {
      ideasAllowed: gate.currentPassed,
      allPassed: gate.allPassed,
      updatable: new Set(open.map((c) => c.at)),
      stuck: new Set(stuck.map((c) => c.at)),
    });
    if (critique.errors.length) return fail(critique.errors[0].code);

    // LW 2.19a: the design-match cards; one the model already rewrites that card is left to it.
    const taken = new Set(critique.cards.map((c) => c.updatesCardId).filter((at) => at !== null));
    const designCards = designMatchCards(report.designMatch, open).filter((c) => c.updatesCardId === null || !taken.has(c.updatesCardId));
    // LW 2.13: read after the Director's tick, so new cards land in the epic now being worked on.
    const epic = pack.activeEpic(pack.parseRoadmap(pack.readPackFile(o.repoDir, 'ROADMAP.md')));
    const applied = safeApplyCards(o.todoStore, [...critique.cards, ...designCards], tag, { epic: epic ? epic.slug : null });
    if (applied.error) log('critic could not save cards', applied.error);
    const date = new Date(now()).toISOString().slice(0, 10);
    // Cards that were not saved are work nobody will do: never ship past them.
    const verdict = applied.error ? 'continue' : critique.verdict;
    const packResult = writePack(o.repoDir, { ...critique, verdict }, {
      iteration: o.iteration,
      date,
      gate,
      architectureCut: docs.architectureCut,
      closedCards: o.closedCards,
    });
    return {
      ...state,
      ok: true,
      verdict,
      cards: { created: applied.created, updated: applied.updated },
      split: applied.split || [],
      // The DECISIONS.md lines of this pass, for the run report.
      decisions: critique.decisions,
      written: packResult.written,
      warnings: [...critique.warnings, ...applied.warnings, ...packResult.warnings],
      errors: applied.error ? [{ code: 'cardsNotSaved', detail: applied.error }] : [],
      durationMs: now() - started,
    };
  } catch (err) {
    return fail('crashed', clean(err && err.message, 300));
  }
}

// ---- LW 2.16: the review of a gate's skill proposals ---------------------------------

const SKILL_REVIEW_BUDGET_USD = 1;
const SKILL_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REVIEW_REASON_CHARS = 300;
const MAX_REVIEW_DESCRIPTION_CHARS = 300;
const MAX_REVIEW_BODY_CHARS = 8000;

/**
 * THE GATE of LW 2.16: one review per known proposal, first one wins. An
 * `edit` without a new description or body is dropped - an unreviewed
 * proposal is never written (lunasworkSkills.applyReview).
 * @param {unknown} raw model output
 * @param {{slug:string}[]} proposals
 * @returns {{reviews:{slug:string, verdict:string, reason:string, description?:string, body?:string}[], warnings:object[]}}
 */
function validateSkillReview(raw, proposals) {
  const known = new Set((Array.isArray(proposals) ? proposals : []).filter(isObj).map((p) => p.slug));
  const list = isObj(raw) && Array.isArray(raw.reviews) ? raw.reviews : [];
  const warnings = isObj(raw) && Array.isArray(raw.reviews) ? [] : [{ code: 'badSkillReview' }];
  const seen = new Set();
  const reviews = [];
  for (const r of list.slice(0, MAX_RAW_CARDS)) {
    const slug = isObj(r) && typeof r.slug === 'string' ? r.slug : '';
    if (!known.has(slug) || seen.has(slug) || !SKILL_VERDICTS.includes(r.verdict)) {
      warnings.push({ code: 'badSkillVerdict', slug: clean(slug, 80) });
      continue;
    }
    const description = clean(r.description, MAX_REVIEW_DESCRIPTION_CHARS);
    const body = clean(r.body, MAX_REVIEW_BODY_CHARS);
    if (r.verdict === 'edit' && !description && !body) {
      warnings.push({ code: 'emptySkillEdit', slug });
      continue;
    }
    seen.add(slug);
    reviews.push({
      slug,
      verdict: r.verdict,
      reason: clean(r.reason, MAX_REVIEW_REASON_CHARS),
      ...(r.verdict === 'edit' && description ? { description } : {}),
      ...(r.verdict === 'edit' && body ? { body } : {}),
    });
  }
  return { reviews, warnings };
}

/**
 * The Critic's review of a milestone gate's skill proposals (LW 2.16): one
 * read-only headless call. Always resolves; on any failure `reviews` is empty,
 * so nothing gets written.
 * @param {{repoDir:string, proposals:object[], milestone?:string|null, models?:object, env?:object,
 *   docs?:{architecture?:string, decisions?:string}, runClaude?:Function, timeoutMs?:number, budgetUsd?:number}} opts
 * @returns {Promise<{ok:boolean, reviews:object[], model:string|null, warnings:object[], costUsd:number|null,
 *   error?:string, detail?:string}>}
 */
async function reviewSkills(opts) {
  const o = isObj(opts) ? opts : {};
  const proposals = Array.isArray(o.proposals) ? o.proposals.filter(isObj) : [];
  const base = { reviews: [], model: null, warnings: [], costUsd: null };
  if (!proposals.length) return { ...base, ok: true };
  try {
    if (!checkCwd(o.repoDir).ok) return { ...base, ok: false, error: 'noRepo' };
    const pick = pickModel('critic', o.models, { gate: true }) || { model: FALLBACK_MODEL, reason: 'default' };
    const docs = isObj(o.docs) ? o.docs : loadDocs(o.repoDir);
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildCriticArgs({ model: pick.model, budgetUsd: o.budgetUsd || SKILL_REVIEW_BUDGET_USD, schema: SKILL_REVIEW_SCHEMA }),
      prompt: buildSkillReviewPrompt({ milestone: o.milestone || null, proposals, docs }),
      cwd: o.repoDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || SKILL_REVIEW_TIMEOUT_MS,
    });
    const state = { ...base, model: pick.model };
    if (!isObj(call) || call.error) return { ...state, ok: false, error: (isObj(call) && call.error) || 'failed', detail: isObj(call) ? call.detail : undefined };
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return { ...state, ok: false, error: parsed.error, detail: parsed.detail };
    const checked = validateSkillReview(parsed.raw, proposals);
    return { ...state, ok: true, reviews: checked.reviews, warnings: checked.warnings, costUsd: parsed.costUsd };
  } catch (err) {
    return { ...base, ok: false, error: 'crashed', detail: clean(err && err.message, 300) };
  }
}

module.exports = {
  CRITIC_SCHEMA,
  CRITIC_TOOLS,
  GATE_PASS_SCORE,
  REPRO_ACCEPTANCE,
  KINDS,
  SEVERITIES,
  gateStatus,
  cardMeta,
  validateCritique,
  buildCriticPrompt,
  buildCriticArgs,
  applyCards,
  formatLogEntry,
  execClaude,
  runCritic,
  validateSkillReview,
  reviewSkills,
};
