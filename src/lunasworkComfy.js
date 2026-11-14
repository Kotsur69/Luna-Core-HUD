// ============================================================================
// LunaCore - ComfyUI HTTP client for Luna's Work asset drafts
// ----------------------------------------------------------------------------
// A local ComfyUI is the draft pipeline of a game's art (concepts, texture
// and VFX drafts); Higgsfield makes the finals (src/lunasworkAssetPipeline.js).
// This client talks to ComfyUI's own HTTP API:
//
//   POST /prompt          {prompt: <API-format workflow>, client_id}
//                         -> {prompt_id, number, node_errors}
//                         400 {error: {type, message, details}, node_errors}
//   GET  /history/<id>    -> {} while queued / running, then
//                         {<id>: {status: {status_str, completed, messages},
//                                 outputs: {<node>: {images: [{filename, subfolder, type}]}}}}
//   GET  /view?filename=&subfolder=&type=   the image bytes
//
// Boundaries: the host is always 127.0.0.1 (loopback only), the port is a
// validated integer (default 8188), redirects are refused, every request has
// a timeout and every reply a size cap, enforced while the body streams in
// (readCappedBody, shared with the Higgsfield downloader). Everything ComfyUI answers is
// validated before use: the prompt id, the history shape, the output file
// names (never used as local paths - the caller names its own files) and the
// image bytes (PNG / JPEG / WEBP magic). Errors carry err.code (COMFY_ERROR).
//
// Workflow helpers (pure): validateWorkflow (API format only, not the UI's
// {nodes, links} save format), applySeed (every sampler's seed / noise_seed),
// applyPrompt (the "{{prompt}}" placeholder in string inputs).
//
// Plain Node, no dependencies; fetch / sleep / now are injected by the tests.
// ============================================================================

'use strict';

const crypto = require('crypto');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8188;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_NODES = 500;
const MAX_ERROR_CHARS = 300;
const PROMPT_PLACEHOLDER = '{{prompt}}';
const PROMPT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const NODE_ID_RE = /^[\w:.-]{1,64}$/;
const CLASS_TYPE_RE = /^[\w .+-]{1,120}$/;
// ComfyUI output names: "ComfyUI_00001_.png"; a subfolder is one plain folder name.
const FILE_NAME_RE = /^[\w.-]{1,200}$/;
const SUBFOLDER_RE = /^[\w.-]{0,100}$/;
const FILE_TYPES = Object.freeze(['output', 'temp']);
const SEED_INPUTS = Object.freeze(['seed', 'noise_seed']);
// A fresh seed stays a safe JS integer (ComfyUI accepts up to 2^64).
const RANDOM_SEED_LIMIT = 2 ** 47;

const COMFY_ERROR = Object.freeze({
  badConfig: 'COMFY_BAD_CONFIG',
  badWorkflow: 'COMFY_BAD_WORKFLOW',
  unreachable: 'COMFY_UNREACHABLE',
  timeout: 'COMFY_TIMEOUT',
  rejected: 'COMFY_REJECTED',
  badReply: 'COMFY_BAD_REPLY',
  failed: 'COMFY_FAILED',
  noOutput: 'COMFY_NO_OUTPUT',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_ERROR_CHARS) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const comfyError = (code, message, extra = {}) => Object.assign(new Error(oneLine(message, 500)), { code }, extra);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image kind from its first bytes, or null: only real PNG / JPEG / WEBP pass. */
function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// ---- workflows (pure) -----------------------------------------------------------------

/**
 * An API-format workflow: {<nodeId>: {class_type, inputs}}. The UI's save
 * format ({nodes, links}) is refused with a hint, since /prompt cannot run it.
 * @returns {{ok:true, workflow:object}|{ok:false, error:string}}
 */
function validateWorkflow(raw) {
  if (!isObj(raw)) return { ok: false, error: 'the workflow is not a JSON object' };
  if (Array.isArray(raw.nodes) || Array.isArray(raw.links)) {
    return { ok: false, error: 'the workflow is in the UI save format; export it with "Save (API Format)"' };
  }
  const ids = Object.keys(raw);
  if (!ids.length) return { ok: false, error: 'the workflow has no nodes' };
  if (ids.length > MAX_NODES) return { ok: false, error: `the workflow has more than ${MAX_NODES} nodes` };
  for (const id of ids) {
    const node = raw[id];
    if (!NODE_ID_RE.test(id)) return { ok: false, error: `bad node id '${oneLine(id, 40)}'` };
    if (!isObj(node) || typeof node.class_type !== 'string' || !CLASS_TYPE_RE.test(node.class_type) || !isObj(node.inputs)) {
      return { ok: false, error: `node ${id} needs a class_type and an inputs object` };
    }
  }
  return { ok: true, workflow: raw };
}

const mapNodes = (workflow, fn) => Object.fromEntries(Object.entries(workflow).map(([id, node]) => [id, { ...node, inputs: fn(node.inputs) }]));

/** A new workflow with every numeric seed / noise_seed input set to `seed`. */
function applySeed(workflow, seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw comfyError(COMFY_ERROR.badWorkflow, 'the seed must be a non-negative whole number');
  let seeded = 0;
  const next = mapNodes(workflow, (inputs) => {
    const out = { ...inputs };
    for (const key of SEED_INPUTS) {
      if (typeof out[key] === 'number') {
        out[key] = seed;
        seeded += 1;
      }
    }
    return out;
  });
  return { workflow: next, seeded };
}

/** A new workflow with "{{prompt}}" in every string input replaced by the prompt. */
function applyPrompt(workflow, prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  let replaced = 0;
  const next = mapNodes(workflow, (inputs) => Object.fromEntries(Object.entries(inputs).map(([k, v]) => {
    if (typeof v !== 'string' || !v.includes(PROMPT_PLACEHOLDER)) return [k, v];
    replaced += 1;
    return [k, v.split(PROMPT_PLACEHOLDER).join(text)];
  })));
  return { workflow: next, replaced };
}

const randomSeed = () => crypto.randomInt(0, RANDOM_SEED_LIMIT);

// ---- capped body read -------------------------------------------------------------------

/**
 * A fetch Response body as a Buffer, never more than `max` bytes in memory:
 * a declared content-length over the cap is refused before reading, and the
 * stream is read chunk by chunk and cancelled as soon as it passes the cap. A
 * response without a readable stream (a test stand-in) falls back to
 * arrayBuffer(), still checked. Throws err.code 'BODY_TOO_LARGE'.
 * @param {{headers?:{get:Function}, body?:{getReader:Function}|null, arrayBuffer?:Function}} res
 * @param {number} max
 * @returns {Promise<Buffer>}
 */
async function readCappedBody(res, max) {
  const tooLarge = (bytes) => Object.assign(new Error(`reply too large (${bytes} bytes, cap ${max})`), { code: 'BODY_TOO_LARGE' });
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge(declared);
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw tooLarge(buf.length);
    return buf;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Cancelling only frees the connection early; the size error is what the caller gets.
      reader.cancel().catch(() => {});
      throw tooLarge(size);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, size);
}

// ---- replies --------------------------------------------------------------------------

/** The output images of one history entry, validated; [] when there are none. */
function outputFiles(entry) {
  const outputs = isObj(entry) && isObj(entry.outputs) ? entry.outputs : {};
  const files = [];
  for (const node of Object.values(outputs)) {
    const images = isObj(node) && Array.isArray(node.images) ? node.images : [];
    for (const img of images) {
      if (!isObj(img) || typeof img.filename !== 'string' || !FILE_NAME_RE.test(img.filename) || img.filename.includes('..')) continue;
      const subfolder = typeof img.subfolder === 'string' ? img.subfolder : '';
      if (!SUBFOLDER_RE.test(subfolder) || subfolder.includes('..')) continue;
      files.push({ filename: img.filename, subfolder, type: FILE_TYPES.includes(img.type) ? img.type : 'output' });
    }
  }
  // Previews (type temp) are not results when the workflow saved real outputs.
  const saved = files.filter((f) => f.type === 'output');
  return (saved.length ? saved : files).slice(0, MAX_IMAGES);
}

/** status_str 'error' -> the execution error's message, else null. */
function historyFailure(entry) {
  const status = isObj(entry) && isObj(entry.status) ? entry.status : null;
  if (!status || status.status_str !== 'error') return null;
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const err = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error');
  return err && isObj(err[1]) ? `${oneLine(err[1].node_type, 60)}: ${oneLine(err[1].exception_message, 200)}` : 'execution error';
}

/** The message of a /prompt rejection: error.message plus the first node error. */
function rejectionText(json) {
  const err = isObj(json) && isObj(json.error) ? json.error : {};
  const base = oneLine(err.message || err.type || 'rejected', 150);
  const nodes = isObj(json) && isObj(json.node_errors) ? Object.entries(json.node_errors) : [];
  if (!nodes.length) return base;
  const [id, ne] = nodes[0];
  const first = isObj(ne) && Array.isArray(ne.errors) && isObj(ne.errors[0]) ? ne.errors[0] : {};
  return `${base} (node ${oneLine(id, 20)}: ${oneLine(first.message || first.details, 120)})`;
}

// ---- client -------------------------------------------------------------------------

function clientOptions(opts) {
  const o = {
    port: opts.port === undefined ? DEFAULT_PORT : opts.port,
    fetch: opts.fetch || globalThis.fetch,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    pollMs: opts.pollMs || DEFAULT_POLL_MS,
    maxWaitMs: opts.maxWaitMs || DEFAULT_MAX_WAIT_MS,
    sleep: opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: opts.now || Date.now,
  };
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw comfyError(COMFY_ERROR.badConfig, `ComfyUI port must be 1-65535, got ${oneLine(o.port, 20)}`);
  if (typeof o.fetch !== 'function') throw comfyError(COMFY_ERROR.badConfig, 'fetch is not available');
  for (const name of ['timeoutMs', 'pollMs', 'maxWaitMs']) {
    if (!Number.isInteger(o[name]) || o[name] <= 0) throw comfyError(COMFY_ERROR.badConfig, `${name} must be a positive whole number`);
  }
  return o;
}

/**
 * @param {{port?:number, fetch?:Function, timeoutMs?:number, pollMs?:number, maxWaitMs?:number,
 *   sleep?:(ms:number)=>Promise<void>, now?:()=>number}} [opts]
 * @returns {{baseUrl:string, queue:Function, history:Function, waitFor:Function, view:Function, run:Function}}
 */
function createComfyClient(opts = {}) {
  const o = clientOptions(isObj(opts) ? opts : {});
  const baseUrl = `http://${HOST}:${o.port}`;

  async function request(pathname, init = {}) {
    try {
      return await o.fetch(`${baseUrl}${pathname}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw comfyError(COMFY_ERROR.timeout, `ComfyUI did not answer ${pathname.split('?')[0]} within ${o.timeoutMs} ms`);
      }
      const cause = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : oneLine(err && err.message, 120);
      throw comfyError(COMFY_ERROR.unreachable, `ComfyUI not reachable on ${baseUrl} (${cause}) - is it running with --listen 127.0.0.1 --port ${o.port}?`);
    }
  }

  async function body(res, max) {
    try {
      return await readCappedBody(res, max);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') throw comfyError(COMFY_ERROR.badReply, `ComfyUI ${err.message}`);
      throw comfyError(COMFY_ERROR.unreachable, `ComfyUI reply broke off (${oneLine(err && err.message, 120)})`);
    }
  }

  async function json(res, what) {
    const buf = await body(res, MAX_JSON_BYTES);
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw comfyError(COMFY_ERROR.badReply, `ComfyUI answered ${what} with HTTP ${res.status} and no JSON`);
    }
  }

  /** Queues a validated workflow. @returns {Promise<string>} the prompt id */
  async function queue(workflow) {
    const checked = validateWorkflow(workflow);
    if (!checked.ok) throw comfyError(COMFY_ERROR.badWorkflow, checked.error);
    const res = await request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ prompt: checked.workflow, client_id: `lunacore-${crypto.randomUUID()}` }),
    });
    const reply = await json(res, '/prompt');
    if (!res.ok) throw comfyError(COMFY_ERROR.rejected, `ComfyUI refused the workflow: ${rejectionText(reply)}`, { status: res.status });
    if (!isObj(reply) || typeof reply.prompt_id !== 'string' || !PROMPT_ID_RE.test(reply.prompt_id)) {
      throw comfyError(COMFY_ERROR.badReply, 'ComfyUI /prompt reply has no valid prompt_id');
    }
    if (isObj(reply.node_errors) && Object.keys(reply.node_errors).length) {
      throw comfyError(COMFY_ERROR.rejected, `ComfyUI refused the workflow: ${rejectionText(reply)}`);
    }
    return reply.prompt_id;
  }

  /** One history entry, or null while the prompt is still queued / running. */
  async function history(promptId) {
    if (typeof promptId !== 'string' || !PROMPT_ID_RE.test(promptId)) throw comfyError(COMFY_ERROR.badConfig, 'bad prompt id');
    const res = await request(`/history/${encodeURIComponent(promptId)}`, { headers: { accept: 'application/json' } });
    const reply = await json(res, '/history');
    if (!res.ok || !isObj(reply)) throw comfyError(COMFY_ERROR.badReply, `ComfyUI /history answered HTTP ${res.status}`);
    const entry = reply[promptId];
    return isObj(entry) ? entry : null;
  }

  /** Polls /history until the prompt finished. @returns {Promise<{filename, subfolder, type}[]>} */
  async function waitFor(promptId) {
    const deadline = o.now() + o.maxWaitMs;
    for (;;) {
      const entry = await history(promptId);
      if (entry) {
        const failure = historyFailure(entry);
        if (failure) throw comfyError(COMFY_ERROR.failed, `ComfyUI run ${promptId} failed: ${failure}`);
        const done = !isObj(entry.status) || entry.status.completed === true || entry.status.status_str === 'success';
        if (done) {
          const files = outputFiles(entry);
          if (!files.length) throw comfyError(COMFY_ERROR.noOutput, `ComfyUI run ${promptId} saved no image (add a SaveImage node)`);
          return files;
        }
      }
      if (o.now() >= deadline) throw comfyError(COMFY_ERROR.timeout, `ComfyUI run ${promptId} did not finish within ${Math.round(o.maxWaitMs / 1000)} s`);
      await o.sleep(o.pollMs);
    }
  }

  /** The bytes of one output image, checked to be a real image. @returns {Promise<{data:Buffer, ext:string}>} */
  async function view(file) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    const res = await request(`/view?${q.toString()}`);
    if (!res.ok) throw comfyError(COMFY_ERROR.badReply, `ComfyUI /view answered HTTP ${res.status} for ${file.filename}`);
    const data = await body(res, MAX_IMAGE_BYTES);
    const ext = imageKind(data);
    if (!ext) throw comfyError(COMFY_ERROR.badReply, `ComfyUI /view returned something that is not an image for ${file.filename}`);
    return { data, ext };
  }

  /** queue -> waitFor -> view. @returns {Promise<{promptId:string, images:{filename:string, data:Buffer, ext:string}[]}>} */
  async function run(workflow) {
    const promptId = await queue(workflow);
    const files = await waitFor(promptId);
    const images = [];
    for (const f of files) images.push({ filename: f.filename, ...(await view(f)) });
    return { promptId, images };
  }

  return { baseUrl, queue, history, waitFor, view, run };
}

module.exports = {
  DEFAULT_PORT,
  PROMPT_PLACEHOLDER,
  COMFY_ERROR,
  imageKind,
  validateWorkflow,
  applySeed,
  applyPrompt,
  randomSeed,
  outputFiles,
  readCappedBody,
  createComfyClient,
};
