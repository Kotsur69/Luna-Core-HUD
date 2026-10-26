// ============================================================================
// LunaCore - Luna's Work second opinion at milestone gates
// (docs/LUNAS_WORK_PLAN.md, B8, slice 2.20)
// ----------------------------------------------------------------------------
// At a milestone gate only, another vendor's agent CLI (Codex or Gemini,
// whichever is first installed AND logged in, in a configurable order) reads
// the same inputs as the Critic - playtest report, design pack, gate diff -
// read-only, and answers in the Critic's JSON shape (CRITIC_SCHEMA).
//
// Its reply goes through the Critic's trust boundary (validateCritique).
// mergeFindings() keeps the Critic's cards and adds only the second-opinion
// cards that are not near-duplicates, marked source 'second opinion'.
// gateVerdict() blocks the gate when the two disagree: the controller keeps
// it closed until the next iteration's Critic or a decision-queue entry
// resolves the disagreement.
//
// Login detection mirrors src/providerusage.js (fetchCodex / fetchGemini):
//   codex   $CODEX_HOME or ~/.codex/auth.json with tokens.access_token or OPENAI_API_KEY
//   gemini  GEMINI_API_KEY / GOOGLE_API_KEY, or ~/.gemini/oauth_creds.json with a token
// The command names match the native provider templates (config/providers.json).
//
// Never throws. Not installed / not logged in -> { skipped:true, note }.
//
// Exports
//   DEFAULT_ORDER          string[]  ['codex', 'gemini']
//   SECOND_OPINION_CLIS    {[cli]: {command:string, args:string[]}}  read-only invocations
//   SECOND_OPINION_SOURCE  'second opinion'
//   detectCli(cli:string, deps?:{env?, homedir?:()=>string, platform?:string,
//       exists?:(p)=>boolean, readFile?:(p)=>string}) -> {installed:boolean, loggedIn:boolean}
//       Default detector; every file-system access goes through deps.
//   pickCli(order:string[], detect:(cli)=>{installed,loggedIn}|Promise<...>)
//       -> Promise<{cli:string|null, tried:{cli, installed, loggedIn}[]}>
//   buildSecondOpinionPrompt(inputs:{playtestReport?, designPack?, gateDiff?}) -> string
//   parseCliOutput(stdout:string) -> {ok:true, raw:object} | {ok:false, error:string}
//   textSimilarity(a:string, b:string) -> number  (0..1, word-set Jaccard)
//   mergeFindings(criticCards:object[], secondCards:object[]) -> object[]
//       Pure. Critic cards first, then the kept second-opinion cards with
//       source 'second opinion' and the extra tag 'second-opinion'.
//   gateVerdict(critic:{passed?, milestone?, verdict?}, second:object|null)
//       -> {passed:boolean, disagreement:object|null}
//   execCli({command, args, prompt, cwd, env, timeoutMs}) -> Promise<{stdout}|{error, detail?}>
//   runSecondOpinion({isGate, inputs, order?, detect?, runCli?, cwd?, env?, allPassed?,
//       ideasAllowed?, log?, now?, timeoutMs?}) -> Promise<
//       {skipped:true, note:string} |
//       {skipped:false, ok:boolean, cli:string, verdict:'continue'|'ship'|null, cards:object[],
//        warnings:object[], notes:string[], durationMs:number}>
//     detect(cli) -> {installed, loggedIn} (sync or async)   (default: detectCli)
//     runCli({cli, command, args, prompt, cwd, env, timeoutMs}) -> Promise<{stdout}|{error, detail?}>
//         (default: execCli)
//     log(message:string, detail?:unknown) -> void            (default: no-op)
//     now() -> number                                        (default: Date.now)
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { CRITIC_SCHEMA, validateCritique } = require('./lunasworkCritic');
const { cleanTags } = require('./todorows');

const DEFAULT_ORDER = ['codex', 'gemini'];
// Prompt on stdin; every arg is a fixed token (safe for the Windows shell shim).
const SECOND_OPINION_CLIS = Object.freeze({
  codex: { command: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-'] },
  // Non-interactive with piped stdin; 'default' approval denies every tool that needs approval (writes, shell).
  gemini: { command: 'gemini', args: ['--approval-mode', 'default', '--output-format', 'json'] },
});
const SAFE_ARG_RE = /^[A-Za-z0-9._:=-]+$/;
const SECOND_OPINION_SOURCE = 'second opinion';
const SECOND_OPINION_TAG = 'second-opinion';
const SECOND_OPINION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INPUT_CHARS = 40000;
const MAX_NOTE_CHARS = 300;
// Two card texts at least this similar are the same finding.
const DUPLICATE_SIMILARITY = 0.6;
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'it', 'be', 'with', 'when', 'from']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => String(s === undefined || s === null ? '' : s).slice(0, max);
const noop = () => {};

// ---- detection ----------------------------------------------------------------------

function safeJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function defaultDeps(deps) {
  const d = isObj(deps) ? deps : {};
  return {
    env: isObj(d.env) ? d.env : process.env,
    homedir: typeof d.homedir === 'function' ? d.homedir : os.homedir,
    platform: typeof d.platform === 'string' ? d.platform : process.platform,
    exists: typeof d.exists === 'function' ? d.exists : (p) => fs.existsSync(p),
    readFile: typeof d.readFile === 'function' ? d.readFile : (p) => fs.readFileSync(p, 'utf8'),
  };
}

/** True when `command` resolves to a file on PATH (with PATHEXT on Windows). */
function onPath(command, d) {
  const env = d.env;
  const pathVar = env.PATH || env.Path || '';
  const win = d.platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const exts = win ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  return pathVar.split(win ? ';' : ':').filter(Boolean).some((dir) => exts.some((ext) => {
    try {
      return d.exists(join(dir, command + ext));
    } catch {
      return false;
    }
  }));
}

function readJsonFile(file, d) {
  try {
    return safeJson(d.readFile(file));
  } catch {
    return null;
  }
}

function codexLoggedIn(d) {
  const home = d.env.CODEX_HOME || path.join(d.homedir(), '.codex');
  const auth = readJsonFile(path.join(home, 'auth.json'), d);
  return !!auth && ((isObj(auth.tokens) && !!auth.tokens.access_token) || !!auth.OPENAI_API_KEY);
}

function geminiLoggedIn(d) {
  if (d.env.GEMINI_API_KEY || d.env.GOOGLE_API_KEY) return true;
  const creds = readJsonFile(path.join(d.homedir(), '.gemini', 'oauth_creds.json'), d);
  // gemini refreshes an expired access token itself when it has a refresh token.
  return !!creds && (!!creds.access_token || !!creds.refresh_token);
}

const LOGIN_CHECKS = { codex: codexLoggedIn, gemini: geminiLoggedIn };

/**
 * Default detector: installed = on PATH, logged in = a cached login or an API key.
 * @param {string} cli
 * @param {object} [deps]
 * @returns {{installed:boolean, loggedIn:boolean}}
 */
function detectCli(cli, deps) {
  const spec = SECOND_OPINION_CLIS[cli];
  if (!spec) return { installed: false, loggedIn: false };
  try {
    const d = defaultDeps(deps);
    const installed = onPath(spec.command, d);
    return { installed, loggedIn: installed && LOGIN_CHECKS[cli](d) };
  } catch {
    return { installed: false, loggedIn: false };
  }
}

/** The first CLI of `order` that is installed and logged in. Never rejects. */
async function pickCli(order, detect) {
  const list = (Array.isArray(order) && order.length ? order : DEFAULT_ORDER).filter((c) => SECOND_OPINION_CLIS[c]);
  const tried = [];
  for (const cli of list) {
    let state;
    try {
      state = await detect(cli);
    } catch {
      state = null;
    }
    const installed = isObj(state) && state.installed === true;
    const loggedIn = installed && state.loggedIn === true;
    tried.push({ cli, installed, loggedIn });
    if (loggedIn) return { cli, tried };
  }
  return { cli: null, tried };
}

// ---- prompt and output --------------------------------------------------------------

function section(title, value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
  const cut = text.length > MAX_INPUT_CHARS;
  return [`## ${title}${cut ? ' (cut)' : ''}`, text.slice(0, MAX_INPUT_CHARS) || '(none)'].join('\n');
}

/** The second-opinion prompt: role, the exact JSON shape, then the Critic's inputs. */
function buildSecondOpinionPrompt(inputs) {
  const i = isObj(inputs) ? inputs : {};
  return [
    "You are a second-opinion reviewer at a milestone gate of Luna's Work. Another model (the Critic) judges the same evidence.",
    'Work READ-ONLY: do not change, create or delete any file, and run no commands that do.',
    'Judge whether the milestone gate really holds: what is broken, what feels wrong, what is missing.',
    'Every card is bug / feel / missing / idea with a severity; a bug card asks for a repro test first.',
    'Answer with ONE JSON object and nothing else, matching this JSON schema exactly:',
    JSON.stringify(CRITIC_SCHEMA),
    '',
    section('Playtest report', i.playtestReport),
    '',
    section('Design pack', i.designPack),
    '',
    section('Gate diff', i.gateDiff),
  ].join('\n');
}

/** The first `{` to the last `}` of a text, parsed; null when that is not JSON. */
function embeddedJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? safeJson(s.slice(start, end + 1)) : null;
}

/**
 * Reads a CLI's answer: plain JSON, a gemini `--output-format json` envelope
 * ({response: "<text>"}), or JSON inside surrounding prose / code fences.
 */
function parseCliOutput(stdout) {
  const whole = safeJson(stdout);
  const fromEnvelope = isObj(whole) && typeof whole.response === 'string' ? whole.response : null;
  let raw;
  if (fromEnvelope !== null) raw = safeJson(fromEnvelope) || embeddedJson(fromEnvelope);
  else raw = isObj(whole) ? whole : embeddedJson(stdout);
  return isObj(raw) ? { ok: true, raw } : { ok: false, error: 'badJson' };
}

// ---- merge and verdict --------------------------------------------------------------

function words(text) {
  return new Set(
    String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
      .filter((w) => w && !STOP_WORDS.has(w)),
  );
}

/** Word-set Jaccard similarity of two card texts, 0..1. */
function textSimilarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

const isDuplicate = (card, kept) => kept.some((k) => textSimilarity(k.text, card.text) >= DUPLICATE_SIMILARITY);

/**
 * Critic cards win; a second-opinion card is kept only when no card already
 * kept says nearly the same thing. Kept ones carry source 'second opinion'.
 */
function mergeFindings(criticCards, secondCards) {
  const merged = (Array.isArray(criticCards) ? criticCards : []).filter(isObj);
  const extra = [];
  for (const card of (Array.isArray(secondCards) ? secondCards : []).filter(isObj)) {
    if (typeof card.text !== 'string' || !card.text || isDuplicate(card, [...merged, ...extra])) continue;
    extra.push({
      ...card,
      source: SECOND_OPINION_SOURCE,
      extraTags: cleanTags([...(Array.isArray(card.extraTags) ? card.extraTags : []), SECOND_OPINION_TAG]),
    });
  }
  return [...merged, ...extra];
}

const blockingTexts = (cards) => (Array.isArray(cards) ? cards : [])
  .filter((c) => isObj(c) && (c.kind === 'bug' || c.severity === 'blocker'))
  .map((c) => c.text);

const criticPassed = (critic) => critic.passed === true || (isObj(critic.milestone) && critic.milestone.passed === true);

/**
 * The gate after a second opinion. No usable second opinion (skipped or
 * failed) leaves the Critic's call alone. They disagree when their verdicts
 * differ, or when the Critic passes the gate while the second opinion files
 * a bug or a blocker. A disagreement never passes the gate.
 * @param {{passed?:boolean, milestone?:{passed:boolean}, verdict?:string}} critic
 *   a runCritic result works as is
 * @param {{skipped?:boolean, ok?:boolean, cli?:string, verdict?:string|null, cards?:object[]}|null} second
 * @returns {{passed:boolean, disagreement:null|{reason:'verdict'|'blockingFindings',
 *   critic:object, second:object, resolveBy:string[]}}}
 */
function gateVerdict(critic, second) {
  const c = isObj(critic) ? critic : {};
  const passed = criticPassed(c);
  const usable = isObj(second) && second.skipped !== true && second.ok !== false && typeof second.verdict === 'string';
  if (!usable) return { passed, disagreement: null };
  const blocking = blockingTexts(second.cards);
  const verdictsDiffer = typeof c.verdict === 'string' && c.verdict !== second.verdict;
  const blockedPass = passed && blocking.length > 0;
  if (!verdictsDiffer && !blockedPass) return { passed, disagreement: null };
  return {
    passed: false,
    disagreement: {
      reason: verdictsDiffer ? 'verdict' : 'blockingFindings',
      critic: { verdict: c.verdict || null, passed },
      second: { cli: second.cli || null, verdict: second.verdict, blocking },
      // The controller keeps the gate closed until one of these settles it.
      resolveBy: ['nextCritic', 'decisionQueue'],
    },
  };
}

// ---- run ----------------------------------------------------------------------------

/**
 * Default runner: execFile with the prompt on stdin. npm installs codex and
 * gemini as .cmd shims on Windows, which only run through the shell; every
 * arg is checked against SAFE_ARG_RE first, so nothing can be injected.
 * Resolves {stdout} or {error, detail}; never rejects.
 */
function execCli({ command, args, prompt, cwd, env, timeoutMs, execImpl = execFile, platform = process.platform }) {
  return new Promise((resolve) => {
    const argv = Array.isArray(args) ? args : [];
    if (![command, ...argv].every((a) => typeof a === 'string' && SAFE_ARG_RE.test(a))) {
      resolve({ error: 'unsafeArgs' });
      return;
    }
    // Through the shell the line is joined here (all tokens are safe), not by
    // Node: an args array with shell:true is deprecated (DEP0190).
    const viaShell = platform === 'win32';
    let child;
    try {
      child = execImpl(
        viaShell ? [command, ...argv].join(' ') : command,
        viaShell ? [] : argv,
        { cwd, env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: viaShell },
        (error, stdout) => {
          if (error && error.code === 'ENOENT') return resolve({ error: 'notInstalled' });
          if (error && error.killed) return resolve({ error: 'timeout' });
          if (error && !stdout) return resolve({ error: 'failed', detail: clip(error.message, MAX_NOTE_CHARS) });
          resolve({ stdout });
        },
      );
    } catch (err) {
      resolve({ error: 'failed', detail: clip(err && err.message, MAX_NOTE_CHARS) });
      return;
    }
    if (child && child.stdin) {
      child.stdin.on('error', () => {}); // a child that died early must not crash main
      child.stdin.end(prompt);
    }
  });
}

function skippedNote(tried) {
  if (!tried.length) return 'second opinion skipped: no known CLI in the order';
  const parts = tried.map((t) => `${t.cli} ${t.installed ? 'not logged in' : 'not installed'}`);
  return `second opinion skipped: ${parts.join(', ')}`;
}

/**
 * Runs the second opinion at a milestone gate. Always resolves.
 * See the export list at the top for the options and the result.
 */
async function runSecondOpinion(opts) {
  const o = isObj(opts) ? opts : {};
  const log = typeof o.log === 'function' ? o.log : noop;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  if (o.isGate !== true) return { skipped: true, note: 'second opinion skipped: not a milestone gate' };
  const started = now();
  let cli = null;
  const failed = (reason, detail) => {
    log(`${cli} second opinion failed: ${reason}`, detail);
    const why = detail ? `${reason} (${clip(detail, MAX_NOTE_CHARS)})` : reason;
    return {
      skipped: false, ok: false, cli, verdict: null, cards: [], warnings: [],
      notes: [`${cli || 'second opinion'} second opinion failed: ${why}`], durationMs: now() - started,
    };
  };
  try {
    const detect = typeof o.detect === 'function' ? o.detect : (name) => detectCli(name, { env: o.env });
    const pick = await pickCli(o.order, detect);
    if (!pick.cli) return { skipped: true, note: skippedNote(pick.tried) };
    cli = pick.cli;
    const spec = SECOND_OPINION_CLIS[cli];
    const runner = typeof o.runCli === 'function' ? o.runCli : execCli;
    const call = await runner({
      cli,
      command: spec.command,
      args: [...spec.args],
      prompt: buildSecondOpinionPrompt(o.inputs),
      cwd: o.cwd,
      env: o.env,
      timeoutMs: o.timeoutMs || SECOND_OPINION_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return failed((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parseCliOutput(call.stdout);
    if (!parsed.ok) return failed(parsed.error);
    const critique = validateCritique(parsed.raw, { ideasAllowed: o.ideasAllowed === true, allPassed: o.allPassed === true });
    if (critique.errors.length) return failed(critique.errors[0].code);
    return {
      skipped: false, ok: true, cli, verdict: critique.verdict, cards: critique.cards,
      warnings: critique.warnings, notes: [], durationMs: now() - started,
    };
  } catch (err) {
    return failed('crashed', err && err.message);
  }
}

module.exports = {
  DEFAULT_ORDER,
  SECOND_OPINION_CLIS,
  SECOND_OPINION_SOURCE,
  detectCli,
  pickCli,
  buildSecondOpinionPrompt,
  parseCliOutput,
  textSimilarity,
  mergeFindings,
  gateVerdict,
  execCli,
  runSecondOpinion,
};
