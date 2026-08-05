// ============================================================================
// LunaCore - icon generator (D2)
// ----------------------------------------------------------------------------
// Renders the LUNA / CORE wordmark into assets/icon-*.png using the 04b_30 pixel
// font. Run by hand, not part of any build:
//
//   npx electron scripts/make-icon.js "C:\path\to\04B_30__.TTF"
//
// Why Electron rather than an image library: it is already a devDependency, so
// this needs no new packages, and Chromium renders the font correctly with no
// glyph-metric guesswork on our side.
//
// The font is only RASTERIZED here - the .ttf is never copied into the repo or
// into the shipped app, so nothing about the release redistributes it.
//
// Crispness is the whole trick. Drawing text at 512px would antialias the pixel
// font into mush, so it is drawn into a SMALL canvas at its native scale and
// then blown up 8x with imageSmoothingEnabled = false. That upscale is what
// keeps the pixels square.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TTF = process.argv[2];
const OUT_DIR = path.join(__dirname, '..', 'assets');
const SMALL = 64; // native pixel grid
const SCALE = 8; // 64 * 8 = 512, the size electron-builder wants

// Mati asked for "yellow or green" - both get generated so the choice can be
// made by looking rather than by imagining.
const VARIANTS = [
  { name: 'icon-green.png', fg: '#39ff14', glow: 'rgba(57,255,20,0.55)' },
  { name: 'icon-yellow.png', fg: '#ffd028', glow: 'rgba(255,208,40,0.55)' },
];

const BG = '#0a0710'; // --bg from the cyberpunk theme

/**
 * Page that does the drawing; returns one data URL per variant.
 *
 * `ttfName` is a bare filename, and the page is written next to the font and
 * loaded with loadFile() so both share a file:// origin. The first attempt used
 * a data: URL, which has an OPAQUE origin - Chromium then refuses to fetch the
 * file:// font, document.fonts.load() rejects, and the script hung forever.
 */
function pageHtml(ttfName) {
  return `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: 'Pixel'; src: url('${ttfName}') format('truetype'); }
  html,body { margin:0; background:#000; }
</style>
<body><script>
window.__render = async function (variants, SMALL, SCALE, BG) {
  await document.fonts.load('16px Pixel');
  await document.fonts.ready;

  // Fail loudly. A font that quietly fails to load falls back to a smooth
  // system face, and the icon would come out looking intentional - wrong, but
  // not obviously wrong. Same lesson as the probe that could not fail.
  if (!document.fonts.check('16px Pixel')) throw new Error('04b_30 did not load');

  const out = {};
  for (const v of variants) {
    const s = document.createElement('canvas');
    s.width = s.height = SMALL;
    const c = s.getContext('2d');

    // Rounded-square plate. Drawn on the SMALL canvas on purpose: the corner
    // steps end up pixelated by the upscale, which is the look we want.
    c.fillStyle = BG;
    const r = 10;
    c.beginPath();
    c.moveTo(r, 0);
    c.arcTo(SMALL, 0, SMALL, SMALL, r);
    c.arcTo(SMALL, SMALL, 0, SMALL, r);
    c.arcTo(0, SMALL, 0, 0, r);
    c.arcTo(0, 0, SMALL, 0, r);
    c.closePath();
    c.fill();

    // Auto-fit: grow the font until the WIDER word fills the target width.
    // Avoids hardcoding metrics for a font we have never measured.
    const target = SMALL - 12;
    let size = 4;
    for (let t = 4; t <= 40; t++) {
      c.font = t + 'px Pixel';
      const w = Math.max(c.measureText('LUNA').width, c.measureText('CORE').width);
      if (w <= target) size = t; else break;
    }

    c.font = size + 'px Pixel';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = v.fg;
    c.shadowColor = v.glow;
    c.shadowBlur = 3;

    const gap = Math.round(size * 1.15);
    c.fillText('LUNA', SMALL / 2, SMALL / 2 - gap / 2);
    c.fillText('CORE', SMALL / 2, SMALL / 2 + gap / 2);

    // Upscale with smoothing OFF - this is what preserves square pixels.
    const big = document.createElement('canvas');
    big.width = big.height = SMALL * SCALE;
    const b = big.getContext('2d');
    b.imageSmoothingEnabled = false;
    b.drawImage(s, 0, 0, big.width, big.height);

    out[v.name] = big.toDataURL('image/png');
  }
  return out;
};
</script></body>`;
}

async function main() {
  if (!TTF || !fs.existsSync(TTF)) {
    console.error('usage: npx electron scripts/make-icon.js <path-to-04B_30__.TTF>');
    app.exit(1);
    return;
  }

  // The page must sit beside the font so both share a file:// origin.
  const htmlPath = path.join(path.dirname(TTF), '__make-icon.html');
  fs.writeFileSync(htmlPath, pageHtml(path.basename(TTF)), 'utf8');

  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  try {
    await win.loadFile(htmlPath);

    const result = await win.webContents.executeJavaScript(
      `window.__render(${JSON.stringify(VARIANTS)}, ${SMALL}, ${SCALE}, ${JSON.stringify(BG)})`,
      true
    );

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, dataUrl] of Object.entries(result)) {
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      console.log('wrote', path.join('assets', name), buf.length, 'bytes');
    }
  } catch (err) {
    console.error('FAILED', err && err.message ? err.message : err);
  } finally {
    // Always quit. The first version let a rejection escape and the hidden
    // window kept the process alive with no output and no exit.
    try {
      fs.unlinkSync(htmlPath);
    } catch {
      /* best effort */
    }
    app.quit();
  }
}

app.whenReady().then(main);
