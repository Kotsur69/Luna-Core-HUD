// ============================================================================
// LunaCore phone - God Mode: review and launch a plan (Phone God Mode C)
// ----------------------------------------------------------------------------
// One card per project with a plan not started yet, from the PCs' `godmode`
// snapshots (snapmodel.godmodePlansFrom), above the live runs:
//   planning  spinner 'Planning <repo> on <host>'
//   failed    the errors + Discard
//   ready     the packages as checkboxes (all ticked; titles read-only), the
//             integration mode, Claude / free workers, 'Create a release
//             after finish' (merge only), Launch + Discard. A merge asks
//             'Merge into main?' first.
// Launch / Discard go to the host that published the plan, signed
// (hostrun.js). Every string is text. The draft of each plan lives here, so a
// realtime repaint keeps what Mati ticked.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { godmodePlansFrom } from '../snapmodel.js';
import { hostForMachine } from '../godmodestart.js';
import { INTEGRATION_MODES, planDraft, togglePackage, needsMergeConfirm, launchPayload, discardPayload } from '../godmodeplanmodel.js';
import { confirmSheet } from './sheet.js';

const INTEGRATION_KEY = { pr: 'gmIntegrationPr', merge: 'gmIntegrationMerge', branches: 'gmIntegrationBranches' };

const planKey = (plan) => `${plan.machine.toLowerCase()}|${plan.projectId}`;
/** A DOM id from free text. */
const domId = (...parts) => parts.join('-').replace(/[^A-Za-z0-9_-]/g, '_');
const repoOf = (plan) => plan.repoName || plan.projectId;

/**
 * @param {{toast: (m: string, bad?: boolean) => void}} deps
 * @param {(host: string) => {run: (kind: string, payload: object) => Promise<object|null>}} runnerFor
 * @param {() => void} repaint
 * @returns {(rows: object[], hosts: object[], now: number) => Node[]}
 */
export function createPlanCards(deps, runnerFor, repaint) {
  /** planKey -> draft (planDraft). */
  const drafts = new Map();
  /** planKeys with a command in flight. */
  const inflight = new Set();

  async function send(plan, kind, payload, okKey) {
    const key = planKey(plan);
    if (inflight.has(key)) return;
    inflight.add(key);
    repaint();
    try {
      const res = await runnerFor(plan.machine).run(kind, payload);
      if (res) deps.toast(tf(okKey, { repo: repoOf(plan), host: plan.machine }));
    } finally {
      inflight.delete(key);
      repaint();
    }
  }

  async function launch(plan) {
    const draft = drafts.get(planKey(plan));
    const payload = launchPayload(plan, draft);
    if (!payload) return;
    if (needsMergeConfirm(draft)) {
      const ok = await confirmSheet({ title: t('gmMergeConfirm'), text: tf('gmMergeConfirmText', { repo: repoOf(plan) }), ok: t('gmMergeOk'), danger: true });
      if (!ok) return;
    }
    await send(plan, 'godmode.launch', payload, 'gmLaunched');
  }

  const discard = (plan) => send(plan, 'godmode.discard', discardPayload(plan), 'gmDiscarded');

  /** The plan's draft through `fn`, then a repaint. */
  function update(plan, fn) {
    const key = planKey(plan);
    drafts.set(key, fn(drafts.get(key)));
    repaint();
  }

  const staleTag = (plan) => (plan.stale ? h('span', { class: 'tag is-warn' }, t('godmodeStale')) : null);
  const todosList = (plan) => (plan.todos.length ? h('ul', { class: 'todo-list' }, plan.todos.map((x) => h('li', { class: 'hint' }, x))) : null);

  function planningCard(plan) {
    return h(
      'section',
      { class: 'card stack-sm gm-plan', 'aria-busy': 'true' },
      h('div', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', { class: 'section-title grow' }, tf('gmPlanning', { repo: repoOf(plan), host: plan.machine })), staleTag(plan)),
      todosList(plan),
    );
  }

  function failedCard(plan, busy, canRun) {
    return h(
      'section',
      { class: 'card stack-sm gm-plan' },
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, tf('gmPlanFailed', { repo: repoOf(plan) })), staleTag(plan)),
      h('span', { class: 'hint' }, plan.machine),
      plan.errors.length ? h('ul', { class: 'rows' }, plan.errors.map((e) => h('li', { class: 'hint is-bad' }, e))) : null,
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy || !canRun, onclick: () => discard(plan) }, t(busy ? 'gmSending' : 'gmDiscard')),
    );
  }

  function packageRow(plan, draft, p, busy) {
    const id = domId('gm-pkg', planKey(plan), p.id);
    const box = h('input', { type: 'checkbox', id, checked: draft.ticked.includes(p.id), disabled: busy });
    box.addEventListener('change', () => update(plan, (d) => togglePackage(d, p.id)));
    const meta = [p.model, p.deps.length ? tf('godmodeAfter', { ids: p.deps.join(', ') }) : ''].filter(Boolean).join(' · ');
    return h('li', {}, h('label', { class: 'gm-check', for: id }, box, h('span', { class: 'gm-check-text' }, h('span', {}, p.title || p.id), meta ? h('span', { class: 'hint num' }, meta) : null)));
  }

  function controls(plan, draft, busy) {
    const base = domId('gm', planKey(plan));
    const sel = h('select', { class: 'field', id: `${base}-integ`, disabled: busy }, INTEGRATION_MODES.map((m) => h('option', { value: m, selected: m === draft.integration }, t(INTEGRATION_KEY[m]))));
    sel.addEventListener('change', () => update(plan, (d) => ({ ...d, integration: sel.value })));
    const free = h('input', { type: 'checkbox', role: 'switch', id: `${base}-free`, checked: draft.free, disabled: busy });
    free.addEventListener('change', () => update(plan, (d) => ({ ...d, free: free.checked })));
    const release = h('input', { type: 'checkbox', id: `${base}-release`, checked: draft.releaseAfter, disabled: busy });
    release.addEventListener('change', () => update(plan, (d) => ({ ...d, releaseAfter: release.checked })));
    return [
      h('label', { class: 'label', for: `${base}-integ` }, t('gmIntegration')),
      sel,
      h('label', { class: 'gm-check', for: `${base}-free` }, free, h('span', { class: 'gm-check-text' }, h('span', {}, t(draft.free ? 'gmWorkersFree' : 'gmWorkersClaude')), h('span', { class: 'hint' }, t('gmWorkersHint')))),
      draft.integration === 'merge' ? h('label', { class: 'gm-check', for: `${base}-release` }, release, h('span', { class: 'gm-check-text' }, t('gmReleaseAfter'))) : null,
    ];
  }

  function readyCard(plan, busy, canRun) {
    const key = planKey(plan);
    const draft = planDraft(plan, drafts.get(key));
    drafts.set(key, draft);
    const payload = launchPayload(plan, draft);
    return h(
      'section',
      { class: 'card stack-sm gm-plan' },
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, tf('gmPlanReady', { repo: repoOf(plan) })), staleTag(plan)),
      h('span', { class: 'hint' }, [plan.machine, tf('gmPackagesCount', { n: draft.ticked.length, total: plan.packages.length })].join(' · ')),
      todosList(plan),
      h('ul', { class: 'rows' }, plan.packages.map((p) => packageRow(plan, draft, p, busy))),
      controls(plan, draft, busy),
      canRun ? null : h('p', { class: 'hint is-warn' }, t('gmHostOff')),
      h(
        'div',
        { class: 'row gm-actions' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy || !canRun, onclick: () => discard(plan) }, t('gmDiscard')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: busy || !canRun || !payload, 'aria-busy': busy ? 'true' : null, onclick: () => launch(plan) }, t(busy ? 'gmSending' : 'gmLaunch')),
      ),
    );
  }

  return (rows, hosts, now) => {
    const plans = godmodePlansFrom(rows, now);
    const shown = new Set(plans.map(planKey));
    // Drafts of plans that went away (launched, discarded) are dropped.
    for (const key of [...drafts.keys()]) if (!shown.has(key)) drafts.delete(key);
    return plans.map((plan) => {
      const host = hostForMachine(hosts, plan.machine);
      const canRun = Boolean(host && host.godmode);
      const busy = inflight.has(planKey(plan));
      if (plan.state === 'planning') return planningCard(plan);
      if (plan.state === 'failed') return failedCard(plan, busy, canRun);
      return readyCard(plan, busy, canRun);
    });
  };
}
