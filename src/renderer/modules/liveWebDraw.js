// ============================================================================
// LunaCore - God Mode Live Web: painting one frame on a Canvas 2D context
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. liveWebView.js owns the loop, the camera and the input;
// this module only paints: edges, nodes (one shape per layer, so a layer
// reads apart without its colour), labels, the overlap glow and the
// travelling particles. Colours come from the theme's CSS tokens
// (readPalette), so every theme restyles the web.
// Text goes on the canvas with fillText only - nothing here builds HTML.
// ============================================================================

'use strict';

import { truncate } from './liveMapHelpers.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';

/** Node radius per layer, in layout units. */
export const NODE_R = Object.freeze({ run: 22, worker: 14, file: 6, process: 7, port: 6, verify: 8, subagent: 6, mcp: 8, memory: 11, more: 12 });
/** At this zoom and above every node has its label; below, only the telling ones do. */
export const LABEL_ZOOM = 0.9;
const LABEL_CHARS = 24;
const WORKER_LABEL_CHARS = 18;
const RING_GAP = 4;
const RING_W = 3;
const GLOW_PAD = 7;
// One overlap glow breath, in ms.
const GLOW_PERIOD_MS = 1600;
const PARTICLE_R = 2.6;
const PARTICLE_HALO_R = 6;
const TRAIL_STEPS = 3;
const TRAIL_GAP = 0.05;
// Paint order: leaves first, the spine on top (the selected node goes last of all).
const PAINT_ORDER = ['more', 'file', 'subagent', 'mcp', 'port', 'process', 'verify', 'memory', 'worker', 'run'];

export const nodeRadius = (node) => NODE_R[node.layer] || 6;

/** The theme's colours and fonts, read from CSS custom properties on `el`. */
export function readPalette(el) {
  let style = null;
  try {
    style = getComputedStyle(el);
  } catch {
    style = null;
  }
  const v = (name, fallback) => {
    const value = style ? style.getPropertyValue(name).trim() : '';
    return value || fallback;
  };
  return {
    text: v('--text', '#e6e6f0'),
    dim: v('--text-dim', '#8a8aa0'),
    edge: v('--edge', '#3a3a50'),
    panel: v('--surface-panel', '#14141c'),
    panel2: v('--surface-panel-2', '#1c1c28'),
    cyan: v('--neon-cyan', '#3ee6ff'),
    magenta: v('--neon-magenta', '#ff4fd8'),
    good: v('--good', '#4ade80'),
    warn: v('--warn', '#fbbf24'),
    bad: v('--bad', '#f87171'),
    fontUi: v('--font-ui', 'system-ui, sans-serif'),
    fontMono: v('--font-mono', 'ui-monospace, monospace'),
  };
}

/** The stroke / fill of a node, by layer and state. */
function colorsOf(node, pal) {
  switch (node.layer) {
    case 'run':
      return { stroke: node.killed ? pal.bad : pal.cyan, fill: pal.panel2 };
    case 'worker': {
      const by = { launched: pal.cyan, finishing: pal.cyan, pushed: pal.good, failed: pal.bad, killed: pal.bad, stalled: pal.warn, closed: pal.dim };
      return { stroke: by[node.state] || pal.dim, fill: pal.panel2 };
    }
    case 'file':
      if (node.overlap) return { stroke: pal.warn, fill: pal.warn };
      return node.changed ? { stroke: pal.magenta, fill: pal.magenta } : { stroke: pal.dim, fill: pal.panel };
    case 'process':
      return node.alive ? { stroke: pal.good, fill: pal.panel2 } : { stroke: pal.dim, fill: pal.panel };
    case 'port':
      if (node.overlap) return { stroke: pal.bad, fill: pal.bad };
      return { stroke: node.alive ? pal.good : pal.dim, fill: pal.panel2 };
    case 'verify':
      return { stroke: node.phase === 'failed' ? pal.bad : node.phase === 'queued' ? pal.warn : pal.cyan, fill: pal.panel2 };
    case 'subagent':
      return { stroke: node.failed ? pal.bad : pal.magenta, fill: pal.panel2 };
    case 'mcp':
      return { stroke: node.workers && node.workers.some((w) => w.failed) ? pal.bad : pal.cyan, fill: pal.panel2 };
    case 'memory':
      return { stroke: pal.magenta, fill: pal.panel2 };
    default:
      return { stroke: pal.dim, fill: pal.panel };
  }
}

function polygon(ctx, x, y, r, sides, rotation) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = rotation + (Math.PI * 2 * i) / sides;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** The outline of a node's shape (one per layer). */
function shapePath(ctx, node, x, y, r) {
  switch (node.layer) {
    case 'process':
      ctx.beginPath();
      ctx.rect(x - r, y - r, r * 2, r * 2);
      return;
    case 'port':
      polygon(ctx, x, y, r * 1.25, 4, 0);
      return;
    case 'verify':
      polygon(ctx, x, y, r * 1.2, 3, -Math.PI / 2);
      return;
    case 'mcp':
      polygon(ctx, x, y, r * 1.1, 5, -Math.PI / 2);
      return;
    case 'memory':
      polygon(ctx, x, y, r, 6, 0);
      return;
    default:
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function contextColor(fraction, pal) {
  if (fraction >= CTX_WARN_HIGH) return pal.bad;
  if (fraction >= CTX_WARN_MID) return pal.warn;
  return pal.good;
}

/** A worker's context ring: the track, then the used share from 12 o'clock. */
function drawContextRing(ctx, node, x, y, r, pal) {
  if (!Number.isFinite(node.context)) return;
  const rr = r + RING_GAP;
  ctx.lineWidth = RING_W;
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = pal.edge;
  ctx.beginPath();
  ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = contextColor(node.context, pal);
  ctx.beginPath();
  ctx.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0, node.context)));
  ctx.stroke();
}

/** The glow under an overlap: breathing while motion is allowed, steady otherwise. */
function drawGlow(ctx, x, y, r, color, time, motion) {
  const breath = motion ? 0.5 + 0.5 * Math.sin((time / GLOW_PERIOD_MS) * Math.PI * 2) : 0.5;
  ctx.globalAlpha = 0.18 + 0.22 * breath;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r + GLOW_PAD + 4 * breath, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Whether a node's label is drawn at this zoom. */
function labelShown(node, f) {
  if (node.id === f.selectedId || node.id === f.hoverId) return true;
  if (node.layer === 'run' || node.layer === 'worker' || node.layer === 'memory' || node.layer === 'more') return true;
  if (node.overlap) return true;
  return f.cam.k >= LABEL_ZOOM;
}

function drawLabel(ctx, node, x, y, r, f) {
  const raw = node.layer === 'run' || node.layer === 'memory' || node.layer === 'more' ? f.labelOf(node) : node.label;
  const text = truncate(raw, node.layer === 'worker' ? WORKER_LABEL_CHARS : LABEL_CHARS);
  if (!text) return;
  const mono = node.layer === 'file' || node.layer === 'port';
  const size = node.layer === 'run' ? 13 : node.layer === 'worker' ? 12 : 11;
  ctx.font = `${mono ? '' : '600 '}${size}px ${mono ? f.pal.fontMono : f.pal.fontUi}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ty = y + r + (node.layer === 'worker' ? RING_GAP + RING_W + 4 : 4);
  // A backing stroke keeps a label readable over edges.
  ctx.lineWidth = 3;
  ctx.strokeStyle = f.pal.panel;
  ctx.strokeText(text, x, ty);
  const strong = node.id === f.selectedId || node.layer === 'run' || node.layer === 'worker';
  ctx.fillStyle = strong ? f.pal.text : f.pal.dim;
  ctx.fillText(text, x, ty);
}

/** The text inside a node: the run's active / total, a summary's +N. */
function drawInner(ctx, node, p, f) {
  if (node.layer !== 'more' && node.layer !== 'run') return;
  ctx.fillStyle = f.pal.text;
  ctx.font = `600 ${node.layer === 'run' ? 12 : 10}px ${f.pal.fontMono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(node.layer === 'run' ? `${node.active}/${node.total}` : `+${node.count}`, p.x, p.y);
}

function drawNode(ctx, node, p, f) {
  const r = nodeRadius(node);
  const { stroke, fill } = colorsOf(node, f.pal);
  const faded = (node.layer === 'process' || node.layer === 'port') && node.alive === false;
  if (node.overlap) drawGlow(ctx, p.x, p.y, r, node.layer === 'port' ? f.pal.bad : f.pal.warn, f.time, f.motion);
  if (node.layer === 'worker' && node.active) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + RING_GAP + RING_W + 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = faded ? 0.45 : 1;
  shapePath(ctx, node, p.x, p.y, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = node.id === f.selectedId ? 3 : node.layer === 'run' ? 2.5 : 1.6;
  ctx.strokeStyle = node.id === f.selectedId ? f.pal.cyan : stroke;
  if (node.layer === 'more') ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  drawInner(ctx, node, p, f);
  if (node.layer === 'worker') drawContextRing(ctx, node, p.x, p.y, r, f.pal);
  if (node.id === f.hoverId && node.id !== f.selectedId) {
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.strokeStyle = f.pal.text;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = faded ? 0.6 : 1;
  if (labelShown(node, f)) drawLabel(ctx, node, p.x, p.y, r, f);
  ctx.globalAlpha = 1;
}

function drawEdges(ctx, f) {
  // The quiet edges in one path, the telling ones (selected, overlap) on top.
  ctx.lineWidth = 1 / Math.max(0.5, f.cam.k);
  ctx.strokeStyle = f.pal.dim;
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  const loud = [];
  for (const e of f.web.edges) {
    const a = f.pos(e.from);
    const b = f.pos(e.to);
    if (!a || !b) continue;
    const target = f.nodes.get(e.to);
    const overlap = !!(target && target.overlap);
    if (overlap || (f.selectedId && (e.from === f.selectedId || e.to === f.selectedId))) {
      loud.push({ a, b, overlap, port: !!(target && target.layer === 'port') });
      continue;
    }
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  for (const l of loud) {
    ctx.globalAlpha = l.overlap ? 0.75 : 0.9;
    ctx.strokeStyle = l.overlap ? (l.port ? f.pal.bad : f.pal.warn) : f.pal.cyan;
    ctx.lineWidth = 1.6 / Math.max(0.5, f.cam.k);
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.lineTo(l.b.x, l.b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Particles: a bright head with a short fading trail along its edge. */
function drawParticles(ctx, f) {
  for (const p of f.particles) {
    const a = f.pos(p.from);
    const b = f.pos(p.to);
    if (!a || !b) continue;
    const color = p.failed ? f.pal.bad : p.reverse ? f.pal.good : f.pal.cyan;
    ctx.fillStyle = color;
    for (let i = TRAIL_STEPS; i >= 0; i -= 1) {
      const t = Math.min(1, Math.max(0, p.progress - i * TRAIL_GAP));
      const s = p.reverse ? 1 - t : t;
      const x = a.x + (b.x - a.x) * s;
      const y = a.y + (b.y - a.y) * s;
      ctx.globalAlpha = i === 0 ? 1 : 0.5 / (i + 1);
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? PARTICLE_R : PARTICLE_R * 0.8, 0, Math.PI * 2);
      ctx.fill();
      if (i === 0) {
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.arc(x, y, PARTICLE_HALO_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Paints one frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{web:{nodes:object[], edges:object[]}, nodes:Map<string, object>, pos:(id:string) => ({x:number,y:number}|null),
 *   cam:{x:number, y:number, k:number}, dpr:number, width:number, height:number, pal:object, time:number,
 *   motion:boolean, selectedId:string|null, hoverId:string|null, labelOf:(node:object) => string,
 *   particles:Array<{from:string, to:string, progress:number, reverse:boolean, failed:boolean}>}} f
 */
export function drawWeb(ctx, f) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, f.width * f.dpr, f.height * f.dpr);
  ctx.setTransform(f.dpr * f.cam.k, 0, 0, f.dpr * f.cam.k, f.dpr * f.cam.x, f.dpr * f.cam.y);
  drawEdges(ctx, f);
  if (f.particles.length) drawParticles(ctx, f);
  const selected = f.selectedId ? f.nodes.get(f.selectedId) : null;
  for (const layer of PAINT_ORDER) {
    for (const node of f.web.nodes) {
      if (node.layer !== layer || node === selected) continue;
      const p = f.pos(node.id);
      if (p) drawNode(ctx, node, p, f);
    }
  }
  if (selected) {
    const p = f.pos(selected.id);
    if (p) drawNode(ctx, selected, p, f);
  }
}
