// ============================================================================
// LunaCore - Free God Mode v2 plan runs: board view, report and sizing (F1e/F1f)
// ----------------------------------------------------------------------------
//   planRunView(plan)        what the board shows of a plan run: topics, the
//                            topics -> critique -> synthesis progress, stall
//                            reasons, flagged tasks, written docs
//   planRunReportLines(view) the run report's "Plan documents" section: a
//                            link to every .md written (copies next to the
//                            report, <runsDir>/<planId>-plan/<file>.md)
//   planSizingStep(text, fs) PLAN.md's tasks through planTasks.js: accept,
//                            ONE split round back to the synthesis writer, or
//                            flag on the board (never blocks the run)
//
// Pure: the fs helpers are injected.
// ============================================================================

'use strict';

const core = require('./orchestraPlanRun');
const { parsePlanTasks, checkTaskSizing, nextSizingStep } = require('./planTasks');

/** Stall reasons of the plan-run finish guard (orchestraPlanRun.js). */
const PLAN_STALL_REASONS = new Set([core.STALL_OUTSIDE, core.STALL_NO_SOURCES, core.STALL_BAD_PLAN_RUN]);
/** A doc file name LunaCore itself made: <topic>.md, CRITIQUE.md or PLAN.md. */
const DOC_FILE_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|CRITIQUE|PLAN)\.md$/;
const MAX_REQUEST_VIEW_CHARS = 600;
const MAX_FLAGGED = 30;
const MAX_REASON_CHARS = 200;
const PLAN_DOCS_SUFFIX = '-plan';
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;

/** The doc file a plan-run package writes (its basename), or null. */
function planDocFile(pkg) {
  const out = pkg && pkg.planRun && typeof pkg.planRun.outputPath === 'string' ? pkg.planRun.outputPath : '';
  const file = out.split('/').pop() || '';
  return DOC_FILE_RE.test(file) ? file : null;
}

/** The folder (relative to the runs dir) the run's doc copies live in, or null. */
function planDocsDir(planId) {
  return RUN_ID_RE.test(String(planId || '')) ? `${planId}${PLAN_DOCS_SUFFIX}` : null;
}

const roleOf = (p) => (p && p.planRun ? p.planRun.role : null);

/** Package state for the board's three phases (a stall wins over pending). */
function phaseState(pkgs) {
  if (!pkgs.length) return 'pending';
  if (pkgs.every((p) => p.state === 'pushed')) return 'done';
  if (pkgs.some((p) => p.state === 'stalled' || p.state === 'failed' || p.state === 'killed')) return 'stalled';
  if (pkgs.some((p) => p.state === 'launched' || p.state === 'finishing')) return 'running';
  return 'pending';
}

/**
 * The plan-run part of the board view, or null for a build run.
 * @param {object|null} plan the controller's plan
 * @returns {null | {runSlug:string, folder:string, request:string, planner:string,
 *   topics:Array<{slug:string, question:string, state:string}>,
 *   phases:{topics:{state:string, done:number, total:number}, critique:{state:string}, synthesis:{state:string}},
 *   stalls:Array<{id:string, reason:string, detail:string|null}>,
 *   flagged:Array<{index:number, text:string, reasons:string[]}>,
 *   docs:Array<{id:string, file:string, path:string, branch:string|null}>, ready:boolean}}
 */
function planRunView(plan) {
  const pr = plan && plan.planRun;
  if (!pr || !core.validateRunSlug(pr.runSlug).ok) return null;
  const pkgs = Array.isArray(plan.packages) ? plan.packages : [];
  const topicPkgs = pkgs.filter((p) => roleOf(p) === core.ROLE_TOPIC);
  const critique = pkgs.filter((p) => roleOf(p) === core.ROLE_CRITIQUE);
  const synthesis = pkgs.filter((p) => roleOf(p) === core.ROLE_SYNTHESIS);
  const saved = new Set(Array.isArray(pr.saved) ? pr.saved : []);
  const docs = pkgs
    .filter((p) => p.state === 'pushed' && saved.has(p.id) && planDocFile(p))
    .map((p) => ({ id: p.id, file: planDocFile(p), path: p.planRun.outputPath, branch: p.branch || null }));
  return {
    runSlug: pr.runSlug,
    folder: core.planFolder(pr.runSlug),
    request: typeof pr.request === 'string' ? pr.request.slice(0, MAX_REQUEST_VIEW_CHARS) : '',
    planner: pr.planner === 'free' ? 'free' : 'claude',
    topics: (Array.isArray(pr.topics) ? pr.topics : []).map((t) => {
      const pkg = topicPkgs.find((p) => p.planRun.topic === t.slug);
      return { slug: t.slug, question: t.question, state: pkg ? pkg.state : 'pending' };
    }),
    phases: {
      topics: {
        state: phaseState(topicPkgs),
        done: topicPkgs.filter((p) => p.state === 'pushed').length,
        total: topicPkgs.length,
      },
      critique: { state: phaseState(critique) },
      synthesis: { state: phaseState(synthesis) },
    },
    stalls: pkgs
      .filter((p) => p.state === 'stalled' && typeof p.error === 'string' && PLAN_STALL_REASONS.has(p.error))
      .map((p) => ({ id: p.id, reason: p.error, detail: typeof p.detail === 'string' ? p.detail.slice(0, 600) : null })),
    flagged: (Array.isArray(pr.flagged) ? pr.flagged : []).slice(0, MAX_FLAGGED),
    docs,
    ready: synthesis.length > 0 && synthesis.every((p) => p.state === 'pushed'),
    // F4a: when "Approve plan" merged it and how many to-dos it made.
    approved: normalizeApproved(pr.approved),
  };
}

/** A stored / live "Approve plan" outcome, or null. */
function normalizeApproved(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at)) return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1000) : 0);
  return { at: raw.at, created: n(raw.created), skipped: n(raw.skipped) };
}

// eslint-disable-next-line no-control-regex
const oneLine = (s, max) => String(s || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

/**
 * The report's result line for a plan run (the hub item shows it).
 * @param {NonNullable<ReturnType<typeof planRunView>>} pr
 * @param {number} total packages in the run
 */
function planRunResult(pr, total) {
  const n = pr.docs.length;
  return pr.ready ? `Plan ready to review - ${n} of ${total} documents written` : `${n} of ${total} plan documents written`;
}

/**
 * The run report's plan section: every .md written, linked to its copy next
 * to the report, plus the flagged tasks and the plan-guard stalls.
 * @param {{id:string, planRun:ReturnType<typeof planRunView>}} view
 * @returns {string[]} markdown lines (empty for a build run)
 */
function planRunReportLines(view) {
  const pr = view && view.planRun;
  if (!pr) return [];
  const dir = planDocsDir(view.id);
  const docLine = (d) => {
    const where = `\`${d.path}\`${d.branch ? ` on \`${d.branch}\`` : ''}`;
    return dir ? `- [${d.file}](${dir}/${d.file}) - ${where}` : `- ${d.file} - ${where}`;
  };
  return [
    '',
    '## Plan documents',
    '',
    `- Plan run \`${pr.runSlug}\` (${pr.planner} planner) - ${pr.ready ? 'Plan ready to review' : 'not finished'}`,
    ...(pr.request ? [`- Request: ${oneLine(pr.request, 300)}`] : []),
    ...(pr.docs.length ? pr.docs.map(docLine) : ['- No document was written']),
    ...(pr.flagged.length
      ? [
          '',
          '### Flagged tasks',
          '',
          ...pr.flagged.map((f) => `- Task ${f.index + 1}: ${oneLine(f.text, 200)} - ${f.reasons.map((r) => oneLine(r, MAX_REASON_CHARS)).join('; ')}`),
        ]
      : []),
    ...(pr.stalls.length
      ? ['', '### Plan guard', '', ...pr.stalls.map((s) => `- ${s.id}: ${s.reason}${s.detail ? ` - ${oneLine(s.detail, 300)}` : ''}`)]
      : []),
  ];
}

/**
 * PLAN.md's tasks -> what happens next. Plan docs are written by free models,
 * so the strict (countable) checks apply. A PLAN.md without a single task, or
 * one that cannot be read, is flagged too.
 * @param {string|null} text PLAN.md
 * @param {{repoRoot:string, fileExists:Function, lineCount:Function, splitsSent?:number, planPath:string}} opts
 * @returns {{action:'accept'} | {action:'split', brief:string}
 *   | {action:'flag', flagged:Array<{index:number, text:string, reasons:string[]}>}}
 */
function planSizingStep(text, opts) {
  if (typeof text !== 'string') {
    return { action: 'flag', flagged: [{ index: -1, text: opts.planPath, reasons: ['PLAN.md could not be read'] }] };
  }
  const tasks = parsePlanTasks(text);
  if (!tasks.length) {
    return { action: 'flag', flagged: [{ index: -1, text: opts.planPath, reasons: ['no `## Tasks` checkbox list'] }] };
  }
  const sizing = checkTaskSizing(tasks, { strict: true, repoRoot: opts.repoRoot, fileExists: opts.fileExists, lineCount: opts.lineCount });
  const step = nextSizingStep(sizing, { splitsSent: opts.splitsSent || 0, planPath: opts.planPath });
  if (step.action !== 'flag') return step;
  return {
    action: 'flag',
    flagged: step.flagged.slice(0, MAX_FLAGGED).map((f) => ({
      index: f.index,
      text: oneLine(f.text, 300),
      reasons: f.reasons.map((r) => oneLine(r, MAX_REASON_CHARS)),
    })),
  };
}

/** The text pasted to the synthesis worker for its one split round. */
function splitRoundText(pkgId, brief) {
  // The worker has no shell: LunaCore commits the fixed PLAN.md on its finish.
  const text = String(brief).replace('Commit the change.', 'LunaCore commits it for you.');
  return `${text}\n\nWhen the Tasks section is fixed, end your final message with the line \`LUNA_DONE ${pkgId}\`.`;
}

const strCap = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * A stored package's planRun flag (orchestraSupervisor.normalizePackage).
 * Present but unreadable stays present as {}: the finish guard then stalls
 * the package 'badPlanRun' instead of finishing it like a build package.
 * @param {unknown} raw
 * @returns {object|undefined} undefined = a build package (no flag)
 */
function normalizeStoredPlanRunFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    runSlug: strCap(raw.runSlug, 64),
    role: strCap(raw.role, 16),
    ...(typeof raw.topic === 'string' ? { topic: raw.topic.slice(0, 64) } : {}),
    outputPath: strCap(raw.outputPath, 200),
  };
}

/**
 * A stored run's plan-run block (orchestraSupervisor.normalizeStoredPlan),
 * or null for a build run / an unreadable block.
 * @param {unknown} raw
 */
function normalizeStoredPlanRun(raw) {
  if (!raw || typeof raw !== 'object' || !core.validateRunSlug(raw.runSlug).ok) return null;
  const topics = core.validateTopics(Array.isArray(raw.topics) ? raw.topics : []).topics;
  const flagged = (Array.isArray(raw.flagged) ? raw.flagged : [])
    .filter((f) => f && Number.isInteger(f.index) && typeof f.text === 'string')
    .slice(0, MAX_FLAGGED)
    .map((f) => ({
      index: f.index,
      text: oneLine(f.text, 300),
      reasons: (Array.isArray(f.reasons) ? f.reasons : []).filter((r) => typeof r === 'string').map((r) => oneLine(r, MAX_REASON_CHARS)).slice(0, 10),
    }));
  return {
    runSlug: raw.runSlug,
    request: strCap(raw.request, core.MAX_GOAL_CHARS),
    planner: raw.planner === 'free' ? 'free' : 'claude',
    topics,
    saved: (Array.isArray(raw.saved) ? raw.saved : []).filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,24}$/.test(id)).slice(0, 12),
    flagged,
    ...(normalizeApproved(raw.approved) ? { approved: normalizeApproved(raw.approved) } : {}),
  };
}

module.exports = {
  normalizeStoredPlanRunFlag,
  normalizeStoredPlanRun,
  PLAN_STALL_REASONS,
  PLAN_DOCS_SUFFIX,
  planDocFile,
  planDocsDir,
  planRunView,
  planRunResult,
  planRunReportLines,
  planSizingStep,
  splitRoundText,
};
