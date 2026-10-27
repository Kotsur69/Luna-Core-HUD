// ============================================================================
// LunaCore - Playtester bridge: a stdio MCP server (LW 3.35 / 3.36b)
// ----------------------------------------------------------------------------
// The Playtester's headless `claude -p` starts this through the adapter's
// --mcp-config (with --strict-mcp-config, so it is the only MCP server). It
// advertises the narrow tool set of tools.js for one backend and forwards
// each validated call:
//
//   --backend electron --control <file>    the in-process wrapper's control
//                                          channel (port + token in <file>,
//                                          written by the electron adapter)
//   --backend unity --unity-url <url>      the Unity editor's MCP server, one
//                                          short session per call (unity.js)
//
// Screenshots come back as an image the model sees AND a PNG written into
// --evidence-dir under the sanitized name - the file validateReport() later
// accepts as evidence. Nothing else touches the disk.
//
// Run with ELECTRON_RUN_AS_NODE=1 under LunaCore's own binary (helpers/** is
// asar-unpacked). createBridge() is exported so the tests drive it directly.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { BACKENDS, TOOL_DEFS, checkArgs } = require('./tools');
const { callControl } = require('./control');
const { createMcpHttpClient, isLoopbackHttpUrl } = require('./mcp-http');
const { UNITY_MCP, unityCall } = require('./unity');

const SERVER_NAME = 'lunacore-playtest';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_RESULT_CHARS = 50000;
const MAX_LINE_CHARS = 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- evidence -----------------------------------------------------------------------

/**
 * Writes a base64 PNG as <evidenceDir>/<name>. `name` was validated by
 * tools.js; the resolved file must still sit directly in the evidence dir.
 * @returns {string} the absolute file path
 */
function saveScreenshot(evidenceDir, name, base64) {
  const root = path.resolve(evidenceDir);
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root || !/\.png$/i.test(file)) throw new Error('bad screenshot name');
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error('the app did not return a PNG image');
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

// ---- backends -----------------------------------------------------------------------

/** Reads {port, token} from the control file the electron adapter wrote. */
function readControl(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(raw) || !Number.isInteger(raw.port) || typeof raw.token !== 'string') throw new Error('bad control file');
  return { port: raw.port, token: raw.token };
}

/** Electron: every tool is the wrapper's tool of the same name. */
function electronBackend({ controlFile, call = callControl }) {
  return async (tool, args) => call(readControl(controlFile), tool, args);
}

/** Unity: each tool is one fixed Unity MCP call, in its own short session. */
function unityBackend({ connect, sleep = realSleep }) {
  const once = async (call) => {
    const client = connect();
    try {
      return await unityCall(client, call);
    } finally {
      await client.close();
    }
  };
  const handlers = {
    screenshot: () => once(UNITY_MCP.driver('screenshot')),
    game_state: () => once(UNITY_MCP.driver('state')),
    send_input: ({ steps }) => once(UNITY_MCP.driver('input', { steps })),
    console_errors: () => once(UNITY_MCP.console()),
    wait: async ({ ms }) => {
      await sleep(ms);
      return { waited: ms };
    },
  };
  return (tool, args) => handlers[tool](args);
}

// ---- MCP ----------------------------------------------------------------------------

const textItem = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { type: 'text', text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n(truncated)` : text };
};
const toolError = (message) => ({ content: [{ type: 'text', text: String(message).slice(0, 2000) }], isError: true });

/**
 * @param {{backend:string, evidenceDir:string, invoke:(tool:string, args:object)=>Promise<unknown>}} opts
 * @returns {{handle:(msg:unknown)=>Promise<object|null>, callTool:Function}}
 */
function createBridge({ backend, evidenceDir, invoke }) {
  if (!BACKENDS.includes(backend)) throw new Error(`unknown backend '${String(backend)}'`);
  if (typeof evidenceDir !== 'string' || !path.isAbsolute(evidenceDir)) throw new Error('evidence dir must be an absolute path');

  async function callTool(name, rawArgs) {
    const checked = checkArgs(backend, name, rawArgs);
    if (!checked.ok) return toolError(checked.error);
    let result;
    try {
      result = await invoke(name, checked.args);
    } catch (err) {
      return toolError(errText(err));
    }
    if (name !== 'screenshot') return { content: [textItem(result === undefined ? null : result)] };
    try {
      const png = isObj(result) ? result.png : null;
      saveScreenshot(evidenceDir, checked.args.name, png);
      const size = isObj(result) && result.width ? ` (${result.width}x${result.height})` : '';
      return {
        content: [
          { type: 'text', text: `Saved screenshot "${checked.args.name}"${size}. Cite exactly this file name as evidence.` },
          { type: 'image', data: png, mimeType: 'image/png' },
        ],
      };
    } catch (err) {
      return toolError(errText(err));
    }
  }

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  /** One JSON-RPC message in, the reply out (null for a notification). Never throws. */
  async function handle(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isObj(msg) && msg.id !== undefined ? fail(msg.id, -32600, 'invalid request') : null;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (!isRequest) return null; // notifications/initialized, cancellations...
    const params = isObj(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'initialize':
        return ok(msg.id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOL_DEFS[backend] });
      case 'tools/call':
        return ok(msg.id, await callTool(params.name, params.arguments));
      default:
        return fail(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  return { handle, callTool };
}

// ---- process ------------------------------------------------------------------------

/** --name value pairs; a flag without a value reads as ''. */
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) continue;
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    out[m[1]] = hasValue ? next : '';
    if (hasValue) i += 1;
  }
  return out;
}

function invokerFor(opts) {
  if (opts.backend === 'electron') {
    if (!opts.control || !path.isAbsolute(opts.control)) throw new Error('--control <absolute file> is required');
    return electronBackend({ controlFile: opts.control });
  }
  if (opts.backend === 'unity') {
    if (!isLoopbackHttpUrl(opts['unity-url'])) throw new Error('--unity-url must be http on 127.0.0.1 / localhost');
    return unityBackend({ connect: () => createMcpHttpClient({ url: opts['unity-url'], clientName: 'lunacore-playtester' }) });
  }
  throw new Error('--backend must be electron or unity');
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgv(argv);
  const bridge = createBridge({ backend: opts.backend, evidenceDir: opts['evidence-dir'], invoke: invokerFor(opts) });
  const write = (reply) => {
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE_CHARS) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'message too large' } });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    bridge.handle(msg).then(write, (err) => write({ jsonrpc: '2.0', id: isObj(msg) ? msg.id : null, error: { code: -32603, message: errText(err) } }));
  });
  lines.on('close', () => process.exit(0));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[luna-playtest-bridge] ${errText(err)}\n`);
    process.exit(2);
  }
}

module.exports = {
  createBridge,
  electronBackend,
  unityBackend,
  saveScreenshot,
  parseArgv,
};
