// ============================================================================
// LunaCore - task intake MCP server (ORCHESTRATOR_PLAN.md, build slice 0)
// ----------------------------------------------------------------------------
// "Describe it to Claude, it lands in To-do." A tiny MCP server, hosted by the
// main process, that lets the `claude` running in a LunaCore tab write task
// cards straight into THAT tab's project to-do list.
//
// Transport: MCP Streamable HTTP, the stateless subset - every JSON-RPC POST
// gets a plain application/json answer, no SSE stream, no Mcp-Session-Id.
// That is all three tools need, and it keeps the server dependency-free.
//
// Identity: one random bearer token PER SESSION. The tab's generated
// --mcp-config file carries it; main resolves token -> session -> projectId on
// every call, so Claude never passes a path or an id it could get wrong, and
// a tab can only ever write its own project's list.
//
// Boundaries (same posture as src/lmstudioshim.js): binds 127.0.0.1 only,
// rejects foreign Host headers and any Origin header (DNS rebinding / browser
// pages), requires the bearer token on every request, caps the body, and
// never logs request contents. What the token does not stop: processes of the
// same OS user, which can read the config file - the same limit the shim has.
//
// The tool logic (applyAdd / applyUpdate / listView) is pure and exported so
// it is unit-testable without a socket; IntakeServer only does HTTP + auth.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { normalizeTodo, normalizeTodos, MAX_ITEMS } = require('./todo');

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** Cards one luna_todo_add call may create - a plan, not a backlog import. */
const MAX_TASKS_PER_CALL = 20;
/** Protocol revisions this server speaks; the first is offered by default. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'lunacore';

// Fields a card may carry besides `text` - the ones luna_todo_update may touch.
const CARD_FIELDS = ['details', 'acceptance', 'files', 'verify', 'size', 'model', 'dependsOn'];

// --- tool definitions ---------------------------------------------------------

const CARD_PROPERTIES = {
  details: {
    type: 'string',
    description: 'Self-contained instructions: a worker with NO other context must be able to do the task from this alone.',
  },
  acceptance: {
    type: 'array',
    items: { type: 'string' },
    description: 'Concrete, checkable definition-of-done bullets.',
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Repo-relative paths the task will most likely touch.',
  },
  verify: { type: 'string', description: 'Command that proves it works, e.g. "npm test".' },
  size: { type: 'string', enum: ['S', 'M', 'L'], description: 'S < 30 min, M < 2 h, L larger.' },
  model: { type: 'string', enum: ['sonnet', 'opus'], description: 'Suggested worker model.' },
};

const TOOLS = [
  {
    name: 'luna_todo_add',
    description:
      "Append task cards to the user's LunaCore To-do list for the project this terminal is in. " +
      'Use when the user asks to plan, queue or note down work. Does not implement anything.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TASKS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Short imperative title (one line).' },
              ...CARD_PROPERTIES,
              dependsOn: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Tasks this one needs first: a 0-based index into THIS tasks array, or the `at` id of an existing card.',
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'luna_todo_list',
    description: "Read this project's LunaCore To-do list (to avoid duplicates, or to answer what is queued).",
    inputSchema: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'Also return completed items. Default false.' },
      },
    },
  },
  {
    name: 'luna_todo_update',
    description:
      'Refine one existing card, identified by its `at` id from luna_todo_list. ' +
      'Only the fields given change; null removes a field. Cannot mark a card done.',
    inputSchema: {
      type: 'object',
      properties: {
        at: { type: 'number', description: 'The card id (`at`) from luna_todo_list.' },
        patch: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            ...CARD_PROPERTIES,
            dependsOn: { type: 'array', items: { type: 'number' }, description: '`at` ids of other cards.' },
            original: {
              type: 'string',
              description:
                "The user's loose note this card was rewritten from. Set once; ignored if the card already has one.",
            },
          },
        },
      },
      required: ['at', 'patch'],
    },
  },
];

// --- pure tool logic ----------------------------------------------------------

/**
 * Picks `at` ids for `count` new cards: strictly increasing, never colliding
 * with an existing card, and roughly "now" so they sort like hand-added ones.
 */
function freshAts(list, count, now) {
  const maxExisting = list.reduce((m, item) => Math.max(m, Number(item.at) || 0), 0);
  const start = Math.max(now, maxExisting + 1);
  return Array.from({ length: count }, (_v, i) => start + i);
}

/**
 * Resolves luna_todo_add's dependsOn: a small integer is an index into the
 * same batch, anything else must be an existing card's `at`.
 * @returns {{ok:true, deps:number[]}|{ok:false, error:string}}
 */
function resolveBatchDeps(raw, selfIndex, batchAts, existingAts) {
  if (raw === undefined || raw === null) return { ok: true, deps: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `tasks[${selfIndex}].dependsOn must be an array` };
  const deps = [];
  for (const ref of raw) {
    if (typeof ref !== 'number' || !Number.isFinite(ref)) {
      return { ok: false, error: `tasks[${selfIndex}].dependsOn holds a non-number` };
    }
    const isIndex = Number.isInteger(ref) && ref >= 0 && ref < batchAts.length;
    if (isIndex && ref === selfIndex) return { ok: false, error: `tasks[${selfIndex}] depends on itself` };
    const at = isIndex ? batchAts[ref] : ref;
    if (!isIndex && !existingAts.has(at)) {
      return { ok: false, error: `tasks[${selfIndex}].dependsOn: no card with at=${ref}` };
    }
    if (!deps.includes(at)) deps.push(at);
  }
  return { ok: true, deps };
}

/**
 * luna_todo_add on a list. Never mutates `list`.
 * @param {Array} list current (normalized) list
 * @param {unknown} tasks the tool's `tasks` argument
 * @param {number} now
 * @returns {{ok:true, list:Array, added:Array}|{ok:false, error:string}}
 */
function applyAdd(list, tasks, now) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, error: 'tasks must be a non-empty array' };
  if (tasks.length > MAX_TASKS_PER_CALL) {
    return { ok: false, error: `at most ${MAX_TASKS_PER_CALL} tasks per call` };
  }
  if (list.length + tasks.length > MAX_ITEMS) {
    return { ok: false, error: `the list holds at most ${MAX_ITEMS} items (${list.length} already)` };
  }
  const batchAts = freshAts(list, tasks.length, now);
  const existingAts = new Set(list.map((item) => item.at));
  const added = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (!task || typeof task !== 'object') return { ok: false, error: `tasks[${i}] must be an object` };
    const deps = resolveBatchDeps(task.dependsOn, i, batchAts, existingAts);
    if (!deps.ok) return deps;
    const card = normalizeTodo({ ...task, done: false, at: batchAts[i], dependsOn: deps.deps });
    if (!card) return { ok: false, error: `tasks[${i}].text must be a non-empty string` };
    added.push(card);
  }
  return { ok: true, list: [...list, ...added], added };
}

/**
 * luna_todo_update on a list. Never mutates `list`.
 * @returns {{ok:true, list:Array, card:object}|{ok:false, error:string}}
 */
function applyUpdate(list, at, patch) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return { ok: false, error: 'at must be a number' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };
  const index = list.findIndex((item) => item.at === at);
  if (index < 0) return { ok: false, error: `no card with at=${at}` };

  if (Array.isArray(patch.dependsOn)) {
    const others = new Set(list.filter((item) => item.at !== at).map((item) => item.at));
    const unknown = patch.dependsOn.filter((ref) => !others.has(ref));
    if (unknown.length) return { ok: false, error: `dependsOn: no other card with at=${unknown.join(', ')}` };
  }

  const current = list[index];
  const removed = new Set(CARD_FIELDS.filter((key) => patch[key] === null));
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !removed.has(key)));
  const changes = Object.fromEntries(
    ['text', ...CARD_FIELDS].filter((key) => key in patch && patch[key] !== null).map((key) => [key, patch[key]]),
  );
  // `original` is write-once and not in CARD_FIELDS, so null cannot remove
  // it: it is the user's own words, the yardstick a later rewrite is
  // checked against, and no rewrite gets to move that yardstick.
  if (!current.original && typeof patch.original === 'string') changes.original = patch.original;
  // done/at are never patchable - ticking a card is the user's (or, later,
  // the run controller's) call, not the planning session's.
  const card = normalizeTodo({ ...kept, ...changes, done: current.done, at: current.at });
  if (!card) return { ok: false, error: 'patch.text must be a non-empty string' };
  return { ok: true, list: list.map((item, i) => (i === index ? card : item)), card };
}

/** luna_todo_list's view: open cards only unless asked otherwise. */
function listView(list, includeDone) {
  return includeDone === true ? list : list.filter((item) => !item.done);
}

// --- JSON-RPC -----------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function toolText(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * Runs one tool against a project's store.
 * @param {string} name
 * @param {object} args
 * @param {{read:() => Array, write:(list:Array) => boolean, now?:() => number}} store
 */
function callTool(name, args, store) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'luna_todo_list') return toolText(listView(normalizeTodos(store.read()), a.includeDone));

  let outcome;
  if (name === 'luna_todo_add') {
    outcome = applyAdd(normalizeTodos(store.read()), a.tasks, store.now ? store.now() : Date.now());
  } else if (name === 'luna_todo_update') {
    outcome = applyUpdate(normalizeTodos(store.read()), a.at, a.patch);
  } else {
    return null; // unknown tool - the caller answers with a protocol error
  }
  if (!outcome.ok) return toolText(outcome.error, true);
  if (!store.write(outcome.list)) return toolText('could not save the to-do list', true);
  return toolText(name === 'luna_todo_add' ? { added: outcome.added } : { updated: outcome.card });
}

/**
 * Answers one JSON-RPC message. Returns null for a notification (no reply).
 * @param {unknown} msg
 * @param {{read:Function, write:Function, now?:Function}} store
 * @param {string} version server version for serverInfo
 */
function handleRpc(msg, store, version = '0.0.0') {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  if (isNotification) return null;
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const result = callTool(params.name, params.arguments, store);
      return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// --- HTTP ---------------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** The bearer token from an Authorization header, or null. */
function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

class IntakeServer {
  /**
   * @param {{storeFor:(sessionId:string) => ({read:Function, write:Function}|null),
   *   version?:string, httpImpl?:Object}} opts storeFor resolves a session to
   *   its project's list store, or null once the session is gone.
   */
  constructor({ storeFor, version = '0.0.0', httpImpl = http }) {
    this.storeFor = storeFor;
    this.version = version;
    this.httpImpl = httpImpl;
    this.server = null;
    this.port = null;
    this.starting = null;
    this.sockets = new Set();
    // sha256(token) -> sessionId. Hashed so a lookup never compares the raw
    // secret byte by byte against attacker-chosen input.
    this.tokens = new Map();
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      const server = this.httpImpl.createServer((req, res) => this.handle(req, res));
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      server.once('error', () => {
        this.starting = null;
        resolve({ ok: false });
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve({ ok: true, url: this.url() });
      });
    });
    return this.starting;
  }

  async stop() {
    const pending = this.starting;
    this.starting = null;
    if (pending) await pending;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.tokens.clear();
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  url() {
    return this.port ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null;
  }

  /** A fresh token for a session, replacing any it had (a restarted tab). */
  issueToken(sessionId) {
    this.revoke(sessionId);
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(hashToken(token), sessionId);
    return token;
  }

  revoke(sessionId) {
    for (const [hash, id] of this.tokens) {
      if (id === sessionId) this.tokens.delete(hash);
    }
  }

  isAllowedHost(host) {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  handle(req, res) {
    req.on('error', () => res.destroy());
    const pathname = String(req.url || '').split('?')[0];
    // A browser page can reach loopback; the CLI never sends Origin.
    if (!this.isAllowedHost(req.headers.host) || req.headers.origin !== undefined || pathname !== MCP_PATH) {
      req.resume();
      sendJson(res, 403, rpcError(null, -32000, 'Forbidden'));
      return;
    }
    const token = bearerToken(req.headers.authorization);
    const sessionId = token ? this.tokens.get(hashToken(token)) : undefined;
    const store = sessionId ? this.storeFor(sessionId) : null;
    if (!store) {
      req.resume();
      sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'));
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      sendJson(res, 405, rpcError(null, -32000, 'Method not allowed'), { allow: 'POST' });
      return;
    }
    this.readBody(req, res, (body) => this.answer(res, body, store));
  }

  readBody(req, res, done) {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        sendJson(res, 413, rpcError(null, -32000, 'Request body too large'), { connection: 'close' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) done(Buffer.concat(chunks).toString('utf8'));
    });
  }

  answer(res, body, store) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = messages.map((msg) => handleRpc(msg, store, this.version)).filter((r) => r !== null);
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, Array.isArray(parsed) ? replies : replies[0]);
  }
}

/**
 * The --mcp-config document for one tab.
 * @param {string} url
 * @param {string} token
 */
function mcpConfigFor(url, token) {
  return {
    mcpServers: {
      [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
    },
  };
}

/**
 * Where one tab's --mcp-config file lives. `.local.json` so the repo's
 * config/*.local.json ignore rule keeps a dev clone's tokens out of git.
 * The session id is LunaCore's own `s<n>`, never user input.
 */
function sessionConfigPath(dir, sessionId) {
  return path.join(dir, `mcp-intake-${sessionId}.local.json`);
}

/**
 * Writes one tab's --mcp-config file.
 * @returns {string|null} its path, or null when it could not be written
 */
function writeSessionConfig(dir, sessionId, url, token, fsImpl = fs) {
  try {
    const file = sessionConfigPath(dir, sessionId);
    fsImpl.writeFileSync(file, JSON.stringify(mcpConfigFor(url, token)), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Deletes one tab's --mcp-config file; a missing file is fine. */
function removeSessionConfig(dir, sessionId, fsImpl = fs) {
  try {
    fsImpl.unlinkSync(sessionConfigPath(dir, sessionId));
  } catch {
    /* already gone, or never written */
  }
}

module.exports = {
  TOOLS,
  sessionConfigPath,
  writeSessionConfig,
  removeSessionConfig,
  MAX_TASKS_PER_CALL,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  TOOLS,
  freshAts,
  applyAdd,
  applyUpdate,
  listView,
  callTool,
  handleRpc,
  bearerToken,
  mcpConfigFor,
  IntakeServer,
};
