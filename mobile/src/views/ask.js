// ============================================================================
// LunaCore phone - Luna's Work: "Ask Luna about the run" (LW 2.27)
// ----------------------------------------------------------------------------
// On the Luna's Work page, under the run's status: a question box ("why did
// you roll back iteration 14?") and the PC's answers with the sources they
// cite. A send writes one unit to the `todos` scope through the outbox
// (works offline); the PC answers read-only from the run's records at its
// next sync and publishes the answer in its `godmode` row. Every string goes
// in as text.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { askUnit, asksToShow, askStatusKey, askStatusTone, sourceLabels, MAX_QUESTION } from '../askmodel.js';

const SCOPE = 'todos';
const FORM_ID = 'lunaswork-ask-text';

function sourcesLine(sources) {
  const labels = sourceLabels(sources).map((s) => (s.iteration === null ? t(s.key) : `${t(s.key)} (${tf('askIteration', { n: s.iteration })})`));
  return labels.length ? h('span', { class: 'hint' }, `${t('askSources')}: ${labels.join(', ')}`) : null;
}

function askItem(item) {
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, item.question), h('span', { class: askStatusTone(item.status) }, t(askStatusKey(item.status)))),
    item.answer ? h('p', { class: 'ask-answer' }, item.answer) : null,
    item.status === 'answered' ? sourcesLine(item.sources) : null,
  );
}

function askForm(send) {
  const input = h('textarea', { class: 'field', id: FORM_ID, rows: '2', maxlength: String(MAX_QUESTION), placeholder: t('askPlaceholder') });
  return h(
    'form',
    {
      class: 'stack-sm',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text && (await send(text))) input.value = '';
      },
    },
    h('label', { class: 'label', for: FORM_ID }, t('askLabel')),
    input,
    h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, t('askSend')),
  );
}

/**
 * The "Ask Luna" card.
 * @param {object[]} rows parsed `godmode` rows (snapRows)
 * @param {number} now
 * @param {{mirror: object, send: (text: string) => Promise<boolean>}} ctx
 */
export function askCard(rows, now, { mirror, send }) {
  const { machine, items } = asksToShow(rows, mirror, now);
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'lunaswork-ask' },
    h('div', { class: 'row' }, h('h2', { class: 'section-title grow', id: 'lunaswork-ask' }, t('askTitle')), machine ? h('span', { class: 'hint' }, machine) : null),
    h('p', { class: 'hint' }, t('askHint')),
    askForm(send),
    items.length ? h('ul', { class: 'rows' }, items.map(askItem)) : null,
  );
}

/**
 * The send flow for a page: holds the `todos` mirror, writes a question
 * through the outbox and repaints.
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {() => void} repaint
 * @returns {{mirror: () => object, send: (text: string) => Promise<boolean>}}
 */
export function createAskSender({ cloud, toast }, repaint) {
  let mirror = {};
  let busy = false;
  cloud.state(SCOPE).then(
    (s) => {
      mirror = s.mirror;
      repaint();
    },
    // No mirror yet (logged out, storage blocked): nothing shows as sent.
    () => {},
  );
  async function send(text) {
    const unit = askUnit(text);
    if (!unit) {
      toast(t('askBad'), true);
      return false;
    }
    if (busy) return false;
    busy = true;
    try {
      const s = await cloud.write(SCOPE, unit);
      mirror = s.mirror;
      toast(s.queued ? t('savedOffline') : t('askSentToast'));
      repaint();
      return true;
    } catch {
      toast(t('saveFailed'), true);
      return false;
    } finally {
      busy = false;
    }
  }
  return { mirror: () => mirror, send };
}
