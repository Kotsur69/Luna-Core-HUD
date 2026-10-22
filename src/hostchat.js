// ============================================================================
// LunaCore - live Claude Code chat driven from the phone (main, host mode)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H2 and "H2 protocol (probed)". One `claude` child
// per session, in stream-json mode, with the host's own login, settings,
// CLAUDE.md, skills, plugins and MCP servers. Max 2 live sessions per host.
//
//   chat.start     {repoId, prompt, model?, mode?, approvalTimeout?}
//   chat.send      {sessionId, text}
//   chat.approve   {requestId, decision: allow | deny | always, card}
//                  card = {tool, summary, preview} as the phone showed it;
//                  anything but the card this host emitted is refused
//   chat.interrupt {sessionId}
//   chat.end       {sessionId}
//   chat.resume    {sessionId, prompt?, repoId?}
//
// Handlers for src/hostcommands.js (registered next to src/hostactions.js),
// so each runs only after src/hostauth.js verified the signature. The payload
// is still untrusted: the cwd comes from the host's own repo list by id (the
// phone never sends a path) and must sit under the repos root or a host-local
// allow-list (src/hostrepos.js chatDirOf); model and mode are allow-listed here.
// Secrets are scrubbed before a clip, so a clip never leaves half a key behind.
//
// What the child does goes out as host_events (src/hostevents.js) and, on a
// full HUD, to listeners (onEvent) that show the session as a read-only tab.
// An unanswered approval waits forever unless the session was started with
// approvalTimeout (minutes): then it is denied after that long.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { clip, cleanCard, RESULT_BYTES } = require('./hostevents');
const { scrub } = require('./hostscrub');

const MAX_SESSIONS = 2;
const MAX_PROMPT = 20000;
const MAX_TIMEOUT_MIN = 24 * 60;
const KILL_GRACE_MS = 5000;
const MAX_KNOWN = 50;
const MAX_PREVIEW_LINES = 40;
const MODELS = { sonnet: 'sonnet', opus: 'opus' };
const MODES = ['default', 'acceptEdits', 'plan'];
const DECISIONS = ['allow', 'deny', 'always'];
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{1,80}$/;
const DENY_MESSAGE = 'Denied from the phone';
const CARD_FIELDS = ['tool', 'summary', 'preview'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The absolute path of the claude CLI from the absolute PATH entries, never
 * a bare 'claude': on Windows a bare name is looked up in the child's cwd
 * (the repo) before PATH, so a `claude.exe` committed to a cloned repo would
 * run instead of the CLI. A match inside `cwd` is refused. null = not found.
 */
function claudePath(env, cwd, { platform = process.platform, isFile = (f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() === true } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const key = Object.keys(env || {}).find((k) => k.toLowerCase() === 'path');
  const dirs = String((key && env[key]) || '').split(platform === 'win32' ? ';' : ':');
  const names = platform === 'win32' ? ['claude.exe'] : ['claude'];
  const root = cwd ? p.resolve(cwd) : null;
  for (const dir of dirs) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const resolved = p.resolve(dir);
    if (root) {
      const rel = p.relative(root, resolved);
      if (!rel || (!rel.startsWith('..') && !p.isAbsolute(rel))) continue;
    }
    for (const name of names) {
      const file = p.join(resolved, name);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** The approval the phone signed must name the card it showed: what the host emitted, field by field. */
function sameCard(shown, card) {
  return isObject(shown) && isObject(card) && CARD_FIELDS.every((k) => shown[k] === card[k]);
}

// ---- pure parts (test/hostchat.test.js) ------------------------------------

/**
 * A chat.start / chat.resume payload -> {model, mode, approvalTimeoutMs} or
 * {error}. Unknown values are refused, not defaulted: the phone shows them.
 */
function sessionOptions(p) {
  const model = p.model === undefined || p.model === null ? 'sonnet' : p.model;
  if (!Object.hasOwn(MODELS, model)) return { error: 'refused: model' };
  const mode = p.mode === undefined || p.mode === null ? 'default' : p.mode;
  if (!MODES.includes(mode)) return { error: 'refused: mode' };
  const t = p.approvalTimeout === undefined || p.approvalTimeout === null ? 0 : p.approvalTimeout;
  if (!Number.isInteger(t) || t < 0 || t > MAX_TIMEOUT_MIN) return { error: 'refused: approvalTimeout' };
  return { model, mode, approvalTimeoutMs: t * 60 * 1000 };
}

/** The claude CLI flags of a session (probed: no --permission-mode for "default"). */
function chatArgs({ model, mode, sessionId, resume = false }) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    '--model', MODELS[model],
    ...(mode && mode !== 'default' ? ['--permission-mode', mode] : []),
    resume ? '--resume' : '--session-id', sessionId,
  ];
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

/** A file path the phone may see: relative to the repo, else just its name. */
function shownPath(file, cwd) {
  if (typeof file !== 'string' || !file) return '';
  const rel = cwd ? path.relative(cwd, file) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return path.basename(file);
}

/** What a tool call is about, in one line: the command, the file or the pattern. */
function toolSummary(name, input, cwd) {
  const i = isObject(input) ? input : {};
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return shownPath(i.file_path, cwd);
  if (typeof i.notebook_path === 'string') return shownPath(i.notebook_path, cwd);
  if (typeof i.pattern === 'string') return i.pattern;
  if (typeof i.url === 'string') return i.url;
  if (typeof i.description === 'string') return i.description;
  return name || '';
}

const firstLines = (text, prefix) =>
  String(text).split('\n').slice(0, MAX_PREVIEW_LINES).map((l) => prefix + l).join('\n');

/** The approval card's preview: a small diff for edits, the head of a write, else ''. */
function toolPreview(name, input) {
  const i = isObject(input) ? input : {};
  let text = '';
  if (typeof i.old_string === 'string' && typeof i.new_string === 'string') text = `${firstLines(i.old_string, '- ')}\n${firstLines(i.new_string, '+ ')}`;
  else if (Array.isArray(i.edits)) text = i.edits.filter(isObject).map((e) => `${firstLines(e.old_string || '', '- ')}\n${firstLines(e.new_string || '', '+ ')}`).join('\n…\n');
  else if (typeof i.content === 'string') text = firstLines(i.content, '+ ');
  return text ? clip(scrub(text)).text : '';
}

/** A tool_result's content (string or blocks) -> plain text. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * One parsed stdout line -> what it means for the session:
 *   [{type: 'text', text}, {type: 'tool', id, name, summary},
 *    {type: 'tool_result', id, text, isError}, {type: 'permission', requestId, tool, input, suggestions},
 *    {type: 'cancel', requestId}, {type: 'result', isError, interrupted, usd, turns}]
 * Unknown lines -> [].
 */
function translate(msg, { cwd = '' } = {}) {
  if (!isObject(msg)) return [];
  if (msg.type === 'stream_event') {
    const d = isObject(msg.event) && isObject(msg.event.delta) ? msg.event.delta : null;
    return d && d.type === 'text_delta' && typeof d.text === 'string' && !msg.parent_tool_use_id ? [{ type: 'text', text: d.text }] : [];
  }
  if (msg.type === 'assistant' && isObject(msg.message) && Array.isArray(msg.message.content)) {
    if (msg.parent_tool_use_id) return []; // a subagent's inner calls stay on the host
    return msg.message.content
      .filter((b) => isObject(b) && b.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => ({ type: 'tool', id: String(b.id || ''), name: b.name, summary: toolSummary(b.name, b.input, cwd) }));
  }
  if (msg.type === 'user' && isObject(msg.message) && Array.isArray(msg.message.content)) {
    if (msg.parent_tool_use_id) return [];
    return msg.message.content
      .filter((b) => isObject(b) && b.type === 'tool_result')
      .map((b) => ({ type: 'tool_result', id: String(b.tool_use_id || ''), text: resultText(b.content), isError: b.is_error === true }));
  }
  if (msg.type === 'control_request' && isObject(msg.request) && msg.request.subtype === 'can_use_tool') {
    if (typeof msg.request_id !== 'string' || !REQUEST_RE.test(msg.request_id)) return [];
    const r = msg.request;
    return [{
      type: 'permission',
      requestId: msg.request_id,
      tool: typeof r.tool_name === 'string' ? r.tool_name : '?',
      input: isObject(r.input) ? r.input : {},
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
    }];
  }
  if (msg.type === 'control_cancel_request' && typeof msg.request_id === 'string') return [{ type: 'cancel', requestId: msg.request_id }];
  if (msg.type === 'result') {
    return [{
      type: 'result',
      isError: msg.is_error === true,
      interrupted: msg.subtype === 'error_during_execution',
      usd: Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : null,
      turns: Number.isInteger(msg.num_turns) ? msg.num_turns : null,
    }];
  }
  return [];
}

/** The control_response for a permission answer (probed shapes). */
function permissionResponse(requestId, decision, { input, suggestions, message } = {}) {
  const response = decision === 'deny'
    ? { behavior: 'deny', message: message || DENY_MESSAGE }
    : { behavior: 'allow', updatedInput: input || {}, ...(decision === 'always' ? { updatedPermissions: suggestions || [] } : {}) };
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

// ---- runtime ---------------------------------------------------------------

/**
 * @param {{
 *   spawn: Function,                         child_process.spawn (or a fake)
 *   repoDir: (repoId: string) => string|{dir?: string, error?: string}|null,
 *                                            the host's own repo list: a cloned project's folder,
 *                                            or why it may not be used (that error reaches the phone)
 *   env: () => object,                       the claude CLI's env
 *   events: {text: Function, emit: Function, forget: Function},  src/hostevents.js
 *   randomUUID: () => string,
 *   notify?: (kind: 'approval'|'done'|'failed', info: {sessionId: string, key: string}) => void,
 *   onSessionsChanged?: () => void,          the heartbeat lists live sessions
 *   setTimer?: Function, clearTimer?: Function,
 *   log?: (line: string) => void,
 *   maxSessions?: number,
 * }} deps
 */
function createHostChat(deps) {
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || ((l) => console.error(l));
  const maxSessions = deps.maxSessions || MAX_SESSIONS;
  const resolveClaude = deps.claudePath || ((env, cwd) => claudePath(env, cwd));
  // Callbacks into the host must never throw into a session's teardown.
  const guard = (fn, what) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      log(`[hostchat] ${what} failed: ${err && err.message}`);
    }
  };
  const notify = guard(deps.notify || (() => {}), 'notify');
  const changed = guard(deps.onSessionsChanged || (() => {}), 'onSessionsChanged');
  /** sessionId -> live session */
  const live = new Map();
  /** sessionId -> {repoId, model, mode, approvalTimeoutMs}: what chat.resume needs, newest last */
  const known = new Map();
  /** HUD tab listeners: (sessionId, kind, data, meta) */
  const listeners = new Set();

  function remember(sessionId, info) {
    known.delete(sessionId);
    known.set(sessionId, info);
    while (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  }

  function emit(s, kind, data) {
    deps.events.emit(s.id, kind, data);
    for (const fn of listeners) {
      try {
        fn(s.id, kind, data, { repoId: s.repoId, name: s.name });
      } catch (err) {
        log(`[hostchat] listener failed: ${err.message}`);
      }
    }
  }

  function setStatus(s, status, reason) {
    if (s.status === status && !reason) return;
    s.status = status;
    emit(s, 'status', reason ? { status, reason } : { status });
    changed();
  }

  function write(s, obj) {
    if (s.ended || s.endRequested || !s.child.stdin || s.child.stdin.destroyed || s.child.stdin.writableEnded) return false;
    try {
      s.child.stdin.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
      return true;
    } catch (err) {
      log(`[hostchat] write failed: ${err.message}`);
      return false;
    }
  }

  function answer(s, requestId, decision, extra = {}) {
    const p = s.pending.get(requestId);
    if (!p) return false;
    clearTimer(p.timer);
    s.pending.delete(requestId);
    const shape = decision === 'timeout' ? 'deny' : decision;
    write(s, permissionResponse(requestId, shape, { input: p.input, suggestions: p.suggestions, ...extra }));
    emit(s, 'decision', { requestId, decision });
    if (!s.pending.size && s.status === 'waiting') setStatus(s, 'working');
    return true;
  }

  function onPermission(s, a) {
    const card = cleanCard({ requestId: a.requestId, tool: a.tool, summary: toolSummary(a.tool, a.input, s.cwd), preview: toolPreview(a.tool, a.input) });
    const timer = s.approvalTimeoutMs
      ? setTimer(() => answer(s, a.requestId, 'timeout', { message: `No answer from the phone in ${Math.round(s.approvalTimeoutMs / 60000)} min` }), s.approvalTimeoutMs)
      : null;
    s.pending.set(a.requestId, { input: a.input, suggestions: a.suggestions, timer, card });
    emit(s, 'permission', card);
    setStatus(s, 'waiting');
    notify('approval', { sessionId: s.id, key: `approval:${a.requestId}` });
  }

  /** A turn ended: one notification, keyed so it fires once. */
  function finished(s, kind) {
    // Per launch: a resumed session counts turns from 0 again, and a reused key never fires twice.
    notify(kind, { sessionId: s.id, key: `${kind}:${s.id}:${s.launch}:${s.turn}` });
    s.turn++;
  }

  function dropPending(s, decision) {
    for (const [requestId, p] of s.pending) {
      clearTimer(p.timer);
      emit(s, 'decision', { requestId, decision });
    }
    s.pending.clear();
  }

  function onLine(s, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol line (a warning on stdout)
    }
    for (const a of translate(msg, { cwd: s.cwd })) {
      if (a.type === 'text') {
        deps.events.text(s.id, a.text);
        for (const fn of listeners) {
          try {
            fn(s.id, 'text', { text: a.text }, { repoId: s.repoId, name: s.name });
          } catch (err) {
            log(`[hostchat] listener failed: ${err.message}`);
          }
        }
      } else if (a.type === 'tool') emit(s, 'tool', { id: a.id, name: a.name, summary: a.summary });
      else if (a.type === 'tool_result') {
        const c = clip(scrub(a.text), RESULT_BYTES);
        emit(s, 'tool_result', { id: a.id, text: c.text, isError: a.isError, clipped: c.clipped });
      } else if (a.type === 'permission') onPermission(s, a);
      else if (a.type === 'cancel') {
        const p = s.pending.get(a.requestId);
        if (p) {
          clearTimer(p.timer);
          s.pending.delete(a.requestId);
          emit(s, 'decision', { requestId: a.requestId, decision: 'cancelled' });
        }
      } else if (a.type === 'result') {
        dropPending(s, 'cancelled');
        emit(s, 'cost', { usd: a.usd, turns: a.turns });
        const failed = a.isError && !a.interrupted && !s.interrupting;
        s.interrupting = false;
        setStatus(s, failed ? 'error' : 'done', a.interrupted ? 'interrupted' : undefined);
        finished(s, failed ? 'failed' : 'done');
      }
    }
  }

  /** Removes everything a session holds: timers, listeners, the child. */
  function cleanup(s) {
    if (s.cleaned) return;
    s.cleaned = true;
    s.ended = true;
    dropPending(s, 'cancelled');
    clearTimer(s.killTimer);
    if (s.rl) s.rl.close();
    s.child.removeAllListeners('exit');
    s.child.removeAllListeners('error');
    if (s.child.stdout) s.child.stdout.removeAllListeners('data');
    if (s.child.stderr) s.child.stderr.removeAllListeners('data');
    live.delete(s.id);
    deps.events.forget(s.id);
    changed();
  }

  function onExit(s, code) {
    if (s.cleaned) return;
    if (!s.endRequested) {
      setStatus(s, 'error', code === 0 ? 'exited' : `exit ${code}`);
      finished(s, 'failed');
      log(`[hostchat] session ${s.id} exited (${code})`);
    } else {
      setStatus(s, 'done', 'ended');
    }
    cleanup(s);
  }

  function launch({ sessionId, repoId, opts, resume, prompt }) {
    const found = deps.repoDir(repoId);
    const cwd = typeof found === 'string' ? found : found && found.dir;
    if (!cwd) return { status: (found && typeof found.error === 'string' && found.error) || 'refused: unknown repo' };
    const env = deps.env();
    const command = resolveClaude(env, cwd);
    if (!command) {
      log('[hostchat] claude not found on PATH');
      return { status: 'failed: no claude' };
    }
    let child;
    try {
      child = deps.spawn(command, chatArgs({ ...opts, sessionId, resume }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      log(`[hostchat] spawn failed: ${err.message}`);
      return { status: 'failed: spawn' };
    }
    const s = {
      id: sessionId,
      repoId,
      name: path.basename(cwd),
      cwd,
      child,
      status: null,
      pending: new Map(),
      approvalTimeoutMs: opts.approvalTimeoutMs,
      ended: false,
      endRequested: false,
      interrupting: false,
      cleaned: false,
      killTimer: null,
      rl: null,
      stderrTail: '',
      turn: 0,
      launch: deps.randomUUID().slice(0, 8),
    };
    live.set(sessionId, s);
    remember(sessionId, { repoId, ...opts });
    // EPIPE / write-after-end on a dying child's stdin is an 'error' event: unhandled, it would take the host down.
    if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', (err) => log(`[hostchat] session ${sessionId} stdin: ${err.code || err.message}`));
    s.rl = readline.createInterface({ input: child.stdout });
    s.rl.on('line', (line) => onLine(s, line));
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        s.stderrTail = (s.stderrTail + String(d)).slice(-2000);
      });
    }
    child.on('error', (err) => {
      log(`[hostchat] session ${sessionId}: ${err.code === 'ENOENT' ? 'claude not found' : err.message}`);
      if (!s.cleaned) {
        setStatus(s, 'error', err.code === 'ENOENT' ? 'no claude' : 'spawn error');
        finished(s, 'failed');
        cleanup(s);
      }
    });
    child.on('exit', (code) => onExit(s, code));
    setStatus(s, 'working');
    if (prompt) {
      emit(s, 'prompt', { text: prompt });
      write(s, userLine(prompt));
    }
    return { status: resume ? 'resumed' : 'started', sessionId };
  }

  const validPrompt = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_PROMPT;
  const full = () => live.size >= maxSessions;

  function liveSession(p) {
    const id = p && p.sessionId;
    return typeof id === 'string' && live.has(id) ? live.get(id) : null;
  }

  async function start(p) {
    if (!isObject(p) || typeof p.repoId !== 'string' || !ID_RE.test(p.repoId)) return { status: 'refused: repoId' };
    if (!validPrompt(p.prompt)) return { status: 'refused: prompt' };
    const opts = sessionOptions(p);
    if (opts.error) return { status: opts.error };
    if (full()) return { status: 'refused: too many sessions' };
    return launch({ sessionId: deps.randomUUID(), repoId: p.repoId, opts, resume: false, prompt: p.prompt });
  }

  async function resume(p) {
    if (!isObject(p) || typeof p.sessionId !== 'string' || !SESSION_RE.test(p.sessionId)) return { status: 'refused: sessionId' };
    if (live.has(p.sessionId)) return { status: 'refused: already running' };
    if (p.prompt !== undefined && !validPrompt(p.prompt)) return { status: 'refused: prompt' };
    const k = known.get(p.sessionId);
    const repoId = k ? k.repoId : p.repoId;
    if (typeof repoId !== 'string' || !ID_RE.test(repoId)) return { status: 'refused: unknown session' };
    const opts = sessionOptions({ ...(k || {}), ...p, approvalTimeout: p.approvalTimeout ?? (k ? k.approvalTimeoutMs / 60000 : undefined) });
    if (opts.error) return { status: opts.error };
    if (full()) return { status: 'refused: too many sessions' };
    // The session's earlier rows hold seq 0..n: new ones continue after them, or the unique index drops them all.
    if (typeof deps.events.continueSession === 'function') await deps.events.continueSession(p.sessionId);
    if (live.has(p.sessionId) || full()) return { status: 'refused: too many sessions' };
    return launch({ sessionId: p.sessionId, repoId, opts, resume: true, prompt: p.prompt });
  }

  async function send(p) {
    const s = liveSession(p);
    if (!s) return { status: 'refused: no session' };
    if (!validPrompt(p.text)) return { status: 'refused: text' };
    if (!write(s, userLine(p.text))) return { status: 'failed: closed' };
    emit(s, 'prompt', { text: p.text });
    setStatus(s, 'working');
    return { status: 'sent' };
  }

  async function approve(p) {
    if (!isObject(p) || typeof p.requestId !== 'string' || !REQUEST_RE.test(p.requestId)) return { status: 'refused: requestId' };
    if (!DECISIONS.includes(p.decision)) return { status: 'refused: decision' };
    for (const s of live.values()) {
      const pending = s.pending.get(p.requestId);
      if (!pending) continue;
      // host_events rows can be edited by anyone holding the cloud session: an
      // approval counts only for the card this host actually emitted.
      if (!sameCard(p.card, pending.card)) {
        log(`[hostchat] approval for ${p.requestId} names a different card, refused`);
        return { status: 'refused: card mismatch' };
      }
      return answer(s, p.requestId, p.decision) ? { status: 'answered' } : { status: 'failed' };
    }
    return { status: 'refused: no such request' };
  }

  async function interrupt(p) {
    const s = liveSession(p);
    if (!s) return { status: 'refused: no session' };
    s.interrupting = true;
    write(s, { type: 'control_request', request_id: `int-${deps.randomUUID()}`, request: { subtype: 'interrupt' } });
    return { status: 'interrupting' };
  }

  function endSession(s) {
    s.endRequested = true;
    clearTimer(s.killTimer);
    try {
      if (s.child.stdin && !s.child.stdin.destroyed) s.child.stdin.end();
    } catch {
      // Already closed: the kill below still ends the child.
    }
    s.killTimer = setTimer(() => {
      try {
        s.child.kill();
      } catch {
        // Gone already.
      }
    }, KILL_GRACE_MS);
  }

  async function end(p) {
    const s = liveSession(p);
    if (!s) return { status: 'refused: no session' };
    endSession(s);
    return { status: 'ending' };
  }

  return {
    handlers: {
      'chat.start': start,
      'chat.send': send,
      'chat.approve': approve,
      'chat.interrupt': interrupt,
      'chat.end': end,
      'chat.resume': resume,
    },
    /** For the heartbeat: [{id, repoId, status}]. */
    sessions: () => [...live.values()].map((s) => ({ id: s.id, repoId: s.repoId, status: s.status || 'working' })),
    /** HUD tabs: fn(sessionId, kind, data, {repoId, name}); returns an unsubscribe. */
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Host stop: every child ends, every timer and listener goes. */
    stopAll() {
      for (const s of [...live.values()]) {
        endSession(s);
        try {
          s.child.kill();
        } catch {
          // Gone already.
        }
        cleanup(s);
      }
      listeners.clear();
    },
  };
}

module.exports = {
  createHostChat,
  sessionOptions,
  chatArgs,
  claudePath,
  sameCard,
  translate,
  toolSummary,
  toolPreview,
  shownPath,
  permissionResponse,
  MAX_SESSIONS,
  MODES,
};
