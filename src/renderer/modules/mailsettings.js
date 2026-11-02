// ============================================================================
// LunaCore - report email settings (Settings overlay, renderer)
// ----------------------------------------------------------------------------
// Connect Gmail (gmail.send only), the nightly summary toggle + time, "send
// even when empty", "Send test now", and God Mode v2's "Email me when a run
// finishes" (wired from orchestrasettings.js through mountRunEmailToggle),
// and the opt-in "Read replies to Luna's Work emails" with its per-project
// client addresses (B17, src/lunasworkMailReplies.js).
// Main keeps the settings in config/mail.local.json and decides the
// recipient; this only shows state and sends toggles. Same static-overlay
// mount shape as orchestrasettings.js.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t, loc } from './util.js';

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

/** Comma / space separated addresses -> a list (main validates each). */
const parseEmails = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

/**
 * "Read replies to Luna's Work emails" (B17, opt-in) and the per-project
 * client allow-list. Turning it on opens Google's read-only consent.
 */
function mountReplySettings(root) {
  const box = root.querySelector('#mail-replies-toggle');
  const project = root.querySelector('#mail-clients-project');
  const emails = root.querySelector('#mail-clients-emails');
  const save = root.querySelector('#mail-clients-save');
  const msg = root.querySelector('#mail-replies-msg');
  if (!box || !project || !emails || !save) return;
  const say = (text) => {
    if (msg) msg.textContent = text;
  };

  const fillEmails = () => {
    const clients = last && last.replies ? last.replies.clients : {};
    emails.value = (clients[project.value] || []).join(', ');
  };

  listeners.add((s) => {
    const r = s.replies;
    if (!r) return;
    setSwitch(root, 'mail-replies', r.on, s.gmail.connected);
    const ids = r.projects.map((p) => p.id).join('|');
    if (project.dataset.ids !== ids) {
      const keep = project.value;
      project.replaceChildren(...r.projects.map((p) => new Option(loc(p.label) || p.id, p.id)));
      if (r.projects.some((p) => p.id === keep)) project.value = keep;
      project.dataset.ids = ids;
    }
    fillEmails();
    const off = !r.projects.length;
    project.disabled = off;
    emails.disabled = off;
    save.disabled = off;
  });

  box.addEventListener('change', async () => {
    sfx.modeToggle();
    const on = box.checked;
    box.disabled = true;
    say(on ? t('mailset.gmail.waiting') : '');
    const res = await call(() => window.lunacore.mailReplies(on));
    box.disabled = false;
    if (!res.ok) {
      box.checked = !on;
      say(errText(res.reason));
    } else {
      say(on ? t('mailset.replies.ready') : '');
    }
  });

  project.addEventListener('change', fillEmails);

  save.addEventListener('click', async () => {
    sfx.modeToggle();
    const res = await call(() => window.lunacore.mailReplyClients(project.value, parseEmails(emails.value)));
    say(res.ok ? t('mailset.clients.saved') : errText(res.reason));
  });
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

  mountReplySettings(root);
  call(() => window.lunacore.mailStatus());
  // Connected elsewhere (another Settings open, a restart): re-read on show.
  root.addEventListener('focusin', () => {
    if (!connect.disabled) call(() => window.lunacore.mailStatus());
  });
}
