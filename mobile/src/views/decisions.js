// ============================================================================
// LunaCore phone - Luna's Work: decisions waiting for Mati
// ----------------------------------------------------------------------------
// On top of the God Mode page. Each decision the PC published in its
// `godmode` snapshot (src/lunasworkDecisions.js) shows its kind, question,
// why it was asked, the options with the default marked, and when the
// default is taken - or that it never is (a client's scope change). A tap
// on an option, or the free-text form where the decision allows it, writes
// one answer unit to the `todos` scope through the outbox (works offline).
// The PC accepts only a pending id of its current run and a listed option.
// Every string goes in as text.
// ============================================================================

import { h } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { godmodeDecisionsFrom } from '../snapmodel.js';
import { answerUnit, sentAnswer, optionKey, kindKey } from '../decisionmodel.js';

const SCOPE = 'todos';
const MAX_FREE_TEXT = 500;

const hhmm = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
const optionLabel = (option) => (optionKey(option) ? t(optionKey(option)) : option);

function deadlineLine(d) {
  if (!d.defaultAnswer || !d.deadline) return h('span', { class: 'hint is-warn' }, t('decisionNoDefault'));
  return h('span', { class: 'hint' }, tf('decisionDefaultAt', { time: hhmm(d.deadline), option: optionLabel(d.defaultAnswer) }));
}

/** One option button; the default carries the mark in its label. */
function optionButton(d, option, send) {
  const label = option === d.defaultAnswer ? tf('decisionDefaultMark', { option: optionLabel(option) }) : optionLabel(option);
  return h('button', { class: option === d.defaultAnswer ? 'btn btn-sm' : 'btn btn-sm btn-ghost', type: 'button', onclick: () => send(d, option) }, label);
}

function freeTextForm(d, send) {
  const id = `decision-free-${d.id}`;
  const input = h('input', { class: 'field', id, type: 'text', maxlength: String(MAX_FREE_TEXT), autocomplete: 'off' });
  return h(
    'form',
    {
      class: 'stack-sm',
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text) send(d, text);
      },
    },
    h('label', { class: 'label', for: id }, t('decisionFree')),
    input,
    h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, t('decisionSend')),
  );
}

function decisionItem(d, mirror, send) {
  const sent = sentAnswer(mirror, d);
  const where = [d.repoName, d.machine].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: 'decision stack-sm' },
    h('div', { class: 'row' }, h('span', { class: 'tag is-warn' }, t(kindKey(d.kind))), h('span', { class: 'hint grow' }, where)),
    h('p', { class: 'decision-q' }, d.question),
    d.detail ? h('span', { class: 'hint' }, d.detail) : null,
    deadlineLine(d),
    sent
      ? h('p', { class: 'hint is-good', role: 'status' }, tf('decisionSent', { answer: optionLabel(sent) }))
      : h('div', { class: 'decision-options' }, d.options.map((o) => optionButton(d, o, send))),
    !sent && d.freeText ? freeTextForm(d, send) : null,
  );
}

/**
 * The decisions card, or null when nothing waits.
 * @param {object[]} rows parsed `godmode` rows (snapRows)
 * @param {number} now
 * @param {{mirror: object, send: (decision: object, answer: string) => void}} ctx
 *   mirror = the `todos` mirror with the outbox laid over it (what was sent)
 */
export function decisionsCard(rows, now, { mirror, send }) {
  const list = godmodeDecisionsFrom(rows, now).filter((d) => d.runId);
  if (!list.length) return null;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-decisions' },
    h('h2', { class: 'section-title', id: 'godmode-decisions' }, t('decisionsTitle')),
    h('p', { class: 'hint' }, t('decisionsHint')),
    h('ul', { class: 'rows' }, list.map((d) => decisionItem(d, mirror, send))),
  );
}

/**
 * The answer flow for a page: holds the `todos` mirror, writes an answer
 * through the outbox and repaints.
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {() => void} repaint
 * @returns {{mirror: () => object, send: (decision: object, answer: string) => Promise<void>}}
 */
export function createDecisionAnswers({ cloud, toast }, repaint) {
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
  async function send(decision, answer) {
    const unit = answerUnit(decision, answer);
    if (!unit) {
      toast(t('decisionAnswerBad'), true);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const s = await cloud.write(SCOPE, unit);
      mirror = s.mirror;
      if (s.queued) toast(t('savedOffline'));
      repaint();
    } catch {
      toast(t('saveFailed'), true);
    } finally {
      busy = false;
    }
  }
  return { mirror: () => mirror, send };
}
