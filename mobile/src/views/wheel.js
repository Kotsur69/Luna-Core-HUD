// ============================================================================
// LunaCore phone - Luna's Work: "Hand me the wheel" (C11)
// ----------------------------------------------------------------------------
// On the God Mode page, above the feedback. Shown while a PC publishes its
// current run: who has the wheel, and one button - "Hand me the wheel" (the
// run pauses at the end of its iteration), "Hand back" (the Critic reads
// Mati's commits and the run goes on), or a cancel while the pause waits. A
// tap writes one unit to the `todos` scope through the outbox (works
// offline); the PC applies the newest one of its run at its next pull.
// ============================================================================

import { h } from '../dom.js';
import { t } from '../i18n.js';
import { godmodeFeedbackFrom } from '../snapmodel.js';
import { wheelUnit, wheelView, pendingAction } from '../wheelmodel.js';

const SCOPE = 'todos';

/**
 * The wheel card, or null when no PC runs Luna's Work right now.
 * @param {object[]} rows parsed `godmode` rows (snapRows)
 * @param {number} now
 * @param {{mirror: object, send: (section: object, action: string) => Promise<boolean>}} ctx
 */
export function wheelCard(rows, now, { mirror, send }) {
  const section = godmodeFeedbackFrom(rows, now);
  if (!section) return null;
  const view = wheelView(section.wheel);
  const pending = pendingAction(section, mirror);
  const tone = section.wheel === 'handed' ? 'tag is-warn' : 'tag';
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-wheel' },
    h('div', { class: 'row' }, h('h2', { class: 'section-title grow', id: 'godmode-wheel' }, t('wheelTitle')), h('span', { class: tone }, t(view.state))),
    h('p', { class: 'hint' }, t(pending ? 'wheelSent' : view.hint)),
    h(
      'button',
      { class: section.wheel === 'running' ? 'btn btn-sm btn-primary' : 'btn btn-sm', type: 'button', disabled: pending ? true : undefined, onclick: () => send(section, view.action) },
      t(view.button),
    ),
  );
}

/**
 * The send flow for a page: holds the `todos` mirror, writes the wheel
 * action through the outbox and repaints.
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {() => void} repaint
 * @returns {{mirror: () => object, send: (section: object, action: string) => Promise<boolean>}}
 */
export function createWheelSender({ cloud, toast }, repaint) {
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
  async function send(section, action) {
    const unit = wheelUnit(section.runId, action);
    if (!unit || busy) return false;
    busy = true;
    try {
      const s = await cloud.write(SCOPE, unit);
      mirror = s.mirror;
      toast(s.queued ? t('savedOffline') : t('wheelSentToast'));
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
