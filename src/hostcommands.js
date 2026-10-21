// ============================================================================
// LunaCore - the host's command loop (main, host mode)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, slice H1. The phone writes a signed row into
// `host_commands`; the host named in it picks it up here:
//
//   realtime event / poll -> read the 'new' rows for this host
//   claim                 one `update ... where id = ? and status = 'new'`:
//                         only one host ever gets the row
//   check                 shape, expiry, then the injected verifier
//                         (src/hostauth.js); no verifier -> every row refused
//   run                   the handler for row.kind; unknown kinds refused
//   finish                status done / refused / failed + result
//
// Realtime only triggers a read, it never carries the row we act on. While
// the realtime socket is down, a poll every 3 s does the same read. Rows are
// untrusted input: the verifier and the handler see a cleaned copy, a refusal
// is logged with the reason only (never the payload).
// ============================================================================

'use strict';

const POLL_MS = 3000;
const LIVE_DEBOUNCE_MS = 200;
/** Rows read per round; the rest come with the next read. */
const BATCH = 20;
/** A row asking for more than this is refused, whatever its signature says. */
const MAX_TTL_MS = 2 * 60 * 1000;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_ERROR = 300;
const KIND_RE = /^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;
const COLUMNS = 'id,host,kind,payload,nonce,expires_at,sig,grant,status,created_at';
const BROKEN = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => String(err instanceof Error ? err.message : err).slice(0, MAX_ERROR);

/**
 * A raw row -> {id, host, kind, payload, nonce, expiresAt, sig, grant}, or null
 * when its shape is off. Says nothing about whether it may run. `grant` (the
 * passkey-signed session grant, null when missing) is checked by the verifier.
 */
function cleanRow(row) {
  if (!isObject(row) || typeof row.id !== 'string' || !row.id || row.id.length > 64) return null;
  if (typeof row.host !== 'string' || typeof row.kind !== 'string' || !KIND_RE.test(row.kind) || row.kind.length > 64) return null;
  if (typeof row.nonce !== 'string' || typeof row.sig !== 'string' || !isObject(row.payload)) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt)) return null;
  const grant = isObject(row.grant) ? row.grant : null;
  return { id: row.id, host: row.host, kind: row.kind, payload: row.payload, nonce: row.nonce, expiresAt, sig: row.sig, grant };
}

/** A handler's answer -> a result that fits the column. */
function fitResult(value) {
  const result = isObject(value) ? value : { value: value === undefined ? null : value };
  const json = JSON.stringify(result);
  return json && Buffer.byteLength(json, 'utf8') <= MAX_RESULT_BYTES ? result : { error: 'result-too-big' };
}

/**
 * @param {{
 *   client: object,                 a logged-in supabase-js client (or a fake)
 *   host: string,                   this host's machine name
 *   verify?: ((row: object) => Promise<{ok: boolean, reason?: string}>)|null,
 *   handlers?: Record<string, (payload: object, row: object) => Promise<object>>,
 *   now?: () => number,
 *   setTimer?: Function, clearTimer?: Function,
 *   log?: (line: string) => void,
 * }} deps
 */
function createHostCommands({
  client,
  host,
  verify = null,
  handlers = {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (line) => console.error(line),
}) {
  let channel = null;
  let pollTimer = null;
  let liveTimer = null;
  let running = null; // the read in flight
  let again = false;
  let stopped = true;
  let polling = false;

  async function finish(id, status, result) {
    const { error } = await client.from('host_commands').update({ status, result }).eq('id', id).eq('status', 'claimed');
    if (error) log(`[hostcommands] ${id}: writing ${status} failed: ${error.code || 'error'}`);
  }

  async function refuse(id, kind, reason) {
    log(`[hostcommands] refused ${kind || '?'} ${id}: ${reason}`);
    await finish(id, 'refused', { error: reason });
  }

  /** @returns {Promise<boolean>} whether this host got the row */
  async function claim(id) {
    const { data, error } = await client
      .from('host_commands')
      .update({ status: 'claimed' })
      .eq('id', id)
      .eq('status', 'new')
      .eq('host', host)
      .select('id');
    if (error) {
      log(`[hostcommands] claim ${id} failed: ${error.code || 'error'}`);
      return false;
    }
    return Array.isArray(data) && data.length === 1;
  }

  /** Why a claimed row may not run, or null. */
  async function refusal(row) {
    if (row.host !== host) return 'wrong-host';
    if (row.expiresAt <= now()) return 'expired';
    if (row.expiresAt > now() + MAX_TTL_MS) return 'expiry-too-far';
    if (typeof verify !== 'function') return 'no-verifier';
    let verdict;
    try {
      verdict = await verify({ ...row, payload: { ...row.payload } });
    } catch (err) {
      return `verify-error: ${errText(err)}`;
    }
    if (!verdict || verdict.ok !== true) return (verdict && typeof verdict.reason === 'string' && verdict.reason.slice(0, MAX_ERROR)) || 'bad-signature';
    if (!Object.hasOwn(handlers, row.kind) || typeof handlers[row.kind] !== 'function') return 'unknown-kind';
    return null;
  }

  async function handle(raw) {
    const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : null;
    if (!id || !(await claim(id))) return;
    const row = cleanRow(raw);
    if (!row) return refuse(id, null, 'malformed');
    const why = await refusal(row);
    if (why) return refuse(id, row.kind, why);
    try {
      const result = await handlers[row.kind]({ ...row.payload }, row);
      await finish(id, 'done', fitResult(result));
    } catch (err) {
      log(`[hostcommands] ${row.kind} ${id} failed: ${errText(err)}`);
      await finish(id, 'failed', { error: errText(err) });
    }
  }

  async function readOnce() {
    const { data, error } = await client
      .from('host_commands')
      .select(COLUMNS)
      .eq('host', host)
      .eq('status', 'new')
      .order('created_at', { ascending: true })
      .limit(BATCH);
    if (error || !Array.isArray(data)) {
      log(`[hostcommands] read failed: ${(error && error.code) || 'error'}`);
      return;
    }
    // One at a time: a command never races the one before it.
    for (const raw of data) {
      if (stopped) return;
      await handle(raw);
    }
  }

  /**
   * One read; a trigger during it queues exactly one more. Resolves when the
   * reads in flight (the queued one included) are done.
   */
  function read() {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await readOnce();
        } while (again && !stopped);
      } catch (err) {
        log(`[hostcommands] read crashed: ${errText(err)}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function schedulePoll() {
    clearTimer(pollTimer);
    pollTimer = setTimer(async () => {
      pollTimer = null;
      if (!polling || stopped) return;
      await read();
      if (polling && !stopped) schedulePoll();
    }, POLL_MS);
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    log('[hostcommands] realtime down, polling every 3 s');
    schedulePoll();
  }

  function stopPolling() {
    polling = false;
    clearTimer(pollTimer);
    pollTimer = null;
  }

  function onLive() {
    clearTimer(liveTimer);
    liveTimer = setTimer(() => {
      liveTimer = null;
      read();
    }, LIVE_DEBOUNCE_MS);
  }

  function onStatus(status) {
    if (stopped) return;
    if (status === 'SUBSCRIBED') {
      stopPolling();
      read(); // whatever arrived while the socket was down
    } else if (BROKEN.has(status)) {
      startPolling();
    }
  }

  /**
   * A row this host claimed before a crash or quit never finishes on its own:
   * once past any allowed expiry it is marked failed, so the phone stops waiting.
   */
  async function failStale() {
    const cutoff = new Date(now() - MAX_TTL_MS).toISOString();
    const { error } = await client
      .from('host_commands')
      .update({ status: 'failed', result: { error: 'host-restarted' } })
      .eq('host', host)
      .eq('status', 'claimed')
      .lt('created_at', cutoff);
    if (error) log(`[hostcommands] clearing stale claims failed: ${error.code || 'error'}`);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failStale().catch((err) => log(`[hostcommands] clearing stale claims crashed: ${errText(err)}`));
      try {
        channel = client
          .channel(`lunacore-host-${host}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'host_commands', filter: `host=eq.${host}` }, onLive)
          .subscribe(onStatus);
      } catch (err) {
        log(`[hostcommands] subscribe failed: ${errText(err)}`);
        channel = null;
        startPolling();
      }
      read();
    },
    stop() {
      stopped = true;
      stopPolling();
      clearTimer(liveTimer);
      liveTimer = null;
      if (channel) {
        try {
          client.removeChannel(channel);
        } catch (err) {
          log(`[hostcommands] unsubscribe failed: ${errText(err)}`);
        }
      }
      channel = null;
    },
    /** For tests and the tray: one read now. */
    read,
    isPolling: () => polling,
  };
}

module.exports = { createHostCommands, cleanRow, fitResult, POLL_MS, MAX_TTL_MS };
