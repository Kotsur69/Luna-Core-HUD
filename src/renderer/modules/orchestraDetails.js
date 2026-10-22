// ============================================================================
// LunaCore - God Mode board details (split out of orchestra.js)
// ----------------------------------------------------------------------------
// Two pieces of the plan dialog:
//  - failureBlock(): a failed launch's structured record (src/orchestra.js
//    failureOf) - localized reason, the stage, the dependency branch, the
//    conflicting files, what to do next and when the attempt happened.
//  - runOptionsRow(): the always-visible "Run options" checkboxes, reflecting
//    plan.options as main pushes it.
// Every git- or model-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';

// Codes with their own "what now" hint (orch.hint.<code>).
const HINT_CODES = new Set(['depMergeFailed', 'conflict', 'depVerifyFailed', 'launchThrew', 'noTab', 'briefFailed']);
// Hints shared between codes.
const HINT_ALIAS = { conflict: 'depMergeFailed' };
const STAGES = new Set(['worktree', 'brief', 'tab', 'launch', 'depMerge', 'depVerify']);
const MAX_FILES_SHOWN = 10;
// Live run switches (orchestraSupervisor RUN_OPTION_FLAGS).
const RUN_OPTIONS = ['sleepOnLimit', 'shutdownWhenDone'];

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
  for (const key of RUN_OPTIONS) {
    const item = el('div', 'orchestra__runopt');
    const label = el('label', 'orchestra__optlabel');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = options[key] === true;
    box.disabled = disabled;
    box.addEventListener('change', () => onToggle(key, box.checked));
    label.append(box, document.createTextNode(` ${t(`orch.runopt.${key}`)}`));
    item.append(label, el('div', 'orchestra__meta', t(`orch.runopt.${key}.note`)));
    row.append(item);
  }
  return row;
}
