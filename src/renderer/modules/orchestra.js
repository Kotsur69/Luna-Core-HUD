// ============================================================================
// LunaCore - God Mode v2 plan review + run board (DONE_ORCHESTRATOR_PLAN.md 3 + 4)
// ----------------------------------------------------------------------------
// The DOM half of src/orchestra.js. "Plan packages" in the to-do widget opens
// #orchestra (static markup in index.html, .palette overlay CSS like #ask):
// first the to-do picker (orchestraPick.js) - only ticked cards are planned -
// while the headless planner runs it says so, then it shows the plan - a
// summary with the estimate (idea #3), warnings, the planner's notes and one
// card per package with an editable prompt.
//
// Approve starts the run: main's supervisor (slice 4) launches packages as
// their dependencies get pushed, finishes each one on LUNA_DONE and stalls
// what it cannot finish. The board shows each package's phase and stall
// reason, with Retry per package and a Kill switch for the whole run (also
// Ctrl+Shift+K). Before the start: when (now / at HH:MM / when the 5 h window
// resets) and what to do with the pushed branches (PRs / merge / nothing).
// After it: overlap warnings, allow-rule suggestions from stalled prompts,
// PR links, and "Finish run" to integrate + report by hand. The plan itself lives in main; this module only renders the
// view main pushes on orchestra:changed and sends back ids + edited prompts.
// Several projects can run at once (MULTI_GODMODE_PLAN.md A4): the board shows
// one of them (orchestraBoard.js, switcher strip in orchestraSwitcher.js) and
// every action passes that project's id; planning still uses the active tab.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { term, getActiveSessionId } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
import { failureBlock, runOptionsRow, powerBanner, batteryBanner } from './orchestraDetails.js';
import { hybridLines } from './orchestraHybridView.js';
import { evolutionLines, isUndecidedGroup } from './orchestraEvolutionView.js';
import { pkgStateKey, recoverAsk } from './orchestraState.js';
import { pkgErrorText, progressText, ladderLines } from './orchestraCardLines.js';
import { retryRefusal, refusalStillValid, canAbortFinish } from './orchestraRetry.js';
import { loadPicker, pickerView } from './orchestraPick.js';
import { loadWorkerModel, chosenWorkerModel, takesWorkerModel, runModelLabel, packageModelBadge, workerModelControls } from './orchestraWorkerModel.js';
import { runEmailRow, releaseRow, releaseAfterBox, releaseAfterChoice, integrationLine, reportRow } from './orchestraFinish.js';
import * as board from './orchestraBoard.js';
import { switcherStrip } from './orchestraSwitcher.js';
import { runTypeSwitch, planOnlyForm, resetPlanOnlyForm, planRunPanel } from './orchestraPlanRun.js';
import { resumeBanner, pauseRow } from './orchestraResumeBanner.js';
// Guarded: node tests import the to-do widget chain without a document.
const overlay = typeof document !== 'undefined' ? document.getElementById('orchestra') : null;
const q = (sel) => (overlay ? overlay.querySelector(sel) : null);
const body = q('#orchestra-body');
const approveBtn = q('#orchestra-approve');
const replanBtn = q('#orchestra-replan');
const discardBtn = q('#orchestra-discard');
const killBtn = q('#orchestra-kill');

// Error codes main can return that have their own message; anything else
// reads as the generic one.
const FAIL_CODES = new Set([
  'noTodos', 'busy', 'runActive', 'noClaude', 'noRepo', 'timeout', 'budget', 'limit', 'badJson', 'failed',
  'noTab', 'noPlan', 'planErrors', 'nothingToLaunch', 'notRetryable', 'briefFailed', 'paused',
  'noNodeModules', 'notHeld', 'installFailed',
  'badSchedule', 'noReset', 'badRule', 'mergeDeclined', 'noFreeProfile', 'badOptions', 'noneSelected',
  'lunasWorkActive', 'batteryLow', 'notFinishing', 'tooEarly', 'notAbortable', 'repoBusy',
  // Free God Mode v2 plan runs (orchestraPlanRun.js).
  'noPlanProfile', 'noLockdown', 'badTopics', 'emptyRequest', 'requestTooLong', 'badPlanner', 'badRepo',
  'unknownRepo', 'noDoc',
  // "Approve plan" (orchestraPlanApprove.js, F4a).
  'notPlanRun', 'notReady', 'noPlanDoc', 'noBase', 'unsafeBranch', 'notOnBase', 'noBranch',
  'outsidePlanFolder', 'mergeConflict', 'mergeInProgress', 'gitFailed', 'noTasks', 'todoWriteFailed', 'badId', 'unavailable',
  // Resume after a shutdown / Pause for shutdown (orchestraResumeBanner.js).
  'notInterrupted', 'notRunning', 'alreadyPaused',
  // A/B builds (src/orchestraVariants.js): a plan with variants runs on Claude workers only.
  'abNeedsClaude',
]);
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
// Package phases that hold a worker slot (orchestraSupervisor's ACTIVE_STATES).
const ACTIVE = new Set(['launched', 'finishing']);
const RETRYABLE = new Set(['stalled', 'closed', 'killed']);
const isActive = (pkg) => ACTIVE.has(pkg.state);

let isOpen = false;
/** Latest plan view from main, or null. */
let plan = null;
/** 'idle' | 'planning' | 'launching' (also covers retry / kill / discard) */
let phase = 'idle';
/** Error code of the last plan/launch attempt, shown above the board. */
let failure = null;
/** What an Approve plan refusal names (paths, branch); shown after the reason. */
let failureDetail = null;
/**
 * Planning parked on a spent Claude limit (main's orchestraPlanWait.js):
 * {state:'waiting'|'planning', resumeAt, window} or null.
 */
let planWait = null;
/** The package whose single Launch / Retry is in flight, or null. */
let busyPkg = null;
/** Why the last Retry of a package was refused: pkgId -> {code, whileFinishing}. */
const retryRefusals = new Map();
/** Re-renders the board when "Abort finish" becomes available. */
let abortRevealTimer = null;
/** A run-options change on its way to main. */
let optionsBusy = false;
/** The to-do picker is on screen instead of the board (orchestraPick.js). */
let picking = false;
/** Edited prompts, `${planId}:${pkgId}` -> text, until launched. */
const drafts = new Map();
/** Where a new run starts: 'build' (the to-do picker) or 'plan' (Plan only). */
let runMode = 'build';
/** Start options picked on the board before Approve. */
// workers: F6 "Workers" picked on the board (null = the plan's own choice).
const startOpts = { when: 'now', time: '01:00', integration: null, workers: null };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const msg = (text, cls = '') => el('p', `orchestra__msg ${cls}`.trim(), text);
const draftKey = (pkgId) => `${plan ? plan.id : ''}:${pkgId}`;

function fmtMinutes(total) {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return h ? t('orch.time.h', { h, m }) : t('orch.time.m', { m });
}

function failText(code, detail) {
  if (code === 'repoBusy') return t('orch.err.repoBusy');
  // Approve plan names what was in the way (paths, the branch on screen).
  if (detail && (code === 'outsidePlanFolder' || code === 'notOnBase' || code === 'mergeConflict')) {
    return `${t(`orch.fail.${code}`)} ${detail}`;
  }
  // A Resume refused for node_modules says why it is still broken.
  if (code === 'noNodeModules') return t('orch.fail.noNodeModules', { why: holdWhy(plan && plan.hold) });
  return t(`orch.fail.${FAIL_CODES.has(code) ? code : 'failed'}`);
}

/** Why a 'noNodeModules' hold holds: missing / empty / which package is not installed. */
function holdWhy(hold) {
  const cause = hold ? hold.cause : null;
  if (cause === 'unresolved' && hold.missing) return t('orch.noNodeModules.unresolved', { pkg: hold.missing });
  if (cause === 'missing' || cause === 'empty') return t(`orch.noNodeModules.${cause}`);
  return t('orch.noNodeModules.unknown');
}

function warningText(w) {
  // Free planner (orchestraPlanBuild.js): a package still too big after one resize round.
  if (w.code === 'sizing') return t('orch.warn.sizing', { id: w.id, reasons: (w.reasons || []).join('; ') });
  if (w.code === 'uncovered') return t('orch.warn.uncovered', { list: w.texts.join('; ') });
  if (w.code === 'overlap') return t('orch.warn.overlap', { a: w.a, b: w.b, files: w.files.join(', ') });
  return t(`orch.warn.${w.code}`, { id: w.id, dep: w.dep });
}

function errorText(e) {
  return e.code === 'cycle' ? t('orch.err.cycle', { ids: e.ids.join(', ') }) : t(`orch.err.${e.code}`);
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function selectEl(options, value, onChange) {
  const sel = el('select', 'profile-select');
  for (const [v, label] of options) {
    const opt = el('option', '', label);
    opt.value = v;
    sel.append(opt);
  }
  sel.value = value;
  sel.disabled = phase !== 'idle';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

const integrationOptions = () => INTEGRATION_MODES.map((m) => [m, t(`orch.integ.${m}`)]);
const chosenIntegration = () => startOpts.integration || plan.integrationMode || 'pr';

/**
 * F6 "Workers" at Approve. "Plan with free models in mind" is offered only
 * for a plan the planner made that way; a free-planned plan is free-only.
 */
function workerOptions() {
  if (plan.buildPlanner === 'free') return ['free'];
  return plan.workers === 'hybrid' ? ['claude', 'hybrid', 'free'] : ['claude', 'free'];
}
const chosenWorkers = () => {
  const options = workerOptions();
  if (options.includes(startOpts.workers)) return startOpts.workers;
  return options.includes(plan.workers) ? plan.workers : options[0];
};

/** Before the start: when to start and what to do with the pushed branches. */
function startOptions() {
  const row = el('div', 'orchestra__options');
  const when = selectEl(
    [['now', t('orch.when.now')], ['time', t('orch.when.time')], ['reset', t('orch.when.reset')]],
    startOpts.when,
    (v) => {
      startOpts.when = v;
      render();
    },
  );
  row.append(el('span', 'orchestra__optlabel', t('orch.when')), when);
  if (startOpts.when === 'time') {
    const time = el('input', 'orchestra__time');
    time.type = 'time';
    time.value = startOpts.time;
    time.disabled = phase !== 'idle';
    time.addEventListener('change', () => {
      startOpts.time = time.value;
    });
    row.append(time);
  }
  // F6 "Workers" (replaces the "Free providers" tick). Free only = workers on
  // the fallback-chain profile, luna-free/ branches only - so the integration
  // select has nothing to choose.
  const workersLabel = el('span', 'orchestra__optlabel', t('orch.workerMode'));
  workersLabel.title = t('orch.workerMode.hint');
  const workersSel = selectEl(
    workerOptions().map((w) => [w, t(`orch.workerMode.${w}`)]),
    chosenWorkers(),
    (v) => {
      startOpts.workers = v;
      render();
    },
  );
  // A free-planned plan is always free-only (D1).
  if (plan.buildPlanner === 'free') workersSel.disabled = true;
  row.append(workersLabel, workersSel);
  if (chosenWorkers() !== 'free') {
    // Which Claude model every worker runs on (saved pref, frozen at start).
    if (takesWorkerModel(plan)) row.append(...workerModelControls(plan, phase !== 'idle', render));
    row.append(
      el('span', 'orchestra__optlabel', t('orch.integ')),
      selectEl(integrationOptions(), chosenIntegration(), (v) => {
        startOpts.integration = v;
        render();
      }),
    );
    // A release only follows a merge into the base branch.
    if (chosenIntegration() === 'merge') row.append(releaseAfterBox(plan.projectId, phase !== 'idle'));
  }
  return row;
}

/**
 * The integration line (orchestraFinish.js), plus "Abort finish" once a long
 * finish passes main's threshold.
 */
function integrationText() {
  const line = integrationLine(plan);
  if (!line) return null;
  const integ = plan.integration || {};
  const running = integ.running || integ.state === 'running';
  if (!running || !canAbortFinish(plan, Date.now())) return line;
  const box = el('div', 'orchestra__power');
  box.append(line, abortFinishRow());
  return box;
}

/** "Abort finish" with its hint: frees a board stuck in a long finish. */
function abortFinishRow() {
  const row = el('div', 'orchestra__actions');
  row.append(el('span', 'orchestra__meta', t('orch.abortFinish.hint')));
  const btn = el('button', 'pad-send', t('orch.abortFinish'));
  btn.type = 'button';
  btn.disabled = phase !== 'idle';
  btn.addEventListener('click', abortFinish);
  row.append(btn);
  return row;
}

/** Once the finish passes main's threshold the board shows "Abort finish" on its own. */
function armAbortReveal() {
  if (abortRevealTimer) clearTimeout(abortRevealTimer);
  abortRevealTimer = null;
  const integ = (plan && plan.integration) || {};
  if (!isOpen || !integ.running || !Number.isFinite(integ.abortAfter)) return;
  const wait = integ.abortAfter - Date.now();
  if (wait <= 0) return;
  abortRevealTimer = setTimeout(() => {
    abortRevealTimer = null;
    if (isOpen) render();
  }, wait + 1000);
}

/** Why Retry was refused, beside the package's own buttons; stale ones go. */
function refusalBlock(pkg) {
  const refusal = retryRefusals.get(pkg.id);
  if (!refusal) return null;
  const { code, whileFinishing } = refusal;
  if (!RETRYABLE.has(pkg.state) || !refusalStillValid(code, plan, whileFinishing)) {
    retryRefusals.delete(pkg.id);
    return null;
  }
  const { key, at } = retryRefusal(code, plan);
  const box = el('div', 'orchestra__failure');
  const line = msg(t(key, at === null ? {} : { time: clock(at) }), 'is-warn');
  line.setAttribute('role', 'status');
  box.append(line);
  if (code === 'busy' && canAbortFinish(plan, Date.now())) box.append(abortFinishRow());
  return box;
}

/** After the run: wrap it up by hand (integrate + clean up + report). */
function finishRow() {
  const row = el('div', 'orchestra__options');
  row.append(
    el('span', 'orchestra__optlabel', t('orch.integ')),
    selectEl(integrationOptions(), chosenIntegration(), (v) => {
      startOpts.integration = v;
    }),
  );
  const btn = el('button', 'pad-send', t('orch.finish'));
  btn.type = 'button';
  btn.title = t('orch.finish.hint');
  btn.disabled = phase !== 'idle' || !!(plan.integration && plan.integration.running);
  btn.addEventListener('click', finishRun);
  row.append(btn);
  return row;
}

/** Idea #5: "Bash(npx tsc:*) stalled 2 workers" + Allow for future workers. */
function suggestionRow(s) {
  const row = el('div', 'orchestra__options');
  const line = el('span', 'orchestra__msg is-warn', t('orch.suggest', { rule: s.rule, n: s.count }));
  // The real command, so "Allow" is decided on what actually ran.
  if (s.example) line.append(el('code', 'orchestra__example', s.example));
  row.append(line);
  const btn = el('button', 'pad-send', t('orch.allow'));
  btn.type = 'button';
  btn.title = t('orch.allow.hint');
  btn.disabled = phase !== 'idle';
  btn.addEventListener('click', () => act(() => window.lunacore.allowOrchestraTool(s.rule, board.project())).then(refetchAndRender));
  row.append(btn);
  return row;
}

// An undecided A/B group launches through its variants, never by itself.
const canLaunch = (pkg) => (pkg.state === 'pending' || pkg.state === 'failed') && !isUndecidedGroup(pkg);

/**
 * Why the hybrid guard (src/orchestraHybridGuard.js) moved a "free" package
 * to Sonnet; null when it did not. Protected kinds come from config (a repo
 * can add its own), so the kind name is shown as it is.
 * @param {{from:string, reasons:Array<{code:string, n?:number, kind?:string, file?:string}>}|null} g
 */
function hybridGuardText(g) {
  if (!g || !Array.isArray(g.reasons) || !g.reasons.length) return null;
  const reasons = g.reasons.map((r) => t(`orch.hybrid.r.${r.code}`, { n: r.n, kind: r.kind, file: r.file }));
  return t('orch.hybrid.upgraded', { reasons: reasons.join('; ') });
}

function pkgCard(pkg) {
  const card = el('section', `orchestra__pkg is-${pkg.state}`);

  const head = el('div', 'orchestra__head');
  head.append(
    el('span', 'orchestra__title', pkg.title),
    el('span', 'orchestra__id', pkg.id),
    el('span', `orchestra__state is-${pkg.state}`, t(`orch.state.${pkgStateKey(pkg)}`)),
  );
  card.append(head);

  const meta = [];
  if (pkg.dependsOn.length) meta.push(t('orch.after', { ids: pkg.dependsOn.join(', ') }));
  if (pkg.files.length) meta.push(t('orch.files', { n: pkg.files.length }));
  if (pkg.verify) meta.push(t('orch.verify', { cmd: pkg.verify }));
  // The model it WILL run on (override, planner's pick or the run's choice).
  const badge = packageModelBadge(pkg, plan, plan.started || plan.scheduledAt ? plan.workers : chosenWorkers());
  if (badge) meta.push(badge);
  // The Claude account the worker is on (claude-accounts failover), when main says.
  if (typeof pkg.account === 'string' && pkg.account) meta.push(t('orch.account.on', { account: pkg.account }));
  if (pkg.branch) meta.push(pkg.branch);
  if (meta.length) {
    const line = el('div', 'orchestra__meta', meta.join(' · '));
    if (pkg.files.length) line.title = pkg.files.join('\n');
    card.append(line);
  }
  // F6 guard: the planner marked it "free", the rules moved it to Sonnet.
  const guard = hybridGuardText(pkg.hybridGuard);
  if (guard) card.append(msg(guard, 'is-warn'));
  // F6c/F6d: runs free, the Claude review, limit waits, hand-overs to Sonnet.
  for (const line of hybridLines(pkg)) card.append(msg(line.text, line.cls));
  // Opt-in evolutions: A/B builds, self-heal, context guard.
  for (const line of evolutionLines(pkg)) card.append(msg(line.text, line.cls));

  if (pkg.todos.length) {
    const list = el('ul', 'orchestra__todos');
    for (const text of pkg.todos) list.append(el('li', '', text));
    card.append(list);
  }

  const prompt = el('textarea', 'orchestra__prompt');
  prompt.spellcheck = false;
  prompt.value = drafts.has(draftKey(pkg.id)) ? drafts.get(draftKey(pkg.id)) : pkg.prompt;
  prompt.readOnly = !canLaunch(pkg);
  prompt.addEventListener('input', () => drafts.set(draftKey(pkg.id), prompt.value));
  card.append(prompt);

  if (pkg.state === 'failed' && pkg.failure) {
    // Structured record of the last failed launch; its time changes per attempt.
    card.append(failureBlock(pkg.failure, pkgErrorText));
  } else if (pkg.error) {
    const text = pkg.detail ? `${pkgErrorText(pkg.error)}: ${pkg.detail}` : pkgErrorText(pkg.error);
    card.append(msg(text, 'is-bad'));
    // A failed dependency install: the end of npm's output says why.
    if (pkg.error === 'installFailed' && pkg.verifyTail) card.append(el('pre', 'orchestra__tail', pkg.verifyTail));
  }

  // The recovery playbook's one ask: cause, what was tried, the next step.
  const ask = recoverAsk(pkg);
  // {dir}: the worktree folder, named like the branch slug (the board has no paths).
  const folder = pkg.branch ? `.luna-worktrees/.../${pkg.branch.split('/').pop()}` : pkg.id;
  if (ask) card.append(msg(t(ask.key, { pkg: pkg.id, dir: folder, branch: pkg.branch || '?' }), 'is-bad'));

  const progress = progressText(pkg);
  if (progress) card.append(el('div', 'orchestra__meta', progress));
  if (pkg.escalated) card.append(el('div', 'orchestra__meta', t('orch.progress.escalated')));
  for (const line of ladderLines(pkg, plan.packages)) card.append(el('div', 'orchestra__meta', line));
  if (pkg.prUrl) {
    const link = el('a', 'orchestra__link', pkg.prUrl);
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.lunacore.openOrchestraPr(pkg.id, board.project());
    });
    card.append(link);
  }

  const actions = el('div', 'orchestra__actions');
  const busy = busyPkg === pkg.id;
  const button = (label, onClick, disabled = phase !== 'idle', busyable = false) => {
    const btn = el('button', busyable && busy ? 'pad-send is-busy' : 'pad-send', busyable && busy ? t('orch.busy') : label);
    btn.type = 'button';
    btn.disabled = disabled || (busyable && busy);
    if (busyable && busy) btn.setAttribute('aria-busy', 'true');
    btn.addEventListener('click', onClick);
    actions.append(btn);
  };
  if (canLaunch(pkg)) button(t('orch.launch'), () => launch([pkg.id]), phase !== 'idle' || plan.errors.length > 0, true);
  if (RETRYABLE.has(pkg.state) && !isUndecidedGroup(pkg)) button(t('orch.retry'), () => retry(pkg.id), phase !== 'idle', true);
  if (pkg.sessionId && (isActive(pkg) || pkg.state === 'stalled')) {
    button(
      t('orch.goto'),
      () => {
        window.lunacore.activateSession(pkg.sessionId);
        closeOrchestra();
      },
      false,
    );
  }
  if (actions.childElementCount) card.append(actions);
  const refused = refusalBlock(pkg);
  if (refused) card.append(refused);
  return card;
}

/** Sends one run-option flip to main; main pushes the new plan view back. */
async function setRunOption(key, value) {
  if (!plan || optionsBusy) return;
  optionsBusy = true;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.orchestraSetOptions({ [key]: value }, board.project());
  } catch {
    res = { ok: false, error: 'failed' };
  }
  optionsBusy = false;
  if (!res || !res.ok) failure = (res && res.error) || 'failed';
  if (isOpen) render();
}

/** "Cancel sleep" / "Cancel shutdown"; main pushes the new view back. */
async function cancelPower(what) {
  try {
    await window.lunacore.cancelOrchestraPower(what, board.project());
  } catch {
    failure = 'failed';
    if (isOpen) render();
  }
}

// The wake check runs once per app start, the first time the board opens.
let wakeChecked = false;
function checkWakeOnce() {
  if (wakeChecked || !window.lunacore.checkOrchestraWake) return;
  wakeChecked = true;
  window.lunacore.checkOrchestraWake(board.project()).catch(() => {});
}

// A countdown that started opens the board once, so its Cancel is in reach.
let shownCountdown = null;
function countdownKey(next) {
  // A resume countdown after a shutdown opens the board too: Cancel in reach.
  const i = next && next.interrupted;
  if (i && Number.isFinite(i.resumeAt)) return `resume:${next.id}:${i.at}`;
  const power = next && next.power;
  if (!power) return null;
  const s = power.shutdown && power.shutdown.phase === 'countdown' ? `shutdown:${power.shutdown.at}` : null;
  return s || (power.sleep && power.sleep.phase === 'countdown' ? `sleep:${power.sleep.at}` : null);
}

function renderPlan() {
  const banner = powerBanner(plan, { onCancel: cancelPower });
  if (banner) body.append(banner);
  // This run's own resume-after-shutdown banner (one per run / board).
  const interrupted = resumeBanner(plan, {
    disabled: phase !== 'idle',
    onResume: () => act(() => window.lunacore.resumeInterruptedOrchestra(plan.id, board.project())),
    onCancel: () => act(() => window.lunacore.cancelOrchestraResume(plan.id, board.project())),
  });
  if (interrupted) body.append(interrupted);
  const pause = pauseRow(plan, {
    running: plan.packages.some(isActive),
    disabled: phase !== 'idle',
    onPause: () => act(() => window.lunacore.pauseOrchestraForShutdown(plan.id, board.project())),
  });
  if (pause) body.append(pause);
  const onBattery = batteryBanner(plan);
  if (onBattery) body.append(onBattery);
  armAbortReveal();
  // Always on top and usable during the run: the switches are live.
  body.append(runOptionsRow(plan, { disabled: optionsBusy, onToggle: setRunOption }));
  // A plan run: topics, progress, guard stalls, flagged tasks, doc links.
  if (plan.planRun) {
    body.append(planRunPanel(plan.planRun, { pkgErrorText, onOpenDoc: openPlanDoc, onApprove: approvePlan, disabled: phase !== 'idle' }));
  }
  const est = plan.estimate;
  let line = t('orch.summary', {
    n: plan.packages.length,
    wall: fmtMinutes(est.wallMinutes),
    workers: est.workers,
    work: fmtMinutes(est.workMinutes),
  });
  if (Number.isFinite(plan.costUsd)) line += ` · ${t('orch.cost', { usd: plan.costUsd.toFixed(2) })}`;
  if (plan.plannerEffort) line += ` · ${t('orch.plannerEffort', { effort: plan.plannerEffort })}`;
  // Only a planner model Mati picked instead of the default is worth a mention.
  if (plan.model && plan.model !== 'opus' && plan.buildPlanner !== 'free') line += ` · ${t('orch.plannerModel', { model: plan.model })}`;
  if (plan.buildPlanner === 'free') line += ` · ${t('orch.pick.planner.freeUsed')}`;
  body.append(el('div', 'orchestra__summary', line));
  body.append(el('div', 'orchestra__meta', t('orch.workers', { model: runModelLabel(plan), perm: plan.permissionMode })));
  const running = plan.packages.some(isActive);
  if (!plan.started && !plan.scheduledAt && !plan.errors.length) body.append(startOptions());
  if (plan.scheduledAt) body.append(scheduledRow());
  if (plan.started && !running && plan.packages.some((p) => p.state !== 'pending')) body.append(finishRow());
  const integ = integrationText();
  if (integ) body.append(integ);
  // The run email (src/godmodemail.js): its state + "Resend report email".
  if (hasReport()) body.append(runEmailRow(plan, () => isOpen && render(), board.project()));
  // "Create a new release after finish" result, or "Release now" (orchestraFinish.js).
  const release = hasReport() ? releaseRow(plan, () => isOpen && render()) : null;
  if (release) body.append(release);
  for (const o of plan.overlaps || []) {
    body.append(msg(t('orch.overlap', { a: o.a, b: o.b, files: o.files.join(', ') }), 'is-warn'));
  }
  for (const s of plan.suggestions || []) body.append(suggestionRow(s));
  if (plan.pausedUntil) {
    // Every Claude account limited: the run waits for the first reset. A free
    // run waits for its free chain (src/freeLimit.js), then retries on its own.
    const key = plan.allAccountsLimited === true ? 'orch.account.waitReset' : plan.freeMode ? 'orch.free.paused' : 'orch.paused';
    body.append(msg(t(key, { time: clock(plan.pausedUntil) }), 'is-warn'));
  }
  if (plan.hold && plan.hold.reason === 'noNodeModules') body.append(holdRow());
  if (plan.killed) body.append(msg(t('orch.killed'), 'is-bad'));
  if (plan.settled) {
    const pushed = (plan.tally && plan.tally.pushed) || 0;
    const total = plan.packages.length;
    body.append(msg(t('orch.settled', { pushed, total }), pushed === total ? '' : 'is-warn'));
  }
  if (hasReport()) body.append(reportRow(plan, board.project()));
  if (plan.dirty > 0) body.append(msg(t('orch.dirty', { n: plan.dirty }), 'is-warn'));
  for (const e of plan.errors) body.append(msg(errorText(e), 'is-bad'));
  for (const w of plan.warnings) body.append(msg(warningText(w), 'is-warn'));
  if (plan.notes) body.append(el('p', 'orchestra__notes', plan.notes));
  for (const pkg of plan.packages) body.append(pkgCard(pkg));
}

/** A settled (or already integrated) run has a morning report in runs/<id>.md. */
function hasReport() {
  const state = plan.integration && plan.integration.state;
  return plan.settled || state === 'done' || state === 'failed';
}

function scheduledRow() {
  const row = el('div', 'orchestra__options');
  row.append(el('span', 'orchestra__msg', t('orch.scheduled', { time: clock(plan.scheduledAt) })));
  const btn = el('button', 'pad-send', t('orch.unschedule'));
  btn.type = 'button';
  btn.disabled = phase !== 'idle';
  btn.addEventListener('click', () => act(() => window.lunacore.unscheduleOrchestra(plan.id, board.project())));
  row.append(btn);
  return row;
}

/**
 * The run is held for a broken node_modules: the message with the real reason
 * and Resume (main checks again; it also checks every minute on its own).
 */
function holdRow() {
  const row = el('div', 'orchestra__options');
  row.append(el('span', 'orchestra__msg is-bad', t('orch.noNodeModules', { repo: plan.hold.dir || '?', why: holdWhy(plan.hold) })));
  const btn = el('button', 'pad-send', t('orch.resume'));
  btn.type = 'button';
  btn.disabled = phase !== 'idle';
  btn.addEventListener('click', () => act(() => window.lunacore.resumeOrchestra(plan.id)));
  row.append(btn);
  return row;
}

/** Pending packages Approve would launch now: every dependency pushed. */
function hasReady() {
  const pushed = new Set(plan.packages.filter((p) => p.state === 'pushed').map((p) => p.id));
  return plan.packages.some((p) => p.state === 'pending' && p.dependsOn.every((d) => pushed.has(d)));
}

function updateButtons() {
  const idle = phase === 'idle';
  const running = !!plan && plan.packages.some(isActive);
  if (approveBtn) {
    approveBtn.hidden = !plan || picking;
    approveBtn.disabled =
      !idle || !plan || plan.errors.length > 0 || !hasReady() || (plan.started && !plan.killed && running) || !!plan.scheduledAt;
    const scheduling = !!plan && !plan.started && startOpts.when !== 'now';
    approveBtn.textContent = t(scheduling ? 'orch.schedule' : 'orch.approve');
  }
  if (replanBtn) {
    // Planning goes by the active tab: no Replan on another project's board.
    replanBtn.hidden = picking || !board.onActiveProject();
    replanBtn.disabled = !idle || running;
  }
  if (discardBtn) {
    discardBtn.hidden = !plan || picking;
    discardBtn.disabled = !idle || running;
  }
  // Kill is never locked by `phase`: an Approve/Retry holds the board busy
  // for the whole launch, which is exactly when stopping must still work.
  if (killBtn) killBtn.hidden = !(running || (plan && plan.started && !plan.killed && phase === 'launching'));
}

/** HH:MM (plus the date when it is not today) of an epoch ms. */
function fmtResume(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

/** The waiting state: why, when planning resumes, and a way out. */
function renderPlanWait() {
  if (!planWait || !board.onActiveProject()) return;
  if (planWait.state === 'planning') {
    body.append(msg(t('orch.planning')));
    return;
  }
  const box = el('div', 'orchestra__wait');
  const key = planWait.window === 'weekly' ? 'orch.wait.weekly' : planWait.window === '5h' ? 'orch.wait.fiveHour' : 'orch.wait.limit';
  box.append(msg(t(key, { time: fmtResume(planWait.resumeAt) })));
  const cancel = el('button', 'pad-send', t('orch.wait.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', cancelPlanWait);
  box.append(cancel);
  body.append(box);
}

async function cancelPlanWait() {
  try {
    await window.lunacore.cancelOrchestraPlanWait(await board.refreshActive());
  } catch {
    /* the wait state event below repaints either way */
  }
  planWait = null;
  if (isOpen) render();
}

function render() {
  if (!body) return;
  const active = document.activeElement;
  const chipFocused = !!(active && active.closest && active.closest('.orchestra-runs') && body.contains(active));
  body.replaceChildren();
  const strip = switcherStrip({ chips: board.chips(), selected: board.project(), onSelect: selectBoard, focus: chipFocused });
  if (strip) body.append(strip);
  if (phase === 'planning') body.append(msg(t('orch.planning')));
  renderPlanWait();
  if (failure) body.append(msg(failText(failure, failureDetail), 'is-bad'));
  if (picking && phase === 'idle') {
    body.append(runTypeSwitch({ mode: runMode, disabled: phase !== 'idle', onChange: setRunMode }));
  }
  if (picking && phase === 'idle' && runMode === 'plan') {
    body.append(planOnlyForm({ disabled: phase !== 'idle', onStart: startPlanRun }));
  } else if (picking && phase === 'idle') {
    body.append(
      pickerView({
        disabled: phase !== 'idle',
        canCancel: !!plan,
        onPlan: (ats, effort, planner, workers, model) => startPlanning(ats, effort, planner, workers, model),
        onCancel: () => {
          picking = false;
          render();
        },
        repaint: render,
      }),
    );
  } else if (plan) renderPlan();
  updateButtons();
}

/** Shows the to-do picker; the planner starts from its "Plan selected". */
async function openPicker() {
  if (phase !== 'idle') return;
  failure = null;
  await loadPicker(getActiveSessionId());
  // Closed while the list loaded: closeOrchestra already reset `picking`.
  if (!isOpen) return;
  picking = true;
  render();
}

/** @param {{reset?: boolean, project?: string|null}} [opts] see orchestraBoard.refresh */
async function refetch(opts) {
  await board.refresh(opts);
  plan = board.view();
}

/** A switcher chip: show that project's run (or plan the active tab's). */
function selectBoard(projectId) {
  if (phase !== 'idle') return;
  board.select(projectId);
  plan = board.view();
  failure = null;
  picking = false;
  startOpts.when = 'now';
  startOpts.integration = null;
  startOpts.workers = null;
  render();
  if (!plan && board.onActiveProject()) openPicker();
}

async function refetchAndRender() {
  await refetch();
  if (isOpen) render();
}

/**
 * @param {number[]} ats the picker's ticked to-dos
 * @param {string} [effort] the planner --effort (main falls back to high)
 * @param {'claude'|'free'} [planner] D1: who plans the build run
 * @param {'claude'|'hybrid'|'free'} [workers] F6 "Workers"
 * @param {string} [model] the Claude planner's model (main falls back to opus)
 */
async function startPlanning(ats, effort, planner, workers, model) {
  if (phase !== 'idle') return;
  phase = 'planning';
  picking = false;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.planOrchestra(getActiveSessionId(), ats, effort, planner, workers, model);
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok) {
    board.apply(res.plan);
    board.select(res.plan.projectId);
    plan = board.view();
    planWait = null;
    drafts.clear();
    retryRefusals.clear();
    startOpts.when = 'now';
    startOpts.integration = null;
    // The new plan carries the picker's choice; the board starts from it.
    startOpts.workers = null;
  } else if (res && res.error === 'waiting') {
    planWait = res.planWait || null;
  } else {
    failure = (res && res.error) || 'failed';
    await refetch(); // a refused re-plan keeps the old plan on screen
    // Nothing on screen to act on: back to the picker, error shown above it.
    if (!plan) picking = true;
  }
  if (isOpen) render();
}

/** Build / Plan only switch: only where a new run starts. */
function setRunMode(mode) {
  if (phase !== 'idle' || (mode !== 'build' && mode !== 'plan')) return;
  runMode = mode;
  failure = null;
  render();
}

/**
 * "Plan only": ONE topic split in main, then the run starts right away (Q6).
 * @param {string} request the free text
 * @param {'claude'|'free'} planner who splits it into topics
 */
async function startPlanRun(request, planner) {
  if (phase !== 'idle') return;
  phase = 'planning';
  picking = false;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.orchestraPlanRun('start', { request, planner, sessionId: getActiveSessionId() });
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok) {
    board.apply(res.plan);
    board.select(res.plan.projectId);
    plan = board.view();
    planWait = null;
    drafts.clear();
    retryRefusals.clear();
    resetPlanOnlyForm();
    runMode = 'build';
  } else if (res && res.error === 'waiting') {
    planWait = res.planWait || null;
  } else {
    failure = (res && res.error) || 'failed';
    await refetch();
    // Back to the form (the draft is kept), the error above it.
    picking = true;
  }
  if (isOpen) render();
}

/**
 * "Approve plan" (F4a): main merges the plan branch into the base and turns
 * the unchecked tasks into to-dos. A refusal says why (with what was in the way).
 */
async function approvePlan() {
  if (!plan) return;
  const planId = plan.id;
  const res = await act(() => window.lunacore.orchestraPlanRun('approve', { planId, projectId: board.project() }));
  failureDetail = res && res.ok === false && typeof res.detail === 'string' ? res.detail.slice(0, 300) : null;
  // The panel shows the outcome from the run's view (planRun.approved).
  if (res && res.ok) await refetch();
  if (isOpen) render();
}

/** A written plan doc: main opens its copy next to the run report. */
function openPlanDoc(id) {
  if (!plan) return;
  act(() => window.lunacore.orchestraPlanRun('openDoc', { planId: plan.id, id, projectId: board.project() }));
}

/** @param {string[]|null} ids null = Approve (all ready packages) */
async function launch(ids) {
  if (!plan || phase !== 'idle') return;
  const prompts = {};
  for (const pkg of plan.packages) {
    const draft = drafts.get(draftKey(pkg.id));
    if (typeof draft === 'string' && draft !== pkg.prompt) prompts[pkg.id] = draft;
  }
  // Approve (not a single-package Launch) carries the start options.
  const approve = ids === null && !plan.started;
  const schedule =
    approve && startOpts.when === 'time'
      ? { kind: 'time', at: startOpts.time }
      : approve && startOpts.when === 'reset'
        ? { kind: 'reset' }
        : null;
  // F6 "Workers"; `free` stays for an older main that only knows the tick.
  const workers = approve ? chosenWorkers() : null;
  const free = workers === 'free';
  const integration = approve && !free ? chosenIntegration() : null;
  const releaseAfter = integration === 'merge' && releaseAfterChoice(plan.projectId);
  // The Approve screen's "Workers model"; a Free-only run has none.
  const workerModel = approve && !free && takesWorkerModel(plan) ? chosenWorkerModel(plan) : null;
  const scope = board.project();
  phase = 'launching';
  busyPkg = Array.isArray(ids) && ids.length === 1 ? ids[0] : null;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.launchOrchestra({
      planId: plan.id, ids, prompts, schedule, integration, free, ...(workers ? { workers } : {}), ...(workerModel ? { workerModel } : {}), releaseAfter, projectId: scope,
    });
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  busyPkg = null;
  if (res && res.ok) {
    board.apply(res.plan, scope);
    plan = board.view();
  } else failure = (res && res.error) || 'failed';
  if (isOpen) render();
}

/**
 * Runs one main-side action with the board locked; main pushes the new view.
 * opts.local: a refusal is shown by the caller (beside its row), not above the board.
 */
async function act(call, opts = {}) {
  if (phase !== 'idle') return null;
  phase = 'launching';
  failure = null;
  render();
  let res;
  try {
    res = await call();
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok === false && !opts.local) failure = res.error || 'failed';
  if (isOpen) render();
  return res;
}

async function discard() {
  const scope = board.project();
  const res = await act(() => window.lunacore.discardOrchestra(scope));
  if (!res || !res.ok) return;
  const planId = plan ? plan.id : null;
  board.apply(null, scope);
  plan = board.view();
  for (const key of [...drafts.keys()]) if (key.startsWith(`${planId}:`)) drafts.delete(key);
  render();
}

async function retry(id) {
  if (!plan || phase !== 'idle') return;
  busyPkg = id;
  retryRefusals.delete(id);
  try {
    const res = await act(() => window.lunacore.retryOrchestra(plan.id, id, board.project()), { local: true });
    if (res && res.ok === false) {
      const whileFinishing = !!(plan && plan.integration && plan.integration.running === true);
      retryRefusals.set(id, { code: res.error || 'failed', whileFinishing });
    }
  } finally {
    busyPkg = null;
    if (isOpen) render();
  }
}

function finishRun() {
  if (plan) act(() => window.lunacore.finishOrchestra(plan.id, chosenIntegration(), board.project()));
}

/** "Abort finish": main ends the hung finish; the board frees once it reports. */
async function abortFinish() {
  if (!plan) return;
  const res = await act(() => window.lunacore.abortOrchestraFinalize(plan.id, board.project()));
  if (res && res.ok) {
    for (const [id, r] of retryRefusals) if (r.code === 'busy') retryRefusals.delete(id);
    if (isOpen) render();
  }
}

/** Outside act(): it must work while a launch holds the board busy. */
async function kill() {
  try {
    await window.lunacore.killOrchestra(board.project());
  } catch {
    failure = 'failed';
  }
  if (isOpen) render();
}

/**
 * Opens the board on the active tab's project (or, for a countdown, on the
 * run that started it).
 * @param {string|null} [projectId]
 */
export async function openOrchestra(projectId) {
  if (!overlay) return;
  const fromTab = !isOpen;
  if (!isOpen) {
    isOpen = true;
    cancelExit(overlay);
    overlay.hidden = false;
    // Focus, so Escape reaches the overlay instead of the terminal.
    overlay.focus();
  }
  if (phase === 'idle') {
    const target = typeof projectId === 'string' || projectId === null ? { project: projectId } : { reset: fromTab };
    // Settings may have changed the worker model since the board was last open.
    await Promise.all([refetch(target), loadWorkerModel()]);
    try {
      planWait = await window.lunacore.getOrchestraPlanWait(board.activeProject());
    } catch {
      planWait = null;
    }
  }
  render();
  checkWakeOnce();
  if (!plan && !planWait && phase === 'idle' && !picking && board.onActiveProject()) openPicker();
}

function closeOrchestra() {
  if (!isOpen) return;
  isOpen = false;
  failure = null;
  picking = false;
  if (abortRevealTimer) clearTimeout(abortRevealTimer);
  abortRevealTimer = null;
  closeWithExit(overlay);
  term.focus();
}

if (overlay) {
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOrchestra();
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-orchestra-close')) closeOrchestra();
  });
  if (approveBtn) approveBtn.addEventListener('click', () => launch(null));
  if (replanBtn) replanBtn.addEventListener('click', openPicker);
  if (discardBtn) discardBtn.addEventListener('click', discard);
  if (killBtn) killBtn.addEventListener('click', kill);

  window.lunacore.onOrchestraChanged((next, projectId) => {
    board.apply(next, projectId);
    plan = board.view();
    // A run that starts (a scheduled start firing) takes the board back from the picker.
    if (next && next.started && plan === next) picking = false;
    const key = countdownKey(next);
    if (key && key !== shownCountdown) {
      shownCountdown = key;
      if (!isOpen) {
        openOrchestra(projectId === undefined ? null : projectId);
        return;
      }
    }
    if (isOpen) render();
  });
  window.lunacore.onOrchestraPlanWait(async (state, projectId) => {
    // Only the active tab plans; another project's wait is not this board's.
    if ((projectId || null) !== (await board.refreshActive())) return;
    if (state && state.state === 'failed') {
      failure = state.error || 'failed';
      planWait = null;
    } else {
      planWait = state;
    }
    if (isOpen) render();
  });
  onLangChange(() => {
    if (isOpen) render();
  });
  // At start: a run a shutdown cut was restored before this page listened -
  // its banner (and Cancel) opens once on its own.
  if (window.lunacore.listOrchestra) {
    window.lunacore
      .listOrchestra()
      .then((runs) => {
        const cut = Array.isArray(runs) ? runs.find((r) => r && r.interrupted === true) : null;
        if (cut && !isOpen) openOrchestra(cut.projectId);
      })
      // Only the auto-open is lost: the countdown runs in main regardless.
      .catch((err) => console.warn('[orchestra] run list unavailable:', err && err.message));
  }
}

/**
 * Wires the to-do widget's "Plan packages" button. Called from todo.js's
 * mount; returns the cleanup for its unmount.
 * @param {HTMLElement} root
 * @returns {() => void}
 */
export function mountOrchestraButton(root) {
  const btn = root.querySelector('#orchestra-plan');
  if (!btn) return () => {};
  const open = () => openOrchestra();
  btn.addEventListener('click', open);
  return () => btn.removeEventListener('click', open);
}
