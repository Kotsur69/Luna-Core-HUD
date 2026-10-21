// ============================================================================
// LunaCore - phone-driven host sessions as read-only HUD tabs (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H2: "On a Windows host running the full HUD, the
// session also shows as a read-only tab, so you can sit down and see what
// happened." Only the full HUD switched into host mode attaches this (main.js
// passes it to src/hostmain.js); a headless host has no tabs and no effect.
//
//   attach(chat)   follows src/hostchat.js onEvent: the first event of a
//                  phone session opens a tab ("Driven from phone"), every
//                  event is written to it as terminal text
//   end            the session's done / error status marks the tab ended; it
//                  stays open until closed by hand
//
// The tab has no process: input is disabled in the renderer and dropped in
// main (no proc to write to). main.js keeps only the wiring: open / write /
// end / isOpen over its own sessions map.
// ============================================================================

'use strict';

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

/** "\n" -> "\r\n" for xterm; other control characters (escapes from model output) dropped. */
function termText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n/g, '\r\n');
}

/**
 * One hostchat event -> what the tab shows (ANSI text), '' for nothing.
 * @param {string} kind
 * @param {object} data
 * @param {'pl'|'en'} [lang]
 */
function formatEvent(kind, data, lang = 'en') {
  const d = data && typeof data === 'object' ? data : {};
  const pl = lang === 'pl';
  switch (kind) {
    case 'text':
      return termText(d.text || '');
    case 'prompt':
      return `\r\n${CYAN}> ${termText(d.text || '')}${RESET}\r\n`;
    case 'tool':
      return `\r\n${DIM}● ${termText(d.name || '')}(${termText(d.summary || '')})${RESET}\r\n`;
    case 'tool_result': {
      const first = termText(String(d.text || '').split('\n').slice(0, 3).join('\n'));
      return `${d.isError ? RED : DIM}  ⎿ ${first}${RESET}\r\n`;
    }
    case 'permission':
      return `\r\n${YELLOW}? ${pl ? 'Zgoda' : 'Approval'}: ${termText(d.tool || '')} ${termText(d.summary || '')}${RESET}\r\n`;
    case 'decision':
      return `${YELLOW}  → ${termText(d.decision || '')}${RESET}\r\n`;
    case 'cost':
      return Number.isFinite(d.usd) ? `${DIM}  $${d.usd.toFixed(4)}${RESET}\r\n` : '';
    case 'status':
      if (d.status === 'done') return `\r\n${GREEN}✓ ${pl ? 'gotowe' : 'done'}${d.reason ? ` (${termText(d.reason)})` : ''}${RESET}\r\n`;
      if (d.status === 'error') return `\r\n${RED}✗ ${pl ? 'blad' : 'error'}${d.reason ? ` (${termText(d.reason)})` : ''}${RESET}\r\n`;
      return '';
    default:
      return '';
  }
}

/** The banner a new tab starts with. */
function banner(name, lang = 'en') {
  const line = lang === 'pl' ? 'Sterowane z telefonu - tylko podglad' : 'Driven from phone - read-only';
  return `${CYAN}📱 ${line}${RESET}${name ? ` ${DIM}(${termText(name)})${RESET}` : ''}\r\n`;
}

/**
 * The tab's session object for main.js's sessions map: no process, never
 * launched, ignored by restarts (main.js checks readOnly).
 */
function readOnlySession(id, name) {
  return {
    id,
    proc: null,
    readOnly: true,
    profileId: null,
    projectId: null,
    cwd: typeof name === 'string' && name ? name : 'phone',
    branch: null,
    task: null,
    size: { cols: 80, rows: 24 },
    watcher: null,
    gitWatcher: null,
    localModelWatcher: null,
    spawnSeq: 0,
    preparing: false,
    transcriptId: null,
    alive: true,
    approvalShowing: false,
    scanTail: '',
    signalShowing: {},
  };
}

/**
 * @param {{
 *   open: (name: string) => string,         adds a tab, returns its id
 *   isOpen: (tabId: string) => boolean,
 *   write: (tabId: string, data: string) => void,
 *   end: (tabId: string) => void,           marks the tab ended (stays open)
 *   lang?: () => 'pl'|'en',
 * }} deps
 */
function createHostChatTabs({ open, isOpen, write, end, lang = () => 'en' }) {
  /** phone session id -> tab id */
  const tabs = new Map();

  function tabFor(sessionId, name) {
    const have = tabs.get(sessionId);
    if (have && isOpen(have)) return have;
    const id = open(name);
    tabs.set(sessionId, id);
    write(id, banner(name, lang()));
    return id;
  }

  function onEvent(sessionId, kind, data, meta) {
    const id = tabFor(sessionId, meta && meta.name);
    const text = formatEvent(kind, data, lang());
    if (text) write(id, text);
    if (kind === 'status' && data && (data.status === 'error' || (data.status === 'done' && data.reason === 'ended'))) {
      end(id);
      tabs.delete(sessionId);
    }
  }

  return {
    /** Follows a hostchat; returns the detach function. */
    attach(chat) {
      return chat.onEvent((sessionId, kind, data, meta) => {
        try {
          onEvent(sessionId, kind, data, meta);
        } catch (err) {
          console.error('[hostchattabs] event failed:', err.message);
        }
      });
    },
    onEvent,
  };
}

module.exports = { createHostChatTabs, formatEvent, readOnlySession, banner, termText };
