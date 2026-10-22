// ============================================================================
// LunaCore - Getting started guide (first-launch overlay)
// ----------------------------------------------------------------------------
// Main decides whether it opens on this start (src/welcome.js, welcome:get):
// once on a clean profile, never for existing users, again only after a major
// version bump that changed the guide. "Don't show this again" (checked by
// default) records it via welcome:dismiss; Ctrl+L -> Setup -> "Getting
// started" reopens it any time. Static markup in index.html (#welcome), same
// overlay shell and close behaviour as the Settings overlay.
// ============================================================================

'use strict';

import { openSettingsAt } from './termcustom.js';
import { closeWithExit, cancelExit } from './motion.js';

const welcomeEl = document.getElementById('welcome');
const els = welcomeEl && {
  dontShow: welcomeEl.querySelector('#welcome-dontshow'),
  close: welcomeEl.querySelector('#welcome-close'),
  openSetup: welcomeEl.querySelector('#welcome-open-setup'),
};

let isOpen = false;

export function openWelcome() {
  if (!welcomeEl || isOpen) return;
  cancelExit(welcomeEl);
  isOpen = true;
  welcomeEl.hidden = false;
  welcomeEl.focus();
}

/** Closes the guide and tells main whether to keep it closed. */
function closeWelcome() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(welcomeEl);
  window.lunacore.dismissWelcome(els.dontShow.checked === true).catch(() => {});
}

/** Runs `fn` once the boot sequence overlay is gone (or right away without one). */
function afterBoot(fn) {
  const boot = document.getElementById('boot');
  if (!boot || boot.hidden) return fn();
  const watch = new MutationObserver(() => {
    if (!boot.hidden) return;
    watch.disconnect();
    fn();
  });
  watch.observe(boot, { attributes: true, attributeFilter: ['hidden'] });
}

/** Called once from renderer.js, after initTermcustomSettings() started the boot sequence. */
export async function initWelcome() {
  if (!welcomeEl || !els.close || typeof window.lunacore.getWelcome !== 'function') return;
  els.close.addEventListener('click', closeWelcome);
  welcomeEl.querySelector('[data-welcome-close]').addEventListener('click', closeWelcome);
  els.openSetup.addEventListener('click', () => {
    closeWelcome();
    openSettingsAt('setup-center');
  });
  welcomeEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeWelcome();
  });
  const reopen = document.getElementById('welcome-reopen');
  if (reopen) {
    reopen.addEventListener('click', () => {
      // Reopened by hand: the box starts checked again, like the first time.
      els.dontShow.checked = true;
      openWelcome();
    });
  }

  let answer = null;
  try {
    answer = await window.lunacore.getWelcome();
  } catch {
    answer = null;
  }
  if (answer && answer.show === true) afterBoot(openWelcome);
}
