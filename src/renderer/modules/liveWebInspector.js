// ============================================================================
// LunaCore - God Mode Live Web: the inspector (read-only side panel)
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. What the Live Web shows about its selected node, one
// section per layer: a worker's state, model, context and calls; a file's
// workers and whether they clash; a process, a port, a verify run, a
// subagent, an MCP server, the Luna Core Memory calls, a "+N" summary.
// Nothing here launches, retries or kills. The only actions:
//   Go to worker tab   activates the worker's terminal tab
//   Show on board      opens the #orchestra board at the package's card
//   Show diff          a file's diff in #filediff-modal (activefiles.js),
//                      one button per worker that touched it
// The host passes them in (ctx.actions), so this module imports no overlay.
// Every string reaches the DOM through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { MEMORY_CALLS } from './workmapmodel.js';
import { formatLines } from './workmapSatellites.js';

const PATH_CHARS = 120;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, cls = 'pad-send') {
  const btn = el('button', cls, text);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function section(label, ...content) {
  const box = el('div', 'lm-side__section');
  box.append(el('div', 'lm-side__label', label), ...content);
  return box;
}

const meta = (text) => el('div', 'lm-side__meta', text);

/** What one node of a layer is ('File'), for the inspector badge and the tooltip. */
export const layerName = (layer) => t(`lm.web.layer.${layer}`);
/** A whole layer ('Files'), for the filter toggles and the "+N" summaries. */
export const filterName = (layer) => t(`lm.web.filter.${layer}`);

/**
 * The label a node draws when the model left it to the view (run, memory, summaries).
 * @param {object} node
 * @returns {string}
 */
export function webLabel(node) {
  if (node.layer === 'run') return node.label || t('lm.web.runDefault');
  if (node.layer === 'memory') return t('lm.web.layer.memory');
  if (node.layer === 'more') return t('lm.web.moreLabel', { n: node.count, layer: filterName(node.moreOf) });
  return node.label || '';
}

/** The worker a package id names, as a button that selects it in the web. */
function workerChip(pkgId, ctx) {
  const id = `w:${pkgId}`;
  return ctx.nodes.has(id) ? button(pkgId, () => ctx.onSelect(id), 'lm-side__id') : el('span', 'lm-side__muted', pkgId);
}

function workerOf(node, ctx) {
  return node.pkgId ? ctx.nodes.get(`w:${node.pkgId}`) || null : null;
}

/** "Go to worker tab" when the worker has a live tab. */
function gotoButton(worker, ctx) {
  if (!worker || !worker.sessionId || !worker.hasTab) return null;
  return button(t('orch.goto'), () => ctx.actions.gotoWorker(worker.sessionId));
}

function actions(...buttons) {
  const row = el('div', 'lm-side__actions');
  row.append(...buttons.filter(Boolean));
  return row.childElementCount ? row : null;
}

// ---- per layer ------------------------------------------------------------------

function runBody(node) {
  return [meta(t('lm.web.runTally', { active: node.active, pushed: node.pushed, failed: node.failed, total: node.total }))];
}

function workerBody(node, ctx) {
  const out = [el('div', 'lm-side__meta', t(`orch.state.${node.stateKey}`))];
  const facts = [node.model, node.branch].filter(Boolean);
  if (facts.length) out.push(meta(facts.join(' · ')));
  if (!node.hasTab) out.push(meta(t('lm.web.noTab')));
  else {
    out.push(meta(Number.isFinite(node.context) ? t('lm.web.context', { pct: Math.round(node.context * 100) }) : t('lm.web.contextNone')));
    const calls = [t('lm.web.calls', { n: node.calls })];
    if (node.running) calls.push(t('lm.wm.running', { n: node.running }));
    if (node.failed) calls.push(t('lm.wm.failed', { n: node.failed }));
    out.push(meta(calls.join(' · ')));
  }
  if (node.error) out.push(el('p', 'orchestra__msg is-bad', node.error));
  out.push(actions(gotoButton(node, ctx), button(t('lm.side.showOnBoard'), () => ctx.actions.showOnBoard(node.pkgId))));
  return out;
}

function fileBody(node, ctx) {
  const out = [el('div', 'lm-side__meta lw-path', node.path.length > PATH_CHARS ? `…${node.path.slice(-PATH_CHARS)}` : node.path)];
  if (node.overlap) out.push(el('p', 'orchestra__msg is-warn', t('lm.web.overlapFile', { n: node.workers.filter((w) => w.changed).length })));
  const list = el('div', 'lw-rows');
  for (const w of node.workers) {
    const row = el('div', 'lw-row');
    const what = [t(w.changed ? 'lm.web.fileChanged' : 'lm.web.fileRead'), formatLines(w.added, w.removed), w.calls ? t('lm.web.calls', { n: w.calls }) : '']
      .filter(Boolean)
      .join(' · ');
    row.append(workerChip(w.pkgId, ctx), el('span', 'lw-row__text', what));
    list.append(row);
  }
  out.push(section(t('lm.web.workers'), list));
  const diffs = node.workers
    .filter((w) => w.sessionId)
    .map((w) => button(node.workers.length > 1 ? t('lm.web.showDiffOf', { pkg: w.pkgId }) : t('lm.web.showDiff'), () => ctx.actions.showDiff(node.path, w.sessionId)));
  out.push(actions(...diffs));
  return out;
}

function processBody(node, ctx) {
  const out = [meta(t('lm.web.pid', { pid: node.pid })), el('div', 'lm-side__meta lw-path', node.command)];
  if (node.ports.length) out.push(meta(t('lm.wm.sat.ports', { list: node.ports.join(', ') })));
  out.push(meta(t(node.alive ? 'lm.wm.sat.alive' : 'lm.wm.sat.gone')));
  out.push(section(t('lm.web.layer.worker'), workerChip(node.pkgId, ctx)));
  out.push(actions(gotoButton(workerOf(node, ctx), ctx)));
  return out;
}

function portBody(node, ctx) {
  const out = [];
  const live = new Set(node.holders.filter((h) => h.alive).map((h) => h.sessionId));
  if (node.overlap) out.push(el('p', 'orchestra__msg is-bad', t('lm.web.overlapPort', { port: node.port, n: live.size })));
  const list = el('div', 'lw-rows');
  for (const h of node.holders) {
    const row = el('div', 'lw-row');
    row.append(workerChip(h.pkgId, ctx), el('span', 'lw-row__text', `${h.name} · ${t('lm.web.pid', { pid: h.pid })} · ${t(h.alive ? 'lm.wm.sat.alive' : 'lm.wm.sat.gone')}`));
    list.append(row);
  }
  out.push(section(t('lm.web.holders'), list));
  return out;
}

function verifyBody(node, ctx) {
  const phase = node.phase === 'failed' ? t('lm.web.verifyFailed') : t(node.phase === 'queued' ? 'orch.state.waitingVerify' : 'orch.state.finishing');
  const out = [el('div', `lm-side__meta${node.phase === 'failed' ? ' is-bad' : ''}`, phase)];
  if (node.rounds) out.push(meta(t('lm.web.verifyRounds', { n: node.rounds })));
  if (node.tail) out.push(el('div', 'lm-side__meta lw-path', node.tail));
  out.push(section(t('lm.web.layer.worker'), workerChip(node.pkgId, ctx)));
  out.push(actions(gotoButton(workerOf(node, ctx), ctx), button(t('lm.side.showOnBoard'), () => ctx.actions.showOnBoard(node.pkgId))));
  return out;
}

function subagentBody(node, ctx) {
  const calls = [t('lm.web.calls', { n: node.calls })];
  if (node.failed) calls.push(t('lm.wm.failed', { n: node.failed }));
  return [meta(calls.join(' · ')), section(t('lm.web.layer.worker'), workerChip(node.pkgId, ctx)), actions(gotoButton(workerOf(node, ctx), ctx))];
}

function perWorker(node, ctx, textOf) {
  const list = el('div', 'lw-rows');
  for (const w of node.workers) {
    const row = el('div', 'lw-row');
    row.append(workerChip(w.pkgId, ctx), el('span', 'lw-row__text', textOf(w)));
    list.append(row);
  }
  return section(t('lm.web.workers'), list);
}

function mcpBody(node, ctx) {
  return [perWorker(node, ctx, (w) => [t('lm.web.calls', { n: w.calls }), w.failed ? t('lm.wm.failed', { n: w.failed }) : ''].filter(Boolean).join(' · '))];
}

function memoryBody(node, ctx) {
  const text = (w) => MEMORY_CALLS.filter((k) => w.calls[k] > 0).map((k) => t(`lm.wm.mem.${k}`, { n: w.calls[k] })).join(' · ');
  return [perWorker(node, ctx, text)];
}

function moreBody(node, ctx) {
  return [meta(t('lm.web.moreHint', { n: node.count, layer: filterName(node.moreOf), cap: ctx.cap }))];
}

const BODIES = {
  run: runBody,
  worker: workerBody,
  file: fileBody,
  process: processBody,
  port: portBody,
  verify: verifyBody,
  subagent: subagentBody,
  mcp: mcpBody,
  memory: memoryBody,
  more: moreBody,
};

/**
 * The side panel of the selected node.
 * @param {object} node a Live Web node
 * @param {{nodes:Map<string, object>, cap:number, onSelect:(id:string) => void, onClose:() => void,
 *   actions:{gotoWorker:(sessionId:string) => void, showOnBoard:(pkgId:string) => void, showDiff:(path:string, sessionId:string) => void}}} ctx
 * @returns {HTMLElement[]}
 */
export function inspectorContent(node, ctx) {
  const head = el('div', 'lm-side__head');
  const title = el('h3', 'lm-side__title', node.layer === 'worker' ? node.title : webLabel(node));
  const close = button('×', ctx.onClose, 'libraries__closebtn');
  close.title = t('lm.side.close');
  close.setAttribute('aria-label', t('lm.side.close'));
  head.append(title, close);
  const kind = el('div', 'lm-tip__state');
  kind.append(el('span', `lm-badge lw-badge is-${node.layer}`, layerName(node.layer)));
  if (node.layer === 'worker') kind.append(el('span', 'lm-tip__id', node.pkgId));
  const body = (BODIES[node.layer] || (() => []))(node, ctx);
  return [head, kind, ...body.filter(Boolean)];
}
