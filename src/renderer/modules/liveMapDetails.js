// ============================================================================
// LunaCore - Live map: a package's tooltip and side panel (DOM)
// ----------------------------------------------------------------------------
// What the God Mode tab shows about one graph node:
//  - tooltipContent(): title, state, deps, dependents, elapsed, short error;
//  - detailsPanel(): the card's information minus the prompt - deps and
//    dependents (each one selects that node), branch, model / account,
//    progress and ladder lines, the failure block, the recovery ask and the
//    root-blocker chain - with only two actions: "Go to worker tab" and
//    "Show on board". Nothing here launches, retries or kills.
// Every git- or model-derived string goes in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { failureBlock } from './orchestraDetails.js';
import { pkgErrorText, progressText, ladderLines } from './orchestraCardLines.js';
import { downstream, rootBlockers } from './orchestraGraphModel.js';
import { nodeStateText } from './orchestraGraphView.js';
import { elapsedLabel, truncate } from './liveMapHelpers.js';

const TOOLTIP_ERROR_CHARS = 120;
const TOOLTIP_IDS_MAX = 6;
// Matches the board: a worker tab is worth jumping to while it runs or is stalled.
const GOTO_STATES = new Set(['launched', 'finishing', 'stalled']);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Direct dependents of a node (ids, graph order). */
const dependentsOf = (graph, id) => graph.edges.filter((e) => e.from === id).map((e) => e.to);

const idList = (ids) => {
  if (!ids.length) return t('lm.none');
  const shown = ids.slice(0, TOOLTIP_IDS_MAX).join(', ');
  return ids.length > TOOLTIP_IDS_MAX ? `${shown} ${t('lm.more', { n: ids.length - TOOLTIP_IDS_MAX })}` : shown;
};

/** The short error of a package for the tooltip, or ''. */
function shortError(node) {
  const pkg = node.pkg;
  if (!pkg || !node.error) return '';
  const text = pkg.detail ? `${pkgErrorText(node.error)}: ${pkg.detail}` : pkgErrorText(node.error);
  return truncate(text, TOOLTIP_ERROR_CHARS);
}

function stateRow(node) {
  const row = el('div', 'lm-tip__state');
  row.append(el('span', `lm-badge is-${node.visual}`, nodeStateText(node)), el('span', 'lm-tip__id', node.id));
  return row;
}

/**
 * The hover tooltip of a node.
 * @param {object} node a graph node
 * @param {{edges:object[]}} graph
 * @returns {HTMLElement[]}
 */
export function tooltipContent(node, graph) {
  const out = [el('div', 'lm-tip__title', node.title), stateRow(node)];
  if (node.ghost) {
    out.push(el('div', 'lm-tip__row', t('lm.ghost')));
    return out;
  }
  out.push(el('div', 'lm-tip__row', t('lm.tip.deps', { ids: idList(node.dependsOn) })));
  out.push(el('div', 'lm-tip__row', t('lm.tip.dependents', { ids: idList(dependentsOf(graph, node.id)) })));
  const elapsed = elapsedLabel(node.elapsedMs);
  if (elapsed) out.push(el('div', 'lm-tip__row', t('lm.tip.elapsed', { time: t(elapsed.key, elapsed.params) })));
  if (node.visual === 'blocked' && node.waitingOn) out.push(el('div', 'lm-tip__row is-warn', t('lm.node.waitingOn', { id: node.waitingOn })));
  const err = shortError(node);
  if (err) out.push(el('div', 'lm-tip__row is-bad', err));
  return out;
}

/** A row of clickable package ids (each selects that node). */
function idButtons(ids, onSelect) {
  const row = el('div', 'lm-side__ids');
  if (!ids.length) {
    row.append(el('span', 'lm-side__muted', t('lm.none')));
    return row;
  }
  for (const id of ids) {
    const btn = el('button', 'lm-side__id', id);
    btn.type = 'button';
    btn.addEventListener('click', () => onSelect(id));
    row.append(btn);
  }
  return row;
}

function section(label, content) {
  const box = el('div', 'lm-side__section');
  box.append(el('div', 'lm-side__label', label), content);
  return box;
}

/** Branch, model, account: one meta line. */
function metaLine(pkg) {
  const meta = [];
  if (typeof pkg.branch === 'string' && pkg.branch) meta.push(pkg.branch);
  if (typeof pkg.model === 'string' && pkg.model) meta.push(pkg.model);
  if (typeof pkg.account === 'string' && pkg.account) meta.push(t('orch.account.on', { account: pkg.account }));
  return meta.length ? el('div', 'lm-side__meta', meta.join(' · ')) : null;
}

/** The failure block, or the plain error line (the card's own rule). */
function errorBlock(pkg) {
  if (pkg.state === 'failed' && pkg.failure) return failureBlock(pkg.failure, pkgErrorText);
  if (!pkg.error) return null;
  return el('p', 'orchestra__msg is-bad', pkg.detail ? `${pkgErrorText(pkg.error)}: ${pkg.detail}` : pkgErrorText(pkg.error));
}

/** "Blocked by: a -> b -> root (failed)" with every id clickable. */
function blockerChain(graph, node, onSelect) {
  const chain = rootBlockers(graph, node.id);
  if (chain.length < 2) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const row = el('div', 'lm-side__chain');
  chain.slice(1).forEach((id, i) => {
    if (i) row.append(el('span', 'lm-side__arrow', '→'));
    const btn = el('button', 'lm-side__id', id);
    btn.type = 'button';
    btn.addEventListener('click', () => onSelect(id));
    row.append(btn);
  });
  const root = byId.get(chain[chain.length - 1]);
  if (root) row.append(el('span', 'lm-side__muted', `(${nodeStateText(root)})`));
  return section(t('lm.side.rootBlocker'), row);
}

function actionRow(node, ctx) {
  const row = el('div', 'lm-side__actions');
  const pkg = node.pkg;
  if (pkg && typeof pkg.sessionId === 'string' && pkg.sessionId && GOTO_STATES.has(node.state)) {
    const go = el('button', 'pad-send', t('orch.goto'));
    go.type = 'button';
    go.addEventListener('click', () => ctx.onGoto(pkg.sessionId));
    row.append(go);
  }
  const show = el('button', 'pad-send', t('lm.side.showOnBoard'));
  show.type = 'button';
  show.addEventListener('click', () => ctx.onShowOnBoard(node.id));
  row.append(show);
  return row;
}

/**
 * The side panel of the selected node.
 * @param {object} node
 * @param {{graph:object, packages:object[], onSelect:(id:string) => void,
 *   onGoto:(sessionId:string) => void, onShowOnBoard:(id:string) => void, onClose:() => void}} ctx
 * @returns {HTMLElement[]}
 */
export function detailsPanel(node, ctx) {
  const head = el('div', 'lm-side__head');
  const title = el('h3', 'lm-side__title', node.title);
  const close = el('button', 'libraries__closebtn', '×');
  close.type = 'button';
  close.title = t('lm.side.close');
  close.setAttribute('aria-label', t('lm.side.close'));
  close.addEventListener('click', ctx.onClose);
  head.append(title, close);
  const out = [head, stateRow(node)];
  if (node.ghost || !node.pkg) {
    out.push(el('p', 'orchestra__msg is-warn', t('lm.ghost')));
    out.push(section(t('lm.side.dependents'), idButtons(dependentsOf(ctx.graph, node.id), ctx.onSelect)));
    return out;
  }
  const pkg = node.pkg;
  const meta = metaLine(pkg);
  if (meta) out.push(meta);
  out.push(section(t('lm.side.deps'), idButtons(node.dependsOn, ctx.onSelect)));
  out.push(section(t('lm.side.dependents'), idButtons(dependentsOf(ctx.graph, node.id), ctx.onSelect)));
  const below = downstream(ctx.graph, node.id).length;
  if (below) out.push(el('div', 'lm-side__meta', t('lm.side.downstream', { n: below })));
  const progress = progressText(pkg);
  if (progress) out.push(el('div', 'lm-side__meta', progress));
  for (const line of ladderLines(pkg, ctx.packages)) out.push(el('div', 'lm-side__meta', line));
  const err = errorBlock(pkg);
  if (err) out.push(err);
  const ask = node.flags.recoverAsk;
  const folder = pkg.branch ? `.luna-worktrees/.../${String(pkg.branch).split('/').pop()}` : pkg.id;
  if (ask) out.push(el('p', 'orchestra__msg is-bad', t(ask.key, { pkg: pkg.id, dir: folder, branch: pkg.branch || '?' })));
  const chain = blockerChain(ctx.graph, node, ctx.onSelect);
  if (chain) out.push(chain);
  out.push(actionRow(node, ctx));
  return out;
}
