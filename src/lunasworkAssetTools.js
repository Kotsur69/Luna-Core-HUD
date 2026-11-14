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
//   download    a Higgsfield result: https only, no IP-literal or local host,
//               size-capped, with a timeout.
//   ComfyUI     src/lunasworkComfy.js (loopback HTTP).
//   Unity       helpers/playtest-bridge/pipeline-http.js (the editor of the
//               worker's project folder).
//
// Per-PC settings (lunaswork-settings.local.json `assetTools`, normalized by
// lunasworkToolkit.normalizeAssetTools): comfyuiPort, blenderPort,
// higgsfieldUsdPerCredit, artRoot.
// ============================================================================

'use strict';

const net = require('net');
const childProcess = require('child_process');
const { createAssetPipeline, KINDS, MODEL_KINDS, IMAGE_KINDS } = require('./lunasworkAssetPipeline');
const { createComfyClient } = require('./lunasworkComfy');
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
const CLI_TOKEN_RE = /^[\w:.-]{1,64}$/;
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
    description: "Luna's Work asset pipeline: a paid FINAL from Higgsfield (concept art, textures, VFX, key art, or a GLB model). The cost is estimated and booked against this run's Higgsfield budget BEFORE it generates; \"capReached\" means stop using Higgsfield for this run. Saves, imports into Unity and logs prompt, seed and cost.",
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

/** True for a public https URL: no credentials, no IP literal, no local name. */
function isPublicHttps(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.')) return false;
  return !net.isIP(host) && !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
}

/**
 * @param {{fetch?:Function, timeoutMs?:number}} [opts]
 * @returns {(url:string)=>Promise<Buffer>}
 */
function createDownloader(opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  return async function download(url) {
    if (!isPublicHttps(url)) throw new Error('refused: a result URL must be public https');
    const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.url && !isPublicHttps(res.url)) throw new Error('refused: the result redirected off public https');
    if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error('the result is too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('the result is too large');
    return buf;
  };
}

// ---- per-session factory ----------------------------------------------------------------

/**
 * The asset tools of one worker tab, or null when it gets none.
 * @param {{assetTools:()=>{comfyuiPort:number, blenderPort:number, higgsfieldUsdPerCredit:number, artRoot:string},
 *   net?:object, execFile?:Function, fetch?:Function, platform?:string, env?:()=>object, log?:(line:string)=>void}} deps
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
        download: createDownloader({ fetch: deps.fetch }),
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
  createDownloader,
  createAssetToolsFor,
};
