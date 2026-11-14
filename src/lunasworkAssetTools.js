// ============================================================================
// LunaCore - Luna's Work asset tools on the lunacore MCP server (main process)
// ----------------------------------------------------------------------------
// The asset worker of a Luna's Work build on a Unity project (the scene worker
// package, lunasworkScene.SCENE_WORKER_ID) reaches the asset pipeline
// (src/lunasworkAssetPipeline.js) through three tools on the MCP server every
// LunaCore tab already has (src/intake.js), next to luna_todo_* and memory_*:
//
//   luna_asset_blender      save the open Blender scene + FBX export + prefab
//   luna_asset_comfy        a ComfyUI draft from a repo workflow (art/comfyui/)
//   luna_asset_higgsfield   a paid Higgsfield final, booked against the run's cap
//
// Only a God Mode worker tab of the project Luna's Work is building gets them
// (main.js decides, then createAssetToolsFor); every other tab never sees
// them. The pipeline writes into the worker's own worktree, so the files ride
// in its commit.
//
// The real tool adapters live here, each small and dependency-free:
//
//   Blender     the Blender MCP add-on's socket (127.0.0.1, default port
//               9876): one JSON command {type: 'execute_code', params: {code}},
//               one JSON answer {status, result | message}. LunaCore sends only
//               the fixed export script of the pipeline, never model text.
//   Higgsfield  the `higgsfield` CLI: `generate cost` (credits) and `generate
//               create --wait --json`. Every argument is a validated plain
//               token; the prompt goes on stdin, never on a command line.
//   download    a Higgsfield result: https on port 443 only, no credentials,
//               no IP literal or local name; the host must resolve to public
//               addresses only (checked before every request, redirects
//               followed by hand, at most 3, each hop checked again); the body
//               is size-capped while it streams in, with one timeout for
//               the lot. Not caught here: a DNS answer that changes between
//               the check and the connect, and a proxy fetch is told to use
//               (HTTPS_PROXY / NODE_USE_ENV_PROXY), which resolves the host
//               itself. Either way the bytes must still prove to be an
//               image or a GLB before the pipeline writes anything.
//   ComfyUI     src/lunasworkComfy.js (loopback HTTP).
//   Unity       helpers/playtest-bridge/pipeline-http.js (the editor of the
//               worker's project folder).
//
// Per-PC settings (lunaswork-settings.local.json `assetTools`, normalized by
// lunasworkAssetPipeline.normalizeAssetTools): comfyuiPort, blenderPort,
// higgsfieldUsdPerCredit, artRoot.
// ============================================================================

'use strict';

const net = require('net');
const dns = require('dns');
const childProcess = require('child_process');
const { createAssetPipeline, KINDS, MODEL_KINDS, IMAGE_KINDS } = require('./lunasworkAssetPipeline');
const { createComfyClient, readCappedBody } = require('./lunasworkComfy');
const { createPipelineClient } = require('../helpers/playtest-bridge/pipeline-http');

const BLENDER_TOOL = 'luna_asset_blender';
const COMFY_TOOL = 'luna_asset_comfy';
const HIGGSFIELD_TOOL = 'luna_asset_higgsfield';
const BLENDER_HOST = '127.0.0.1';
const DEFAULT_BLENDER_PORT = 9876;
const BLENDER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BLENDER_REPLY_BYTES = 1024 * 1024;
const COST_TIMEOUT_MS = 60 * 1000;
const GENERATE_TIMEOUT_MS = 25 * 60 * 1000;
// The CLI's own wait, kept under the process timeout above.
const GENERATE_WAIT = '20m';
const MAX_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_URLS = 4;
const MAX_SEARCH_DEPTH = 5;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// A plain token never starts with '-', so a value cannot read as a CLI flag.
const CLI_TOKEN_RE = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|lan|home|localdomain|home\.arpa)$/;
// Addresses a result download must never reach: unspecified, loopback,
// private, carrier-grade NAT, link-local, documentation, benchmark,
// multicast, reserved, unique-local. BlockList also matches IPv4-mapped IPv6.
const NON_PUBLIC = (() => {
  const list = new net.BlockList();
  const v4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
  // IPv4-compatible (::/96), discard, Teredo, documentation and the local ranges.
  const v6 = [['::', 96], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
  // A v4 subnet as the 16-bit groups of its first address.
  const groups = (address) => {
    const [a, b, c, e] = address.split('.').map(Number);
    return [((a << 8) | b).toString(16), ((c << 8) | e).toString(16)];
  };
  for (const [address, prefix] of v4) {
    list.addSubnet(address, prefix, 'ipv4');
    const [hi, lo] = groups(address);
    // The same v4 ranges embedded in NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses.
    list.addSubnet(`64:ff9b::${hi}:${lo}`, 96 + prefix, 'ipv6');
    list.addSubnet(`2002:${hi}:${lo}::`, 16 + prefix, 'ipv6');
  }
  for (const [address, prefix] of v6) list.addSubnet(address, prefix, 'ipv6');
  return list;
})();
const FAILED_STATUSES = new Set(['failed', 'error', 'nsfw', 'canceled', 'cancelled']);
const CREDIT_KEYS = Object.freeze(['credits', 'total_credits', 'credit_cost', 'cost', 'price']);
// Result URL keys that are previews, not the result itself.
const PREVIEW_KEY_RE = /(thumb|min|preview|poster|avatar)/i;
const NO_HIGGSFIELD_KINDS = Object.freeze(['animation', 'audio', 'material']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = 300) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- MCP tool definitions -------------------------------------------------------------

const NAME_PROP = { type: 'string', description: 'The asset name as in design/ASSETS.md, e.g. "Ronin Hero". It names the files.' };
const PROMPT_PROP = { type: 'string', description: 'The generation prompt (the ASSETS.md spec plus the art direction).' };

const ASSET_TOOLS = Object.freeze([
  {
    name: BLENDER_TOOL,
    description: "Luna's Work asset pipeline: after you built the model in Blender through the Blender MCP, save the open Blender scene to art/blender/<slug>.blend, export it as FBX for Unity (-Z forward, Y up, scale applied) under the art root, import it through the Unity Pipeline and make its prefab. Logged in the run report.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind'],
      properties: { name: NAME_PROP, kind: { type: 'string', enum: [...MODEL_KINDS] }, prompt: PROMPT_PROP },
    },
  },
  {
    name: COMFY_TOOL,
    description: "Luna's Work asset pipeline: a DRAFT image from the local ComfyUI. Runs an API-format workflow from the repo's art/comfyui/ (\"{{prompt}}\" placeholder, seed set on every sampler), saves the images under the art root and the exact workflow + seed under art/comfyui/runs/, then imports them into Unity. Free; use it for drafts.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind', 'workflow'],
      properties: {
        name: NAME_PROP,
        kind: { type: 'string', enum: [...IMAGE_KINDS] },
        prompt: PROMPT_PROP,
        workflow: { type: 'string', description: 'A workflow file name in art/comfyui/, e.g. "concept.json".' },
        seed: { type: 'integer', minimum: 0, description: 'Optional; a fresh seed is picked and saved when omitted.' },
      },
    },
  },
  {
    name: HIGGSFIELD_TOOL,
    description: "Luna's Work asset pipeline: a paid FINAL from Higgsfield (concept art, textures, VFX, key art, or a GLB model). The cost is estimated and booked against this run's Higgsfield budget BEFORE it generates; \"capReached\" means stop using Higgsfield for this run. Saves (a name already used gets -v2, never an overwrite), imports into Unity and logs prompt, seed and cost. When a paid result cannot be saved, the answer carries its job id and URLs.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind', 'prompt', 'model'],
      properties: {
        name: NAME_PROP,
        kind: { type: 'string', enum: Object.keys(KINDS).filter((k) => !NO_HIGGSFIELD_KINDS.includes(k)) },
        prompt: PROMPT_PROP,
        model: { type: 'string', description: 'A Higgsfield model id (job set type), e.g. "gpt_image_2_6".' },
        params: { type: 'object', description: 'Optional plain model flags, e.g. {"aspect_ratio": "16:9", "resolution": "2k"}.' },
      },
    },
  },
]);
const TOOL_NAMES = new Set(ASSET_TOOLS.map((t) => t.name));

/**
 * One asset tool call. Null for a name that is not an asset tool.
 * @param {string} name
 * @param {object} args untrusted: the pipeline validates every field
 * @param {{blenderModel:Function, comfyDraft:Function, higgsfieldFinal:Function}} assets
 * @returns {null|Promise<{ok:true, payload:object}|{ok:false, error:object}>}
 */
function callAssetTool(name, args, assets) {
  if (!TOOL_NAMES.has(name)) return null;
  const a = isObj(args) ? args : {};
  const run = name === BLENDER_TOOL ? assets.blenderModel : name === COMFY_TOOL ? assets.comfyDraft : assets.higgsfieldFinal;
  return Promise.resolve()
    .then(() => run(a))
    .then((res) => (isObj(res) && res.ok ? { ok: true, payload: res } : { ok: false, error: isObj(res) ? res : { ok: false, error: 'failed' } }))
    .catch((err) => ({ ok: false, error: { ok: false, error: 'failed', detail: oneLine(errText(err)) } }));
}

// ---- Blender add-on socket ------------------------------------------------------------

/**
 * @param {{port?:number, net?:object, timeoutMs?:number}} [opts]
 * @returns {{executeCode:(code:string)=>Promise<unknown>}}
 */
function createBlenderClient(opts = {}) {
  const port = opts.port === undefined ? DEFAULT_BLENDER_PORT : opts.port;
  const netImpl = opts.net || net;
  const timeoutMs = opts.timeoutMs || BLENDER_TIMEOUT_MS;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the Blender MCP port must be 1-65535');

  function executeCode(code) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const socket = netImpl.createConnection({ host: BLENDER_HOST, port });
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      socket.setTimeout(timeoutMs, () => finish(new Error(`blender did not answer within ${Math.round(timeoutMs / 1000)} s`)));
      socket.on('error', (err) => finish(new Error(`blender not connected on ${BLENDER_HOST}:${port} (${err && err.code ? err.code : errText(err)}) - is Blender running with its MCP add-on?`)));
      socket.on('connect', () => socket.write(JSON.stringify({ type: 'execute_code', params: { code } })));
      socket.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BLENDER_REPLY_BYTES) {
          finish(new Error('blender answer too large'));
          return;
        }
        chunks.push(chunk);
        let reply;
        try {
          reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return; // not complete yet: wait for the next chunk
        }
        if (!isObj(reply)) finish(new Error('blender answered something that is not a JSON object'));
        else if (reply.status !== 'success') finish(new Error(`blender failed: ${oneLine(reply.message || reply.status, 300)}`));
        else finish(null, reply.result === undefined ? null : reply.result);
      });
      socket.on('end', () => finish(new Error('blender closed the connection without an answer')));
    });
  }

  return { executeCode };
}

// ---- Higgsfield CLI -------------------------------------------------------------------

/** argv flags of a validated request; null when a token is not plain. */
function cliFlags(params) {
  const out = [];
  for (const [k, v] of Object.entries(isObj(params) ? params : {})) {
    if (!CLI_TOKEN_RE.test(k) || !CLI_TOKEN_RE.test(String(v))) return null;
    out.push(`--${k}`, String(v));
  }
  return out;
}

/** Depth-limited walk over a parsed CLI answer. */
function walk(value, visit, depth = 0, key = '') {
  if (depth > MAX_SEARCH_DEPTH) return;
  visit(key, value);
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit, depth + 1, key));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) walk(v, visit, depth + 1, k);
}

/** The credit estimate in a `generate cost --json` answer, or NaN. */
function creditsOf(json) {
  if (typeof json === 'number' && Number.isFinite(json)) return json;
  let found = NaN;
  walk(json, (key, v) => {
    if (Number.isNaN(found) && CREDIT_KEYS.includes(key) && typeof v === 'number' && Number.isFinite(v)) found = v;
  });
  return found;
}

/** Status, job id, result URLs and seed of a `generate create --wait --json` answer. */
function jobResultOf(json) {
  const urls = [];
  let status = null;
  let jobId = null;
  let seed = null;
  walk(Array.isArray(json) ? json : [json], (key, v) => {
    if (key === 'status' && typeof v === 'string' && !status) status = v.toLowerCase();
    if ((key === 'id' || key === 'job_id') && typeof v === 'string' && !jobId) jobId = v;
    if (key === 'seed' && Number.isSafeInteger(v) && v >= 0 && seed === null) seed = v;
    if (typeof v === 'string' && /url$/i.test(key) && !PREVIEW_KEY_RE.test(key) && v.startsWith('https://') && !urls.includes(v)) urls.push(v);
  });
  return { status, jobId, seed, urls: urls.slice(0, MAX_URLS) };
}

/**
 * @param {{execFile?:Function, platform?:string, env?:object, bin?:string}} [opts]
 * @returns {{estimate:Function, generate:Function}}
 */
function createHiggsfieldCli(opts = {}) {
  const execFile = opts.execFile || childProcess.execFile;
  const platform = opts.platform || process.platform;
  const bin = opts.bin || 'higgsfield';

  /** Runs the CLI; the prompt is written to stdin. Resolves the parsed JSON answer. */
  function run(args, prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
      // An npm-installed CLI is a .cmd shim on Windows, which needs a shell; every
      // argument is a validated plain token, the prompt never is an argument.
      const child = execFile(bin, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
        windowsHide: true,
        shell: platform === 'win32',
        env: opts.env || process.env,
      }, (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? 'timed out' : oneLine(stderr || err.message, 300);
          reject(new Error(`higgsfield ${args[1]} failed: ${why}`));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          reject(new Error(`higgsfield ${args[1]} answered without JSON`));
        }
      });
      if (child && child.stdin) {
        // A CLI that exits before reading stdin must not crash LunaCore with EPIPE.
        child.stdin.on('error', () => {});
        child.stdin.end(prompt || '');
      }
    });
  }

  function argsFor(sub, req, extra) {
    const flags = cliFlags(req.params);
    if (!CLI_TOKEN_RE.test(req.model) || !flags) throw new Error('higgsfield: the model or a param is not a plain token');
    return ['generate', sub, req.model, ...flags, ...extra, '--json'];
  }

  async function estimate(req) {
    return { credits: creditsOf(await run(argsFor('cost', req, []), req.prompt, COST_TIMEOUT_MS)) };
  }

  async function generate(req) {
    const result = jobResultOf(await run(argsFor('create', req, ['--wait', '--wait-timeout', GENERATE_WAIT]), req.prompt, GENERATE_TIMEOUT_MS));
    if (result.status && FAILED_STATUSES.has(result.status)) throw new Error(`higgsfield job ${oneLine(result.jobId, 80)} ended ${result.status}`);
    return result;
  }

  return { estimate, generate };
}

// ---- download -------------------------------------------------------------------------

/** The host of a parsed URL: lower case, no IPv6 brackets, no trailing root dot. */
const hostOf = (u) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

/** True for a public https URL: port 443, no credentials, no IP literal, no local name. */
function isPublicHttps(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = hostOf(u);
  // URL drops the default port, so '' is 443; any other port is refused.
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '' || !host.includes('.')) return false;
  return !net.isIP(host) && !LOCAL_NAME_RE.test(host);
}

/** True for a resolved address outside every non-public range. */
function isPublicAddress(address) {
  const family = net.isIP(typeof address === 'string' ? address : '');
  return family !== 0 && !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** `promise`, or a rejection as soon as `signal` aborts (dns.lookup itself takes no signal). */
function untilAborted(promise, signal, what) {
  if (signal.aborted) return Promise.reject(new Error(`${what} timed out`));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(`${what} timed out`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** Throws unless every address `host` resolves to is public. */
async function assertPublicHost(host, lookup, signal) {
  let addresses;
  try {
    addresses = await untilAborted(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), signal, `resolving ${host}`);
  } catch (err) {
    throw new Error(`cannot resolve ${host} (${err && err.code ? err.code : oneLine(errText(err), 80)})`);
  }
  const list = Array.isArray(addresses) ? addresses : [];
  if (!list.length) throw new Error(`cannot resolve ${host}`);
  if (!list.every((a) => isObj(a) && isPublicAddress(a.address))) throw new Error(`refused: ${host} resolves to a non-public address`);
}

/** Drops a body that will not be read (a redirect's); only frees the connection early. */
function discardBody(res) {
  if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
}

/**
 * @param {{fetch?:Function, lookup?:(host:string, opts:object)=>Promise<{address:string, family:number}[]>, timeoutMs?:number}} [opts]
 * @returns {(url:string)=>Promise<Buffer>}
 */
function createDownloader(opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const lookup = opts.lookup || dns.promises.lookup;
  const timeoutMs = opts.timeoutMs || DOWNLOAD_TIMEOUT_MS;

  const timedOut = (err) => !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const timeoutText = () => `download timed out after ${Math.round(timeoutMs / 1000)} s`;

  async function fetchOnce(url, signal) {
    try {
      return await fetchFn(url, { redirect: 'manual', signal });
    } catch (err) {
      throw new Error(timedOut(err) ? timeoutText() : `download failed: ${oneLine(err && err.cause && err.cause.code ? err.cause.code : errText(err), 120)}`);
    }
  }

  async function bodyOf(res) {
    try {
      return await readCappedBody(res, MAX_DOWNLOAD_BYTES);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') throw new Error('the result is too large');
      throw new Error(timedOut(err) ? timeoutText() : `download broke off: ${oneLine(errText(err), 120)}`);
    }
  }

  return async function download(url) {
    // One budget for the whole download: every lookup, hop and the body read.
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (!isPublicHttps(current)) throw new Error(hop ? 'refused: the result redirected off public https' : 'refused: a result URL must be public https');
      await assertPublicHost(hostOf(new URL(current)), lookup, signal);
      const res = await fetchOnce(current, signal);
      if (!REDIRECT_STATUSES.has(res.status)) {
        if (res.ok) return bodyOf(res);
        discardBody(res);
        throw new Error(`download failed with HTTP ${res.status}`);
      }
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      discardBody(res);
      if (hop >= MAX_REDIRECTS) throw new Error(`refused: more than ${MAX_REDIRECTS} redirects`);
      if (!location) throw new Error(`download answered HTTP ${res.status} without a location`);
      try {
        current = new URL(location, current).href;
      } catch {
        throw new Error('refused: a redirect to an unreadable location');
      }
    }
  };
}

// ---- per-session factory ----------------------------------------------------------------

/**
 * The asset tools of one worker tab, or null when it gets none.
 * @param {{assetTools:()=>{comfyuiPort:number, blenderPort:number, higgsfieldUsdPerCredit:number, artRoot:string},
 *   net?:object, execFile?:Function, fetch?:Function, lookup?:Function, platform?:string, env?:()=>object, log?:(line:string)=>void}} deps
 * @returns {(ctx:{repoPath:string, recordSpend:Function, recordAsset:Function, cappedTools:Function}|null)
 *   => null|{blenderModel:Function, comfyDraft:Function, higgsfieldFinal:Function}}
 */
function createAssetToolsFor(deps) {
  const log = deps.log || (() => {});
  return function assetsFor(ctx) {
    if (!isObj(ctx) || typeof ctx.repoPath !== 'string') return null;
    // Built per call: changed settings (ports, credit rate) apply without a restart.
    const pipeline = () => {
      const cfg = deps.assetTools();
      return createAssetPipeline({
        repoPath: ctx.repoPath,
        artRoot: cfg.artRoot,
        usdPerCredit: cfg.higgsfieldUsdPerCredit,
        comfy: createComfyClient({ port: cfg.comfyuiPort, fetch: deps.fetch }),
        blender: createBlenderClient({ port: cfg.blenderPort, net: deps.net }),
        higgsfield: createHiggsfieldCli({ execFile: deps.execFile, platform: deps.platform, env: deps.env ? deps.env() : undefined }),
        download: createDownloader({ fetch: deps.fetch, lookup: deps.lookup }),
        unity: createPipelineClient({ projectDir: ctx.repoPath, fetch: deps.fetch }),
        recordSpend: ctx.recordSpend,
        cappedTools: ctx.cappedTools,
        logAsset: (entry) => {
          if (!ctx.recordAsset(entry)) log(`[lunaswork-assets] asset not logged: ${oneLine(entry.path, 120)}`);
        },
      });
    };
    return {
      blenderModel: (a) => pipeline().blenderModel(a),
      comfyDraft: (a) => pipeline().comfyDraft(a),
      higgsfieldFinal: (a) => pipeline().higgsfieldFinal(a),
    };
  };
}

module.exports = {
  ASSET_TOOLS,
  BLENDER_TOOL,
  COMFY_TOOL,
  HIGGSFIELD_TOOL,
  DEFAULT_BLENDER_PORT,
  callAssetTool,
  createBlenderClient,
  createHiggsfieldCli,
  creditsOf,
  jobResultOf,
  isPublicHttps,
  isPublicAddress,
  createDownloader,
  createAssetToolsFor,
};
