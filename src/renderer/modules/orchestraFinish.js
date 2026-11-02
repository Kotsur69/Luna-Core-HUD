// ============================================================================
// LunaCore - God Mode finished-run actions (split out of orchestra.js)
// ----------------------------------------------------------------------------
// The finished run's email line: what happened to the run email
// (integration.emailError / emailPending from src/orchestraFinalize.js) and
// a "Resend report email" button. Only the run id goes to main
// (orchestra:resend-email), which checks it and does the sending.
// Every main-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';

const NOT_CONNECTED = 'gmail-not-connected';
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
