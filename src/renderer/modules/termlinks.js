// ============================================================================
// LunaCore - clickable file:line links in the terminal
// ----------------------------------------------------------------------------
// The RENDERER half. Claude Code prints `src/foo.js:123` (and `x.rs:9:4`)
// constantly; this turns those tokens into xterm links that underline on
// hover, show an "Open in editor" tooltip, and open the file at that line on
// click.
//
// Zero extra tokens, trivially: this is neither a Passive Observer nor an
// Action Injector - it never touches the PTY stream or the model. Detection is
// a pure string scan here; the click sends { sessionId, file, line, col } to
// main, which resolves the path against that session's own cwd and refuses
// anything that escapes it (see src/editor.js's header, the §D4a control).
//
// parseFileLinks() is pure and unit-tested (test/termlinks.test.js).
// mountFileLinks() wires one xterm instance and returns the IDisposable from
// registerLinkProvider() - the caller MUST dispose it when it disposes the
// terminal (FUTURE_PLAN.md §A2a/§A2b: a leaked provider is a leaked listener).
// ============================================================================

'use strict';

// Extensions that make a bare token (no path separator) count as a file link -
// so `README.md:1` works but `12:34:56` and `v1.2:3` do not. Kept deliberately
// tight; the follow-up list (Python `File "x.py", line 12`) is out of scope.
const SOURCE_EXTS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go', 'java',
  'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'css', 'scss', 'sass',
  'less', 'html', 'htm', 'vue', 'svelte', 'md', 'mdx', 'txt', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'lua',
  'kt', 'swift', 'dart', 'r', 'pl', 'ex', 'exs',
]);

// A path-ish run, then ":line" with an optional ":col". An optional Windows
// drive prefix (C:\ or C:/) is matched separately because ":" is not in the
// path-char class. The leading negative lookbehind stops the token starting
// mid-word or mid-URL - without it `https://h:80` yields a bogus `s://h`
// because `s:/` looks exactly like a drive prefix. Still deliberately loose:
// `12:34` matches here and is thrown out by the hasSep/known-ext filter in
// parseFileLinks() below, which is what keeps a plain `word:12` from ever
// becoming a link.
const TOKEN_RE = /(?<![\w:/\\.@+-])(?:[A-Za-z]:[\\/])?[\w./\\@+-]+:\d+(?::\d+)?/g;

// Splits the trailing ":line" / ":line:col" off an already-matched token.
const TAIL_RE = /:(\d+)(?::(\d+))?$/;

/**
 * Finds every file:line (and file:line:col) token on one terminal line.
 * Pure: a string in, a plain array out. Claude prints several per line, so all
 * matches are returned.
 *
 * @param {string} lineText  one terminal row, already flattened to a string.
 * @returns {Array<{startIndex:number,length:number,file:string,line:number,col:number|null}>}
 */
export function parseFileLinks(lineText) {
  if (typeof lineText !== 'string' || !lineText) return [];

  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(lineText)) !== null) {
    const token = m[0];
    const start = m.index;

    // Belt and braces over the lookbehind: never treat a URL authority as a
    // file (http://host:8080, git+ssh://...).
    if (token.indexOf('://') !== -1) continue;

    // Kill an "a:b:c" chain caught mid-string (a 12:34:56 timestamp): a ":"
    // immediately before the token.
    const before = lineText.slice(Math.max(0, start - 2), start);
    if (before.endsWith('//') || before.endsWith(':')) continue;

    const tail = TAIL_RE.exec(token);
    if (!tail) continue; // regex guarantees this, but be defensive
    const file = token.slice(0, tail.index);
    if (!file) continue;

    const hasSep = file.indexOf('/') !== -1 || file.indexOf('\\') !== -1;
    const dot = file.lastIndexOf('.');
    const ext = dot !== -1 ? file.slice(dot + 1).toLowerCase() : '';
    if (!hasSep && !SOURCE_EXTS.has(ext)) continue;

    out.push({
      startIndex: start,
      length: token.length,
      file,
      line: parseInt(tail[1], 10),
      col: tail[2] != null ? parseInt(tail[2], 10) : null,
    });
  }
  return out;
}

// ---- Tooltip + failure notice (DOM, renderer only) ------------------------

let tipEl = null;

function tip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'termlink-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

function showTip(evt, text) {
  const el = tip();
  el.textContent = text;
  el.hidden = false;
  const pad = 12;
  el.style.left = `${evt.clientX + pad}px`;
  el.style.top = `${evt.clientY + pad}px`;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

let noteTimer = null;

/**
 * A transient one-line failure notice in the terminal bar (the token was a
 * traversal string, the file vanished, or no editor is configured). The
 * `#termlink-note` span is a singleton in the `terminal` widget, which never
 * remounts, so a lazy lookup is safe - same pattern as claudecheck.js.
 */
function showNote(text) {
  const el = document.getElementById('termlink-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

const REASON_KEY = {
  noSession: 'termlink.failed',
  badPath: 'termlink.failed.badPath',
  noEditor: 'termlink.failed.noEditor',
  spawnFailed: 'termlink.failed',
};

/**
 * Registers the file:line link provider on one xterm instance.
 *
 * @param {import('@xterm/xterm').Terminal} instance
 * @param {() => string} getSessionId  the owning tab's id (each tab resolves
 *   its links against its OWN cwd, so a background tab is correct too).
 * @returns {{dispose: () => void}} the registerLinkProvider disposable - the
 *   caller stores it next to the instance and disposes it on teardown.
 */
export function mountFileLinks(instance, getSessionId) {
  const provider = {
    provideLinks(y, callback) {
      const bufferLine = instance.buffer.active.getLine(y - 1);
      if (!bufferLine) {
        callback(undefined);
        return;
      }
      const text = bufferLine.translateToString(true);
      const matches = parseFileLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links = matches.map((mt) => ({
        text: text.slice(mt.startIndex, mt.startIndex + mt.length),
        // xterm link ranges are 1-based, `end` inclusive.
        range: {
          start: { x: mt.startIndex + 1, y },
          end: { x: mt.startIndex + mt.length, y },
        },
        activate() {
          hideTip();
          Promise.resolve(
            window.lunacore.openInEditor({
              sessionId: getSessionId(),
              file: mt.file,
              line: mt.line,
              col: mt.col,
            })
          ).then((res) => {
            if (res && res.ok) return;
            const key = (res && REASON_KEY[res.reason]) || 'termlink.failed';
            showNote(window.i18n.t(key));
          });
        },
        hover(evt) {
          showTip(evt, window.i18n.t('termlink.tooltip'));
        },
        leave() {
          hideTip();
        },
      }));
      callback(links);
    },
  };

  return instance.registerLinkProvider(provider);
}
