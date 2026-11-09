// ============================================================================
// LunaCore - Luna's Work "Run Playtester pass" (renderer)
// ----------------------------------------------------------------------------
// One explore pass of the Playtester on the picked project's app, without a
// run: main confirms the profile's commands natively, starts the app, lets
// the Playtester play it once and stops it (src/lunasworkPlaytestOnce.js).
//
// The group shows a status line fed by {type:'playtestOnce', stage} pushes on
// lunaswork:event, then the report: findings (severity, steps, evidence
// thumbnail), scores, journeys, console errors, warnings and cost - and the
// "Open evidence folder" button (lunaswork:openEvidence {what:'playtestOnce'}).
// Everything is painted through textContent; thumbnails are data:image URLs
// made in main, never a path.
// ============================================================================

'use strict';

import { t } from './util.js';
import { sfx } from './sound.js';
import { onLangChange } from './bus.js';

const EVENT_TYPE = 'playtestOnce';
const STAGES = ['starting', 'playing', 'stopping', 'done'];
const SEVERITY_ORDER = ['blocker', 'high', 'medium', 'low'];
const MS_PER_MINUTE = 60000;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Localized text of a refused or failed pass. */
function failText(res) {
  const reason = res && typeof res.reason === 'string' ? res.reason : 'failed';
  if (reason === 'limit') {
    return Number.isFinite(res.resetsAt) ? t('lw.pt.err.limit', { time: timeOf(res.resetsAt) }) : t('lw.pt.err.limit-unknown');
  }
  const own = t(`lw.pt.err.${reason}`);
  if (own !== `lw.pt.err.${reason}`) return res.detail ? `${own} (${res.detail})` : own;
  const shared = t(`lw.err.${reason}`);
  return shared === `lw.err.${reason}` ? t('lw.err.failed') : shared;
}

function section(title, body) {
  const wrap = el('div', 'lw-pt__section');
  wrap.append(el('h4', 'lw-pt__heading', title), body);
  return wrap;
}

function findingItem(f) {
  const li = el('li', 'lw-pt__finding');
  const head = el('div', 'lw-pt__finding-head');
  // Severity as a word, not only a color.
  const sev = SEVERITY_ORDER.includes(f.severity) ? f.severity : 'low';
  head.append(el('span', `lw-pt__sev is-${sev}`, t(`lw.pt.sev.${sev}`)), el('span', 'lw-pt__title', f.title));
  li.append(head);
  if (f.steps.length) {
    const ol = el('ol', 'lw-pt__steps');
    ol.append(...f.steps.map((s) => el('li', '', s)));
    li.append(ol);
  }
  if (f.files.length) li.append(el('div', 'lw-pt__meta', `${t('lw.pt.files')}: ${f.files.join(', ')}`));
  if (typeof f.thumb === 'string' && f.thumb.startsWith('data:image/')) {
    const img = el('img', 'lw-pt__thumb');
    img.src = f.thumb;
    img.alt = t('lw.pt.thumbAlt', { title: f.title });
    img.loading = 'lazy';
    li.append(img);
  }
  return li;
}

function scoresTable(scores) {
  const table = el('table', 'lw-run__scores');
  const head = el('tr');
  head.append(el('th', '', t('lw.pt.criterion')), el('th', '', t('lw.pt.score')));
  table.append(head, ...scores.map((s) => {
    const tr = el('tr');
    const name = s.milestone ? `${s.milestone} - ${s.criterion}` : s.criterion;
    tr.append(el('td', '', name), el('td', '', s.score === null ? '-' : String(s.score)));
    return tr;
  }));
  return table;
}

function plainList(items, cls) {
  const ul = el('ul', `lw-pt__list ${cls || ''}`.trim());
  ul.append(...items.map((text) => el('li', '', text)));
  return ul;
}

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

function costLine(result) {
  const parts = [];
  if (Number.isFinite(result.costUsd)) parts.push(`$${result.costUsd.toFixed(2)}`);
  if (result.usage && typeof result.usage === 'object') {
    const tokens = TOKEN_KEYS.reduce((sum, k) => sum + (Number.isFinite(result.usage[k]) ? result.usage[k] : 0), 0);
    if (tokens) parts.push(t('lw.pt.tokens', { n: tokens.toLocaleString() }));
  }
  if (Number.isFinite(result.durationMs)) parts.push(t('lw.pt.minutes', { n: Math.max(1, Math.round(result.durationMs / MS_PER_MINUTE)) }));
  if (result.model) parts.push(result.model);
  if (result.retried) parts.push(t('lw.pt.retried'));
  return parts.join(' · ');
}

function journeysList(journeys) {
  const ul = el('ul', 'lw-pt__list');
  ul.append(...journeys.map((j) => {
    const li = el('li');
    // PASS / FAIL as a word, not only a color.
    li.append(el('span', `lw-pt__verdict ${j.passed ? 'is-pass' : 'is-fail'}`, t(j.passed ? 'lw.pt.pass' : 'lw.pt.fail')), ` ${j.name}`);
    return li;
  }));
  return ul;
}

/** The report of a finished pass, as DOM nodes. */
function reportNodes(result) {
  const findings = [...result.findings]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const list = el('ul', 'lw-pt__findings');
  list.append(...findings.map(findingItem));
  const out = [section(t('lw.pt.findings', { n: findings.length }), findings.length ? list : el('p', 'termcustom__hint', t('lw.pt.noFindings')))];
  if (result.scores.length) out.push(section(t('lw.pt.scores'), scoresTable(result.scores)));
  if (result.journeys.length) out.push(section(t('lw.pt.journeys'), journeysList(result.journeys)));
  if (result.consoleErrors.length) out.push(section(t('lw.pt.console'), plainList(result.consoleErrors, 'is-mono')));
  if (result.warnings.length) {
    out.push(section(t('lw.pt.warnings'), plainList(result.warnings.map((w) => (w.text ? `${w.code}: ${w.text}` : w.code)), 'is-mono')));
  }
  const cost = costLine(result);
  if (cost) out.push(el('p', 'termcustom__hint', cost));
  return out;
}

/**
 * @param {HTMLElement} root the Settings overlay
 * @param {{projectId: () => string|null}} ctx
 * @returns {{projectChanged: () => void, dispose: () => void}}
 */
export function mountLunasWorkPlaytestPass(root, { projectId }) {
  const ui = {
    group: root.querySelector('#lw-pt'),
    run: root.querySelector('#lw-pt-run'),
    evidence: root.querySelector('#lw-pt-evidence'),
    status: root.querySelector('#lw-pt-status'),
    error: root.querySelector('#lw-pt-error'),
    report: root.querySelector('#lw-pt-report'),
  };
  if (Object.values(ui).some((v) => !v)) return { projectChanged: () => {}, dispose: () => {} };

  let busy = false;
  let passProject = null;
  let stage = null;
  // The last answer and the project it belongs to: shown only while that project is picked.
  let answer = null;
  let answerProject = null;
  // A failed "Open evidence folder" click, shown under the report.
  let openFailure = null;

  const shown = () => (answer && !busy && answerProject === projectId() ? answer : null);

  function statusText(res) {
    if (busy) return t(`lw.pt.stage.${stage || 'confirm'}`);
    if (!res) return '';
    if (res.ok) return t('lw.pt.done', { n: res.result.findings.length });
    // Cancelling the dialog is not an error: no alert for it.
    return res.reason === 'declined' ? t('lw.pt.err.declined') : '';
  }

  function errorText(res) {
    if (openFailure) return failText(openFailure);
    if (!res || res.ok || res.reason === 'declined') return '';
    return failText(res);
  }

  function paint() {
    // The project list loads after mount: a click without a project explains itself.
    ui.run.disabled = busy;
    ui.run.textContent = t(busy ? 'lw.pt.running' : 'lw.pt.run');
    ui.group.setAttribute('aria-busy', busy ? 'true' : 'false');
    const res = shown();
    const status = statusText(res);
    ui.status.textContent = status;
    ui.status.hidden = !status;
    const err = errorText(res);
    ui.error.textContent = err;
    ui.error.hidden = !err;
    ui.evidence.hidden = !res || !(res.ok || res.evidence === true);
    ui.report.replaceChildren(...(res && res.ok ? reportNodes(res.result) : []));
  }

  function settle(id, res) {
    answer = res;
    answerProject = id;
    busy = false;
    paint();
  }

  async function runPass() {
    if (busy) return;
    openFailure = null;
    const id = projectId();
    if (!id) {
      settle(null, { ok: false, reason: 'bad-project' });
      return;
    }
    sfx.terminalNew();
    busy = true;
    passProject = id;
    stage = null;
    paint();
    let res;
    try {
      res = await window.lunacore.lunasworkPlaytestOnce(id);
    } catch {
      res = null;
    }
    const valid = res && typeof res === 'object' && (res.ok ? !!res.result : true);
    if (valid && res.ok) sfx.modeToggle();
    settle(id, valid ? res : { ok: false, reason: 'failed' });
  }

  async function openEvidence() {
    sfx.navClick();
    let res;
    try {
      res = await window.lunacore.lunasworkOpenEvidence(EVENT_TYPE);
    } catch {
      res = null;
    }
    openFailure = res && res.ok ? null : res || { reason: 'failed' };
    paint();
  }

  const offEvent = window.lunacore.onLunasworkEvent((event) => {
    if (!busy || !event || event.type !== EVENT_TYPE || event.projectId !== passProject) return;
    if (!STAGES.includes(event.stage)) return;
    stage = event.stage;
    paint();
  });
  const offLang = onLangChange(paint);
  ui.run.addEventListener('click', runPass);
  ui.evidence.addEventListener('click', openEvidence);
  paint();

  return {
    // The report and the evidence button belong to the project the pass ran on.
    projectChanged: () => {
      openFailure = null;
      paint();
    },
    dispose: () => {
      ui.run.removeEventListener('click', runPass);
      ui.evidence.removeEventListener('click', openEvidence);
      if (typeof offEvent === 'function') offEvent();
      if (typeof offLang === 'function') offLang();
    },
  };
}
