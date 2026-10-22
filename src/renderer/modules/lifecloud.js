// ============================================================================
// LunaCore - Life dashboard: Cloud card (renderer)
// ----------------------------------------------------------------------------
// The cloud sync (src/cloudsync.js) of the budget and the to-dos: who is
// logged in, the last sync, changes not pushed yet, Sync now, Log out, and
// the PCs with rows in the cloud - a retired one can be forgotten (main
// refuses this PC). Main answers from a whitelist (src/cloudipc.js) - no
// token or row data ever gets here, only machine names and last updates.
// ============================================================================

'use strict';

import { t, machineLabel } from './util.js';
import { el, bucket, button, armedButton } from './lifeui.js';

// Main's fixed reason codes (src/cloudipc.js); anything else reads as 'failed'.
const REASONS = new Set([
  'not-configured',
  'logged-out',
  'no-encryption',
  'timeout',
  'denied',
  'pull-failed',
  'push-failed',
  'rate-limited',
  'bad-machine',
  'own-machine',
  'failed',
]);

let busy = null; // 'login' | 'sync' | 'logout' | 'forget' | null
let lastError = null;

const ipcFailed = () => ({ ok: false, reason: 'failed' });
const reasonText = (r) => t(`life.cloud.err.${REASONS.has(r) ? r : 'failed'}`);
const timeText = (ms) => new Date(ms).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

function lines(status) {
  if (!status.configured) return [el('p', 'hint', t('life.cloud.off'))];
  if (!status.loggedIn) return [el('p', 'hint', t(busy === 'login' ? 'life.cloud.waiting' : 'life.cloud.loggedOut'))];
  const out = [
    el('p', 'hint', t('life.cloud.as', { user: status.user || '?' })),
    el('p', 'hint', status.lastSync ? t('life.cloud.last', { time: timeText(status.lastSync) }) : t('life.cloud.never')),
  ];
  if (status.pending) out.push(el('p', 'hint', t('life.cloud.pending', { n: status.pending })));
  if (status.error) out.push(el('p', 'hint is-fail', reasonText(status.error)));
  return out;
}

/** The PCs with rows in the cloud; every other PC gets a Forget button. */
function machineList(res, forget) {
  const wrap = el('div', 'life-cloud__machines');
  wrap.append(el('p', 'hint', t('life.cloud.machines')));
  if (!res || !res.ok) {
    wrap.append(el('p', 'hint is-fail', reasonText(res && res.reason)));
    return wrap;
  }
  if (!res.machines.length) wrap.append(el('p', 'hint', t('life.cloud.machinesNone')));
  for (const m of res.machines) {
    const row = el('div', 'life-form__row');
    const name = machineLabel(m.machine);
    const when = m.updatedAt ? timeText(m.updatedAt) : t('life.cloud.machineNever');
    row.append(el('span', 'hint', t(m.self ? 'life.cloud.machineSelf' : 'life.cloud.machineRow', { name, time: when })));
    if (!m.self) {
      const b = button('life.cloud.forget', () => forget(m.machine, name), 'life-btn mc-danger');
      b.disabled = Boolean(busy);
      row.append(b);
    }
    wrap.append(row);
  }
  return wrap;
}

/** The card; fills itself once main answers. */
export function cloudCard() {
  const card = bucket('life.cloud.title');

  async function run(kind, call) {
    if (busy) return;
    busy = kind;
    lastError = null;
    await refresh();
    const res = await call().catch(ipcFailed);
    busy = null;
    if (!res.ok) lastError = res.reason;
    await refresh();
  }

  function forget(machine, name) {
    if (!confirm(t('life.cloud.forgetConfirm', { name }))) return;
    run('forget', () => window.lunacore.cloudForget(machine));
  }

  function actions(status) {
    const row = el('div', 'life-form__row');
    if (status.configured && !status.loggedIn) {
      row.append(button('life.cloud.login', () => run('login', () => window.lunacore.cloudLogin()), 'pad-send life-btn'));
    }
    if (status.loggedIn) {
      row.append(
        button('life.cloud.syncNow', () => run('sync', () => window.lunacore.cloudSyncNow()), 'pad-send life-btn'),
        armedButton('life.cloud.logout', () => run('logout', () => window.lunacore.cloudLogout())),
      );
    }
    for (const b of row.querySelectorAll('button')) b.disabled = Boolean(busy);
    return row;
  }

  async function refresh() {
    const status = await window.lunacore.cloudStatus().catch(() => null);
    if (!status || !status.ok) {
      card.body.replaceChildren(el('p', 'hint is-fail', reasonText('failed')));
      return;
    }
    const parts = lines(status);
    if (lastError && lastError !== status.error) parts.push(el('p', 'hint is-fail', reasonText(lastError)));
    const extra = [];
    if (status.loggedIn) extra.push(machineList(await window.lunacore.cloudMachines().catch(ipcFailed), forget));
    card.body.replaceChildren(...parts, actions(status), ...extra);
  }

  card.body.append(el('p', 'hint', t('life.cloud.loading')));
  refresh();
  return card.sec;
}
