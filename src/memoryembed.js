// ============================================================================
// LunaCore - memory search: local embeddings (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 2b. Memories are written in
// English and asked about in Polish as often as not; keyword search cannot
// bridge that, an embedding model can.
//
// The embedder talks to LM Studio on this machine and nowhere else: memory
// text never leaves the PC. The vector store keeps one vector per memory in a
// local file, never synced (decision 9): each PC embeds with the best model it
// has installed, and a PC with none keeps working on keyword search.
//
// LM Studio answers a request for a model it cannot serve with whatever
// embedding model happens to be loaded. Vectors of two models must never mix,
// so a reply is only accepted when it names the model that was asked for, and
// the store holds the vectors of exactly one model at a time.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:1234';
const VECTORS_FILE = 'memory-vectors.local.json';
const FILE_VERSION = 1;
/** Installed embedding models LunaCore uses, best first (measured on the golden set, 2026-11-12). */
const PREFERRED_MODELS = ['qwen3-embedding-4b', 'qwen3-embedding-0.6b'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const MODEL_LIST_TIMEOUT_MS = 2000;
/** A search waits this long for its query vector, then answers from keywords. Covers a cold model load on a GPU. */
const QUERY_TIMEOUT_MS = 8000;
/** One batch of memories; generous, because a laptop embeds on its CPU. */
const DOCS_TIMEOUT_MS = 180000;
const MODEL_TTL_MS = 60000;
/** How long "no model" (or a failed call) is believed before LM Studio is asked again. */
const NO_MODEL_TTL_MS = 15000;
const BATCH_SIZE = 16;
/** Memories that fail on their own in a row before the fill gives up until the next rebuild. */
const MAX_FAILURES_IN_A_ROW = 2;
const MAX_DIM = 8192;
const MAX_TEXT_CHARS = 8000;
const HASH_CHARS = 16;
/** A cache file past this size is not read: it is rebuilt from the memories. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Questions embedded at once; one more is answered from keywords. */
const MAX_QUERIES_AT_ONCE = 4;
/** How often a silent LM Studio is woken (`lms server start`), at most. */
const WAKE_EVERY_MS = 10 * 60000;
/** Question vectors kept, so a repeated question costs no model call. */
const QUERY_CACHE_SIZE = 64;

/** The text a memory is embedded as. */
const docText = (record) => `${record.title}\n\n${record.body}`.slice(0, MAX_TEXT_CHARS);
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_CHARS);
const vectorsPath = (configDir) => path.join(configDir, VECTORS_FILE);

function reasonOf(err) {
  if (!err) return 'error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  return (err.cause && err.cause.code) || err.code || err.message || 'error';
}

/** An origin on this machine, or '' (memory text is never sent to another host). */
function localOrigin(url) {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOCAL_HOSTS.has(parsed.hostname) ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * The embedding model to use out of LM Studio's model list.
 * @param {unknown} body the reply of GET /api/v0/models
 * @param {string|null} wanted an exact model id, or null for the best preferred one
 * @returns {string|null}
 */
function pickModel(body, wanted = null) {
  const rows = body && Array.isArray(body.data) ? body.data : [];
  const ids = rows.filter((m) => m && m.type === 'embeddings' && typeof m.id === 'string').map((m) => m.id);
  if (wanted) return ids.includes(wanted) ? wanted : null;
  for (const name of PREFERRED_MODELS) {
    const id = ids.find((candidate) => candidate.toLowerCase().includes(name));
    if (id) return id;
  }
  return null;
}

/** A vector scaled to length 1, or null when it has no finite, non-zero length. */
function normalize(vector) {
  let sum = 0;
  for (const x of vector) sum += x * x;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  const norm = Math.sqrt(sum);
  return vector.map((x) => x / norm);
}

/** One embedding from a reply -> a unit Float32Array, or null when it is not a usable vector. */
function toUnitVector(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_DIM || !raw.every((x) => typeof x === 'number')) return null;
  return normalize(Float32Array.from(raw));
}

/**
 * The vectors of an /v1/embeddings reply, in input order.
 * @returns {Float32Array[]} throws when the reply is not exactly what was asked for
 */
function parseEmbeddings(body, model, count) {
  if (!body || body.model !== model) throw new Error(`asked for ${model}, answered by ${(body && body.model) || 'nothing'}`);
  const rows = Array.isArray(body.data) ? body.data : [];
  if (rows.length !== count) throw new Error(`asked for ${count} vectors, got ${rows.length}`);
  const vectors = new Array(count).fill(null);
  let dim = 0;
  for (const row of rows) {
    // Each input is answered exactly once: a missing or repeated index would pair a vector with the wrong text.
    if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= count || vectors[row.index]) throw new Error('the reply is out of order');
    const vector = toUnitVector(row.embedding);
    dim = dim || (vector ? vector.length : 0);
    if (!vector || vector.length !== dim) throw new Error('the reply holds an unusable vector');
    vectors[row.index] = vector;
  }
  return vectors;
}

/**
 * Embeddings from LM Studio on this machine.
 * @param {{baseUrl?: string, model?: string|null, fetchImpl?: Function, now?: () => number, log?: Function, wake?: Function|null}} [opts]
 *   model = an exact LM Studio model id instead of the preferred list;
 *   wake = starts LM Studio's server when it does not answer (src/lmstudiocli.js wakeLmStudio); the search does not wait for it
 * @returns {{model: () => Promise<string|null>, embed: Function, state: () => {model: string|null, reason: string|null}}}
 *   state = what is known without asking: reason is 'checking', 'not-local', 'no-server', 'no-model' or 'failed' when there is no model
 */
function createEmbedder({
  baseUrl = process.env.LUNA_EMBED_URL || DEFAULT_URL,
  model: wanted = process.env.LUNA_EMBED_MODEL || null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console.error,
  wake = null,
} = {}) {
  const origin = localOrigin(baseUrl);
  let picked = { at: -Infinity, id: null };
  let listing = null;
  let lastReason = null;
  let code = 'checking';
  let wokenAt = -Infinity;

  /** One line per change of state, not one per search. */
  function note(reason, why = null) {
    code = why;
    if (reason !== lastReason) log(reason ? `[memory] embeddings off, keyword search only: ${reason}` : '[memory] embeddings on');
    lastReason = reason;
  }

  async function request(route, init, timeoutMs) {
    // A redirect could carry memory text to another host: it is an error.
    const res = await fetchImpl(`${origin}${route}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Starts LM Studio's server in the background; the next look at the model list finds it. */
  function wakeUp(at) {
    if (!wake || at - wokenAt < WAKE_EVERY_MS) return;
    wokenAt = at;
    Promise.resolve()
      .then(() => wake())
      .then((res) => {
        if (res && res.ok) picked = { at: -Infinity, id: null };
      })
      .catch((err) => log(`[memory] LM Studio not woken: ${reasonOf(err)}`));
  }

  async function list(at) {
    try {
      const id = pickModel(await request('/api/v0/models', {}, MODEL_LIST_TIMEOUT_MS), wanted);
      note(id ? null : `LM Studio has no ${wanted || PREFERRED_MODELS.join(' or ')}`, id ? null : 'no-model');
      picked = { at, id };
    } catch (err) {
      note(`LM Studio does not answer (${reasonOf(err)})`, 'no-server');
      picked = { at, id: null };
      wakeUp(at);
    }
    return picked.id;
  }

  function model() {
    if (!origin) {
      note('the embedding URL is not on this machine', 'not-local');
      return Promise.resolve(null);
    }
    const at = now();
    if (at - picked.at < (picked.id ? MODEL_TTL_MS : NO_MODEL_TTL_MS)) return Promise.resolve(picked.id);
    // Searches that arrive together share one look at the model list.
    if (!listing) {
      listing = list(at).finally(() => {
        listing = null;
      });
    }
    return listing;
  }

  async function embed(id, texts, timeoutMs = QUERY_TIMEOUT_MS) {
    try {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id, input: texts }) };
      return parseEmbeddings(await request('/v1/embeddings', init, timeoutMs), id, texts.length);
    } catch (err) {
      note(`${id} failed (${reasonOf(err)})`, 'failed');
      // Searches answer from keywords for a while instead of each waiting for the same failure.
      picked = { at: now(), id: null };
      return null;
    }
  }

  return { model, embed, state: () => ({ model: picked.id, reason: picked.id ? null : code }) };
}

const encode = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');

/** A vector from the cache file; checked like one from the model, because the file can be edited. */
function decode(text, dim) {
  if (typeof text !== 'string') return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== dim * 4) return null;
  return normalize(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
}

/** The cache file -> {model, entries}; a missing or unusable file is an empty cache (it is rebuilt from the memories). */
function readVectors(file) {
  const empty = { model: null, entries: new Map() };
  let raw;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('too large');
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[memory] vector cache unreadable, rebuilding:', reasonOf(err));
    return empty;
  }
  const { v, model, dim, vectors } = raw && typeof raw === 'object' ? raw : {};
  if (v !== FILE_VERSION || typeof model !== 'string' || !Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) return empty;
  const entries = new Map();
  for (const [key, row] of Object.entries(vectors && typeof vectors === 'object' ? vectors : {})) {
    const vec = Array.isArray(row) && typeof row[0] === 'string' ? decode(row[1], dim) : null;
    if (vec) entries.set(key, { hash: row[0], vec });
  }
  return { model, entries };
}

function writeVectors(file, { model, entries }) {
  const first = entries.values().next().value;
  const vectors = Object.fromEntries([...entries].map(([key, e]) => [key, [e.hash, encode(e.vec)]]));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, model, dim: first ? first.vec.length : 1, vectors }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * One vector per memory, cached in a local file and filled in the background.
 * @param {{file: string, embedder: {model: Function, embed: Function, state?: Function}, onChange?: () => void}} opts
 *   onChange fires when what mode() answers changed after a look at the model (the HUD repaints its status line)
 * @returns {{prepare: Function, ready: () => Promise<void>, queryVector: Function, mode: Function, status: () => {model: string|null, count: number}}}
 */
function createVectorStore({ file, embedder, onChange = () => {} }) {
  /** The vectors of one model. Replaced whole when the model changes, so two models never meet. */
  let state = readVectors(file);
  /** key -> hash of the memories of the latest prepare(): what the vectors are wanted for. */
  let wanted = new Map();
  let docs = [];
  let inFlight = null;
  let again = false;
  let asking = 0;
  const asked = new Map();

  /** The vector of a memory, if it was made from the memory's current text. */
  function vectorOf(key) {
    const entry = state.entries.get(key);
    return entry && entry.hash === wanted.get(key) ? entry.vec : undefined;
  }

  /** What an index reads: always the current model's vectors, also while they are being filled. */
  const view = {
    get: vectorOf,
    get size() {
      let count = 0;
      for (const key of wanted.keys()) if (vectorOf(key)) count++;
      return count;
    },
  };

  /** Embeds a batch; when it fails, each memory on its own, so one bad memory does not hold back the rest. */
  async function embedBatch(model, batch) {
    const keep = (doc, vec) => state.entries.set(doc.key, { hash: doc.hash, vec });
    const texts = batch.map((doc) => doc.text);
    const all = await embedder.embed(model, texts, DOCS_TIMEOUT_MS);
    if (all) {
      batch.forEach((doc, i) => keep(doc, all[i]));
      return true;
    }
    if (batch.length === 1) return false;
    let failures = 0;
    for (const doc of batch) {
      const one = await embedder.embed(model, [doc.text], DOCS_TIMEOUT_MS);
      if (one) keep(doc, one[0]);
      failures = one ? 0 : failures + 1;
      // Several in a row is the model, not the memory.
      if (failures >= MAX_FAILURES_IN_A_ROW) return false;
    }
    return true;
  }

  async function fill() {
    const model = await embedder.model();
    if (!model) return;
    if (model !== state.model) {
      state = { model, entries: new Map() };
      asked.clear();
    }
    const before = state.entries.size;
    for (const key of [...state.entries.keys()]) if (!wanted.has(key)) state.entries.delete(key);
    let changed = state.entries.size !== before;
    const missing = docs.filter((doc) => !vectorOf(doc.key));
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const ok = await embedBatch(model, missing.slice(i, i + BATCH_SIZE));
      changed = true;
      if (!ok) break;
    }
    if (changed) writeVectors(file, state);
  }

  /**
   * How a search is answered right now, without asking the model.
   * @returns {{mode: 'meaning', model: string, embedded: number, total: number}|{mode: 'keywords', reason: string}}
   *   reason: 'checking', 'not-local', 'no-server', 'no-model', 'failed', or 'building' (vectors not made yet)
   */
  function mode() {
    const known = typeof embedder.state === 'function' ? embedder.state() : { model: state.model, reason: null };
    if (!known.model) return { mode: 'keywords', reason: known.reason || 'no-model' };
    const embedded = view.size;
    if (known.model !== state.model || (wanted.size > 0 && embedded === 0)) return { mode: 'keywords', reason: 'building' };
    return { mode: 'meaning', model: known.model, embedded, total: wanted.size };
  }

  let reported = '';
  async function run() {
    try {
      do {
        again = false;
        await fill();
      } while (again);
    } finally {
      const now = JSON.stringify(mode());
      if (now !== reported) {
        reported = now;
        onChange();
      }
    }
  }

  /**
   * Says which memories exist now and starts embedding the ones without a
   * vector in the background.
   * @param {[string, object][]} records [key, record] from memorystore.scan()
   * @returns {{get: (key: string) => Float32Array|undefined, size: number}} a live view
   */
  function prepare(records) {
    docs = records.map(([key, record]) => {
      const text = docText(record);
      return { key, text, hash: hashOf(text) };
    });
    wanted = new Map(docs.map((doc) => [doc.key, doc.hash]));
    // Always looked at, also with every vector present: the model may have changed.
    if (inFlight) again = true;
    else {
      inFlight = run()
        .catch((err) => console.error('[memory] vectors not saved:', reasonOf(err)))
        .finally(() => {
          inFlight = null;
        });
    }
    return view;
  }

  /**
   * @param {string} text
   * @returns {Promise<Float32Array|null>} null = answer from keywords (no model, its vectors are not built yet, or too busy)
   */
  async function queryVector(text) {
    const question = String(text).slice(0, MAX_TEXT_CHARS);
    try {
      const model = await embedder.model();
      if (!model || model !== state.model) return null;
      if (asked.has(question)) return asked.get(question);
      if (asking >= MAX_QUERIES_AT_ONCE) return null;
      asking++;
      let vectors;
      try {
        vectors = await embedder.embed(model, [question], QUERY_TIMEOUT_MS);
      } finally {
        asking--;
      }
      // The model may have been replaced while the question was embedded.
      if (!vectors || model !== state.model) return null;
      if (asked.size >= QUERY_CACHE_SIZE) asked.delete(asked.keys().next().value);
      asked.set(question, vectors[0]);
      return vectors[0];
    } catch (err) {
      console.error('[memory] query not embedded:', reasonOf(err));
      return null;
    }
  }

  return {
    prepare,
    ready: () => inFlight || Promise.resolve(),
    queryVector,
    mode,
    status: () => ({ model: state.model, count: state.entries.size }),
  };
}

module.exports = { createEmbedder, createVectorStore, pickModel, parseEmbeddings, vectorsPath, docText, PREFERRED_MODELS };
