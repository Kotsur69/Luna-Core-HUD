// ============================================================================
// LunaCore phone - Host: drive Claude Code on a host (REMOTE_HOST_PLAN H2-H4)
// ----------------------------------------------------------------------------
//   usage bars (U1) on top
//   host picker   online dot from the heartbeat, star for host:default
//   repo picker   a repo the host hasn't cloned -> Clone (repo.clone)
//   new session   model, mode, "deny after N min", skills/commands picker
//                 inserting "/name", prompt -> chat.start
//   all sessions  collapsed list of every host's sessions (live = heartbeat);
//                 the running ones are also in the menu (shell.js)
//
// A session opens as its own page, #chat/<host>/<id> (views/chat.js).
//
// Every command is signed (hostrun.js -> hostsend.js). The static parts (the
// forms and the text the user is typing) are built once; refresh() repaints
// only what came from the cloud.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { snapRows } from '../snapmodel.js';
import { usageCard } from './usage.js';
import { when } from './snapshotview.js';
import { createRunner } from './hostrun.js';
import { pushState, enablePush } from '../push.js';
import { rememberLabel, readLabels } from '../sessionlabels.js';
import { MODELS, MODES, TIMEOUTS, hostList, pickHost, cloneUrl, insertName, pickerNames, sessionList, sessionRepo, sessionLight, chatHash } from '../hostmodel.js';

const PICK_KEY = 'lunacore.host.pick';
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
  const sessionsCard = h('details', { class: 'card stack-sm' }, h('summary', { class: 'section-title' }, t('hostAllSessions')), sessionsBox);
  const pushCard = h('div', { class: 'row' }, pushBtn);

  main.replaceChildren(h('div', { class: 'stack' }, usageBox, newForm, sessionsCard, pushCard));

  const currentHost = () => hosts.find((x) => x.machine === hostName) || null;
  const statusText = (s) => t(`hostStatus_${s}`) || s;
  const lockables = [startBtn, cloneBtn];
  const run = createRunner({ cloud, toast, onBusy: (b) => lockables.forEach((x) => (x.disabled = b)) });

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
    options(pickerSel, [['', t('hostInsert')], ...pickerNames(host).map((n) => [n, `/${n}`])], '');
    startBtn.disabled = !host || !host.online;
  }

  function paintSessions() {
    const list = sessionList(sessionsRaw, hosts).slice(0, MAX_SESSIONS_SHOWN);
    if (!list.length) {
      sessionsBox.replaceChildren(h('li', { class: 'hint' }, t('hostNoSessions')));
      return;
    }
    const labels = readLabels();
    sessionsBox.replaceChildren(
      ...list.map((s) => {
        const repo = sessionRepo(hosts, s.sessionId);
        const name = (repo && repo.name) || labels[s.sessionId] || '';
        return h(
          'li',
          {},
          h(
            'a',
            { class: 'row session-row', href: chatHash(s.host, s.sessionId) },
            h('span', { class: `light ${sessionLight(s)}`, 'aria-hidden': 'true' }, '●'),
            h('span', { class: 'grow' }, name ? `${name} · ${s.host}` : s.host),
            h('span', { class: 'hint' }, statusText(s.status)),
            h('span', { class: 'hint num' }, when(s.at)),
          ),
        );
      }),
    );
  }

  function paint() {
    usageBox.replaceChildren(usageCard(snapRows(usageRows, Date.now()), Date.now()));
    paintHosts();
    paintSessions();
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

  pickerSel.addEventListener('change', () => {
    if (!pickerSel.value) return;
    const r = insertName(prompt.value, prompt.selectionStart, pickerSel.value);
    prompt.value = r.text;
    prompt.focus();
    prompt.setSelectionRange(r.cursor, r.cursor);
    pickerSel.value = '';
  });

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
    const repo = host.repos.find((r) => r.id === repoSel.value);
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
      if (repo) rememberLabel(r.sessionId, repo.name);
      // Left the page during the signed round-trip: the menu has the session, no jump.
      if (main.isConnected) location.hash = chatHash(host.machine, r.sessionId);
    }
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
    if (mine !== seq) return;
    if (hostRows.status === 'fulfilled') hosts = hostList(hostRows.value, Date.now());
    else hosts = hostList(await cloud.cachedSnapshots('host').catch(() => []), Date.now());
    if (uRows.status === 'fulfilled') usageRows = uRows.value;
    if (sRows.status === 'fulfilled') sessionsRaw = sRows.value;
    if (hostRows.status !== 'fulfilled') toast(t('pullFailed'), true);
    paint();
  }

  usageBox.replaceChildren(h('p', { class: 'hint' }, t('loading')));
  return { refresh };
}
