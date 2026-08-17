// ============================================================================
// LunaCore - session tabs, and the only place pty IPC is routed
// ----------------------------------------------------------------------------
// Every tab is a separate pty process with its own transcript, context window
// and metrics. This module is the switchboard: it registers ONE listener per
// IPC channel and decides whether an event belongs to the tab you are looking
// at (fan it out to the live UI) or to one running in the background (park it
// on that tab's bucket, so switching to it shows ITS numbers, not somebody
// else's). Fanning out goes through bus.js so no view module is imported for
// the live path.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  emitActiveContext,
  emitBackgroundContext,
  emitSessionRestarted,
  saveSessionView,
  loadSessionView,
  clearSessionView,
} from './bus.js';
import {
  ensureTerm,
  getBucket,
  getActiveBucket,
  getActiveSessionId,
  setActiveSessionId,
  showPane,
  pruneTerms,
  fitAndResize,
  term,
} from './terminals.js';
import {
  markWorking,
  markBucketWorking,
  setLedDead,
  markBucketDead,
  resetLed,
} from './led.js';
import { setPtyStatus } from './ptystatus.js';
import { CTX_WARN_HIGH, CTX_WARN_MID } from './thresholds.js';
import { lightTiles, applyToolEvents, trackBucketTools, resetTiles } from './skilltracker.js';
import { applyFileEvents, trackBucketFiles } from './activefiles.js';
import { applyTurnEnd, trackBucketTurn } from './sessiontimeline.js';
import { syncSwitchers } from './switchers.js';
import { sfx } from './sound.js';

// A2f: set once by mountTabs() - see modules/terminal.js.
let tabEls = null;

/** Session metadata from the main process - the source of truth for what lives. */
let sessionList = [];

function activeMeta() {
  return sessionList.find((x) => x.id === getActiveSessionId());
}

// ---- pty stream, routed by sessionId ----------------------------------------

// PASSIVE OBSERVER: output from the Claude CLI -> the RIGHT tab's screen.
window.lunacore.onData(({ sessionId, data }) => {
  const s = ensureTerm(sessionId);
  s.term.write(data);
  // The LED describes what you are looking at. A background tab blinks on its
  // own marker instead.
  if (sessionId === getActiveSessionId()) markWorking();
  else markBucketWorking(s);
});

// Connection status of one tab's pty.
window.lunacore.onExit(({ sessionId, code }) => {
  const s = ensureTerm(sessionId);
  s.alive = false;
  markBucketDead(s);
  s.term.write(`\r\n\x1b[38;5;203m${t('log.session.ended', { code })}\x1b[0m\r\n`);
  if (sessionId === getActiveSessionId()) {
    setLedDead();
    setPtyStatus(false, 'ptystatus.ended', { code });
  }
  renderTabs();
});

// Context metrics: EVERY tab has its own context window.
window.lunacore.onContext(({ sessionId, metrics }) => {
  const s = ensureTerm(sessionId);
  if (!metrics || typeof metrics.percent !== 'number') return;
  if (sessionId === getActiveSessionId()) emitActiveContext(metrics);
  else emitBackgroundContext(s, metrics);
  renderTabs();
});

// Skill Tracker. Two payload shapes share this channel: `events` is the
// transcript's tool_use/tool_result lifecycle (B8), `tiles` the older flat list
// the stdout backstop still emits.
//
// A background tab's events are folded onto its bucket rather than dropped: a
// tool that starts while you are on another tab must still be running when you
// come back, and that is only true if we tracked its start.
window.lunacore.onTools(({ sessionId, events, tiles }) => {
  const active = sessionId === getActiveSessionId();
  if (Array.isArray(events)) {
    if (active) {
      applyToolEvents(events);
      applyFileEvents(events);
    } else {
      const bucket = ensureTerm(sessionId);
      trackBucketTools(bucket, events);
      trackBucketFiles(bucket, events);
    }
  }
  // The blink has no end signal, so it is only worth showing live.
  if (tiles && active) lightTiles(tiles);
});

// §6.1: a turn just completed. Same active/background split as onTools above -
// a turn finishing on a background tab must still show up when you switch to it.
window.lunacore.onTurnEnd(({ sessionId, turn }) => {
  if (sessionId === getActiveSessionId()) {
    applyTurnEnd(turn);
  } else {
    trackBucketTurn(ensureTerm(sessionId), turn);
  }
});

// A restart (profile / project change) concerns one specific tab.
window.lunacore.onRestarted((profile) => {
  const sessionId = profile.sessionId;
  const s = getBucket(sessionId);
  if (s) {
    s.term.reset();
    clearSessionView(s);
    s.alive = true;
    const msg = profile.folder
      ? t('log.session.project', { label: profile.label, folder: profile.folder })
      : t('log.session.switched', { label: profile.label });
    s.term.write(`\x1b[38;5;80m${msg}\x1b[0m\r\n`);
  }
  if (sessionId === getActiveSessionId()) {
    resetLed();
    // clearSessionView() above only wiped the bucket; the tiles on screen are
    // still showing tools that belonged to the process we just replaced.
    resetTiles();
    setPtyStatus(true, 'ptystatus.active');
    emitSessionRestarted(profile);
    fitAndResize();
    term.focus();
  }
});

// ---- Tab bar ----------------------------------------------------------------

/** Leaving a tab: park the live view state on its bucket. */
function stashActive() {
  const s = getActiveBucket();
  if (!s) return;
  saveSessionView(s);
}

/** Entering a tab: adopt its view state and repaint. */
function restoreActive() {
  const s = getActiveBucket();
  if (!s) return;
  loadSessionView(s);
  setPtyStatus(s.alive, s.alive ? 'ptystatus.active' : 'ptystatus.ended', { code: 0 });
}

/** Shows the chosen tab; the other processes keep running in the background. */
function showSession(sessionId) {
  if (!sessionId || sessionId === getActiveSessionId()) return;
  stashActive();
  setActiveSessionId(sessionId);
  showPane(sessionId);
  restoreActive();
  syncSwitchers(activeMeta());
  renderTabs();
  fitAndResize(); // a background tab did not know its own size
  term.focus();
}

function renderTabs() {
  if (!tabEls) return;
  tabEls.list.innerHTML = '';
  for (const meta of sessionList) {
    const s = getBucket(meta.id);
    const tab = document.createElement('div');
    tab.className = 'tab' + (meta.id === getActiveSessionId() ? ' is-active' : '');
    if (s && !s.alive) tab.classList.add('is-dead');

    const btn = document.createElement('button');
    btn.className = 'tab__label';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(meta.id === getActiveSessionId()));
    btn.textContent = meta.folder || meta.profileLabel || meta.id;
    btn.title = `${meta.profileLabel || ''} - ${meta.cwd || ''}`.trim();
    btn.addEventListener('click', () => {
      sfx.navClick();
      window.lunacore.activateSession(meta.id);
    });
    tab.appendChild(btn);

    // How full THIS tab's context is - you can see trouble brewing in the
    // background. `lastCtx` is context.js's key on the bucket; read-only here.
    const pct = s && s.lastCtx ? Math.round(s.lastCtx.percent * 100) : null;
    if (pct !== null) {
      const dot = document.createElement('span');
      dot.className = 'tab__ctx';
      if (pct >= CTX_WARN_HIGH * 100) dot.classList.add('is-high');
      else if (pct >= CTX_WARN_MID * 100) dot.classList.add('is-mid');
      dot.textContent = `${pct}%`;
      tab.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className = 'tab__close';
    close.textContent = '×';
    close.title = t('tabs.close');
    close.setAttribute('aria-label', t('tabs.close'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      sfx.terminalClose();
      window.lunacore.closeSession(meta.id);
    });
    tab.appendChild(close);

    tabEls.list.appendChild(tab);
  }
}

// The session list from the main process - the source of truth for what lives.
window.lunacore.onSessions(({ sessions, activeSessionId: activeId }) => {
  sessionList = sessions || [];
  for (const meta of sessionList) {
    const s = ensureTerm(meta.id);
    s.alive = meta.alive;
  }
  pruneTerms(new Set(sessionList.map((m) => m.id)));

  if (activeId && activeId !== getActiveSessionId()) {
    if (getActiveSessionId() === null) {
      // First broadcast: there is nothing to stash, just show it.
      setActiveSessionId(activeId);
      showPane(activeId);
      restoreActive();
      syncSwitchers(activeMeta());
      fitAndResize();
    } else {
      showSession(activeId);
    }
  }
  renderTabs();
});

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountTabs(root) {
  tabEls = { list: root.querySelector('#tabs-list') };
  root.querySelector('#tab-new').addEventListener('click', () => {
    sfx.terminalNew();
    window.lunacore.createSession({});
  });
  renderTabs();
}

/**
 * First fetch of the tab list.
 *
 * The main process broadcasts it while creating the session - that is, before
 * this renderer has subscribed - so we have to ask for the initial state
 * ourselves, otherwise the tab bar would stay empty until the first change.
 */
export function initSessions() {
  window.lunacore
    .getSessions()
    .then(({ sessions, activeSessionId: activeId }) => {
      sessionList = sessions || [];
      for (const meta of sessionList) ensureTerm(meta.id).alive = meta.alive;
      if (activeId) {
        setActiveSessionId(activeId);
        showPane(activeId);
        syncSwitchers(activeMeta());
      }
      renderTabs();
      fitAndResize();
      setPtyStatus(true, 'ptystatus.active');
      term.focus();
    })
    .catch(() => {
      // Could not fetch the sessions - do not block the HUD from starting.
    });
}
