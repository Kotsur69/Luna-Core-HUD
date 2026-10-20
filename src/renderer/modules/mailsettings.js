// ============================================================================
// LunaCore - report email settings (Settings overlay, renderer)
// ----------------------------------------------------------------------------
// Connect Gmail (gmail.send only), the nightly summary toggle + time, "send
// even when empty", "Send test now", and God Mode v2's "Email me when a run
// finishes" (wired from orchestrasettings.js through mountRunEmailToggle).
// Main keeps the settings in config/mail.local.json and decides the
// recipient; this only shows state and sends toggles. Same static-overlay
// mount shape as orchestrasettings.js.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t } from './util.js';

const ipcFailed = () => ({ ok: false, reason: 'ipc' });
const listeners = new Set();
let last = null;

function errText(reason) {
  const key = `mailset.err.${reason}`;
  return t(key) === key ? t('mailset.err.failed') : t(key);
}

function publish(res) {
  if (!res || !res.ok) return;
  last = res;
  for (const fn of listeners) fn(res);
}

const call = async (fn) => {
  const res = await fn().catch(ipcFailed);
  publish(res);
  return res;
};

function setSwitch(root, id, on, enabled = true) {
  const box = root.querySelector(`#${id}-toggle`);
  const status = root.querySelector(`#${id}-status`);
  if (!box) return;
  box.checked = on;
  box.disabled = !enabled;
  if (status) status.textContent = t(on ? 'mailset.on' : 'mailset.off');
}

function bindSwitch(root, id, key) {
  const box = root.querySelector(`#${id}-toggle`);
  if (!box) return;
  box.addEventListener('change', () => {
    sfx.modeToggle();
    call(() => window.lunacore.mailSet({ [key]: box.checked }));
  });
}

/** God Mode v2's "Email me when a run finishes" (Settings -> God Mode v2). */
export function mountRunEmailToggle(root) {
  const field = root.querySelector('#orchestra-email-field');
  bindSwitch(root, 'orchestra-email', 'godmodeEmail');
  listeners.add((s) => {
    setSwitch(root, 'orchestra-email', s.godmodeOn, s.gmail.connected);
    // Disabled until Gmail is connected: the hint says where.
    if (field) field.title = t(s.gmail.connected ? 'orchset.email.hint' : 'orchset.email.needGmail');
  });
  if (last) publish(last);
}

/** @param {HTMLElement} root the Settings overlay */
export function mountMailSettings(root) {
  const status = root.querySelector('#mail-gmail-status');
  const connect = root.querySelector('#mail-gmail-connect');
  const time = root.querySelector('#mail-nightly-time');
  const test = root.querySelector('#mail-test');
  const testStatus = root.querySelector('#mail-test-status');
  if (!status || !connect || !time || !test) return;

  listeners.add((s) => {
    const g = s.gmail;
    status.textContent = g.connected ? t('mailset.gmail.on', { email: g.email }) : t(g.configured ? 'mailset.gmail.off' : 'mailset.gmail.noClient');
    connect.textContent = t(g.connected ? 'mailset.gmail.disconnect' : 'mailset.gmail.connect');
    connect.disabled = !g.configured && !g.connected;
    setSwitch(root, 'mail-nightly', s.prefs.nightlyEnabled, g.connected);
    setSwitch(root, 'mail-empty', s.prefs.sendWhenEmpty, g.connected);
    time.value = s.prefs.nightlyTime;
    time.disabled = !g.connected;
    test.disabled = !g.connected;
  });

  bindSwitch(root, 'mail-nightly', 'nightlyEnabled');
  bindSwitch(root, 'mail-empty', 'sendWhenEmpty');

  time.addEventListener('change', async () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) return;
    const res = await call(() => window.lunacore.mailSet({ nightlyTime: time.value }));
    if (!res.ok && testStatus) testStatus.textContent = errText(res.reason);
  });

  connect.addEventListener('click', async () => {
    sfx.modeToggle();
    connect.disabled = true;
    const connected = last && last.gmail.connected;
    if (!connected) status.textContent = t('mailset.gmail.waiting');
    const res = await call(() => (connected ? window.lunacore.mailDisconnect() : window.lunacore.mailConnect()));
    if (!res.ok) {
      status.textContent = errText(res.reason);
      connect.disabled = false;
    }
  });

  test.addEventListener('click', async () => {
    sfx.modeToggle();
    test.disabled = true;
    if (testStatus) testStatus.textContent = t('mailset.test.sending');
    const res = await window.lunacore.mailTest().catch(ipcFailed);
    if (testStatus) testStatus.textContent = res.ok ? t('mailset.test.sent') : errText(res.reason);
    test.disabled = false;
  });

  call(() => window.lunacore.mailStatus());
  // Connected elsewhere (another Settings open, a restart): re-read on show.
  root.addEventListener('focusin', () => {
    if (!connect.disabled) call(() => window.lunacore.mailStatus());
  });
}
