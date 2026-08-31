// ============================================================================
// LunaCore - appearance: theme + language
// ----------------------------------------------------------------------------
// Themes come from config/themes.json (maps of CSS tokens + xterm colours), the
// language from the i18n.js dictionary. Both choices persist in
// config/ui.local.json. Switching works live: tokens go onto documentElement,
// xterm palettes through term.options, and the text through applyStatic() plus
// a language broadcast that has every module re-render its own dynamic strings.
//
// `activeThemeId` is kept at module scope (mirroring autocompact's armed flag /
// switchers' currentProfileId) so a remount repaints the select from truth
// instead of its template's first authored <option>; the language equivalent
// is already available as window.i18n.lang, so no separate variable is needed
// for it.
//
// 2026-08-13: sound settings and the boot-sequence toggle (mountBoot) moved
// OUT of this widget into termcustom.js's Settings overlay (Ctrl+L) - Mati
// wanted the left panel decluttered down to theme/layout/language. This
// module no longer imports sound.js's setKeystrokeVariant or boot.js at all.
// See TERMINAL_CUSTOMIZER_PLAN.md.
// ============================================================================

'use strict';

import { emitLangChange, onLangChange } from './bus.js';
import { applyTerminalTheme, applyTerminalAppearance } from './terminals.js';
import { defineWidget } from './registry.js';
import { getLayouts, getActiveLayoutId, selectLayout, refreshLayouts } from './layout.js';
import { currentUnrailedColumns, copyRailsTo } from './panels.js';
import { slotsFor } from './widgetarrange.js';
import {
  specFromLive,
  saveCustomLayout,
  renameCustomLayout,
  duplicateCustomLayout,
  deleteCustomLayout,
} from './layoutbuilder.js';
import { loc } from './util.js';
import { sfx } from './sound.js';
import { crossfade } from './motion.js';

let themesById = new Map();
let activeThemeId = null;

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

// Tokens the previous theme wrote onto documentElement. See applyThemeVars().
let appliedTokens = [];

/**
 * Puts a theme's tokens on :root and its palette on the terminals.
 *
 * Tokens the OUTGOING theme set and the incoming one does not are removed, not
 * left in place. This matters much more since C3: when every theme carried the
 * same 17 colour tokens they all overwrote each other and nothing could go
 * stale, but the vocabulary is ~45 now and themes deliberately set only what
 * they care about. Without this, switching `matrix` (--radius: 0) -> `light`
 * (silent on radius) would leave every corner square, and the bug would look
 * like it belonged to `light`.
 *
 * Removing rather than resetting is the point: styles.css's :root block is the
 * one source of default values, so a cleared token falls back to it instead of
 * to a second copy of the defaults maintained over here.
 */
function applyThemeVars(theme) {
  if (!theme) return;
  const root = document.documentElement;
  const vars = theme.vars || {};

  for (const k of appliedTokens) {
    if (!(k in vars)) root.style.removeProperty(k);
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  appliedTokens = Object.keys(vars);

  if (theme.terminal && typeof theme.terminal === 'object') {
    applyTerminalTheme(theme.terminal);
  }
}

/**
 * Switches language: static labels, then everything held in module state.
 *
 * Exported: the language <select> itself now lives in the Settings overlay
 * (Ctrl+L, 2026-08-19) - modules/termcustom.js calls this on change, this
 * module keeps owning the apply/persist logic since it's what boots the HUD
 * into the right language in the first place (see initAppearance() below).
 */
export function applyLang(lang) {
  window.i18n.setLang(lang);
  window.i18n.applyStatic();
  emitLangChange();
}

/** Rebuilds the theme select's options and repaints it from module state. */
function renderThemeSwitcher() {
  if (!els || !activeThemeId) return;
  els.themeSwitcher.innerHTML = '';
  for (const th of themesById.values()) {
    const opt = document.createElement('option');
    opt.value = th.id;
    opt.textContent = th.label;
    els.themeSwitcher.appendChild(opt);
  }
  els.themeSwitcher.value = activeThemeId;
}

/**
 * Rebuilds the layout select from layout.js's state (C1).
 *
 * No local mirror of the active id: unlike the theme, a layout can also change
 * from the console (__luna.layout) or be corrected at startup when the
 * remembered preset no longer exists, so the single source of truth is
 * getActiveLayoutId(). Labels are localized, hence the repaint on langChange.
 */
/** layoutId -> saved layout spec, as ui.local.json holds it. v0.10 4.2.
 *  Mirrored at module scope because every builder action is a whole-map write:
 *  see the note on customLayouts in src/uiprefs.js. */
let customLayouts = {};

/** Whether an id belongs to one of the user's own layouts rather than a preset. */
function isOwnLayout(id) {
  return Object.prototype.hasOwnProperty.call(customLayouts, id);
}

/**
 * Which builder buttons are usable right now. v0.10 4.2.
 *
 * Save works from any layout - it snapshots whatever is on screen. The other
 * three act on a SAVED layout, so they stay disabled on a shipped preset: a
 * preset is not the user's to rename or remove, and duplicating one is just Save
 * under another name.
 */
function renderBuilderState() {
  if (!els || !els.layoutName) return;
  const named = els.layoutName.value.trim().length > 0;
  const own = isOwnLayout(els.layoutSwitcher.value);
  els.layoutSave.disabled = !named;
  els.layoutRename.disabled = !named || !own;
  els.layoutDup.disabled = !named || !own;
  els.layoutDel.disabled = !own;
}

function renderLayoutSwitcher() {
  if (!els) return;
  const layouts = getLayouts();
  els.layoutSwitcher.innerHTML = '';
  for (const l of layouts) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = loc(l.label);
    els.layoutSwitcher.appendChild(opt);
  }
  const active = getActiveLayoutId();
  if (active) els.layoutSwitcher.value = active;
  renderBuilderState();
}

/** Ids of every loaded theme, for the console hook and the probe. */
export function getThemeIds() {
  return [...themesById.keys()];
}

/**
 * Switches theme from outside the widget (console hook, --luna-probe).
 *
 * Goes through the same path the select does, including the repaint, so a theme
 * chosen this way cannot leave the switcher showing the previous one. Does NOT
 * persist: this is a look-at-it tool, and the probe cycling all nine themes
 * should not end up rewriting Mati's saved choice.
 */
export function selectTheme(id) {
  if (!themesById.has(id)) return false;
  activeThemeId = id;
  // v0.10 3.1: dissolved rather than slammed. See modules/motion.js - with no
  // View Transitions support, or with motion off, crossfade() just calls this
  // straight through, so the old instant swap is still the fallback path.
  crossfade(() => {
    applyThemeVars(themesById.get(id));
    renderThemeSwitcher();
  });
  return true;
}

export async function initAppearance() {
  let prefs = { theme: 'cyberpunk', lang: 'pl' };
  try {
    prefs = (await window.lunacore.getUiPrefs()) || prefs;
  } catch {
    /* no preferences - stay on the defaults */
  }

  // Before any tab exists (initSessions() runs after initAppearance() in
  // renderer.js), so this only updates terminals.js's currentTermAppearance -
  // ensureTerm() then picks it up for the very first tab, same as
  // currentTermTheme already does for the theme (TERMINAL_CUSTOMIZER_PLAN.md
  // §4/§5). A fallback `prefs` with no term* keys is a safe no-op here.
  applyTerminalAppearance(prefs);

  // v0.10 4.2. Read before renderLayoutSwitcher() below, which needs it to know
  // which of the listed layouts the user is allowed to rename or delete.
  customLayouts = (prefs && prefs.customLayouts) || {};

  // Language first, so applyStatic catches the whole DOM on startup.
  applyLang(prefs.lang);
  // The widget already mounted (initLayout runs first), so its layout options
  // were built in the authored language - relabel them now that we know better.
  renderLayoutSwitcher();

  // Themes: fill the list and apply the active one (or the first available).
  try {
    const { themes } = await window.lunacore.getThemes();
    themesById = new Map((themes || []).map((th) => [th.id, th]));
    const active = themesById.has(prefs.theme)
      ? prefs.theme
      : themes && themes[0] && themes[0].id;
    if (active) {
      activeThemeId = active;
      renderThemeSwitcher();
      applyThemeVars(themesById.get(active));
    }
  } catch {
    /* no themes - the built-in styles.css look stays */
  }
}

defineWidget({
  id: 'appearance',
  titleKey: 'appearance.title',
  template: 'w-appearance',
  mount(root) {
    els = {
      themeSwitcher: root.querySelector('#theme-switcher'),
      layoutSwitcher: root.querySelector('#layout-switcher'),
      // v0.10 4.2 layout builder.
      layoutName: root.querySelector('#layout-name'),
      layoutSave: root.querySelector('#layout-save-btn'),
      layoutRename: root.querySelector('#layout-rename-btn'),
      layoutDup: root.querySelector('#layout-dup-btn'),
      layoutDel: root.querySelector('#layout-del-btn'),
    };

    // Repaint from module state - initAppearance() only runs once at launch,
    // a remount must not fall back to the template's authored defaults.
    renderThemeSwitcher();
    renderLayoutSwitcher();

    // Layout labels are localized - relabel them on every language change, not
    // just the one initAppearance() applies at boot. Used to be a direct call
    // from the lang-select's own 'change' handler, but that select now lives in
    // the Settings overlay (termcustom.js), so this widget needs the generic
    // bus subscription every other widget already uses (see todo.js, etc.).
    const offLang = onLangChange(renderLayoutSwitcher);

    els.themeSwitcher.addEventListener('change', () => {
      sfx.modeToggle();
      activeThemeId = els.themeSwitcher.value;
      crossfade(() => applyThemeVars(themesById.get(activeThemeId)));
      window.lunacore.setUiPrefs({ theme: activeThemeId });
    });

    // C1. Two things to know about this one handler:
    //   * selectLayout() MOVES this very widget's root into the new region while
    //     this listener is on the stack. That is safe precisely because it is a
    //     DOM move, not a remount - the element, its listeners and `els` all
    //     survive (see modules/layout.js).
    //   * on a preset this widget is not part of we could never come back, which
    //     is why src/layouts.js rejects any layout that fails to place it.
    els.layoutSwitcher.addEventListener('change', () => {
      if (!selectLayout(els.layoutSwitcher.value)) renderLayoutSwitcher();
      else renderBuilderState();
    });

    // ---- v0.10 4.2: the layout builder -------------------------------------
    //
    // Every action is the same three steps: transform the map, write it WHOLE
    // (uiprefs merges nothing per entry, which is what makes a delete
    // expressible), then ask the main process for the list again - a layout in
    // ui.local.json does not exist for the renderer until layouts:list has been
    // re-read.
    const commit = async (next, selectId) => {
      customLayouts = next;
      window.lunacore.setUiPrefs({ customLayouts: next });
      await refreshLayouts();
      if (selectId) selectLayout(selectId);
      renderLayoutSwitcher();
    };

    // Shipped ids as well as saved ones: loadLayouts lets the user's source win,
    // so a name that slugged onto a preset's id would make that preset vanish
    // from this very list with no hint why.
    const takenIds = () => [...getLayouts().map((l) => l.id), ...Object.keys(customLayouts)];

    els.layoutName.addEventListener('input', renderBuilderState);

    els.layoutSave.addEventListener('click', async () => {
      const active = getLayouts().find((l) => l.id === els.layoutSwitcher.value);
      const spec = specFromLive({
        layout: active,
        columns: currentUnrailedColumns(),
        slots: active ? slotsFor(active) : null,
        label: els.layoutName.value,
      });
      const out = spec && saveCustomLayout(customLayouts, spec, takenIds());
      if (!out) return;
      sfx.modeToggle();
      // Rails are panels.js's to move - keyed by layout id, deliberately not in
      // the spec. Before the switch, while the current layout is still applied.
      copyRailsTo(out.id);
      els.layoutName.value = '';
      await commit(out.map, out.id);
    });

    els.layoutRename.addEventListener('click', async () => {
      const next = renameCustomLayout(
        customLayouts,
        els.layoutSwitcher.value,
        els.layoutName.value
      );
      if (!next) return;
      sfx.modeToggle();
      els.layoutName.value = '';
      // No selectId: a rename changes a label, not which layout is on screen.
      await commit(next, null);
    });

    els.layoutDup.addEventListener('click', async () => {
      const out = duplicateCustomLayout(
        customLayouts,
        els.layoutSwitcher.value,
        els.layoutName.value,
        takenIds()
      );
      if (!out) return;
      sfx.modeToggle();
      els.layoutName.value = '';
      await commit(out.map, out.id);
    });

    els.layoutDel.addEventListener('click', async () => {
      const doomed = els.layoutSwitcher.value;
      const next = deleteCustomLayout(customLayouts, doomed);
      if (!next) return;
      sfx.modeToggle();

      // Whether we are standing on it has to be decided BEFORE the list is
      // re-read, or getActiveLayoutId() is answering about a layout that no
      // longer appears in it.
      const standingOnIt = getActiveLayoutId() === doomed;
      customLayouts = next;
      window.lunacore.setUiPrefs({ customLayouts: next });
      await refreshLayouts();
      if (standingOnIt) {
        const fallback = getLayouts()[0];
        if (fallback) selectLayout(fallback.id);
      }
      renderLayoutSwitcher();
    });

    return () => {
      offLang();
      els = null;
    };
  },
});
