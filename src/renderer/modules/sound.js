// ============================================================================
// LunaCore - sound trigger module
// ----------------------------------------------------------------------------
// Plain service module, no DOM (same category as bus.js) - imported by
// whatever module already owns the relevant click handler, not a global
// click-scraper. Every call goes through window.lunacore.playSound(), the one
// narrow preload bridge (contextIsolation: renderer never touches mpv).
//
// Keystroke sound moved to keysynth.js (Web Audio synth, no IPC hop) -
// CONCEPT_TYPING_SYNTH.md. Everything below still plays through mpv.
// ============================================================================

'use strict';

function playSound(key, opts) {
  window.lunacore.playSound(key, opts);
}

export const sfx = {
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
