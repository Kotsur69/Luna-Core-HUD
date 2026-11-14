// ============================================================================
// LunaCore - a minimal, defensive zip reader for library asset downloads
// ----------------------------------------------------------------------------
// ambientCG ships its texture sets as zip files, Sketchfab a glTF model with
// its buffers and textures (src/lunasworkFreeSources.js). No dependency: the
// central directory is parsed by hand and each wanted entry is inflated with
// zlib. Only what an asset needs comes out:
//
//   - entries whose extension the caller allows (images, HDR / EXR, models,
//     sounds); everything else is skipped, never written
//   - a flat file name: an entry name with "..", a drive, an absolute path or
//     a control character is refused; folders inside the zip are dropped,
//     unless keepDirs (a glTF names its textures by relative path): then up to
//     MAX_DIR_DEPTH folders are kept, each one a safe name
//   - no Windows device name (CON, NUL, COM1...) and no trailing dot or space
//   - stored (0) or deflated (8) only; encrypted and zip64 entries refused
//   - caps on the entry count, each entry's size and the total, enforced on
//     the inflated bytes (maxOutputLength), not only the declared sizes
//   - the CRC-32 of every extracted entry is checked
//
// Pure: a Buffer in, {name, data}[] out. Inflation is async (zlib's thread
// pool), so a big archive does not stall the main process. Rejects with an
// Error with a plain message.
// ============================================================================

'use strict';

const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const CEN_MIN = 46;
const LOC_MIN = 30;
const ZIP64_MARK = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const STORED = 0;
const DEFLATED = 8;
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 2000, maxFiles: 32, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });
const SAFE_NAME_RE = /^[\w][\w .()+-]{0,119}$/;
const MAX_DIR_DEPTH = 3;
// Names Windows maps to a device whatever the extension.
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** True for a file or folder name that is safe to create on every OS. */
const isSafeName = (name) => SAFE_NAME_RE.test(name) && !DEVICE_NAME_RE.test(name) && !/[. ]$/.test(name);

/** CRC-32 (IEEE), table built once; zlib.crc32 where the runtime has it. */
const crc32 = (() => {
  if (typeof zlib.crc32 === 'function') return (buf) => zlib.crc32(buf) >>> 0;
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function findEocd(buf) {
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= lowest; i -= 1) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  throw new Error('not a zip file (no end of central directory)');
}

/**
 * The name an entry may be written as (flat, or with its folders when
 * keepDirs), or null when it must be skipped. Throws for a name that tries to
 * leave its folder.
 */
function entryFileName(raw, keepDirs) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('refused: a zip entry name has control characters');
  const parts = raw.split(/[\\/]/);
  if (parts.includes('..') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`refused: the zip entry "${raw.slice(0, 80)}" points outside its folder`);
  }
  const base = parts[parts.length - 1];
  if (!base || base.startsWith('.') || raw.toLowerCase().startsWith('__macosx/')) return null;
  if (!keepDirs) return isSafeName(base) ? base : null;
  const kept = parts.filter((p) => p && p !== '.');
  if (kept.length > MAX_DIR_DEPTH + 1 || !kept.every(isSafeName)) return null;
  return kept.join('/');
}

/** The central directory entries: name, method, sizes, CRC and local header offset. */
function centralEntries(buf, limits) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (size === ZIP64_MARK || offset === ZIP64_MARK || count === 0xffff) throw new Error('refused: zip64 archives are not read');
  if (count > limits.maxEntries) throw new Error(`refused: the zip has more than ${limits.maxEntries} entries`);
  if (offset + size > eocd) throw new Error('not a zip file (bad central directory)');
  const entries = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + CEN_MIN > eocd || buf.readUInt32LE(at) !== CEN_SIG) throw new Error('not a zip file (bad central directory entry)');
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    entries.push({
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressed: buf.readUInt32LE(at + 20),
      uncompressed: buf.readUInt32LE(at + 24),
      local: buf.readUInt32LE(at + 42),
      name: buf.toString('utf8', at + CEN_MIN, at + CEN_MIN + nameLen),
    });
    at += CEN_MIN + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, inflated and checked. */
async function entryData(buf, e, maxBytes) {
  if (e.flags & FLAG_ENCRYPTED) throw new Error(`refused: the zip entry ${e.name} is encrypted`);
  if (e.compressed === ZIP64_MARK || e.uncompressed === ZIP64_MARK || e.local === ZIP64_MARK) throw new Error('refused: zip64 entries are not read');
  if (e.uncompressed > maxBytes) throw new Error(`refused: the zip entry ${e.name} is larger than ${maxBytes} bytes`);
  if (e.local + LOC_MIN > buf.length || buf.readUInt32LE(e.local) !== LOC_SIG) throw new Error('not a zip file (bad local header)');
  const start = e.local + LOC_MIN + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  if (start + e.compressed > buf.length) throw new Error(`the zip entry ${e.name} is cut off`);
  const raw = buf.subarray(start, start + e.compressed);
  let data;
  if (e.method === STORED) data = Buffer.from(raw);
  else if (e.method === DEFLATED) {
    try {
      data = await inflateRaw(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new Error(`the zip entry ${e.name} does not inflate (${err && err.code ? err.code : 'error'})`);
    }
  } else throw new Error(`refused: the zip entry ${e.name} uses compression method ${e.method}`);
  if (data.length !== e.uncompressed || crc32(data) !== e.crc) throw new Error(`the zip entry ${e.name} is damaged (size or CRC mismatch)`);
  return data;
}

/**
 * The wanted files of a zip, flat unless keepDirs.
 * @param {Buffer} buf
 * @param {{allowExt:string[], keepDirs?:boolean, maxEntries?:number, maxFiles?:number, maxFileBytes?:number, maxTotalBytes?:number}} opts
 *   allowExt: lower-case extensions without the dot
 * @returns {Promise<{name:string, data:Buffer}[]>} name: posix, relative
 */
async function readZip(buf, opts) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) throw new Error('not a zip file');
  const limits = { ...DEFAULT_LIMITS, ...(opts || {}) };
  const allow = new Set(Array.isArray(limits.allowExt) ? limits.allowExt : []);
  const out = [];
  const names = new Set();
  let total = 0;
  for (const e of centralEntries(buf, limits)) {
    if (e.name.endsWith('/')) continue;
    const name = entryFileName(e.name, limits.keepDirs === true);
    const base = name ? name.slice(name.lastIndexOf('/') + 1) : '';
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!name || !allow.has(ext) || names.has(name.toLowerCase())) continue;
    if (out.length >= limits.maxFiles) throw new Error(`refused: the zip has more than ${limits.maxFiles} usable files`);
    const room = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
    if (room < 1) throw new Error(`refused: the zip unpacks to more than ${limits.maxTotalBytes} bytes`);
    const data = await entryData(buf, e, room);
    total += data.length;
    names.add(name.toLowerCase());
    out.push({ name, data });
  }
  return out;
}

module.exports = { readZip, crc32, isSafeName };
