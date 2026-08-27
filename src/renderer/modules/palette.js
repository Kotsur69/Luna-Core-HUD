// ============================================================================
// LunaCore - command palette (Ctrl+K)
// ----------------------------------------------------------------------------
// A keyboard aggregate of EVERY injectable action: the physical COMPACT, the
// cheatsheets (7C), the prompts and the skills. Purely renderer-side - no new
// IPC channel and no extra tokens: each entry fires exactly like its original
// button (runCommand / pastePrompt / copy to clipboard).
//
// Enter = the entry's main action (command: send; prompt: paste without
// sending; skill: copy the name). Shift+Enter on a prompt pastes AND sends.
// ============================================================================

'use strict';

import { t, loc } from './util.js';
import { onLangChange } from './bus.js';
import { term } from './terminals.js';
import { closeWithExit, cancelExit } from './motion.js';

const paletteEl = document.getElementById('palette');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
const PALETTE_MAX = 50; // how many rows we render (the skill list runs to 300+)

let paletteItems = null; // lazily built flat aggregate of every action
let paletteFiltered = []; // currently visible entries (after filtering)
let paletteSel = 0; // index of the highlighted row
let paletteOpen = false;

// Collects actions from every source into one flat list of
// `{ kind, label, sub, hint, run(opts) }`. The data comes from the same
// bridges the panels use.
async function buildPaletteActions() {
  const items = [];

  // Static action: the physical COMPACT button.
  items.push({
    kind: 'action',
    label: 'COMPACT CONTEXT',
    sub: t('palette.action.sub'),
    hint: '/compact',
    run: () => window.lunacore.runCommand('/compact'),
  });

  const [cheats, prompts, skills] = await Promise.all([
    window.lunacore.getCheatsheets().catch(() => null),
    window.lunacore.getPrompts().catch(() => null),
    window.lunacore.getSkills().catch(() => null),
  ]);

  for (const g of (cheats && cheats.groups) || []) {
    for (const c of g.commands || []) {
      items.push({
        kind: 'command',
        label: loc(c.label),
        sub: loc(g.title),
        hint: c.command,
        run: () => window.lunacore.runCommand(c.command),
      });
    }
  }

  for (const g of (prompts && prompts.groups) || []) {
    for (const p of g.prompts || []) {
      // loc() also flattens an authored line-array, so the defensive join the
      // old code did is covered.
      const text = loc(p.text);
      items.push({
        kind: 'prompt',
        label: loc(p.label),
        sub: loc(g.title),
        hint: t('palette.hint.promptPaste'),
        run: (opts) => window.lunacore.pastePrompt(text, !!(opts && opts.send)),
      });
    }
  }

  for (const cat of (skills && skills.categories) || []) {
    for (const s of cat.skills || []) {
      items.push({
        kind: 'skill',
        label: s.name,
        sub: cat.name,
        hint: t('palette.hint.skillCopy'),
        run: () => navigator.clipboard.writeText(s.name).catch(() => {}),
      });
    }
  }

  return items;
}

// Fuzzy (subsequence) match: returns { score, indices } or null.
// Rewards contiguous hits and word boundaries; shorter text ranks higher.
function fuzzyMatch(query, text) {
  const tx = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const indices = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  let streak = 0;

  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (let k = ti; k < tx.length; k++) {
      if (tx[k] === q[qi]) { found = k; break; }
    }
    if (found === -1) return null;
    indices.push(found);

    if (found === prev + 1) { streak++; score += 5 + streak * 3; }
    else { streak = 0; score += 1; }
    if (found === 0 || /[\s/_\-:.]/.test(tx[found - 1])) score += 8; // word start

    prev = found;
    ti = found + 1;
  }

  if (tx.includes(q)) score += 15; // a contiguous substring is a strong bonus
  score -= tx.length * 0.05; // on a tie the shorter one wins
  return { score, indices };
}

// Filters and sorts entries for a query. Highlighting only applies to the
// label; a match may also come through `sub`/`hint`, at a lower priority.
function filterPalette(query) {
  const q = query.trim();
  if (!q) return paletteItems.slice(0, PALETTE_MAX).map((item) => ({ item, indices: [] }));

  const scored = [];
  for (const item of paletteItems) {
    const onLabel = fuzzyMatch(q, item.label);
    if (onLabel) {
      scored.push({ item, indices: onLabel.indices, score: onLabel.score + 1000 });
      continue;
    }
    const onMeta = fuzzyMatch(q, `${item.sub} ${item.hint}`);
    if (onMeta) scored.push({ item, indices: [], score: onMeta.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, PALETTE_MAX);
}

// Builds a label with the matched characters highlighted (safely, no innerHTML).
function labelWithMarks(label, indices) {
  const frag = document.createDocumentFragment();
  const set = new Set(indices);
  let buf = '';
  const flush = (mark) => {
    if (!buf) return;
    if (mark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(buf));
    }
    buf = '';
  };
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i);
    const prevHit = set.has(i - 1);
    if (i > 0 && hit !== prevHit) flush(prevHit);
    buf += label[i];
  }
  flush(set.has(label.length - 1));
  return frag;
}

function renderPalette() {
  paletteList.innerHTML = '';

  if (!paletteFiltered.length) {
    const empty = document.createElement('li');
    empty.className = 'palette__empty';
    empty.textContent = t('palette.empty');
    paletteList.appendChild(empty);
    return;
  }

  paletteFiltered.forEach(({ item, indices }, i) => {
    const li = document.createElement('li');
    li.className = 'palette-item' + (i === paletteSel ? ' is-active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === paletteSel ? 'true' : 'false');
    li.dataset.idx = i;

    const kind = document.createElement('span');
    kind.className = 'palette-item__kind';
    kind.dataset.kind = item.kind;
    kind.textContent = t(`palette.kind.${item.kind}`);

    const body = document.createElement('span');
    body.className = 'palette-item__body';
    const label = document.createElement('div');
    label.className = 'palette-item__label';
    label.appendChild(labelWithMarks(item.label, indices));
    const sub = document.createElement('div');
    sub.className = 'palette-item__sub';
    sub.textContent = item.sub;
    body.append(label, sub);

    const hint = document.createElement('span');
    hint.className = 'palette-item__hint';
    hint.textContent = item.hint;

    li.append(kind, body, hint);
    paletteList.appendChild(li);
  });
}

// Keeps the selection in range and scrolls it into view.
function setPaletteSel(idx) {
  const len = paletteFiltered.length;
  if (!len) return;
  paletteSel = ((idx % len) + len) % len; // wrap top/bottom
  renderPalette();
  const active = paletteList.querySelector('.palette-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updatePalette() {
  paletteFiltered = filterPalette(paletteInput.value);
  paletteSel = 0;
  renderPalette();
}

// Fires the highlighted (or given) entry and closes the palette.
function firePalette(idx, opts) {
  const row = paletteFiltered[idx];
  if (!row) return;
  try {
    row.item.run(opts);
  } catch {
    // one bad action must not take the palette down
  }
  closePalette();
  term.focus();
}

async function openPalette() {
  if (paletteOpen) return;
  // Esc-then-Ctrl+K inside the exit window is a real gesture on a keyboard-
  // driven HUD; without this the pending timer would hide what was just opened.
  cancelExit(paletteEl);
  paletteOpen = true;
  paletteEl.hidden = false;

  // Build the aggregate lazily on first open (getSkills can be slow, but main
  // caches it for the session). Later opens are instant.
  if (!paletteItems) {
    paletteItems = [];
    try {
      paletteItems = await buildPaletteActions();
    } catch {
      paletteItems = [];
    }
  }

  paletteInput.value = '';
  updatePalette();
  paletteInput.focus();
}

function closePalette() {
  if (!paletteOpen) return;
  // The flag drops NOW, the element leaves over the next ~120ms (v0.10 3.2).
  // Everything that asks "is the palette open" has to get the answer the user
  // just gave it, not the one the animation is still finishing.
  paletteOpen = false;
  closeWithExit(paletteEl);
}

// Keyboard inside the search field.
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel(paletteSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel(paletteSel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); firePalette(paletteSel, { send: e.shiftKey }); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); term.focus(); }
});

paletteInput.addEventListener('input', updatePalette);

// Mouse: hover highlights, click fires (Shift+click sends a prompt).
paletteList.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.palette-item');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (idx !== paletteSel) { paletteSel = idx; renderPalette(); }
});
paletteList.addEventListener('click', (e) => {
  const row = e.target.closest('.palette-item');
  if (!row) return;
  firePalette(Number(row.dataset.idx), { send: e.shiftKey });
});

// Clicking the backdrop closes it.
paletteEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-palette-close')) { closePalette(); term.focus(); }
});

// The chip in the terminal bar opens the palette.
/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountPaletteChip(root) {
  const btn = root.querySelector('#palette-open');
  if (btn) btn.addEventListener('click', openPalette);
}

// Global Ctrl/Cmd+K (capture, to get ahead of xterm.js).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      if (paletteOpen) { closePalette(); term.focus(); }
      else openPalette();
    }
  },
  true
);

// Rebuild with the new translations on the next open.
onLangChange(() => {
  paletteItems = null;
});
