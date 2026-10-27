// ============================================================================
// LunaCore - minimal MCP client over Streamable HTTP (Unity MCP, LW 3.36b)
// ----------------------------------------------------------------------------
// Enough of the MCP client side to call tools on the Unity editor's MCP
// server: initialize (keeps the Mcp-Session-Id), notifications/initialized,
// tools/call, and a DELETE to end the session. A reply may come back as JSON
// or as an SSE stream (text/event-stream); both are read. No dependencies.
//
// One editor = one Unity MCP connection: callers open a session for the few
// calls they need and close it again, so a session is never held while
// someone else (the scene worker, the Playtester's bridge) needs the editor.
// ============================================================================

'use strict';

const PROTOCOL_VERSION = '2025-06-18';
const SESSION_HEADER = 'mcp-session-id';
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const CLOSE_TIMEOUT_MS = 5 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** True for an http URL on this machine - the editor's MCP server never lives elsewhere. */
function isLoopbackHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The JSON-RPC messages in an SSE body (`data:` lines, events split by a blank line). */
function parseSse(text) {
  const out = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // A keep-alive or a partial event: not a message.
    }
  }
  return out;
}

/**
 * @param {{url:string, fetch?:Function, timeoutMs?:number, clientName?:string}} opts
 * @returns {{callTool:(name:string, args:object)=>Promise<object>, close:()=>Promise<void>}}
 */
function createMcpHttpClient({ url, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, clientName = 'lunacore' }) {
  if (!isLoopbackHttpUrl(url)) throw new Error('Unity MCP url must be http on 127.0.0.1 / localhost');
  let session = null;
  let ready = null;
  let nextId = 1;

  async function post(message) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (session) headers[SESSION_HEADER] = session;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Error(`Unity MCP is not reachable at ${url} (${errText(err)}) - is the editor open with the MCP server running?`);
    }
    const sid = res.headers && typeof res.headers.get === 'function' ? res.headers.get(SESSION_HEADER) : null;
    if (sid) session = sid;
    if (message.id === undefined) {
      if (!res.ok && res.status !== 202) throw new Error(`Unity MCP answered HTTP ${res.status}`);
      return null;
    }
    if (!res.ok) throw new Error(`Unity MCP answered HTTP ${res.status}`);
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    const body = await res.text();
    let messages;
    try {
      messages = type.includes('text/event-stream') ? parseSse(body) : [JSON.parse(body)];
    } catch {
      throw new Error('Unity MCP sent a reply that is not JSON');
    }
    const reply = messages.find((m) => m && m.id === message.id);
    if (!reply) throw new Error('Unity MCP sent no reply');
    if (reply.error) throw new Error(`Unity MCP error: ${reply.error.message || reply.error.code}`);
    return reply.result;
  }

  function init() {
    if (!ready) {
      ready = (async () => {
        await post({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' } },
        });
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      })();
      // A failed handshake is retried on the next call, not cached.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  async function callTool(name, args = {}) {
    await init();
    return post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  }

  /** Ends the session; never throws. */
  async function close() {
    const sid = session;
    session = null;
    ready = null;
    if (!sid) return;
    try {
      await fetch(url, { method: 'DELETE', headers: { [SESSION_HEADER]: sid }, signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
    } catch {
      // The editor may already be gone; the session dies with it.
    }
  }

  return { callTool, close };
}

module.exports = {
  PROTOCOL_VERSION,
  SESSION_HEADER,
  isLoopbackHttpUrl,
  parseSse,
  createMcpHttpClient,
};
