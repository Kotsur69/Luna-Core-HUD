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
import './modules/terminal.js';
import { initTermcustomSettings } from './modules/termcustom.js';

// -- Right panel: metrics -----------------------------------------------------
// context before spark and autocompact: both read its thresholds, and this is
// also the order their context-stream subscribers should fire in.
import './modules/context.js';
import './modules/spark.js';
import './modules/usage.js';
import './modules/media.js';
import './modules/skilltracker.js';
import './modules/activefiles.js';
import './modules/sessiontimeline.js';
import './modules/telemetry.js';

// -- Action Injector ----------------------------------------------------------
import './modules/actions.js';
import './modules/autocompact.js';
import './modules/autoproceed.js';
import './modules/notify.js';
import { initCheatsheets } from './modules/cheatsheets.js';
import { initPrompts } from './modules/prompts.js';
import { initSkills } from './modules/skills.js';
import './modules/scratchpad.js';
import './modules/clipboard.js';
import './modules/todo.js';
import './modules/devices.js';
// Both load their own data on first mount rather than at boot: one streams the
// transcripts, the other spawns a git process per repo, and neither is worth
// paying for in a session where the panel is never looked at.
import './modules/mcp.js';
import './modules/git.js';
import './modules/palette.js';
import './modules/gitquick.js';

// -- Left panel: switchers, ports, appearance ---------------------------------
import { initProfiles, initProjects } from './modules/switchers.js';
import { initPorts } from './modules/ports.js';
import { initAppearance, getThemeIds, selectTheme } from './modules/appearance.js';
import { initClaudeCheck } from './modules/claudecheck.js';

// -- Widgets (A2) -------------------------------------------------------------
// Blocks converted to the widget contract. They self-register at import time
// (the imports above are what pull them in) and are mounted below, into the
// [data-slot] placeholder that marks their spot in index.html.
import { remountWidget, mountedWidgets } from './modules/host.js';
import { listWidgets } from './modules/registry.js';
import { busStats } from './modules/bus.js';

// -- Layout presets (C1) ------------------------------------------------------
// Which widgets exist and where they go is data now (config/layouts.json), not
// a list in this file - see modules/layout.js.
import { initLayout, applyLayout, getLayouts, getActiveLayoutId } from './modules/layout.js';
import { initPanels, initPanelResizeTracking } from './modules/panels.js';

// ---- Startup ----------------------------------------------------------------
//
// Everything above only registers listeners and bus subscriptions. Nothing has
// hit IPC yet, so every subscriber is in place before the first payload lands -
// in particular initAppearance() broadcasts a language change, and each module
// must already be listening for it.
//
// The HUD goes up FIRST: widget DOM has to exist before the init calls below
// reach for it, and before initAppearance() broadcasts the first language
// change. initCheatsheets / initPrompts / initSkills / initPorts all render into
// a mounted widget - they load config into module state and repaint, which is a
// no-op if the widget is not on screen yet.
//
// This used to be a hand-maintained WIDGETS array mounted into [data-slot]
// placeholders. C1 replaced it with the active layout preset, which carries two
// ordering constraints that used to live in that array's comment - both are now
// enforced by modules/layout.js rather than by list order:
//
//   * BUS ORDER. A widget that subscribes in mount() joins a channel in mount
//     order, and `autocompact` must come after `context`: context updates the
//     bar, then autocompact decides whether that reading is worth injecting
//     /compact over. Nested widgets mount last, so this holds for every preset.
//   * DOM ORDER. `autocompact`'s placeholder is nested INSIDE the w-actions
//     template, so `actions` must be on screen before it. Same rule, same reason
//     it holds: nested last. This is also why a layout cannot place autocompact
//     itself - it has no region of its own.
//
// Top-level await: this is the entry module, so nothing is being held up, but it
// does mean the code below runs after DOMContentLoaded rather than before it -
// hence the direct fitAndResize() at the bottom instead of a listener.
// C2 before C1: initLayout() draws the HUD and ends by calling applyPanels(),
// which needs the remembered fold state and column widths already in hand -
// otherwise the first paint shows every panel open and every preset at its
// authored widths, then corrects itself a frame later.
await initPanels();
initPanelResizeTracking();

await initLayout();

initProfiles();
initProjects();
initCheatsheets();
initPrompts();
initSkills();
initPorts();
initAppearance();
// After initAppearance(): boot's animation needs language + theme already
// applied, same ordering constraint startBoot() has always documented.
initTermcustomSettings();
initSessions();

// D3. After initAppearance() so applyStatic() has already resolved the notice's
// data-i18n keys - showing it earlier would flash the authored English strings
// at a user who chose Polish. Not awaited: it is an IPC round trip, and nothing
// below depends on its answer.
initClaudeCheck();

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
  // C1: __luna.layout('focus') switches presets from the console, and is the
  // harsher version of remount() - it moves every widget root at once, and
  // unmounts whatever the new preset has no region for.
  layout: applyLayout,
  layouts: () => getLayouts().map((l) => l.id),
  activeLayout: getActiveLayoutId,
  // C3: __luna.theme('amber-crt'). Applies without persisting, so cycling the
  // list here cannot overwrite the saved choice in ui.local.json.
  theme: selectTheme,
  themes: getThemeIds,
  // The inline custom properties a theme has written onto :root. The probe
  // compares this set before and after cycling every theme: a token left behind
  // by a theme the next one does not mention is invisible on screen but changes
  // how the HUD looks for the rest of the session.
  tokens: () => [...document.documentElement.style].filter((p) => p.startsWith('--')).sort(),
};

// ---- Window events ----------------------------------------------------------

window.addEventListener('resize', fitAndResize);

// Not DOMContentLoaded: the top-level await above almost certainly outlives it.
fitAndResize();
