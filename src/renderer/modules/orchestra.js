// ============================================================================
// LunaCore - God Mode v2 plan review + run board (ORCHESTRATOR_PLAN.md 3 + 4)
// ----------------------------------------------------------------------------
// The DOM half of src/orchestra.js. "Plan packages" in the to-do widget opens
// #orchestra (static markup in index.html, .palette overlay CSS like #ask):
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
  'noTodos', 'busy', 'runActive', 'noClaude', 'timeout', 'budget', 'badJson', 'failed',
  'noTab', 'noPlan', 'planErrors', 'nothingToLaunch', 'notRetryable', 'briefFailed', 'paused',
  'badSchedule', 'noReset', 'badRule', 'mergeDeclined',
]);
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
// Integration errors with their own message (orchestraFinalize / Integrate).
const INTEG_ERRORS = new Set([
  'noBaseBranch', 'noGh', 'ghFailed', 'fetchFailed', 'worktreeFailed', 'installFailed', 'mergeFailed',
  'conflictFailed', 'verifyFailed', 'pushFailed', 'baseMoved',
]);
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
/** Edited prompts, `${planId}:${pkgId}` -> text, until launched. */
const drafts = new Map();
/** Start options picked on the board before Approve. */
const startOpts = { when: 'now', time: '01:00', integration: null };

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
  row.append(
    el('span', 'orchestra__optlabel', t('orch.integ')),
    selectEl(integrationOptions(), chosenIntegration(), (v) => {
      startOpts.integration = v;
    }),
  );
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

  if (pkg.error) {
    const text = pkg.detail ? `${pkgErrorText(pkg.error)}: ${pkg.detail}` : pkgErrorText(pkg.error);
    card.append(msg(text, 'is-bad'));
  }

  const progress = progressText(pkg);
  if (progress) card.append(el('div', 'orchestra__meta', progress));
  if (pkg.escalated) card.append(el('div', 'orchestra__meta', t('orch.progress.escalated')));
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
  const button = (label, onClick, disabled = phase !== 'idle') => {
    const btn = el('button', 'pad-send', label);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    actions.append(btn);
  };
  if (canLaunch(pkg)) button(t('orch.launch'), () => launch([pkg.id]), phase !== 'idle' || plan.errors.length > 0);
  if (RETRYABLE.has(pkg.state)) button(t('orch.retry'), () => retry(pkg.id));
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

function renderPlan() {
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
  if (plan.dirty > 0) body.append(msg(t('orch.dirty', { n: plan.dirty }), 'is-warn'));
  for (const e of plan.errors) body.append(msg(errorText(e), 'is-bad'));
  for (const w of plan.warnings) body.append(msg(warningText(w), 'is-warn'));
  if (plan.notes) body.append(el('p', 'orchestra__notes', plan.notes));
  for (const pkg of plan.packages) body.append(pkgCard(pkg));
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
    approveBtn.hidden = !plan;
    approveBtn.disabled =
      !idle || !plan || plan.errors.length > 0 || !hasReady() || (plan.started && !plan.killed && running) || !!plan.scheduledAt;
    const scheduling = !!plan && !plan.started && startOpts.when !== 'now';
    approveBtn.textContent = t(scheduling ? 'orch.schedule' : 'orch.approve');
  }
  if (replanBtn) replanBtn.disabled = !idle || running;
  if (discardBtn) {
    discardBtn.hidden = !plan;
    discardBtn.disabled = !idle || running;
  }
  // Kill is never locked by `phase`: an Approve/Retry holds the board busy
  // for the whole launch, which is exactly when stopping must still work.
  if (killBtn) killBtn.hidden = !(running || (plan && plan.started && !plan.killed && phase === 'launching'));
}

function render() {
  if (!body) return;
  body.replaceChildren();
  if (phase === 'planning') body.append(msg(t('orch.planning')));
  if (failure) body.append(msg(failText(failure), 'is-bad'));
  if (plan) renderPlan();
  updateButtons();
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

async function startPlanning() {
  if (phase !== 'idle') return;
  phase = 'planning';
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.planOrchestra(getActiveSessionId());
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok) {
    plan = res.plan;
    drafts.clear();
    startOpts.when = 'now';
    startOpts.integration = null;
  } else {
    failure = (res && res.error) || 'failed';
    await refetch(); // a refused re-plan keeps the old plan on screen
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
  const integration = approve ? chosenIntegration() : null;
  phase = 'launching';
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.launchOrchestra({ planId: plan.id, ids, prompts, schedule, integration });
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
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

function retry(id) {
  if (plan) act(() => window.lunacore.retryOrchestra(plan.id, id));
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
  if (phase === 'idle') await refetch();
  render();
  if (!plan && phase === 'idle' && !failure) startPlanning();
}

function closeOrchestra() {
  if (!isOpen) return;
  isOpen = false;
  failure = null;
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
  if (replanBtn) replanBtn.addEventListener('click', startPlanning);
  if (discardBtn) discardBtn.addEventListener('click', discard);
  if (killBtn) killBtn.addEventListener('click', kill);

  window.lunacore.onOrchestraChanged((next) => {
    plan = next;
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
