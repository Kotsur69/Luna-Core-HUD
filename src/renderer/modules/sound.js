// ============================================================================
// LunaCore - sound trigger module
// ----------------------------------------------------------------------------
// Plain service module, no DOM (same category as bus.js) - imported by
// whatever module already owns the relevant click handler, not a global
// click-scraper. Every call goes through window.lunacore.playSound(), the one
// narrow preload bridge (contextIsolation: renderer never touches mpv).
//
// Owns the keystroke THROTTLE - the one place spam-prevention logic lives, so
// callers don't each reinvent it. A burst (fast typing, rapid tab-clicking)
// can't flood the IPC channel / mpv socket.
// ============================================================================

'use strict';

const lastFired = new Map(); // per-key cooldown timestamp

// Which of the 4 keystroke clips to play - set once at startup from the
// soundKeystrokeVariant pref, and again on each change in the Appearance
// panel's picker. undefined until then, in which case resolveSoundFile()
// falls back to variants[0] ('mechanical').
let keystrokeVariant;

/** Called by appearance.js: initAppearance() and the variant <select>'s change handler. */
export function setKeystrokeVariant(id) {
  keystrokeVariant = id;
}

function playSound(key, opts, { throttleMs = 0 } = {}) {
  if (throttleMs > 0) {
    const now = Date.now();
    const last = lastFired.get(key) || 0;
    if (now - last < throttleMs) return;
    lastFired.set(key, now);
  }
  window.lunacore.playSound(key, opts);
}

export const sfx = {
  keystroke: () => playSound('sfx.keystroke', { variant: keystrokeVariant }, { throttleMs: 55 }),
  navClick: () => playSound('sfx.navClick'),
  modeToggle: () => playSound('sfx.modeToggle'),
  terminalNew: () => playSound('sfx.terminalNew'),
  terminalClose: () => playSound('sfx.terminalClose'),
};

export const voice = {
  welcome: () => playSound('voice.welcome'),
  needYou: () => playSound('voice.needYou'),
  done: () => playSound('voice.done'),
  usage50: () => playSound('voice.usage50'),
  usage80: () => playSound('voice.usage80'),
};
