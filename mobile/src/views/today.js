// ============================================================================
// LunaCore phone - Today: the next 24 hours of weather (phase 4c), then the
// week's calendar and the inbox (phase 5, views/agenda.js)
// ----------------------------------------------------------------------------
// The town is asked once and kept on this phone (weather.js). Hours are shown
// as a grid of 3-hour slots - no sideways scrolling inside the page.
// ============================================================================

import { h } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { savedPlace, savePlace, findPlace, nextHours } from '../weather.js';
import { mountAgenda } from './agenda.js';

const SLOT_EVERY = 3;
const hourOf = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
const dash = (v) => (v === null ? '–' : v);

/** `onCancel` is offered only when a place is already saved (changing it, not setting it up). */
function placeForm(onSaved, current, onCancel) {
  const input = h('input', { class: 'field', id: 'today-place', type: 'text', autocomplete: 'address-level2', maxlength: '80' });
  input.value = current ? current.name : '';
  const error = h('p', { class: 'hint is-bad', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, t('weatherSave'));
  const cancel = current ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: onCancel }, t('cancel')) : null;
  const form = h('form', { class: 'stack-sm' }, h('label', { class: 'label', for: 'today-place' }, t('weatherWhere')), h('div', { class: 'add-row' }, input, save), error, cancel);
  const fail = (key) => {
    error.textContent = t(key);
    error.hidden = false;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    error.hidden = true;
    try {
      const place = await findPlace(input.value);
      if (!place) return fail('weatherNotFound');
      savePlace(place);
      onSaved();
    } catch {
      fail('weatherFailed');
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

function forecastView(w) {
  if (!w) return h('p', { class: 'hint' }, t('weatherNone'));
  const slots = w.hours.filter((_, i) => i % SLOT_EVERY === 0);
  return h(
    'div',
    { class: 'stack-sm' },
    h('div', { class: 'big-sm num' }, `${Math.round(w.hours[0].temp)}°C`),
    h('div', { class: 'hint' }, tf('weatherRange', { min: w.tMin, max: w.tMax, rain: dash(w.rain), wind: dash(w.wind) })),
    h(
      'ol',
      { class: 'hours' },
      slots.map((x) => h('li', {}, h('span', { class: 'hint' }, hourOf(x.t)), h('span', { class: 'num' }, `${Math.round(x.temp)}°`), h('span', { class: 'hint num' }, x.rain === null ? '–' : `${x.rain}%`))),
    ),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountToday(main, { cloud, toast }) {
  let seq = 0;
  let editing = false;
  let loaded = false; // a forecast, "none" or an error is on screen: no "loading" flash over it
  const weatherBody = h('div');
  const head = h('div', { class: 'row' });
  const agenda = mountAgenda({ cloud, toast });
  main.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('section', { class: 'card stack-sm', 'aria-labelledby': 'today-weather' }, head, weatherBody, h('p', { class: 'hint' }, t('weatherHint'))),
      ...agenda.nodes,
    ),
  );

  function header(place) {
    const change = place && !editing ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => ((editing = true), weather()) }, t('weatherChange')) : null;
    // replaceChildren() would print a null as the text "null".
    const title = h('h2', { class: 'section-title grow', id: 'today-weather' }, place ? `${t('weather')} · ${place.name}` : t('weather'));
    head.replaceChildren(...[title, change].filter(Boolean));
  }

  function refresh() {
    return Promise.all([weather(), agenda.refresh()]).then(() => {});
  }

  async function weather() {
    const mine = ++seq;
    const place = savedPlace();
    header(place);
    if (!place || editing) {
      const done = () => {
        editing = false;
        weather();
      };
      // A sync or a return to the app must not wipe a town being typed.
      if (!weatherBody.querySelector('form')) weatherBody.replaceChildren(placeForm(done, place, done));
      loaded = false;
      return;
    }
    if (!loaded) weatherBody.replaceChildren(h('p', { class: 'hint' }, t('loading')));
    try {
      const w = await nextHours(place);
      if (mine !== seq) return;
      weatherBody.replaceChildren(forecastView(w));
      loaded = true;
    } catch {
      if (mine !== seq) return;
      weatherBody.replaceChildren(h('p', { class: 'hint is-bad' }, t('weatherFailed')));
      loaded = true;
      toast(t('weatherFailed'), true);
    }
  }

  return { refresh };
}
