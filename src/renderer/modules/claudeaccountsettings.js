// ============================================================================
// LunaCore - Claude accounts (Settings overlay, AI providers)
// ----------------------------------------------------------------------------
// The account failover list (src/claudeaccounts.js): which subscription is
// active, which is cooling down after a limit and until when, reorder (first
// = preferred), remove, and add one from a `claude setup-token` token. A
// token goes renderer -> main once, on "Add"; the list never carries one.
// Per account: "Connect usage" / "Use main login" / "Reconnect" for the
// usage-only login that feeds the gauge (src/claudeaccountusage.js) - only
// the account id crosses; an email and a status come back.
// DOM/IPC only - the selection logic is unit-tested in src/claudeaccounts.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

let els = null;
let view = { encryption: true, accounts: [] };
let note = null; // {key, fail, params?}
let connecting = false; // a `claude auth login` is running in main

const clock = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function statusText(a) {
  if (a.limitedUntil) return t('accounts.limitedUntil', { at: clock(a.limitedUntil) });
  return t(a.active ? 'accounts.active' : 'accounts.ready');
}

function button(textKey, onClick, titleKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'termcustom__reset';
  b.textContent = t(textKey);
  if (titleKey) b.title = t(titleKey);
  b.addEventListener('click', onClick);
  return b;
}

/** Runs one list action, then repaints from main's answer. */
async function act(fn, id) {
  let res = null;
  try {
    res = await fn(id);
  } catch {
    res = null;
  }
  note = res && res.ok ? null : { key: 'accounts.saveFailed', fail: true };
  await refresh();
}

/** The account's usage-login line ("usage: <email>", "login expired", ...). */
function usageText(u) {
  if (!u || !u.connected) return t('accounts.usage.none');
  if (u.status === 'reconnect') return t('accounts.usage.expired');
  const email = u.email || '?';
  return t(u.main ? 'accounts.usage.connectedMain' : 'accounts.usage.connectedAs', { email });
}

const USAGE_ERRORS = {
  busy: 'accounts.usage.err.busy',
  noClaude: 'accounts.usage.err.noClaude',
  timeout: 'accounts.usage.err.timeout',
  loginFailed: 'accounts.usage.err.loginFailed',
  noMainLogin: 'accounts.usage.err.noMainLogin',
  badDir: 'accounts.usage.err.badDir',
};

/** Connects (or re-connects) a usage login; the browser login can take minutes. */
async function connectUsage(fn, id) {
  if (connecting) return;
  connecting = true;
  note = { key: 'accounts.usage.connecting', fail: false };
  render();
  let res = null;
  try {
    res = await fn(id);
  } catch {
    res = null;
  }
  connecting = false;
  note = res && res.ok
    ? { key: 'accounts.usage.connected', fail: false, params: { email: res.email || '?' } }
    : { key: USAGE_ERRORS[res && res.error] || 'accounts.saveFailed', fail: true };
  await refresh();
}

/** The usage-login buttons of one row. */
function usageButtons(a) {
  const u = a.usage;
  if (!u || typeof window.lunacore.connectClaudeUsage !== 'function') return [];
  const out = [];
  if (!u.connected) {
    out.push(button('accounts.usage.connect', () => connectUsage(window.lunacore.connectClaudeUsage, a.id), 'accounts.usage.connectHint'));
    out.push(button('accounts.usage.useMain', () => connectUsage(window.lunacore.useMainClaudeUsage, a.id), 'accounts.usage.useMainHint'));
  } else {
    // The main login is renewed by running `claude`, not from here.
    if (u.status === 'reconnect' && !u.main) {
      out.push(button('accounts.usage.reconnect', () => connectUsage(window.lunacore.connectClaudeUsage, a.id), 'accounts.usage.connectHint'));
    }
    out.push(button('accounts.usage.disconnect', () => act(window.lunacore.disconnectClaudeUsage, a.id)));
  }
  for (const b of out) b.disabled = connecting;
  return out;
}

function renderRow(a, index) {
  const li = document.createElement('li');
  li.className = 'project-row';
  const dot = document.createElement('span');
  const dotState = a.limitedUntil ? 'fail' : a.active ? 'ok' : 'unknown';
  dot.className = `diag-item__dot diag-item__dot--${dotState}`;
  const label = document.createElement('span');
  label.className = 'ui-field__label';
  label.textContent = `${index + 1}. ${a.label} - ${statusText(a)}`;
  li.append(dot, label);
  if (a.usage) {
    const usage = document.createElement('span');
    usage.className = a.usage.status === 'reconnect' ? 'hint is-fail' : 'hint';
    usage.textContent = usageText(a.usage);
    li.append(usage);
  }
  if (index > 0) li.append(button('accounts.moveUp', () => act(window.lunacore.moveClaudeAccountUp, a.id), 'accounts.moveUpHint'));
  if (a.limitedUntil) li.append(button('accounts.clearLimit', () => act(window.lunacore.clearClaudeAccountLimit, a.id)));
  li.append(...usageButtons(a));
  li.append(button('accounts.remove', () => act(window.lunacore.removeClaudeAccount, a.id)));
  return li;
}

function render() {
  if (!els) return;
  els.list.replaceChildren(...view.accounts.map(renderRow));
  els.empty.hidden = view.accounts.length > 0;
  els.noEncryption.hidden = view.encryption !== false;
  els.status.hidden = !note;
  if (note) {
    els.status.textContent = t(note.key, note.params);
    els.status.classList.toggle('is-fail', note.fail);
  }
}

async function refresh() {
  if (!els) return;
  try {
    const next = await window.lunacore.listClaudeAccounts();
    if (next && Array.isArray(next.accounts)) view = next;
  } catch {
    note = { key: 'accounts.loadFailed', fail: true };
  }
  render();
}

const ADD_ERRORS = {
  badToken: 'accounts.err.badToken',
  badLabel: 'accounts.err.badLabel',
  duplicate: 'accounts.err.duplicate',
  tooMany: 'accounts.err.tooMany',
  noEncryption: 'accounts.noEncryption',
};

async function add() {
  if (!els) return;
  els.add.disabled = true;
  let res = null;
  try {
    res = await window.lunacore.addClaudeAccount(els.label.value, els.token.value);
  } catch {
    res = null;
  }
  if (!els) return;
  els.add.disabled = false;
  if (res && res.ok) {
    els.label.value = '';
    els.token.value = '';
    note = { key: 'accounts.added', fail: false };
  } else {
    note = { key: ADD_ERRORS[res && res.error] || 'accounts.saveFailed', fail: true };
  }
  await refresh();
}

/**
 * Called from mountProviderSettings() - the block sits in the same section.
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountClaudeAccountSettings(root) {
  els = {
    list: root.querySelector('#claude-accounts-list'),
    empty: root.querySelector('#claude-accounts-empty'),
    noEncryption: root.querySelector('#claude-accounts-noenc'),
    tokenTab: root.querySelector('#claude-accounts-token-btn'),
    label: root.querySelector('#claude-accounts-label'),
    token: root.querySelector('#claude-accounts-token'),
    add: root.querySelector('#claude-accounts-add-btn'),
    status: root.querySelector('#claude-accounts-status'),
  };
  if (!els.list || !els.add || typeof window.lunacore.listClaudeAccounts !== 'function') {
    els = null;
    return () => {};
  }
  els.tokenTab.addEventListener('click', () => window.lunacore.openClaudeTokenTab());
  els.add.addEventListener('click', add);
  els.token.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const offChanged = window.lunacore.onClaudeAccountsChanged(refresh);
  const offLang = onLangChange(render);
  // A cooldown ends on its own; repaint once a minute while Settings is open.
  const timer = setInterval(refresh, 60 * 1000);
  refresh();

  return () => {
    clearInterval(timer);
    offChanged();
    offLang();
    els = null;
  };
}
