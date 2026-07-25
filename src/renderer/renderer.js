// ============================================================================
// LunaCore - renderer entry point
// ----------------------------------------------------------------------------
// This file used to be the whole frontend (~1550 lines of shared scope). It is
// now only the wiring: import the modules, then run the async initialisers in
// one visible order.
//
// Loaded as <script type="module"> from index.html. Modules are deferred, so
// the DOM is fully parsed before any of this runs and every module may look up
// its elements at import time. The xterm UMD globals (Terminal, FitAddon) and
// window.i18n come from classic <script> tags that execute earlier.
//
// The renderer reaches the main process ONLY through window.lunacore - the
// contextBridge in preload.js. See docs in FUTURE_PLAN.md §8 (A1).
// ============================================================================

'use strict';

// -- Terminal, tabs and session routing ---------------------------------------
import { fitAndResize } from './modules/terminals.js';
import { initSessions } from './modules/sessions.js';

// -- Right panel: metrics -----------------------------------------------------
// context before spark and autocompact: both read its thresholds, and this is
// also the order their context-stream subscribers should fire in.
import './modules/context.js';
import './modules/spark.js';
import './modules/usage.js';
import './modules/skilltracker.js';

// -- Action Injector ----------------------------------------------------------
import './modules/actions.js';
import './modules/autocompact.js';
import { initCheatsheets } from './modules/cheatsheets.js';
import { initPrompts } from './modules/prompts.js';
import { initSkills } from './modules/skills.js';
import { initScratchpad } from './modules/scratchpad.js';
import './modules/palette.js';

// -- Left panel: switchers, ports, appearance ---------------------------------
import { initProfiles, initProjects } from './modules/switchers.js';
import { initPorts } from './modules/ports.js';
import { initAppearance } from './modules/appearance.js';

// ---- Startup ----------------------------------------------------------------
//
// Everything above only registers listeners and bus subscriptions. Nothing has
// hit IPC yet, so every subscriber is in place before the first payload lands -
// in particular initAppearance() broadcasts a language change, and each module
// must already be listening for it.

initProfiles();
initProjects();
initCheatsheets();
initPrompts();
initSkills();
initScratchpad();
initPorts();
initAppearance();
initSessions();

// ---- Window events ----------------------------------------------------------

window.addEventListener('resize', fitAndResize);

window.addEventListener('DOMContentLoaded', () => {
  fitAndResize();
});
