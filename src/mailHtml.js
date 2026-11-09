// ============================================================================
// LunaCore - readable HTML alternative for a plain-text email (main process)
// ----------------------------------------------------------------------------
// gmailsend.js sends every mail as text; with html:true it adds this page as
// the text/html alternative. The text is never trusted as markup: it is split
// into lines, each line is classified (heading, bullet, numbered item, code,
// rule, paragraph) and every piece of text goes through escapeHtml.
//
// Email-client safe: inline styles only (Gmail drops most of <style>), one
// centered table-free container of ~680px, system sans-serif fonts, no
// external assets. Monospace is used only for code-like lines: ``` fences,
// indented blocks, markdown table rows and `inline code`.
// ============================================================================

'use strict';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const MAX_LABEL_HEADING = 80;
const FONT = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif';
const MONO = 'font-family:ui-monospace,SFMono-Regular,Consolas,\'Liberation Mono\',monospace';

const STYLE = {
  body: `margin:0;padding:24px 12px;background:#f4f5f8;color:#1d2230;${FONT};font-size:15px;line-height:1.6`,
  box: 'max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ee;border-radius:12px;padding:24px 28px',
  h1: 'margin:0 0 12px;font-size:22px;line-height:1.3;color:#141824',
  h2: 'margin:22px 0 8px;font-size:18px;line-height:1.35;color:#141824;border-bottom:1px solid #e3e6ee;padding-bottom:4px',
  h3: 'margin:18px 0 6px;font-size:15px;line-height:1.4;color:#3a3170;text-transform:none',
  p: 'margin:0 0 12px',
  list: 'margin:0 0 12px;padding-left:22px',
  li: 'margin:0 0 4px',
  pre: `margin:0 0 12px;padding:10px 12px;background:#f1f2f6;border:1px solid #e3e6ee;border-radius:8px;${MONO};font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word`,
  code: `${MONO};font-size:13px;background:#f1f2f6;border-radius:4px;padding:1px 4px`,
  a: 'color:#3b5bdb;text-decoration:underline;word-break:break-all',
  hr: 'border:0;border-top:1px solid #e3e6ee;margin:18px 0',
  check: `${MONO};color:#6b7385`,
};

// Inline tokens: `code` spans and http(s) links. Everything else is text.
const INLINE_RE = /(`[^`\n]+`|https?:\/\/[^\s<>"'`]+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

/** One line of text as escaped markup with inline code and links. */
function inline(text) {
  return String(text)
    .split(INLINE_RE)
    .map((part, i) => {
      if (i % 2 === 0) return escapeHtml(part);
      if (part.startsWith('`')) return `<code style="${STYLE.code}">${escapeHtml(part.slice(1, -1))}</code>`;
      const tail = (part.match(TRAILING_PUNCT_RE) || [''])[0];
      const url = tail ? part.slice(0, -tail.length) : part;
      return `<a href="${escapeHtml(url)}" style="${STYLE.a}">${escapeHtml(url)}</a>${escapeHtml(tail)}`;
    })
    .join('');
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const MD_HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s*```/;
const CHECKBOX_RE = /^\[( |x|X)\]\s+(.*)$/;

/** A line that reads as code: indented by 4+, a tab, or a markdown table row. */
const isCodeLine = (line) => (/^( {4,}|\t)\S/.test(line) && !BULLET_RE.test(line) && !NUMBERED_RE.test(line)) || /^\s*\|.*\|\s*$/.test(line);

/** A short standalone label line: 'FUN', 'Needs you:', 'NEXT WEEK'. */
function labelHeading(line) {
  const t = line.trim();
  if (!t || t.length > MAX_LABEL_HEADING) return null;
  if (/:$/.test(t) && !/^https?:/.test(t) && !/\s{2,}/.test(t)) return t.slice(0, -1).trim() || null;
  if (/^[A-Z][A-Z0-9 &/'-]{1,40}$/.test(t) && /[A-Z]{2}/.test(t)) return t;
  return null;
}

function listItem(content) {
  const box = content.match(CHECKBOX_RE);
  if (!box) return `<li style="${STYLE.li}">${inline(content)}</li>`;
  const mark = box[1] === ' ' ? '[ ]' : '[x]';
  return `<li style="${STYLE.li}"><span style="${STYLE.check}">${mark}</span> ${inline(box[2])}</li>`;
}

/**
 * Groups the lines into blocks. Each block is { kind, lines } where kind is
 * one of: h1 h2 h3 ul ol pre hr p.
 */
function blocksOf(lines) {
  const blocks = [];
  const push = (kind, line) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && (kind === 'ul' || kind === 'ol' || kind === 'pre' || kind === 'p')) last.lines.push(line);
    else blocks.push({ kind, lines: [line] });
  };
  const close = () => blocks.push({ kind: 'break', lines: [] });
  let fenced = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      close();
      continue;
    }
    if (fenced) {
      push('pre', line);
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const md = line.match(MD_HEADING_RE);
    if (md) {
      blocks.push({ kind: md[1].length <= 2 ? 'h2' : 'h3', lines: [md[2]] });
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'hr', lines: [] });
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet && !isCodeLine(line)) {
      push('ul', bullet[1]);
      continue;
    }
    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      push('ol', numbered[2]);
      continue;
    }
    // An indented continuation (e.g. '    [ ] todo') under a list item stays in the list.
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'ul' && /^\s{2,}[^\s|]/.test(line)) {
      push('ul', line.trim());
      continue;
    }
    if (isCodeLine(line)) {
      push('pre', line);
      continue;
    }
    const label = labelHeading(line);
    if (label) {
      blocks.push({ kind: 'h3', lines: [label] });
      continue;
    }
    push('p', line);
  }
  return blocks.filter((b) => b.kind !== 'break');
}

function renderBlock(b) {
  switch (b.kind) {
    case 'h1': return `<h1 style="${STYLE.h1}">${inline(b.lines[0])}</h1>`;
    case 'h2': return `<h2 style="${STYLE.h2}">${inline(b.lines[0])}</h2>`;
    case 'h3': return `<h3 style="${STYLE.h3}">${inline(b.lines[0])}</h3>`;
    case 'hr': return `<hr style="${STYLE.hr}">`;
    case 'ul': return `<ul style="${STYLE.list}">${b.lines.map(listItem).join('')}</ul>`;
    case 'ol': return `<ol style="${STYLE.list}">${b.lines.map(listItem).join('')}</ol>`;
    case 'pre': return `<pre style="${STYLE.pre}">${escapeHtml(b.lines.join('\n'))}</pre>`;
    default: return `<p style="${STYLE.p}">${b.lines.map(inline).join('<br>')}</p>`;
  }
}

/**
 * A plain-text mail body as a readable, self-contained HTML document.
 * The first non-empty line becomes the title when it is short prose.
 * @param {string} text the plain-text body (CRLF or LF)
 * @returns {string} html, every piece of text escaped
 */
function textToMailHtml(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = blocksOf(lines);
  const isTitle = (b) => b.kind === 'h2' || (b.kind === 'p' && b.lines.length === 1 && b.lines[0].trim().length <= MAX_LABEL_HEADING);
  const titled = blocks.map((b, i) => (i === 0 && isTitle(b) ? { ...b, kind: 'h1' } : b));
  const inner = titled.map(renderBlock).join('\n');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="${STYLE.body}">`,
    `<div style="${STYLE.box}">`,
    inner,
    '</div>',
    '</body></html>',
  ].join('\n');
}

module.exports = { textToMailHtml, escapeHtml };
