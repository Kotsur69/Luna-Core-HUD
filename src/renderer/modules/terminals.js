// ============================================================================
// LunaCore - xterm instances, one per session tab
// ----------------------------------------------------------------------------
// Every tab owns its OWN pty process, xterm buffer and metrics. `term` below is
// a facade: it forwards each call to the ACTIVE tab's terminal, so callers
// (term.write / term.focus / term.reset / term.cols) never care which tab is on
// screen, and switching tabs silently redirects them somewhere else.
//
// `Terminal` and `FitAddon` are UMD globals from the xterm <script> tags in
// index.html, which run before this module graph.
// ============================================================================

'use strict';

import { sfx } from './sound.js';

const TERM_OPTIONS = {
  cursorBlink: true,
  fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  // Constructor-only (xterm.d.ts: "must be set before Terminal.open(), can't
  // be changed later without executing it again"). Without this, the canvas
  // paints theme.background fully opaque no matter what alpha value it
  // carries - termBgOpacity silently doing nothing was this, not a wiring bug
  // (TERMINAL_CUSTOMIZER_PLAN.md §2/§4, found 2026-08-13 from Mati's report).
  allowTransparency: true,
  // Starting palette (cyberpunk); a theme may override it via term.options.theme.
  theme: {
    background: '#0c0912',
    foreground: '#e6dcff',
    cursor: '#c774ff',
    selectionBackground: '#3a2a5a',
    black: '#1a1424',
    brightBlack: '#4a3a63',
    magenta: '#c774ff',
    brightMagenta: '#e29bff',
    cyan: '#5ff2d6',
    brightCyan: '#8ffbe6',
    green: '#7CFF9B',
    yellow: '#ffd86b',
    red: '#ff6b8a',
  },
};

// A2f: `#terminal` lives inside the `terminal` widget's template now, so it is
// looked up in mountTerminalHost() instead of at import time. In practice it
// is set exactly once and never cleared - see modules/terminal.js.
let termHost = null;

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountTerminalHost(root) {
  termHost = root.querySelector('#terminal');
}

/**
 * sessionId -> session bucket.
 *
 * This module owns `{ id, term, fitAddon, el, alive }`. Everything else on the
 * bucket belongs to whichever module registered a session view on the bus
 * (led.js adds ledState/ledDead, context.js adds lastCtx, spark.js adds
 * sparkBuf) - see bus.js. Nothing here reads those keys. `id` mirrors the Map
 * key onto the bucket itself so a module that only has the bucket (not the
 * sessionId that looked it up) can still name which session it belongs to -
 * led.js's background idle timer and notify.js both need this.
 */
const termsBySession = new Map();

let activeSessionId = null;

// Last xterm palette handed over by a theme. New tabs must get it immediately,
// otherwise they would be born in the default cyberpunk despite another theme.
let currentTermTheme = null;

// TERMINAL_CUSTOMIZER_PLAN.md §4: last customized appearance, mirroring
// currentTermTheme's role - a newly created tab must be born with it instead
// of the hardcoded TERM_OPTIONS defaults. Global, not per-tab (§0). Starts as
// a copy of TERM_OPTIONS's own values so an app launch with no customization
// yet behaves exactly as before this feature existed.
let currentTermAppearance = {
  fontFamily: TERM_OPTIONS.fontFamily,
  fontSize: TERM_OPTIONS.fontSize,
  lineHeight: 1.0, // xterm default - TERM_OPTIONS never set this explicitly
  letterSpacing: 0, // xterm default - TERM_OPTIONS never set this explicitly
  cursorStyle: 'block', // xterm default - TERM_OPTIONS never set this explicitly
  cursorBlink: TERM_OPTIONS.cursorBlink,
  scrollback: TERM_OPTIONS.scrollback,
};

// §2/§4: background opacity, percent 0-100. NOT part of currentTermAppearance
// above - it is not a plain term.options.* key, it composes with whatever the
// CURRENT theme's background is (see backgroundWithOpacity()), so it must
// survive a later theme switch on its own.
let currentTermOpacity = 100;

/** '#rrggbb' -> {r,g,b}, or null for anything else (short hex, named colors). */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

/** Every theme in config/themes.json authors its terminal.background as a
 * full 6-digit hex (see the built-in TERM_OPTIONS.theme.background above), so
 * hexToRgb() failing is defensive only - falls back to the opaque hex itself,
 * i.e. the opacity slider silently has no effect rather than throwing. */
function backgroundWithOpacity(bgHex, opacityPct) {
  const rgb = hexToRgb(bgHex);
  if (!rgb) return bgHex;
  const a = Math.max(0, Math.min(100, opacityPct)) / 100;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

function currentBgHex() {
  return (currentTermTheme && currentTermTheme.background) || TERM_OPTIONS.theme.background;
}

/** Re-applies currentTermOpacity on top of whatever background is live now. */
function applyOpacityToAllTabs() {
  const background = backgroundWithOpacity(currentBgHex(), currentTermOpacity);
  for (const s of termsBySession.values()) {
    s.term.options.theme = { ...s.term.options.theme, background };
  }
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function setActiveSessionId(sessionId) {
  activeSessionId = sessionId;
}

export function getBucket(sessionId) {
  return termsBySession.get(sessionId) || null;
}

export function getActiveBucket() {
  return activeSessionId ? termsBySession.get(activeSessionId) || null : null;
}

/** Creates (or returns the existing) terminal for a session. */
export function ensureTerm(sessionId) {
  let s = termsBySession.get(sessionId);
  if (s) return s;

  const el = document.createElement('div');
  el.className = 'terminal__pane';
  termHost.appendChild(el);

  const instance = new Terminal({
    ...TERM_OPTIONS,
    fontFamily: currentTermAppearance.fontFamily,
    fontSize: currentTermAppearance.fontSize,
    lineHeight: currentTermAppearance.lineHeight,
    letterSpacing: currentTermAppearance.letterSpacing,
    cursorStyle: currentTermAppearance.cursorStyle,
    cursorBlink: currentTermAppearance.cursorBlink,
    scrollback: currentTermAppearance.scrollback,
  });
  const addon = new FitAddon.FitAddon();
  instance.loadAddon(addon);
  instance.open(el);
  if (currentTermTheme) {
    instance.options.theme = { ...instance.options.theme, ...currentTermTheme };
  }
  // Opacity composes on top of whichever background the block above set -
  // always applied (even at the 100%/opaque default) so a fresh tab never
  // disagrees with an already-customized one (§4).
  instance.options.theme = {
    ...instance.options.theme,
    background: backgroundWithOpacity(currentBgHex(), currentTermOpacity),
  };
  // ACTION INJECTOR: keystrokes from THIS terminal go to ITS OWN pty.
  instance.onData((data) => {
    // Single printable char only - onData also fires for pasted bursts and
    // xterm's own multi-byte escape sequences (e.g. arrow keys send
    // \x1b[A), neither of which is "a keystroke" for sound purposes.
    if (data.length === 1 && data >= ' ') sfx.keystroke();
    window.lunacore.write(data, sessionId);
  });
  // MARK MODE + COPY: xterm has no built-in copy binding or keyboard
  // selection, so both live in ONE attachCustomKeyEventHandler (xterm only
  // keeps the last handler attached - a second call would silently replace
  // this one, not add to it).
  //
  // Ctrl+Shift+Arrow extends a keyboard-driven selection one cell/row at a
  // time from an anchor - the keyboard equivalent of Shift+dragging with the
  // mouse, for selecting without fighting xterm's mouse-capture (Mati's
  // request, 2026-08-19). markAnchor/markFocus are absolute buffer
  // coordinates, 0-based to match buffer.cursorX/cursorY/baseY and select() -
  // NOT getSelectionPosition(), which is 1-based (an xterm.js
  // inconsistency), hence the -1 in selectionEdges() below.
  //
  // Ctrl+C (and Ctrl+Shift+C) copies via the same clipboard IPC clipboard.js
  // uses for stored clips - only when there IS a selection; with none, it
  // falls through to onData above and interrupts exactly as before.
  let markAnchor = null;
  let markFocus = null;

  const absCursor = () => {
    const buf = instance.buffer.active;
    return { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  };

  const selectionEdges = () => {
    const pos = instance.getSelectionPosition();
    if (!pos) return null;
    return {
      start: { x: pos.start.x - 1, y: pos.start.y - 1 },
      end: { x: pos.end.x - 1, y: pos.end.y - 1 },
    };
  };

  // Only scrolls when the focus cell actually left the viewport, rather than
  // re-snapping it to the top on every move (which would fight the user
  // extending a selection that is already fully on screen).
  const scrollIntoView = (y) => {
    const buf = instance.buffer.active;
    if (y < buf.viewportY) instance.scrollToLine(y);
    else if (y > buf.viewportY + instance.rows - 1) instance.scrollToLine(y - instance.rows + 1);
  };

  const applyMarkSelection = () => {
    const cols = instance.cols;
    const [start, end] =
      markAnchor.y < markFocus.y || (markAnchor.y === markFocus.y && markAnchor.x <= markFocus.x)
        ? [markAnchor, markFocus]
        : [markFocus, markAnchor];
    // select()'s length is a flat row-major count, so it wraps across rows
    // on its own - no need to special-case a same-row vs. multi-row range.
    instance.select(start.x, start.y, (end.y - start.y) * cols + (end.x - start.x) + 1);
    scrollIntoView(markFocus.y);
  };

  const MARK_ARROWS = {
    ArrowLeft: { dx: -1, dy: 0 },
    ArrowRight: { dx: 1, dy: 0 },
    ArrowUp: { dx: 0, dy: -1 },
    ArrowDown: { dx: 0, dy: 1 },
  };

  instance.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    const arrow = MARK_ARROWS[event.key];
    if (event.ctrlKey && event.shiftKey && !event.altKey && arrow) {
      if (!markAnchor) {
        // Continue an existing mouse/Shift-drag selection if there is one,
        // rather than discarding it and starting over from the cursor.
        const existing = selectionEdges();
        markAnchor = existing ? existing.start : absCursor();
        markFocus = existing ? existing.end : absCursor();
      }
      const maxY = instance.buffer.active.length - 1;
      if (arrow.dx !== 0) {
        markFocus.x += arrow.dx;
        if (markFocus.x < 0) {
          markFocus.x = instance.cols - 1;
          markFocus.y = Math.max(0, markFocus.y - 1);
        } else if (markFocus.x >= instance.cols) {
          markFocus.x = 0;
          markFocus.y = Math.min(maxY, markFocus.y + 1);
        }
      } else {
        markFocus.y = Math.max(0, Math.min(maxY, markFocus.y + arrow.dy));
      }
      applyMarkSelection();
      return false;
    }

    const isCopyChord = (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'c' || event.key === 'C');
    if (isCopyChord) {
      if (!instance.hasSelection()) return true;
      window.lunacore.copyClipboardEntry(instance.getSelection());
      return false;
    }

    // Any other real key drops the anchor, so the next Ctrl+Shift+Arrow
    // starts fresh from the cursor instead of resuming a stale one. Bare
    // Control/Shift keydowns (mid-chord, before the arrow lands) must NOT
    // count as "another key" or the chord could never complete.
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
      if (markAnchor) instance.clearSelection();
      markAnchor = null;
      markFocus = null;
    }
    return true;
  });

  s = { id: sessionId, term: instance, fitAddon: addon, el, alive: true };
  termsBySession.set(sessionId, s);
  return s;
}

/** Shows one pane; the others keep running (and keep their scrollback). */
export function showPane(sessionId) {
  for (const [id, s] of termsBySession) s.el.classList.toggle('is-active', id === sessionId);
}

/** Tears down terminals whose session no longer exists. */
export function pruneTerms(liveIds) {
  for (const [id, s] of [...termsBySession]) {
    if (liveIds.has(id)) continue;
    s.term.dispose();
    s.el.remove();
    termsBySession.delete(id);
  }
}

/** Facade routing to the active tab's terminal (see the header comment). */
export const term = {
  get _t() {
    const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
    return s ? s.term : null;
  },
  write(data) { const x = this._t; if (x) x.write(data); },
  reset() { const x = this._t; if (x) x.reset(); },
  focus() { const x = this._t; if (x) x.focus(); },
  get cols() { const x = this._t; return x ? x.cols : 80; },
  get rows() { const x = this._t; return x ? x.rows : 24; },
  get options() { const x = this._t; return x ? x.options : {}; },
};

/**
 * A theme's new xterm palette -> ALL tabs, not just the visible one.
 *
 * Assigns the `theme` sub-option only. Writing the whole options object back
 * (`term.options = { ...term.options, theme }`) looks equivalent but is not:
 * the spread carries `cols` and `rows` along with everything else, and xterm
 * throws `Option "cols" can only be set in the constructor` on any attempt to
 * set them afterwards. Surfaced by --luna-probe the first time it cycled themes
 * with live sessions open.
 */
export function applyTerminalTheme(palette) {
  if (!palette) return;
  currentTermTheme = palette;
  for (const s of termsBySession.values()) {
    s.term.options.theme = { ...s.term.options.theme, ...palette };
  }
  // Compose, don't race (§4): a theme switch would otherwise overwrite a
  // customized opacity back to the incoming theme's fully-opaque background.
  applyOpacityToAllTabs();
}

// Knobs that change the cell grid, not just how a cell is painted - a change
// to any of these desyncs xterm's cols/rows from what the pty thinks the
// terminal size is until fitAndResize() runs (§4).
const RESIZE_AFFECTING_KEYS = ['termFontFamily', 'termFontSize', 'termLineHeight', 'termLetterSpacing'];

// raw uiprefs.js key -> xterm ITerminalOptions key. Only the keys this
// function actually knows how to apply live; termBgOpacity/termBgBlur are
// handled separately (§4's opacity-via-theme and CSS-blur, not plain
// term.options).
const APPEARANCE_KEY_MAP = {
  termFontFamily: 'fontFamily',
  termFontSize: 'fontSize',
  termLineHeight: 'lineHeight',
  termLetterSpacing: 'letterSpacing',
  termCursorStyle: 'cursorStyle',
  termCursorBlink: 'cursorBlink',
  termScrollback: 'scrollback',
};

/**
 * A customized terminal appearance -> ALL tabs, not just the visible one -
 * same "global, not per-tab" shape as applyTerminalTheme() (§0/§4). Only the
 * term* keys actually present in `prefs` are touched, so a caller may pass a
 * single changed field (e.g. `{ termFontSize: 18 }`) or a full prefs object.
 */
export function applyTerminalAppearance(prefs) {
  if (!prefs) return;
  let resizeNeeded = false;

  for (const [rawKey, xtermKey] of Object.entries(APPEARANCE_KEY_MAP)) {
    if (!(rawKey in prefs)) continue;
    currentTermAppearance[xtermKey] = prefs[rawKey];
    if (RESIZE_AFFECTING_KEYS.includes(rawKey)) resizeNeeded = true;
    for (const s of termsBySession.values()) {
      s.term.options[xtermKey] = prefs[rawKey];
    }
  }

  // Not a term.options.* key - composes into theme.background (§2/§4).
  if ('termBgOpacity' in prefs) {
    currentTermOpacity = prefs.termBgOpacity;
    applyOpacityToAllTabs();
  }

  // Pure CSS, no xterm involvement (§2/§4) - the var() fallback in styles.css
  // covers a launch before this ever runs.
  if ('termBgBlur' in prefs) {
    document.documentElement.style.setProperty('--term-blur', `${prefs.termBgBlur}px`);
  }

  // Custom background image (2026-08-13, from Mati's request): lives on
  // #terminal (termHost), the ANCESTOR of every .terminal__pane, not on the
  // panes themselves - so applyOpacityToAllTabs()'s transparent canvas
  // reveals it, and .terminal__pane's own backdrop-filter blurs it, rather
  // than each pane needing its own copy of the image. `termHost` can be null
  // if this fires before the `terminal` widget has mounted (defensive only -
  // initAppearance() -> initTermcustomSettings() -> initSessions() already
  // guarantees mount-before-use in renderer.js's startup order).
  if ('termBgImage' in prefs && termHost) {
    termHost.style.backgroundImage = prefs.termBgImage ? `url("${prefs.termBgImage}")` : 'none';
  }

  if (resizeNeeded) fitAndResize();
}

/**
 * Fits the ACTIVE terminal to its container and syncs its pty size.
 * Background tabs have zero dimensions (display:none), so fit() would give them
 * a nonsensical 1x1 - they get their size the first time they are shown.
 */
export function fitAndResize() {
  const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
  if (!s) return;
  try {
    s.fitAddon.fit();
    window.lunacore.resize(s.term.cols, s.term.rows, activeSessionId);
  } catch (err) {
    // Ignore fit errors while the window is momentarily zero-sized.
  }
}
