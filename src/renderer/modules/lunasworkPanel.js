// ============================================================================
// LunaCore - Luna's Work run panel (docs/LUNAS_WORK_PLAN.md, slice 1.7)
// ----------------------------------------------------------------------------
// The "Run" group of the Luna's Work Settings pane:
//   - Start: a start dialog with the effective model per role (LunaCore's
//     default, or the project's override), changeable for THIS run, with
//     "save as this project's default". Refusals (no profile, pack not
//     complete, God Mode on the project, ...) are shown with their reason.
//   - Stop: the kill switch - the running step finishes, then the run ends.
//   - Steer: quick-adds a `steer` card to the project's to-do list.
//   - Live status from the lunaswork:event push (every phase transition,
//     wait, resume, stop): run id, iteration, phase + role, models, verdict,
//     time in phase, WAIT with its resume time, pending decisions when main
//     reports them (count, and the list: kind, question, options with the
//     default, deadline - answered from the phone), recent scores per
//     milestone and the evidence folder.
//
// Everything goes through window.lunacore.lunaswork* (src/lunasworkipc.js);
// main validates every payload and the status it pushes. Every value from
// main is painted through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { sfx } from './sound.js';
import { onLangChange } from './bus.js';
import { sparkPoints } from './spark.js';

const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const TICK_MS = 1000;
const FLASH_MS = 2000;
const SPARK_W = 80;
const SPARK_H = 16;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_MISSING_SHOWN = 6;

// ---- pure helpers (tested) -----------------------------------------------------

/** The models a run starts with before any change: project override over the default. */
export function effectiveModels(view) {
  const base = view && view.models ? view.models : {};
  const project = view && view.projectModels ? view.projectModels : {};
  return { ...base, ...project };
}

/** Where each role's effective model comes from: 'project' or 'global'. */
export function modelSources(view) {
  const project = view && view.projectModels ? view.projectModels : {};
  const roles = view && Array.isArray(view.roles) ? view.roles : [];
  return Object.fromEntries(roles.map((r) => [r, r in project ? 'project' : 'global']));
}

/** Only the roles the dialog changed: the run override (null when none). */
export function runOverride(chosen, effective) {
  const out = {};
  for (const [role, model] of Object.entries(chosen || {})) {
    if (effective[role] !== model) out[role] = model;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Why a start cannot go, known before asking main (the controller checks
 * again): no profile, or a design pack that is not complete.
 * @returns {{reason:string, missing?:string[]}|null}
 */
export function startBlocker(view, pack) {
  if (view && view.ok && !view.profile) return { reason: 'no-profile' };
  if (pack && pack.ok && pack.pack && !pack.pack.complete) {
    return { reason: 'pack-incomplete', missing: [...(pack.pack.missing || []), ...(pack.pack.empty || [])] };
  }
  return null;
}

/** "m:ss" or "h:mm:ss" for a duration in ms. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// ---- DOM ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const modelLabel = (m) => (m === 'auto' ? t('lw.model.auto') : MODEL_LABELS[m] || m);

/** Localized text for a refused call. */
function reasonText(res) {
  const reason = res && typeof res.reason === 'string' ? res.reason : 'failed';
  const text = t(`lw.err.${reason}`);
  return text === `lw.err.${reason}` ? t('lw.err.failed') : text;
}

function setMsg(node, text, tone) {
  node.textContent = text || '';
  node.hidden = !text;
  node.classList.toggle('is-bad', tone === 'bad');
}

/** One label/value row of the status list. */
function row(label, value, cls) {
  const wrap = el('div', 'lw-run__row');
  wrap.append(el('dt', '', label), el('dd', cls || '', value));
  return wrap;
}

function sparkline(scores) {
  const points = sparkPoints(scores.map((s) => s.score), SPARK_W, SPARK_H);
  if (!points) return el('span', 'lw-run__spark');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'lw-run__spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  svg.append(line);
  return svg;
}

/** Recent scores per milestone: name, sparkline, last scores. */
function scoresTable(scores) {
  const entries = Object.entries(scores || {});
  if (!entries.length) return null;
  const table = el('table', 'lw-run__scores');
  const head = el('tr');
  for (const key of ['lw.run.milestone', 'lw.run.trend', 'lw.run.recent']) head.append(el('th', '', t(key)));
  table.append(head);
  for (const [milestone, list] of entries) {
    const tr = el('tr');
    const recent = list.slice(-5).map((s) => (Number.isInteger(s.n) ? `#${s.n}: ${s.score}` : String(s.score)));
    const sparkCell = el('td');
    sparkCell.append(sparkline(list));
    tr.append(el('td', '', milestone || t('lw.run.noMilestone')), sparkCell, el('td', '', recent.join(', ')));
    table.append(tr);
  }
  return table;
}

/** A known option ('approve', 'yes', ...) in the UI language; anything else as sent. */
function optionLabel(option) {
  const key = `lw.decision.option.${option}`;
  const text = t(key);
  return text === key ? option : text;
}

/**
 * One pending decision as text lines (tested): kind, question, the options
 * with the default marked, and when the default is taken (or that it never is).
 * @param {{kind:string, question:string, detail?:string|null, options:string[],
 *   defaultAnswer:string|null, deadline:number|null}} d
 * @param {(ms:number)=>string} [timeOf]
 * @returns {{kind:string, question:string, detail:string, options:string, deadline:string}}
 */
export function decisionText(d, timeOf = clock) {
  const kindKey = `lw.decision.kind.${d.kind}`;
  const kind = t(kindKey);
  return {
    kind: kind === kindKey ? t('lw.decision.kind.other') : kind,
    question: d.question,
    detail: d.detail || '',
    options: d.options.map((o) => (o === d.defaultAnswer ? `${optionLabel(o)} (${t('lw.decision.default')})` : optionLabel(o))).join(' · '),
    deadline: d.deadline ? t('lw.decision.deadline', { time: timeOf(d.deadline) }) : t('lw.decision.noDeadline'),
  };
}

/** The pending decisions list (answered from the phone), or null when there are none. */
function decisionList(decisions) {
  if (!Array.isArray(decisions) || !decisions.length) return null;
  const list = el('ul', 'lw-run__decisions');
  list.setAttribute('aria-label', t('lw.run.pending'));
  for (const d of decisions) {
    const text = decisionText(d);
    const item = el('li', 'lw-run__decision');
    item.append(el('span', 'lw-run__decision-kind', text.kind), el('span', 'lw-run__decision-q', text.question));
    if (text.detail) item.append(el('span', 'termcustom__hint', text.detail));
    item.append(el('span', 'termcustom__hint', text.options), el('span', 'termcustom__hint', text.deadline));
    list.append(item);
  }
  return list;
}

/**
 * @param {HTMLElement} root the Settings overlay
 * @param {{projectId:()=>string|null, projectLabel:(id:string)=>string}} opts
 * @returns {{projectChanged:()=>void, dispose:()=>void}}
 */
export function mountLunasWorkPanel(root, { projectId, projectLabel }) {
  const el$ = (id) => root.querySelector(`#${id}`);
  const ui = {
    summary: el$('lw-run-summary'),
    details: el$('lw-run-details'),
    scores: el$('lw-run-scores'),
    error: el$('lw-run-error'),
    start: el$('lw-run-start'),
    stop: el$('lw-run-stop'),
    evidence: el$('lw-run-evidence'),
    dialog: el$('lw-start-panel'),
    dialogModels: el$('lw-start-models'),
    dialogBlock: el$('lw-start-block'),
    save: el$('lw-start-save'),
    go: el$('lw-start-go'),
    cancel: el$('lw-start-cancel'),
    steerForm: el$('lw-steer-form'),
    steerText: el$('lw-steer-text'),
    steerMsg: el$('lw-steer-msg'),
  };
  if (Object.values(ui).some((v) => !v)) return { projectChanged: () => {}, dispose: () => {} };

  let status = { active: false, runId: null };
  let dialogView = null;
  let dialogBlocker = null;
  let ticker = null;
  let steerTimer = null;

  // ---- live status ----

  function phaseLine(s) {
    if (s.waitUntil) return t('lw.run.waiting', { time: clock(s.waitUntil) });
    const phase = s.phase ? t(`lw.phase.${s.phase}`) : '-';
    return s.role ? `${phase} · ${t(`lw.role.${s.role}`)}` : phase;
  }

  function paintTimer() {
    const node = ui.details.querySelector('[data-lw-timer]');
    if (node && status.phaseStartedAt) node.textContent = elapsed(Date.now() - status.phaseStartedAt);
  }

  function paint() {
    const s = status;
    const has = !!s.runId;
    ui.start.disabled = s.active;
    ui.stop.disabled = !s.active || s.stopRequested;
    ui.evidence.hidden = !(has && s.hasEvidence);

    if (!has) ui.summary.textContent = t('lw.run.none');
    else if (s.active) ui.summary.textContent = t(s.stopRequested ? 'lw.run.stopping' : 'lw.run.active');
    else ui.summary.textContent = t('lw.run.ended', { verdict: s.verdict ? t(`lw.verdict.${s.verdict}`) : '-' });

    ui.details.replaceChildren();
    ui.scores.replaceChildren();
    clearInterval(ticker);
    ticker = null;
    if (!has) return;

    ui.details.append(
      row(t('lw.run.id'), s.runId),
      row(t('lw.project'), s.projectId ? projectLabel(s.projectId) : '-'),
      row(t('lw.run.iteration'), String(s.iteration)),
      row(t('lw.run.phase'), phaseLine(s), s.waitUntil ? 'is-warn' : ''),
    );
    if (s.active && !s.waitUntil && s.phaseStartedAt) {
      const timer = row(t('lw.run.inPhase'), elapsed(Date.now() - s.phaseStartedAt));
      timer.querySelector('dd').dataset.lwTimer = '1';
      ui.details.append(timer);
      ticker = setInterval(() => (ui.details.isConnected ? paintTimer() : clearInterval(ticker)), TICK_MS);
    }
    if (s.freeUntil) ui.details.append(row(t('lw.run.free'), t('lw.run.freeUntil', { time: clock(s.freeUntil) }), 'is-warn'));
    const models = Object.entries(s.models || {}).map(([role, m]) => `${t(`lw.role.${role}`)}: ${modelLabel(m)}`);
    if (models.length) ui.details.append(row(t('lw.run.models'), models.join(' · ')));
    ui.details.append(row(t('lw.run.verdict'), s.verdict ? t(`lw.verdict.${s.verdict}`) : t('lw.run.noVerdict')));
    if (Number.isInteger(s.pendingDecisions)) {
      ui.details.append(row(t('lw.run.pending'), String(s.pendingDecisions), s.pendingDecisions ? 'is-warn' : ''));
    }
    const decisions = decisionList(s.decisions);
    if (decisions) ui.scores.append(decisions);
    const table = scoresTable(s.scores);
    if (table) ui.scores.append(table);
  }

  function apply(next) {
    if (next && typeof next === 'object') status = next;
    paint();
  }

  async function loadStatus() {
    const res = await window.lunacore.lunasworkStatus();
    if (res && res.ok) apply(res.status);
  }

  // ---- start dialog ----

  function closeDialog() {
    ui.dialog.hidden = true;
    dialogView = null;
    dialogBlocker = null;
  }

  function paintDialog(view, blocker) {
    const effective = effectiveModels(view);
    const sources = modelSources(view);
    ui.dialogModels.replaceChildren(...view.roles.map((role) => {
      const label = el('label', 'ui-field');
      const select = el('select', 'profile-select');
      select.dataset.lwRunRole = role;
      for (const choice of view.choices) {
        const opt = el('option', '', modelLabel(choice));
        opt.value = choice;
        select.append(opt);
      }
      select.value = effective[role];
      const name = el('span', 'ui-field__label', t(`lw.role.${role}`));
      label.append(name, select, el('span', 'termcustom__hint', t(`lw.source.${sources[role]}`)));
      return label;
    }));
    ui.save.checked = false;
    if (blocker) {
      const missing = (blocker.missing || []).slice(0, MAX_MISSING_SHOWN).join(', ');
      setMsg(ui.dialogBlock, `${t(`lw.err.${blocker.reason}`)}${missing ? ` (${missing})` : ''}`, 'bad');
    } else {
      setMsg(ui.dialogBlock, '');
    }
    ui.go.disabled = !!blocker;
  }

  async function openDialog() {
    const id = projectId();
    setMsg(ui.error, '');
    if (!id) return setMsg(ui.error, t('lw.err.bad-project'), 'bad');
    const [view, pack] = await Promise.all([
      window.lunacore.lunasworkGetSettings(id),
      window.lunacore.lunasworkPackStatus(id),
    ]);
    if (!view || !view.ok) return setMsg(ui.error, reasonText(view), 'bad');
    dialogView = view;
    dialogBlocker = startBlocker(view, pack);
    paintDialog(view, dialogBlocker);
    ui.dialog.hidden = false;
  }

  async function startRun() {
    const id = projectId();
    if (!id || !dialogView) return;
    const chosen = Object.fromEntries(
      Array.from(ui.dialogModels.querySelectorAll('[data-lw-run-role]')).map((s) => [s.dataset.lwRunRole, s.value]),
    );
    ui.go.disabled = true;
    try {
      let effective = effectiveModels(dialogView);
      if (ui.save.checked) {
        const saved = await window.lunacore.lunasworkSaveSettings(id, { projectModels: chosen });
        if (!saved || !saved.ok) return setMsg(ui.dialogBlock, reasonText(saved), 'bad');
        effective = effectiveModels(saved);
      }
      const override = runOverride(chosen, effective);
      sfx.terminalNew();
      const res = await window.lunacore.lunasworkStart(id, override || undefined);
      if (!res || !res.ok) {
        const missing = res && Array.isArray(res.missing) ? res.missing.slice(0, MAX_MISSING_SHOWN).join(', ') : '';
        return setMsg(ui.dialogBlock, `${reasonText(res)}${missing ? ` (${missing})` : ''}`, 'bad');
      }
      closeDialog();
      apply(res.status);
    } finally {
      ui.go.disabled = false;
    }
  }

  // ---- stop / steer / evidence ----

  async function stopRun() {
    sfx.modeToggle();
    ui.stop.disabled = true;
    const res = await window.lunacore.lunasworkStop();
    if (!res || !res.ok) {
      setMsg(ui.error, reasonText(res), 'bad');
      paint();
      return;
    }
    setMsg(ui.error, '');
    apply(res.status);
  }

  async function steer(e) {
    e.preventDefault();
    const id = projectId();
    const text = ui.steerText.value.trim();
    if (!id || !text) return;
    const res = await window.lunacore.lunasworkSteer(id, text);
    if (!res || !res.ok) return setMsg(ui.steerMsg, reasonText(res), 'bad');
    sfx.modeToggle();
    ui.steerText.value = '';
    setMsg(ui.steerMsg, t('lw.steer.added'));
    clearTimeout(steerTimer);
    steerTimer = setTimeout(() => setMsg(ui.steerMsg, ''), FLASH_MS);
  }

  async function openEvidence() {
    const res = await window.lunacore.lunasworkOpenEvidence();
    setMsg(ui.error, res && res.ok ? '' : reasonText(res), 'bad');
  }

  ui.start.addEventListener('click', () => {
    sfx.navClick();
    openDialog();
  });
  ui.cancel.addEventListener('click', closeDialog);
  ui.go.addEventListener('click', startRun);
  ui.stop.addEventListener('click', stopRun);
  ui.evidence.addEventListener('click', openEvidence);
  ui.steerForm.addEventListener('submit', steer);

  const offEvent = window.lunacore.onLunasworkEvent((event) => apply(event && event.status));
  const offLang = onLangChange(() => {
    paint();
    if (dialogView && !ui.dialog.hidden) paintDialog(dialogView, dialogBlocker);
  });
  loadStatus();

  return {
    // The dialog was for the previous project.
    projectChanged: closeDialog,
    dispose: () => {
      clearInterval(ticker);
      clearTimeout(steerTimer);
      if (typeof offEvent === 'function') offEvent();
      if (typeof offLang === 'function') offLang();
    },
  };
}

