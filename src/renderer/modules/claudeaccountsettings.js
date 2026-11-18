// ============================================================================
// LunaCore - Claude accounts (Settings overlay, AI providers)
// ----------------------------------------------------------------------------
// The account failover list (src/claudeaccounts.js): which subscription is
// active, which is cooling down after a limit and until when, reorder (first
// = preferred), rename (inline Edit), remove, and add one from a `claude setup-token` token. A
// token goes renderer -> main once, on "Add"; the list never carries one.
// Per account: "Connect usage" / "Use main login" / "Reconnect" for the
// usage-only login that feeds the gauge (src/claudeaccountusage.js) - only
// the account id crosses; an email and a status come back.
// Per account: optional reserve caps "max 5h %" / "max weekly %"
// (src/accountreserve.js) - main validates them as integers 1-100 or empty.
// DOM/IPC only - the selection logic is unit-tested in src/claudeaccounts.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

let els = null;
let view = { encryption: true, accounts: [] };
let note = null; // {key, fail, params?}
let connecting = false; // a `claude auth login` is running in main
let editingId = null; // the account whose name is being edited inline, if any
// The editor's text. Kept here because the 60 s refresh and every
// accounts-changed event rebuild the list, which would wipe a half-typed name.
let editDraft = '';
let editJustOpened = false; // select the text on open only, not on every rebuild
// Half-typed reserve caps, `${id}:${field}` -> text. Same reason as editDraft:
// a list rebuild must not wipe them. Cleared once the account's caps save.
const reserveDrafts = new Map();

/** Reserve fields per account: [field, label key]. */
const RESERVE_INPUTS = [['fiveHour', 'accounts.reserve.fiveHour'], ['weekly', 'accounts.reserve.weekly']];

const clock = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function statusText(a) {
  if (a.limitedUntil && a.reserveHit) return t('accounts.reserveHit', { at: clock(a.limitedUntil) });
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

/** Saves the inline rename; on a bad name the editor stays open with a note. */
async function saveRename(id, value) {
  let res = null;
  try {
    res = await window.lunacore.renameClaudeAccount(id, value);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    editingId = null;
    note = { key: 'accounts.renamed', fail: false };
  } else {
    note = { key: res && res.error === 'badLabel' ? 'accounts.err.badLabel' : 'accounts.saveFailed', fail: true };
  }
  await refresh();
}

/** The text a reserve input shows: the draft, else the stored cap, else empty. */
function reserveValue(a, field) {
  const key = `${a.id}:${field}`;
  if (reserveDrafts.has(key)) return reserveDrafts.get(key);
  const cap = a.reserve && a.reserve[field];
  return Number.isInteger(cap) ? String(cap) : '';
}

/** Saves both caps of one account; main validates them (1-100 or empty). */
async function saveReserve(a) {
  if (typeof window.lunacore.setClaudeAccountReserve !== 'function') return;
  const fiveHour = reserveValue(a, 'fiveHour').trim();
  const weekly = reserveValue(a, 'weekly').trim();
  let res = null;
  try {
    res = await window.lunacore.setClaudeAccountReserve(a.id, fiveHour, weekly);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    for (const [field] of RESERVE_INPUTS) reserveDrafts.delete(`${a.id}:${field}`);
    note = { key: 'accounts.reserve.saved', fail: false };
  } else {
    // The drafts stay, so the bad value is still there to correct.
    note = { key: res && res.error === 'badReserve' ? 'accounts.reserve.err' : 'accounts.saveFailed', fail: true };
  }
  await refresh();
}

/** The two optional caps ("max 5h %", "max weekly %") of one account. */
function reserveInputs(a) {
  if (typeof window.lunacore.setClaudeAccountReserve !== 'function') return [];
  const wrap = document.createElement('span');
  wrap.className = 'claude-account-reserve';
  wrap.title = t('accounts.reserve.hint');
  for (const [field, labelKey] of RESERVE_INPUTS) {
    const label = document.createElement('label');
    label.className = 'hint';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '100';
    input.step = '1';
    input.inputMode = 'numeric';
    input.className = 'profile-select claude-account-reserve__input';
    input.value = reserveValue(a, field);
    input.addEventListener('input', () => reserveDrafts.set(`${a.id}:${field}`, input.value));
    // 'change' fires on Enter and on blur - one save per edit, not per key.
    input.addEventListener('change', () => {
      reserveDrafts.set(`${a.id}:${field}`, input.value);
      saveReserve(a);
    });
    label.append(`${t(labelKey)} `, input);
    wrap.append(label);
  }
  return [wrap];
}

/** The inline editor that replaces a row's name while editing. */
function renameEditor(a) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'profile-select';
  input.maxLength = 60;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = editDraft;
  input.setAttribute('aria-label', t('accounts.label'));
  const cancel = () => {
    editingId = null;
    render();
  };
  input.addEventListener('input', () => {
    editDraft = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRename(a.id, input.value);
    else if (e.key === 'Escape') {
      // Close only the editor, not the Settings overlay around it.
      e.stopPropagation();
      cancel();
    }
  });
  // Focus once the row is in the DOM (render() appends it right after).
  const selectAll = editJustOpened;
  editJustOpened = false;
  queueMicrotask(() => {
    input.focus();
    if (selectAll) input.select();
  });
  return [
    input,
    button('accounts.save', () => saveRename(a.id, input.value)),
    button('accounts.cancel', cancel),
  ];
}

function renderRow(a, index) {
  if (a.id === editingId) {
    const li = document.createElement('li');
    li.className = 'project-row';
    li.append(...renameEditor(a));
    return li;
  }
  // One grid row (styles.css .claude-accounts): dot | name, status and usage
  // login | the two caps | the buttons. Columns line up across accounts.
  const li = document.createElement('li');
  li.className = 'claude-account';
  const dot = document.createElement('span');
  const dotState = a.limitedUntil ? 'fail' : a.active ? 'ok' : 'unknown';
  dot.className = `diag-item__dot diag-item__dot--${dotState}`;
  li.append(dot, identityCell(a, index));
  const caps = reserveInputs(a);
  // An empty cell keeps the actions in their own column when caps are unavailable.
  li.append(...(caps.length > 0 ? caps : [document.createElement('span')]));
  li.append(actionsCell(a, index));
  return li;
}

/** Name and status on the first line, the usage login under them. */
function identityCell(a, index) {
  const cell = document.createElement('div');
  cell.className = 'claude-account__id';
  const head = document.createElement('div');
  head.className = 'claude-account__head';
  const name = document.createElement('span');
  name.className = 'claude-account__name';
  name.textContent = `${index + 1}. ${a.label}`;
  const status = document.createElement('span');
  status.className = a.limitedUntil ? 'claude-account__status is-fail' : 'claude-account__status';
  status.textContent = statusText(a);
  head.append(name, status);
  cell.append(head);
  if (a.usage) {
    const usage = document.createElement('span');
    usage.className = a.usage.status === 'reconnect' ? 'claude-account__usage is-fail' : 'claude-account__usage';
    usage.textContent = usageText(a.usage);
    // The line is cut with an ellipsis when narrow; the tooltip keeps it whole.
    usage.title = usage.textContent;
    cell.append(usage);
  }
  return cell;
}

/** Every button of a row, right-aligned in one group. */
function actionsCell(a, index) {
  const cell = document.createElement('div');
  cell.className = 'claude-account__actions';
  if (index > 0) cell.append(button('accounts.moveUp', () => act(window.lunacore.moveClaudeAccountUp, a.id), 'accounts.moveUpHint'));
  // A reached reserve ends with the window's reset or a higher cap, not here.
  if (a.limitedUntil && !a.reserveHit) cell.append(button('accounts.clearLimit', () => act(window.lunacore.clearClaudeAccountLimit, a.id)));
  cell.append(...usageButtons(a));
  if (typeof window.lunacore.renameClaudeAccount === 'function') {
    cell.append(button('accounts.edit', () => {
      editingId = a.id;
      editDraft = a.label || '';
      editJustOpened = true;
      note = null;
      render();
    }, 'accounts.editHint'));
  }
  cell.append(button('accounts.remove', () => act(window.lunacore.removeClaudeAccount, a.id)));
  return cell;
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
