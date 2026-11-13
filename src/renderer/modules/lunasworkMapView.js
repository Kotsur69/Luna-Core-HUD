// ============================================================================
// LunaCore - Live map, Luna's Work tab: the iteration loop (SVG view)
// ----------------------------------------------------------------------------
// Draws a loop model (lunasworkMapModel.js) as stations on a ring - Director
// -> Build (God Mode) -> Playtester -> Critic (-> Second opinion) and back -
// with arrows along the ring, the iteration number, phase and milestone in
// the middle, and next to each station what it did in the last iteration.
//
//  - Elements are built once per station set (four, or five with the second
//    opinion) and repainted in place; the caller batches update() calls to
//    one animation frame.
//  - The Build station is a button (click, Enter, Space): it opens that
//    iteration's package graph (handlers.onOpenBuild). The others are
//    labelled images; their state is text, never colour alone.
//  - The active station breathes (CSS, lunasworkmap.css), only when motion
//    is allowed; otherwise it is highlighted and still.
//  - Data reaches the DOM through textContent / setAttribute only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { truncate } from './liveMapHelpers.js';
import { stationLayout } from './workmap.js';

export const LOOP_VIEW = Object.freeze({ w: 960, h: 560 });
export const LOOP_CENTER = Object.freeze({ x: 480, y: 280 });
export const LOOP_R = 190;
export const LOOP_STATION_R = 52;
// Clearance between an arrow's ends and the station discs, along the ring.
const ARC_CLEARANCE = 14;
const MILESTONE_CHARS = 34;
const RESULT_CHARS = 30;
const SVG_NS = 'http://www.w3.org/2000/svg';
let viewSeq = 0;

const round2 = (n) => Math.round(n * 100) / 100;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * The arrow along the ring from one station to the next (clockwise), as an
 * SVG path; it starts and ends clear of both discs.
 * @param {number} fromDeg angle of the station it leaves
 * @param {number} toDeg angle of the station it reaches
 * @param {{cx?:number, cy?:number, r?:number, stationR?:number}} [opts]
 * @returns {string}
 */
export function loopArc(fromDeg, toDeg, opts = {}) {
  const cx = Number.isFinite(opts.cx) ? opts.cx : LOOP_CENTER.x;
  const cy = Number.isFinite(opts.cy) ? opts.cy : LOOP_CENTER.y;
  const r = Number.isFinite(opts.r) ? opts.r : LOOP_R;
  const stationR = Number.isFinite(opts.stationR) ? opts.stationR : LOOP_STATION_R;
  const gapDeg = (((stationR + ARC_CLEARANCE) / r) * 180) / Math.PI;
  let end = toDeg;
  while (end <= fromDeg) end += 360;
  const a = fromDeg + gapDeg;
  const b = Math.max(a, end - gapDeg);
  const large = b - a > 180 ? 1 : 0;
  const p = (deg) => `${round2(cx + r * Math.cos(rad(deg)))},${round2(cy + r * Math.sin(rad(deg)))}`;
  return `M${p(a)} A${r},${r} 0 ${large} 1 ${p(b)}`;
}

/**
 * Where a station's result line goes: outside the ring, clear of the arrows
 * that leave and reach it - above / below a top or bottom station, beside a
 * side one (anchored away from the ring).
 * @param {{x:number, y:number}} pos
 * @returns {{x:number, y:number, anchor:'start'|'middle'|'end'}}
 */
export function resultLabelPos(pos) {
  const dx = pos.x - LOOP_CENTER.x;
  const dy = pos.y - LOOP_CENTER.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return { x: pos.x, y: dy < 0 ? pos.y - LOOP_STATION_R - 14 : pos.y + LOOP_STATION_R + 22, anchor: 'middle' };
  }
  const side = dx > 0 ? 1 : -1;
  return { x: round2(pos.x + side * (LOOP_STATION_R + 16)), y: pos.y + 4, anchor: side > 0 ? 'start' : 'end' };
}

function svg(tag, cls, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const setText = (node, value) => {
  if (node.textContent !== value) node.textContent = value;
};
const setAttr = (node, key, value) => {
  const v = String(value);
  if (node.getAttribute(key) !== v) node.setAttribute(key, v);
};

/** The localized line for a station's last result, or ''. */
function resultText(result) {
  if (!result) return '';
  const main = result.key === 'score' ? '' : t(`lm.lw.result.${result.key}`, { n: result.n });
  const score = Number.isFinite(result.score) ? t('lm.lw.result.score', { score: result.score }) : '';
  return [main, score].filter(Boolean).join(' · ');
}

function buildStation(key, pos) {
  const isBuild = key === 'build';
  const g = svg('g', `lwm-station is-${key}`, isBuild ? { role: 'button', tabindex: 0 } : { role: 'img' });
  const title = svg('title');
  const halo = svg('circle', 'lwm-station__halo', { cx: pos.x, cy: pos.y, r: LOOP_STATION_R + 8 });
  const disc = svg('circle', 'lwm-station__disc', { cx: pos.x, cy: pos.y, r: LOOP_STATION_R });
  const name = svg('text', 'lwm-station__name', { x: pos.x, y: pos.y - 4 });
  const state = svg('text', 'lwm-station__state', { x: pos.x, y: pos.y + 16 });
  const at = resultLabelPos(pos);
  const result = svg('text', 'lwm-station__result', { x: at.x, y: at.y, 'text-anchor': at.anchor });
  g.append(title, halo, disc, name, state, result);
  const parts = { g, title, name, state, result, link: null };
  if (isBuild) {
    // The drill-down's affordance, inside the disc's lower edge.
    const link = svg('text', 'lwm-station__link', { x: pos.x, y: pos.y + 34 });
    g.append(link);
    parts.link = link;
  }
  return parts;
}

function buildCentre(arrowId) {
  const g = svg('g', 'lwm-centre');
  const ring = svg('circle', 'lwm-ring', { cx: LOOP_CENTER.x, cy: LOOP_CENTER.y, r: LOOP_R });
  const iter = svg('text', 'lwm-centre__iter', { x: LOOP_CENTER.x, y: LOOP_CENTER.y - 8 });
  const phase = svg('text', 'lwm-centre__phase', { x: LOOP_CENTER.x, y: LOOP_CENTER.y + 18 });
  const milestone = svg('text', 'lwm-centre__milestone', { x: LOOP_CENTER.x, y: LOOP_CENTER.y + 40 });
  const defs = svg('defs');
  const marker = svg('marker', '', { id: arrowId, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' });
  marker.append(svg('path', 'lwm-arrow', { d: 'M0,0 L10,5 L0,10 z' }));
  defs.append(marker);
  g.append(ring, iter, phase, milestone);
  return { g, defs, iter, phase, milestone };
}

/**
 * Mounts a loop view into `host`.
 * @param {HTMLElement} host
 * @param {{onOpenBuild?: () => void}} [handlers]
 * @returns {{update:(model:object) => void, focusBuild:() => void, destroy:() => void}}
 */
export function createLoopView(host, handlers = {}) {
  viewSeq += 1;
  const arrowId = `lwm-arrow-${viewSeq}`;
  const root = svg('svg', 'lwm-map', { viewBox: `0 0 ${LOOP_VIEW.w} ${LOOP_VIEW.h}`, preserveAspectRatio: 'xMidYMid meet', role: 'group' });
  const centre = buildCentre(arrowId);
  const arcLayer = svg('g', 'lwm-arcs', { 'aria-hidden': 'true' });
  const stationLayer = svg('g', 'lwm-stations');
  root.append(centre.defs, centre.g, arcLayer, stationLayer);
  host.append(root);

  let keysSig = '';
  let stations = new Map();
  let arcs = [];

  /** Rebuilds the stations and arrows; only when the set of stations changes. */
  function layout(keys) {
    const sig = keys.join(',');
    if (sig === keysSig) return;
    keysSig = sig;
    const positions = stationLayout(keys, { cx: LOOP_CENTER.x, cy: LOOP_CENTER.y, r: LOOP_R });
    stations = new Map(positions.map((pos) => [pos.id, buildStation(pos.id, pos)]));
    stationLayer.replaceChildren(...[...stations.values()].map((s) => s.g));
    arcs = positions.map((pos, i) => {
      const next = positions[(i + 1) % positions.length];
      const path = svg('path', 'lwm-arc', { d: loopArc(pos.angleDeg, next.angleDeg), 'marker-end': `url(#${arrowId})` });
      return { path, to: next.id };
    });
    arcLayer.replaceChildren(...arcs.map((a) => a.path));
  }

  function paintStation(role, parts) {
    const name = t(`lm.lw.role.${role.key}`);
    const stateText = t(`lm.lw.state.${role.state}`);
    const result = truncate(resultText(role.lastResult), RESULT_CHARS);
    setText(parts.name, name);
    setText(parts.state, stateText);
    setText(parts.result, result);
    const tone = role.lastResult ? role.lastResult.tone : 'dim';
    setAttr(parts.g, 'class', `lwm-station is-${role.key} is-${role.state}`);
    setAttr(parts.result, 'class', `lwm-station__result is-${tone}`);
    const label = t('lm.lw.stationAria', { role: name, state: stateText, result: result || '-' });
    setAttr(parts.g, 'aria-label', parts.link ? `${label}. ${t('lm.lw.openGraph')}` : label);
    setText(parts.title, parts.link ? t('lm.lw.openGraph') : name);
    if (parts.link) setText(parts.link, `${t('lm.lw.graphLink')} ›`);
  }

  function paintCentre(model) {
    setText(centre.iter, t('lm.lw.iteration', { n: model.iteration }));
    let phase = '';
    if (model.stage === 'other') phase = t('lm.lw.phaseOther');
    else if (model.phase) phase = t(`lw.phase.${model.phase}`);
    setText(centre.phase, phase);
    setText(centre.milestone, model.milestone ? truncate(model.milestone, MILESTONE_CHARS) : '');
  }

  const onActivate = (e) => {
    const g = e.target instanceof Element ? e.target.closest('.lwm-station.is-build') : null;
    if (!g) return;
    if (e.type === 'keydown') {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
    }
    if (handlers.onOpenBuild) handlers.onOpenBuild();
  };
  root.addEventListener('click', onActivate);
  root.addEventListener('keydown', onActivate);

  return {
    /** Paints the model now (the caller is already inside its animation frame). */
    update(model) {
      const roles = Array.isArray(model.roles) ? model.roles : [];
      layout(roles.map((r) => r.key));
      for (const role of roles) paintStation(role, stations.get(role.key));
      for (const arc of arcs) setAttr(arc.path, 'class', `lwm-arc${arc.to === model.activeRole ? ' is-current' : ''}`);
      paintCentre(model);
      setAttr(root, 'aria-label', t('lm.lw.label'));
    },
    focusBuild() {
      const build = stations.get('build');
      if (build) build.g.focus();
    },
    destroy() {
      root.removeEventListener('click', onActivate);
      root.removeEventListener('keydown', onActivate);
      root.remove();
      stations.clear();
      arcs = [];
    },
  };
}
