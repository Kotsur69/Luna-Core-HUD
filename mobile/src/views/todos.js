// ============================================================================
// LunaCore phone - to-do lists (plan phase 4a)
// ----------------------------------------------------------------------------
// One list at a time, picked from the projects the PCs have synced. Every
// action is one cloud unit (todomodel.js); the screen re-renders from the
// mirror the write's pull returns: what the server holds, plus this phone's
// writes still waiting to be sent (phase 4d).
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t } from '../i18n.js';
import { lists, addUnit, toggleUnit, toggleManualUnit, toggleTagUnit, hasTag, deleteUnit, STEER_TAG } from '../todomodel.js';
import { PICK_KEY } from '../cloud.js';

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

  function render(mirror) {
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
        addForm(),
        open.length ? h('ul', { class: 'todos' }, open.map((i) => itemRow(picked, i))) : h('p', { class: 'empty' }, t('emptyItems')),
        done.length ? h('h2', { class: 'section-title' }, `${t('done')} · ${done.length}`) : null,
        done.length ? h('ul', { class: 'todos' }, done.map((i) => itemRow(picked, i))) : null,
      ),
    );
    if (typing) document.getElementById('todo-new')?.focus();
  }

  async function refresh() {
    try {
      render((await cloud.pull(SCOPE)).mirror);
    } catch {
      toast(t('pullFailed'), true);
    }
  }

  // Cached mirror first (instant, works offline), then the network.
  cloud.state(SCOPE).then((s) => render(s.mirror), () => {});
  return { refresh };
}
