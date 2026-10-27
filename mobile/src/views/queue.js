// ============================================================================
// LunaCore phone - Luna's Work: the project queue (B16)
// ----------------------------------------------------------------------------
// On the God Mode page. Each PC that has a Luna's Work project queue
// publishes it in its `godmode` snapshot (labels only, godmodesnapshot.js).
// After a SHIP the PC starts the next one; PLATEAU / RED / STOP pause the
// queue. Read-only here: the queue is edited in the HUD panel.
// ============================================================================

import { h } from '../dom.js';
import { t } from '../i18n.js';
import { godmodeQueueFrom } from '../snapmodel.js';

/**
 * The queue card, or null when no PC has anything queued.
 * @param {object[]} rows parsed `godmode` rows (snapRows)
 * @param {number} now
 */
export function queueCard(rows, now) {
  const queues = godmodeQueueFrom(rows, now);
  if (!queues.length) return null;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-queue' },
    h('h2', { class: 'section-title', id: 'godmode-queue' }, t('queueTitle')),
    h('p', { class: 'hint' }, t('queueHint')),
    queues.map((q) =>
      h(
        'div',
        { class: 'stack-sm' },
        h('div', { class: 'row' }, h('span', { class: 'hint grow' }, q.machine), q.stale ? h('span', { class: 'tag is-warn' }, t('godmodeStale')) : null),
        h('ol', { class: 'rows' }, q.items.map((item) => h('li', { class: 'row' }, h('span', { class: 'grow' }, item.label)))),
      ),
    ),
  );
}
