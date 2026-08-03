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

// -- IPC feeds ----------------------------------------------------------------
// One listener per process-wide channel, fanned out on the bus. First, so the
// feeds exist before anything subscribes - though they replay their last
// payload anyway, which is what lets a widget mount late (A2).
import './modules/feeds.js';

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
import './modules/scratchpad.js';
import './modules/palette.js';

// -- Left panel: switchers, ports, appearance ---------------------------------
import { initProfiles, initProjects } from './modules/switchers.js';
import { initPorts } from './modules/ports.js';
import { initAppearance } from './modules/appearance.js';

// -- Widgets (A2) -------------------------------------------------------------
// Blocks converted to the widget contract. They self-register at import time
// (the imports above are what pull them in) and are mounted below, into the
// [data-slot] placeholder that marks their spot in index.html.
import { mountIntoSlot, remountWidget, mountedWidgets } from './modules/host.js';
import { listWidgets } from './modules/registry.js';
import { busStats } from './modules/bus.js';

// Order here is cosmetic FOR LAYOUT - each widget lands in its own [data-slot],
// so the panel's arrangement comes from index.html, not from this list.
//
// It is NOT cosmetic for the bus, though: a widget that subscribes in mount()
// joins a channel in mount order. `autocompact` therefore has to come after
// `context`, which is the same order their imports used to give them (see the
// import comment above) - context updates the bar, then autocompact decides
// whether that reading is worth injecting /compact over.
const WIDGETS = ['ports', 'scratchpad', 'usage', 'skilltracker', 'context', 'autocompact'];

// ---- Startup ----------------------------------------------------------------
//
// Everything above only registers listeners and bus subscriptions. Nothing has
// hit IPC yet, so every subscriber is in place before the first payload lands -
// in particular initAppearance() broadcasts a language change, and each module
// must already be listening for it.

// Widgets go up FIRST: their DOM has to exist before the init calls below
// (initPorts) reach for it, and before initAppearance() broadcasts the first
// language change.
for (const id of WIDGETS) mountIntoSlot(id);

initProfiles();
initProjects();
initCheatsheets();
initPrompts();
initSkills();
initPorts();
initAppearance();
initSessions();

// ---- Dev hooks (A2) ---------------------------------------------------------
//
// The whole point of the widget contract is that unmount() undoes everything a
// widget did, and nothing in normal use ever unmounts anything - so a leaked
// subscription would stay invisible until Phase C moved a panel, where it would
// look like a layout bug instead. This is the handle for exercising it:
//
//   __luna.remount('ports')   // then check renders/clicks still happen ONCE
//
// Cheap enough to keep shipped; it also lists what is registered vs mounted.
window.__luna = {
  remount: remountWidget,
  mounted: mountedWidgets,
  widgets: () => listWidgets().map((w) => w.id),
  // Subscriber counts per bus channel - see busStats(). Remount, compare, and a
  // forgotten disposer shows up as a number that grew.
  stats: busStats,
};

// ---- Window events ----------------------------------------------------------

window.addEventListener('resize', fitAndResize);

window.addEventListener('DOMContentLoaded', () => {
  fitAndResize();
});
