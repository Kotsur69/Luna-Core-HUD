// ============================================================================
// LunaCore - standalone HTML report building blocks (main process)
// ----------------------------------------------------------------------------
// Shared by the God Mode run report (orchestraReport.js) and the weekly
// review (weeklyreview.js): one page shell with inlined light/dark CSS,
// summary cards, tables and inline SVG charts drawn here in plain JS - no
// library, no network, no script in the output.
//
// Everything interpolated into markup goes through escapeHtml: titles, error
// text, file names and commit subjects come from git and from models. Chart
// geometry is rounded to one decimal so the same input always yields the
// same bytes (tests compare output, and diffs of two reports stay readable).
// ============================================================================

'use strict';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Natural widths: a full-width panel and one of two side by side. An svg
// never grows past its own width, so 12px text stays 12px on a wide page.
const CHART_W = 900;
const HALF_W = 420;
const ROW_H = 26;
const LABEL_W = 190;
const VALUE_W = 70;
const MAX_LABEL = 28;
const MAX_ROWS = 50;

/** The one escaper: text and attribute values alike. null/undefined -> ''. */
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const esc = escapeHtml;
const r1 = (v) => Math.round(v * 10) / 10;
const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const short = (v, max = MAX_LABEL) => {
  const s = String(v == null ? '' : v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
/** A CSS class token from data: anything off-shape falls back to 'muted'. */
const tone = (v) => (typeof v === 'string' && /^[a-z][a-z-]{0,23}$/.test(v) ? v : 'muted');
const widthOf = (opts) => (Number.isFinite(opts.width) && opts.width >= 300 ? Math.min(opts.width, CHART_W) : CHART_W);
const svgOpen = (w, h, label) => `<svg viewBox="0 0 ${w} ${h}" style="max-width:${w}px" role="img" aria-label="${label}">`;
const empty = (text) => `<p class="empty">${esc(text || 'No data')}</p>`;

// Status colors come in two sets: --ok etc. for chart marks and large card
// values, --ok-fg/--ok-bg for small text on a tinted pill (>= 4.5:1 contrast
// in both themes). Print forces the light palette and drops the panels' look.
const CSS = `
:root{--bg:#f4f5f8;--panel:#fff;--text:#1d2230;--strong:#121620;--muted:#5e6678;--line:#e1e4ec;--track:#eef0f5;--zebra:#f8f9fb;
--ok:#18804f;--bad:#c93c3c;--warn:#b96d0c;--info:#2f6fd0;--idle:#8a92a3;--accent:#6a4ce0;
--ok-fg:#0f5c38;--ok-bg:#ddf3e7;--bad-fg:#9a2424;--bad-bg:#fbe3e3;--warn-fg:#7a4705;--warn-bg:#fcefd8;
--info-fg:#1d4f9c;--info-bg:#e2ecfb;--muted-fg:#4a5263;--muted-bg:#eceef3;--accent-fg:#4a31b0;--accent-bg:#ece7fd}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--panel:#181b24;--text:#e3e6ee;--strong:#f4f5f9;--muted:#a1a8b8;
--line:#2c3140;--track:#232836;--zebra:#1c2029;--ok:#3ecf8e;--bad:#ff7b7b;--warn:#f5b04c;--info:#7cb0ff;--idle:#7a8294;--accent:#a996ff;
--ok-fg:#7ee2b1;--ok-bg:#16352a;--bad-fg:#ffaaaa;--bad-bg:#3d1d22;--warn-fg:#f8cb85;--warn-bg:#3a2b14;
--info-fg:#a8c9ff;--info-bg:#1b2b45;--muted-fg:#c3c8d4;--muted-bg:#262b37;--accent-fg:#cbbfff;--accent-bg:#2a2347}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 20px 56px}
header{padding:4px 2px 6px;border-bottom:1px solid var(--line)}
header .eyebrow{margin:0 0 4px;color:var(--accent);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
header h1{margin:0 0 6px;font-size:28px;line-height:1.25;color:var(--strong);letter-spacing:-.01em;overflow-wrap:anywhere}
header p{margin:0 0 10px;color:var(--muted);max-width:72ch;overflow-wrap:anywhere}
.summary{margin:18px 0 0;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;font-size:16px;max-width:none}
h2{font-size:17px;line-height:1.35;margin:0 0 14px;color:var(--strong);display:flex;align-items:center;gap:8px}
h2::before{content:"";width:4px;height:16px;border-radius:2px;background:var(--accent);flex:none}
h3{font-size:14px;margin:16px 0 8px;color:var(--strong)}
section h3:first-of-type{margin-top:4px}
p{max-width:80ch}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:20px;min-width:0;box-shadow:0 1px 2px rgba(16,24,40,.04)}
section>p:last-child,section>ul:last-child{margin-bottom:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.card{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--idle);border-radius:12px;padding:14px 16px;min-width:0}
.card.ok{border-top-color:var(--ok)}.card.bad{border-top-color:var(--bad)}.card.warn{border-top-color:var(--warn)}
.card.info{border-top-color:var(--info)}.card.accent{border-top-color:var(--accent)}
.card .v{font-size:26px;font-weight:700;line-height:1.2;color:var(--strong);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.card .k{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.card.ok .v{color:var(--ok)}.card.bad .v{color:var(--bad)}.card.warn .v{color:var(--warn)}.card.info .v{color:var(--info)}.card.accent .v{color:var(--accent)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 20px}
svg{display:block;width:100%;height:auto;max-width:100%}
svg text{fill:var(--text);stroke:none;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}
svg .lbl{fill:var(--muted)}
svg .track{fill:var(--track)}
svg .axis{stroke:var(--line);stroke-width:1}
.ok{fill:var(--ok);stroke:var(--ok)}.bad{fill:var(--bad);stroke:var(--bad)}.warn{fill:var(--warn);stroke:var(--warn)}
.info{fill:var(--info);stroke:var(--info)}.muted{fill:var(--idle);stroke:var(--idle)}.accent{fill:var(--accent);stroke:var(--accent)}
rect.ok,rect.bad,rect.warn,rect.info,rect.muted,rect.accent{stroke:none}
.donut{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.donut svg{width:160px;flex:none}
.donut circle{fill:none;stroke-width:22}
.donut circle.track{fill:none;stroke:var(--track)}
.legend{list-style:none;margin:0;padding:0}
.legend li{display:flex;align-items:center;gap:8px;margin:3px 0}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block;background:var(--idle)}
.legend i.ok{background:var(--ok)}.legend i.bad{background:var(--bad)}.legend i.warn{background:var(--warn)}
.legend i.info{background:var(--info)}.legend i.accent{background:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.45}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td{overflow-wrap:anywhere;min-width:4ch}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid var(--line);white-space:nowrap}
tbody tr:nth-child(even) td{background:var(--zebra)}
tbody tr:last-child td{border-bottom:0}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow-wrap:normal}
td ul.plain{padding-left:16px}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.5;color:var(--muted-fg);background:var(--muted-bg);white-space:nowrap}
.pill.ok{color:var(--ok-fg);background:var(--ok-bg)}.pill.bad{color:var(--bad-fg);background:var(--bad-bg)}
.pill.warn{color:var(--warn-fg);background:var(--warn-bg)}.pill.info{color:var(--info-fg);background:var(--info-bg)}
.pill.accent{color:var(--accent-fg);background:var(--accent-bg)}
ul.plain{margin:0;padding-left:20px}
ul.plain li{margin:4px 0;overflow-wrap:anywhere}
ul.plain li::marker{color:var(--muted)}
code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--track);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--track);border:1px solid var(--line);padding:12px 14px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto;margin:8px 0 0}
a{color:var(--info);overflow-wrap:anywhere}
.empty{color:var(--muted);margin:0;font-style:italic}
footer{color:var(--muted);font-size:13px;margin-top:28px;padding-top:14px;border-top:1px solid var(--line);text-align:center}
@media (max-width:600px){main{padding:20px 12px 40px}header h1{font-size:23px}section{padding:16px 14px}.card .v{font-size:22px}}
@media print{
:root{--bg:#fff;--panel:#fff;--text:#000;--strong:#000;--muted:#444;--line:#ccc;--zebra:#f4f4f4}
body{font-size:11pt;background:#fff}
main{max-width:none;padding:0}
section,.card,.summary{box-shadow:none;break-inside:avoid;page-break-inside:avoid}
section{border-color:#ccc;margin-top:12pt}
h2{break-after:avoid;page-break-after:avoid}
tr{break-inside:avoid;page-break-inside:avoid}
.tbl{overflow:visible}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

/**
 * A whole standalone document. `body` is already-escaped markup.
 * `summary` is an optional one-line plain-text lead shown under the header.
 * @param {{title:string, subtitle?:string, summary?:string, kind?:string, body:string, footer?:string}} p
 */
function page({ title, subtitle, summary, kind, body, footer }) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${esc(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body><main>',
    `<header><p class="eyebrow">${esc(kind || 'LunaCore report')}</p><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</header>`,
    summary ? `<p class="summary">${esc(summary)}</p>` : '',
    body,
    footer ? `<footer>${esc(footer)}</footer>` : '',
    '</main></body>',
    '</html>',
    '',
  ].join('\n');
}

/** @param {Array<{label:string, value:string|number, tone?:string}>} items */
function cards(items) {
  const html = items.map((c) => `<div class="card ${tone(c.tone)}"><div class="v">${esc(c.value)}</div><div class="k">${esc(c.label)}</div></div>`);
  return `<div class="cards">${html.join('')}</div>`;
}

/** A titled panel around already-escaped markup. */
const section = (title, inner) => `<section><h2>${esc(title)}</h2>${inner}</section>`;

/**
 * Horizontal bars, one row each, scaled to the largest value.
 * @param {Array<{label:string, value:number, tone?:string, text?:string}>} rows
 * @param {{emptyText?:string, width?:number}} [opts]
 */
function barChart(rows, opts = {}) {
  const items = (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS);
  const max = Math.max(0, ...items.map((r) => num(r.value)));
  if (!items.length || max <= 0) return empty(opts.emptyText);
  const W = widthOf(opts);
  const barW = W - LABEL_W - VALUE_W;
  const h = items.length * ROW_H + 4;
  const out = [svgOpen(W, h, 'bar chart')];
  items.forEach((r, i) => {
    const y = i * ROW_H + 4;
    const w = r1((num(r.value) / max) * barW);
    const text = r.text == null ? r.value : r.text;
    out.push(
      `<g><title>${esc(r.label)}: ${esc(text)}</title>`,
      `<text class="lbl" x="0" y="${y + 13}">${esc(short(r.label))}</text>`,
      `<rect class="track" x="${LABEL_W}" y="${y}" width="${barW}" height="18" rx="4"/>`,
      `<rect class="${tone(r.tone)}" x="${LABEL_W}" y="${y}" width="${Math.max(w, 2)}" height="18" rx="4"/>`,
      `<text x="${LABEL_W + barW + 8}" y="${y + 13}">${esc(text)}</text></g>`,
    );
  });
  out.push('</svg>');
  return out.join('');
}

/**
 * A donut with a legend. Segments with no value stay off both.
 * @param {Array<{label:string, value:number, tone?:string}>} segments
 * @param {{center?:string, emptyText?:string}} [opts]
 */
function donutChart(segments, opts = {}) {
  const items = (Array.isArray(segments) ? segments : []).filter((s) => num(s.value) > 0).slice(0, MAX_ROWS);
  const total = items.reduce((s, x) => s + num(x.value), 0);
  if (!total) return empty(opts.emptyText);
  const rad = 60;
  const circ = 2 * Math.PI * rad;
  let offset = 0;
  const rings = items.map((s) => {
    const len = (num(s.value) / total) * circ;
    const ring = `<circle class="${tone(s.tone)}" cx="80" cy="80" r="${rad}" stroke-dasharray="${r1(len)} ${r1(circ - len)}" stroke-dashoffset="${r1(-offset)}" transform="rotate(-90 80 80)"><title>${esc(s.label)}: ${esc(s.value)}</title></circle>`;
    offset += len;
    return ring;
  });
  const center = opts.center == null ? String(total) : opts.center;
  const svg = [
    '<svg viewBox="0 0 160 160" role="img" aria-label="donut chart">',
    `<circle class="track" cx="80" cy="80" r="${rad}"/>`,
    ...rings,
    `<text x="80" y="87" text-anchor="middle" style="font-size:20px;font-weight:650">${esc(center)}</text>`,
    '</svg>',
  ].join('');
  const legend = items.map((s) => `<li><i class="${tone(s.tone)}"></i>${esc(s.label)} <b>${esc(s.value)}</b></li>`).join('');
  return `<div class="donut">${svg}<ul class="legend">${legend}</ul></div>`;
}

/**
 * A timeline: one bar per row from start to end on a shared time axis.
 * Rows without a finite start are skipped; a missing end draws to `until`.
 * @param {Array<{label:string, start:number, end?:number|null, tone?:string, text?:string}>} rows
 * @param {{from?:number, until?:number, fmt?:(ms:number)=>string, emptyText?:string, width?:number}} [opts]
 */
function ganttChart(rows, opts = {}) {
  const items = (Array.isArray(rows) ? rows : []).filter((r) => Number.isFinite(r.start)).slice(0, MAX_ROWS);
  if (!items.length) return empty(opts.emptyText);
  const endOf = (r) => (Number.isFinite(r.end) && r.end >= r.start ? r.end : Number.isFinite(opts.until) ? opts.until : r.start);
  const from = Math.min(Number.isFinite(opts.from) ? opts.from : Infinity, ...items.map((r) => r.start));
  const until = Math.max(Number.isFinite(opts.until) ? opts.until : -Infinity, ...items.map(endOf));
  const span = Math.max(until - from, 1);
  const fmt = typeof opts.fmt === 'function' ? opts.fmt : (ms) => String(ms);
  const W = widthOf(opts);
  const trackW = W - LABEL_W - 10;
  const h = items.length * ROW_H + 30;
  const x = (ms) => r1(LABEL_W + ((ms - from) / span) * trackW);
  const out = [svgOpen(W, h, 'timeline')];
  items.forEach((r, i) => {
    const y = i * ROW_H + 4;
    const x0 = x(r.start);
    const w = Math.max(r1(x(endOf(r)) - x0), 3);
    out.push(
      `<g><title>${esc(r.label)}: ${esc(r.text || '')}</title>`,
      `<text class="lbl" x="0" y="${y + 13}">${esc(short(r.label))}</text>`,
      `<rect class="track" x="${LABEL_W}" y="${y}" width="${trackW}" height="18" rx="4"/>`,
      `<rect class="${tone(r.tone)}" x="${x0}" y="${y}" width="${w}" height="18" rx="4"/></g>`,
    );
  });
  const axisY = items.length * ROW_H + 8;
  out.push(
    `<line class="axis" x1="${LABEL_W}" y1="${axisY}" x2="${LABEL_W + trackW}" y2="${axisY}"/>`,
    `<text class="lbl" x="${LABEL_W}" y="${axisY + 16}">${esc(fmt(from))}</text>`,
    `<text class="lbl" x="${LABEL_W + trackW}" y="${axisY + 16}" text-anchor="end">${esc(fmt(until))}</text>`,
    '</svg>',
  );
  return out.join('');
}

/**
 * Vertical columns over a fixed set of labels (e.g. the 7 days of a week).
 * @param {Array<{label:string, value:number, tone?:string}>} cols
 * @param {{emptyText?:string, width?:number}} [opts]
 */
function columnChart(cols, opts = {}) {
  const items = (Array.isArray(cols) ? cols : []).slice(0, MAX_ROWS);
  const max = Math.max(0, ...items.map((c) => num(c.value)));
  if (!items.length || max <= 0) return empty(opts.emptyText);
  const h = 180;
  const plotH = 130;
  const W = widthOf(opts);
  const slot = W / items.length;
  const barW = r1(Math.min(56, slot * 0.6));
  const out = [svgOpen(W, h, 'column chart')];
  items.forEach((c, i) => {
    const v = num(c.value);
    const bh = r1((v / max) * plotH);
    const cx = r1(slot * i + slot / 2);
    const top = r1(20 + plotH - bh);
    out.push(
      `<g><title>${esc(c.label)}: ${esc(v)}</title>`,
      `<rect class="${tone(c.tone)}" x="${r1(cx - barW / 2)}" y="${top}" width="${barW}" height="${v ? Math.max(bh, 2) : 0}" rx="4"/>`,
      `<text x="${cx}" y="${r1(top - 5)}" text-anchor="middle">${v ? esc(v) : ''}</text>`,
      `<text class="lbl" x="${cx}" y="${h - 12}" text-anchor="middle">${esc(short(c.label, 12))}</text></g>`,
    );
  });
  out.push(`<line class="axis" x1="0" y1="${20 + plotH}" x2="${W}" y2="${20 + plotH}"/>`, '</svg>');
  return out.join('');
}

/**
 * A table; `rows` cells are already-escaped markup (use escapeHtml / pill).
 * @param {string[]} head
 * @param {string[][]} rows
 * @param {string} [emptyText]
 */
function table(head, rows, emptyText) {
  if (!rows.length) return empty(emptyText);
  const numeric = head.map((_, i) => isNumericColumn(rows.map((r) => r[i])));
  const cls = (i) => (numeric[i] ? ' class="num"' : '');
  const th = head.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// A number with an optional unit: '12', '1,234.5', '$12.50', '40%', '30 min',
// '1 h 0 min', '3 / 4', '#2'. A '-' placeholder does not decide a column.
const NUMERIC_CELL_RE = /^[#+-]?\$?\d[\d.,]*(?:\s?(?:%|ms|s|min|h|d|k|M|x))?(?:\s(?:\/\s)?\d[\d.,]*(?:\s?(?:%|ms|s|min|h))?)*$/;
const PLACEHOLDER_RE = /^(?:-|–|—|)$/;

/** True when every real cell of a column is a plain number (cells are escaped markup). */
function isNumericColumn(cells) {
  const real = cells.map((c) => String(c == null ? '' : c).trim()).filter((c) => !PLACEHOLDER_RE.test(c));
  return real.length > 0 && real.every((c) => NUMERIC_CELL_RE.test(c));
}

const pill = (text, t) => `<span class="pill ${tone(t)}">${esc(text)}</span>`;
const list = (items, emptyText) => (items.length ? `<ul class="plain">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : empty(emptyText));


module.exports = {
  HALF_W,
  escapeHtml,
  page,
  cards,
  section,
  barChart,
  donutChart,
  ganttChart,
  columnChart,
  table,
  pill,
  list,
  empty,
};
