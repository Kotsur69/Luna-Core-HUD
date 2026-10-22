// ============================================================================
// LunaCore - Setup Center + Getting started IPC (main process)
// ----------------------------------------------------------------------------
// setup:status            -> {ok, rows:[{id, state, note}], ownerUserId, pwaUrl}
// setup:check-tables      -> {ok, present, total, missing:[table]} | {ok:false, reason}
// setup:save-cloud {url, key} -> {ok, changedProject} | {ok:false, reason}
//                         (replacing another project asks main's confirmReplace())
// setup:set-pwa-url url|null -> {ok, pwaUrl} | {ok:false, reason}
// setup:pwa-qr            -> {ok, size, bits} | {ok:false, reason}
// setup:open target-id    -> opens one whitelisted page (fire and forget)
// setup:relaunch          -> restarts LunaCore so a new cloud config loads
// welcome:get             -> {show}
// welcome:dismiss {dontShow} -> {ok}
//
// The renderer is untrusted: payloads are checked here (setupcenter.js does
// the validation), URLs are built here from constants or the validated
// config, and answers carry state strings only - never the key, a token or
// raw error text. Every probe runs under a timeout (setupcenter.collectStatus).
// Lives outside main.js (past the file-size guideline); main.js calls
// captureFirstStart() before anything writes config, then registerSetupIpc().
// ============================================================================

'use strict';

const paths = require('./paths');
const center = require('./setupcenter');
const probes = require('./setupprobes');
const welcome = require('./welcome');
const gateway = require('./freellmgateway');
const { encodeQr } = require('./qrcode');
const { readUiPrefs, writeUiPrefs } = require('./uiprefs');

const STATUS_TTL_MS = 3000;
const MIN_TABLES_GAP_MS = 3000;
const MIN_RELAUNCH_GAP_MS = 5000;
const AGENT_REACH_TIMEOUT_MS = 20000;
const SAVE_REASONS = new Set(['bad-url', 'bad-key', 'secret-key', 'exists', 'save-failed']);
const REPO_URL = 'https://github.com/Kotsur69/Luna-Core-HUD';

/** Pages that need no project: target id -> URL. */
const STATIC_LINKS = Object.freeze({
  'supabase-new': 'https://supabase.com/dashboard/new',
  migrations: `${REPO_URL}/tree/main/supabase/migrations`,
  functions: `${REPO_URL}/tree/main/supabase/functions`,
  mobile: `${REPO_URL}/tree/main/mobile`,
  'google-console': 'https://console.cloud.google.com/apis/credentials',
  'google-consent': 'https://console.cloud.google.com/apis/credentials/consent',
  'vercel-new': 'https://vercel.com/new',
  'claude-install': 'https://docs.anthropic.com/en/docs/claude-code/setup',
  'gh-install': 'https://cli.github.com/',
  lmstudio: 'https://lmstudio.ai/',
  freellm: 'https://github.com/search?q=FreeLLMAPI&type=repositories',
});

/** Dashboard pages of the user's own project: target id -> path. */
const PROJECT_LINKS = Object.freeze({
  'supabase-sql': 'sql/new',
  'supabase-auth-providers': 'auth/providers',
  'supabase-url-config': 'auth/url-configuration',
  'supabase-functions': 'functions',
  'supabase-secrets': 'functions/secrets',
});

let firstStart = null;

/**
 * Snapshot of "did this profile have any *.local.json" - main calls this
 * first thing in app.whenReady(), before any module writes its own file.
 */
function captureFirstStart(dir = paths.userDir()) {
  if (firstStart === null) firstStart = { hadLocalConfig: welcome.hasLocalConfig(dir) };
  return firstStart;
}

/**
 * Runs the show/skip decision once per launch and records it.
 * @returns {boolean} whether the guide opens on this start
 */
function decideWelcomeOnce({ appVersion, readPrefs = readUiPrefs, writePrefs = writeUiPrefs, hadLocalConfig }) {
  const prefs = readPrefs();
  const decision = welcome.decideWelcome({
    appVersion,
    seen: prefs.welcomeSeen,
    checked: prefs.welcomeChecked === true,
    hasLocalConfig: hadLocalConfig,
  });
  if (decision === 'mark-seen') writePrefs({ welcomeSeen: appVersion, welcomeChecked: true });
  else if (!prefs.welcomeChecked) writePrefs({ welcomeChecked: true });
  return decision === 'show';
}

/** The default probes, built from the running app's modules. */
function defaultProbes({ cloud, gcal, claudeFound, state, cloudFile, readPrefs }) {
  let yazio = null;
  let news = null;
  const fileConfig = () => probes.readCloudConfig(cloudFile());
  const cloudStatus = () => {
    const c = cloud();
    return c ? c.status() : { configured: false, loggedIn: false };
  };
  const needsConfig = async (fn) => {
    const config = fileConfig();
    return config ? { configured: true, ...(await fn(config)) } : { configured: false };
  };
  return {
    claude: () => ({ installed: Boolean(claudeFound()), loggedIn: probes.claudeLoggedIn() }),
    gh: () => probes.ghAuthStatus(),
    cloud: () => {
      const st = cloudStatus();
      return {
        fileValid: Boolean(fileConfig()),
        running: st.configured === true && !state.restartPending,
        loggedIn: st.loggedIn === true,
      };
    },
    cloudTables: () => ({ configured: Boolean(fileConfig()), checked: Boolean(state.tables), ...(state.tables || {}) }),
    cloudAuth: () => needsConfig((c) => probes.probeAuth(c)),
    google: () => gcal.status(),
    functions: () => needsConfig((c) => probes.probeFunctions(c)),
    pwa: () => ({ url: readPrefs().pwaUrl }),
    host: () => {
      const st = cloudStatus();
      const { hasPairedPhone } = require('./hostpairing');
      return {
        configured: st.configured === true,
        loggedIn: st.loggedIn === true,
        paired: hasPairedPhone(paths.local('host-keys.local.json')),
      };
    },
    yazio: () => {
      if (!yazio) yazio = require('./lifeyazio').createYazio();
      return yazio.status();
    },
    agentReach: () => {
      if (!news) news = require('./missionnews').createNews();
      return news.status();
    },
    lmstudio: async () => {
      const [port, cli] = await Promise.all([
        require('./lmstudiosdk').findApiPort(),
        require('./lmstudiocli').detectLmsCli(),
      ]);
      return { running: Boolean(port), cli: Boolean(cli && cli.ok) };
    },
    freellm: () => gateway.gatewayStatus(gateway.loadGatewayPrefs().port),
  };
}

/**
 * A whitelisted target id -> the URL to open, or null. Project pages are
 * built from the validated config's ref; the PWA from the saved https URL.
 * @param {unknown} target
 * @param {() => {url:string}|null} config
 * @param {() => string|null} pwaUrl
 */
function linkFor(target, config, pwaUrl) {
  if (typeof target !== 'string') return null;
  if (Object.hasOwn(STATIC_LINKS, target)) return STATIC_LINKS[target];
  if (target === 'pwa') return pwaUrl() || null;
  if (!Object.hasOwn(PROJECT_LINKS, target)) return null;
  const c = config();
  const ref = c && center.projectRef(c.url);
  return ref ? `https://supabase.com/dashboard/project/${ref}/${PROJECT_LINKS[target]}` : null;
}

/**
 * @param {{ipcMain:object, shell:{openExternal:Function}, app:{getVersion:Function, relaunch:Function, quit:Function},
 *   cloud:()=>object|null, gcal:object, claudeFound:()=>unknown,
 *   deps?:{probes?:object, now?:()=>number, cloudFile?:()=>string, sessionFile?:()=>string,
 *     hadLocalConfig?:boolean, readPrefs?:Function, writePrefs?:Function}}} args
 */
function registerSetupIpc({ ipcMain, shell, app, cloud, gcal, claudeFound, confirmReplace = async () => false, deps = {} }) {
  const now = deps.now || Date.now;
  const cloudFile = deps.cloudFile || (() => paths.local(probes.CLOUD_FILE));
  const sessionFile = deps.sessionFile || (() => paths.local(probes.SESSION_FILE));
  const state = { tables: null, restartPending: false };
  const readPrefs = deps.readPrefs || readUiPrefs;
  const writePrefs = deps.writePrefs || writeUiPrefs;
  const probeSet = deps.probes || defaultProbes({ cloud, gcal, claudeFound, state, cloudFile, readPrefs });
  let statusCache = null; // {at, promise}
  let lastTablesAt = -Infinity;
  let lastRelaunchAt = -Infinity;

  const hadLocalConfig = typeof deps.hadLocalConfig === 'boolean' ? deps.hadLocalConfig : captureFirstStart().hadLocalConfig;
  const showWelcome = decideWelcomeOnce({ appVersion: app.getVersion(), hadLocalConfig, readPrefs, writePrefs });
  const invalidate = () => {
    statusCache = null;
  };

  async function buildStatus() {
    const rows = await center.collectStatus(probeSet, { timeouts: { agentReach: AGENT_REACH_TIMEOUT_MS } });
    const c = cloud();
    const ownerUserId = c && typeof c.userId === 'function' ? center.cleanUserId(c.userId()) : null;
    return { ok: true, rows, ownerUserId, pwaUrl: readPrefs().pwaUrl };
  }

  // Cached for a few seconds, so a looping renderer cannot spawn `gh` / Python
  // or hit Supabase in a tight loop.
  ipcMain.handle('setup:status', () => {
    if (!statusCache || now() - statusCache.at > STATUS_TTL_MS) {
      statusCache = { at: now(), promise: buildStatus().catch(() => ({ ok: false, reason: 'failed' })) };
    }
    return statusCache.promise;
  });

  ipcMain.handle('setup:check-tables', async () => {
    const config = probes.readCloudConfig(cloudFile());
    if (!config) return { ok: false, reason: 'not-configured' };
    if (now() - lastTablesAt < MIN_TABLES_GAP_MS) return { ok: false, reason: 'rate-limited' };
    lastTablesAt = now();
    const result = await center.withTimeout(() => probes.probeTables(config), center.DEFAULT_TIMEOUT_MS);
    if (result.failed) return { ok: false, reason: result.failed === 'timeout' ? 'timeout' : 'failed' };
    state.tables = { present: result.present, total: result.total };
    invalidate();
    return {
      ok: true,
      present: result.present,
      total: result.total,
      missing: result.missing.filter((t) => center.CLOUD_TABLES.includes(t)),
    };
  });

  ipcMain.handle('setup:save-cloud', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const checked = center.validateCloudInput({ url: input.url, key: input.key });
    if (!checked.ok) return { ok: false, reason: SAVE_REASONS.has(checked.reason) ? checked.reason : 'bad-key' };
    if (!deps.cloudFile) paths.ensureUserDir();
    const target = { file: cloudFile(), sessionFile: sessionFile() };
    let result = probes.writeCloudConfig(checked.config, target);
    // Another project is configured: only main's own dialog may approve the swap.
    if (!result.ok && result.reason === 'exists') {
      if (!(await confirmReplace())) return { ok: false, reason: 'cancelled' };
      result = probes.writeCloudConfig(checked.config, { ...target, replace: true });
    }
    if (!result.ok) return { ok: false, reason: SAVE_REASONS.has(result.reason) ? result.reason : 'save-failed' };
    // The sync engine reads its config once at startup: a restart applies it.
    state.restartPending = true;
    state.tables = null;
    invalidate();
    return { ok: true, changedProject: result.changedProject };
  });

  ipcMain.handle('setup:set-pwa-url', (_event, raw) => {
    const clear = raw === null || raw === '';
    const url = clear ? null : center.normalizePwaUrl(raw);
    if (!clear && !url) return { ok: false, reason: 'bad-url' };
    const next = writePrefs({ pwaUrl: url });
    invalidate();
    return next ? { ok: true, pwaUrl: next.pwaUrl } : { ok: false, reason: 'save-failed' };
  });

  ipcMain.handle('setup:pwa-qr', () => {
    const url = readPrefs().pwaUrl;
    const qr = url ? encodeQr(url) : null;
    return qr ? { ok: true, size: qr.size, bits: qr.bits } : { ok: false, reason: 'no-url' };
  });

  ipcMain.on('setup:open', (_event, target) => {
    const url = linkFor(target, () => probes.readCloudConfig(cloudFile()), () => readPrefs().pwaUrl);
    if (url) shell.openExternal(url);
  });

  ipcMain.on('setup:relaunch', () => {
    if (now() - lastRelaunchAt < MIN_RELAUNCH_GAP_MS) return;
    lastRelaunchAt = now();
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('welcome:get', () => ({ show: showWelcome }));

  ipcMain.handle('welcome:dismiss', (_event, payload) => {
    const dontShow = Boolean(payload && payload.dontShow === true);
    const next = writePrefs(dontShow ? { welcomeSeen: app.getVersion(), welcomeChecked: true } : { welcomeChecked: true });
    return { ok: Boolean(next) };
  });
}

module.exports = { registerSetupIpc, captureFirstStart, decideWelcomeOnce, linkFor, STATIC_LINKS, PROJECT_LINKS };
