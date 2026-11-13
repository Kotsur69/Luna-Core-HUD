// ============================================================================
// LunaCore - Live map (Ctrl+Shift+G): the God Mode tab
// ----------------------------------------------------------------------------
// The selected run's packages as a live dependency graph. Read-only: it
// reads the board's data (orchestraBoard.js - chips, viewOf, refresh) and
// repaints on the same orchestra:changed push the board uses; it never
// launches, retries or kills, and never moves the board's own selection.
//
//  - one run at a time: the board's run chips (orchestraSwitcher.js);
//  - toolbar (liveMapToolbar.js): LR / TB, filter, Focus blocked, Critical
//    path, Trace, fit and zoom;
//  - hover = tooltip, click = select + side panel (liveMapDetails.js),
//    double-click = Show on board;
//  - every state has its message: loading, no run, no packages, malformed,
//    one package, done, failed, stopped - and a summary above
//    GRAPH_SUMMARY_LIMIT packages.
// The layout is recomputed only when the graph's shape or the direction
// changes; a state change repaints the existing elements in place.
// ============================================================================

'use strict';

import { t } from './util.js';
import * as board from './orchestraBoard.js';
import { openOrchestra } from './orchestra.js';
import { switcherStrip } from './orchestraSwitcher.js';
import { buildGraph, upstream, downstream, rootBlockers, criticalPath } from './orchestraGraphModel.js';
import { layoutGraph } from './orchestraGraphLayout.js';
import { createGraphView, nodeStateText } from './orchestraGraphView.js';
import { tooltipContent, detailsPanel } from './liveMapDetails.js';
import { createToolbar, summaryPanel } from './liveMapToolbar.js';
import {
  DIRECTIONS, STORAGE_DIR, readPref, writePref, graphStatus, doneSummary, summaryLists, matchesFilter, runChips, elapsedLabel,
} from './liveMapHelpers.js';

// Elapsed hints and "long-stalled" age without a push; a repaint, not a fetch.
const CLOCK_TICK_MS = 30 * 1000;
// How long the located card on the board stays highlighted.
const LOCATE_HIGHLIGHT_MS = 2400;
const TIP_GAP_PX = 10;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const FOCUSABLE = 'button, input, select, a[href], [tabindex="0"]';

/**
 * Swaps a container's content without dropping the reader's place: the
 * focused control (by its position among the focusables) and the scroll
 * position survive, so a live push never throws keyboard focus to <body>.
 */
function replaceKeepingPlace(container, children) {
  const active = document.activeElement;
  const items = () => [...container.querySelectorAll(FOCUSABLE)];
  const index = active && container.contains(active) ? items().indexOf(active) : -1;
  const scroll = container.scrollTop;
  container.replaceChildren(...children);
  container.scrollTop = scroll;
  if (index < 0) return;
  const list = items();
  const target = list[Math.min(index, list.length - 1)];
  if (target) target.focus();
}

/**
 * The God Mode tab. `shell` is the live map's own API ({close}).
 * @param {{close:() => void}} shell
 */
export function createGodModeTab(shell) {
  const s = {
    // The run on screen, and the one Mati picked (kept while it briefly has no view).
    project: undefined,
    chosen: undefined,
    direction: readPref(storage(), STORAGE_DIR, DIRECTIONS, 'LR'),
    query: '',
    focusBlocked: false,
    showPath: false,
    trace: false,
    selectedId: null,
    loading: false,
  };
  let dom = null;
  let graphView = null;
  let graph = null;
  let layout = null;
  let layoutSig = '';
  let fitPending = true;
  let unsubscribe = null;
  let tick = null;
  let frame = 0;
  let hoverId = null;
  let shown = false;
  let inflight = null;
  let sideSig = '';
  let summarySig = '';

  const viewNow = () => (s.project === undefined ? null : board.viewOf(s.project));

  // --- DOM -------------------------------------------------------------------
  function build(panel) {
    const runs = el('div', 'lm-runs');
    const toolbar = createToolbar({
      onDirection: setDirection,
      onQuery: (q) => {
        s.query = q;
        renderSoon();
      },
      onToggle: (key) => {
        if (key === 'blocked') s.focusBlocked = !s.focusBlocked;
        if (key === 'path') s.showPath = !s.showPath;
        if (key === 'trace') s.trace = !s.trace;
        renderSoon();
      },
      onFit: () => graphView && graphView.fit(),
      onZoomIn: () => graphView && graphView.zoomIn(),
      onZoomOut: () => graphView && graphView.zoomOut(),
    });
    const body = el('div', 'lm-gm__body');
    const stage = el('div', 'lm-stage');
    const message = el('div', 'lm-stage__msg');
    message.setAttribute('role', 'status');
    const banner = el('div', 'lm-stage__banner');
    banner.setAttribute('role', 'status');
    const host = el('div', 'lm-stage__graph');
    const summary = el('div', 'lm-stage__summary');
    const tip = el('div', 'lm-tip');
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    stage.append(banner, message, host, summary, tip);
    const side = el('aside', 'lm-side');
    side.hidden = true;
    body.append(stage, side);
    panel.replaceChildren(runs, toolbar.root, body);
    dom = { panel, runs, toolbar, stage, message, banner, host, summary, tip, side };
    graphView = createGraphView(host, { onSelect: select, onOpen: showOnBoard, onHover: hover });
  }

  // --- actions ---------------------------------------------------------------
  function setDirection(dir) {
    if (!DIRECTIONS.includes(dir) || dir === s.direction) return;
    s.direction = dir;
    writePref(storage(), STORAGE_DIR, dir);
    fitPending = true;
    renderSoon();
  }

  function select(id) {
    s.selectedId = id && graph && graph.nodes.some((n) => n.id === id) ? id : null;
    if (!s.selectedId) s.trace = false;
    renderSoon();
  }

  /** A different run on screen: nothing of the old one's view state carries over. */
  function resetRunState() {
    s.selectedId = null;
    s.trace = false;
    fitPending = true;
    layoutSig = '';
  }

  function selectRun(projectId) {
    s.chosen = projectId;
    s.project = projectId;
    resetRunState();
    renderSoon();
  }

  /** Closes the live map and opens the board on this run, scrolled to the card. */
  async function showOnBoard(id) {
    const project = s.project === undefined ? null : s.project;
    shell.close();
    try {
      await openOrchestra(project);
    } catch (err) {
      console.error('[livemap] Show on board: opening the board failed:', err);
      return;
    }
    const cards = document.querySelectorAll('#orchestra-body .orchestra__pkg');
    const card = [...cards].find((c) => {
      const idEl = c.querySelector('.orchestra__id');
      return idEl && idEl.textContent === id;
    });
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('is-located');
    setTimeout(() => card.classList.remove('is-located'), LOCATE_HIGHLIGHT_MS);
  }

  function gotoWorker(sessionId) {
    window.lunacore.activateSession(sessionId);
    shell.close({ focusTerminal: true });
  }

  // --- tooltip ---------------------------------------------------------------
  function hover(id, rect) {
    hoverId = id;
    if (!dom) return;
    const node = id && graph ? graph.nodes.find((n) => n.id === id) : null;
    // A late focus frame after the tab hid must not bring the tooltip back.
    if (!node || !rect || !shown) {
      dom.tip.hidden = true;
      dom.tip.classList.remove('is-visible');
      return;
    }
    dom.tip.replaceChildren(...tooltipContent(node, graph));
    dom.tip.hidden = false;
    const box = dom.stage.getBoundingClientRect();
    const tipW = dom.tip.offsetWidth;
    const tipH = dom.tip.offsetHeight;
    let x = rect.left - box.left;
    let y = rect.bottom - box.top + TIP_GAP_PX;
    if (y + tipH > box.height) y = rect.top - box.top - tipH - TIP_GAP_PX;
    x = Math.max(TIP_GAP_PX, Math.min(x, box.width - tipW - TIP_GAP_PX));
    y = Math.max(TIP_GAP_PX, y);
    dom.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    dom.tip.classList.add('is-visible');
  }

  // --- render ----------------------------------------------------------------
  function renderSoon() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  /** The run to show: the chosen one while it has a view, else the current, the board's, the first. */
  function pickProject(chips) {
    for (const key of [s.chosen, s.project, board.project()]) {
      if (key !== undefined && board.viewOf(key)) return key;
    }
    if (chips.length) return chips[0].projectId;
    if (s.project !== undefined) return s.project;
    const boardProject = board.project();
    return boardProject === undefined ? null : boardProject;
  }

  function renderRuns(chips) {
    const active = document.activeElement;
    const chipFocused = !!(active && dom.runs.contains(active));
    const strip = switcherStrip({ chips, selected: s.project, onSelect: selectRun, focus: chipFocused });
    if (strip || chips.length !== 1) {
      dom.runs.replaceChildren(...(strip ? [strip] : []));
      return;
    }
    // One run: no switch to offer, but still say whose graph this is.
    const only = chips[0];
    const label = el('div', 'lm-runs__single');
    label.append(
      el('span', 'orchestra-runs__label', only.label || only.projectId || t('orch.runs.noProject')),
      el('span', 'orchestra-runs__state', t(`orch.runs.state.${only.state}`)),
    );
    dom.runs.replaceChildren(label);
  }

  /** Nodes the toggles keep bright (intersection of every active one), or null for all. */
  function emphasisOf() {
    const sets = [];
    if (s.query.trim()) sets.push(new Set(graph.nodes.filter((n) => matchesFilter(n, s.query, nodeStateText(n))).map((n) => n.id)));
    if (s.focusBlocked) {
      const keep = new Set();
      for (const n of graph.nodes) if (n.visual === 'blocked') for (const id of rootBlockers(graph, n.id).concat(n.id)) keep.add(id);
      sets.push(keep);
    }
    if (s.trace && s.selectedId) sets.push(new Set([s.selectedId, ...upstream(graph, s.selectedId), ...downstream(graph, s.selectedId)]));
    if (!sets.length) return null;
    return sets.reduce((acc, set) => new Set([...acc].filter((id) => set.has(id))));
  }

  function bannerText(view, status) {
    if (status.banner === 'killed') return { text: t('lm.state.killed'), cls: 'is-bad' };
    if (status.banner === 'failed') return { text: t('lm.state.failed'), cls: 'is-bad' };
    if (status.banner !== 'done') return null;
    const d = doneSummary(view, graph);
    const wall = elapsedLabel(d.wallMs);
    const time = wall ? t('lm.state.doneTime', { time: t(wall.key, wall.params) }) : '';
    return { text: `${t('lm.state.done', { pushed: d.pushed, total: d.total, merged: d.merged })}${time}`, cls: 'is-good' };
  }

  function renderGraph(emphasis, path) {
    const sig = `${s.direction}|${graph.nodes.map((n) => n.id).join(',')}|${graph.edges.map((e) => `${e.from}>${e.to}`).join(',')}`;
    if (sig !== layoutSig) {
      layout = layoutGraph(graph, { direction: s.direction });
      layoutSig = sig;
    }
    graphView.update(graph, layout, { selectedId: s.selectedId, emphasis, path });
    if (fitPending) {
      fitPending = false;
      graphView.fit(layout);
    }
  }

  function renderSide() {
    const node = s.selectedId && graph ? graph.nodes.find((n) => n.id === s.selectedId) : null;
    dom.side.hidden = !node;
    if (!node) {
      dom.side.replaceChildren();
      sideSig = '';
      return;
    }
    const view = viewNow();
    // Rebuilt only when something it shows changed (a push or the clock tick often changes nothing here).
    const sig = JSON.stringify([window.i18n.lang, node.id, node.visual, node.waitingOn, node.pkg, graph.edges.filter((e) => e.from === node.id || e.to === node.id), rootBlockers(graph, node.id)]);
    if (sig === sideSig) return;
    sideSig = sig;
    dom.side.setAttribute('aria-label', t('lm.side.label'));
    replaceKeepingPlace(dom.side, detailsPanel(node, {
      graph,
      packages: view && Array.isArray(view.packages) ? view.packages : [],
      onSelect: select,
      onGoto: gotoWorker,
      onShowOnBoard: showOnBoard,
      onClose: () => select(null),
    }));
  }

  function render() {
    frame = 0;
    if (!dom) return;
    const chips = runChips(board.chips());
    const picked = pickProject(chips);
    // The run changed under us (its view went away): start clean, like a chip click.
    if (s.project !== undefined && picked !== s.project) resetRunState();
    s.project = picked;
    renderRuns(chips);
    const view = viewNow();
    graph = buildGraph(view);
    const status = graphStatus(view, graph, { loading: s.loading });
    if (s.selectedId && !graph.nodes.some((n) => n.id === s.selectedId)) {
      s.selectedId = null;
      s.trace = false;
    }
    const showGraph = status.kind === 'graph';
    const emphasis = showGraph ? emphasisOf() : null;
    const crit = showGraph && s.showPath ? criticalPath(graph) : null;
    let info = crit && crit.ids.length ? t('lm.tb.pathInfo', { n: crit.ids.length, min: Math.round(crit.minutes) }) : '';
    if (emphasis && !emphasis.size) info = t('lm.state.noMatch');
    dom.toolbar.sync({ ...s, enabled: showGraph, info });

    const msgKey = { loading: 'lm.state.loading', noRun: 'lm.state.noRun', malformed: 'lm.state.malformed', noPackages: 'lm.state.noPackages' }[status.kind];
    dom.message.textContent = msgKey ? t(msgKey) : status.single ? t('lm.state.single') : '';
    dom.message.hidden = !dom.message.textContent;
    dom.message.classList.toggle('is-center', !!msgKey);
    const banner = bannerText(view, status);
    dom.banner.hidden = !banner;
    dom.banner.textContent = banner ? banner.text : '';
    dom.banner.className = `lm-stage__banner ${banner ? banner.cls : ''}`.trim();

    dom.host.hidden = !showGraph;
    dom.summary.hidden = status.kind !== 'summary';
    if (status.kind === 'summary') {
      const total = graph.nodes.filter((n) => !n.ghost).length;
      const lists = summaryLists(graph);
      const sig = JSON.stringify([window.i18n.lang, total, lists]);
      if (sig !== summarySig) {
        summarySig = sig;
        replaceKeepingPlace(dom.summary, [summaryPanel(lists, total, select)]);
      }
    } else if (summarySig) {
      summarySig = '';
      dom.summary.replaceChildren();
    }
    if (showGraph) renderGraph(emphasis, crit ? crit.ids : null);
    else layoutSig = '';
    if (hoverId && !graph.nodes.some((n) => n.id === hoverId)) hover(null, null);
    renderSide();
  }

  /** One refresh at a time: a reopen while one runs joins it (two overlapping refreshes could drop a push). */
  function refetch() {
    if (inflight) return inflight;
    s.loading = !viewNow();
    renderSoon();
    inflight = (async () => {
      try {
        await board.refresh();
      } catch (err) {
        // The board's fetchers swallow IPC errors themselves; anything else is a bug worth seeing.
        console.error('[livemap] refreshing the God Mode runs failed:', err);
      } finally {
        inflight = null;
        s.loading = false;
        renderSoon();
      }
    })();
    return inflight;
  }

  // --- the tab contract (liveMap.js registerTab) ------------------------------
  return {
    mount(panel) {
      build(panel);
    },
    unmount() {
      if (graphView) graphView.destroy();
      graphView = null;
      dom = null;
    },
    onShow() {
      shown = true;
      if (!unsubscribe && window.lunacore && window.lunacore.onOrchestraChanged) {
        // orchestra.js's own listener (registered first) has applied it to the board.
        unsubscribe = window.lunacore.onOrchestraChanged(() => renderSoon());
      }
      if (!tick) tick = setInterval(renderSoon, CLOCK_TICK_MS);
      fitPending = true;
      refetch();
    },
    onHide() {
      shown = false;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (tick) clearInterval(tick);
      tick = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (dom) hover(null, null);
    },
    /** Re-renders labels after a language switch. */
    onLang() {
      layoutSig = '';
      sideSig = '';
      summarySig = '';
      renderSoon();
    },
    /**
     * Keys while this tab shows. Esc clears the selection first (true = consumed).
     * @param {KeyboardEvent} e
     */
    onKey(e) {
      if (e.key === 'Escape') {
        if (!s.selectedId) return false;
        const id = s.selectedId;
        select(null);
        if (graphView) graphView.focusNode(id);
        return true;
      }
      const typing = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (typing || e.ctrlKey || e.metaKey || e.altKey || !graphView || dom.host.hidden) return false;
      if (e.key === '+' || e.key === '=') graphView.zoomIn();
      else if (e.key === '-' || e.key === '_') graphView.zoomOut();
      else if (e.key === '0') graphView.fit();
      else return false;
      return true;
    },
  };
}
