// ============================================================================
// LunaCore - host mode inside the running HUD (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/REMOTE_HOST_PLAN.md, "Host runtime". One owner for "this HUD is also a
// host": a second `--host` launch (src/hostmain.js second-instance) and the
// in-app toggle (Settings -> Host mode, src/hostmodeipc.js) both go through
// here, so there is exactly one startHost() per process.
//
//   start({makeDefault, hideWindows})  startHost() on the HUD's own cloud
//   stop()                             the host's own Stop: tray, heartbeat,
//                                      host_commands loop, keep-awake, chats
//   makeDefault()                      `--host --make-default`: the default
//                                      flag, starting host mode if it is off
//   status()                           {on, isDefault, machine}
//
// The launcher switch hides the HUD windows (as before); the in-app toggle
// leaves them up - the user is looking at the Settings pane that flipped it.
// ============================================================================

'use strict';

/**
 * @param {{
 *   machine: string,
 *   startHost: (opts: object) => {stop: () => void, setDefault: () => void},
 *   hud: () => ({cloud: object|null, chatTabs?: object|null, configSync?: {soon: () => void}|null}),
 *   windows: () => Array<{hide: () => void, show: () => void, isDestroyed: () => boolean}>,
 *   isDefault: () => boolean,
 *   log?: (...args: unknown[]) => void,
 * }} deps
 */
function createHostSwitch({ machine, startHost, hud, windows, isDefault, log = console.error }) {
  let host = null;

  const status = () => ({ ok: true, on: Boolean(host), isDefault: Boolean(isDefault()), machine });

  /** The HUD's config sync pushes host:default; the switched host has none of its own. */
  function pushDefaultSoon() {
    const { configSync } = hud() || {};
    if (configSync && typeof configSync.soon === 'function') configSync.soon();
  }

  function start({ makeDefault = false, hideWindows = false } = {}) {
    if (host) {
      if (makeDefault) host.setDefault();
      return status();
    }
    // Only once the HUD is up: its cloud must exist, or a second one would start.
    const { cloud, chatTabs } = hud() || {};
    if (!cloud) {
      log('[hostswitch] HUD cloud not ready, host mode not started');
      return { ok: false, reason: 'notReady' };
    }
    const hidden = hideWindows ? windows() : [];
    const showAll = () => hidden.filter((w) => !w.isDestroyed()).forEach((w) => w.show());
    hidden.forEach((w) => w.hide());
    try {
      host = startHost({
        machine,
        makeDefault,
        cloud,
        chatTabs: chatTabs || null,
        // Every default write (start flag, this switch, the host tray's item).
        onDefaultSet: pushDefaultSoon,
        onStop: () => {
          host = null;
          showAll();
        },
      });
    } catch (err) {
      log('[hostswitch] host mode failed to start:', err && err.message);
      host = null;
      showAll();
      return { ok: false, reason: 'failed' };
    }
    return status();
  }

  function stop() {
    // host.stop() runs onStop above, which clears `host`.
    if (host) host.stop();
    return status();
  }

  const makeDefault = () => start({ makeDefault: true });

  return { start, stop, makeDefault, status, isOn: () => Boolean(host) };
}

module.exports = { createHostSwitch };
