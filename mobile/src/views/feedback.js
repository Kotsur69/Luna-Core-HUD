// ============================================================================
// LunaCore phone - Luna's Work: feedback while the run goes on (B17)
// ----------------------------------------------------------------------------
// On the God Mode page, under the decisions. Shown while a PC publishes the
// feedback section of its current run (src/lunasworkFeedback.js): every item
// with its status (sent / received / waiting / planned / built / verified /
// declined / noted) and a form for new feedback. The milestone email's
// feedback link opens this page, on the phone or on the web. A send writes
// one unit to the `todos` scope through the outbox (works offline); the PC
// triages it into cards at the start of its next iteration - the run never
// pauses. Every string goes in as text.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { godmodeFeedbackFrom } from '../snapmodel.js';
import { feedbackUnit, itemsToShow, statusKey, statusTone, MAX_TEXT } from '../feedbackmodel.js';

const SCOPE = 'todos';

function feedbackItem(item) {
  const meta = [item.author === 'client' ? t('feedbackClient') : '', item.cards > 0 ? tf('feedbackCards', { n: item.cards }) : ''].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, item.text), h('span', { class: statusTone(item.status) }, t(statusKey(item.status)))),
    meta ? h('span', { class: 'hint' }, meta) : null,
  );
}

function feedbackForm(section, send) {
  const id = `feedback-${section.runId}`;
  const input = h('textarea', { class: 'field', id, rows: '3', maxlength: String(MAX_TEXT), placeholder: t('feedbackPlaceholder') });
  return h(
    'form',
    {
      class: 'stack-sm',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text && (await send(section, text))) input.value = '';
      },
    },
    h('label', { class: 'label', for: id }, t('feedbackLabel')),
    input,
    h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, t('feedbackSend')),
  );
}

/**
 * The feedback card, or null when no PC runs Luna's Work right now.
 * @param {object[]} rows parsed `godmode` rows (snapRows)
 * @param {number} now
 * @param {{mirror: object, send: (section: object, text: string) => Promise<boolean>}} ctx
 */
export function feedbackCard(rows, now, { mirror, send }) {
  const section = godmodeFeedbackFrom(rows, now);
  if (!section) return null;
  const items = itemsToShow(section, mirror);
  const where = [section.repoName, section.machine].filter(Boolean).join(' · ');
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-feedback' },
    h('div', { class: 'row' }, h('h2', { class: 'section-title grow', id: 'godmode-feedback' }, t('feedbackTitle')), where ? h('span', { class: 'hint' }, where) : null),
    h('p', { class: 'hint' }, t('feedbackHint')),
    items.length ? h('ul', { class: 'rows' }, items.map(feedbackItem)) : h('p', { class: 'hint' }, t('feedbackEmpty')),
    feedbackForm(section, send),
  );
}

/**
 * The send flow for a page: holds the `todos` mirror, writes feedback through
 * the outbox and repaints.
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {() => void} repaint
 * @returns {{mirror: () => object, send: (section: object, text: string) => Promise<boolean>}}
 */
export function createFeedbackSender({ cloud, toast }, repaint) {
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
  async function send(section, text) {
    const unit = feedbackUnit(section.runId, text);
    if (!unit) {
      toast(t('feedbackBad'), true);
      return false;
    }
    if (busy) return false;
    busy = true;
    try {
      const s = await cloud.write(SCOPE, unit);
      mirror = s.mirror;
      toast(s.queued ? t('savedOffline') : t('feedbackSentToast'));
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
