// ============================================================================
// LunaCore - "Claude Code not found" notice (D3)
// ----------------------------------------------------------------------------
// LunaCore ships publicly now, so it has to be honest with someone who has
// never installed Claude Code. Before this, the PTY spawned a perfectly good
// shell, the user typed nothing, and the only clue was a `command not found`
// buried in the terminal - true, but useless if you do not already know what
// the missing thing is or where to get it.
//
// NOT a widget. The banner sits outside .app (see index.html) because .app is
// the layout grid, so it registers nothing on the bus and no preset can place
// or unmount it. That also means it needs no cleanup: it is created once with
// the document and simply shown or not.
//
// Localisation is free here. The markup carries data-i18n keys and lives in the
// DOM from the start, so applyStatic() fills it during initAppearance() and
// re-fills it on every language switch - no langChange subscription needed.
// ============================================================================

'use strict';

/**
 * Shows the notice when `claude` is nowhere on PATH.
 *
 * Silence is the failure mode on purpose. If the check itself throws we show
 * nothing: a banner claiming Claude Code is missing on a machine where it is
 * installed is worse than no banner - it would send someone to reinstall a
 * working tool. Only a definite "not found" is worth interrupting anyone for.
 */
export async function initClaudeCheck() {
  const el = document.getElementById('claude-missing');
  if (!el) return;

  let status;
  try {
    status = await window.lunacore.getClaudeStatus();
  } catch {
    return; // a check that failed is not evidence of anything
  }
  if (!status || status.found) return;

  const docs = document.getElementById('claude-missing-docs');
  const close = document.getElementById('claude-missing-close');

  if (docs) docs.addEventListener('click', () => window.lunacore.openClaudeDocs());
  // Dismissible rather than blocking: LunaCore is also usable as a plain
  // terminal, and with a non-Claude profile this notice is simply noise.
  if (close) {
    close.addEventListener('click', () => {
      el.hidden = true;
    });
  }

  el.hidden = false;
}
