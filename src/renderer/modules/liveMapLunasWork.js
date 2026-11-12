// ============================================================================
// LunaCore - Live map (Ctrl+Shift+G): the Luna's Work tab
// ----------------------------------------------------------------------------
// The current run's iteration loop, live: Director -> Build (God Mode) ->
// Playtester -> Critic, the active role, iteration N, the last verdict,
// cards created, the hand-over (wheel) state and the queued projects.
// Clicking the Build station opens that iteration's God Mode package graph
// in the same tab (orchestraGraphModel / Layout / View, read-only); Back or
// Esc returns to the loop.
//
// Read-only and on existing channels only: lunasworkStatus / Dashboard /
// QueueList when the tab shows and (debounced) after a lunaswork:event push,
// whose status is applied at once; the graph reads the God Mode board
// (orchestraBoard.js) and repaints on orchestra:changed while it shows. No
// polling, no timer while hidden, no tokens. Data reaches the DOM through
// textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import * as board from './orchestraBoard.js';
import { buildGraph } from './orchestraGraphModel.js';
import { layoutGraph } from './orchestraGraphLayout.js';
import { createGraphView } from './orchestraGraphView.js';
import { graphStatus } from './liveMapHelpers.js';
import { buildLoopModel, applyLunasworkEvent } from './lunasworkMapModel.js';
import { createLoopView } from './lunasworkMapView.js';

// Same as the dashboard: a burst of phase events refetches once.
const REFRESH_DEBOUNCE_MS = 400;
const GRAPH_MESSAGES = { loading: 'lm.state.loading', noRun: 'lm.state.noRun', malformed: 'lm.state.malformed', noPackages: 'lm.state.noPackages' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const api = () => (typeof window !== 'undefined' && window.lunacore ? window.lunacore : {});

/** One IPC answer, or null when the call is missing or failed (logged, never swallowed silently). */
async function ask(name) {
  const fn = api()[name];
  if (typeof fn !== 'function') return null;
  try {
    return await fn();
  } catch (err) {
    console.error(`[livemap] Luna's Work: ${name} failed:`, err);
    return null;
  }
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function verdictText(v) {
  if (!v) return t('lm.lw.verdict.none');
  return v.final ? t(`lw.verdict.${v.key}`) : t(`lm.lw.verdict.${v.key}`);
}

/** The side panel: verdict, cards, wheel, notices, the project queue. */
function sidePanel(model) {
  const parts = [];
  if (!model.empty) {
    const kpis = el('dl', 'lwm-kpis');
    const kpi = (labelKey, value, tone) => {
      const box = el('div', `lwm-kpi${tone ? ` is-${tone}` : ''}`);
      box.append(el('dt', '', t(labelKey)), el('dd', '', value));
      kpis.append(box);
    };
    kpi('lm.lw.kpi.verdict', verdictText(model.verdict), model.verdict && model.verdict.final ? 'final' : '');
    kpi('lm.lw.kpi.cards', t('lm.lw.cards', { created: model.cardsCreated, closed: model.cardsClosed }));
    kpi('lm.lw.kpi.wheel', t(`lm.lw.wheel.${model.handedOver}`), model.handedOver === 'no' ? '' : 'warn');
    parts.push(kpis);
    const notes = [];
    if (model.waiting) notes.push(t('lm.lw.waiting', { time: clock(model.waiting.until) }) + (model.waiting.reason ? `: ${model.waiting.reason}` : ''));
    if (model.retrying) notes.push(t('lm.lw.retrying', model.retrying));
    if (model.stopRequested) notes.push(t('lm.lw.stopping'));
    for (const n of notes) parts.push(el('p', 'lwm-note', n));
  }
  const queue = el('section', 'lm-side__section');
  queue.append(el('span', 'lm-side__label', t('lm.lw.kpi.queue')));
  if (model.queue.length) {
    const list = el('ol', 'lwm-queue');
    for (const q of model.queue) list.append(el('li', 'lwm-queue__item', q.label));
    queue.append(list);
  } else {
    queue.append(el('span', 'lm-side__muted', t('lm.lw.queueEmpty')));
  }
  parts.push(queue);
  return parts;
}

/** The Luna's Work tab (liveMap.js registerTab). */
export function createLunasWorkTab() {
  let input = { status: null, dashboard: null, queue: null };
  let loaded = false;
  let loadFailed = false;
  let mode = 'loop';
  let dom = null;
  let loopView = null;
  let graphView = null;
  let layoutSig = '';
  let layout = null;
  let fitPending = true;
  let graphLoading = false;
  let selectedId = null;
  let shown = false;
  let frame = 0;
  let seq = 0;
  // Push events applied so far: a refresh that started before one keeps its status.
  let eventCount = 0;
  let boardSeq = 0;
  let refreshTimer = null;
  let unsubEvents = null;
  let unsubBoard = null;
  let sideSig = '';
  let focusAfter = null;
  const labels = new Map();
  let labelsRead = false;

  const renderSoon = () => {
    if (shown && dom && !frame) frame = requestAnimationFrame(render);
  };

  function build(panel) {
    const head = el('div', 'lwm-head');
    const project = el('span', 'lwm-head__project');
    const run = el('span', 'lwm-head__run');
    const chip = el('span', 'lwm-head__chip');
    head.append(project, run, chip);

    const loop = el('div', 'lwm-body');
    const stage = el('div', 'lm-stage lwm-stage');
    const host = el('div', 'lwm-stage__map');
    const message = el('div', 'lm-stage__msg is-center');
    message.setAttribute('role', 'status');
    stage.append(host, message);
    const side = el('aside', 'lm-side lwm-side');
    loop.append(stage, side);

    const drill = el('div', 'lwm-drill');
    drill.hidden = true;
    const bar = el('div', 'lwm-drill__bar');
    const back = el('button', 'lm-tool lwm-drill__back');
    back.type = 'button';
    back.addEventListener('click', backToLoop);
    const title = el('span', 'lwm-drill__title');
    const note = el('span', 'lwm-drill__note');
    bar.append(back, title, note);
    const graphStage = el('div', 'lm-stage');
    const graphHost = el('div', 'lm-stage__graph');
    const graphMsg = el('div', 'lm-stage__msg is-center');
    graphMsg.setAttribute('role', 'status');
    graphStage.append(graphHost, graphMsg);
    drill.append(bar, graphStage);

    panel.classList.add('lwm-panel');
    panel.replaceChildren(head, loop, drill);
    dom = { head, project, run, chip, loop, host, message, side, drill, back, title, note, graphHost, graphMsg };
    loopView = createLoopView(host, { onOpenBuild: openBuild });
    // The graph view is created on the first drill-down (ensureGraphView): an
    // SVG built inside the still-hidden drill-down did not paint once shown.
  }

  /** The package graph view, created once its host is in a displayed subtree. */
  function ensureGraphView() {
    if (!graphView) graphView = createGraphView(dom.graphHost, { onSelect: (id) => { selectedId = id; renderSoon(); } });
    return graphView;
  }

  // --- data ------------------------------------------------------------------
  async function refresh() {
    const mine = ++seq;
    const eventsAtStart = eventCount;
    const [st, dash, queue] = await Promise.all([ask('lunasworkStatus'), ask('lunasworkDashboard'), ask('lunasworkQueueList')]);
    // A newer refresh started meanwhile: its answer wins.
    if (mine !== seq) return;
    const statusOk = !!(st && st.ok);
    const next = { ...input };
    // A push event that landed while this was in flight carries a newer status.
    if (statusOk && eventCount === eventsAtStart) next.status = st.status;
    if (dash && dash.ok) next.dashboard = dash.dashboard || null;
    if (queue && queue.ok) next.queue = queue.queue;
    // Failed with nothing to show: say so on every attempt, never "no run".
    loadFailed = !statusOk && !next.status;
    loaded = true;
    input = next;
    renderSoon();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  }

  function onEvent(event) {
    const next = applyLunasworkEvent(input, event);
    if (next === input) return;
    eventCount += 1;
    input = next;
    loadFailed = false;
    renderSoon();
    scheduleRefresh();
  }

  /** Project names, read once; a failed read is retried on the next show. */
  async function readLabels() {
    if (labelsRead) return;
    labelsRead = true;
    const res = await ask('getProjects');
    if (!res || !Array.isArray(res.projects)) {
      labelsRead = false;
      return;
    }
    for (const p of res.projects) {
      if (p && typeof p.id === 'string') labels.set(p.id, typeof p.label === 'string' && p.label ? p.label : p.id);
    }
    renderSoon();
  }

  // --- drill-down ------------------------------------------------------------
  function watchBoard() {
    if (unsubBoard || typeof api().onOrchestraChanged !== 'function') return;
    // orchestra.js's own listener (registered first) has applied it to the board.
    unsubBoard = api().onOrchestraChanged(() => renderSoon());
  }

  function unwatchBoard() {
    if (unsubBoard) unsubBoard();
    unsubBoard = null;
  }

  /** Re-reads the God Mode board for the run's project; only the latest read ends the loading state. */
  async function refreshBoard() {
    const mine = ++boardSeq;
    const project = buildLoopModel(input).project;
    graphLoading = !!project && !board.viewOf(project);
    renderSoon();
    if (!project) return;
    try {
      await board.refresh();
    } catch (err) {
      console.error('[livemap] Luna\'s Work: refreshing the God Mode runs failed:', err);
    } finally {
      if (mine === boardSeq) {
        graphLoading = false;
        renderSoon();
      }
    }
  }

  function openBuild() {
    if (mode === 'build') return;
    mode = 'build';
    fitPending = true;
    layoutSig = '';
    selectedId = null;
    focusAfter = 'back';
    watchBoard();
    refreshBoard();
  }

  function backToLoop() {
    if (mode !== 'build') return;
    mode = 'loop';
    unwatchBoard();
    focusAfter = 'build';
    renderSoon();
  }

  function renderDrill(model) {
    dom.back.textContent = `‹ ${t('lm.lw.back')}`;
    dom.title.textContent = t('lm.lw.graphTitle', { n: model.iteration });
    dom.note.textContent = t('lm.lw.graphNote');
    const view = model.project ? board.viewOf(model.project) : null;
    const graph = buildGraph(view);
    const status = graphStatus(view, graph, { loading: graphLoading });
    let msg = '';
    if (!model.project) msg = t('lm.lw.graphNoProject');
    else if (status.kind === 'summary') msg = t('lm.lw.graphTooBig', { n: graph.nodes.filter((n) => !n.ghost).length });
    else if (GRAPH_MESSAGES[status.kind]) msg = t(GRAPH_MESSAGES[status.kind]);
    dom.graphMsg.textContent = msg;
    dom.graphMsg.hidden = !msg;
    const showGraph = !msg && status.kind === 'graph';
    dom.graphHost.hidden = !showGraph;
    if (!showGraph) {
      layoutSig = '';
      layout = null;
      return;
    }
    if (selectedId && !graph.nodes.some((n) => n.id === selectedId)) selectedId = null;
    const sig = `${graph.nodes.map((n) => n.id).join(',')}|${graph.edges.map((e) => `${e.from}>${e.to}`).join(',')}`;
    if (sig !== layoutSig || !layout) {
      layout = layoutGraph(graph, { direction: 'LR' });
      layoutSig = sig;
    }
    const gv = ensureGraphView();
    gv.update(graph, layout, { selectedId });
    if (fitPending) {
      fitPending = false;
      gv.fit(layout);
    }
  }

  // --- render ----------------------------------------------------------------
  function renderHead(model) {
    const name = model.project ? labels.get(model.project) || model.project : '';
    dom.project.textContent = name;
    dom.run.textContent = model.runId ? t('lm.lw.run', { id: model.runId }) : '';
    let chip = '';
    if (!model.empty) chip = model.active ? t('lm.lw.live') : t('lm.lw.ended');
    dom.chip.textContent = chip;
    dom.chip.className = `lwm-head__chip${model.active ? ' is-live' : ''}`;
    dom.chip.hidden = !chip;
  }

  function renderLoop(model) {
    let msg = '';
    if (!loaded) msg = t('lm.lw.loading');
    else if (loadFailed) msg = t('lm.lw.loadFailed');
    else if (model.empty) msg = t('lm.lw.noRun');
    dom.message.textContent = msg;
    dom.message.hidden = !msg;
    dom.host.hidden = !!msg;
    if (!msg) loopView.update(model);
    const sig = JSON.stringify([window.i18n.lang, model.empty, model.verdict, model.cardsCreated, model.cardsClosed, model.handedOver, model.queue, model.waiting, model.retrying, model.stopRequested]);
    if (sig !== sideSig) {
      sideSig = sig;
      dom.side.replaceChildren(...sidePanel(model));
    }
    dom.side.setAttribute('aria-label', t('lm.lw.sideLabel'));
  }

  function render() {
    frame = 0;
    if (!dom || !shown) return;
    const model = buildLoopModel(input);
    // The run went away under the drill-down: back to the loop's own message.
    if (mode === 'build' && model.empty) backToLoop();
    renderHead(model);
    dom.loop.hidden = mode !== 'loop';
    dom.drill.hidden = mode !== 'build';
    if (mode === 'build') renderDrill(model);
    else renderLoop(model);
    if (focusAfter === 'back') dom.back.focus();
    else if (focusAfter === 'build') loopView.focusBuild();
    focusAfter = null;
  }

  // --- the tab contract (liveMap.js registerTab) ------------------------------
  return {
    mount(panel) {
      build(panel);
    },
    unmount() {
      if (loopView) loopView.destroy();
      if (graphView) graphView.destroy();
      loopView = null;
      graphView = null;
      dom = null;
    },
    onShow() {
      shown = true;
      if (!unsubEvents && typeof api().onLunasworkEvent === 'function') unsubEvents = api().onLunasworkEvent(onEvent);
      if (mode === 'build') {
        watchBoard();
        fitPending = true;
        // The board may have moved on while the overlay was closed.
        refreshBoard();
      }
      readLabels();
      refresh();
      renderSoon();
    },
    onHide() {
      shown = false;
      if (unsubEvents) unsubEvents();
      unsubEvents = null;
      unwatchBoard();
      clearTimeout(refreshTimer);
      refreshTimer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    onLang() {
      sideSig = '';
      renderSoon();
    },
    /**
     * Esc leaves the package graph first (true = consumed); + / - / 0 zoom it.
     * @param {KeyboardEvent} e
     */
    onKey(e) {
      if (mode !== 'build') return false;
      if (e.key === 'Escape') {
        backToLoop();
        return true;
      }
      const typing = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (typing || e.ctrlKey || e.metaKey || e.altKey || !graphView || dom.graphHost.hidden) return false;
      if (e.key === '+' || e.key === '=') graphView.zoomIn();
      else if (e.key === '-' || e.key === '_') graphView.zoomOut();
      else if (e.key === '0') graphView.fit();
      else return false;
      return true;
    },
  };
}
