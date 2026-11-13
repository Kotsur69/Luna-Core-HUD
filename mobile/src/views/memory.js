// ============================================================================
// LunaCore phone - Memory: review a PC's memory inbox (Luna Core Memory)
// ----------------------------------------------------------------------------
// What capture proposed and waits for Mati's decision, with Approve and
// Reject. Both are signed commands to the PC (src/hostmemory.js, through
// hostsend.js: Face ID once per session and host), which runs the same inbox
// functions as the HUD, so the decision syncs to the other PC from there.
// Edit and Make global stay on the PC.
//
//   host picker   PCs whose `host` heartbeat says memory: true (HUD host mode)
//   Show waiting  memory.inbox: the list is fetched on a tap, never on a
//                 background refresh (each fetch is a signed command)
//   offline       the picked PC's heartbeat is stale: it says so, and the
//                 buttons stay off until it is back
//
// Every string from the PC goes in as text (dom.js h()), never as HTML.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { sendHostCommand } from '../hostsend.js';
import { hostList } from '../hostmodel.js';
import { when } from './snapshotview.js';
import { confirmSheet } from './sheet.js';
import { memoryHosts, pickMemoryHost, inboxFrom, decisionPayload, withoutItem, isGone, refusalKey, outcomeOf } from '../memorymodel.js';

const PICK_KEY = 'lunacore.memory.pick';

const readPick = () => {
  try {
    return localStorage.getItem(PICK_KEY) || '';
  } catch {
    return '';
  }
};
const savePick = (m) => {
  try {
    localStorage.setItem(PICK_KEY, m);
  } catch {
    // Private mode: the default host is picked next time.
  }
};

/** A refusal code -> the toast's reason: the phone's own words when it knows the code. */
const reasonText = (code) => {
  const key = refusalKey(code);
  return key ? t(key) : String(code || t('memErr_failed'));
};

/** One signed command -> {ok, result} or {ok: false, code} (memorymodel.outcomeOf). Never throws. */
async function send(cloud, host, kind, payload) {
  try {
    const { status, result } = await sendHostCommand(cloud, host, kind, payload);
    return outcomeOf(status, result);
  } catch (err) {
    return { ok: false, code: err && err.name === 'NotAllowedError' ? 'cancelled' : 'notSent' };
  }
}

function notesOf(item) {
  const tags = [
    item.type ? h('span', { class: 'tag' }, item.type) : null,
    item.usefulness !== null ? h('span', { class: `tag ${item.usefulness >= 70 ? 'is-good' : ''}`.trim() }, tf('memUsefulness', { n: item.usefulness })) : null,
    item.suggestedGlobal ? h('span', { class: 'tag is-warn' }, t('memSuggestedGlobal')) : null,
    item.outside ? h('span', { class: 'tag is-warn' }, tf('memOutside', { n: item.outside })) : null,
    item.duplicates ? h('span', { class: 'tag' }, tf('memDuplicates', { n: item.duplicates })) : null,
  ].filter(Boolean);
  return tags.length ? h('div', { class: 'tags' }, tags) : null;
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountMemory(main, { cloud, toast }) {
  let hosts = [];
  let hostName = readPick();
  /** machine (lower case) -> {items, total} as last fetched. */
  const inboxes = new Map();
  let busy = false;
  let seq = 0;

  const hostSel = h('select', { class: 'field', id: 'mem-host', 'aria-label': t('memHostPick') });
  const hostInfo = h('p', { class: 'hint', role: 'status' });
  const loadBtn = h('button', { class: 'btn btn-primary', type: 'button' }, t('memLoad'));
  const pickCard = h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'mem-title' },
    h('h2', { class: 'section-title', id: 'mem-title' }, t('memTitle')),
    h('label', { class: 'label', for: 'mem-host' }, t('memHostPick')),
    hostSel,
    hostInfo,
    loadBtn,
    h('p', { class: 'hint' }, t('memPcOnly')),
  );
  const listBox = h('div', { class: 'stack' });
  main.replaceChildren(h('div', { class: 'stack' }, pickCard, listBox));

  const currentHost = () => pickMemoryHost(hosts, hostName);
  const canSend = () => {
    const host = currentHost();
    return Boolean(host && host.online && !busy);
  };

  function paintHost() {
    const list = memoryHosts(hosts);
    const host = currentHost();
    hostName = host ? host.machine : hostName;
    hostSel.replaceChildren(...list.map((x) => h('option', { value: x.machine, selected: host && x.machine === host.machine }, `${x.online ? '●' : '○'} ${x.machine}${x.default ? ' ★' : ''}`)));
    hostSel.hidden = list.length < 2;
    if (!hosts.length) hostInfo.textContent = t('hostNone');
    else if (!host) hostInfo.textContent = t('memNoHost');
    else if (!host.online) hostInfo.textContent = tf('memOffline', { machine: host.machine, time: when(host.updatedAt) });
    else hostInfo.textContent = tf('memOnline', { machine: host.machine });
    hostInfo.classList.toggle('is-bad', Boolean(host && !host.online));
    const shown = host ? inboxes.get(host.machine.toLowerCase()) : null;
    loadBtn.textContent = t(busy ? 'memSending' : shown ? 'memReload' : 'memLoad');
    loadBtn.disabled = !canSend();
    loadBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function itemCard(item) {
    const meta = [item.project, item.area, item.created].filter(Boolean).join(' · ');
    const off = !canSend();
    return h(
      'section',
      { class: 'card stack-sm' },
      h('h3', { class: 'section-title' }, item.title),
      h('span', { class: 'hint num' }, meta),
      notesOf(item),
      item.body ? h('p', { class: 'prose mem-body' }, item.body) : null,
      item.clipped ? h('p', { class: 'hint' }, t('memClipped')) : null,
      item.supersedes.length ? h('p', { class: 'hint' }, tf('memReplaces', { titles: item.supersedes.join(', ') })) : null,
      item.similar ? h('p', { class: 'hint is-warn' }, tf('memSimilar', { title: item.similar })) : null,
      item.source ? h('p', { class: 'hint' }, item.source) : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-danger btn-sm', type: 'button', disabled: off, onclick: () => decide(item, 'reject') }, t('memReject')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: off, onclick: () => decide(item, 'approve') }, t('memApprove')),
      ),
    );
  }

  function paintList() {
    const host = currentHost();
    const inbox = host ? inboxes.get(host.machine.toLowerCase()) : null;
    if (!inbox) {
      listBox.replaceChildren();
      return;
    }
    if (!inbox.items.length) {
      // Every listed entry decided, but the PC said more wait than it sent.
      const more = inbox.total > 0;
      listBox.replaceChildren(h('p', { class: more ? 'hint' : 'empty' }, more ? tf('memMoreWaiting', { n: inbox.total }) : t('memEmpty')));
      return;
    }
    const more = inbox.total > inbox.items.length ? h('p', { class: 'hint' }, tf('memShown', { n: inbox.items.length, total: inbox.total })) : null;
    listBox.replaceChildren(...[more, ...inbox.items.map(itemCard)].filter(Boolean));
  }

  function paint() {
    paintHost();
    paintList();
  }

  /** Runs one command with every button locked; the page repaints after. */
  async function locked(fn) {
    if (busy) return;
    busy = true;
    paint();
    try {
      await fn();
    } finally {
      busy = false;
      if (main.isConnected) paint();
    }
  }

  function refusal(code) {
    if (code === 'cancelled') return toast(t('pairCancelled'), true);
    if (code === 'notSent') return toast(t('hostSendFailed'), true);
    return toast(tf('hostRefused', { why: reasonText(code) }), true);
  }

  async function load() {
    const host = currentHost();
    if (!host || !host.online) return;
    await locked(async () => {
      const res = await send(cloud, host.machine, 'memory.inbox', {});
      if (!res.ok) return refusal(res.code);
      inboxes.set(host.machine.toLowerCase(), inboxFrom(res.result));
    });
  }

  async function decide(item, action) {
    const host = currentHost();
    const payload = decisionPayload(item);
    if (!host || !host.online || !payload) return;
    if (action === 'reject') {
      const sure = await confirmSheet({ title: t('memRejectTitle'), text: tf('memRejectText', { title: item.title }), ok: t('memReject'), danger: true });
      if (!sure) return;
      // The heartbeat may have gone stale, or the pick changed, while the sheet was open.
      const still = currentHost();
      if (!still || still.machine !== host.machine || !still.online) return;
    }
    const machine = host.machine.toLowerCase();
    await locked(async () => {
      const res = await send(cloud, host.machine, `memory.${action}`, payload);
      const inbox = inboxes.get(machine);
      if (res.ok) {
        if (inbox) inboxes.set(machine, withoutItem(inbox, item.key));
        toast(t(action === 'approve' ? 'memApproved' : 'memRejected'));
        return;
      }
      // Decided on the PC (or the other phone) meanwhile: it leaves the list here too.
      if (isGone(res.code) && inbox) inboxes.set(machine, withoutItem(inbox, item.key));
      refusal(res.code);
    });
  }

  hostSel.addEventListener('change', () => {
    hostName = hostSel.value;
    savePick(hostName);
    paint();
  });
  loadBtn.addEventListener('click', load);

  /** Pulls the heartbeats only: whether the PC is online. The list itself is fetched on a tap. */
  async function refresh() {
    const mine = ++seq;
    let rows;
    try {
      rows = await cloud.snapshots('host');
    } catch {
      rows = await cloud.cachedSnapshots('host').catch(() => []);
      if (mine === seq) toast(t('pullFailed'), true);
    }
    if (mine !== seq) return;
    hosts = hostList(rows, Date.now());
    paint();
  }

  hostInfo.textContent = t('loading');
  loadBtn.disabled = true;
  return { refresh };
}
