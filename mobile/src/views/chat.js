// ============================================================================
// LunaCore phone - one host session as a full-screen chat (#chat/<host>/<id>)
// ----------------------------------------------------------------------------
// Messenger layout: your prompts right, Claude left, tool calls as small rows
// that expand to their output, approval cards inline, system lines centered,
// a composer pinned to the bottom ([end] [/] [message] [stop] [send]).
// The session's name and status go into the shell's top bar (setHeader).
//
// TEXT ONLY: every string is model output over untrusted files and goes in
// through dom.js h() as a text node, never innerHTML. Every command is signed
// (hostrun.js -> hostsend.js). An approval carries the exact card shown; the
// host refuses anything else.
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t } from '../i18n.js';
import { createRunner } from './hostrun.js';
import { rememberLabel, readLabels } from '../sessionlabels.js';
import { hostList, chatModel, sessionRepo, pickerNames, insertName, sessionLight } from '../hostmodel.js';

const MAX_EVENTS = 5000;
/** cloud.js EVENTS_PAGE: a full page means more rows wait. */
const EVENTS_PAGE = 500;
const MAX_PAGES_PER_PULL = 10;
const NEAR_BOTTOM_PX = 80;
const MAX_COMPOSER_PX = 160;

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: Function, route: {host: string, sessionId: string},
 *   setHeader: (h: {title: string, sub: string, light: string}) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountChat(main, { cloud, toast, route, setHeader }) {
  const { host: machine, sessionId } = route;
  let hosts = [];
  let eventRows = [];
  let lastSeq = -1;
  let seq = 0;
  let painted = false;
  let hostsKnown = false; // false until a host pull (or cache) answered: live is unknown
  let foreign = false; // a row of this session came from another host than the URL names
  let slashKey = null;
  const openTools = new Set(); // indices of expanded tool rows, kept across repaints
  // main.js mounts every page into a fresh node and drops the old one: a late
  // pull of a page left behind must not touch the shared header or toast.
  const alive = () => main.isConnected;

  // No aria-live: the log is rebuilt on every pull and would be re-read whole.
  const log = h('div', { class: 'chat-log', role: 'region', 'aria-label': t('chatLog') });
  const endBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('hostEnd') }, icon(ICONS.power));
  const slashSel = h('select', { class: 'slash-pick', 'aria-label': t('hostInsert') });
  const slash = h('span', { class: 'icon-btn slash' }, icon(ICONS.slash), slashSel);
  const input = h('textarea', { class: 'composer-input', rows: '1', maxlength: '20000', placeholder: t('hostReply'), 'aria-label': t('hostReply') });
  const stopBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('hostStop') }, icon(ICONS.stop));
  const sendBtn = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': t('hostSend') }, icon(ICONS.send));
  const composer = h('form', { class: 'composer' }, endBtn, slash, input, stopBtn, sendBtn);
  main.replaceChildren(h('div', { class: 'chat-page' }, log, composer));

  const buttons = [endBtn, stopBtn, sendBtn];
  const run = createRunner({ cloud, toast, onBusy: (b) => buttons.forEach((x) => (x.disabled = b)) });

  const isLive = () => hosts.some((x) => x.machine === machine && x.online && x.sessions.some((s) => s.id === sessionId));
  const statusText = (s) => t(`hostStatus_${s}`) || s;

  // ---- items ----
  function approvalCard(a) {
    const decide = (decision) => async () => {
      const r = await run(machine, 'chat.approve', { requestId: a.requestId, decision, card: { tool: a.tool, summary: a.summary, preview: a.preview } });
      if (r) refresh();
    };
    return h(
      'div',
      { class: 'approval' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `${t('hostApproval')}: ${a.tool}`), a.decision ? h('span', { class: 'tag' }, t(`hostDecision_${a.decision}`)) : null),
      a.summary ? h('code', { class: 'mono' }, a.summary) : null,
      a.preview ? h('pre', { class: 'diff' }, a.preview) : null,
      a.decision
        ? null
        : h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: decide('allow') }, t('hostAllow')),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: decide('deny') }, t('hostDeny')),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: decide('always') }, t('hostAlways')),
          ),
    );
  }

  function toolRow(it, i) {
    const head = h('span', { class: 'tool-head' }, h('span', { class: 'tool-name' }, it.name), h('span', { class: 'tool-sum' }, it.summary));
    if (!it.result) return h('div', { class: 'tool-row is-pending' }, head);
    const row = h(
      'details',
      { class: it.result.isError ? 'tool-row is-bad' : 'tool-row', open: openTools.has(i) },
      h('summary', {}, head),
      h('pre', { class: 'tool-out' }, it.result.text),
    );
    row.addEventListener('toggle', () => (row.open ? openTools.add(i) : openTools.delete(i)));
    return row;
  }

  function chatItem(it, i) {
    if (it.type === 'prompt') return h('p', { class: 'bubble bubble-me' }, it.text);
    if (it.type === 'text') return h('p', { class: 'bubble' }, it.text);
    if (it.type === 'tool') return toolRow(it, i);
    if (it.type === 'approval') return approvalCard(it);
    if (it.type === 'status') return h('p', { class: it.status === 'error' ? 'sys is-bad' : 'sys' }, `${statusText(it.status)}${it.reason ? ` (${it.reason})` : ''}`);
    if (it.type === 'cost') return h('p', { class: 'sys num' }, `$${it.usd.toFixed(4)}`);
    return null;
  }

  // ---- painting ----
  function paint() {
    if (!alive()) return;
    const model = chatModel(eventRows);
    const live = isLive();
    const repo = sessionRepo(hosts, sessionId);
    if (repo) rememberLabel(sessionId, repo.name);
    const name = (repo && repo.name) || readLabels()[sessionId] || machine;
    const status = model.status || (live ? 'working' : 'done');
    const state = !hostsKnown ? t('loading') : live ? statusText(status) : t('chatEnded');
    setHeader({ title: name, sub: `${machine} · ${state}`, light: hostsKnown ? sessionLight({ status, live }) : '' });

    const stick = !painted || nearBottom();
    const items = foreign ? [h('p', { class: 'sys is-bad' }, t('chatForeign'))] : model.items.map(chatItem).filter(Boolean);
    log.replaceChildren(...(items.length ? items : [h('p', { class: 'sys' }, t('loading'))]));
    if (stick) toBottom();
    painted = true;

    const host = hosts.find((x) => x.machine === machine) || null;
    const names = pickerNames(host);
    // Rebuilt only when the list changes: an open native picker survives a pull.
    if (names.join('\n') !== slashKey) {
      slashKey = names.join('\n');
      slashSel.replaceChildren(h('option', { value: '' }, t('hostInsert')), ...names.map((n) => h('option', { value: n }, `/${n}`)));
    }
    slash.hidden = !names.length;
    composer.hidden = foreign;
    sendBtn.disabled = !hostsKnown;
    endBtn.hidden = !live;
    stopBtn.hidden = !live || status === 'done';
    sendBtn.setAttribute('aria-label', t(live ? 'hostSend' : 'hostResume'));
    input.placeholder = t(live ? 'hostReply' : 'chatResumeHint');
  }

  // ---- actions ----
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, MAX_COMPOSER_PX)}px`;
  };
  input.addEventListener('input', grow);
  slashSel.addEventListener('change', () => {
    if (!slashSel.value) return;
    const r = insertName(input.value, input.selectionStart, slashSel.value);
    input.value = r.text;
    slashSel.value = '';
    input.focus();
    input.setSelectionRange(r.cursor, r.cursor);
    grow();
  });

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const live = isLive();
    if (!hostsKnown || foreign || (live && !text)) return;
    const r = live
      ? await run(machine, 'chat.send', { sessionId, text })
      : await run(machine, 'chat.resume', { sessionId, ...(text ? { prompt: text } : {}) });
    if (!r) return;
    input.value = '';
    grow();
    toBottom();
    refresh();
  });
  stopBtn.addEventListener('click', async () => {
    if (await run(machine, 'chat.interrupt', { sessionId })) refresh();
  });
  endBtn.addEventListener('click', async () => {
    if (confirm(t('hostEndConfirm')) && (await run(machine, 'chat.end', { sessionId }))) refresh();
  });

  // ---- data ----
  /** Every event after `after`, page by page (a long session has more than one). */
  async function pullEvents(after) {
    let rows = [];
    let from = after;
    for (let i = 0; i < MAX_PAGES_PER_PULL; i += 1) {
      const page = await cloud.hostEvents(sessionId, from);
      rows = rows.concat(page);
      if (page.length < EVENTS_PAGE) break;
      from = Math.max(from, ...page.map((r) => (Number.isInteger(r.seq) ? r.seq : -1)));
    }
    return rows;
  }

  async function refresh() {
    const mine = ++seq;
    const [hostRows, events] = await Promise.allSettled([cloud.snapshots('host'), pullEvents(lastSeq)]);
    if (mine !== seq || !alive()) return;
    let cached = null;
    if (hostRows.status !== 'fulfilled') {
      cached = await cloud.cachedSnapshots('host').catch(() => []);
      if (mine !== seq || !alive()) return; // a newer pull started meanwhile; it owns the rows
    }
    hosts = hostList(hostRows.status === 'fulfilled' ? hostRows.value : cached, Date.now());
    hostsKnown = hostsKnown || hostRows.status === 'fulfilled' || hosts.length > 0;
    if (events.status === 'fulfilled') {
      // Only rows past what is shown: an overlapping pull never doubles a bubble.
      const fresh = events.value.filter((r) => Number.isInteger(r.seq) && r.seq > lastSeq);
      if (fresh.some((r) => r.host !== machine)) foreign = true;
      if (fresh.length) {
        eventRows = eventRows.concat(fresh).slice(-MAX_EVENTS);
        lastSeq = Math.max(lastSeq, ...fresh.map((r) => r.seq));
      }
    }
    if (hostRows.status !== 'fulfilled' || events.status !== 'fulfilled') toast(t('pullFailed'), true);
    paint();
  }

  return { refresh };
}
