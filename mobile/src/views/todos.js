// ============================================================================
// LunaCore phone - to-do lists (plan phase 4a)
// ----------------------------------------------------------------------------
// One list at a time, picked from the projects the PCs have synced. Every
// action is one cloud unit (todomodel.js); the screen re-renders from the
// mirror the write's pull returns: what the server holds, plus this phone's
// writes still waiting to be sent (phase 4d).
// Phone God Mode B: 'Start God Mode' picks open cards of the list (manual
// ones disabled) and a PC whose `host` heartbeat says godmode: true, then
// sends the signed godmode.plan (godmodestart.js, hostrun.js) and opens the
// God Mode page, where the plan shows up.
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf } from '../i18n.js';
import { lists, addUnit, toggleUnit, toggleManualUnit, toggleTagUnit, hasTag, deleteUnit, STEER_TAG } from '../todomodel.js';
import { PICK_KEY } from '../cloud.js';
import { hostList } from '../hostmodel.js';
import { godmodeHosts, pickGodmodeHost, projectIdFor, pickableCards, defaultSelection, toggleSelection, planPayload } from '../godmodestart.js';
import { createRunners } from './hostrun.js';

const SCOPE = 'todos';

function remembered() {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}

function remember(key) {
  try {
    localStorage.setItem(PICK_KEY, key);
  } catch {
    // Private mode: the pick just isn't kept.
  }
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: ReturnType<import('../cloud.js').createCloud>, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountTodos(main, { cloud, toast }) {
  let picked = remembered();
  let busy = false;
  // Phone God Mode B: the hosts' heartbeats, the select mode and its picks.
  let hosts = [];
  let gmHost = '';
  let selecting = false;
  let selected = [];
  let gmSending = false;
  let lastMirror = null;
  const runnerFor = createRunners({ cloud, toast });
  // Kept outside the DOM: a refresh re-renders the screen while Mati types.
  let draft = '';
  // The add form's Steer toggle: the next card goes out tagged `steer`.
  let steerDraft = false;

  async function act(unit) {
    if (!unit || busy) return false;
    busy = true;
    try {
      const s = await cloud.write(SCOPE, unit);
      render(s.mirror);
      if (s.queued) toast(t('savedOffline'));
      return true;
    } catch {
      toast(t('saveFailed'), true);
      return false;
    } finally {
      busy = false;
    }
  }

  function itemRow(key, item) {
    const del = () => {
      if (confirm(t('confirmDelete'))) act(deleteUnit(key, item));
    };
    const manual = item.manual === true;
    const steer = hasTag(item, STEER_TAG);
    const tagChips = (item.tags || []).map((tag) =>
      tag === STEER_TAG ? h('span', { class: 'todo-chip is-steer' }, t('steer')) : h('span', { class: 'todo-chip is-tag' }, `#${tag}`),
    );
    return h(
      'li',
      { class: `todo${item.done ? ' is-done' : ''}${manual ? ' is-manual' : ''}${steer ? ' is-steer' : ''}` },
      h(
        'button',
        { class: 'todo-check', role: 'checkbox', 'aria-checked': String(item.done), onclick: () => act(toggleUnit(key, item)) },
        h('span', { class: 'box' }, item.done ? icon(ICONS.check) : null),
        h('span', { class: 'todo-text' }, item.text),
        manual ? h('span', { class: 'todo-chip' }, t('manual')) : null,
        ...tagChips,
      ),
      h(
        'button',
        {
          class: 'icon-btn todo-steer-btn',
          'aria-pressed': String(steer),
          'aria-label': `${t(steer ? 'steerOff' : 'steerOn')}: ${item.text}`,
          onclick: () => act(toggleTagUnit(key, item, STEER_TAG)),
        },
        '🧭',
      ),
      h(
        'button',
        {
          class: 'icon-btn todo-manual-btn',
          'aria-pressed': String(manual),
          'aria-label': `${t(manual ? 'manualOff' : 'manualOn')}: ${item.text}`,
          onclick: () => act(toggleManualUnit(key, item)),
        },
        '✋',
      ),
      h('button', { class: 'icon-btn', 'aria-label': `${t('delete')}: ${item.text}`, onclick: del }, icon(ICONS.trash)),
    );
  }

  function picker(all, mirror) {
    const select = h(
      'select',
      { class: 'field', id: 'todo-list' },
      all.map((l) => h('option', { value: l.key, selected: l.key === picked }, `${l.name} (${l.items.filter((i) => !i.done).length})`)),
    );
    select.addEventListener('change', () => {
      picked = select.value;
      remember(picked);
      // A pick belongs to one list.
      selecting = false;
      render(mirror);
    });
    return h('div', {}, h('label', { class: 'label', for: 'todo-list' }, t('project')), select);
  }

  function addForm() {
    const input = h('input', {
      class: 'field',
      id: 'todo-new',
      type: 'text',
      enterkeyhint: 'done',
      autocomplete: 'off',
      maxlength: 1000,
      'aria-label': t('newTodo'),
      placeholder: t('newTodo'),
    });
    input.value = draft;
    input.addEventListener('input', () => {
      draft = input.value;
    });
    const steerBtn = h(
      'button',
      {
        class: 'icon-btn todo-steer-btn',
        type: 'button',
        'aria-pressed': String(steerDraft),
        'aria-label': t(steerDraft ? 'steerNewOff' : 'steerNewOn'),
        title: t(steerDraft ? 'steerNewOff' : 'steerNewOn'),
        onclick: () => {
          steerDraft = !steerDraft;
          steerBtn.setAttribute('aria-pressed', String(steerDraft));
          steerBtn.setAttribute('aria-label', t(steerDraft ? 'steerNewOff' : 'steerNewOn'));
          steerBtn.title = t(steerDraft ? 'steerNewOff' : 'steerNewOn');
        },
      },
      '🧭',
    );
    const form = h(
      'form',
      { class: 'add-row' },
      input,
      steerBtn,
      h('button', { class: 'btn', type: 'submit', 'aria-label': t('add') }, icon(ICONS.plus)),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const unit = addUnit(picked, draft, Date.now(), steerDraft ? [STEER_TAG] : []);
      if (!unit) return;
      const sent = draft;
      if (await act(unit)) {
        if (draft === sent) {
          draft = '';
          steerDraft = false;
        }
        const field = document.getElementById('todo-new');
        if (field) {
          field.value = draft;
          field.focus();
        }
      }
    });
    return form;
  }

  const rerender = () => {
    if (lastMirror) render(lastMirror);
  };

  async function startGodmode(host, payload) {
    if (gmSending) return;
    gmSending = true;
    rerender();
    try {
      const res = await runnerFor(host.machine).run('godmode.plan', payload);
      if (res && res.status === 'planning') {
        selecting = false;
        toast(tf('gmPlanningToast', { host: host.machine }));
        location.hash = 'godmode';
      }
    } finally {
      gmSending = false;
      rerender();
    }
  }

  /** The God Mode start: a button, the select mode, or the hint when no PC can run it. */
  function godmodeSection(list) {
    const able = godmodeHosts(hosts);
    if (!able.length) return h('p', { class: 'hint' }, t('gmNoHost'));
    if (!selecting) {
      return h(
        'button',
        {
          class: 'btn btn-sm gm-start',
          type: 'button',
          onclick: () => {
            selecting = true;
            selected = defaultSelection(pickableCards(list.items));
            rerender();
          },
        },
        t('gmStart'),
      );
    }
    const host = pickGodmodeHost(hosts, gmHost);
    gmHost = host.machine;
    const cards = pickableCards(list.items);
    // Cards that went away (done, deleted, made manual) drop out of the pick.
    selected = selected.filter((at) => cards.some((c) => c.at === at && !c.disabled));
    const projectId = projectIdFor(host, list.key);
    const payload = planPayload(projectId, selected, cards);
    const hostSel = h('select', { class: 'field', id: 'gm-host', disabled: gmSending }, able.map((x) => h('option', { value: x.machine, selected: x.machine === gmHost }, `${x.online ? '●' : '○'} ${x.machine}${x.default ? ' ★' : ''}`)));
    hostSel.addEventListener('change', () => {
      gmHost = hostSel.value;
      rerender();
    });
    const cardRow = (c) => {
      const id = `gm-card-${c.at}`;
      const box = h('input', { type: 'checkbox', id, checked: selected.includes(c.at), disabled: c.disabled || gmSending });
      box.addEventListener('change', () => {
        selected = toggleSelection(selected, c.at, cards);
        rerender();
      });
      return h('li', {}, h('label', { class: `gm-check${c.disabled ? ' is-disabled' : ''}`, for: id }, box, h('span', { class: 'gm-check-text' }, h('span', {}, c.text), c.manual ? h('span', { class: 'hint' }, t('gmManualOut')) : null)));
    };
    return h(
      'section',
      { class: 'card stack-sm', 'aria-labelledby': 'gm-start-title' },
      h('h2', { class: 'section-title', id: 'gm-start-title' }, t('gmStartTitle')),
      h('label', { class: 'label', for: 'gm-host' }, t('gmHost')),
      hostSel,
      projectId ? null : h('p', { class: 'hint is-warn' }, tf('gmNoProject', { host: host.machine })),
      cards.length ? h('ul', { class: 'rows' }, cards.map(cardRow)) : h('p', { class: 'hint' }, t('emptyItems')),
      h('span', { class: 'hint' }, tf('gmPicked', { n: payload ? payload.todoAts.length : 0, total: cards.filter((c) => !c.disabled).length })),
      h(
        'div',
        { class: 'row gm-actions' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: gmSending, onclick: () => { selecting = false; rerender(); } }, t('cancel')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: !payload || gmSending, 'aria-busy': gmSending ? 'true' : null, onclick: () => payload && startGodmode(host, payload) }, t(gmSending ? 'gmSending' : 'gmStartPlan')),
      ),
    );
  }

  function render(mirror) {
    lastMirror = mirror;
    const all = lists(mirror);
    if (!all.length) {
      main.replaceChildren(h('p', { class: 'empty' }, t('emptyLists')));
      return;
    }
    if (!all.some((l) => l.key === picked)) picked = all[0].key;
    const list = all.find((l) => l.key === picked);
    const open = list.items.filter((i) => !i.done);
    const done = list.items.filter((i) => i.done);
    const typing = document.activeElement?.id === 'todo-new';
    main.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        picker(all, mirror),
        godmodeSection(list),
        selecting ? null : addForm(),
        selecting ? null : open.length ? h('ul', { class: 'todos' }, open.map((i) => itemRow(picked, i))) : h('p', { class: 'empty' }, t('emptyItems')),
        done.length ? h('h2', { class: 'section-title' }, `${t('done')} · ${done.length}`) : null,
        done.length ? h('ul', { class: 'todos' }, done.map((i) => itemRow(picked, i))) : null,
      ),
    );
    if (typing) document.getElementById('todo-new')?.focus();
  }

  /** The hosts' heartbeats: which PCs take godmode.plan. A failed pull keeps the cached copy. */
  async function loadHosts() {
    try {
      hosts = hostList(await cloud.snapshots('host'), Date.now());
    } catch {
      hosts = hostList(await cloud.cachedSnapshots('host').catch(() => []), Date.now());
    }
  }

  async function refresh() {
    const [todos] = await Promise.allSettled([cloud.pull(SCOPE), loadHosts()]);
    if (todos.status === 'fulfilled') render(todos.value.mirror);
    else {
      toast(t('pullFailed'), true);
      rerender();
    }
  }

  // Cached mirror first (instant, works offline), then the network.
  cloud.state(SCOPE).then((s) => render(s.mirror), () => {});
  cloud.cachedSnapshots('host').then(
    (rows) => {
      if (!hosts.length) hosts = hostList(rows, Date.now());
      rerender();
    },
    () => {},
  );
  return { refresh };
}
