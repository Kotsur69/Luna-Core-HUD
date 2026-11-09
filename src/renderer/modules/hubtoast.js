// ============================================================================
// LunaCore - notification hub: one OS toast per new Needs-you item (renderer)
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N5. A Needs-you item that shows up while the
// window is unfocused fires ONE native toast through notify.js - which keeps
// its opt-in (notificationsEnabled, off by default) - and the hub's own
// switch (hubToasts, Settings -> Notification hub) must be on too. Clicking
// the toast focuses the window and opens the drawer.
//
// The first loaded view is the baseline: what is already waiting at launch is
// the auto-open's job (hubicon.js), not a burst of toasts. The decision itself
// is hubrules.js toastPlan(), pinned by node tests.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onHubView, hubLoaded, onHubPrefs } from './hubstate.js';
import { openHub, itemTitle } from './hubpanel.js';
import { isNotifyEnabled, fireNotification } from './notify.js';
import { toastPlan } from './hubrules.js';

let hubToasts = true;
/** Needs-you ids this session already knows; null until the first loaded view. */
let known = null;
let wired = false;

/** Settings -> Notification hub -> toasts (hubsettings.js), applied live. */
export function setHubToastsEnabled(on) {
  hubToasts = on !== false;
}

function show(item) {
  fireNotification(t('hub.toast.title'), itemTitle(item), () => openHub());
}

/** Called once from hubicon.js mountHubChip(). */
export function wireHubToasts() {
  if (wired) return;
  wired = true;
  Promise.resolve()
    .then(() => window.lunacore.getUiPrefs())
    .then((prefs) => setHubToastsEnabled(!prefs || prefs.hubToasts !== false))
    .catch(() => {});
  // N7: another PC switched toasts on / off.
  onHubPrefs((prefs) => setHubToastsEnabled(prefs.hubToasts !== false));
  onHubView((view, failed) => {
    if (failed || !hubLoaded()) return;
    const plan = toastPlan({
      known,
      items: view.items,
      enabled: isNotifyEnabled(),
      hubToasts,
      focused: document.hasFocus(),
    });
    known = plan.known;
    plan.toast.forEach(show);
  });
}
