// ============================================================================
// LunaCore - Luna's Work client feedback widget (docs/LUNAS_WORK_PLAN.md B17, LW 3.28b)
// ----------------------------------------------------------------------------
// For web apps with a staging profile: a small script on the STAGING build
// lets a client send feedback without a LunaCore account. A floating
// "Feedback" button opens a text box (pl / en), with an optional screenshot
// of the current view and the page URL (origin + path only).
//
//   bake      prepare(run) runs inside the staging deploy step only
//             (src/lunasworkStaging.js) and only when widgetGuard() passes:
//             a staging profile with a deploy command, a stagingUrl that is
//             no production host, and a deploy command touchesProduction()
//             finds nothing in. It writes the per-run script OUTSIDE the
//             repo (<runs>/lunaswork-<id>/widget/lunaswork-feedback.js) and
//             hands the deploy command its path as $LUNA_FEEDBACK_WIDGET; the
//             staging build includes that file. No other step, and no
//             production deploy (LunaCore runs none), ever gets it, and it
//             can never be committed, so it can never reach production.
//   token     per run, random (256 bits), revocable. Supabase keeps only its
//             SHA-256 hash with the staging origin and an expiry
//             (lunaswork_widget_tokens); the token itself lives in the run's
//             widget.json and in the staging build. Expiry is extended while
//             the run deploys, so a dead LunaCore cannot leave it open long.
//   endpoint  supabase/functions/lunaswork-feedback checks the token, the
//             caps, the content type and the rate limit, and stores the item.
//   intake    deliver(controller) pulls the run's rows (the owner's session,
//             RLS), saves a screenshot under the run folder, and hands each
//             item to the controller's feedback() as author `client`: look /
//             bug parts become cards, a scope change waits for Mati in the
//             decision queue with no default (lunasworkFeedback trust rules).
//             Each row is deleted once taken.
//   revoke    revoke(runId) when the run ends (src/lunaswork.js, run-end
//             hook): revoked locally first (no new bake), then in Supabase,
//             and the run's untaken rows are deleted. A failed remote revoke
//             is retried by the next poll of a finished run.
//
// The widget never renders anything as HTML: every string goes in with
// textContent. The feedback text is shown as text on every LunaCore surface.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { isStaging, touchesProduction } = require('./lunasworkStaging');
const { withContext } = require('./lunasworkFeedback');

// Kept in step with supabase/functions/lunaswork-feedback/core.mjs.
const MAX_TEXT = 800;
const MAX_URL = 500;
const MAX_SHOT_CHARS = 700000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_RE = /^[a-z0-9]{1,40}$/;

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHOT_WIDTH = 1280;
const FUNCTION_NAME = 'lunaswork-feedback';
const ENV_KEY = 'LUNA_FEEDBACK_WIDGET';
const STATE_FILE = 'widget.json';
const WIDGET_DIR = 'widget';
const WIDGET_FILE = 'lunaswork-feedback.js';
const SHOTS_DIR = 'client-feedback';
const TOKENS_TABLE = 'lunaswork_widget_tokens';
const FEEDBACK_TABLE = 'lunaswork_client_feedback';
const PULL_LIMIT = 20;
const MAX_SEEN = 500;
// A row whose created_at ms is taken by another item moves on by up to this many ms.
const MAX_ID_BUMPS = 5;
const POLL_MS = 2 * 60 * 1000;

const SHOT_RE = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = 200) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- widget UI strings ---------------------------------------------------------------

const TEXT = Object.freeze({
  en: {
    button: 'Feedback',
    title: 'Send feedback',
    note: 'Test version - your message goes straight to the team.',
    placeholder: 'What should change? What does not work?',
    screenshot: 'Attach a screenshot of this view',
    send: 'Send',
    close: 'Close',
    sending: 'Sending...',
    sent: 'Thank you - sent.',
    sentNoShot: 'Sent, without a screenshot.',
    empty: 'Write a few words first.',
    tooMany: 'Too many messages - please try again later.',
    failed: 'Could not send. Please try again later.',
  },
  pl: {
    button: 'Opinia',
    title: 'Wyślij opinię',
    note: 'Wersja testowa - wiadomość trafi prosto do zespołu.',
    placeholder: 'Co zmienić? Co nie działa?',
    screenshot: 'Dołącz zrzut ekranu tego widoku',
    send: 'Wyślij',
    close: 'Zamknij',
    sending: 'Wysyłanie...',
    sent: 'Dziękujemy - wysłane.',
    sentNoShot: 'Wysłane, bez zrzutu ekranu.',
    empty: 'Najpierw napisz kilka słów.',
    tooMany: 'Za dużo wiadomości - spróbuj później.',
    failed: 'Nie udało się wysłać. Spróbuj później.',
  },
});

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const CSS = [
  ':host{all:initial}',
  `.fab{position:fixed;right:16px;bottom:16px;z-index:2147483646;min-height:44px;padding:12px 18px;border:0;border-radius:999px;background:#1f2937;color:#fff;font:600 14px/1 ${FONT};box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}`,
  `.panel{position:fixed;right:16px;bottom:72px;z-index:2147483647;box-sizing:border-box;width:min(360px,calc(100vw - 32px));padding:16px;border-radius:12px;background:#fff;color:#111827;font:14px/1.45 ${FONT};box-shadow:0 10px 30px rgba(0,0,0,.25)}`,
  '.panel[hidden]{display:none}',
  '.title{margin:0 0 4px;font-size:15px;font-weight:600}',
  '.note{margin:0 0 10px;font-size:12px;color:#4b5563}',
  'textarea{box-sizing:border-box;width:100%;min-height:96px;padding:8px;border:1px solid #9ca3af;border-radius:8px;background:transparent;color:inherit;font:inherit;resize:vertical}',
  '.shot{display:flex;gap:8px;align-items:center;min-height:32px;margin:8px 0;font-size:13px;cursor:pointer}',
  '.status{min-height:18px;margin:0 0 8px;font-size:13px}',
  '.actions{display:flex;gap:8px;justify-content:flex-end}',
  `.actions button{min-height:40px;padding:8px 14px;border-radius:8px;font:600 13px ${FONT};cursor:pointer}`,
  '.ghost{border:1px solid #9ca3af;background:transparent;color:inherit}',
  '.send{border:0;background:#1d4ed8;color:#fff}',
  '.send:disabled{opacity:.6;cursor:progress}',
  'button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid #2563eb;outline-offset:2px}',
  '@media (prefers-color-scheme:dark){.panel{background:#111827;color:#f9fafb}.note{color:#d1d5db}textarea,.ghost{border-color:#6b7280}}',
].join('\n');

// ---- the widget (runs in the client's browser) -----------------------------------------

/* eslint-disable no-undef */
/**
 * The widget itself. Serialized with toString() into the staging script, so
 * it must not reach anything outside its own body: everything comes in `cfg`.
 * No framework, no innerHTML - every string goes in as text.
 * @param {{endpoint:string, token:string, runId:string, origin:string, maxText:number, maxShot:number,
 *   shotWidth:number, text:object, css:string}} cfg
 */
function widgetMain(cfg) {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__lunaFeedbackWidget) return;
  // Pinned to the staging origin: a copy that leaked into another build stays inert.
  if (location.origin !== cfg.origin) return;
  window.__lunaFeedbackWidget = true;
  const lang = String(document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('pl') === 0 ? 'pl' : 'en';
  const t = cfg.text[lang] || cfg.text.en;
  const make = (tag, attrs, text) => {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, attrs[k]));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const host = make('div', { 'data-luna-feedback': '' });
  if (!host.attachShadow) return;
  // Closed shadow root: the page's CSS and scripts do not reach the widget's inside.
  const root = host.attachShadow({ mode: 'closed' });
  const style = make('style', {}, cfg.css);
  const button = make('button', { type: 'button', class: 'fab', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, t.button);
  const panel = make('form', { class: 'panel', role: 'dialog', 'aria-label': t.title, hidden: '' });
  const area = make('textarea', { maxlength: String(cfg.maxText), rows: '5', 'aria-label': t.title, placeholder: t.placeholder });
  const shotBox = make('input', { type: 'checkbox' });
  const shotLabel = make('label', { class: 'shot' });
  shotLabel.append(shotBox, document.createTextNode(t.screenshot));
  const status = make('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const close = make('button', { type: 'button', class: 'ghost' }, t.close);
  const send = make('button', { type: 'submit', class: 'send' }, t.send);
  const actions = make('div', { class: 'actions' });
  actions.append(close, send);
  panel.append(make('p', { class: 'title' }, t.title), make('p', { class: 'note' }, t.note), area, shotLabel, status, actions);
  root.append(style, button, panel);

  const toggle = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) area.focus();
  };
  button.addEventListener('click', () => toggle(panel.hidden));
  close.addEventListener('click', () => toggle(false));
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggle(false);
    button.focus();
  });

  /** One frame of the current tab (the browser asks the client first), as a capped JPEG data URL, or null. */
  async function capture() {
    const media = navigator.mediaDevices;
    if (!media || typeof media.getDisplayMedia !== 'function') return null;
    let stream = null;
    host.style.display = 'none';
    try {
      stream = await media.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true });
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => requestAnimationFrame(() => r()));
      const scale = Math.min(1, cfg.shotWidth / (video.videoWidth || cfg.shotWidth));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      for (let q = 0.7; q >= 0.3; q -= 0.2) {
        const url = canvas.toDataURL('image/jpeg', q);
        if (url.length <= cfg.maxShot) return url;
      }
      return null;
    } catch (err) {
      return null;
    } finally {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      host.style.display = '';
    }
  }

  let busy = false;
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = area.value.trim().slice(0, cfg.maxText);
    if (!text) {
      status.textContent = t.empty;
      return;
    }
    busy = true;
    send.disabled = true;
    status.textContent = t.sending;
    try {
      const screenshot = shotBox.checked ? await capture() : null;
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        // origin + path only: a query or hash can hold a session.
        body: JSON.stringify({ token: cfg.token, runId: cfg.runId, text, url: location.origin + location.pathname, screenshot }),
      });
      if (res.ok) {
        status.textContent = shotBox.checked && !screenshot ? t.sentNoShot : t.sent;
        area.value = '';
        shotBox.checked = false;
      } else {
        status.textContent = res.status === 429 ? t.tooMany : t.failed;
      }
    } catch (err) {
      status.textContent = t.failed;
    } finally {
      busy = false;
      send.disabled = false;
    }
  });

  const mount = () => document.body.appendChild(host);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
}
/* eslint-enable no-undef */

// ---- the staging guard + the script (pure) --------------------------------------------

const PROD_LABELS = new Set(['prod', 'production']);

/** origin of an http(s) URL, or null. */
function originOf(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The function URL the widget posts to: https only. */
function validEndpoint(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Whether the widget may go into this build, or why not (the build/inject
 * guard). Only a staging deploy qualifies: a staging profile with a deploy
 * command, a stagingUrl whose host is no production one, and a deploy that
 * the staging production guard (touchesProduction) finds nothing in.
 * @param {object|null} profile the run's pinned profile
 * @returns {string|null} null = allowed
 */
function widgetGuard(profile) {
  if (!isStaging(profile)) return 'no staging in the profile';
  if (typeof profile.stagingDeployCommand !== 'string' || !profile.stagingDeployCommand.trim()) return 'no staging deploy command';
  const origin = originOf(profile.stagingUrl);
  if (!origin) return 'the stagingUrl is not an http(s) URL';
  if (new URL(origin).hostname.split(/[.-]/).some((label) => PROD_LABELS.has(label))) return 'the stagingUrl looks like production';
  const lines = [profile.stagingUrl, ...profile.stagingDeployCommand.split(/\r?\n/)].map((l) => `+${l}`);
  // The deploy command checked against the OTHER staging targets: its own
  // hosts and refs must not vouch for themselves.
  const prod = touchesProduction(['diff --git a/lunaswork-profile b/lunaswork-profile', '@@ -0,0 +1 @@', ...lines].join('\n'), { ...profile, stagingDeployCommand: '' });
  return prod ? `the staging deploy ${prod.reason}` : null;
}

// JSON that is safe inside a <script> and in any file encoding: no `<`, `>`, `&`, no non-ASCII.
const safeJson = (value) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]|[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The staging script: the widget and its config for one run.
 * @param {{endpoint:string, token:string, runId:string, origin:string}} cfg origin = the staging origin
 * @returns {string}
 */
function widgetScript({ endpoint, token, runId, origin }) {
  if (!validEndpoint(endpoint)) throw new Error('widget endpoint must be an https URL');
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('widget token is malformed');
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('runId must be 1-40 lowercase letters or digits');
  if (typeof origin !== 'string' || originOf(origin) !== origin) throw new Error('widget origin must be an http(s) origin');
  const cfg = { endpoint, token, runId, origin, maxText: MAX_TEXT, maxShot: MAX_SHOT_CHARS, shotWidth: SHOT_WIDTH, text: TEXT, css: CSS };
  return [
    "/* LunaCore Luna's Work client feedback widget. STAGING builds only - generated per run, never commit it. */",
    `(${widgetMain.toString()})(${safeJson(cfg)});`,
    '',
  ].join('\n');
}

/** A new widget token: 32 random bytes, base64url (43 characters). */
const newToken = (randomBytes = crypto.randomBytes) => randomBytes(TOKEN_BYTES).toString('base64url');

/** The hash Supabase keeps (same as core.mjs tokenHash). */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ---- disk -------------------------------------------------------------------------------

function runDirFor(runsRoot, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('runId must be 1-40 lowercase letters or digits');
  const root = path.resolve(runsRoot);
  const dir = path.resolve(root, `lunaswork-${runId}`);
  if (!dir.startsWith(root + path.sep)) throw new Error('run dir escapes the runs folder');
  return dir;
}

const isTime = (v) => Number.isSafeInteger(v) && v > 0;

/** The run's widget state; a missing or broken file reads as an empty one. */
function cleanState(raw) {
  const s = isObj(raw) ? raw : {};
  return {
    token: typeof s.token === 'string' && TOKEN_RE.test(s.token) ? s.token : null,
    origin: typeof s.origin === 'string' && originOf(s.origin) === s.origin ? s.origin : null,
    expiresAt: isTime(s.expiresAt) ? s.expiresAt : 0,
    revokedAt: isTime(s.revokedAt) ? s.revokedAt : null,
    remoteRevoked: s.remoteRevoked === true,
    seen: (Array.isArray(s.seen) ? s.seen : []).filter(isTime).slice(-MAX_SEEN),
  };
}

function readState(file) {
  try {
    return cleanState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return cleanState(null);
  }
}

// The token is a secret until it is deployed: owner-only where the OS has modes.
function writePrivate(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const writeState = (file, state) => writePrivate(file, JSON.stringify(cleanState(state), null, 2) + '\n');

/** A row the controller may take, or null. Untrusted: it came from the cloud. */
function cleanRow(raw, runId) {
  if (!isObj(raw) || !isTime(raw.id) || raw.run_id !== runId) return null;
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_TEXT) return null;
  const at = Date.parse(raw.created_at);
  const page = typeof raw.page_url === 'string' && raw.page_url.length <= MAX_URL && originOf(raw.page_url) ? raw.page_url : null;
  const shot = typeof raw.screenshot === 'string' && raw.screenshot.length <= MAX_SHOT_CHARS && SHOT_RE.test(raw.screenshot) ? raw.screenshot : null;
  return { id: raw.id, text: raw.text, page, shot, createdAt: isTime(at) ? at : null };
}

/** A screenshot data URL -> the file under the run folder, or null when it is no real image. */
function saveShot(runDir, rowId, dataUrl) {
  const m = SHOT_RE.exec(dataUrl);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (!MAGIC[m[1]].every((b, i) => bytes[i] === b)) return null;
  const file = path.join(runDir, SHOTS_DIR, `${rowId}.${m[1] === 'png' ? 'png' : 'jpg'}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}

const isInside = (dir, file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ---- Supabase (the owner's session) -----------------------------------------------------

/**
 * The widget's tables over the logged-in supabase-js client (RLS: own rows only).
 * @param {object} client supabase-js client
 */
function supabaseRegistry(client) {
  const must = ({ error }, what) => {
    if (error) throw new Error(`${what}: ${oneLine(error.message, 120)}`);
  };
  const iso = (ms) => new Date(ms).toISOString();
  return {
    async register({ runId, tokenHash, origin, expiresAt }) {
      must(await client.from(TOKENS_TABLE).insert({ run_id: runId, token_hash: tokenHash, origin, expires_at: iso(expiresAt) }), 'token not registered');
    },
    async extend({ tokenHash, expiresAt }) {
      must(await client.from(TOKENS_TABLE).update({ expires_at: iso(expiresAt) }).eq('token_hash', tokenHash).is('revoked_at', null), 'token not extended');
    },
    async revoke(runId, at) {
      must(await client.from(TOKENS_TABLE).update({ revoked_at: iso(at) }).eq('run_id', runId).is('revoked_at', null), 'token not revoked');
      must(await client.from(FEEDBACK_TABLE).delete().eq('run_id', runId), 'untaken feedback not deleted');
    },
    async pull(runId, limit) {
      const res = await client.from(FEEDBACK_TABLE).select('id,run_id,text,page_url,screenshot,created_at').eq('run_id', runId).order('id', { ascending: true }).limit(limit);
      must(res, 'client feedback not read');
      return Array.isArray(res.data) ? res.data : [];
    },
    async ack(ids) {
      if (ids.length) must(await client.from(FEEDBACK_TABLE).delete().in('id', ids), 'client feedback not deleted');
    },
  };
}

// ---- the lifecycle ----------------------------------------------------------------------

/**
 * @param {{registry?:()=>ReturnType<typeof supabaseRegistry>|null, endpoint?:()=>string|null,
 *   runsRoot?:()=>string, randomBytes?:(n:number)=>Buffer, now?:()=>number, log?:(line:string)=>void}} [deps]
 */
function createWidget(deps = {}) {
  const registry = deps.registry || (() => null);
  const endpoint = deps.endpoint || (() => null);
  const runsRoot = deps.runsRoot || (() => path.join(paths.userDir(), 'runs'));
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const stateFile = (runId) => path.join(runDirFor(runsRoot(), runId), STATE_FILE);

  /** The token for this run's build: a new one, or the saved one (its expiry extended at half-life). */
  async function tokenFor(run, reg, file) {
    const state = readState(file);
    const origin = originOf(run.profile.stagingUrl);
    const at = now();
    if (state.token && state.origin === origin && state.expiresAt > at) {
      if (state.expiresAt - at >= TOKEN_TTL_MS / 2) return state;
      const next = { ...state, expiresAt: at + TOKEN_TTL_MS };
      await reg.extend({ tokenHash: hashToken(state.token), expiresAt: next.expiresAt });
      writeState(file, next);
      return next;
    }
    // A token that was never saved is never baked anywhere: it is dead weight
    // until it expires, and revoke(runId) covers it too.
    const next = { ...state, token: newToken(randomBytes), origin, expiresAt: at + TOKEN_TTL_MS };
    await reg.register({ runId: run.id, tokenHash: hashToken(next.token), origin, expiresAt: next.expiresAt });
    if (!writeState(file, next)) throw new Error('widget state not saved');
    return next;
  }

  /**
   * The staging deploy step's widget: the guard, the run's token, the script
   * written outside the repo. Never throws.
   * @param {{id:string, repoPath:string, profile:object}} run
   * @returns {Promise<{ok:true, file:string, env:{LUNA_FEEDBACK_WIDGET:string}}|{ok:false, reason:string}>}
   */
  async function prepare(run) {
    try {
      if (!isObj(run) || typeof run.id !== 'string' || !RUN_ID_RE.test(run.id)) return { ok: false, reason: 'bad run' };
      const guard = widgetGuard(run.profile);
      if (guard) return { ok: false, reason: guard };
      const url = endpoint();
      const reg = registry();
      if (!url || !validEndpoint(url) || !reg) return { ok: false, reason: 'cloud sync is not logged in' };
      const file = stateFile(run.id);
      if (readState(file).revokedAt) return { ok: false, reason: 'the run ended - its token is revoked' };
      const script = path.join(path.dirname(file), WIDGET_DIR, WIDGET_FILE);
      if (typeof run.repoPath === 'string' && isInside(run.repoPath, script)) return { ok: false, reason: 'the runs folder is inside the repo' };
      const state = await tokenFor(run, reg, file);
      if (!writePrivate(script, widgetScript({ endpoint: url, token: state.token, runId: run.id, origin: state.origin }))) return { ok: false, reason: 'widget script not written' };
      return { ok: true, file: script, env: { [ENV_KEY]: script } };
    } catch (err) {
      return { ok: false, reason: oneLine(errText(err)) };
    }
  }

  /**
   * Revokes the run's token: locally first (prepare refuses from then on),
   * then in Supabase with the run's untaken rows. Idempotent; never throws.
   * @param {string} runId
   * @returns {Promise<{ok:boolean, revoked?:boolean, reason?:string}>}
   */
  async function revoke(runId) {
    let file;
    try {
      file = stateFile(runId);
    } catch (err) {
      return { ok: false, reason: errText(err) };
    }
    const state = readState(file);
    // No token was ever baked for this run on this machine.
    if (!state.token || state.remoteRevoked) return { ok: true, revoked: false };
    const marked = { ...state, revokedAt: state.revokedAt || now() };
    if (!state.revokedAt && !writeState(file, marked)) log(`[lunaswork] widget state of ${runId} not saved`);
    try {
      const reg = registry();
      if (!reg) throw new Error('cloud sync is not logged in');
      await reg.revoke(runId, marked.revokedAt);
      writeState(file, { ...marked, remoteRevoked: true });
      return { ok: true, revoked: true };
    } catch (err) {
      log(`[lunaswork] widget token of ${runId} not revoked yet (${oneLine(errText(err), 120)}) - retried on the next poll`);
      return { ok: false, reason: oneLine(errText(err)) };
    }
  }

  /**
   * Older runs whose remote revoke never went through (offline at the run
   * end, or LunaCore died in between): retried here, so a token never
   * outlives its run just because another run started. Never throws.
   * @param {string|null} currentRunId handled by deliver() itself
   */
  async function retryRevokes(currentRunId) {
    let names;
    try {
      names = fs.readdirSync(runsRoot());
    } catch {
      return;
    }
    for (const name of names) {
      const runId = name.startsWith('lunaswork-') ? name.slice('lunaswork-'.length) : '';
      if (!RUN_ID_RE.test(runId) || runId === currentRunId) continue;
      let state;
      try {
        state = readState(stateFile(runId));
      } catch {
        continue;
      }
      if (state.token && state.revokedAt && !state.remoteRevoked) await revoke(runId);
    }
  }

  /** One row into the run as client feedback. @returns {'added'|'refused'|'later'} */
  function take(controller, runId, row, runDir) {
    const screenshot = row.shot ? saveShot(runDir, row.id, row.shot) : null;
    const text = withContext(row.text, { page: row.page, screenshot });
    const base = row.createdAt || now();
    for (let bump = 0; bump < MAX_ID_BUMPS; bump += 1) {
      const res = controller.feedback({ text, author: 'client', id: base + bump, runId });
      if (res && res.ok) return 'added';
      const reason = res && res.reason;
      if (reason === 'duplicate') continue;
      if (reason === 'no-run' || reason === 'otherRun') return 'later';
      log(`[lunaswork] client feedback ${row.id} refused (${oneLine(reason, 40)})`);
      return 'refused';
    }
    return 'refused';
  }

  /**
   * The poll: the current run's client feedback into the controller (author
   * client), each row deleted once taken. A finished run's token is revoked
   * (again) instead - the retry of a revoke that failed at the run end.
   * @param {{status:Function, feedback:Function}} controller
   * @returns {Promise<number>} items added
   */
  async function deliver(controller) {
    const st = controller.status();
    await retryRevokes(isObj(st) ? st.runId : null);
    if (!isObj(st) || typeof st.runId !== 'string' || !RUN_ID_RE.test(st.runId)) return 0;
    if (!st.active) {
      await revoke(st.runId);
      return 0;
    }
    const file = stateFile(st.runId);
    const state = readState(file);
    const reg = registry();
    if (!state.token || state.revokedAt || !reg) return 0;
    const rows = await reg.pull(st.runId, PULL_LIMIT);
    const seen = new Set(state.seen);
    const taken = [];
    let added = 0;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = cleanRow(raw, st.runId);
      // A malformed row is dropped, so it never blocks the head of the queue.
      if (!row) {
        if (isObj(raw) && isTime(raw.id) && raw.run_id === st.runId) taken.push(raw.id);
        continue;
      }
      if (seen.has(row.id)) {
        taken.push(row.id);
        continue;
      }
      const res = take(controller, st.runId, row, path.dirname(file));
      if (res === 'later') break;
      if (res === 'added') added += 1;
      seen.add(row.id);
      taken.push(row.id);
    }
    // Seen first: a delete that fails never brings a row in twice.
    writeState(file, { ...readState(file), seen: [...seen] });
    await reg.ack(taken);
    return added;
  }

  return { prepare, revoke, deliver };
}

/**
 * The run controller's run-end hook (src/lunaswork.js): revoke the run's
 * widget token. Never throws, never waits.
 * @param {{revoke:(runId:string)=>Promise<unknown>}|undefined} widget
 */
function revokeOnRunEnd(widget, runId, log = () => {}) {
  if (!widget || typeof widget.revoke !== 'function') return;
  try {
    Promise.resolve(widget.revoke(runId)).catch((err) => log(`[lunaswork] widget revoke failed: ${errText(err)}`));
  } catch (err) {
    log(`[lunaswork] widget revoke failed: ${errText(err)}`);
  }
}

/**
 * Polls the widget's intake while LunaCore runs (main process).
 * @returns {{tick:()=>Promise<void>, stop:()=>void}}
 */
function startClientFeedbackPoll({ controller, widget, intervalMs = POLL_MS, setTimer = setInterval, clearTimer = clearInterval, log = () => {} }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await widget.deliver(controller);
    } catch (err) {
      log(`[lunaswork] client feedback not read: ${oneLine(errText(err), 160)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setTimer(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { tick, stop: () => clearTimer(timer) };
}

/** The function URL on a Supabase project URL. */
const endpointFor = (supabaseUrl) => (typeof supabaseUrl === 'string' && supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${FUNCTION_NAME}` : null);

module.exports = {
  MAX_TEXT,
  MAX_URL,
  MAX_SHOT_CHARS,
  TOKEN_RE,
  TOKEN_TTL_MS,
  ENV_KEY,
  TEXT,
  widgetGuard,
  widgetScript,
  newToken,
  hashToken,
  cleanRow,
  supabaseRegistry,
  createWidget,
  revokeOnRunEnd,
  startClientFeedbackPoll,
  endpointFor,
};
