// ============================================================================
// LunaCore - replies to Luna's Work emails become feedback (B17, opt-in)
// ----------------------------------------------------------------------------
// OFF by default. Only with "Read replies to Luna's Work emails" on (mail
// settings, its own gmail.readonly consent - src/gmailread.js) does anything
// here touch the network. Off = no timer, no request, the emails as before.
//
//   record   every milestone / run-end email Gmail took gets its message id
//            and thread id stored with the run (src/lunasworkReport.js calls
//            record() after the send): <runsRoot>/lunaswork-<runId>/mail-replies.json
//            {threads:[{threadId, messageId, kind, sentAt}], seen:[gmail ids]}
//   poll     every 10 min while a run is active (the controller's events call
//            sync(), src/lunaswork.js), and only that run's threads - one
//            threads.get each, never a search of the inbox
//   accept   a message is taken only when it is a reply in that thread
//            (In-Reply-To / References, not a draft, not spam, not older than
//            our email) and its one From address is
//              - Mati's own connected address (author `mati`): written in this
//                mailbox (Gmail's SENT label, which only the account itself
//                can set) or delivered with an aligned SPF / DKIM pass, or
//              - an address Mati allow-listed for the run's project (author
//                `client`): aligned SPF or DKIM pass required.
//            "Aligned pass" is read from the TOPMOST Authentication-Results
//            header, and only when Gmail (authserv-id mx.google.com) wrote
//            it: a pass for another domain than the From domain, a DMARC
//            fail, or a header the sender wrote himself counts for nothing.
//   text     the text/plain part (or the HTML part as plain text), quoted
//            history and signature cut, capped at the feedback MAX_TEXT
//   import   controller.feedback({text, author, id: internalDate}) - the
//            normal channel: triage at the next iteration, the trust rules
//            (a client's scope change waits for Mati, no default), the status
//            on the phone and in the next milestone email
//   dedupe   every message id handled is kept in `seen`; the item id is the
//            message's internal date, so a crash between the import and the
//            write is caught by the controller as a duplicate
//
// Email text is DATA. Nothing in it is followed, opened or acted on: no link
// is fetched, no attachment downloaded (format=full carries only their ids),
// and the text reaches the run only as a feedback item, like a phone note.
// No Gmail label is written - the read grant cannot modify the mailbox.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { cleanText } = require('./lunasworkFeedback');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
// Gmail ids (src/gmailsend.js gmailId): safe inside a URL path.
const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

const POLL_MS = 10 * 60 * 1000;
const STATE_FILE = 'mail-replies.json';
const KINDS = ['milestone', 'runEnd'];
const MAX_THREADS = 60;
const MAX_SEEN = 2000;
const MAX_CLIENTS = 10;
const MAX_HEADERS = 200;
const MAX_HEADER_CHARS = 4000;
const MAX_PARTS = 40;
const MAX_PART_DEPTH = 6;
// Base64 characters of one body part looked at (about 150 KB of text).
const MAX_PART_DATA = 200 * 1024;
// HTML looked at when a reply has no plain part; a reply is short.
const MAX_HTML_CHARS = 20000;
// The PC's clock and Gmail's may differ a little.
const CLOCK_SLACK_MS = 5 * 60 * 1000;
const AUTHSERV_ID = 'mx.google.com';
const SKIP_LABELS = { DRAFT: 'draft', SPAM: 'spam', TRASH: 'trash' };
// Characters of one body line the quote patterns look at: keeps them linear.
const MAX_LINE_CHARS = 400;
// Not marked seen: the same message may pass later (Mati allow-lists the
// sender, the draft is sent - a sent draft gets a new id anyway; an auth
// result we could not read is never trusted, but never lost for good either).
const RETRY_REASONS = new Set(['sender', 'draft', 'auth']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const gmailId = (v) => (typeof v === 'string' && GMAIL_ID_RE.test(v) ? v : null);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

// ---- headers + sender -------------------------------------------------------------

/** The message's headers, names lower case, capped. */
function headersOf(msg) {
  const list = isObj(msg) && isObj(msg.payload) && Array.isArray(msg.payload.headers) ? msg.payload.headers.slice(0, MAX_HEADERS) : [];
  return list
    .filter((h) => isObj(h) && typeof h.name === 'string' && typeof h.value === 'string')
    .map((h) => ({ name: h.name.toLowerCase(), value: h.value.slice(0, MAX_HEADER_CHARS) }));
}

const headerValue = (headers, name) => {
  const h = headers.find((x) => x.name === name);
  return h ? h.value : null;
};

/**
 * The one address of a From header, lower case, or null (none, several, or
 * malformed). The display name never counts.
 * @param {string} value
 * @returns {string|null}
 */
function parseMailbox(value) {
  if (typeof value !== 'string') return null;
  // Quoted display names may hold anything, commas and @ included.
  const bare = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').trim();
  const angles = bare.match(/<[^<>]*>/g) || [];
  if (angles.length > 1) return null;
  let addr;
  if (angles.length === 1) {
    if (bare.replace(angles[0], '').includes('@')) return null;
    addr = angles[0].slice(1, -1).trim();
  } else {
    addr = bare;
  }
  if (addr.includes(',')) return null;
  return EMAIL_RE.test(addr) ? addr.toLowerCase() : null;
}

const domainOf = (addr) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();

/**
 * Gmail's own Authentication-Results (the topmost one, authserv-id
 * mx.google.com), or null. Comments in parentheses are dropped first: only
 * Gmail's results and properties count, never the prose around them.
 * @returns {{spf:string|null, spfDomain:string|null, dkim:Array<{result:string, domain:string|null}>, dmarc:string|null}|null}
 */
function authResults(headers) {
  const first = headers.find((h) => h.name === 'authentication-results');
  if (!first) return null;
  // A folded header (CRLF + space inside a clause) is one line again first.
  const clauses = first.value.replace(/\s+/g, ' ').replace(/\([^()]*\)/g, ' ').split(';');
  if (clauses[0].trim().toLowerCase() !== AUTHSERV_ID) return null;
  const out = { spf: null, spfDomain: null, dkim: [], dmarc: null };
  for (const raw of clauses.slice(1)) {
    const m = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)\b(.*)$/i.exec(raw);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const props = m[3];
    if (method === 'spf' && out.spf === null) {
      const from = /\bsmtp\.mailfrom=(?:[^\s@;]*@)?([A-Za-z0-9.-]+)/i.exec(props);
      out.spf = result;
      out.spfDomain = from ? from[1].toLowerCase() : null;
    } else if (method === 'dkim') {
      const d = /\bheader\.(?:d=|i=[^\s@;]*@)([A-Za-z0-9.-]+)/i.exec(props);
      out.dkim.push({ result, domain: d ? d[1].toLowerCase() : null });
    } else if (method === 'dmarc' && out.dmarc === null) {
      out.dmarc = result;
    }
  }
  return out;
}

/** Relaxed alignment: the authenticated domain and the From domain share their tail. */
function aligned(domain, fromDomain) {
  if (!domain || !domain.includes('.') || !fromDomain) return false;
  return domain === fromDomain || fromDomain.endsWith(`.${domain}`) || domain.endsWith(`.${fromDomain}`);
}

/**
 * Whether Gmail saw an SPF or DKIM pass for the From domain itself.
 * @param {Array<{name:string, value:string}>} headers
 * @param {string} from the From address
 */
function authenticated(headers, from) {
  const ar = authResults(headers);
  if (!ar || ar.dmarc === 'fail') return false;
  const fromDomain = domainOf(from);
  const dkimOk = ar.dkim.some((d) => d.result === 'pass' && aligned(d.domain, fromDomain));
  const spfOk = ar.spf === 'pass' && aligned(ar.spfDomain, fromDomain);
  return dkimOk || spfOk;
}

/**
 * Who wrote a message, or why it is not trusted.
 * @param {object} msg a Gmail API message
 * @param {{self:string, clients:string[]}} ctx
 * @returns {{ok:true, author:'mati'|'client'}|{ok:false, reason:'from'|'auth'|'sender'}}
 */
function senderOf(msg, ctx) {
  const headers = headersOf(msg);
  const froms = headers.filter((h) => h.name === 'from');
  if (froms.length !== 1) return { ok: false, reason: 'from' };
  const from = parseMailbox(froms[0].value);
  if (!from) return { ok: false, reason: 'from' };
  const labels = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  if (ctx.self && from === ctx.self) {
    return labels.includes('SENT') || authenticated(headers, from) ? { ok: true, author: 'mati' } : { ok: false, reason: 'auth' };
  }
  if (ctx.clients.includes(from)) return authenticated(headers, from) ? { ok: true, author: 'client' } : { ok: false, reason: 'auth' };
  return { ok: false, reason: 'sender' };
}

// ---- body -------------------------------------------------------------------------

/** The charset of a part's Content-Type, or utf-8. */
function charsetOf(part) {
  const type = headerValue(headersOf({ payload: part }), 'content-type') || '';
  const m = /charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})/i.exec(type);
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decodePart(part) {
  const data = isObj(part.body) && typeof part.body.data === 'string' ? part.body.data : '';
  if (!data) return '';
  // A multiple of 4, so a cut never splits a base64 group.
  const bytes = Buffer.from(data.slice(0, MAX_PART_DATA - (MAX_PART_DATA % 4)), 'base64url');
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Text parts that are not attachments, depth-first, capped. */
function textParts(payload) {
  const out = [];
  const walk = (part, depth) => {
    if (!isObj(part) || depth > MAX_PART_DEPTH || out.length >= MAX_PARTS) return;
    const type = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const disposition = headerValue(headersOf({ payload: part }), 'content-disposition') || '';
    const attachment = (typeof part.filename === 'string' && part.filename) || /^\s*attachment/i.test(disposition);
    if (!attachment && (type === 'text/plain' || type === 'text/html')) out.push({ type, part });
    if (Array.isArray(part.parts)) for (const child of part.parts.slice(0, MAX_PARTS)) walk(child, depth + 1);
  };
  walk(payload, 0);
  return out;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/**
 * HTML as plain text: quoted blocks, scripts and styles out, tags dropped.
 * Cut to MAX_HTML_CHARS first: the block pattern rescans to the end for every
 * unclosed opener, so its input stays small.
 */
function htmlToText(html) {
  return html
    .slice(0, MAX_HTML_CHARS)
    .replace(/<(script|style|head|blockquote)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, e) => ENTITIES[e.toLowerCase()])
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    });
}

/**
 * The readable text of a message: its plain part, else its HTML as text.
 * @param {object} payload the Gmail API message payload
 * @returns {string}
 */
function messageText(payload) {
  const parts = textParts(payload);
  const plain = parts.find((p) => p.type === 'text/plain');
  if (plain) return decodePart(plain.part);
  const html = parts.find((p) => p.type === 'text/html');
  return html ? htmlToText(decodePart(html.part)) : '';
}

// Where quoted history starts: everything from here down is cut.
const QUOTE_START = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^(?:W dniu|Dnia)\b.{0,300}(?:napisa\S{0,10}|pisze):\s*$/i,
  /^-{2,}\s*(?:Original Message|Forwarded message|Wiadomo\S* oryginalna|Wiadomo\S* przekazana)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
  // LunaCore's own email, quoted without '>' by some clients.
  /^Milestone ".{0,120}" reached after iteration \d+/,
  /^(?:NEEDS YOU|WAITS FOR YOU|SCORES PER MILESTONE|FULL REPORT)$/,
];
// "On <date>, <name>" wraps before "wrote:" in many clients.
const QUOTE_LEAD_RE = /^(?:On|W dniu|Dnia)\b/i;
const QUOTE_TAIL_RE = /(?:wrote|napisa\S{0,10}|pisze):\s*$/i;
// An Outlook header block: "From: ..." followed by "Sent: / Date: / To: ...".
const OUTLOOK_FROM_RE = /^(?:From|Od):\s/i;
const OUTLOOK_NEXT_RE = /^(?:Sent|Date|To|Subject|Wys\S*|Data|Do|Temat):\s/i;
// Where a signature starts.
const SIGNATURE_START = [/^-- ?$/, /^(?:Sent from my|Sent from Mail for|Get Outlook for|Wys[lł]ane z )/i];

/** Whether line i opens the quoted history. */
function quoteStartsAt(lines, i) {
  const line = lines[i].slice(0, MAX_LINE_CHARS).trim();
  const next = i + 1 < lines.length ? lines[i + 1].slice(0, MAX_LINE_CHARS).trim() : '';
  if (QUOTE_START.some((re) => re.test(line))) return true;
  if (QUOTE_LEAD_RE.test(line) && !QUOTE_TAIL_RE.test(line) && QUOTE_TAIL_RE.test(next)) return true;
  return OUTLOOK_FROM_RE.test(line) && OUTLOOK_NEXT_RE.test(next);
}

/**
 * The new text of a reply: quoted history, '>' lines and the signature cut,
 * then cleaned and capped like any feedback text (lunasworkFeedback.cleanText).
 * @param {string} text
 * @returns {string}
 */
function replyText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (quoteStartsAt(lines, i)) break;
    if (SIGNATURE_START.some((re) => re.test(lines[i].replace(/^\s+/, '')))) break;
    if (/^\s*>/.test(lines[i])) continue;
    out.push(lines[i]);
  }
  return cleanText(out.join('\n'));
}

// ---- one message ------------------------------------------------------------------

/**
 * One thread message -> a reply to import, or why not.
 * @param {object} msg an untrusted Gmail API message
 * @param {{self:string|null, clients:string[], ownIds:Set<string>, notBefore:number|null}} ctx
 * @returns {{ok:true, id:string, at:number, author:'mati'|'client', text:string}|{ok:false, id:string|null, reason:string}}
 */
function readReply(msg, ctx) {
  const id = isObj(msg) ? gmailId(msg.id) : null;
  if (!id) return { ok: false, id: null, reason: 'malformed' };
  const refuse = (reason) => ({ ok: false, id, reason });
  if (ctx.ownIds.has(id)) return refuse('own');
  const labels = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  const skip = Object.keys(SKIP_LABELS).find((l) => labels.includes(l));
  if (skip) return refuse(SKIP_LABELS[skip]);
  const at = typeof msg.internalDate === 'string' && /^\d{1,16}$/.test(msg.internalDate) ? Number(msg.internalDate) : NaN;
  if (!Number.isSafeInteger(at) || at <= 0) return refuse('malformed');
  if (Number.isFinite(ctx.notBefore) && at < ctx.notBefore - CLOCK_SLACK_MS) return refuse('older');
  const headers = headersOf(msg);
  if (!headerValue(headers, 'in-reply-to') && !headerValue(headers, 'references')) return refuse('not-reply');
  const sender = senderOf(msg, ctx);
  if (!sender.ok) return refuse(sender.reason);
  const text = replyText(messageText(msg.payload));
  if (!text) return refuse('empty');
  return { ok: true, id, at, author: sender.author, text };
}

// ---- state --------------------------------------------------------------------------

function cleanThread(raw) {
  if (!isObj(raw)) return null;
  const threadId = gmailId(raw.threadId);
  if (!threadId) return null;
  return {
    threadId,
    messageId: gmailId(raw.messageId),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'milestone',
    sentAt: Number.isSafeInteger(raw.sentAt) && raw.sentAt > 0 ? raw.sentAt : null,
  };
}

/** A run's stored threads and seen ids; a missing or broken file is empty. */
function normalizeState(raw) {
  const r = isObj(raw) ? raw : {};
  const ids = new Set();
  const threads = (Array.isArray(r.threads) ? r.threads : [])
    .slice(-MAX_THREADS)
    .map(cleanThread)
    .filter((t) => t && !ids.has(t.threadId) && ids.add(t.threadId));
  const seen = [...new Set((Array.isArray(r.seen) ? r.seen : []).filter((s) => gmailId(s)))].slice(-MAX_SEEN);
  return { threads, seen };
}

/**
 * The allow-listed client addresses of a project (mailprefs replyClients).
 * @returns {string[]}
 */
function clientsFor(prefs, projectId) {
  const map = isObj(prefs) && isObj(prefs.replyClients) ? prefs.replyClients : {};
  const list = typeof projectId === 'string' && Object.hasOwn(map, projectId) && Array.isArray(map[projectId]) ? map[projectId] : [];
  return list.filter((a) => typeof a === 'string' && EMAIL_RE.test(a)).map((a) => a.toLowerCase()).slice(0, MAX_CLIENTS);
}

// ---- the poller ---------------------------------------------------------------------

/**
 * @param {{
 *   reader: {status:()=>{connected:boolean, email:string|null}, thread:(id:string)=>Promise<object[]|null>},
 *   sender: {status:()=>{connected:boolean, email:string|null}},
 *   prefs: {loadPrefs:()=>object},
 *   runsRoot: ()=>string,
 *   intervalMs?: number, setTimer?: Function, clearTimer?: Function,
 *   now?: ()=>number, log?: (line:string)=>void,
 * }} deps
 * @returns {{record:Function, attach:Function, sync:Function, refresh:Function, tick:Function, enabled:Function, stop:Function}}
 */
function createMailReplies(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const setTimer = deps.setTimer || setInterval;
  const clearTimer = deps.clearTimer || clearInterval;
  const intervalMs = deps.intervalMs || POLL_MS;
  let controller = null;
  let current = null; // {runId, projectId} of the active run
  let timer = null;
  let busy = false;
  // Refusals that are retried (unknown sender) are logged once per session.
  const told = new Set();

  const stateFile = (runId) => path.join(deps.runsRoot(), `lunaswork-${runId}`, STATE_FILE);

  function readState(runId) {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(stateFile(runId), 'utf8')));
    } catch (err) {
      if (err && err.code !== 'ENOENT') log(`[lunaswork] mail reply state unreadable: ${errText(err)}`);
      return normalizeState(null);
    }
  }

  function writeState(runId, state) {
    const file = stateFile(runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeState(state)), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** The setting is on, the read grant is there, and it is the same mailbox the emails went from. */
  function enabled() {
    try {
      if (deps.prefs.loadPrefs().replyRead !== true) return false;
      const r = deps.reader.status();
      const s = deps.sender.status();
      return !!(r.connected && s.connected && r.email && r.email === s.email);
    } catch (err) {
      log(`[lunaswork] mail reply setting unreadable: ${errText(err)}`);
      return false;
    }
  }

  /**
   * An email Gmail took for this run: its ids, so a reply can be matched.
   * Stored whatever the setting says (it may be turned on mid-run). Never throws.
   * @param {string} runId
   * @param {{threadId?:string|null, messageId?:string|null, kind?:string}} info
   * @returns {boolean} whether it was stored
   */
  function record(runId, info) {
    try {
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || !isObj(info)) return false;
      const thread = cleanThread({ ...info, sentAt: now() });
      if (!thread) return false;
      const state = readState(runId);
      if (state.threads.some((t) => t.threadId === thread.threadId)) return true;
      writeState(runId, { ...state, threads: [...state.threads, thread] });
      return true;
    } catch (err) {
      log(`[lunaswork] mail thread not stored: ${errText(err)}`);
      return false;
    }
  }

  function disarm() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function arm() {
    if (timer || !current || !enabled()) return;
    timer = setTimer(() => {
      tick().catch((err) => log(`[lunaswork] mail replies not read: ${errText(err)}`));
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** The run controller to import into (src/lunaswork.js createLunasWork). */
  const attach = (c) => {
    controller = c;
  };

  /**
   * The controller's events: polling while a run is active, none after.
   * @param {{id:string, projectId:string, phase:string}|null} run
   */
  function sync(run) {
    const active = isObj(run) && typeof run.id === 'string' && RUN_ID_RE.test(run.id) && run.phase !== 'done';
    if (!active) {
      current = null;
      disarm();
      return;
    }
    if (current && current.runId === run.id) return;
    current = { runId: run.id, projectId: typeof run.projectId === 'string' && PROJECT_ID_RE.test(run.projectId) ? run.projectId : null };
    disarm();
    arm();
  }

  /**
   * The setting or a grant changed: start or stop polling, and look now when on.
   * @returns {Promise<number>} items added
   */
  async function refresh() {
    if (!current || !enabled()) {
      disarm();
      return 0;
    }
    arm();
    return tick();
  }

  /** One message into the run. @returns {'added'|'seen'|'later'} */
  function take(reply, runId) {
    const res = controller.feedback({ text: reply.text, author: reply.author, id: reply.at, runId });
    if (res && res.ok) {
      log(`[lunaswork] email reply ${reply.id} from ${reply.author} imported as feedback ${res.id}`);
      return 'added';
    }
    const reason = res && res.reason;
    if (reason === 'no-run' || reason === 'otherRun') return 'later';
    if (reason !== 'duplicate') log(`[lunaswork] email reply ${reply.id} refused (${oneLine(reason, 40)})`);
    return 'seen';
  }

  function skipped(reply, seen) {
    if (RETRY_REASONS.has(reply.reason)) {
      if (!told.has(reply.id)) log(`[lunaswork] email reply ${reply.id} skipped (${reply.reason})`);
      told.add(reply.id);
      return;
    }
    if (reply.reason !== 'own') log(`[lunaswork] email reply ${reply.id} skipped (${reply.reason})`);
    seen.add(reply.id);
  }

  /** The new messages of one thread. @returns {Promise<{added:number, stop:boolean}>} */
  async function readThread(thread, ctx, runId) {
    let messages;
    try {
      messages = await deps.reader.thread(thread.threadId);
    } catch (err) {
      log(`[lunaswork] mail thread not read: ${oneLine((err && err.reason) || errText(err), 80)}`);
      return { added: 0, stop: true };
    }
    let added = 0;
    for (const msg of Array.isArray(messages) ? messages : []) {
      const reply = readReply(msg, { ...ctx, notBefore: thread.sentAt });
      if (!reply.id || ctx.seen.has(reply.id)) continue;
      if (!reply.ok) {
        skipped(reply, ctx.seen);
        continue;
      }
      const res = take(reply, runId);
      if (res === 'later') return { added, stop: true };
      if (res === 'added') added += 1;
      ctx.seen.add(reply.id);
    }
    return { added, stop: false };
  }

  /**
   * One poll: the active run's threads, new replies into its feedback.
   * @returns {Promise<number>} items added
   */
  async function tick() {
    if (busy || !current || !controller) return 0;
    if (!enabled()) {
      disarm();
      return 0;
    }
    busy = true;
    const { runId, projectId } = current;
    try {
      const state = readState(runId);
      if (!state.threads.length) return 0;
      const ctx = {
        self: deps.reader.status().email,
        clients: clientsFor(deps.prefs.loadPrefs(), projectId),
        ownIds: new Set(state.threads.map((t) => t.messageId).filter(Boolean)),
        seen: new Set(state.seen),
      };
      const before = ctx.seen.size;
      let added = 0;
      for (const thread of state.threads) {
        const res = await readThread(thread, ctx, runId);
        added += res.added;
        if (res.stop) break;
      }
      if (ctx.seen.size !== before) writeState(runId, { ...readState(runId), seen: [...ctx.seen] });
      return added;
    } finally {
      busy = false;
    }
  }

  const stop = () => {
    current = null;
    disarm();
  };

  return { record, attach, sync, refresh, tick, enabled, stop };
}

/**
 * The run controller's hook (src/lunaswork.js, on every event): polling
 * follows the run. Never throws.
 */
function syncMailReplies(mailReplies, run, log = () => {}) {
  if (!mailReplies || typeof mailReplies.sync !== 'function') return;
  try {
    mailReplies.sync(run ? { id: run.id, projectId: run.projectId, phase: run.phase } : null);
  } catch (err) {
    log(`[lunaswork] mail replies sync failed: ${errText(err)}`);
  }
}

module.exports = {
  POLL_MS,
  STATE_FILE,
  MAX_CLIENTS,
  EMAIL_RE,
  PROJECT_ID_RE,
  parseMailbox,
  authResults,
  authenticated,
  senderOf,
  messageText,
  replyText,
  readReply,
  normalizeState,
  clientsFor,
  createMailReplies,
  syncMailReplies,
};
