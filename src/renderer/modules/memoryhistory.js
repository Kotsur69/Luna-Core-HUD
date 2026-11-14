// ============================================================================
// LunaCore - the History expander of one memory (renderer)
// ----------------------------------------------------------------------------
// Under every memory of the "All memories" list (memorybrain.js memoriesPanel):
// where it came from, what it replaced and what replaced it, its links and
// conflicts, and what this PC's memory log says happened to it. One read-only
// call, memory:provenance (src/memorybrainipc.js, src/memoryprovenance.js),
// made when the expander opens. No graph: an indented list.
//
// Memory text is free text from a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

/** Keys whose History is open: a repaint of the list opens them again. */
const open = new Set();
/** key -> the last memory:provenance answer, so a repaint does not ask again. */
const cache = new Map();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Forgets every open expander (the window closed). */
export function clearHistory() {
  open.clear();
  cache.clear();
}

const when = (ms) =>
  Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
const orDash = (v) => (typeof v === 'string' && v ? v : '-');

/** The source line in words: a session or a God Mode run, the machine, the notes. */
export function sourceLines(source) {
  const s = source && typeof source === 'object' ? source : {};
  const params = { ref: orDash(s.ref), machine: orDash(s.machine), text: orDash(s.text) };
  const main = {
    session: 'mem.brain.history.src.session',
    godmode: 'mem.brain.history.src.godmode',
    merged: 'mem.brain.history.src.merged',
    'auto-memory': 'mem.brain.history.src.autoMemory',
    other: 'mem.brain.history.src.other',
  }[s.kind];
  const lines = [t(main || 'mem.brain.history.src.none', params)];
  if (Number.isInteger(s.outside) && s.outside > 0) lines.push(t('mem.brain.history.src.outside', { count: s.outside }));
  if (s.suggestedGlobal) lines.push(t('mem.brain.history.src.suggestedGlobal'));
  if (s.autoAccepted) lines.push(t('mem.brain.history.src.autoAccepted'));
  return lines;
}

/** The i18n key of each timeline event. */
const EVENT_KEYS = {
  proposed: 'mem.brain.history.ev.proposed',
  approved: 'mem.brain.history.ev.approved',
  edited: 'mem.brain.history.ev.edited',
  rejected: 'mem.brain.history.ev.rejected',
  retired: 'mem.brain.history.ev.retired',
  'auto-accepted': 'mem.brain.history.ev.autoAccepted',
  superseded: 'mem.brain.history.ev.superseded',
  restored: 'mem.brain.history.ev.restored',
  verified: 'mem.brain.history.ev.verified',
  disputed: 'mem.brain.history.ev.disputed',
  conflict: 'mem.brain.history.ev.conflict',
};

const keyId = (key) => String(key || '').split('/').pop();

/** One timeline event in words. */
export function eventLine(e) {
  let what;
  if (e.ev === 'merged') {
    what = Array.isArray(e.from)
      ? t('mem.brain.history.ev.mergedFrom', { from: e.from.map(keyId).join(', ') })
      : t('mem.brain.history.ev.mergedInto', { into: keyId(e.into) });
  } else if (e.ev === 'conflict') {
    what = t(EVENT_KEYS.conflict, { other: keyId(e.other) });
  } else {
    what = Object.hasOwn(EVENT_KEYS, e.ev) ? t(EVENT_KEYS[e.ev]) : String(e.ev);
  }
  const by = e.by === 'user' ? ` (${t('mem.brain.history.byUser')})` : e.by === 'tool' ? ` (${t('mem.brain.history.byTool')})` : '';
  const note = e.note ? ` - ${e.note}` : '';
  return `${when(e.at)}: ${what}${by}${note}`;
}

/** A chain node's label: its title, or its id when the file is gone; a waiting one says so. */
function nodeLabel(node) {
  const name = node.title || t('mem.brain.history.gone', { id: node.id });
  return node.confirmed === false ? `${name} (${t('mem.brain.history.waiting')})` : name;
}

function chainList(nodes) {
  const ul = el('ul', 'mem-brain__chain');
  for (const node of nodes) {
    const li = el('li', '', nodeLabel(node));
    if (Array.isArray(node.children) && node.children.length) li.append(chainList(node.children));
    ul.append(li);
  }
  return ul;
}

function chainSection(titleKey, chain) {
  const nodes = [el('h4', '', t(titleKey))];
  const list = chain && Array.isArray(chain.nodes) ? chain.nodes : [];
  if (!list.length) nodes.push(el('p', 'hint', t('mem.brain.history.none')));
  else nodes.push(chainList(list));
  if (chain && chain.cut) nodes.push(el('p', 'hint', t('mem.brain.history.cut')));
  return nodes;
}

const refNames = (list) => (Array.isArray(list) && list.length ? list.map((r) => r.title || r.id).join('; ') : '-');

/** The expander's content, from memory:provenance's answer. */
function content(p) {
  const nodes = [el('h4', '', t('mem.brain.history.source')), ...sourceLines(p.source).map((line) => el('p', '', line))];
  nodes.push(
    el('p', '', t('mem.brain.history.dates', { created: orDash(p.created), verified: orDash(p.last_verified), used: orDash(p.last_used) })),
    el('p', '', p.usefulness_note ? t('mem.brain.history.why', { note: p.usefulness_note }) : t('mem.brain.history.whyNone')),
    ...chainSection('mem.brain.history.supersedes', p.supersedes),
    ...chainSection('mem.brain.history.supersededBy', p.supersededBy),
    el('h4', '', t('mem.brain.history.refs')),
    el('p', '', t('mem.brain.history.links', { list: refNames(p.links) })),
    el('p', '', t('mem.brain.history.conflicts', { list: refNames(p.conflicts) })),
    el('p', '', t('mem.brain.history.compatible', { list: refNames(p.compatible) })),
    el('h4', '', t('mem.brain.history.timeline')),
    // The log is not synced: say so, so an empty timeline is not read as "nothing happened".
    el('p', 'hint', t('mem.brain.history.local')),
  );
  const tl = p.timeline || {};
  const events = Array.isArray(tl.events) ? tl.events : [];
  if (!events.length) nodes.push(el('p', 'hint', t('mem.brain.history.noEvents')));
  else {
    const ul = el('ul', 'mem-brain__timeline');
    for (const e of events) ul.append(el('li', '', eventLine(e)));
    nodes.push(ul);
  }
  if (Number.isInteger(tl.total) && tl.total > events.length) nodes.push(el('p', 'hint', t('mem.brain.history.older', { count: tl.total - events.length })));
  const reads = tl.reads || {};
  nodes.push(el('p', '', t('mem.brain.history.reads', { found: reads.found || 0, opened: reads.opened || 0, last: reads.last ? when(reads.last) : '-' })));
  return nodes;
}

/**
 * Fills the expander with a fresh read. A repaint follows every change (a merge,
 * an approval, a sync), so the last answer is shown at once and then replaced:
 * an open History never stays stale and never flashes "loading".
 */
async function fill(body, key) {
  if (cache.has(key)) body.replaceChildren(...content(cache.get(key)));
  else body.replaceChildren(el('p', 'hint', t('mem.inbox.loading')));
  let res;
  try {
    res = await window.lunacore.memoryProvenance(key);
  } catch {
    res = { ok: false, reason: 'ipc' };
  }
  // The list was repainted meanwhile: the new expander shows the answer from the cache.
  if (res && res.ok) cache.set(key, res);
  if (!body.isConnected) return;
  if (res && res.ok) body.replaceChildren(...content(res));
  else {
    const err = el('p', 'hint is-fail', t('mem.brain.history.failed'));
    err.setAttribute('role', 'alert');
    body.replaceChildren(err);
  }
}

/**
 * The History expander of one memory: a <details>, read when it opens.
 * @param {string} key the memory's key, as memory:list gave it
 */
export function historyBlock(key) {
  const details = el('details', 'mem-brain__history');
  const body = el('div', 'mem-brain__history-body');
  details.append(el('summary', '', t('mem.brain.history.title')), body);
  if (open.has(key)) {
    details.open = true;
    fill(body, key);
  }
  details.addEventListener('toggle', () => {
    if (!details.open) {
      open.delete(key);
      return;
    }
    // Setting `open` after a repaint fires this too: that expander is already being filled.
    if (open.has(key)) return;
    open.add(key);
    fill(body, key);
  });
  return details;
}
