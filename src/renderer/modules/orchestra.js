// ============================================================================
// LunaCore - God Mode v2 plan review + run board (ORCHESTRATOR_PLAN.md 3 + 4)
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
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { term, getActiveSessionId } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';
import { failureBlock, runOptionsRow, powerBanner } from './orchestraDetails.js';
import { loadPicker, pickerView } from './orchestraPick.js';

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
  'badSchedule', 'noReset', 'badRule', 'mergeDeclined', 'noFreeProfile', 'badOptions', 'noneSelected',
]);
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
// Integration errors with their own message (orchestraFinalize / Integrate).
const INTEG_ERRORS = new Set([
  'noBaseBranch', 'noGh', 'missingCwd', 'ghFailed', 'fetchFailed', 'worktreeFailed', 'installFailed', 'mergeFailed',
  'conflictFailed', 'verifyFailed', 'pushFailed', 'baseMoved', 'nothingMergedFailed', 'beforePushFailed',
]);
// "Open report" errors main can return (orchestra:openReport).
const REPORT_ERRORS = new Set(['badId', 'noReport', 'openFailed']);
// Package phases that hold a worker slot (orchestraSupervisor's ACTIVE_STATES).
const ACTIVE = new Set(['launched', 'finishing']);
const RETRYABLE = new Set(['stalled', 'closed', 'killed']);
const isActive = (pkg) => ACTIVE.has(pkg.state);
// Per-package launch errors that come straight from src/worktrees.js.
const WORKTREE_ERRORS = new Set(['badName', 'notRepo', 'noCommits', 'exists', 'gitFailed']);

let isOpen = false;
/** Latest plan view from main, or null. */
let plan = null;
/** 'idle' | 'planning' | 'launching' (also covers retry / kill / discard) */
let phase = 'idle';
/** Error code of the last plan/launch attempt, shown above the board. */
let failure = null;
/**
 * Planning parked on a spent Claude limit (main's orchestraPlanWait.js):
 * {state:'waiting'|'planning', resumeAt, window} or null.
 */
let planWait = null;
/** The package whose single Launch / Retry is in flight, or null. */
let busyPkg = null;
/** A run-options change on its way to main. */
let optionsBusy = false;
/** The to-do picker is on screen instead of the board (orchestraPick.js). */
let picking = false;
/** Edited prompts, `${planId}:${pkgId}` -> text, until launched. */
const drafts = new Map();
/** Start options picked on the board before Approve. */
const startOpts = { when: 'now', time: '01:00', integration: null, free: false };

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

function failText(code) {
  return t(`orch.fail.${FAIL_CODES.has(code) ? code : 'failed'}`);
}

function warningText(w) {
  if (w.code === 'uncovered') return t('orch.warn.uncovered', { list: w.texts.join('; ') });
  if (w.code === 'overlap') return t('orch.warn.overlap', { a: w.a, b: w.b, files: w.files.join(', ') });
  return t(`orch.warn.${w.code}`, { id: w.id, dep: w.dep });
}

function errorText(e) {
  return e.code === 'cycle' ? t('orch.err.cycle', { ids: e.ids.join(', ') }) : t(`orch.err.${e.code}`);
}

function pkgErrorText(code) {
  return WORKTREE_ERRORS.has(code) ? t(`tabs.worktree.err.${code}`) : t(`orch.pkgerr.${code}`);
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
  // Free providers: workers on the fallback-chain profile, luna-free/
  // branches only - so the integration select has nothing to choose.
  const free = el('label', 'orchestra__optlabel');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = startOpts.free;
  box.disabled = phase !== 'idle';
  box.addEventListener('change', () => {
    startOpts.free = box.checked;
    render();
  });
  free.append(box, document.createTextNode(` ${t('orch.free')}`));
  free.title = t('orch.free.hint');
  row.append(free);
  if (!startOpts.free) {
    row.append(
      el('span', 'orchestra__optlabel', t('orch.integ')),
      selectEl(integrationOptions(), chosenIntegration(), (v) => {
        startOpts.integration = v;
      }),
    );
  }
  return row;
}

function integrationText() {
  const integ = plan.integration || {};
  const mode = t(`orch.integ.${plan.integrationMode || 'pr'}`);
  if (integ.running || integ.state === 'running') return msg(t('orch.integ.running', { mode }));
  if (integ.state === 'done') return msg(t('orch.integ.done', { mode }));
  if (integ.state === 'failed') {
    const why = INTEG_ERRORS.has(integ.error) ? t(`orch.integerr.${integ.error}`) : integ.error || '';
    return msg(t('orch.integ.failed', { mode, why: integ.detail ? `${why}: ${integ.detail}` : why }), 'is-bad');
  }
  return null;
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
  btn.addEventListener('click', () => act(() => window.lunacore.allowOrchestraTool(s.rule)).then(refetchAndRender));
  row.append(btn);
  return row;
}

/** One line under the title: what the supervisor is doing with this package. */
function progressText(pkg) {
  if (pkg.state === 'pushed' && pkg.merged) return t('orch.progress.merged');
  if (pkg.state === 'pushed' && pkg.headSha) return t('orch.progress.pushed', { sha: pkg.headSha.slice(0, 7) });
  if (pkg.state === 'launched' && (pkg.nudges || pkg.verifyRounds)) {
    return t('orch.progress.running', { nudges: pkg.nudges, verify: pkg.verifyRounds });
  }
  if (pkg.state === 'launched' && pkg.startedAt) return t('orch.progress.since', { time: clock(pkg.startedAt) });
  return '';
}

/**
 * What the never-blocks ladder did or is doing with this package: automatic
 * relaunch / resume, gave up, or waiting on a dependency that gave up.
 */
function ladderLines(pkg) {
  const out = [];
  if (pkg.blockedBy) {
    const blocker = plan.packages.find((p) => p.id === pkg.blockedBy);
    const reason = blocker && blocker.error ? pkgErrorText(blocker.error) : t(`orch.state.${blocker ? blocker.state : 'pending'}`);
    out.push(t('orch.progress.blockedBy', { id: pkg.blockedBy, reason }));
  }
  if (pkg.autoRetries && !pkg.terminal && pkg.state === 'failed') {
    out.push(t('orch.progress.autoRetry', { n: pkg.autoRetries }));
  }
  if (pkg.autoResumed) out.push(t('orch.progress.autoResumed'));
  if (pkg.terminal) out.push(t('orch.progress.terminal'));
  return out;
}

const canLaunch = (pkg) => pkg.state === 'pending' || pkg.state === 'failed';

function pkgCard(pkg) {
  const card = el('section', `orchestra__pkg is-${pkg.state}`);

  const head = el('div', 'orchestra__head');
  head.append(
    el('span', 'orchestra__title', pkg.title),
    el('span', 'orchestra__id', pkg.id),
    el('span', `orchestra__state is-${pkg.state}`, t(`orch.state.${pkg.state}`)),
  );
  card.append(head);

  const meta = [];
  if (pkg.dependsOn.length) meta.push(t('orch.after', { ids: pkg.dependsOn.join(', ') }));
  if (pkg.files.length) meta.push(t('orch.files', { n: pkg.files.length }));
  if (pkg.verify) meta.push(t('orch.verify', { cmd: pkg.verify }));
  if (pkg.model) meta.push(pkg.model);
  if (pkg.branch) meta.push(pkg.branch);
  if (meta.length) {
    const line = el('div', 'orchestra__meta', meta.join(' · '));
    if (pkg.files.length) line.title = pkg.files.join('\n');
    card.append(line);
  }

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
  }

  const progress = progressText(pkg);
  if (progress) card.append(el('div', 'orchestra__meta', progress));
  if (pkg.escalated) card.append(el('div', 'orchestra__meta', t('orch.progress.escalated')));
  for (const line of ladderLines(pkg)) card.append(el('div', 'orchestra__meta', line));
  if (pkg.prUrl) {
    const link = el('a', 'orchestra__link', pkg.prUrl);
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.lunacore.openOrchestraPr(pkg.id);
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
  if (RETRYABLE.has(pkg.state)) button(t('orch.retry'), () => retry(pkg.id), phase !== 'idle', true);
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
    res = await window.lunacore.orchestraSetOptions({ [key]: value });
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
    await window.lunacore.cancelOrchestraPower(what);
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
  window.lunacore.checkOrchestraWake().catch(() => {});
}

// A countdown that started opens the board once, so its Cancel is in reach.
let shownCountdown = null;
function countdownKey(next) {
  const power = next && next.power;
  if (!power) return null;
  const s = power.shutdown && power.shutdown.phase === 'countdown' ? `shutdown:${power.shutdown.at}` : null;
  return s || (power.sleep && power.sleep.phase === 'countdown' ? `sleep:${power.sleep.at}` : null);
}

function renderPlan() {
  const banner = powerBanner(plan, { onCancel: cancelPower });
  if (banner) body.append(banner);
  // Always on top and usable during the run: the switches are live.
  body.append(runOptionsRow(plan, { disabled: optionsBusy, onToggle: setRunOption }));
  const est = plan.estimate;
  let line = t('orch.summary', {
    n: plan.packages.length,
    wall: fmtMinutes(est.wallMinutes),
    workers: est.workers,
    work: fmtMinutes(est.workMinutes),
  });
  if (Number.isFinite(plan.costUsd)) line += ` · ${t('orch.cost', { usd: plan.costUsd.toFixed(2) })}`;
  body.append(el('div', 'orchestra__summary', line));
  body.append(el('div', 'orchestra__meta', t('orch.workers', { model: plan.workerModel, perm: plan.permissionMode })));
  const running = plan.packages.some(isActive);
  if (!plan.started && !plan.scheduledAt && !plan.errors.length) body.append(startOptions());
  if (plan.scheduledAt) body.append(scheduledRow());
  if (plan.started && !running && plan.packages.some((p) => p.state !== 'pending')) body.append(finishRow());
  const integ = integrationText();
  if (integ) body.append(integ);
  // The run email (src/godmodemail.js) failed: the run itself is fine.
  if (plan.integration && plan.integration.emailError) {
    const reason = plan.integration.emailError;
    body.append(msg(reason === 'gmail-not-connected' ? t('orch.emailNotConnected') : t('orch.emailFailed', { reason }), 'is-warn'));
  }
  for (const o of plan.overlaps || []) {
    body.append(msg(t('orch.overlap', { a: o.a, b: o.b, files: o.files.join(', ') }), 'is-warn'));
  }
  for (const s of plan.suggestions || []) body.append(suggestionRow(s));
  if (plan.pausedUntil) body.append(msg(t('orch.paused', { time: clock(plan.pausedUntil) }), 'is-warn'));
  if (plan.killed) body.append(msg(t('orch.killed'), 'is-bad'));
  if (plan.settled) {
    const pushed = (plan.tally && plan.tally.pushed) || 0;
    const total = plan.packages.length;
    body.append(msg(t('orch.settled', { pushed, total }), pushed === total ? '' : 'is-warn'));
  }
  if (hasReport()) body.append(reportRow());
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

/** "Open report": only the plan id goes to main, which builds the path. */
function reportRow() {
  const row = el('div', 'orchestra__options');
  const btn = el('button', 'pad-send', t('orch.openReport'));
  btn.type = 'button';
  btn.title = t('orch.openReport.hint');
  const status = el('span', 'orchestra__msg is-bad');
  status.hidden = true;
  btn.addEventListener('click', async () => {
    let res;
    try {
      res = await window.lunacore.openOrchestraReport(plan.id);
    } catch {
      res = { ok: false, error: 'openFailed' };
    }
    const failed = !res || !res.ok;
    status.hidden = !failed;
    if (failed) {
      const code = res && REPORT_ERRORS.has(res.error) ? res.error : 'openFailed';
      status.textContent = t(`orch.openReport.${code}`);
    }
  });
  row.append(btn, status);
  return row;
}

function scheduledRow() {
  const row = el('div', 'orchestra__options');
  row.append(el('span', 'orchestra__msg', t('orch.scheduled', { time: clock(plan.scheduledAt) })));
  const btn = el('button', 'pad-send', t('orch.unschedule'));
  btn.type = 'button';
  btn.disabled = phase !== 'idle';
  btn.addEventListener('click', () => act(() => window.lunacore.unscheduleOrchestra(plan.id)));
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
    replanBtn.hidden = picking;
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
  if (!planWait) return;
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
    await window.lunacore.cancelOrchestraPlanWait();
  } catch {
    /* the wait state event below repaints either way */
  }
  planWait = null;
  if (isOpen) render();
}

function render() {
  if (!body) return;
  body.replaceChildren();
  if (phase === 'planning') body.append(msg(t('orch.planning')));
  renderPlanWait();
  if (failure) body.append(msg(failText(failure), 'is-bad'));
  if (picking && phase === 'idle') {
    body.append(
      pickerView({
        disabled: phase !== 'idle',
        canCancel: !!plan,
        onPlan: (ats) => startPlanning(ats),
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

async function refetch() {
  try {
    plan = await window.lunacore.getOrchestra();
  } catch {
    plan = null;
  }
}

async function refetchAndRender() {
  await refetch();
  if (isOpen) render();
}

/** @param {number[]} ats the picker's ticked to-dos */
async function startPlanning(ats) {
  if (phase !== 'idle') return;
  phase = 'planning';
  picking = false;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.planOrchestra(getActiveSessionId(), ats);
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok) {
    plan = res.plan;
    planWait = null;
    drafts.clear();
    startOpts.when = 'now';
    startOpts.integration = null;
    startOpts.free = false;
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
  const free = approve && startOpts.free;
  const integration = approve && !free ? chosenIntegration() : null;
  phase = 'launching';
  busyPkg = Array.isArray(ids) && ids.length === 1 ? ids[0] : null;
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.launchOrchestra({ planId: plan.id, ids, prompts, schedule, integration, free });
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  busyPkg = null;
  if (res && res.ok) plan = res.plan;
  else failure = (res && res.error) || 'failed';
  if (isOpen) render();
}

/** Runs one main-side action with the board locked; main pushes the new view. */
async function act(call) {
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
  if (res && res.ok === false) failure = res.error || 'failed';
  if (isOpen) render();
  return res;
}

async function discard() {
  const res = await act(() => window.lunacore.discardOrchestra());
  if (!res || !res.ok) return;
  plan = null;
  drafts.clear();
  render();
}

async function retry(id) {
  if (!plan || phase !== 'idle') return;
  busyPkg = id;
  try {
    await act(() => window.lunacore.retryOrchestra(plan.id, id));
  } finally {
    busyPkg = null;
    if (isOpen) render();
  }
}

function finishRun() {
  if (plan) act(() => window.lunacore.finishOrchestra(plan.id, chosenIntegration()));
}

/** Outside act(): it must work while a launch holds the board busy. */
async function kill() {
  try {
    await window.lunacore.killOrchestra();
  } catch {
    failure = 'failed';
  }
  if (isOpen) render();
}

async function openOrchestra() {
  if (!overlay) return;
  if (!isOpen) {
    isOpen = true;
    cancelExit(overlay);
    overlay.hidden = false;
    // Focus, so Escape reaches the overlay instead of the terminal.
    overlay.focus();
  }
  if (phase === 'idle') {
    await refetch();
    try {
      planWait = await window.lunacore.getOrchestraPlanWait();
    } catch {
      planWait = null;
    }
  }
  render();
  checkWakeOnce();
  if (!plan && !planWait && phase === 'idle' && !picking) openPicker();
}

function closeOrchestra() {
  if (!isOpen) return;
  isOpen = false;
  failure = null;
  picking = false;
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

  window.lunacore.onOrchestraChanged((next) => {
    plan = next;
    // A run that starts (a scheduled start firing) takes the board back from the picker.
    if (next && next.started) picking = false;
    const key = countdownKey(next);
    if (key && key !== shownCountdown) {
      shownCountdown = key;
      if (!isOpen) {
        openOrchestra();
        return;
      }
    }
    if (isOpen) render();
  });
  window.lunacore.onOrchestraPlanWait((state) => {
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
  btn.addEventListener('click', openOrchestra);
  return () => btn.removeEventListener('click', openOrchestra);
}
