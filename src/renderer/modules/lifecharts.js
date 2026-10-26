// ============================================================================
// LunaCore - Life dashboard: small inline-SVG charts (renderer)
// ----------------------------------------------------------------------------
// No chart library: a donut and a stacked-bar trend are a few dozen lines of
// SVG, inherit the theme through CSS variables and need no CSP exception.
// Every chart carries role="img" + an aria-label summary, and the views that
// use them also print the numbers as text (legend / table), so nothing is
// readable from colour alone.
// ============================================================================

'use strict';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function titled(node, text) {
  const tip = svgEl('title');
  tip.textContent = text;
  node.append(tip);
  return node;
}

function svgRoot(w, h, label) {
  return titled(svgEl('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label, class: 'life-chart' }), label);
}

/**
 * A donut of `slices` [{label, amount, color}] with `center` text (big) and
 * `sub` (small) in the hole. Zero slices are skipped.
 */
export function donut(slices, { center = '', sub = '', label = '' } = {}) {
  const size = 200;
  const mid = size / 2;
  const r = 78;
  const stroke = 26;
  const c = 2 * Math.PI * r;
  const svg = svgRoot(size, size, label);
  svg.classList.add('life-chart--donut');
  svg.append(svgEl('circle', { cx: mid, cy: mid, r, fill: 'none', class: 'life-chart__track', 'stroke-width': stroke }));
  const total = slices.reduce((s, x) => s + Math.max(0, x.amount), 0);
  let offset = 0;
  for (const s of slices) {
    if (!(s.amount > 0) || !total) continue;
    const len = (s.amount / total) * c;
    const arc = svgEl('circle', {
      cx: mid,
      cy: mid,
      r,
      fill: 'none',
      stroke: s.color,
      'stroke-width': stroke,
      // A 1.5px gap between slices keeps neighbours apart without a border.
      'stroke-dasharray': `${Math.max(0, len - 1.5)} ${c}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${mid} ${mid})`,
    });
    svg.append(titled(arc, s.label));
    offset += len;
  }
  const big = svgEl('text', { x: mid, y: mid + 2, 'text-anchor': 'middle', class: 'life-chart__center' });
  big.textContent = center;
  const small = svgEl('text', { x: mid, y: mid + 24, 'text-anchor': 'middle', class: 'life-chart__sub' });
  small.textContent = sub;
  svg.append(big, small);
  return svg;
}

/**
 * Stacked bars, one per row: rows [{label, values: {key: n}}], series
 * [{key, color, label}]. `line` (optional number) draws a dashed reference
 * across, e.g. monthly income. `fmt` formats the top-of-bar total;
 * `highlight` is the index of the bar to mark as the viewed one.
 */
export function stackedBars(rows, series, { line = 0, fmt = String, label = '', highlight = -1 } = {}) {
  const w = 640;
  const h = 220;
  const pad = { l: 8, r: 8, t: 22, b: 26 };
  const svg = svgRoot(w, h, label);
  svg.classList.add('life-chart--bars');
  const totals = rows.map((r) => series.reduce((s, x) => s + (r.values[x.key] || 0), 0));
  const max = Math.max(1, line, ...totals) * 1.08;
  const plotH = h - pad.t - pad.b;
  const slot = (w - pad.l - pad.r) / Math.max(1, rows.length);
  const bw = Math.min(46, slot * 0.62);
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  svg.append(svgEl('line', { x1: pad.l, x2: w - pad.r, y1: y(0), y2: y(0), class: 'life-chart__axis' }));
  rows.forEach((r, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    let acc = 0;
    for (const s of series) {
      const v = r.values[s.key] || 0;
      if (v <= 0) continue;
      const rect = svgEl('rect', { x, y: y(acc + v), width: bw, height: Math.max(0.5, y(acc) - y(acc + v)), fill: s.color, rx: 2 });
      svg.append(titled(rect, `${r.label} · ${s.label}: ${fmt(v)}`));
      acc += v;
    }
    if (totals[i] > 0) {
      const tl = svgEl('text', { x: x + bw / 2, y: y(totals[i]) - 6, 'text-anchor': 'middle', class: 'life-chart__value' });
      tl.textContent = fmt(totals[i]);
      svg.append(tl);
    }
    const xl = svgEl('text', { x: x + bw / 2, y: h - 8, 'text-anchor': 'middle', class: `life-chart__tick${i === highlight ? ' is-current' : ''}` });
    xl.textContent = r.label;
    svg.append(xl);
  });
  if (line > 0) svg.append(svgEl('line', { x1: pad.l, x2: w - pad.r, y1: y(line), y2: y(line), class: 'life-chart__ref' }));
  return svg;
}

/**
 * Lines over a shared x axis (e.g. iterations): series [{label, color,
 * points: [{x, y}]}]. The y range is `min`..`max` when given, else the data's
 * own. Every point is a dot with a title, so single points still show.
 */
export function lineChart(series, { label = '', min = null, max = null, fmt = String } = {}) {
  const w = 640;
  const h = 220;
  const pad = { l: 34, r: 10, t: 14, b: 26 };
  const svg = svgRoot(w, h, label);
  svg.classList.add('life-chart--bars', 'life-chart--lines');
  const points = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return svg;
  const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
  const lo = Number.isFinite(min) ? min : Math.min(...points.map((p) => p.y));
  const hiRaw = Number.isFinite(max) ? max : Math.max(...points.map((p) => p.y));
  const hi = hiRaw > lo ? hiRaw : lo + 1;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xFirst = xs[0];
  const xSpan = Math.max(1, xs[xs.length - 1] - xFirst);
  const x = (v) => pad.l + (xs.length > 1 ? ((v - xFirst) / xSpan) * plotW : plotW / 2);
  const y = (v) => pad.t + plotH - ((v - lo) / (hi - lo)) * plotH;

  svg.append(svgEl('line', { x1: pad.l, x2: w - pad.r, y1: y(lo), y2: y(lo), class: 'life-chart__axis' }));
  for (const v of [lo, hi]) {
    const tl = svgEl('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'life-chart__tick' });
    tl.textContent = fmt(v);
    svg.append(tl);
  }
  // At most ~12 x labels, always the first and the last.
  const step = Math.max(1, Math.ceil(xs.length / 12));
  xs.forEach((v, i) => {
    if (i % step && i !== xs.length - 1) return;
    const tl = svgEl('text', { x: x(v), y: h - 8, 'text-anchor': 'middle', class: 'life-chart__tick' });
    tl.textContent = String(v);
    svg.append(tl);
  });
  for (const s of series) {
    const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (pts.length > 1) {
      svg.append(svgEl('polyline', {
        points: pts.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
      }));
    }
    for (const p of pts) {
      svg.append(titled(svgEl('circle', { cx: x(p.x), cy: y(p.y), r: 3, fill: s.color }), `${s.label} · ${p.x}: ${fmt(p.y)}`));
    }
  }
  return svg;
}
