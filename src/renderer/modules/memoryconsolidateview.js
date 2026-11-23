// ============================================================================
// LunaCore - the Sleep Pass in the memory window (renderer)
// ----------------------------------------------------------------------------
// On the All memories tab (memorybrain.js memoriesPanel), next to Scan:
//
//   Consolidate   one Sonnet call proposes merges, expiry, retirement and an
//                 architecture-map refresh (src/memoryconsolidate.js). The
//                 proposals land in the inbox; nothing confirmed changes.
//                 Disabled while any model job on the memory runs.
//   Weekly        the opt-in schedule of this project on this PC (default off).
//   the line      what the pass is doing or last did, for this project.
//
// Main's answers are data: textContent only, never markup.
// ============================================================================

'use strict';

import { t } from './util.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The i18n key of a refused start. */
export function consolidateStartKey(reason) {
  if (reason === 'busy') return 'mem.brain.consolidate.err.busy';
  if (reason === 'empty') return 'mem.brain.consolidate.err.empty';
  return 'mem.brain.consolidate.err.failed';
}

/** The i18n key of why the last pass made no proposals (the consolidator's status.error). */
export function consolidateErrorKey(reason) {
  if (reason === 'model-no-claude') return 'mem.brain.err.noClaude';
  if (reason === 'model-timeout') return 'mem.brain.err.timeout';
  if (['bad-answer', 'model-bad-json', 'model-cli-error'].includes(reason)) return 'mem.brain.consolidate.err.reply';
  return 'mem.brain.err.failed';
}

/** What the pass is doing or last did, in words; '' when there is nothing to say for this project. */
export function consolidateLine(status, project) {
  if (!status || !status.project || (project && status.project !== project)) return '';
  if (status.running) return t('mem.brain.consolidate.running', { clusters: status.clusters || 0 });
  if (!status.finishedAt) return '';
  if (status.error) return t('mem.brain.consolidate.failed', { reason: t(consolidateErrorKey(status.error)) });
  const done = t('mem.brain.consolidate.done', {
    merges: status.merges || 0,
    expiries: status.expiries || 0,
    retirements: status.retirements || 0,
  });
  const arch = status.architecture ? ` ${t('mem.brain.consolidate.architecture')}` : '';
  return done + arch;
}

/**
 * @param {{call: (fn: string, ...args: unknown[]) => Promise<object>, load: () => void}} w the window's hooks
 */
export function createConsolidateFlow(w) {
  let status = null;
  let busy = false;
  let weekly = false;
  /** An i18n key when main refused a start or the weekly switch, or null. */
  let startError = null;
  let starting = false;

  async function start(project) {
    // A second click before the repaint disables the button would only be refused as busy.
    if (starting) return;
    starting = true;
    startError = null;
    let res = null;
    try {
      res = await w.call('memoryConsolidate', project);
    } finally {
      starting = false;
    }
    if (!res || !res.ok) startError = consolidateStartKey(res && res.reason);
    w.load();
  }

  async function setWeekly(project, on) {
    startError = null;
    const res = await w.call('memoryConsolidateWeekly', project, on);
    if (!res || !res.ok) startError = 'mem.brain.consolidate.err.weekly';
    w.load();
  }

  return {
    /** memory:consolidate-status's answer, read on every repaint of the tab. */
    setStatus(res) {
      status = res && res.ok && res.status ? res.status : null;
      busy = Boolean(res && res.ok && res.busy === true);
      weekly = Boolean(res && res.ok && res.weekly === true);
    },
    startError: () => startError,
    reset() {
      startError = null;
    },
    line: (project) => consolidateLine(status, project),
    /** The Consolidate button and the weekly switch of `project`. */
    controls(project) {
      const running = Boolean(status && status.running);
      const btn = el('button', 'port-btn mem-inbox__btn mem-brain__consolidate', t(running ? 'mem.brain.consolidate.buttonRunning' : 'mem.brain.consolidate.button'));
      btn.type = 'button';
      btn.title = t('mem.brain.consolidate.hint');
      // One model job at a time (scan, check and this share a lock): main refuses a second one too.
      btn.disabled = running || busy || starting;
      btn.addEventListener('click', () => start(project));
      const label = el('label', 'mem-auto__row mem-brain__weekly');
      const box = el('input', 'mem-auto__switch');
      box.type = 'checkbox';
      box.setAttribute('role', 'switch');
      box.checked = weekly;
      box.addEventListener('change', () => setWeekly(project, box.checked));
      label.title = t('mem.brain.consolidate.weeklyHint');
      label.append(box, el('span', 'mem-auto__text', t('mem.brain.consolidate.weekly')));
      return [btn, label];
    },
  };
}
