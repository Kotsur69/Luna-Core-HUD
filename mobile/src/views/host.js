// ============================================================================
// LunaCore phone - Host: drive Claude Code on a host (REMOTE_HOST_PLAN H2-H4)
// ----------------------------------------------------------------------------
//   usage bars (U1) on top
//   host picker   online dot from the heartbeat, star for host:default
//   repo picker   a repo the host hasn't cloned -> Clone (repo.clone)
//   new session   model, mode, "deny after N min", skills/commands picker
//                 inserting "/name", prompt -> chat.start
//   sessions      every host's sessions from host_events (live = heartbeat)
//   chat          host_events of the open session, TEXT ONLY (textContent via
//                 dom.js h(); never innerHTML: this is model output over
//                 untrusted files), approval cards with Allow / Deny / Always,
//                 Send, Stop (chat.interrupt), End, Resume
//
// Every command is signed (hostsend.js -> hostkey.js). The static parts (the
// forms and the text the user is typing) are built once; refresh() repaints
// only what came from the cloud.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { snapRows } from '../snapmodel.js';
import { usageCard } from './usage.js';
import { when } from './snapshotview.js';
import { sendHostCommand } from '../hostsend.js';
import { pushState, enablePush } from '../push.js';
import { MODELS, MODES, TIMEOUTS, hostList, pickHost, cloneUrl, insertName, pickerNames, chatModel, sessionList, sessionRepo } from '../hostmodel.js';

const PICK_KEY = 'lunacore.host.pick';
const MAX_EVENTS = 5000;
const MAX_SESSIONS_SHOWN = 20;

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

const options = (sel, list, current) =>
  sel.replaceChildren(...list.map(([value, label]) => h('option', { value, selected: value === current }, label)));

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountHost(main, { cloud, toast }) {
  let hosts = [];
  let hostName = readPick();
  let sessionsRaw = [];
  let usageRows = [];
  let open = null; // {sessionId, host}
  let eventRows = [];
  let lastSeq = -1;
  let busy = false;
  let seq = 0;

  // ---- static parts ----
  const usageBox = h('div');
  const hostSel = h('select', { class: 'field', id: 'host-pick', 'aria-label': t('hostPick') });
  const hostInfo = h('p', { class: 'hint' });
  const repoSel = h('select', { class: 'field', id: 'host-repo', 'aria-label': t('hostRepo') });
  const cloneBtn = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, t('hostClone'));
  const modelSel = h('select', { class: 'field', 'aria-label': t('hostModel') });
  const modeSel = h('select', { class: 'field', 'aria-label': t('hostMode') });
  const timeoutSel = h('select', { class: 'field', 'aria-label': t('hostTimeout') });
  const pickerSel = h('select', { class: 'field', 'aria-label': t('hostInsert') });
  const prompt = h('textarea', { class: 'field', rows: '4', maxlength: '20000', placeholder: t('hostPrompt'), 'aria-label': t('hostPrompt') });
  const startBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, t('hostStart'));
  const sessionsBox = h('ul', { class: 'rows' });
  const chatTitle = h('h2', { class: 'section-title' });
  const chatLog = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite' });
  const reply = h('textarea', { class: 'field', rows: '3', maxlength: '20000', placeholder: t('hostReply'), 'aria-label': t('hostReply') });
  const replyPicker = h('select', { class: 'field', 'aria-label': t('hostInsert') });
  const sendBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, t('hostSend'));
  const stopBtn = h('button', { class: 'btn btn-sm', type: 'button' }, t('hostStop'));
  const endBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, t('hostEnd'));
  const resumeBtn = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, t('hostResume'));
  const closeBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, t('hostBack'));
  const pushBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, t('pushEnable'));

  options(modelSel, MODELS.map((m) => [m, m === 'opus' ? 'Opus' : 'Sonnet']), 'sonnet');
  options(modeSel, MODES.map((m) => [m, t(`hostMode_${m}`)]), 'default');
  options(timeoutSel, TIMEOUTS.map((n) => [String(n), n ? tf('hostDenyAfter', { n }) : t('hostWaitForever')]), '0');

  const newForm = h(
    'form',
    { class: 'card stack-sm' },
    h('h2', { class: 'section-title' }, t('hostNew')),
    h('label', { class: 'label', for: 'host-pick' }, t('hostPick')),
    hostSel,
    hostInfo,
    h('label', { class: 'label', for: 'host-repo' }, t('hostRepo')),
    h('div', { class: 'row' }, repoSel, cloneBtn),
    h('div', { class: 'row' }, modelSel, modeSel),
    timeoutSel,
    pickerSel,
    prompt,
    startBtn,
  );
  const sessionsCard = h('section', { class: 'card stack-sm' }, h('h2', { class: 'section-title' }, t('hostSessions')), sessionsBox);
  const replyForm = h('form', { class: 'stack-sm' }, replyPicker, reply, h('div', { class: 'row' }, sendBtn, stopBtn, endBtn, resumeBtn));
  const chatCard = h('section', { class: 'card stack-sm', hidden: true }, h('div', { class: 'row' }, chatTitle, closeBtn), chatLog, replyForm);
  const pushCard = h('div', { class: 'row' }, pushBtn);

  main.replaceChildren(h('div', { class: 'stack' }, usageBox, chatCard, newForm, sessionsCard, pushCard));

  const currentHost = () => hosts.find((x) => x.machine === hostName) || null;
  const statusText = (s) => t(`hostStatus_${s}`) || s;

  /** Runs one signed command with the UI locked; returns the handler's result or null. */
  async function run(host, kind, payload) {
    if (busy) return null;
    busy = true;
    [startBtn, sendBtn, stopBtn, endBtn, resumeBtn, cloneBtn].forEach((b) => (b.disabled = true));
    try {
      const { status, result } = await sendHostCommand(cloud, host, kind, payload);
      const verdict = typeof result.status === 'string' ? result.status : status;
      if (status !== 'done' || /^(refused|failed)/.test(verdict)) {
        toast(tf('hostRefused', { why: typeof result.error === 'string' ? result.error : verdict }), true);
        return null;
      }
      return result;
    } catch (err) {
      toast(t(err && err.name === 'NotAllowedError' ? 'pairCancelled' : 'hostSendFailed'), true);
      return null;
    } finally {
      busy = false;
      [startBtn, sendBtn, stopBtn, endBtn, resumeBtn, cloneBtn].forEach((b) => (b.disabled = false));
    }
  }

  function openSession(sessionId, host) {
    if (!open || open.sessionId !== sessionId) {
      eventRows = [];
      lastSeq = -1;
    }
    open = { sessionId, host };
    chatCard.hidden = false;
    refresh();
  }

  // ---- painting ----
  function paintHosts() {
    const pick = pickHost(hosts, hostName);
    hostName = pick ? pick.machine : '';
    options(hostSel, hosts.map((x) => [x.machine, `${x.online ? '●' : '○'} ${x.machine}${x.default ? ' ★' : ''}`]), hostName);
    const host = currentHost();
    hostInfo.textContent = host ? (host.online ? t('hostOnline') : tf('hostSeen', { time: when(host.updatedAt) })) : t('hostNone');
    const repoPick = repoSel.value;
    options(repoSel, (host ? host.repos : []).map((r) => [r.id, r.cloned ? r.name : `${r.name} (${t('hostNotCloned')})`]), repoPick);
    const repo = host && host.repos.find((r) => r.id === repoSel.value);
    cloneBtn.hidden = !repo || repo.cloned || !cloneUrl(repo.key);
    const names = pickerNames(host);
    for (const sel of [pickerSel, replyPicker]) options(sel, [['', t('hostInsert')], ...names.map((n) => [n, `/${n}`])], '');
    startBtn.disabled = !host || !host.online;
  }

  function paintSessions() {
    const list = sessionList(sessionsRaw, hosts).slice(0, MAX_SESSIONS_SHOWN);
    if (!list.length) {
      sessionsBox.replaceChildren(h('li', { class: 'hint' }, t('hostNoSessions')));
      return;
    }
    sessionsBox.replaceChildren(
      ...list.map((s) => {
        const repo = sessionRepo(hosts, s.sessionId);
        return h(
          'li',
          {},
          h(
            'button',
            { class: 'row btn-ghost session-row', type: 'button', onclick: () => openSession(s.sessionId, s.host) },
            h('span', { class: 'grow' }, `${s.host}${repo ? ` · ${repo.name}` : ''}`),
            h('span', { class: s.status === 'error' ? 'tag is-bad' : s.status === 'waiting' ? 'tag is-warn' : s.live ? 'tag is-good' : 'tag' }, statusText(s.status)),
            h('span', { class: 'hint num' }, when(s.at)),
          ),
        );
      }),
    );
  }

  function approvalCard(a) {
    const decide = (decision) => async () => {
      const r = await run(open.host, 'chat.approve', { requestId: a.requestId, decision });
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

  function chatItem(it) {
    if (it.type === 'prompt') return h('p', { class: 'msg msg-me' }, it.text);
    if (it.type === 'text') return h('p', { class: 'msg' }, it.text);
    if (it.type === 'tool') {
      return h(
        'div',
        { class: 'tool' },
        h('span', { class: 'hint mono' }, `● ${it.name}(${it.summary})`),
        it.result ? h('pre', { class: it.result.isError ? 'tool-out is-bad' : 'tool-out' }, it.result.text) : null,
      );
    }
    if (it.type === 'approval') return approvalCard(it);
    if (it.type === 'status') return h('p', { class: it.status === 'error' ? 'hint is-bad' : 'hint is-good' }, `${statusText(it.status)}${it.reason ? ` (${it.reason})` : ''}`);
    if (it.type === 'cost') return h('p', { class: 'hint num' }, `$${it.usd.toFixed(4)}`);
    return null;
  }

  function paintChat() {
    if (!open) {
      chatCard.hidden = true;
      return;
    }
    const model = chatModel(eventRows);
    const live = hosts.some((x) => x.machine === open.host && x.online && x.sessions.some((s) => s.id === open.sessionId));
    chatTitle.textContent = `${open.host} · ${statusText(model.status || 'working')}`;
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.replaceChildren(...model.items.map(chatItem).filter(Boolean));
    if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
    sendBtn.hidden = !live;
    stopBtn.hidden = !live || model.status === 'done';
    endBtn.hidden = !live;
    resumeBtn.hidden = live;
  }

  function paint() {
    usageBox.replaceChildren(usageCard(snapRows(usageRows, Date.now()), Date.now()));
    paintHosts();
    paintSessions();
    paintChat();
    const ps = pushState();
    pushBtn.hidden = ps === 'unsupported' || ps === 'unconfigured' || ps === 'granted';
  }

  // ---- actions ----
  hostSel.addEventListener('change', () => {
    hostName = hostSel.value;
    savePick(hostName);
    paintHosts();
  });
  repoSel.addEventListener('change', paintHosts);

  const insertFrom = (sel, area) => () => {
    if (!sel.value) return;
    const r = insertName(area.value, area.selectionStart, sel.value);
    area.value = r.text;
    area.focus();
    area.setSelectionRange(r.cursor, r.cursor);
    sel.value = '';
  };
  pickerSel.addEventListener('change', insertFrom(pickerSel, prompt));
  replyPicker.addEventListener('change', insertFrom(replyPicker, reply));

  cloneBtn.addEventListener('click', async () => {
    const host = currentHost();
    const repo = host && host.repos.find((r) => r.id === repoSel.value);
    const url = repo && cloneUrl(repo.key);
    if (!url) return;
    const r = await run(host.machine, 'repo.clone', { url });
    if (r) toast(tf('hostCloned', { name: repo.name }));
  });

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = currentHost();
    const text = prompt.value.trim();
    if (!host || !repoSel.value || !text) return toast(t('hostMissing'), true);
    const timeout = Number(timeoutSel.value);
    const r = await run(host.machine, 'chat.start', {
      repoId: repoSel.value,
      prompt: text,
      model: modelSel.value,
      mode: modeSel.value,
      ...(timeout ? { approvalTimeout: timeout } : {}),
    });
    if (r && typeof r.sessionId === 'string') {
      prompt.value = '';
      openSession(r.sessionId, host.machine);
    }
  });

  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = reply.value.trim();
    if (!open || !text) return;
    const r = await run(open.host, 'chat.send', { sessionId: open.sessionId, text });
    if (r) {
      reply.value = '';
      refresh();
    }
  });
  stopBtn.addEventListener('click', async () => {
    if (open && (await run(open.host, 'chat.interrupt', { sessionId: open.sessionId }))) refresh();
  });
  endBtn.addEventListener('click', async () => {
    if (open && confirm(t('hostEndConfirm')) && (await run(open.host, 'chat.end', { sessionId: open.sessionId }))) refresh();
  });
  resumeBtn.addEventListener('click', async () => {
    const text = reply.value.trim();
    if (!open) return;
    const r = await run(open.host, 'chat.resume', { sessionId: open.sessionId, ...(text ? { prompt: text } : {}) });
    if (r) {
      reply.value = '';
      refresh();
    }
  });
  closeBtn.addEventListener('click', () => {
    open = null;
    paintChat();
  });
  pushBtn.addEventListener('click', async () => {
    try {
      const state = await enablePush(cloud);
      toast(t(state === 'granted' ? 'pushOn' : 'pushDenied'), state !== 'granted');
    } catch {
      toast(t('pushFailed'), true);
    }
    paint();
  });

  // ---- data ----
  async function refresh() {
    const mine = ++seq;
    const [hostRows, uRows, sRows] = await Promise.allSettled([cloud.snapshots('host'), cloud.snapshots('usage'), cloud.hostSessions()]);
    let events = null;
    if (open) events = await cloud.hostEvents(open.sessionId, lastSeq).catch(() => null);
    if (mine !== seq) return;
    if (hostRows.status === 'fulfilled') hosts = hostList(hostRows.value, Date.now());
    else hosts = hostList(await cloud.cachedSnapshots('host').catch(() => []), Date.now());
    if (uRows.status === 'fulfilled') usageRows = uRows.value;
    if (sRows.status === 'fulfilled') sessionsRaw = sRows.value;
    if (events && events.length) {
      eventRows = eventRows.concat(events).slice(-MAX_EVENTS);
      lastSeq = Math.max(lastSeq, ...events.map((r) => (Number.isInteger(r.seq) ? r.seq : -1)));
    }
    if (hostRows.status !== 'fulfilled') toast(t('pullFailed'), true);
    paint();
  }

  usageBox.replaceChildren(h('p', { class: 'hint' }, t('loading')));
  return { refresh };
}
