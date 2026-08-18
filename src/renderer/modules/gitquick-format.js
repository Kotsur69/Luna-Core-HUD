// ============================================================================
// LunaCore - Git quick-menu (Ctrl+G): pure formatting
// ----------------------------------------------------------------------------
// Split out of gitquick.js so it can be unit-tested with a plain `require()`.
// gitquick.js itself queries `document.getElementById` at module scope (same
// as palette.js/termcustom.js, the other two standalone overlays) - that
// needs a real DOM and is left to the manual checklist, same as those two.
// This file imports NOTHING and touches no global, so it is always safe to
// load in a bare Node test.
// ============================================================================

'use strict';

/** The literal git command shown/mirrored for an action. */
export function describeCommand(action, message) {
  if (action === 'commit') return `git add -A && git commit -m "${message}"`;
  if (action === 'push') return 'git push';
  if (action === 'fetch') return 'git fetch --all --prune';
  if (action === 'status') return 'git status';
  return '';
}

/**
 * Turns one `git:quickAction` IPC result into { ok, text } for the small
 * result line under the menu. `tFn` is injected (not imported) so this stays
 * DOM-free - the caller passes the real `t()` from util.js, a test passes a
 * pass-through stub.
 */
export function summarizeResult(action, res, tFn) {
  if (!res || res.error === 'noSession') return { ok: false, text: tFn('gitquick.result.noRepo') };

  if (action === 'status') {
    const r = res.repo;
    if (!r || r.error) return { ok: false, text: tFn(r && r.error ? `git.error.${r.error}` : 'gitquick.result.noRepo') };
    const s = r.status;
    const bits = [s.branch || '?'];
    if (s.behind) bits.push(`↓${s.behind}`);
    if (s.ahead) bits.push(`↑${s.ahead}`);
    const dirty = s.staged + s.changed + s.untracked;
    if (dirty) bits.push(`●${dirty}`);
    if (s.conflicts) bits.push(`!${s.conflicts}`);
    return { ok: true, text: bits.join(' ') };
  }

  const okKey = { commit: 'gitquick.result.commitOk', push: 'gitquick.result.pushOk', fetch: 'gitquick.result.fetchOk' }[action];
  const failKey = { commit: 'gitquick.result.commitFail', push: 'gitquick.result.pushFail', fetch: 'gitquick.result.fetchFail' }[action];
  return { ok: !!res.ok, text: tFn(res.ok ? okKey : failKey) };
}

/**
 * Builds the text mirrored into the active terminal pane: the command line,
 * plus git's own output verbatim (already human-readable, no need to
 * re-translate it). `\r\n` throughout - xterm.js is a real terminal buffer,
 * a bare `\n` moves down without returning to column 0 (found by hand while
 * building this: plain `\n` output stair-stepped down the pane).
 */
export function buildMirrorText(action, message, res) {
  if (!res || res.error === 'noSession') return null;
  const cmd = describeCommand(action, message);
  const out = action === 'status' ? '' : String(res.output || '').trim();
  const lines = [`\r\n$ ${cmd}\r\n`];
  if (out) lines.push(`${out.split('\n').join('\r\n')}\r\n`);
  return lines.join('');
}

/**
 * The keyboard decision for the menu list, kept pure so it can be unit-tested
 * without a DOM (gitquick.js's handler is left a thin switch over the result).
 * Only the LIST is modelled here - the commit-message input has its own
 * handler and never reaches this function.
 *
 * `actions` is the id array, and the letter shortcut matches an id's first
 * letter (c/p/f/s). That stays honest only because every `gitquick.menu.*`
 * label happens to start with the same letter as its id in both languages;
 * a translation that breaks that would need the badge letter to come from
 * here instead of from the label.
 *
 * Returns one of:
 *   { kind: 'close' }             - Escape
 *   { kind: 'move',   sel }       - arrows, wrapping at both ends
 *   { kind: 'select', sel }       - Enter (sel unchanged) or a letter shortcut
 *   { kind: 'none' }              - anything else, swallowed by the modal
 */
export function resolveMenuKey(key, sel, actions) {
  const len = Array.isArray(actions) ? actions.length : 0;
  if (key === 'Escape') return { kind: 'close' };
  if (!len) return { kind: 'none' };
  if (key === 'ArrowDown') return { kind: 'move', sel: (sel + 1) % len };
  if (key === 'ArrowUp') return { kind: 'move', sel: (sel - 1 + len) % len };
  if (key === 'Enter') return { kind: 'select', sel };

  const letter = String(key || '').toLowerCase();
  if (letter.length !== 1) return { kind: 'none' }; // 'Tab', 'F5', ... never match
  const idx = actions.findIndex((a) => a[0] === letter);
  return idx >= 0 ? { kind: 'select', sel: idx } : { kind: 'none' };
}
