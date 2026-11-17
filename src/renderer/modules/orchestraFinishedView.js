// ============================================================================
// LunaCore - God Mode "run finished" screen (DOM half)
// ----------------------------------------------------------------------------
// Replaces the run board once isRunFinished() (orchestraFinished.js) says the
// run is over: package counts, run time, the integration line, the release
// row, PR links, the run email and "Open report" (all from orchestraFinish.js),
// then "Plan another God Mode run" and "Show run board" (Retry on stalled
// packages lives there). The actions themselves stay in orchestra.js.
// Every main-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { fmtElapsed } from './orchestraIntegStatus.js';
import { finishedSummary } from './orchestraFinished.js';
import { integrationLine, releaseRow, runEmailRow, reportRow } from './orchestraFinish.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, cls, onClick, disabled) {
  const btn = el('button', cls, label);
  btn.type = 'button';
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

/** One link per pull request; main opens it from the package id. */
function prLinks(prs, onOpenPr) {
  const box = el('div', 'orchestra__finished-prs');
  box.append(el('span', 'orchestra__optlabel', t('orch.finished.prs')));
  for (const pr of prs) {
    const link = el('a', 'orchestra__link', `${pr.id}: ${pr.url}`);
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      onOpenPr(pr.id);
    });
    box.append(link);
  }
  return box;
}

/**
 * @param {object} plan the board's finished run view
 * @param {{
 *   scope: string|null, disabled: boolean, rerender: () => void,
 *   onPlanAnother: () => void, onShowBoard: () => void, onOpenPr: (id:string) => void,
 * }} opts
 * @returns {HTMLElement}
 */
export function finishedPanel(plan, opts) {
  const s = finishedSummary(plan);
  const box = el('section', 'orchestra__finished');
  box.setAttribute('aria-label', t('orch.finished.title'));
  box.append(el('h3', 'orchestra__finished-title', t('orch.finished.title')));
  box.append(el('div', 'orchestra__summary', t('orch.finished.counts', s)));
  if (s.durationMs !== null) box.append(el('div', 'orchestra__meta', t('orch.finished.duration', { time: fmtElapsed(s.durationMs) })));
  const integ = integrationLine(plan);
  if (integ) box.append(integ);
  const release = releaseRow(plan, opts.rerender);
  if (release) box.append(release);
  if (s.prs.length) box.append(prLinks(s.prs, opts.onOpenPr));
  box.append(runEmailRow(plan, opts.rerender, opts.scope));
  box.append(reportRow(plan, opts.scope));

  const actions = el('div', 'orchestra__actions');
  const another = button(t('orch.finished.planAnother'), 'pad-send orchestra__primary', opts.onPlanAnother, opts.disabled);
  another.title = t('orch.finished.planAnother.hint');
  actions.append(another, button(t('orch.finished.showBoard'), 'pad-send', opts.onShowBoard, opts.disabled));
  box.append(actions);
  return box;
}

/**
 * "Back to summary" above the board of a finished run the user opened.
 * @param {() => void} onBack
 * @returns {HTMLElement}
 */
export function backToSummaryRow(onBack) {
  const row = el('div', 'orchestra__actions');
  row.append(button(t('orch.finished.backToSummary'), 'pad-send', onBack, false));
  return row;
}
