// ============================================================================
// LunaCore phone - Memory: review a PC's memory inbox (Luna Core Memory)
// ----------------------------------------------------------------------------
// What capture proposed and waits for Mati's decision, with Approve and
// Reject. Both are signed commands to the PC (src/hostmemory.js, through
// hostsend.js: Face ID once per session and host), which runs the same inbox
// functions as the HUD, so the decision syncs to the other PC from there.
// Edit and Make global stay on the PC.
//
//   Reject        a sheet with quick reason chips (too vague, duplicate, ...);
//                 the chosen slug travels as memory.reject's optional reason
//   swipe         on an inbox card: right approves, left opens the reject
//                 sheet. A drag must be long and mostly horizontal
//                 (memorymodel.swipeIntent), so vertical scrolling still works
//   Search        memory.search: titles, trust labels and snippets of confirmed
//                 memories, fetched on a tap like the inbox
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
import {
  memoryHosts,
  pickMemoryHost,
  inboxFrom,
  decisionPayload,
  rejectPayload,
  searchPayload,
  searchFrom,
  swipeIntent,
  REJECT_REASONS,
  MAX_QUERY,
  withoutItem,
  isGone,
  refusalKey,
  outcomeOf,
} from '../memorymodel.js';

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

/** A drag moves the card only this far (px), as a hint of the swipe. */
const MAX_DRAG_PX = 120;
/** A finger must move this far (px) before the card follows it. */
const DRAG_START_PX = 12;

/**
 * Reject confirmation with reason chips. A chip toggles; the answer is
 * {reason} (null when none picked) or null when cancelled. Text only.
 * @returns {Promise<{reason: string|null}|null>}
 */
function rejectSheet(item) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    let picked = null;
    let root = null;
    const close = (answer) => {
      document.removeEventListener('keydown', onKey);
      root.remove();
      if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const chips = REJECT_REASONS.map((reason) =>
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          'aria-pressed': 'false',
          onclick: (e) => {
            picked = picked === reason ? null : reason;
            for (const c of chips) c.setAttribute('aria-pressed', c === e.currentTarget && picked ? 'true' : 'false');
            for (const c of chips) c.classList.toggle('btn-primary', c.getAttribute('aria-pressed') === 'true');
          },
        },
        t(`memWhy_${reason.replace(/-/g, '_')}`),
      ),
    );
    const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(null) }, t('cancel'));
    const okBtn = h('button', { class: 'btn btn-danger', type: 'button', onclick: () => close({ reason: picked }) }, t('memReject'));
    root = h(
      'div',
      { class: 'sheet-wrap' },
      h('div', { class: 'sheet-scrim', onclick: () => close(null) }),
      h(
        'div',
        { class: 'sheet stack-sm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title', 'aria-describedby': 'sheet-text' },
        h('h2', { class: 'section-title', id: 'sheet-title' }, t('memRejectTitle')),
        h('p', { class: 'hint', id: 'sheet-text' }, tf('memRejectText', { title: item.title })),
        h('p', { class: 'label' }, t('memRejectWhy')),
        h('div', { class: 'row', role: 'group', 'aria-label': t('memRejectWhy') }, chips),
        h('div', { class: 'sheet-actions' }, cancelBtn, okBtn),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(root);
    cancelBtn.focus();
  });
}

/**
 * Horizontal swipe on a card: right approves, left rejects. touch-action
 * pan-y leaves vertical scrolling to the browser (it then sends pointercancel).
 */
function attachDecisionSwipe(card, onIntent) {
  let start = null;
  const reset = () => {
    start = null;
    card.style.transform = '';
  };
  card.style.touchAction = 'pan-y';
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button, a, input, select')) return;
    start = { x: e.clientX, y: e.clientY };
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > DRAG_START_PX && Math.abs(dx) > Math.abs(dy) * 2) {
      card.style.transform = `translateX(${Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, dx))}px)`;
    }
  });
  card.addEventListener('pointerup', (e) => {
    const from = start;
    reset();
    if (!from) return;
    const intent = swipeIntent(e.clientX - from.x, e.clientY - from.y);
    if (intent) onIntent(intent);
  });
  card.addEventListener('pointercancel', reset);
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
  const searchInput = h('input', { class: 'field', id: 'mem-q', type: 'search', maxlength: MAX_QUERY, autocomplete: 'off', 'aria-label': t('memSearchLabel'), placeholder: t('memSearchLabel') });
  const searchBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, t('memSearchGo'));
  const searchBox = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  /** machine (lower case) -> {query, hits} of the last search; null until one ran. */
  const searches = new Map();
  const searchForm = h(
    'form',
    { class: 'card stack-sm', 'aria-labelledby': 'mem-search-title', novalidate: true },
    h('h2', { class: 'section-title', id: 'mem-search-title' }, t('memSearchTitle')),
    h('label', { class: 'label', for: 'mem-q' }, t('memSearchLabel')),
    h('div', { class: 'row' }, searchInput, searchBtn),
    h('p', { class: 'hint' }, t('memSearchHint')),
    searchBox,
  );
  main.replaceChildren(h('div', { class: 'stack' }, pickCard, searchForm, listBox));

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
    searchBtn.disabled = !canSend();
    paintSearch();
  }

  function paintSearch() {
    const host = currentHost();
    const last = host ? searches.get(host.machine.toLowerCase()) : null;
    if (!last) {
      searchBox.replaceChildren();
      return;
    }
    if (!last.hits.length) {
      searchBox.replaceChildren(h('p', { class: 'empty' }, t('memSearchNone')));
      return;
    }
    searchBox.replaceChildren(
      ...last.hits.map((hit) =>
        h(
          'article',
          { class: 'stack-sm' },
          h('h3', { class: 'section-title' }, hit.title),
          h('span', { class: 'hint num' }, [hit.project, hit.type, hit.trust].filter(Boolean).join(' · ')),
          hit.unreviewed ? h('p', { class: 'hint is-warn' }, t('memSearchUnreviewed')) : hit.snippet ? h('p', { class: 'prose mem-body' }, hit.snippet) : null,
          hit.source ? h('p', { class: 'hint' }, hit.source) : null,
        ),
      ),
    );
  }

  async function search() {
    const host = currentHost();
    const payload = searchPayload(searchInput.value);
    if (!host || !host.online || !payload) return;
    await locked(async () => {
      const res = await send(cloud, host.machine, 'memory.search', payload);
      if (!res.ok) return refusal(res.code);
      searches.set(host.machine.toLowerCase(), { query: payload.query, hits: searchFrom(res.result) });
    });
  }

  function itemCard(item) {
    const meta = [item.project, item.area, item.created].filter(Boolean).join(' · ');
    const off = !canSend();
    const card = h(
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
      item.originSessionId ? h('p', { class: 'hint num' }, tf('memOrigin', { id: item.originSessionId })) : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-danger btn-sm', type: 'button', disabled: off, onclick: () => decide(item, 'reject') }, t('memReject')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: off, onclick: () => decide(item, 'approve') }, t('memApprove')),
      ),
    );
    // The same guard as the buttons: a swipe does nothing while a command runs or the PC is offline.
    attachDecisionSwipe(card, (intent) => {
      if (canSend()) decide(item, intent);
    });
    return card;
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
    listBox.replaceChildren(...[h('p', { class: 'hint' }, t('memSwipeHint')), more, ...inbox.items.map(itemCard)].filter(Boolean));
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
    let reason = null;
    if (action === 'reject') {
      const sure = await rejectSheet(item);
      if (!sure) return;
      reason = sure.reason;
      // The heartbeat may have gone stale, or the pick changed, while the sheet was open.
      const still = currentHost();
      if (!still || still.machine !== host.machine || !still.online) return;
    }
    const machine = host.machine.toLowerCase();
    await locked(async () => {
      const res = await send(cloud, host.machine, `memory.${action}`, action === 'reject' ? rejectPayload(item, reason) : payload);
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
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });

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
