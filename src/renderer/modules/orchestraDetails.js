// ============================================================================
// LunaCore - God Mode board details (split out of orchestra.js)
// ----------------------------------------------------------------------------
// Two pieces of the plan dialog:
//  - failureBlock(): a failed launch's structured record (src/orchestra.js
//    failureOf) - localized reason, the stage, the dependency branch, the
//    conflicting files, what to do next and when the attempt happened.
//  - runOptionsRow(): the always-visible "Run options" checkboxes, reflecting
//    plan.options as main pushes it.
//  - powerBanner(): the sleep / shutdown countdown with its cancel button
//    (src/orchestraPower.js), counting down on its own.
//  - batteryBanner(): the one on-battery warning (createBatteryGuard), with
//    the low-battery hold when new workers and verifies wait for the charger.
// Every git- or model-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { freeReviewLine } from './orchestraHybridView.js';

// Codes with their own "what now" hint (orch.hint.<code>).
const HINT_CODES = new Set(['depMergeFailed', 'conflict', 'depVerifyFailed', 'launchThrew', 'noTab', 'briefFailed']);
// Hints shared between codes.
const HINT_ALIAS = { conflict: 'depMergeFailed' };
const STAGES = new Set(['worktree', 'brief', 'tab', 'launch', 'depMerge', 'depVerify']);
const MAX_FILES_SHOWN = 10;
// Live run switches (orchestraSupervisor RUN_OPTION_FLAGS).
const RUN_OPTIONS = ['sleepOnLimit', 'shutdownWhenDone'];
// F5, a free build run only: one Claude review per luna-free/* branch (opt-in).
const FREE_RUN_OPTIONS = ['freeReview'];
// canWake() reasons with their own text (orch.wake.<reason>).
const WAKE_REASONS = new Set(['noSleepState', 'wakeTimersOff', 'wakeTimersImportantOnly', 'unsupported', 'unknown']);
const COUNTDOWN_TICK_MS = 1000;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The localized hint for a failure code, or '' when it has none. */
export function hintFor(code) {
  if (!HINT_CODES.has(code)) return '';
  return t(`orch.hint.${HINT_ALIAS[code] || code}`);
}

const stamp = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * The failure block of a failed package card.
 * @param {{code:string, stage:string|null, branch:string|null, files:string[], detail:string|null, at:number|null}} failure
 * @param {(code:string) => string} reasonText the card's localized error text
 * @returns {HTMLElement}
 */
export function failureBlock(failure, reasonText) {
  const box = el('div', 'orchestra__failure');
  const head = el('p', 'orchestra__msg is-bad', reasonText(failure.code));
  if (failure.stage && STAGES.has(failure.stage)) {
    head.append(el('span', 'orchestra__stage', ` · ${t(`orch.stage.${failure.stage}`)}`));
  }
  box.append(head);
  if (failure.branch) box.append(el('div', 'orchestra__meta', t('orch.fail.branch', { branch: failure.branch })));
  const files = Array.isArray(failure.files) ? failure.files : [];
  if (files.length) {
    box.append(el('div', 'orchestra__meta', t('orch.fail.files')));
    const list = el('ul', 'orchestra__files');
    for (const f of files.slice(0, MAX_FILES_SHOWN)) list.append(el('li', '', f));
    if (files.length > MAX_FILES_SHOWN) list.append(el('li', 'is-more', t('orch.fail.more', { n: files.length - MAX_FILES_SHOWN })));
    box.append(list);
  }
  if (failure.detail) box.append(el('code', 'orchestra__example', failure.detail));
  const hint = hintFor(failure.code);
  if (hint) box.append(el('p', 'orchestra__msg is-warn', hint));
  if (Number.isFinite(failure.at)) box.append(el('div', 'orchestra__meta', t('orch.fail.at', { time: stamp(failure.at) })));
  return box;
}

/**
 * "Run options": one checkbox per live switch with a short note under it.
 * @param {{options?:object}} plan
 * @param {{disabled:boolean, onToggle:(key:string, value:boolean) => void}} opts
 * @returns {HTMLElement}
 */
export function runOptionsRow(plan, { disabled, onToggle }) {
  const options = plan.options && typeof plan.options === 'object' ? plan.options : {};
  const row = el('div', 'orchestra__runopts');
  row.append(el('span', 'orchestra__optlabel', t('orch.runopts')));
  const keys = plan.freeMode === true ? [...RUN_OPTIONS, ...FREE_RUN_OPTIONS] : RUN_OPTIONS;
  for (const key of keys) {
    const item = el('div', 'orchestra__runopt');
    const label = el('label', 'orchestra__optlabel');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = options[key] === true;
    box.disabled = disabled;
    box.addEventListener('change', () => onToggle(key, box.checked));
    label.append(box, document.createTextNode(` ${t(`orch.runopt.${key}`)}`));
    item.append(label, el('div', 'orchestra__meta', t(`orch.runopt.${key}.note`)));
    const wake = plan.power && plan.power.wake;
    if (key === 'sleepOnLimit' && wake && WAKE_REASONS.has(wake.reason)) {
      item.append(el('div', `orchestra__meta${wake.ok ? '' : ' is-warn'}`, t(`orch.wake.${wake.reason}`)));
    }
    const status = key === 'freeReview' ? freeReviewLine(plan) : null;
    if (status) item.append(el('div', `orchestra__meta${status.cls ? ` ${status.cls}` : ''}`, status.text));
    row.append(item);
  }
  return row;
}

const clockText = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const secondsLeft = (at) => Math.max(0, Math.ceil((at - Date.now()) / 1000));

/** The live text of a countdown, or of its phase before / after it. */
function powerText(kind, state) {
  if (kind === 'sleep') {
    if (state.phase === 'scheduling') return t('orch.power.sleepScheduling');
    if (state.phase === 'sleeping') return t('orch.power.sleeping', { time: clockText(state.wakeAt) });
    return t('orch.power.sleepCountdown', { s: secondsLeft(state.at), time: clockText(state.wakeAt) });
  }
  if (state.phase === 'arming') return t('orch.power.shutdownArming');
  return t('orch.power.shutdownCountdown', { s: secondsLeft(state.at) });
}

/**
 * The on-battery warning, or null on mains power. One line: the hold when
 * the battery is low, else the warning (with the level when it is known).
 * @param {{battery?:object|null}} plan
 * @returns {HTMLElement|null}
 */
export function batteryBanner(plan) {
  const b = plan.battery && typeof plan.battery === 'object' ? plan.battery : null;
  if (!b || b.onBattery !== true) return null;
  const pct = Number.isFinite(b.percent) ? b.percent : null;
  const text =
    b.held === true && pct !== null
      ? t('orch.battery.held', { pct, min: b.thresholdPct })
      : `${t('orch.battery.on')}${pct !== null ? ` ${t('orch.battery.pct', { pct })}` : ''}`;
  const line = el('p', `orchestra__msg ${b.held === true ? 'is-bad' : 'is-warn'}`, text);
  line.setAttribute('role', 'status');
  return line;
}

/**
 * The sleep / shutdown banner, or null when neither is going. It ticks its
 * own seconds, so the board is not re-rendered every second.
 * @param {{power?:object}} plan
 * @param {{onCancel:(what:'sleep'|'shutdown') => void}} opts
 * @returns {HTMLElement|null}
 */
export function powerBanner(plan, { onCancel }) {
  const power = plan.power && typeof plan.power === 'object' ? plan.power : {};
  const box = el('div', 'orchestra__power');
  for (const kind of ['shutdown', 'sleep']) {
    const state = power[kind];
    if (!state) continue;
    const line = el('p', 'orchestra__msg is-warn', powerText(kind, state));
    line.setAttribute('role', 'status');
    const btn = el('button', 'pad-send', t(kind === 'sleep' ? 'orch.power.cancelSleep' : 'orch.power.cancelShutdown'));
    btn.type = 'button';
    btn.addEventListener('click', () => onCancel(kind));
    box.append(line, btn);
    if (Number.isFinite(state.at)) {
      const timer = setInterval(() => {
        if (!line.isConnected) clearInterval(timer);
        else line.textContent = powerText(kind, state);
      }, COUNTDOWN_TICK_MS);
    }
  }
  if (power.sleepError) box.append(el('p', 'orchestra__msg is-bad', t('orch.power.sleepFailed', { reason: power.sleepError })));
  if (power.shutdownError) {
    box.append(el('p', 'orchestra__msg is-bad', t('orch.power.shutdownFailed', { reason: power.shutdownError })));
  }
  return box.childElementCount ? box : null;
}
