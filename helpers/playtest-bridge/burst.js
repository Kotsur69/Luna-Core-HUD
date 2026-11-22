// ============================================================================
// LunaCore - Playtester bridge: burst capture and the contact sheet
// ----------------------------------------------------------------------------
// A single screenshot cannot show motion: hit-stop freezes, UI animations,
// eye-trail afterimages. `burst` (tools.js) takes N screenshots at even
// intervals through the backend's own `screenshot` call, recording the real
// time each capture started, then stitches them into ONE PNG: a grid read
// left to right, top to bottom, every tile labeled "#<n> +<ms>ms" (offset
// from the start of the burst). A frame that failed becomes a crossed-out
// tile labeled FAIL plus a note; the burst fails only when every frame did.
// Frames still pending 10 s past the planned end are skipped (a hung app),
// and frames are decoded one at a time (one decoded frame in memory).
//
// The sheet stays within the caps LunaCore applies to a Playtester evidence
// PNG (src/lunasworkPlaytest.js MAX_PNG_PIXELS / MAX_PNG_BYTES, mirrored here
// because the bridge runs outside app.asar; a test keeps them equal). Tiles
// are scaled down to fit, never up. Decoding and encoding use pngjs, which
// LunaCore already ships (asarUnpack'ed so the bridge can load it).
// ============================================================================

'use strict';

const { PNG } = require('pngjs');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Mirrors of src/lunasworkPlaytest.js MAX_PNG_PIXELS and MAX_PNG_BYTES. Never raise them here.
const MAX_SHEET_PIXELS = 8 * 1000 * 1000;
const MAX_SHEET_BYTES = 25 * 1024 * 1024;
// A captured frame is decoded only up to the largest window resize_window allows.
const MAX_FRAME_PIXELS = 7680 * 4320;
// Signature (8) + IHDR length/type (8) + width (4) + height (4).
const PNG_HEADER_BYTES = 24;
const MAX_TILE_SIDE = 640;
const MAX_COLUMNS = 4;
const GAP_PX = 4;
const LABEL_PAD_PX = 3;
// Tiles at least this wide get the 2x label font.
const BIG_FONT_MIN_TILE_PX = 160;
const SHRINK_MARGIN = 0.98;
const MAX_NOTE_CHARS = 300;
// A burst stops capturing this long after its planned end (a hung app would
// otherwise cost every frame its full call timeout); the rest are skipped.
const MAX_OVERRUN_MS = 10 * 1000;
const SKIPPED_NOTE = 'skipped: the burst ran past its time budget';

const BACKGROUND = [24, 24, 24];
const LABEL_COLOR = [255, 255, 255];
const FAILED_TILE = [60, 18, 18];
const FAILED_MARK = [220, 60, 60];

/** One-line caption the Playtester and the Critic get with every sheet. */
const BURST_CAPTION = 'Time sequence, not one moment: frames of one short burst, read left to right then top to bottom, each tile labeled #frame and +ms from the start of the burst.';

// 5x7 bitmap glyphs for the tile labels ('#' = lit pixel).
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPHS = {
  0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  3: ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  4: ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  6: ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  9: [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  '#': [' # # ', ' # # ', '#####', ' # # ', '#####', ' # # ', ' # # '],
  m: ['     ', '     ', '## # ', '# # #', '# # #', '#   #', '#   #'],
  s: ['     ', '     ', ' ####', '#    ', ' ### ', '    #', '#### '],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);

const isPng = (buf) => Buffer.isBuffer(buf) && buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);

/** The PNG bytes of one screenshot result ({png:<base64>}), checked by magic and header size. */
function framePng(result) {
  const buf = Buffer.from(String(isObj(result) && result.png ? result.png : ''), 'base64');
  if (!isPng(buf)) throw new Error('the app did not return a PNG image');
  if (buf.length < PNG_HEADER_BYTES) throw new Error('the PNG image is truncated');
  if (buf.readUInt32BE(16) * buf.readUInt32BE(20) > MAX_FRAME_PIXELS) throw new Error('the frame is larger than any window');
  return buf;
}

// ---- capture ------------------------------------------------------------------------

/**
 * Captures `frames` screenshots at even intervals across `durationMs` (the
 * first at 0, the last at durationMs). A capture that runs late starts the
 * next one at once; past durationMs + MAX_OVERRUN_MS the remaining frames
 * are skipped. Each frame records when its capture really started.
 * @param {{capture:()=>Promise<unknown>, frames:number, durationMs:number,
 *   now:()=>number, sleep:(ms:number)=>Promise<unknown>}} opts
 * @returns {Promise<Array<{index:number, atMs:number, png?:Buffer, error?:string}>>}
 */
async function captureBurst({ capture, frames, durationMs, now, sleep }) {
  const stepMs = frames > 1 ? durationMs / (frames - 1) : 0;
  const start = now();
  const deadline = start + durationMs + MAX_OVERRUN_MS;
  const shots = [];
  for (let index = 0; index < frames; index += 1) {
    const waitMs = start + Math.round(index * stepMs) - now();
    if (waitMs > 0) await sleep(waitMs);
    const atMs = Math.max(0, Math.round(now() - start));
    if (now() > deadline) {
      shots.push({ index, atMs, error: SKIPPED_NOTE });
      continue;
    }
    try {
      shots.push({ index, atMs, png: framePng(await capture()) });
    } catch (err) {
      shots.push({ index, atMs, error: oneLine(errText(err)) || 'capture failed' });
    }
  }
  return shots;
}

// ---- layout -------------------------------------------------------------------------

/**
 * Grid geometry for `count` tiles of frames sized frameW x frameH: tiles at
 * most MAX_TILE_SIDE, never upscaled, shrunk until the sheet fits maxPixels.
 * @returns {{cols:number, rows:number, tileW:number, tileH:number, labelH:number,
 *   fontScale:number, width:number, height:number}}
 */
function sheetLayout({ frameW, frameH, count, maxPixels = MAX_SHEET_PIXELS }) {
  const cols = Math.min(MAX_COLUMNS, count);
  const rows = Math.ceil(count / cols);
  const measure = (scale) => {
    const tileW = Math.max(1, Math.round(frameW * scale));
    const tileH = Math.max(1, Math.round(frameH * scale));
    const fontScale = tileW >= BIG_FONT_MIN_TILE_PX ? 2 : 1;
    const labelH = GLYPH_H * fontScale + 2 * LABEL_PAD_PX;
    const width = cols * tileW + (cols + 1) * GAP_PX;
    const height = rows * (labelH + tileH) + (rows + 1) * GAP_PX;
    return { cols, rows, tileW, tileH, labelH, fontScale, width, height };
  };
  let scale = Math.min(1, MAX_TILE_SIDE / frameW, MAX_TILE_SIDE / frameH);
  let layout = measure(scale);
  while (layout.width * layout.height > maxPixels && (layout.tileW > 1 || layout.tileH > 1)) {
    scale *= Math.sqrt(maxPixels / (layout.width * layout.height)) * SHRINK_MARGIN;
    layout = measure(scale);
  }
  if (layout.width * layout.height > maxPixels) throw new Error('the burst does not fit the sheet size cap');
  return layout;
}

// ---- drawing ------------------------------------------------------------------------

/** An RGBA canvas filled with one colour. */
function canvas(width, height, rgb) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Fills a rectangle, clipped to the canvas. */
function fillRect(dst, x0, y0, w, h, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(dst.height, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(dst.width, x0 + w); x += 1) {
      const o = (y * dst.width + x) * 4;
      dst.data[o] = rgb[0];
      dst.data[o + 1] = rgb[1];
      dst.data[o + 2] = rgb[2];
      dst.data[o + 3] = 255;
    }
  }
}

/**
 * Writes the average colour of one source block (composited over black,
 * opaque out) into dst at byte offset `o`.
 */
function averageInto(dst, o, src, sx0, sx1, sy0, sy1) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let sy = sy0; sy < sy1; sy += 1) {
    for (let s = (sy * src.width + sx0) * 4, end = (sy * src.width + sx1) * 4; s < end; s += 4) {
      const a = src.data[s + 3] / 255;
      r += src.data[s] * a;
      g += src.data[s + 1] * a;
      b += src.data[s + 2] * a;
    }
  }
  const n = (sx1 - sx0) * (sy1 - sy0);
  dst.data[o] = Math.round(r / n);
  dst.data[o + 1] = Math.round(g / n);
  dst.data[o + 2] = Math.round(b / n);
  dst.data[o + 3] = 255;
}

/** Draws `src` scaled down to w x h at (x0, y0) by area averaging; the target must lie inside dst. */
function drawScaled(dst, src, x0, y0, w, h) {
  for (let y = 0; y < h; y += 1) {
    const sy0 = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x += 1) {
      const sx0 = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / w));
      averageInto(dst, ((y0 + y) * dst.width + x0 + x) * 4, src, sx0, sx1, sy0, sy1);
    }
  }
}

/** Draws `text` with the 5x7 font, clipped to maxW pixels. Unknown characters leave a gap. */
function drawText(dst, text, x0, y0, fontScale, maxW) {
  const advance = (GLYPH_W + 1) * fontScale;
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    const gx = x0 + i * advance;
    if (!glyph || gx + GLYPH_W * fontScale > x0 + maxW) return;
    glyph.forEach((row, gy) => {
      [...row].forEach((cell, cx) => {
        if (cell === '#') fillRect(dst, gx + cx * fontScale, y0 + gy * fontScale, fontScale, fontScale, LABEL_COLOR);
      });
    });
  });
}

/** A failed frame: a dark tile crossed out corner to corner. */
function drawFailedTile(dst, x0, y0, w, h) {
  fillRect(dst, x0, y0, w, h, FAILED_TILE);
  const steps = Math.max(w, h);
  for (let i = 0; i < steps; i += 1) {
    const x = Math.round((i * (w - 1)) / Math.max(1, steps - 1));
    const y = Math.round((i * (h - 1)) / Math.max(1, steps - 1));
    fillRect(dst, x0 + x - 1, y0 + y - 1, 3, 3, FAILED_MARK);
    fillRect(dst, x0 + (w - 1 - x) - 1, y0 + y - 1, 3, 3, FAILED_MARK);
  }
}

const tileLabel = (shot, failed) => `#${shot.index + 1} +${shot.atMs}ms${failed ? ' FAIL' : ''}`;

// ---- sheet --------------------------------------------------------------------------

/** Decodes one captured frame; a frame pngjs cannot read becomes a failed one. */
function decodeShot(shot) {
  if (!shot.png) return { index: shot.index, atMs: shot.atMs, error: shot.error };
  try {
    return { index: shot.index, atMs: shot.atMs, image: PNG.sync.read(shot.png) };
  } catch (err) {
    return { index: shot.index, atMs: shot.atMs, error: oneLine(`unreadable PNG: ${errText(err)}`) };
  }
}

function paintTile(sheet, shot, layout, slot) {
  const col = slot % layout.cols;
  const row = Math.floor(slot / layout.cols);
  const x0 = GAP_PX + col * (layout.tileW + GAP_PX);
  const y0 = GAP_PX + row * (layout.labelH + layout.tileH + GAP_PX);
  drawText(sheet, tileLabel(shot, !shot.image), x0 + LABEL_PAD_PX, y0 + LABEL_PAD_PX, layout.fontScale, layout.tileW - LABEL_PAD_PX);
  const ty = y0 + layout.labelH;
  if (!shot.image) {
    drawFailedTile(sheet, x0, ty, layout.tileW, layout.tileH);
    return;
  }
  // Letterbox a frame whose size differs from the first one (a resized window); never upscale.
  const fit = Math.min(1, layout.tileW / shot.image.width, layout.tileH / shot.image.height);
  const w = Math.max(1, Math.round(shot.image.width * fit));
  const h = Math.max(1, Math.round(shot.image.height * fit));
  drawScaled(sheet, shot.image, x0 + Math.floor((layout.tileW - w) / 2), ty + Math.floor((layout.tileH - h) / 2), w, h);
}

/**
 * Stitches captured frames into one labeled contact-sheet PNG.
 * @param {Array<{index:number, atMs:number, png?:Buffer, error?:string}>} shots captureBurst()
 * @param {{maxPixels?:number, maxBytes?:number}} [caps] tests only; default the evidence caps
 * @returns {{png:Buffer, width:number, height:number,
 *   frames:Array<{index:number, atMs:number, ok:boolean, error?:string}>}}
 * @throws when no frame was captured, or the sheet breaks a cap or is not a PNG
 */
function buildSheet(shots, { maxPixels = MAX_SHEET_PIXELS, maxBytes = MAX_SHEET_BYTES } = {}) {
  const noFrame = (why) => new Error(`no frame of the burst could be captured${why ? `: ${why}` : ''}`);
  const first = shots.find((s) => s.png);
  if (!first) throw noFrame((shots.find((s) => s.error) || {}).error);
  // The grid is sized from the first frame's header (framePng checked it), so
  // each frame is decoded, painted and dropped in turn: one decoded frame in memory.
  const layout = sheetLayout({ frameW: first.png.readUInt32BE(16), frameH: first.png.readUInt32BE(20), count: shots.length, maxPixels });
  const sheet = canvas(layout.width, layout.height, BACKGROUND);
  const frames = shots.map((raw, slot) => {
    const shot = decodeShot(raw);
    paintTile(sheet, shot, layout, slot);
    return shot.image
      ? { index: shot.index, atMs: shot.atMs, ok: true }
      : { index: shot.index, atMs: shot.atMs, ok: false, error: shot.error };
  });
  if (!frames.some((f) => f.ok)) throw noFrame(frames[0].error);

  const out = new PNG({ width: sheet.width, height: sheet.height });
  sheet.data.copy(out.data);
  const png = PNG.sync.write(out);
  if (!isPng(png)) throw new Error('the contact sheet is not a PNG');
  if (png.length > maxBytes) throw new Error('the contact sheet is larger than the evidence size cap');
  return { png, width: sheet.width, height: sheet.height, frames };
}

/** The text the Playtester gets with the sheet: caption, frame times, a note per failed frame. */
function burstSummary(name, sheet, durationMs) {
  const ok = sheet.frames.filter((f) => f.ok).length;
  const lines = [
    `Saved burst "${name}" (${sheet.width}x${sheet.height}): ${ok} of ${sheet.frames.length} frames over ${durationMs} ms. Cite exactly this file name as evidence.`,
    BURST_CAPTION,
    `Frame start times (ms from the start of the burst): ${sheet.frames.map((f) => f.atMs).join(', ')}.`,
    ...sheet.frames.filter((f) => !f.ok).map((f) => `Note: frame #${f.index + 1} (+${f.atMs}ms) failed and is crossed out: ${f.error}`),
  ];
  return lines.join('\n');
}

module.exports = {
  BURST_CAPTION,
  MAX_SHEET_PIXELS,
  MAX_SHEET_BYTES,
  MAX_TILE_SIDE,
  captureBurst,
  sheetLayout,
  buildSheet,
  burstSummary,
};
