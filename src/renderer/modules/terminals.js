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
 * This module owns `{ term, fitAddon, el, alive }`. Everything else on the
 * bucket belongs to whichever module registered a session view on the bus
 * (led.js adds ledState/ledDead, context.js adds lastCtx, spark.js adds
 * sparkBuf) - see bus.js. Nothing here reads those keys.
 */
const termsBySession = new Map();

let activeSessionId = null;

// Last xterm palette handed over by a theme. New tabs must get it immediately,
// otherwise they would be born in the default cyberpunk despite another theme.
let currentTermTheme = null;

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

  const instance = new Terminal(TERM_OPTIONS);
  const addon = new FitAddon.FitAddon();
  instance.loadAddon(addon);
  instance.open(el);
  if (currentTermTheme) {
    instance.options.theme = { ...instance.options.theme, ...currentTermTheme };
  }
  // ACTION INJECTOR: keystrokes from THIS terminal go to ITS OWN pty.
  instance.onData((data) => {
    // Single printable char only - onData also fires for pasted bursts and
    // xterm's own multi-byte escape sequences (e.g. arrow keys send
    // \x1b[A), neither of which is "a keystroke" for sound purposes.
    if (data.length === 1 && data >= ' ') sfx.keystroke();
    window.lunacore.write(data, sessionId);
  });

  s = { term: instance, fitAddon: addon, el, alive: true };
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
