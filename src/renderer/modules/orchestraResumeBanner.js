// ============================================================================
// LunaCore - God Mode board: the resume-after-shutdown banner
// ----------------------------------------------------------------------------
// One banner per run (each board shows its own run's view.interrupted, from
// src/orchestraResume.js):
//   - restored after a shutdown: "resuming in 60 s" (or "at HH:MM" when the
//     usage-limit reset is later), why it waits, Resume now / Cancel
//   - paused in this session: "Safe to turn off the PC" (or still finishing)
//     and Resume
// plus the "Pause for shutdown" button of a running board. The banner ticks
// its own seconds, so the board is not re-rendered every second. Every
// string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';

const COUNTDOWN_TICK_MS = 1000;
// view.interrupted.waiting reasons with their own text (orch.interrupted.waiting.<reason>).
const WAIT_REASONS = new Set(['busy', 'batteryLow', 'noNodeModules', 'lunasWorkActive', 'usageLimit']);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clockText = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const secondsLeft = (at, nowMs) => Math.max(0, Math.ceil((at - nowMs) / 1000));

/**
 * The banner's headline for an interruption at `nowMs`. Exported for tests.
 * @param {{by:string, resumeAt:number|null, resetAt:number|null, safe:boolean}} i
 * @param {number} nowMs
 * @returns {{key:string, vars:object}}
 */
export function bannerText(i, nowMs) {
  if (!Number.isFinite(i.resumeAt)) {
    return { key: i.safe ? 'orch.interrupted.paused' : 'orch.interrupted.pausedBusy', vars: {} };
  }
  if (Number.isFinite(i.resetAt) && i.resetAt > nowMs) return { key: 'orch.interrupted.resetAt', vars: { time: clockText(i.resumeAt) } };
  const key = i.by === 'pause' ? 'orch.interrupted.pauseCountdown' : 'orch.interrupted.countdown';
  return { key, vars: { s: secondsLeft(i.resumeAt, nowMs) } };
}

/**
 * The resume banner of one run, or null when the run is not interrupted.
 * @param {{interrupted?:object|null}} plan
 * @param {{disabled:boolean, onResume:() => void, onCancel:() => void}} opts
 * @returns {HTMLElement|null}
 */
export function resumeBanner(plan, { disabled, onResume, onCancel }) {
  const i = plan && plan.interrupted && typeof plan.interrupted === 'object' ? plan.interrupted : null;
  if (!i) return null;
  const box = el('div', 'orchestra__options orchestra__resume');
  const head = () => {
    const { key, vars } = bannerText(i, Date.now());
    return t(key, vars);
  };
  const line = el('span', 'orchestra__msg is-warn', head());
  line.setAttribute('role', 'status');
  box.append(line);
  if (Number.isFinite(i.resumeAt)) {
    const timer = setInterval(() => {
      if (!line.isConnected) clearInterval(timer);
      else line.textContent = head();
    }, COUNTDOWN_TICK_MS);
  }
  const resumeBtn = el('button', 'pad-send', t('orch.interrupted.resumeNow'));
  resumeBtn.type = 'button';
  resumeBtn.disabled = disabled;
  resumeBtn.addEventListener('click', onResume);
  box.append(resumeBtn);
  // Cancel only stops a countdown; a pause in this session has none to stop.
  if (Number.isFinite(i.resumeAt)) {
    const cancelBtn = el('button', 'pad-send', t('orch.interrupted.cancel'));
    cancelBtn.type = 'button';
    cancelBtn.disabled = disabled;
    cancelBtn.addEventListener('click', onCancel);
    box.append(cancelBtn);
  }
  if (Number.isInteger(i.toResume) && i.toResume > 0) box.append(el('div', 'orchestra__meta', t('orch.interrupted.count', { n: i.toResume })));
  if (WAIT_REASONS.has(i.waiting)) box.append(el('div', 'orchestra__meta is-warn', t(`orch.interrupted.waiting.${i.waiting}`)));
  return box;
}

/**
 * "Pause for shutdown" on a running board, or null when it does not apply.
 * @param {{started?:boolean, killed?:boolean, settled?:boolean, interrupted?:object|null, integration?:object}} plan
 * @param {{running:boolean, disabled:boolean, onPause:() => void}} opts
 * @returns {HTMLElement|null}
 */
export function pauseRow(plan, { running, disabled, onPause }) {
  if (!plan || !plan.started || plan.killed || plan.settled || plan.interrupted || !running) return null;
  if (plan.integration && plan.integration.running === true) return null;
  const row = el('div', 'orchestra__options');
  const btn = el('button', 'pad-send', t('orch.pauseShutdown'));
  btn.type = 'button';
  btn.disabled = disabled;
  btn.addEventListener('click', onPause);
  row.append(btn, el('span', 'orchestra__meta', t('orch.pauseShutdown.note')));
  return row;
}
