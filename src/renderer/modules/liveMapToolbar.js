// ============================================================================
// LunaCore - Live map, God Mode tab: toolbar and big-run summary (DOM)
// ----------------------------------------------------------------------------
// createToolbar() builds the graph tools once - direction (LR / TB), the
// search filter, Focus blocked, Critical path, Trace, Fit and zoom - and
// hands back a sync() that reflects the tab's state on every render, so the
// search box keeps its focus and caret while the graph updates live.
// summaryPanel() is what a run above GRAPH_SUMMARY_LIMIT packages shows
// instead of the graph: counts per state and clickable failed / blocked /
// running lists. Labels go in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { GRAPH_SUMMARY_LIMIT } from './liveMapHelpers.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolButton(cls, onClick) {
  const btn = el('button', `lm-tool ${cls}`);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * The toolbar of the God Mode tab.
 * @param {{onDirection:(d:'LR'|'TB') => void, onQuery:(q:string) => void, onToggle:(key:'blocked'|'path'|'trace') => void,
 *   onFit:() => void, onZoomIn:() => void, onZoomOut:() => void}} actions
 * @returns {{root:HTMLElement, sync:(state:object) => void}}
 */
export function createToolbar(actions) {
  const root = el('div', 'lm-toolbar');
  root.setAttribute('role', 'toolbar');
  const dirGroup = el('div', 'lm-toolbar__group');
  const lr = toolButton('is-dir', () => actions.onDirection('LR'));
  const tb = toolButton('is-dir', () => actions.onDirection('TB'));
  lr.textContent = 'LR';
  tb.textContent = 'TB';
  dirGroup.append(lr, tb);
  const search = el('input', 'lm-search');
  search.type = 'search';
  search.spellcheck = false;
  search.addEventListener('input', () => actions.onQuery(search.value));
  const blocked = toolButton('', () => actions.onToggle('blocked'));
  const path = toolButton('', () => actions.onToggle('path'));
  const trace = toolButton('', () => actions.onToggle('trace'));
  const viewGroup = el('div', 'lm-toolbar__group');
  const zoomOut = toolButton('is-icon', actions.onZoomOut);
  const fit = toolButton('', actions.onFit);
  const zoomIn = toolButton('is-icon', actions.onZoomIn);
  zoomOut.textContent = '−';
  zoomIn.textContent = '+';
  viewGroup.append(zoomOut, fit, zoomIn);
  const info = el('span', 'lm-toolbar__info');
  info.setAttribute('aria-live', 'polite');
  root.append(dirGroup, search, blocked, path, trace, viewGroup, info);

  const press = (btn, on) => btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const label = (btn, key) => {
    btn.title = t(key);
    btn.setAttribute('aria-label', t(key));
  };

  /** Reflects the tab state: pressed toggles, disabled tools, labels in the current language. */
  function sync(state) {
    root.setAttribute('aria-label', t('lm.tb.label'));
    label(lr, 'lm.tb.lr');
    label(tb, 'lm.tb.tb');
    press(lr, state.direction === 'LR');
    press(tb, state.direction === 'TB');
    search.placeholder = t('lm.tb.search');
    search.setAttribute('aria-label', t('lm.tb.search'));
    if (search.value !== state.query) search.value = state.query;
    blocked.textContent = t('lm.tb.blocked');
    path.textContent = t('lm.tb.path');
    trace.textContent = t('lm.tb.trace');
    trace.title = state.selectedId ? '' : t('lm.tb.traceHint');
    fit.textContent = t('lm.tb.fit');
    label(zoomIn, 'lm.tb.zoomIn');
    label(zoomOut, 'lm.tb.zoomOut');
    press(blocked, state.focusBlocked);
    press(path, state.showPath);
    press(trace, state.trace && !!state.selectedId);
    const off = !state.enabled;
    for (const b of [lr, tb, blocked, path, zoomIn, zoomOut, fit]) b.disabled = off;
    search.disabled = off;
    trace.disabled = off || !state.selectedId;
    info.textContent = state.info || '';
  }
  return { root, sync };
}

function listBlock(titleKey, list, onPick) {
  const box = el('section', 'lm-summary__block');
  box.append(el('h4', 'lm-summary__title', `${t(titleKey)} (${list.items.length + list.more})`));
  if (!list.items.length) {
    box.append(el('p', 'lm-side__muted', t('lm.none')));
    return box;
  }
  const ul = el('ul', 'lm-summary__list');
  for (const item of list.items) {
    const li = el('li');
    const btn = el('button', 'lm-summary__item');
    btn.type = 'button';
    btn.append(el('span', 'lm-summary__name', item.title), el('span', 'lm-tip__id', `${item.id} · ${t(`orch.state.${item.stateKey}`)}`));
    btn.addEventListener('click', () => onPick(item.id));
    li.append(btn);
    ul.append(li);
  }
  if (list.more) ul.append(el('li', 'lm-side__muted', t('lm.more', { n: list.more })));
  box.append(ul);
  return box;
}

/**
 * The big-run summary (counts + clickable lists).
 * @param {{counts:Array<{key:string, n:number}>, failed:object, blocked:object, active:object}} lists
 * @param {number} total
 * @param {(id:string) => void} onPick selects a package (opens its side panel)
 */
export function summaryPanel(lists, total, onPick) {
  const root = el('div', 'lm-summary');
  root.append(el('p', 'lm-summary__lead', t('lm.summary.title', { n: total, limit: GRAPH_SUMMARY_LIMIT })));
  const counts = el('dl', 'lm-summary__counts');
  for (const { key, n } of lists.counts) {
    const item = el('div', 'lm-summary__count');
    item.append(el('dt', '', t(`orch.state.${key}`)), el('dd', '', String(n)));
    counts.append(item);
  }
  root.append(counts);
  const grid = el('div', 'lm-summary__grid');
  grid.append(
    listBlock('lm.summary.failed', lists.failed, onPick),
    listBlock('lm.summary.blocked', lists.blocked, onPick),
    listBlock('lm.summary.active', lists.active, onPick),
  );
  root.append(grid);
  return root;
}
