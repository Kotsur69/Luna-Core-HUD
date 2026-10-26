// ============================================================================
// LunaCore - Luna's Work milestone mail (LW 2.18)
// ----------------------------------------------------------------------------
// Sending and dedupe for the milestone email (lunasworkReport builds it):
//
//   - EXACTLY ONE email per passed milestone gate, never per iteration. The
//     controller only calls in when a gate passes and marks the gate in
//     run.gatesMailed (kept across restarts); this mailer dedupes again per
//     run + milestone in memory, so a double call sends nothing
//   - the key screenshots of that milestone go along inline (gmailsend
//     image/png, image/jpeg parts), size-capped: at most MAX_IMAGES, each at
//     most MAX_IMAGE_BYTES, all together at most MAX_TOTAL_BYTES. Only files
//     inside the evidence folder of the lap that took them (or the run's) are
//     read, only real PNG / JPEG bytes are sent; anything else is skipped
//   - LW 2.25a: a design-variant choice still open goes first, one image per
//     variant (lunasworkVariants.pendingShots), so Mati can pick from the mail
//
// screenshotAttachments() is shared with the run email's screen tour.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { keyScreens } = require('./lunasworkRun');
const { pendingShots } = require('./lunasworkVariants');

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;
const MAX_TOTAL_BYTES = 1536 * 1024;
const MAX_MILESTONE_KEYS = 200;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** The image type from the file's first bytes, or null. */
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Default reader: a plain file of at most `max` bytes, else null. */
function readImageFile(file, max) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

const insideDir = (dir, file) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Inline screenshot attachments: `first` (LW 2.25a: the variant shots), then
 * one per key screen of `laps`, capped.
 * @param {object} run the run (its evidenceDir bounds what is read)
 * @param {{laps?:object[], max?:number, readImage?:(file:string, max:number)=>Buffer|null,
 *   first?:{name:string, screenshot:string, n:number}[]}} [opts]
 * @returns {{filename:string, mimeType:string, content:Buffer, name:string, n:number}[]}
 */
function screenshotAttachments(run, opts = {}) {
  const r = isObj(run) ? run : {};
  const laps = (Array.isArray(opts.laps) ? opts.laps : Array.isArray(r.laps) ? r.laps : []).filter(isObj);
  // The evidence folder is per iteration: a shot is read from its own lap's folder (or the run's) only.
  // Every lap of the run names its folder: a variant shot may come from a lap before this milestone's.
  const folders = new Map([...(Array.isArray(r.laps) ? r.laps : []), ...laps].filter(isObj).map((l) => [l.n, l.evidenceDir]));
  const allowed = (shot) => [folders.get(shot.n), r.evidenceDir]
    .some((dir) => typeof dir === 'string' && path.isAbsolute(dir) && insideDir(dir, shot.screenshot));
  const read = typeof opts.readImage === 'function' ? opts.readImage : readImageFile;
  const max = Number.isInteger(opts.max) && opts.max >= 0 ? Math.min(opts.max, MAX_IMAGES) : MAX_IMAGES;
  const out = [];
  let total = 0;
  const first = Array.isArray(opts.first) ? opts.first.filter((s) => isObj(s) && typeof s.screenshot === 'string' && typeof s.name === 'string') : [];
  for (const shot of [...first, ...keyScreens(laps)]) {
    if (out.length >= max) break;
    if (!allowed(shot)) continue;
    const content = read(shot.screenshot, MAX_IMAGE_BYTES);
    const mimeType = imageType(content);
    if (!mimeType || content.length > MAX_IMAGE_BYTES || total + content.length > MAX_TOTAL_BYTES) continue;
    total += content.length;
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    out.push({ filename: `${shot.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'screen'}.${ext}`, mimeType, content, name: shot.name, n: shot.n });
  }
  return out;
}

/** The laps of the milestone just reached; the newest lap when none is named for it. */
function milestoneLaps(run, milestone) {
  const laps = (Array.isArray(run.laps) ? run.laps : []).filter(isObj);
  const named = laps.filter((l) => l.milestone === milestone);
  return named.length ? named : laps.slice(-1);
}

/**
 * @param {{mail?:{sender:{status:Function, send:Function}, prefs:{loadPrefs:Function}, enabled:Function},
 *   build:(run:object, ctx:object)=>{subject:string, text:string}, readImage?:Function, log?:(line:string)=>void}} deps
 *   build: lunasworkReport.buildMilestoneEmail (injected: the report module loads this one)
 */
function createMilestoneMailer(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const sent = new Set();

  /**
   * One milestone email, with the milestone's key screenshots inline.
   * @returns {Promise<{sent:boolean, images?:number, skipped?:string, error?:string}>} never rejects
   */
  async function send(run, ctx) {
    const m = deps.mail;
    if (!isObj(run) || typeof run.id !== 'string' || !FILE_ID_RE.test(run.id)) return { sent: false, skipped: 'bad-run' };
    if (!m) return { sent: false, skipped: 'no-mailer' };
    const milestone = oneLine(ctx && ctx.milestone, 80);
    const key = `${run.id}|${milestone}`;
    if (sent.has(key)) return { sent: false, skipped: 'duplicate' };
    try {
      const st = m.sender.status();
      const prefs = m.prefs.loadPrefs();
      if (!st.connected && prefs.godmodeEmail !== false) return { sent: false, skipped: 'not-connected' };
      if (!m.enabled(prefs, st.connected)) return { sent: false, skipped: 'off' };
      sent.add(key);
      if (sent.size > MAX_MILESTONE_KEYS) sent.delete(sent.values().next().value);
      const images = screenshotAttachments(run, {
        laps: milestoneLaps(run, ctx && ctx.milestone), readImage: deps.readImage, first: pendingShots(run.variants),
      });
      const email = deps.build(run, { ...ctx, screenshots: images.map((i) => ({ name: i.name, n: i.n, filename: i.filename })) });
      const attachments = images.map(({ filename, mimeType, content }) => ({ filename, mimeType, content }));
      await m.sender.send({ subject: email.subject, text: email.text, ...(attachments.length ? { attachments } : {}) });
      return { sent: true, images: attachments.length };
    } catch (err) {
      const reason = (err && err.reason) || 'gmail-failed';
      log(`[lunaswork] milestone email failed: ${reason} ${errText(err)}`);
      return { sent: false, error: reason };
    }
  }

  return { send };
}

module.exports = { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, imageType, screenshotAttachments, createMilestoneMailer };
