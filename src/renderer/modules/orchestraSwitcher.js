// ============================================================================
// LunaCore - God Mode board project switcher (docs/tbc_docs/MULTI_GODMODE_PLAN.md A4)
// ----------------------------------------------------------------------------
// A role="tablist" strip of chips, one per project with a run (plus the
// active tab's project when it has none yet, to plan it). Each chip: label,
// a status dot and the state as text - never colour alone. Roving tabindex:
// only the selected chip is in the Tab order; Arrow keys / Home / End move
// and select (automatic activation, the board repaints at once). The board
// re-creates the strip on every render, so the caller passes `focus` when a
// chip had focus and the new selected chip takes it back.
// Labels go in through textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The chip's state line: "paused until 03:10", "scheduled 01:00", or the plain state. */
function stateText(chip) {
  if (chip.state === 'paused' && Number.isFinite(chip.pausedUntil)) return t('orch.runs.pausedUntil', { time: clock(chip.pausedUntil) });
  if (chip.state === 'scheduled' && Number.isFinite(chip.scheduledAt)) return t('orch.runs.scheduledAt', { time: clock(chip.scheduledAt) });
  return t(`orch.runs.state.${chip.state}`);
}

const chipLabel = (chip) => chip.label || chip.projectId || t('orch.runs.noProject');

function chipButton(chip, selected) {
  const btn = el('button', `orchestra-runs__chip is-${chip.state}`);
  btn.type = 'button';
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  btn.tabIndex = selected ? 0 : -1;
  const dot = el('span', 'orchestra-runs__dot');
  dot.setAttribute('aria-hidden', 'true');
  const state = stateText(chip);
  btn.append(dot, el('span', 'orchestra-runs__label', chipLabel(chip)), el('span', 'orchestra-runs__state', state));
  btn.title = `${chipLabel(chip)} - ${state}`;
  return btn;
}

const KEY_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** The chip index a navigation key moves to, or null for any other key. */
function targetIndex(key, current, count) {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (!Object.prototype.hasOwnProperty.call(KEY_STEP, key)) return null;
  return (current + KEY_STEP[key] + count) % count;
}

/**
 * The switcher strip, or null with fewer than two chips (one run needs no switch).
 * @param {{
 *   chips: Array<{projectId:string|null, label:string|null, state:string, pausedUntil?:number|null, scheduledAt?:number|null}>,
 *   selected: string|null,
 *   onSelect: (projectId:string|null) => void,
 *   focus?: boolean,
 * }} opts
 * @returns {HTMLElement|null}
 */
export function switcherStrip({ chips, selected, onSelect, focus = false }) {
  if (!Array.isArray(chips) || chips.length < 2) return null;
  const strip = el('div', 'orchestra-runs');
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', t('orch.runs.label'));
  const found = chips.findIndex((c) => c.projectId === selected);
  const selectedIndex = found < 0 ? 0 : found;
  const buttons = chips.map((chip, i) => chipButton(chip, i === selectedIndex));
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (i !== selectedIndex) onSelect(chips[i].projectId);
    });
  });
  strip.addEventListener('keydown', (e) => {
    const to = targetIndex(e.key, selectedIndex, chips.length);
    if (to === null) return;
    e.preventDefault();
    if (to !== selectedIndex) onSelect(chips[to].projectId);
  });
  strip.append(...buttons);
  // Runs after the caller has attached the strip.
  if (focus) queueMicrotask(() => buttons[selectedIndex].focus());
  return strip;
}
