// ============================================================================
// LunaCore - "Resume" button: reopen the tabs of the last run (renderer)
// ----------------------------------------------------------------------------
// After a crash or a power cut the main process still knows which Claude
// conversations were open (src/tabResume.js). When there are any, a button
// shows next to the new-tab "+": a click reopens each one in its folder with
// `claude --resume`, a right-click forgets them. Nothing is sent to the model.
// The button is gone for the rest of this run once used or dismissed.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

/** Button label for `count` resumable tabs. Pure. */
export function resumeLabel(count, translate = t) {
  return translate('tabs.resume', { n: count });
}

/** Whole, positive tab count out of an IPC answer; 0 for anything else. Pure. */
export function resumableCount(res) {
  const n = res && typeof res === 'object' ? res.count : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Called once from sessions.js mountTabs() with the tab bar as root. */
export function mountTabResume(root) {
  const button = root.querySelector('#tab-resume');
  if (!button) return;
  let count = 0;

  const render = () => {
    button.hidden = count === 0;
    button.textContent = count ? resumeLabel(count) : '';
    button.title = t('tabs.resume.title');
  };
  const done = () => {
    count = 0;
    render();
  };

  button.addEventListener('click', () => {
    button.disabled = true;
    window.lunacore
      .resumeLastTabs()
      .catch(() => {})
      .finally(() => {
        button.disabled = false;
        done();
      });
  });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.lunacore.dismissResumableTabs().catch(() => {});
    done();
  });
  onLangChange(render);

  window.lunacore
    .getResumableTabs()
    .then((res) => {
      count = resumableCount(res);
      render();
    })
    .catch(() => {});
}
