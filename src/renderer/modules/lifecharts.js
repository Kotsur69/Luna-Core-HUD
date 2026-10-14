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
