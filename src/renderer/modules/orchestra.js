// ============================================================================
// LunaCore - God Mode v2 plan review + board (ORCHESTRATOR_PLAN.md slice 3)
// ----------------------------------------------------------------------------
// The DOM half of src/orchestra.js. "Plan packages" in the to-do widget opens
// #orchestra (static markup in index.html, .palette overlay CSS like #ask):
// while the headless planner runs it says so, then it shows the plan - a
// summary with the estimate (idea #3), warnings, the planner's notes and one
// card per package with an editable prompt.
//
// Approve launches every package without dependencies; the rest keep a
// Launch button (waiting for a dependency to FINISH is slice 4's supervisor).
// The plan itself lives in main; this module only renders the view main
// pushes on orchestra:changed and sends back ids + edited prompt text.
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

// Error codes main can return that have their own message; anything else
// reads as the generic one.
const FAIL_CODES = new Set([
  'noTodos', 'busy', 'runActive', 'noClaude', 'timeout', 'budget', 'badJson', 'failed',
  'noTab', 'noPlan', 'planErrors', 'nothingToLaunch',
]);
// Per-package launch errors that come straight from src/worktrees.js.
const WORKTREE_ERRORS = new Set(['badName', 'notRepo', 'noCommits', 'exists', 'gitFailed']);

let isOpen = false;
/** Latest plan view from main, or null. */
let plan = null;
/** 'idle' | 'planning' | 'launching' */
let phase = 'idle';
/** Error code of the last plan/launch attempt, shown above the board. */
let failure = null;
/** Edited prompts, `${planId}:${pkgId}` -> text, until launched. */
const drafts = new Map();

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

  if (pkg.error) card.append(msg(pkgErrorText(pkg.error), 'is-bad'));

  const actions = el('div', 'orchestra__actions');
  if (canLaunch(pkg)) {
    const btn = el('button', 'pad-send', t('orch.launch'));
    btn.type = 'button';
    btn.disabled = phase !== 'idle' || plan.errors.length > 0;
    btn.addEventListener('click', () => launch([pkg.id]));
    actions.append(btn);
  } else if (pkg.state === 'launched' && pkg.sessionId) {
    const btn = el('button', 'pad-send', t('orch.goto'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      window.lunacore.activateSession(pkg.sessionId);
      closeOrchestra();
    });
    actions.append(btn);
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
  if (plan.dirty > 0) body.append(msg(t('orch.dirty', { n: plan.dirty }), 'is-warn'));
  for (const e of plan.errors) body.append(msg(errorText(e), 'is-bad'));
  for (const w of plan.warnings) body.append(msg(warningText(w), 'is-warn'));
  if (plan.notes) body.append(el('p', 'orchestra__notes', plan.notes));
  for (const pkg of plan.packages) body.append(pkgCard(pkg));
}

function updateButtons() {
  const idle = phase === 'idle';
  const launched = !!plan && plan.packages.some((p) => p.state === 'launched');
  const roots = !!plan && plan.packages.some((p) => canLaunch(p) && !p.dependsOn.length);
  if (approveBtn) {
    approveBtn.hidden = !plan;
    approveBtn.disabled = !idle || !plan || plan.errors.length > 0 || !roots;
  }
  if (replanBtn) replanBtn.disabled = !idle || launched;
  if (discardBtn) {
    discardBtn.hidden = !plan;
    discardBtn.disabled = !idle;
  }
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
  phase = 'launching';
  failure = null;
  render();
  let res;
  try {
    res = await window.lunacore.launchOrchestra({ planId: plan.id, ids, prompts });
  } catch {
    res = { ok: false, error: 'failed' };
  }
  phase = 'idle';
  if (res && res.ok) plan = res.plan;
  else failure = (res && res.error) || 'failed';
  if (isOpen) render();
}

async function discard() {
  if (phase !== 'idle') return;
  try {
    await window.lunacore.discardOrchestra();
  } catch {
    /* main keeps the plan; the next open shows it again */
  }
  plan = null;
  failure = null;
  drafts.clear();
  render();
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
