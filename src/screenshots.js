// ============================================================================
// LunaCore - screenshots pasted into a session
// ----------------------------------------------------------------------------
// Win+Shift+S puts a BITMAP on the clipboard, not text. xterm.js's paste
// handler only reads text/plain, so Ctrl+V in a terminal silently did nothing
// - which is why an external helper (winclipshot) existed at all: it watches
// the clipboard, and when a known terminal .exe takes focus it swaps the
// bitmap for the path of a PNG it saved. LunaCore was never on that helper's
// list of terminals, so the paste died here specifically.
//
// This module is that trick, in-app and without the allowlist: the renderer
// hands us the bytes of an image the user explicitly pasted, we write them to
// a file, and main.js pastes the PATH into the session - which is the form
// Claude Code reads an image in.
//
// WE DO NOT READ THE CLIPBOARD. src/clipboard.js's header explains why that
// line matters: a poller sees everything copied anywhere on the machine.
// Nothing here runs until the user presses Ctrl+V over a terminal pane, and
// the only bytes we ever touch are the ones that paste carried.
//
// WHY %TEMP% and not the project folder: a screenshot pasted into a chat is a
// throwaway, and dropping PNGs into a repo would show up in `git status` (and
// eventually in a commit). The cap below keeps the folder from growing without
// bound the way winclipshot's own %TEMP%\winclipshot does.
//
// Pure half (extForMime / clipName / excessClips) separated from the I/O half
// for the reason filestat.js and clipboard.js both document: the interesting
// behaviour stays testable without a disk.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Folder under %TEMP% that holds pasted screenshots. */
const DIR_NAME = 'lunacore-clips';

/**
 * Filename prefix. Every deletion this module performs is gated on it, so a
 * folder the user also keeps something else in cannot be swept up by pruning.
 */
const PREFIX = 'clip-';

/** How many clips survive. A history of pastes, not an archive. */
const MAX_CLIPS = 30;

/**
 * Per-clip byte cap. A full-screen PNG is ~1-5 MB; 25 MB is far past any
 * screenshot and stops a stray multi-hundred-MB paste from filling the disk.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Accepted clipboard image types -> file extension.
 *
 * An allowlist rather than a `split('/')` guess: the extension ends up inside
 * a path we write to disk, and "whatever came after image/" is user-supplied
 * data. SVG is deliberately absent - it is markup, not a screenshot.
 */
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

/** Where clips live. */
function clipsDir() {
  return path.join(os.tmpdir(), DIR_NAME);
}

/**
 * The extension for a clipboard MIME type, or null when we do not take it.
 * Tolerates the case and `; parameter` spellings a DataTransfer may carry.
 * @param {unknown} mime
 * @returns {string|null}
 */
function extForMime(mime) {
  if (typeof mime !== 'string') return null;
  const base = mime.toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[base] || null;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * The filename for a clip pasted at `now`.
 *
 * Local time, biggest unit first, so plain lexicographic order IS chronological
 * order - which is the whole reason excessClips() can find the oldest files by
 * sorting names instead of stat()-ing every one of them. Milliseconds are in
 * the name because two pastes can land in the same second.
 *
 * @param {unknown} mime
 * @param {number} [now]
 * @returns {string|null} null when the type is not one we take
 */
function clipName(mime, now = Date.now()) {
  const ext = extForMime(mime);
  if (!ext) return null;
  const d = new Date(now);
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`;
  return `${PREFIX}${stamp}${ext}`;
}

/**
 * Which of `names` are over the cap - oldest first, and only ever our own.
 * Pure: takes a listing, returns names. The caller does the deleting.
 * @param {unknown} names a directory listing
 * @param {number} [max]
 * @returns {string[]}
 */
function excessClips(names, max = MAX_CLIPS) {
  const ours = (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string' && name.startsWith(PREFIX))
    .sort();
  return ours.length <= max ? [] : ours.slice(0, ours.length - max);
}

/**
 * Normalizes whatever the IPC layer delivered into a Buffer.
 * Structured clone turns the renderer's Uint8Array back into a Uint8Array, not
 * a Buffer, so this is a real conversion rather than a formality.
 * @returns {Buffer|null}
 */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  return null;
}

/**
 * Writes one pasted image.
 *
 * `dir` is a parameter (not clipsDir() baked in) so tests run against a
 * throwaway folder - the same boundary ports.js draws around its scanner.
 *
 * @param {string} dir
 * @param {Buffer|Uint8Array|ArrayBuffer} bytes
 * @param {string} mime
 * @param {number} [now]
 * @returns {string|null} absolute path, or null when nothing was written
 */
function saveClip(dir, bytes, mime, now = Date.now()) {
  const buf = toBuffer(bytes);
  if (!buf || buf.length === 0 || buf.length > MAX_BYTES) return null;
  const name = clipName(mime, now);
  if (!name) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    // A full disk, a read-only %TEMP%, a name collision with a directory: the
    // paste simply does not happen. Nothing here is worth crashing main over.
    return null;
  }
}

/**
 * Deletes clips past the cap. Best effort - a file held open by an image
 * viewer just survives until the next paste.
 * @param {string} dir
 * @param {number} [max]
 */
function pruneClips(dir, max = MAX_CLIPS) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // nothing pasted yet, or the folder was cleaned up under us
  }
  for (const name of excessClips(names, max)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // keep going: one stuck file must not stop the rest of the prune
    }
  }
}

module.exports = {
  clipsDir,
  extForMime,
  clipName,
  excessClips,
  saveClip,
  pruneClips,
  DIR_NAME,
  PREFIX,
  MAX_CLIPS,
  MAX_BYTES,
};
