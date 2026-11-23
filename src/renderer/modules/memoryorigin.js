// ============================================================================
// LunaCore - the memory window's origin-session drawer (renderer)
// ----------------------------------------------------------------------------
// C on a selected entry (memoryinboxkeys.js COMMANDS.CONTEXT) opens a pane
// beside the list: the excerpt of the session transcript or God Mode run
// report the memory was proposed from (memory:origin-snippet), and an
// [Interrogate] button that asks Sonnet once, without tools, why this memory
// came from that excerpt and whether it is a durable lesson or a guess
// (memory:interrogate). C again, or the close button, folds it away.
//
// The drawer is one node kept across the window's repaints: memoryinbox.js
// puts it next to its list through wrap(). Excerpts and replies are text from
// transcripts and a model: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The i18n key of a snippet main could not give. */
export function originReasonKey(reason) {
  if (reason === 'no-source') return 'mem.brain.origin.err.noSource';
  if (reason === 'not-found') return 'mem.brain.origin.err.notFound';
  if (reason === 'empty') return 'mem.brain.origin.err.empty';
  return 'mem.brain.origin.err.failed';
}

/** The i18n key and its values of a failed Interrogate call. */
export function interrogateReason(reason) {
  const why = String(reason || '');
  if (why === 'busy') return { key: 'mem.brain.origin.err.busy' };
  if (why === 'bad-answer') return { key: 'mem.brain.origin.err.reply' };
  if (why.startsWith('model-')) return { key: 'mem.brain.origin.err.model', values: { reason: why.slice('model-'.length) } };
  return { key: originReasonKey(why) };
}

/** The line saying where the excerpt is from. */
export function originFromLine(snippet) {
  if (!snippet || !snippet.ok) return '';
  if (snippet.kind === 'godmode') return t('mem.brain.origin.from.godmode', { ref: snippet.ref });
  return t('mem.brain.origin.from.session', { ref: snippet.ref, file: snippet.file });
}

/**
 * @param {{call: (fn: string, ...args: any[]) => Promise<object>}} deps call = the window's IPC
 *   helper (never throws: a failure is {ok: false, reason})
 * @returns {{toggle: (item: {key: string, title?: string}|null) => boolean, close: () => void,
 *   isOpen: () => boolean, openKey: () => string|null, wrap: (panel: HTMLElement) => HTMLElement}}
 */
export function createOriginDrawer({ call }) {
  let item = null;
  /** null = loading; else main's answer. */
  let snippet = null;
  let reply = null;
  let asking = false;
  /** Counts openings: an answer for an entry the drawer has left is dropped. */
  let seq = 0;
  let root = null;

  function interrogateButton() {
    const btn = el('button', 'port-btn mem-inbox__btn mem-origin__ask', t(asking ? 'mem.brain.origin.asking' : 'mem.brain.origin.interrogate'));
    btn.type = 'button';
    btn.title = t('mem.brain.origin.interrogateHint');
    btn.disabled = asking || !snippet || !snippet.ok;
    btn.addEventListener('click', interrogate);
    return btn;
  }

  function replyNodes() {
    if (!reply) return [];
    if (!reply.ok) {
      const { key, values } = interrogateReason(reply.reason);
      const fail = el('p', 'hint is-fail', t(key, values));
      fail.setAttribute('role', 'alert');
      return [fail];
    }
    const verdict = el('p', `mem-origin__verdict is-${reply.verdict}`, t(`mem.brain.origin.verdict.${reply.verdict}`));
    return [verdict, el('p', 'mem-origin__reply', reply.text)];
  }

  function snippetNodes() {
    if (snippet === null) return [el('p', 'hint', t('mem.brain.origin.loading'))];
    if (!snippet.ok) return [el('p', 'hint is-fail', t(originReasonKey(snippet.reason)))];
    const words = Array.isArray(snippet.matched) && snippet.matched.length ? t('mem.brain.origin.matched', { words: snippet.matched.join(', ') }) : t('mem.brain.origin.noMatch');
    const notes = [words, snippet.truncated ? t('mem.brain.origin.truncated') : '', t('mem.brain.origin.scrubbed')].filter(Boolean).join(' ');
    return [el('p', 'hint mem-origin__from', originFromLine(snippet)), el('pre', 'mem-origin__excerpt', snippet.excerpt), el('p', 'hint', notes)];
  }

  function paint() {
    if (!root || !item) return;
    const head = el('div', 'mem-origin__head');
    const close = el('button', 'port-btn mem-origin__close', t('mem.brain.origin.close'));
    close.type = 'button';
    close.addEventListener('click', () => {
      const node = root;
      closeDrawer();
      // The split folds on the window's next repaint; until then the pane just goes.
      if (node) node.remove();
    });
    head.append(el('h3', 'mem-origin__title', t('mem.brain.origin.title')), close);
    const status = el('div', 'mem-origin__answer');
    status.setAttribute('aria-live', 'polite');
    status.append(...replyNodes());
    root.replaceChildren(head, el('p', 'mem-origin__memory', item.title || item.key), ...snippetNodes(), interrogateButton(), status);
  }

  async function open(next) {
    item = { key: next.key, title: typeof next.title === 'string' ? next.title : '' };
    snippet = null;
    reply = null;
    asking = false;
    const mine = ++seq;
    if (!root) {
      root = el('aside', 'mem-origin');
      root.setAttribute('aria-label', t('mem.brain.origin.title'));
    }
    paint();
    const res = await call('memoryOriginSnippet', item.key);
    if (mine !== seq) return;
    snippet = res && typeof res === 'object' ? res : { ok: false, reason: 'failed' };
    paint();
  }

  async function interrogate() {
    if (asking || !item || !snippet || !snippet.ok) return;
    const mine = seq;
    asking = true;
    reply = null;
    paint();
    const res = await call('memoryInterrogate', item.key);
    if (mine !== seq) return;
    asking = false;
    reply = res && typeof res === 'object' ? res : { ok: false, reason: 'failed' };
    paint();
  }

  function closeDrawer() {
    seq++;
    item = null;
    snippet = null;
    reply = null;
    asking = false;
  }

  return {
    /** Opens the drawer for an entry, or closes it when it already shows that one. @returns {boolean} whether it is open now */
    toggle(next) {
      if (!next || typeof next.key !== 'string') return false;
      if (item && item.key === next.key) {
        closeDrawer();
        return false;
      }
      open(next);
      return true;
    },
    close: closeDrawer,
    isOpen: () => item !== null,
    openKey: () => (item ? item.key : null),
    /** The list, with the drawer beside it while it is open. */
    wrap(panel) {
      if (!item || !root) return panel;
      const split = el('div', 'mem-origin-split');
      split.append(panel, root);
      return split;
    },
  };
}
