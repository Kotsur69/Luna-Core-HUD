// ============================================================================
// LunaCore - the Antigravity quota as agy's own `/usage` prints it
// ----------------------------------------------------------------------------
// `agy -p /usage` (print mode expands the slash command; no model turn, no
// conversation is created) prints one tab-separated line per quota bucket:
//   <group>\t<bucket label>\t<NN%>\t<ISO reset>
//   Gemini Models          Weekly Limit Remaining        97%  2026-11-25T08:30:15Z
//   Claude and GPT models  Five Hour Limit Remaining    100%  2026-11-18T16:29:12Z
//   Gemini 4 Argon         Gemini 4 Argon Weekly Limit    1%  2026-11-25T07:04:05Z
// The percentage is what is LEFT. Verified live with agy 1.5.11 on 2026-11-18
// (about 2.5 s per call). This is the only source that has all three groups:
// the Code Assist summary LunaCore can call itself (src/agyusage.js) answers
// with the "Claude and GPT models" group alone, without Gemini and Argon.
//
// agy refreshes its own login, so this also works after the keyring token
// read by src/agyusage.js has expired. Started like src/agymodels.js starts
// `agy models`: execFile (no shell), the home folder as cwd, a kill timer.
// ============================================================================

'use strict';

const os = require('os');
const { execFile } = require('child_process');
const parse = require('./providerusageparse');

const AGY_BIN = 'agy';
const AGY_USAGE_ARGS = Object.freeze(['-p', '/usage', '--print-timeout', '30s']);
/** Kill timer: agy's own print timeout plus its start-up. */
const AGY_USAGE_TIMEOUT_MS = 45 * 1000;
/** The table is a few hundred bytes; far more is not it. */
const AGY_USAGE_MAX_BYTES = 64 * 1024;
const COLUMNS = 4;
const MAX_LINES = 50;

/** Windows the panel knows, read off a bucket label ("Five Hour Limit Remaining"). */
const LABEL_WINDOWS = [
  { re: /\bweek(ly)?\b|\b7\s*-?\s*days?\b/, window: 'weekly', label: 'Weekly limit' },
  { re: /\bfive\s*hours?\b|\b5\s*-?\s*h(ours?|rs?)?\b/, window: '5h', label: '5-hour window' },
  // Not a bare "day": a "3 day" bucket must stay custom with its own label.
  { re: /\bdaily\b|\b24\s*-?\s*hours?\b/, window: 'daily', label: 'Daily limit' },
  { re: /\bmonth(ly)?\b/, window: 'monthly', label: 'Monthly limit' },
];
const MAX_LABEL = 60;

/**
 * Runs `agy -p /usage`. Never rejects.
 * @param {{execImpl?: Function, timeoutMs?: number, env?: object}} [opts]
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 */
function runAgyUsage({ execImpl = execFile, timeoutMs = AGY_USAGE_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    // cwd: the home folder, never a project - Windows looks for a bare `agy` in the cwd first.
    const opts = { cwd: os.homedir(), env, timeout: timeoutMs, maxBuffer: AGY_USAGE_MAX_BYTES, windowsHide: true };
    try {
      execImpl(AGY_BIN, [...AGY_USAGE_ARGS], opts, (error, stdout) => {
        if (!error) return resolve({ ok: true, text: String(stdout || '') });
        if (error.code === 'ENOENT') return resolve({ ok: false, reason: 'agy not found' });
        // Checked before `killed`: an overflow kills the child too.
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: false, reason: 'agy /usage printed too much' });
        if (error.killed) return resolve({ ok: false, reason: `agy /usage timed out after ${timeoutMs} ms` });
        return resolve({ ok: false, reason: `agy /usage failed (${error.code || 'exit'})` });
      });
    } catch (err) {
      resolve({ ok: false, reason: `agy /usage could not start: ${(err && err.message) || err}` });
    }
  });
}

/** A bucket label's window, or null for one the panel does not know. */
function labelWindow(label) {
  const words = label.toLowerCase().replace(/[_\-.]+/g, ' ');
  return LABEL_WINDOWS.find((w) => w.re.test(words)) || null;
}

/** "97%" / "0.51%" -> 97 / 0.51 (what is left), or null. */
function remainingPercent(text) {
  const m = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n <= 100 ? n : null;
}

/**
 * `agy -p /usage` output -> usage rows, or null when no line parses. Every
 * column is untrusted text: a line that is not exactly four columns with a
 * percentage in the third is skipped. Each row carries `model`, the short
 * family name the usage tile shows (src/providerusageparse.js agyModelName).
 * @param {unknown} text
 * @returns {Array<object>|null}
 */
function parseAgyUsageTable(text) {
  const lines = String(typeof text === 'string' ? text : '').split(/\r?\n/).slice(0, MAX_LINES);
  const limits = [];
  for (const line of lines) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length !== COLUMNS) continue;
    const [group, label, pct, reset] = cols;
    const remaining = remainingPercent(pct);
    if (remaining === null || !group) continue;
    const win = labelWindow(label);
    const percentUsed = parse.clampPct(100 - remaining);
    limits.push({
      window: win ? win.window : 'custom',
      label: win ? win.label : label.slice(0, MAX_LABEL) || 'Limit',
      unit: 'credits',
      used: percentUsed,
      limit: 100,
      percentUsed,
      resetsAt: parse.toIso(reset),
      source: 'account',
      model: parse.agyModelName(group),
    });
  }
  return limits.length > 0 ? limits : null;
}

/** After a failed call (no agy, hang, error) agy is not started again for this long. */
const FAILED_RETRY_MS = 15 * 60 * 1000;
/**
 * After a call that ran but printed no table, this long. An agy that ever
 * stops expanding `/usage` in print mode would send it to the model as a
 * prompt: this caps that cost at one turn per six hours.
 */
const UNREADABLE_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * The `agy -p /usage` reader with a back-off, so the 5-minute usage poll does
 * not start a missing, hanging or misbehaving agy every time. read() answers
 * {ok: true, limits} or {ok: false, reason}; during a back-off it answers at
 * once without starting agy. Each new back-off is logged once.
 * @param {{run?: Function, now?: () => number, log?: (line: string) => void}} [opts]
 */
function createAgyUsageReader({ run = runAgyUsage, now = Date.now, log = (line) => console.warn(line) } = {}) {
  let retryAt = 0;
  let pending = null;
  const backOff = (ms, reason) => {
    retryAt = now() + ms;
    log(`[agy-usage] ${reason}; not starting agy again for ${Math.round(ms / 60000)} min`);
    return { ok: false, reason };
  };
  async function attempt() {
    const res = await run();
    if (!res || !res.ok) return backOff(FAILED_RETRY_MS, (res && res.reason) || 'agy /usage failed');
    const limits = parseAgyUsageTable(res.text);
    if (!limits) return backOff(UNREADABLE_RETRY_MS, 'agy /usage printed no usage table');
    return { ok: true, limits };
  }
  function read() {
    if (now() < retryAt) return Promise.resolve({ ok: false, reason: 'agy /usage backing off' });
    // One call at a time: a second poll joins the running one.
    if (!pending) pending = attempt().finally(() => { pending = null; });
    return pending;
  }
  return { read };
}

module.exports = { AGY_USAGE_ARGS, FAILED_RETRY_MS, UNREADABLE_RETRY_MS, runAgyUsage, parseAgyUsageTable, createAgyUsageReader };
