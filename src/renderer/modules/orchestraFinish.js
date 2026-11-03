// ============================================================================
// LunaCore - God Mode finished-run actions (split out of orchestra.js)
// ----------------------------------------------------------------------------
//  - integrationLine(): the "Integration (...)" line from the stored
//    integration.state (orchestraIntegStatus.js), with a live elapsed time
//    while the step really runs.
//  - runEmailRow():what happened to the run email (integration.emailError /
//    emailPending from src/orchestraFinalize.js) + "Resend report email".
//    Only the run id goes to main (orchestra:resend-email).
//  - releaseAfterBox() / releaseAfterChoice(): the launch screen's "Create a
//    new release after finish", off by default, remembered per project in
//    localStorage (a per-viewer convenience; the run itself keeps it as
//    options.releaseAfter in main).
//  - releaseRow(): the release result, or "Release now" with the count of
//    unreleased commits when it was not ticked. Only the project id goes to
//    main (orchestra:unreleased-count / orchestra:release-now), which checks
//    it and asks Mati natively before anything is pushed.
// Every main-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { integrationStatus, fmtElapsed } from './orchestraIntegStatus.js';

const NOT_CONNECTED = 'gmail-not-connected';
// Integration errors with their own message (orchestraFinalize / Integrate).
const INTEG_ERRORS = new Set([
  'noBaseBranch', 'noGh', 'missingCwd', 'ghFailed', 'fetchFailed', 'worktreeFailed', 'installFailed', 'mergeFailed',
  'conflictFailed', 'verifyFailed', 'pushFailed', 'baseMoved', 'nothingMergedFailed', 'beforePushFailed',
]);
const ELAPSED_TICK_MS = 1000;
const ELAPSED_ATTR = 'data-orch-started';
// Resend answers with their own text (orch.resend.err.<reason>).
const RESEND_ERRORS = new Set(['badId', 'unknownRun', 'busy', 'rate-limited', 'gmail-not-connected', 'no-report']);

/** The last resend per run: {planId, busy, ok, reason}. */
let resend = { planId: null, busy: false, ok: false, reason: null };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const msg = (text, cls = '') => el('p', `orchestra__msg ${cls}`.trim(), text);

// ---------------------------------------------------------------------------
// Integration status
// ---------------------------------------------------------------------------

let elapsedTimer = null;

/** Repaints only the elapsed counters (a full render would reset edited prompts). */
function tickElapsed() {
  const nodes = typeof document !== 'undefined' ? document.querySelectorAll(`[${ELAPSED_ATTR}]`) : [];
  if (!nodes.length) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    return;
  }
  for (const node of nodes) node.textContent = fmtElapsed(Date.now() - Number(node.getAttribute(ELAPSED_ATTR)));
}

function elapsedNode(startedAt, elapsedMs) {
  const span = el('span', 'orchestra__elapsed', fmtElapsed(elapsedMs));
  span.setAttribute(ELAPSED_ATTR, String(startedAt));
  if (!elapsedTimer) elapsedTimer = setInterval(tickElapsed, ELAPSED_TICK_MS);
  return span;
}

function integFailWhy(s) {
  const why = INTEG_ERRORS.has(s.error) ? t(`orch.integerr.${s.error}`) : s.error || '';
  return s.detail ? `${why}: ${s.detail}` : why;
}

/**
 * The integration line, derived from the stored integration.state - so a
 * settled run reads done / partial / failed on open and on every update,
 * whatever the finalizer's `running` flag says.
 * @param {object} plan the board's run view
 * @returns {HTMLElement|null}
 */
export function integrationLine(plan) {
  const s = integrationStatus(plan, Date.now());
  if (!s) return null;
  const mode = t(`orch.integ.${s.mode}`);
  if (s.kind === 'running') {
    const line = msg(t('orch.integ.running', { mode }));
    if (s.elapsedMs !== null) line.append(' ', elapsedNode(plan.integration.startedAt, s.elapsedMs));
    return line;
  }
  if (s.kind === 'failed') return msg(t('orch.integ.failed', { mode, why: integFailWhy(s) }), 'is-bad');
  if (s.kind === 'partial') return msg(t('orch.integ.partial', { mode, n: s.merged, m: s.total, sha: s.sha || '-' }), 'is-warn');
  if (s.mode === 'merge' && s.sha) return msg(t('orch.integ.merged', { base: s.base || '-', sha: s.sha }));
  return msg(t('orch.integ.done', { mode }));
}

/** The run email's state line, or null when it went out. */
function emailStatus(integ) {
  if (!integ.emailError) return null;
  if (integ.emailError === NOT_CONNECTED) {
    const line = integ.emailPending ? `${t('orch.emailNotConnected')} - ${t('orch.emailPending')}` : t('orch.emailNotConnected');
    return msg(line, 'is-warn');
  }
  const line = t('orch.emailFailed', { reason: integ.emailError });
  return msg(integ.emailPending ? `${line} - ${t('orch.emailRetry')}` : line, 'is-warn');
}

/** The last resend's answer for this run, or null. */
function resendStatus(planId) {
  if (resend.planId !== planId || resend.busy) return null;
  if (resend.ok) return el('span', 'orchestra__msg', t('orch.resend.sent'));
  if (!resend.reason) return null;
  const code = RESEND_ERRORS.has(resend.reason) ? resend.reason : 'failed';
  return el('span', 'orchestra__msg is-bad', t(`orch.resend.err.${code}`));
}

/**
 * The finished run's email line + "Resend report email".
 * @param {{id:string, integration?:object}} plan
 * @param {() => void} rerender redraws the board after an answer
 * @returns {HTMLElement}
 */
export function runEmailRow(plan, rerender) {
  const integ = plan.integration || {};
  const box = el('div', 'orchestra__email');
  const status = emailStatus(integ);
  if (status) box.append(status);
  const row = el('div', 'orchestra__options');
  const btn = el('button', 'pad-send', t('orch.resend'));
  btn.type = 'button';
  btn.title = t('orch.resend.hint');
  btn.disabled = (resend.busy && resend.planId === plan.id) || !!integ.running;
  btn.addEventListener('click', async () => {
    const planId = plan.id;
    resend = { planId, busy: true, ok: false, reason: null };
    rerender();
    let res;
    try {
      res = await window.lunacore.resendOrchestraEmail(planId);
    } catch {
      res = { ok: false, reason: 'failed' };
    }
    resend = { planId, busy: false, ok: !!(res && res.ok), reason: res && !res.ok ? String(res.reason || 'failed') : null };
    rerender();
  });
  row.append(btn);
  const answer = resendStatus(plan.id);
  if (answer) row.append(answer);
  box.append(row);
  return box;
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

const RELEASE_KEY_PREFIX = 'orch.releaseAfter.';

/** Whether "Create a new release after finish" is ticked for a project (default off). */
export function releaseAfterChoice(projectId) {
  if (typeof projectId !== 'string' || !projectId) return false;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(RELEASE_KEY_PREFIX + projectId) === '1';
  } catch {
    return false;
  }
}

function rememberReleaseAfter(projectId, on) {
  if (typeof projectId !== 'string' || !projectId) return;
  try {
    if (typeof localStorage === 'undefined') return;
    if (on) localStorage.setItem(RELEASE_KEY_PREFIX + projectId, '1');
    else localStorage.removeItem(RELEASE_KEY_PREFIX + projectId);
  } catch {
    // Storage blocked: the box still works for this launch.
  }
}

/**
 * The launch screen checkbox (merge runs only - the caller decides).
 * @param {string} projectId
 * @param {boolean} disabled
 * @returns {HTMLElement}
 */
export function releaseAfterBox(projectId, disabled) {
  const label = el('label', 'orchestra__optlabel');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = releaseAfterChoice(projectId);
  box.disabled = disabled;
  box.addEventListener('change', () => rememberReleaseAfter(projectId, box.checked));
  label.append(box, document.createTextNode(` ${t('orch.releaseAfter')}`));
  label.title = t('orch.releaseAfter.hint');
  return label;
}

/** Unreleased commit count per run: {planId, loading, count, tag}; Release now: {planId, busy, reason}. */
let unreleased = { planId: null, loading: false, count: null, tag: null };
let releasing = { planId: null, busy: false, reason: null };

function loadUnreleased(plan, rerender) {
  if (unreleased.planId === plan.id || !window.lunacore.orchestraUnreleasedCount) return;
  unreleased = { planId: plan.id, loading: true, count: null, tag: null };
  window.lunacore
    .orchestraUnreleasedCount(plan.projectId)
    .then((res) => res, () => null)
    .then((res) => {
      if (unreleased.planId !== plan.id) return;
      unreleased = { planId: plan.id, loading: false, count: res && res.ok ? res.count : null, tag: res && res.ok ? res.tag : null };
      rerender();
    });
}

/** The release step's stored result as one line, or null. */
function releaseResultLine(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.released) return msg(t('orch.release.done', { tag: result.tag || `v${result.version}`, url: result.url || '-' }));
  if (result.skipped) return msg(t('orch.release.skipped', { reason: result.skipped }), 'is-warn');
  if (result.error) return msg(t('orch.release.failed', { reason: result.error }), 'is-bad');
  return null;
}

/**
 * The finished run's release line: what the release step did, or "Release
 * now" (+ unreleased commit count) when the run landed and it was not ticked.
 * @param {{id:string, projectId:string, integrationMode?:string, options?:object, integration?:object}} plan
 * @param {() => void} rerender
 * @returns {HTMLElement|null}
 */
export function releaseRow(plan, rerender) {
  const integ = plan.integration || {};
  const result = integ.postMerge && integ.postMerge.release;
  const ticked = !!(plan.options && plan.options.releaseAfter === true);
  const landed = plan.integrationMode === 'merge' && integ.state === 'done' && !!integ.headSha;
  const box = el('div', 'orchestra__release');
  const line = releaseResultLine(result);
  if (line) box.append(line);
  const canRelease = landed && !ticked && !(result && result.released);
  if (!canRelease) return line ? box : null;

  loadUnreleased(plan, rerender);
  const row = el('div', 'orchestra__options');
  const busy = releasing.busy && releasing.planId === plan.id;
  const btn = el('button', 'pad-send', t('orch.releaseNow'));
  btn.type = 'button';
  btn.title = t('orch.releaseNow.hint');
  btn.disabled = busy || !!integ.running;
  btn.addEventListener('click', async () => {
    const planId = plan.id;
    releasing = { planId, busy: true, reason: null };
    rerender();
    let res;
    try {
      res = await window.lunacore.releaseOrchestraNow(plan.projectId);
    } catch {
      res = { ok: false, reason: 'failed' };
    }
    releasing = { planId, busy: false, reason: res && !res.ok ? String(res.reason || 'failed') : null };
    // The count changed (or not): ask again on the next render.
    unreleased = { planId: null, loading: false, count: null, tag: null };
    rerender();
  });
  row.append(btn);
  if (busy) row.append(el('span', 'orchestra__msg', t('orch.release.running')));
  else if (Number.isInteger(unreleased.count) && unreleased.planId === plan.id) {
    row.append(el('span', 'orchestra__msg', t('orch.release.unreleased', { n: unreleased.count, tag: unreleased.tag || '-' })));
  }
  if (!busy && releasing.planId === plan.id && releasing.reason) {
    const text = releasing.reason === 'declined' ? t('orch.release.declined') : t('orch.release.refused', { reason: releasing.reason });
    row.append(el('span', 'orchestra__msg is-bad', text));
  }
  box.append(row);
  return box;
}
