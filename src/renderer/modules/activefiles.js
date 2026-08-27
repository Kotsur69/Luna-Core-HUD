// ============================================================================
// LunaCore - Active-Files Edit Heatmap (ACTIVE_FILES_HEATMAP_PLAN.md)
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER, the narrowest kind: rides the Skill Tracker's existing
// tool_use/tool_result lifecycle (observer.js's toolEventsFromLines() /
// foldToolEvents(), widened in §3.2 to carry file identity + diff stats) - the
// diff stats need no new IPC channel or fs read of the edited file's content.
//
// One exception (Mati, 2026-08-13 manual test): whether a tracked file still
// EXISTS cannot be read from the transcript at all - `rm` is a Bash call with
// no file_path, so there is no lifecycle event to ride. That one fact comes
// from a narrow, read-only IPC round trip (files:check-exist -> fs.existsSync
// in main.js, renderer has no fs access under context isolation), polled on
// the same timer as the live-indicator self-heal. Still just a local disk
// read - no token, no PTY write, no hidden agent.
//
// A SECOND, opt-in read of the same class: clicking a CHANGED or DELETED row
// opens #filediff-modal with that file's accumulated `git diff HEAD -- <file>`
// (files:diff -> gitfiles.js's git() in main.js). `git diff` is a local disk
// read - zero tokens, zero PTY writes, no watcher - and it happens ONLY on an
// explicit user click, never on a timer. Pure read-only rows stay inert: there
// is no diff behind them, so they get no affordance. The diff text is painted
// line by line with createElement (never innerHTML with git output).
//
// Three things this shows that a plain "files touched" tally would not:
//
//  1. Real +/- line counts, straight from the CLI's own `structuredPatch`
//     (a computed unified diff already sitting in the transcript) - not a
//     hand-rolled diff, not a blink, not a frequency count (§2).
//  2. A LIVE indicator (`inProgress`, §5.6): a file lights up the moment its
//     tool is called, before the result comes back, and turns off the instant
//     it does - not just after the fact.
//  3. A DELETED indicator: a file that no longer exists keeps its last known
//     diff (the edit still happened) but is visibly marked gone, rather than
//     silently looking unchanged.
//
// State placement follows ports.js's split: `files` is app state and stays at
// module scope so a remount repaints from truth (§A2c); `els` is DOM state and
// belongs to the mount.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onSessionRestarted, onActiveContext, registerSessionView } from './bus.js';
import { defineWidget } from './registry.js';
import { getActiveSessionId } from './terminals.js';
import { parseDiff } from '../../filediff.js';

/** Honest truncation (ports.js's rule): show this many, state the rest. */
const MAX_ROWS = 8;

/** Self-heal ceiling (Mati, 2026-08-13 manual test: a row stayed live past its
 *  edit finishing). The start/end pairing in observer.js is transcript-driven
 *  and normally reliable, but an end event can still go missing - a hook
 *  denying the call before the CLI ever writes a matching tool_result, a
 *  crashed nested session, anything upstream this widget cannot see. Rather
 *  than trust that pairing is always perfect, a row that has been "live" for
 *  longer than any real Edit/Write/Read call takes is forced dark. Real Edit
 *  tool calls resolve in well under a second; 20s gives huge headroom without
 *  meaningfully delaying the self-heal a stuck row needs. */
const MAX_LIVE_MS = 20000;

/** How often the self-heal sweep runs while mounted. Cheap (a Map scan, no
 *  I/O) and purely local DOM hygiene - not a Passive Observer violation, since
 *  it never touches the PTY or the transcript. */
const STALE_CHECK_MS = 5000;

/** Absolute path -> { file, added, removed, touches, lastAt, inProgress,
 *  liveSince, deleted }. App state, not view state - survives unmount/remount
 *  and tab backgrounding. */
let files = new Map();

/** Elements of the current mount, or null while this widget is off screen. */
let els = null;

/**
 * Last two path segments, `\` or `/` alike. Not cwd-relative in v1 - see plan
 * §5.2 for why threading the session cwd in here is deferred.
 * @param {string} file absolute path
 * @returns {string}
 */
export function shortPath(file) {
  if (!file) return '';
  const parts = String(file).split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * Folds one tool lifecycle event (from foldToolEvents()) into the file map.
 * Pure and exported so the accumulation logic is unit-testable without a DOM
 * - the same split spark.js uses for pushSample().
 *
 * A `start` only flips the live flag - it never touches added/removed, so a
 * rejected or still-running edit never inflates the stat. The matching `end`
 * ADDS to added/removed (two edits to one file accumulate into one row) and
 * unconditionally clears `inProgress`, even when its stat is {0,0} (a Read,
 * or a failed edit) - a row must never stay lit past its tool call returning.
 *
 * Events with no `file` (Bash, Grep, ...) carry no file identity and are
 * dropped - there is nothing to key a row on.
 *
 * @param {Map<string, object>} map mutated in place
 * @param {{phase:'start'|'end', at:number|null, file:string, added?:number, removed?:number}} ev
 * @returns {Map<string, object>} the same map, for chaining
 */
export function applyFileEvent(map, ev) {
  if (!ev || !ev.file) return map;

  const row =
    map.get(ev.file) ||
    {
      file: ev.file,
      added: 0,
      removed: 0,
      // Characters this file has put into the context window, summed across
      // reads. Deliberately cumulative: reading one file three times costs
      // three times, and a row that hid that would be answering a question
      // nobody asked ("how big is it") instead of the one they did.
      contextChars: 0,
      contextTokens: 0,
      reads: 0,
      touches: 0,
      lastAt: 0,
      inProgress: false,
      liveSince: 0,
      deleted: false,
    };

  if (ev.phase === 'start') {
    row.inProgress = true;
    row.liveSince = ev.at || Date.now();
  } else {
    row.inProgress = false;
    row.liveSince = 0;
    row.added += ev.added || 0;
    row.removed += ev.removed || 0;
    row.touches += 1;
    if (ev.contextChars > 0) {
      row.contextChars += ev.contextChars;
      // Summed, never re-derived: the chars-per-token ratio lives in
      // src/filestat.js and the estimate is made once, in the main process.
      row.contextTokens += ev.contextTokens || 0;
      row.reads += 1;
    }
  }
  row.lastAt = ev.at || Date.now();
  // A real tool call on this path is strong evidence it exists again (a Write
  // recreating a deleted file, say) - the next files:check-exist sweep will
  // re-flag it if that turns out to be wrong (e.g. a failed edit attempt).
  row.deleted = false;

  map.set(ev.file, row);
  return map;
}

/**
 * Folds one git-sourced stat (src/gitfiles.js's GitFileWatcher) into the file
 * map. A file the transcript already has real touches for (`row.touches > 0`)
 * is left alone - the transcript's structuredPatch-derived numbers are exact,
 * git's are a second opinion, and this is a Bash/PowerShell-only backstop, not
 * a source that should fight the more precise one for the same row (plan
 * §12/R4's whole point about ONLY READ COUNTS applies here too: don't blend
 * two measurements of the same thing).
 *
 * Unlike applyFileEvent's 'end' branch, this OVERWRITES added/removed rather
 * than accumulating: `files:` git status/diff is polled repeatedly and each
 * read is the file's CURRENT total diff, not a discrete new event - adding it
 * every tick would multiply the same change by however many polls happened
 * to catch it.
 * @param {Map<string, object>} map mutated in place
 * @param {{file:string, added:number, removed:number}} stat
 * @returns {Map<string, object>} the same map, for chaining
 */
export function applyGitStat(map, stat) {
  if (!stat || !stat.file) return map;
  const existing = map.get(stat.file);
  if (existing && existing.touches > 0) return map;

  const row = existing || {
    file: stat.file,
    added: 0,
    removed: 0,
    contextChars: 0,
    contextTokens: 0,
    reads: 0,
    touches: 0,
    lastAt: 0,
    inProgress: false,
    liveSince: 0,
    deleted: false,
  };
  row.added = stat.added || 0;
  row.removed = stat.removed || 0;
  row.lastAt = Date.now();
  row.deleted = false;

  map.set(stat.file, row);
  return map;
}

/**
 * Applies a files:check-exist result ({path: boolean}) to the map: any
 * tracked row whose path came back `false` is marked deleted. Paths not
 * present in `existsMap` (e.g. the IPC call raced a row being added) are left
 * alone rather than guessed at.
 *
 * Pure and exported for the same reason as clearStaleInProgress - the async
 * IPC round trip lives in refreshDeleted() below, so this half is testable
 * without mocking window.lunacore.
 * @param {Map<string, object>} map mutated in place
 * @param {Record<string, boolean>} existsMap
 * @returns {boolean} true if any row's deleted flag changed (caller should re-render)
 */
export function applyDeletedFlags(map, existsMap) {
  let changed = false;
  if (!existsMap) return changed;
  for (const row of map.values()) {
    if (!Object.prototype.hasOwnProperty.call(existsMap, row.file)) continue;
    const deleted = !existsMap[row.file];
    if (row.deleted !== deleted) {
      row.deleted = deleted;
      changed = true;
    }
  }
  return changed;
}

/**
 * Self-heal sweep (see MAX_LIVE_MS): forces any row that has been `inProgress`
 * for longer than a real tool call could possibly take back to dark. Exists
 * because the live flag can only be turned off by a matching `end` event
 * (§5.6), and this widget has no way to prove that event is coming - a hook
 * denial upstream, a killed nested session, or any other gap between this
 * observer and the CLI can leave a row lit with nothing left to close it.
 *
 * Pure and exported so the ceiling behavior is unit-testable without a real
 * timer - the caller supplies `now` instead of this function reading the
 * clock itself.
 * @param {Map<string, object>} map mutated in place
 * @param {number} now Date.now() at check time
 * @param {number} maxAgeMs ceiling in ms
 * @returns {boolean} true if any row was cleared (caller should re-render)
 */
export function clearStaleInProgress(map, now, maxAgeMs) {
  let changed = false;
  for (const row of map.values()) {
    if (row.inProgress && row.liveSince && now - row.liveSince > maxAgeMs) {
      row.inProgress = false;
      row.liveSince = 0;
      changed = true;
    }
  }
  return changed;
}

/** Live rows first, then changed files ahead of read-only ones (plan §12/R6),
 *  then most-recent first within each group. */
function sortedRows(map) {
  return [...map.values()].sort((a, b) => {
    if (a.inProgress !== b.inProgress) return a.inProgress ? -1 : 1;
    const aChanged = a.added + a.removed > 0;
    const bChanged = b.added + b.removed > 0;
    if (aChanged !== bChanged) return aChanged ? -1 : 1;
    return b.lastAt - a.lastAt;
  });
}

/**
 * Context window of the ACTIVE session, so a file's weight can be shown as a
 * share of the window it is competing for. 0 = not known yet, and then the row
 * prints the token estimate alone rather than a percentage of a guess.
 */
let contextLimit = 0;

/** Compact token count: 1928 -> "1.9k". */
function formatTokens(n) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

// --- Accumulated diff viewer (#filediff-modal) ------------------------------
// The modal markup is static top-level HTML (index.html), not part of this
// widget's template, so it is looked up once and survives mount/unmount -
// same rule as sessiontimeline.js / mcp.js.
let diffModal = null;
let diffModalOpen = false;
// Bumped on every open; a slow git result whose token no longer matches (the
// user clicked another row, or closed the modal) is dropped rather than
// painted into the wrong or closed panel.
let diffReqToken = 0;

function ensureDiffModal() {
  if (diffModal) return;
  const el = document.getElementById('filediff-modal');
  if (!el) return;
  diffModal = {
    el,
    title: document.getElementById('filediff-modal-title'),
    text: document.getElementById('filediff-modal-text'),
    truncated: document.getElementById('filediff-modal-truncated'),
  };
  el.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-filediff-close')) closeDiffModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && diffModalOpen) closeDiffModal();
  });
}

/** Maps a parseDiff() line kind to its colour class. 'meta' shares the dim
 *  'hunk' class (@@ headers and diff --git / index / +++ / --- headers read
 *  alike); 'ctx' gets no class and keeps the panel's default text colour. */
function diffLineClass(kind) {
  if (kind === 'add') return 'filediff__add';
  if (kind === 'del') return 'filediff__del';
  if (kind === 'hunk' || kind === 'meta') return 'filediff__hunk';
  return '';
}

/** Paints classified diff lines into the <pre> with createElement - never
 *  innerHTML with git output. */
function paintDiff(pre, lines) {
  pre.textContent = '';
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const span = document.createElement('span');
    const cls = diffLineClass(line.kind);
    if (cls) span.className = cls;
    span.textContent = `${line.text}\n`;
    frag.appendChild(span);
  }
  pre.appendChild(frag);
}

/** Fills the <pre> with a single message line (empty state / not-a-repo). */
function showDiffMessage(msgKey) {
  if (!diffModal) return;
  diffModal.text.textContent = t(msgKey);
  diffModal.truncated.hidden = true;
}

/** Opens #filediff-modal for one file and fills it with `git diff HEAD --
 *  <file>` from main.js. Read-only: this only ever displays the diff text. */
async function openDiffModal(file) {
  ensureDiffModal();
  if (!diffModal || !file) return;

  const token = ++diffReqToken;
  diffModal.title.textContent = `${t('activefiles.diff.title')} · ${shortPath(file)}`;
  diffModal.text.textContent = '';
  diffModal.truncated.hidden = true;
  diffModal.el.hidden = false;
  diffModalOpen = true;

  if (!window.lunacore || typeof window.lunacore.getFileDiff !== 'function') {
    showDiffMessage('activefiles.diff.empty');
    return;
  }

  let res;
  try {
    res = await window.lunacore.getFileDiff(getActiveSessionId(), file);
  } catch {
    res = null;
  }
  // A newer open, or a close, happened while the IPC was in flight.
  if (token !== diffReqToken || !diffModalOpen) return;

  if (!res || !res.ok) {
    showDiffMessage(res && res.reason === 'notRepo' ? 'activefiles.diff.notrepo' : 'activefiles.diff.empty');
    return;
  }
  const { lines } = parseDiff(res.diff);
  if (!lines.length) {
    showDiffMessage('activefiles.diff.empty');
    return;
  }
  paintDiff(diffModal.text, lines);
  diffModal.truncated.hidden = !res.truncated;
}

function closeDiffModal() {
  if (!diffModalOpen || !diffModal) return;
  diffModalOpen = false;
  diffModal.el.hidden = true;
  diffModal.text.textContent = '';
}

/** One `<li class="afile">` - built by createElement, never innerHTML with
 *  data (ports.js:39-47's precedent; file paths are untrusted-ish text). */
function buildRow(row) {
  const changed = row.added + row.removed > 0;

  const li = document.createElement('li');
  li.className = changed ? 'afile' : 'afile is-read';
  li.classList.toggle('is-live', !!row.inProgress);
  li.classList.toggle('is-deleted', !!row.deleted);

  // A CHANGED or DELETED row has an accumulated diff worth showing - make it
  // open #filediff-modal. A pure read-only row (read, never changed, still on
  // disk) has nothing to diff, so it stays inert - no cursor, no semantics.
  const hasDiff = changed || !!row.deleted;
  if (hasDiff) {
    li.classList.add('is-clickable');
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.setAttribute('aria-label', `${t('activefiles.diff.title')}: ${shortPath(row.file)}`);
    const open = () => openDiffModal(row.file);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  const dot = document.createElement('i');
  dot.className = 'afile__dot';
  li.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'afile__name';
  name.textContent = shortPath(row.file);
  name.title = row.file;
  li.appendChild(name);

  if (changed) {
    const stat = document.createElement('span');
    stat.className = 'afile__stat';
    if (row.added > 0) {
      const add = document.createElement('i');
      add.className = 'afile__add';
      add.textContent = `+${row.added}`;
      stat.appendChild(add);
    }
    if (row.removed > 0) {
      const del = document.createElement('i');
      del.className = 'afile__del';
      del.textContent = `−${row.removed}`;
      stat.appendChild(del);
    }
    li.appendChild(stat);
  } else if (row.contextTokens <= 0) {
    // Touched but never actually read into context - keep the old label rather
    // than an empty column.
    const ro = document.createElement('span');
    ro.className = 'afile__readonly';
    ro.textContent = t('activefiles.readonly');
    li.appendChild(ro);
  }

  // What this file cost the context window. `≈` is not decoration: every other
  // token number in the HUD comes straight from the API and is exact, this one
  // is derived from a chars-per-token ratio. The tooltip carries the datum that
  // is not an estimate - the exact character count - plus how many reads it
  // took, which is where the surprises are.
  if (row.contextTokens > 0) {
    const weight = document.createElement('span');
    weight.className = 'afile__weight';
    const share =
      contextLimit > 0 ? Math.round((row.contextTokens / contextLimit) * 1000) / 10 : null;
    weight.textContent =
      share !== null
        ? `≈${formatTokens(row.contextTokens)} · ${share}%`
        : `≈${formatTokens(row.contextTokens)}`;
    weight.title = t('activefiles.weight.title', {
      chars: row.contextChars.toLocaleString(),
      reads: row.reads,
    });
    li.appendChild(weight);
  }

  if (row.deleted) {
    const del = document.createElement('span');
    del.className = 'afile__deleted';
    del.textContent = t('activefiles.deleted');
    li.appendChild(del);
  }

  return li;
}

/** Repaints from `files`. Called on every event AND on mount/lang change, so
 *  a remount shows truth rather than the template's authored empty state. */
function render() {
  if (!els) return;

  const rows = sortedRows(files);
  els.list.innerHTML = '';

  if (!rows.length) {
    els.empty.textContent = t('activefiles.empty');
    els.empty.style.display = '';
    return;
  }

  const shown = rows.slice(0, MAX_ROWS);
  for (const row of shown) els.list.appendChild(buildRow(row));

  const extra = rows.length - shown.length;
  els.empty.textContent = extra > 0 ? t('activefiles.more', { n: extra }) : '';
  els.empty.style.display = extra > 0 ? '' : 'none';
}

/** Apply transcript lifecycle events to the tab you are looking at. */
export function applyFileEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  for (const ev of events) applyFileEvent(files, ev);
  render();
}

/**
 * Asks main.js which of the currently-tracked files still exist and applies
 * the result. Fire-and-forget from the caller's point of view - errors are
 * swallowed (an IPC hiccup should not spam anything) and a re-render only
 * happens when something actually changed.
 */
async function refreshDeleted() {
  if (!window.lunacore || typeof window.lunacore.checkFilesExist !== 'function') return;
  const paths = [...files.keys()];
  if (!paths.length) return;
  let existsMap;
  try {
    existsMap = await window.lunacore.checkFilesExist(paths);
  } catch {
    return;
  }
  if (applyDeletedFlags(files, existsMap)) render();
}

/** The same fold for a tab running in the background: keep its file map
 *  accurate so switching to it shows what happened THERE, without touching
 *  the DOM. Mirrors skilltracker.js's trackBucketTools(). */
export function trackBucketFiles(bucket, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  if (!bucket.activeFiles) bucket.activeFiles = new Map();
  for (const ev of events) applyFileEvent(bucket.activeFiles, ev);
}

/** Apply git-sourced stats (src/gitfiles.js) to the tab you are looking at. */
export function applyGitFiles(stats) {
  if (!Array.isArray(stats) || stats.length === 0) return;
  for (const stat of stats) applyGitStat(files, stat);
  render();
}

/** The same fold for a tab running in the background - mirrors trackBucketFiles(). */
export function trackBucketGitFiles(bucket, stats) {
  if (!Array.isArray(stats) || stats.length === 0) return;
  if (!bucket.activeFiles) bucket.activeFiles = new Map();
  for (const stat of stats) applyGitStat(bucket.activeFiles, stat);
}

defineWidget({
  id: 'activefiles',
  titleKey: 'activefiles.title',
  template: 'w-activefiles',
  mount(root) {
    els = {
      list: root.querySelector('#afile-list'),
      empty: root.querySelector('#afile-empty'),
    };
    ensureDiffModal();

    const offLang = onLangChange(render);
    // Only for the denominator of a row's share. Repainting on every context
    // tick would be pointless churn, so this only redraws when the limit
    // actually changes - which is once per session, or when the model does.
    const offCtx = onActiveContext((m) => {
      const limit = m && Number(m.limit) > 0 ? Number(m.limit) : 0;
      if (limit && limit !== contextLimit) {
        contextLimit = limit;
        render();
      }
    });
    render();
    refreshDeleted(); // do not wait a full interval for the first check

    const staleTimer = setInterval(() => {
      if (clearStaleInProgress(files, Date.now(), MAX_LIVE_MS)) render();
      refreshDeleted();
    }, STALE_CHECK_MS);

    return () => {
      offLang();
      offCtx();
      clearInterval(staleTimer);
      closeDiffModal();
      els = null;
    };
  },
});

// Module scope, not inside mount() - same reason skilltracker.js gives:
// a background tab's bookkeeping must stay correct while this widget is off
// screen, and the subscriber count --luna-probe watches must stay constant
// across remounts.
registerSessionView({
  save(bucket) {
    bucket.activeFiles = new Map(files);
  },
  load(bucket) {
    files = bucket.activeFiles || new Map();
    // A background tab gets no stale sweep (no timer runs while off screen) -
    // catch up in one shot so switching to it never shows a leftover live row
    // or a deleted-file row that still looks untouched.
    clearStaleInProgress(files, Date.now(), MAX_LIVE_MS);
    render();
    refreshDeleted();
  },
  clear(bucket) {
    bucket.activeFiles = new Map();
  },
});

// Restart = a new process: whatever was tracked belonged to the one that died.
onSessionRestarted(() => {
  files = new Map();
  closeDiffModal();
  render();
});
