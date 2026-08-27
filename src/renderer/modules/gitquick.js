// ============================================================================
// LunaCore - Git quick-menu (Ctrl+G)
// ----------------------------------------------------------------------------
// Commit / Push / Fetch / Status on the ACTIVE TAB'S OWN repo, reachable even
// when Claude Code itself is out of tokens - the whole reason this exists.
// Mirrors palette.js's shape exactly (static overlay markup in index.html,
// not a <template>; global keydown capture for the open shortcut; backdrop
// click + Escape to close) - see .gitquick reusing .palette's CSS in
// styles.css for why.
//
// Deliberately separate from src/gitstation.js's git-station PANEL (the #git
// widget, read+fetch-only by design - see that module's header). This is a
// different UI contract: reached only by an explicit keystroke, one menu pick,
// and (for commit) a typed message - never a stray click.
//
// EXECUTION: runs via IPC -> execFile in the main process (gitstation.js's
// commitAll/pushCurrent/fetchDir), NOT pty.write() into the terminal. If the
// active pane is mid-`claude` session (the app's whole purpose), pty.write()
// would type the git command as a chat prompt instead of running it - exactly
// the moment this feature needs to survive. The command + result is mirrored
// into the pane afterward via term.write(), a pure display write that never
// touches the shell, so it still reads like it happened there.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { term, getActiveSessionId } from './terminals.js';
import { summarizeResult, buildMirrorText, resolveMenuKey } from './gitquick-format.js';
import { closeWithExit, cancelExit } from './motion.js';

const gitquickEl = document.getElementById('gitquick');
const els = {
  list: document.getElementById('gitquick-list'),
  message: document.getElementById('gitquick-message'),
  messageInput: document.getElementById('gitquick-message-input'),
  result: document.getElementById('gitquick-result'),
};

// Order matters: also the letter-shortcut order (first letter of each id).
const ACTIONS = ['commit', 'push', 'fetch', 'status'];

let gitquickOpen = false;
let sel = 0; // index into ACTIONS
let pending = false; // an IPC call is in flight - list input is ignored

function actionLabel(action) {
  return t(`gitquick.menu.${action}`);
}

function renderMenu() {
  els.list.innerHTML = '';
  ACTIONS.forEach((action, idx) => {
    const li = document.createElement('li');
    li.className = 'palette-item gitquick-item';
    li.dataset.idx = String(idx);
    if (idx === sel) li.classList.add('is-active');

    const kind = document.createElement('span');
    kind.className = 'palette-item__kind gitquick-item__kind';
    kind.dataset.kind = action;
    kind.textContent = actionLabel(action).charAt(0).toUpperCase();

    const body = document.createElement('span');
    body.className = 'palette-item__body';
    const label = document.createElement('span');
    label.className = 'palette-item__label';
    label.textContent = actionLabel(action);
    body.appendChild(label);

    li.append(kind, body);
    els.list.appendChild(li);
  });
}

function showResult(text, cls) {
  els.result.hidden = false;
  els.result.textContent = text;
  els.result.className = `gitquick__result ${cls}`;
  pulse(els.result);
}

function hideResult() {
  els.result.hidden = true;
  els.result.textContent = '';
}

function showMessageInput() {
  els.message.hidden = false;
  els.messageInput.value = '';
  els.messageInput.focus();
}

function hideMessageInput() {
  els.message.hidden = true;
}

/** Fires one action, shows the result, mirrors it into the terminal. */
async function runAction(action, message) {
  if (pending) return;
  pending = true;
  hideMessageInput();
  showResult(t('gitquick.result.running'), 'is-pending');

  const sessionId = getActiveSessionId();
  let res;
  try {
    res = await window.lunacore.gitQuickAction(sessionId, action, message);
  } catch {
    res = { ok: false, error: 'ipcFailed' };
  }

  const summary = summarizeResult(action, res, t);
  showResult(summary.text, summary.ok ? 'is-ok' : 'is-fail');

  const mirror = buildMirrorText(action, message, res);
  if (mirror) term.write(mirror);

  pending = false;
  // The commit path leaves focus in the now-hidden message input; anything
  // else leaves it wherever the click landed. Either way the list stops
  // answering arrows unless focus comes back here.
  if (gitquickOpen) gitquickEl.focus();
}

function selectAction() {
  const action = ACTIONS[sel];
  if (pending) return;
  if (action === 'commit') {
    showMessageInput();
    return;
  }
  hideResult();
  runAction(action, '');
}

function openGitQuick() {
  if (gitquickOpen) return;
  gitquickOpen = true;
  sel = 0;
  pending = false;
  hideMessageInput();
  hideResult();
  cancelExit(gitquickEl);
  gitquickEl.hidden = false;
  renderMenu();
  // WHY: without this the keys go to xterm's textarea (still the active
  // element) and get typed into the running `claude` session instead of
  // driving the list - the overlay is a plain <div>, so it needs both the
  // tabindex="-1" in index.html and this explicit focus(). palette.js gets
  // away without it only because it focuses its search <input>.
  gitquickEl.focus();
}

function closeGitQuick() {
  if (!gitquickOpen) return;
  gitquickOpen = false;
  hideMessageInput();
  closeWithExit(gitquickEl);
}

els.list.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.gitquick-item');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (idx !== sel) { sel = idx; renderMenu(); }
});
els.list.addEventListener('click', (e) => {
  const row = e.target.closest('.gitquick-item');
  if (!row) return;
  sel = Number(row.dataset.idx);
  selectAction();
});

els.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const message = els.messageInput.value.trim();
    if (!message) return; // an empty commit message is not a valid save
    runAction('commit', message);
  }
});

// Escape always closes the whole menu (message input included) - no nested
// "one Escape backs out of the message, a second Escape closes" state
// machine, matching how simple palette.js/termcustom.js keep their Escape.
gitquickEl.addEventListener('keydown', (e) => {
  const hit = resolveMenuKey(e.key, sel, ACTIONS);
  if (hit.kind === 'close') {
    e.preventDefault();
    closeGitQuick();
    term.focus();
    return;
  }
  if (e.target === els.messageInput) return; // typing a message never drives the list
  if (hit.kind === 'none') return; // swallowed: a modal owns the keyboard

  e.preventDefault();
  sel = hit.sel;
  renderMenu();
  if (hit.kind === 'select') selectAction();
});

gitquickEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-gitquick-close')) { closeGitQuick(); term.focus(); }
});

onLangChange(() => { if (gitquickOpen) renderMenu(); });

// The chip in the terminal bar opens the menu.
/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountGitquickChip(root) {
  const btn = root.querySelector('#gitquick-open');
  if (btn) btn.addEventListener('click', openGitQuick);
}

// Global Ctrl/Cmd+G (capture, to get ahead of xterm.js) - same tradeoff and
// precedent as palette.js's Ctrl+K and termcustom.js's Ctrl+L. Free at the
// app level today (only K and L are hijacked).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      e.stopPropagation();
      if (gitquickOpen) { closeGitQuick(); term.focus(); }
      else openGitQuick();
    }
  },
  true
);
