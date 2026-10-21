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
import { applyFileEvents, trackBucketFiles, applyGitFiles, trackBucketGitFiles } from './activefiles.js';
import { applyTurnEnd, trackBucketTurn } from './sessiontimeline.js';
import { applyMcpEvents, trackBucketMcp } from './mcp.js';
import { syncSwitchers } from './switchers.js';
import { syncTodoProject, setTodoToolsState } from './todo.js';
import { sfx } from './sound.js';
import { agentStream } from './keysynth.js';
import { targetSlot, siblingOffsets, clampDx } from './tabdrag.js';

// A2f: set once by mountTabs() - see modules/terminal.js.
let tabEls = null;

/** Prefix on a worktree tab's label (git's "branch" glyph). */
const WORKTREE_MARK = '⑂';

/** Session metadata from the main process - the source of truth for what lives. */
let sessionList = [];

function activeMeta() {
  return sessionList.find((x) => x.id === getActiveSessionId());
}

// ---- pty stream, routed by sessionId ----------------------------------------

// PASSIVE OBSERVER: output from the Claude CLI -> the RIGHT tab's screen.
window.lunacore.onData(({ sessionId, data }) => {
  const s = ensureTerm(sessionId);
  if (sessionList.some((m) => m.id === sessionId && m.readOnly)) s.term.options.disableStdin = true;
  s.term.write(data);
  // The LED describes what you are looking at. A background tab blinks on its
  // own marker instead - same reasoning extends to the agent-stream sound
  // (CONCEPT_TYPING_SYNTH.md §2): only the tab you're looking at gets audio.
  if (sessionId === getActiveSessionId()) {
    markWorking(sessionId);
    agentStream(data.length);
  } else markBucketWorking(s);
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

// reference/MCP_DEBUGGER_PLAN.md safe half: MCP call start/end lifecycle. Same
// active/background split as onTools above.
window.lunacore.onMcp(({ sessionId, events }) => {
  if (!Array.isArray(events)) return;
  if (sessionId === getActiveSessionId()) applyMcpEvents(events);
  else trackBucketMcp(ensureTerm(sessionId), events);
});

// Active-Files Heatmap's git-sourced signal (src/gitfiles.js): catches files
// a session changed via Bash/PowerShell, which carry no file_path for the
// transcript path above to key a row on. Same active/background split.
//
// `files` is already narrowed to this terminal by main.js (src/gitattribution.js);
// `repoFiles` is the unfiltered repo view behind the widget's scope toggle.
window.lunacore.onGitFiles(({ sessionId, files, repoFiles }) => {
  if (!Array.isArray(files)) return;
  const repo = Array.isArray(repoFiles) ? repoFiles : files;
  if (sessionId === getActiveSessionId()) applyGitFiles(files, repo);
  else trackBucketGitFiles(ensureTerm(sessionId), files, repo);
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
    // The project switcher can restart THIS tab into a different project -
    // the todo board needs to follow it, same as every project switch does.
    syncTodoProject();
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
  syncTodoProject();
  setTodoToolsState(activeMeta());
  renderTabs();
  fitAndResize(); // a background tab did not know its own size
  term.focus();
}

// The active id as of the last renderTabs paint. When it changes, the tab that
// just became active gets .tab--enter for that one paint so the CSS accent
// under it wipes in; the repeated repaints a context tick triggers see no
// change and leave it at rest. null until the first paint - the opening tab
// should not wipe, the same rule context.js's lastCtxLevel follows.
let paintedActiveId = null;

// ---- drag-to-reorder ----------------------------------------------------------
// Live, Chrome-style, on pointer events: past a small threshold the tab
// follows the pointer and its neighbours slide aside to preview the drop. The
// arithmetic is in tabdrag.js; this half only reads rects and writes
// transforms. Below the threshold nothing happens, so a click still activates.
//
// While `draggedId` is set renderTabs() holds off: a context tick repaints the
// whole bar, and rebuilding it mid-drag would destroy the captured element.
// On drop the bar is repainted from a snapshot of where the tabs are ON SCREEN
// (transforms included), so the existing FLIP slides them home without a jump.
let draggedId = null;
let repaintAfterDrag = false;

/** Pointer travel in px before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;

/** The gesture in progress (pending or live), or null. */
let drag = null;

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.dx = e.clientX - drag.startX;
  if (!drag.active) {
    if (Math.abs(drag.dx) < DRAG_THRESHOLD_PX) return;
    if (!beginLiveDrag()) {
      endDrag(false);
      return;
    }
  }
  if (!drag.raf) drag.raf = requestAnimationFrame(paintDrag);
}

function onDragUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  endDrag(true);
}

function onDragCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  endDrag(false);
}

function onDragKey(e) {
  if (!drag || !drag.active || e.key !== 'Escape') return;
  // Capture phase + stop, so the Escape cancels the drag instead of also
  // reaching the focused terminal.
  e.preventDefault();
  e.stopPropagation();
  endDrag(false);
}

/** Turns a pending press into a live drag. false when the bar cannot support one. */
function beginLiveDrag() {
  const tabs = [...tabEls.list.children].filter((el) => el.dataset.sessionId);
  const from = tabs.indexOf(drag.tab);
  if (from < 0 || tabs.length < 2) return false;
  const rects = tabs.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const gap = parseFloat(getComputedStyle(tabEls.list).columnGap) || 0;
  Object.assign(drag, { active: true, tabs, from, rects, shift: rects[from].width + gap, slot: from });
  try {
    drag.tab.setPointerCapture(drag.pointerId);
  } catch {
    /* the pointer is already gone - pointerup/cancel on window still ends it */
  }
  draggedId = drag.id;
  tabEls.list.classList.add('is-reordering');
  drag.tab.classList.add('is-dragging');
  return true;
}

/** Where the drag currently lands, from the latest pointer offset. */
function currentSlot(d) {
  const self = d.rects[d.from];
  return targetSlot(d.rects, d.from, self.left + self.width / 2 + clampDx(d.rects, d.from, d.dx));
}

/** One rAF-batched frame: the dragged tab under the pointer, siblings aside. */
function paintDrag() {
  const d = drag;
  if (!d || !d.active) return;
  d.raf = 0;
  d.slot = currentSlot(d);
  d.tab.style.transform = `translateX(${clampDx(d.rects, d.from, d.dx)}px)`;
  const offsets = siblingOffsets(d.rects, d.from, d.slot, d.shift);
  d.tabs.forEach((el, i) => {
    if (i !== d.from) el.style.transform = offsets[i] ? `translateX(${offsets[i]}px)` : '';
  });
}

/** After a real drag the release must not also count as a click on the label. */
function swallowNextClick() {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

/** Ends the gesture. `commit` false (cancel / Escape / lost capture) snaps back. */
function endDrag(commit) {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
  window.removeEventListener('keydown', onDragKey, true);
  if (!d || !d.active) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  swallowNextClick();

  const slot = currentSlot(d);
  const moved = commit && slot !== d.from;
  // Snapshot BEFORE the rebuild drops the inline transforms: the FLIP then
  // starts every tab from where it is on screen, not from its old slot.
  const onScreen = snapshotTabX();
  draggedId = null;
  repaintAfterDrag = false;
  tabEls.list.classList.remove('is-reordering');
  if (moved) {
    // Optimistic: paint the new order now. The main process broadcasts the
    // authoritative list right after, which repaints in place.
    const rest = sessionList.filter((m) => m.id !== d.id);
    const meta = sessionList.find((m) => m.id === d.id);
    if (meta) sessionList = [...rest.slice(0, slot), meta, ...rest.slice(slot)];
  }
  renderTabs(onScreen);
  if (moved) window.lunacore.reorderSession(d.id, slot);
}

function wireTabDrag(tab, id) {
  tab.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0 || !e.isPrimary) return;
    // The close button and any inner control keep their own click.
    if (e.target.closest('.tab__close, input, select, textarea, a')) return;
    drag = { tab, id, pointerId: e.pointerId, startX: e.clientX, dx: 0, active: false, raf: 0 };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
    window.addEventListener('keydown', onDragKey, true);
  });
  // Capture lost without a pointerup (window blur, element gone): snap back.
  // After a normal pointerup `drag` is already null, so this is a no-op.
  tab.addEventListener('lostpointercapture', (e) => {
    if (drag && drag.tab === tab && e.pointerId === drag.pointerId) endDrag(false);
  });
}

// ---- tab slide (FLIP) -----------------------------------------------------------
// renderTabs() rebuilds the bar from scratch, so a reorder or a close would
// make the tabs jump. Instead: remember where each tab was (First), paint the
// new bar (Last), Invert each moved tab back to its old x, and Play it home.

/** sessionId -> left edge, read just before the bar is rebuilt. */
function snapshotTabX() {
  const xs = new Map();
  for (const el of tabEls.list.children) {
    if (el.dataset.sessionId) xs.set(el.dataset.sessionId, el.getBoundingClientRect().left);
  }
  return xs;
}

/** Slide duration in ms. Read off --dur-fast, which the reduced/off motion
 *  tiers already pin to 0, so those tiers get the old instant jump for free. */
function slideMs() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-fast');
  const ms = parseFloat(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function slideTabsFrom(oldX) {
  const ms = slideMs();
  if (ms <= 0 || oldX.size === 0) return;
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-smooth').trim() || 'ease-out';
  for (const el of tabEls.list.children) {
    const before = oldX.get(el.dataset.sessionId);
    if (before === undefined) continue; // a brand-new tab just appears
    const dx = before - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 1) continue;
    el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], {
      duration: ms,
      easing,
    });
  }
}

/**
 * Rebuilds the tab bar. `fromX` is an optional sessionId -> left snapshot to
 * slide from instead of the current DOM (the drag drop passes the on-screen
 * positions it measured before releasing its transforms).
 */
function renderTabs(fromX) {
  if (!tabEls) return;
  if (draggedId) {
    repaintAfterDrag = true;
    return;
  }
  const activeId = getActiveSessionId();
  const switched = paintedActiveId !== null && activeId !== paintedActiveId;
  paintedActiveId = activeId;
  const oldX = fromX instanceof Map ? fromX : snapshotTabX();
  tabEls.list.innerHTML = '';
  for (const meta of sessionList) {
    const s = getBucket(meta.id);
    const isActive = meta.id === activeId;
    const tab = document.createElement('div');
    tab.dataset.sessionId = meta.id;
    tab.className = 'tab' + (isActive ? ' is-active' : '');
    if (isActive && switched) tab.classList.add('tab--enter');
    if (s && !s.alive) tab.classList.add('is-dead');

    const btn = document.createElement('button');
    btn.className = 'tab__label';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(meta.id === getActiveSessionId()));
    const label = meta.folder || meta.profileLabel || meta.id;
    if (meta.readOnly) {
      // A phone-driven host session (src/hostchattabs.js): shown, never typed into.
      btn.textContent = `📱 ${label}`;
      btn.title = t('tabs.phone');
      if (s && s.term) s.term.options.disableStdin = true;
    } else {
      // A worktree tab carries a branch mark, so two tabs of one project tell apart.
      btn.textContent = meta.branch ? `${WORKTREE_MARK} ${label}` : label;
      btn.title = [meta.profileLabel, meta.branch, meta.cwd].filter(Boolean).join(' - ');
    }
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

    wireTabDrag(tab, meta.id);
    tabEls.list.appendChild(tab);
  }
  slideTabsFrom(oldX);
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
      syncTodoProject();
      fitAndResize();
    } else {
      showSession(activeId);
    }
  }
  // The active tab's own flag may have flipped (its `claude` just launched).
  setTodoToolsState(activeMeta());
  renderTabs();
});

/**
 * "New tab in worktree": swaps the button for a name field in place. Enter
 * creates the worktree + tab (main does the git work), Esc or blur cancels.
 * A failure keeps the field open with the reason in its tooltip.
 */
function openWorktreeField(button) {
  if (button.hidden) return;
  const input = document.createElement('input');
  input.className = 'tabs__wt-input';
  input.type = 'text';
  input.maxLength = 60;
  input.placeholder = t('tabs.worktree.placeholder');
  input.setAttribute('aria-label', t('tabs.worktree'));
  button.hidden = true;
  button.after(input);

  let busy = false;
  const close = () => {
    input.remove();
    button.hidden = false;
  };
  input.addEventListener('blur', () => {
    if (!busy) close();
  });
  input.addEventListener('input', () => input.classList.remove('is-error'));
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
      return;
    }
    if (e.key !== 'Enter' || busy || !input.value.trim()) return;
    e.preventDefault();
    busy = true;
    input.disabled = true;
    const res = await window.lunacore
      .createWorktreeSession(input.value)
      .catch(() => ({ ok: false, error: 'gitFailed' }));
    busy = false;
    if (res && res.ok) {
      close();
      return;
    }
    const reason = t(`tabs.worktree.err.${(res && res.error) || 'gitFailed'}`);
    input.disabled = false;
    input.classList.add('is-error');
    input.title = res && res.detail ? `${reason}: ${res.detail}` : reason;
    input.focus();
  });
  input.focus();
}

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountTabs(root) {
  tabEls = { list: root.querySelector('#tabs-list') };
  root.querySelector('#tab-new').addEventListener('click', () => {
    sfx.terminalNew();
    window.lunacore.createSession({});
  });
  const wtButton = root.querySelector('#tab-worktree');
  wtButton.addEventListener('click', () => openWorktreeField(wtButton));
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
