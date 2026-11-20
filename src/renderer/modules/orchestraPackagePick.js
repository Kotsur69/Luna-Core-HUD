// ============================================================================
// LunaCore - a package's model + effort on the Approve board (pool runs)
// ----------------------------------------------------------------------------
// Before Approve, in a pool run, a package card's model badge is a button: a
// click opens a select of the ticked pool models plus Opus (always offered),
// each with its efforts ("Per plan", a Claude level, an agy family's live
// variant). The picks ride along with Approve as {packageModels: {[id]:
// {model, effort}}}; main checks every one again (src/orchestraPackageModel.js)
// and saves it as the package's planned model. Free profiles are not offered:
// a free package needs the hybrid machinery.
//
// The rules (choices, payload) are pure and exported for node tests; text
// goes in via textContent only.
// ============================================================================

'use strict';

import { STRENGTH_ORDER, POOL_FREE_KEY, POOL_EFFORT_PLAN, isPoolRun, poolKeys, runsOnOf, claudePoolLevels, poolModelName, poolEffortLevel } from '../../workerPool.js';

/** Picks on screen, `${planId}:${pkgId}` -> {model, effort}, until launched. */
const picks = new Map();
/** Cards whose select is open. */
const open = new Set();

const OPUS = 'opus';
const keyOf = (planId, pkgId) => `${planId}:${pkgId}`;

/**
 * The models a pick may name: the ticked pool keys without the free
 * profile, plus Opus, strongest first.
 * @param {{model:string, effort:string}[]} pool the pool on screen
 * @returns {string[]}
 */
export function pickKeys(pool) {
  const keys = new Set([...poolKeys(pool).filter((k) => k !== POOL_FREE_KEY), OPUS]);
  return STRENGTH_ORDER.filter((k) => keys.has(k));
}

/**
 * Every {model, effort} choice, in menu order.
 * @param {{model:string, effort:string}[]} pool
 * @param {(key:string) => {id:string}[]} variantsOf the live agy variants of a family
 * @returns {{model:string, effort:string}[]}
 */
export function pickOptions(pool, variantsOf) {
  return pickKeys(pool).flatMap((model) => {
    const on = runsOnOf(model);
    const efforts = on === 'claude' ? claudePoolLevels(model) : on === 'agy' ? variantsOf(model).map((v) => v.id) : [];
    return [POOL_EFFORT_PLAN, ...efforts].map((effort) => ({ model, effort }));
  });
}

/** A choice's text: 'Opus - xhigh', 'Argon (agy) - medium', 'Sonnet - <per plan>'. */
export function pickText(choice, perPlan) {
  const name = poolModelName(choice.model) || choice.model;
  const level = choice.effort === POOL_EFFORT_PLAN ? perPlan : poolEffortLevel(choice) || choice.effort;
  return `${name} - ${level}`;
}

/** True when the card's badge takes a pick: before Approve, a pool run on screen, a pending package. */
export function canPick(plan, pkg, pool, workers) {
  if (!plan || plan.started || plan.scheduledAt || plan.planRun || !pkg || pkg.state !== 'pending') return false;
  return isPoolRun(pool) && workers !== 'free' && workers !== 'agy';
}

/** The pick on screen for a package, or null. */
export function pickOf(planId, pkgId) {
  return picks.get(keyOf(planId, pkgId)) || null;
}

/**
 * Approve's packageModels: the picks of this plan that are still choices of
 * the pool on screen; null when there are none (the payload as before).
 * @param {object} plan the plan view
 * @param {{model:string, effort:string}[]} pool
 * @param {(key:string) => {id:string}[]} variantsOf
 * @returns {Object<string,{model:string, effort:string}>|null}
 */
export function packageModelsField(plan, pool, variantsOf) {
  if (!plan || !isPoolRun(pool)) return null;
  const allowed = pickOptions(pool, variantsOf);
  const out = {};
  for (const p of Array.isArray(plan.packages) ? plan.packages : []) {
    const pick = pickOf(plan.id, p.id);
    if (pick && p.state === 'pending' && allowed.some((c) => c.model === pick.model && c.effort === pick.effort)) out[p.id] = { ...pick };
  }
  return Object.keys(out).length ? out : null;
}

/** Forget a plan's picks (launched or discarded). */
export function clearPicks(planId) {
  for (const k of [...picks.keys()]) if (k.startsWith(`${planId}:`)) picks.delete(k);
  for (const k of [...open]) if (k.startsWith(`${planId}:`)) open.delete(k);
}

/**
 * The badge button and, once clicked, its select.
 * @param {{plan:object, pkg:object, pool:object[], variantsOf:Function, badge:string, t:Function, onChange:() => void, disabled?:boolean}} o
 * @returns {HTMLElement}
 */
export function packagePickView({ plan, pkg, pool, variantsOf, badge, t, onChange, disabled = false }) {
  const key = keyOf(plan.id, pkg.id);
  const wrap = document.createElement('div');
  wrap.className = 'orchestra__options';
  const pick = picks.get(key) || null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pad-send';
  btn.disabled = disabled;
  btn.title = t('orch.pick.pkg.hint');
  btn.textContent = pick ? pickText(pick, t('orch.pick.pkg.perPlan')) : badge || t('orch.pick.pkg.none');
  btn.addEventListener('click', () => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    onChange();
  });
  wrap.append(btn);
  if (!open.has(key)) return wrap;
  const select = document.createElement('select');
  select.className = 'profile-select';
  select.disabled = disabled;
  select.setAttribute('aria-label', t('orch.pick.pkg'));
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('orch.pick.pkg.none');
  select.append(none);
  const choices = pickOptions(pool, variantsOf);
  choices.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = pickText(c, t('orch.pick.pkg.perPlan'));
    if (pick && c.model === pick.model && c.effort === pick.effort) opt.selected = true;
    select.append(opt);
  });
  select.addEventListener('change', () => {
    const chosen = select.value === '' ? null : choices[Number(select.value)];
    if (chosen) picks.set(key, { model: chosen.model, effort: chosen.effort });
    else picks.delete(key);
    open.delete(key);
    onChange();
  });
  wrap.append(select);
  return wrap;
}
