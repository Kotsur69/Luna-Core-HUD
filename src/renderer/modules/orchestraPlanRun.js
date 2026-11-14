// ============================================================================
// LunaCore - God Mode board: Free God Mode v2 "Plan only" (slice F1f)
// ----------------------------------------------------------------------------
// The DOM half of a plan run (main: src/orchestraPlanRunStart.js / -View.js):
//
//   runTypeSwitch   Build / Plan only, where a run starts (beside the to-do
//                   picker that starts a Build run)
//   planOnlyForm    ONE free-text box (no presets, Q1), "Planner: Claude /
//                   Free" and the note that free tiers may train on prompts
//   planRunPanel    after the start: topics (slug + question), the topics ->
//                   critique -> synthesis progress, plan-guard stall reasons
//                   (outsidePlanFolder, noSources), flagged PLAN.md tasks,
//                   and when done a link to each .md + "Plan ready to review"
//
// Only text and two choice names go to main; main validates everything.
// ============================================================================

'use strict';

import { t } from './util.js';

/** Same cap main enforces (orchestraPlanRunStart.MAX_REQUEST_CHARS). */
export const MAX_REQUEST_CHARS = 20000;
export const PLANNERS = Object.freeze(['claude', 'free']);
const MIN_REQUEST_CHARS = 3;
const PHASE_STATES = new Set(['pending', 'running', 'done', 'stalled']);

/** The form's draft survives a re-render (the board repaints often). */
const form = { request: '', planner: 'claude' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, disabled) {
  const btn = el('button', 'pad-send', label);
  btn.type = 'button';
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Build / Plan only. Two pressed-state buttons (not colour-only: aria-pressed
 * and the label carry the state).
 * @param {{mode:'build'|'plan', disabled:boolean, onChange:(mode:string)=>void}} opts
 */
export function runTypeSwitch({ mode, disabled, onChange }) {
  const row = el('div', 'orchestra__options orchestra__runtype');
  row.title = t('orch.runType.hint');
  row.append(el('span', 'orchestra__optlabel', t('orch.runType')));
  const group = el('div', 'orchestra__seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('orch.runType'));
  for (const value of ['build', 'plan']) {
    const btn = button(t(`orch.runType.${value}`), () => onChange(value), disabled);
    btn.classList.add('orchestra__seg-btn');
    btn.setAttribute('aria-pressed', String(mode === value));
    group.append(btn);
  }
  row.append(group);
  return row;
}

/**
 * The Plan only start form.
 * @param {{disabled:boolean, onStart:(request:string, planner:string)=>void}} opts
 */
export function planOnlyForm({ disabled, onStart }) {
  const box = el('div', 'orchestra__planrun');
  const label = el('label', 'orchestra__optlabel', t('orch.planRun.request'));
  const area = el('textarea', 'orchestra__prompt orchestra__request');
  area.id = 'orchestra-plan-request';
  label.htmlFor = area.id;
  area.spellcheck = true;
  area.maxLength = MAX_REQUEST_CHARS;
  area.placeholder = t('orch.planRun.placeholder');
  area.value = form.request;
  area.disabled = !!disabled;
  const count = el('span', 'orchestra__meta', t('orch.planRun.count', { n: form.request.length, max: MAX_REQUEST_CHARS }));
  const tooShort = () => form.request.trim().length < MIN_REQUEST_CHARS;
  const start = button(t('orch.planRun.start'), () => onStart(form.request.trim(), form.planner), disabled || tooShort());
  area.addEventListener('input', () => {
    form.request = area.value;
    count.textContent = t('orch.planRun.count', { n: area.value.length, max: MAX_REQUEST_CHARS });
    start.disabled = !!disabled || tooShort();
  });

  const options = el('div', 'orchestra__options');
  options.append(el('span', 'orchestra__optlabel', t('orch.planRun.planner')));
  const select = el('select', 'profile-select');
  select.setAttribute('aria-label', t('orch.planRun.planner'));
  select.title = t('orch.planRun.planner.hint');
  for (const p of PLANNERS) {
    const opt = el('option', '', t(`orch.planRun.planner.${p}`));
    opt.value = p;
    select.append(opt);
  }
  select.value = form.planner;
  select.disabled = !!disabled;
  select.addEventListener('change', () => {
    form.planner = PLANNERS.includes(select.value) ? select.value : 'claude';
  });
  options.append(select, start);

  box.append(label, area, count, options, el('p', 'orchestra__msg is-warn', t('orch.planRun.training')));
  return box;
}

/** Clears the draft after a run started. */
export function resetPlanOnlyForm() {
  form.request = '';
}

const knownState = (state) => (PHASE_STATES.has(state) ? state : 'pending');

function phaseLine(label, state) {
  const item = el('li', `orchestra__phase is-${knownState(state)}`);
  item.append(el('span', 'orchestra__phase-name', label), el('span', 'orchestra__phase-state', t(`orch.planRun.state.${knownState(state)}`)));
  return item;
}

function topicList(topics) {
  const list = el('ul', 'orchestra__todos');
  for (const topic of topics) {
    const item = el('li', '');
    item.append(el('code', 'orchestra__id', topic.slug), document.createTextNode(` ${topic.question}`));
    list.append(item);
  }
  return list;
}

function flaggedList(flagged) {
  const list = el('ul', 'orchestra__todos');
  for (const f of flagged) {
    list.append(el('li', 'orchestra__msg is-warn', t('orch.planRun.flaggedTask', { n: f.index + 1, text: f.text })));
    if (f.reasons.length) list.append(el('li', 'orchestra__meta', f.reasons.join('; ')));
  }
  return list;
}

function docList(docs, onOpenDoc, disabled) {
  const list = el('ul', 'orchestra__todos');
  for (const d of docs) {
    const item = el('li', '');
    const link = el('a', 'orchestra__link', d.file);
    link.href = '#';
    link.title = d.branch ? `${d.path} (${d.branch})` : d.path;
    if (disabled) link.setAttribute('aria-disabled', 'true');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (!disabled) onOpenDoc(d.id);
    });
    item.append(link);
    list.append(item);
  }
  return list;
}

/**
 * "Approve plan" (F4a): merge PLAN.md's branch into the base and turn its
 * unchecked tasks into to-dos. Approving again is safe (no duplicates), so
 * the button stays, relabelled, after the first approve.
 * @param {{approved:{created:number, skipped:number}|null}} pr
 */
function approveRow(pr, onApprove, disabled) {
  const row = el('div', 'orchestra__options');
  const approved = pr.approved;
  const label = approved ? t('orch.planRun.approveAgain') : t('orch.planRun.approve');
  const btn = button(label, () => onApprove && onApprove(), disabled || !onApprove);
  btn.title = t('orch.planRun.approve.hint');
  row.append(btn);
  if (approved) {
    row.append(el('span', 'orchestra__meta', t('orch.planRun.approved', { created: approved.created, skipped: approved.skipped })));
  }
  return row;
}

/**
 * The plan run on the board.
 * @param {object} pr the view's planRun (orchestraPlanRunView.planRunView)
 * @param {{pkgErrorText:(code:string)=>string, onOpenDoc:(id:string)=>void, onApprove?:()=>void, disabled:boolean}} opts
 */
export function planRunPanel(pr, { pkgErrorText, onOpenDoc, onApprove, disabled }) {
  const box = el('section', 'orchestra__planrun');
  box.append(
    el('div', 'orchestra__summary', t('orch.planRun.title', { slug: pr.runSlug })),
    el('div', 'orchestra__meta', t('orch.planRun.folder', { folder: pr.folder })),
  );
  if (pr.request) box.append(el('p', 'orchestra__notes', pr.request));

  const phases = el('ol', 'orchestra__phases');
  const tp = pr.phases.topics;
  phases.append(
    phaseLine(t('orch.planRun.phase.topics', { done: tp.done, total: tp.total }), tp.state),
    phaseLine(t('orch.planRun.phase.critique'), pr.phases.critique.state),
    phaseLine(t('orch.planRun.phase.synthesis'), pr.phases.synthesis.state),
  );
  box.append(phases);

  if (pr.topics.length) box.append(el('div', 'orchestra__optlabel', t('orch.planRun.topics')), topicList(pr.topics));
  if (pr.stalls.length) {
    box.append(el('div', 'orchestra__optlabel', t('orch.planRun.stalls')));
    for (const s of pr.stalls) {
      box.append(el('p', 'orchestra__msg is-bad', `${s.id}: ${pkgErrorText(s.reason)}${s.detail ? ` - ${s.detail}` : ''}`));
    }
  }
  if (pr.flagged.length) box.append(el('div', 'orchestra__optlabel', t('orch.planRun.flagged')), flaggedList(pr.flagged));
  if (pr.docs.length) box.append(el('div', 'orchestra__optlabel', t('orch.planRun.docs')), docList(pr.docs, onOpenDoc, disabled));
  if (pr.ready) box.append(el('p', 'orchestra__msg orchestra__ready', t('orch.planRun.ready')));
  if (pr.ready) box.append(approveRow(pr, onApprove, disabled));
  return box;
}
