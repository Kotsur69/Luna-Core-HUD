// ============================================================================
// LunaCore - Mission Control IPC (main process)
// ----------------------------------------------------------------------------
// Wires the mission:* channels to the mail and calendar jobs, and the agenda
// to the Google Calendar API client (src/gcal.js - no model call), the
// GitHub telemetry to the gh CLI (src/missiongithub.js), and News to the
// vendored Agent-Reach bridge plus a Haiku summary (src/missionnews.js), and the
// weekly / daily brief (src/missionbrief.js, mission:brief*). Lives outside
// main.js on purpose (main.js is far past the file-size guideline); main.js
// only calls registerMissionIpc() once.
//
// Calendar channels live in missioncalipc.js and News in missionnewsipc.js;
// this file builds the shared helpers and services and hands them over.
//
// State held here, and why:
//   - lastPreview: the validated mail preview. mission:mail-apply only trashes
//     ids found in it (see missionmail.js approvedTrashIds) - the renderer can
//     tick and untick, but it cannot introduce a thread id of its own.
//   - busy: one job per kind at a time. A double-click must not start two
//     overlapping inbox scans, each costing a full model call.
// ============================================================================

'use strict';

const { runJob, MISSION_MODELS, DEFAULT_MISSION_MODEL } = require('./missionrunner');
const { loadMissionConfig } = require('./missionconfig');
const mail = require('./missionmail');
const { createGcal } = require('./gcal');
const { createWeather } = require('./missionweather');
const { createGithub } = require('./missiongithub');
const { createTrending, buildDescribePrompt, parseDescription } = require('./missiontrending');
const { createNews } = require('./missionnews');
const newsStore = require('./missionnewsstore');
const projectStore = require('./missionprojects');
const { createBrief, createBriefStore, defaultSources, KINDS: BRIEF_KINDS } = require('./missionbrief');
const { LANGS, localIsoNow, typedFailure } = require('./missionipcshared');
const { registerCalendarIpc, defaultPickClientFile } = require('./missioncalipc');
const { registerNewsIpc } = require('./missionnewsipc');

/** The real ledger: this PC's ~/.claude/projects, priced with config/rates.json. */
function defaultLedgerService(cloudSnapshots) {
  const os = require('os');
  const path = require('path');
  const { createLedger } = require('./missionledger');
  const { createRepoKeys } = require('./missionrepokey');
  const { createLedgerService } = require('./missionledgerservice');
  const sync = require('./missionledgersync');
  const { loadRates } = require('./rates');
  const { createCommits } = require('./missioncommits');
  // Pinned (and unpinned) projects' folder aliases catch sessions from repos no longer on this PC.
  const { resolve } = createRepoKeys({ aliases: () => projectStore.pinnedAliases(projectStore.aliasEntries(projectStore.loadProjects())) });
  return createLedgerService({
    ledger: createLedger({ root: path.join(os.homedir(), '.claude', 'projects'), resolveKey: resolve }),
    // Focus time: own commits in config/repos.local.json, keyed like the transcripts.
    commits: createCommits({ resolveKey: resolve }),
    store: projectStore,
    sync,
    loadRates,
    machine: sync.machineName(os.hostname()),
    // Other PCs' ledgers through the cloud's `snapshots` table (cloudsnapshots.js).
    cloud: cloudSnapshots,
  });
}

/** The brief's real inputs: this module's ledger / calendar / weather plus the local stores. */
function defaultBriefSources({ getLedger, gcal, weather, projectNames }) {
  const { repoStats, openTodos } = require('./weeklycollect');
  return defaultSources({
    ledgerRange: (req) => getLedger().range(req),
    gcal,
    weather,
    loadMissionConfig,
    repoStats,
    listRepos: () => require('./gitstation').loadRepoList().repos,
    readTodoStore: () => require('./todo').readStore(),
    openTodos,
    projectNames,
    loadGoals: () => require('./lifegoals').loadGoals(),
    loadWeekly: () => require('./weeklyreview').createWeeklyStore().load(),
    localIsoNow,
  });
}

/** Minimum gap between two links opened from the renderer. */
const OPEN_GAP_MS = 500;

const TIMEOUTS = { preview: 300000, apply: 180000, parse: 60000, news: 180000, describe: 90000 };

/**
 * @param {{ipcMain:object, getModel:()=>string, getEnv:()=>Record<string,string>, run?:Function,
 *          gcal?:object, github?:object, news?:object, store?:object, openExternal?:(url:string)=>void}} deps
 *   Everything after getEnv is injectable so tests can exercise the handlers
 *   without a CLI, Python, the network, the disk or a browser.
 */
function registerMissionIpc({
  ipcMain,
  getModel,
  getEnv,
  run = runJob,
  gcal = createGcal(),
  weather = createWeather(),
  github = createGithub(),
  trending = createTrending(),
  news = createNews({
    linksFile: () => require('path').join(require('electron').app.getPath('userData'), 'news-links.json'),
  }),
  store = newsStore,
  openExternal = (url) => require('electron').shell.openExternal(url),
  ledgerService = null,
  cloudSnapshots = () => null,
  projects = projectStore,
  pickClientFile = defaultPickClientFile,
  briefStore = createBriefStore(),
  briefSources = null,
  projectNames = () => new Map(),
  onResume = null,
}) {
  // Built on first use: requiring it is cheap, but tests never need the real one.
  let ledger = ledgerService;
  const getLedger = () => ledger || (ledger = defaultLedgerService(cloudSnapshots));
  let lastPreview = null;
  // When lastPreview was scanned: the notification hub keys its item by it.
  let lastPreviewAt = 0;
  /** key -> name of the projects in the last ledger report, for mission:project-pin. */
  let knownProjects = new Map();
  const busy = new Set();
  let lastOpenAt = 0;

  /** Opens what `resolve` maps the renderer's key to - throttled, so a
   *  misbehaving renderer cannot fire a burst of browser tabs. */
  const openResolved = (resolve) => (_event, key) => {
    const url = resolve(key);
    const now = Date.now();
    if (!url || now - lastOpenAt < OPEN_GAP_MS) return;
    lastOpenAt = now;
    openExternal(url);
  };

  const model = () => {
    const m = getModel();
    return MISSION_MODELS.includes(m) ? m : DEFAULT_MISSION_MODEL;
  };

  /** Runs `fn` under the per-kind busy guard; always resolves. */
  async function guarded(kind, fn) {
    if (busy.has(kind)) return { ok: false, reason: 'busy' };
    busy.add(kind);
    try {
      return await fn();
    } catch (err) {
      console.error(`[mission] ${kind} failed:`, err && err.message);
      return { ok: false, reason: 'generic' };
    } finally {
      busy.delete(kind);
    }
  }

  // W6 brief: weekly on its own (start()), daily on 'Brief me'. Same runner,
  // same minimal env; its only tools are Gmail's read-only search + get.
  const brief = createBrief({
    store: briefStore,
    run: (opts) => run(opts),
    getEnv,
    onResume,
    sources: briefSources || defaultBriefSources({ getLedger, gcal, weather, projectNames }),
  });

  const job = (kind, prompt, opts) =>
    run({ prompt, model: model(), env: getEnv(), timeoutMs: TIMEOUTS[kind], ...opts });

  ipcMain.handle('mission:config', () => {
    const { calendar } = loadMissionConfig();
    return {
      model: model(),
      models: MISSION_MODELS,
      categories: calendar.categories,
      days: calendar.days,
      // Trackday events default to the trackday calendar in quick add.
      weatherCategory: calendar.weather.category,
      gcal: gcal.status(),
    };
  });

  ipcMain.handle('mission:mail-preview', () =>
    guarded('preview', async () => {
      const { mail: rules } = loadMissionConfig();
      const res = await job('preview', mail.buildMailPreviewPrompt(rules, localIsoNow()), {
        allowed: mail.PREVIEW_TOOLS,
      });
      if (!res.ok) return res;
      lastPreview = mail.parseMailPreview(res.answer);
      lastPreviewAt = Date.now();
      return { ok: true, preview: lastPreview, costUsd: res.costUsd };
    })
  );

  ipcMain.handle('mission:mail-apply', (_event, ids) =>
    guarded('apply', async () => {
      const approved = mail.approvedTrashIds(ids, lastPreview);
      if (approved.length === 0) return { ok: false, reason: 'nothing-approved' };
      const res = await job('apply', mail.buildMailApplyPrompt(approved), { allowed: mail.APPLY_TOOLS });
      if (!res.ok) return res;
      const result = mail.parseMailApply(res.answer, approved);
      // Trashed threads leave the preview, so a second Apply cannot re-send them.
      const gone = new Set(result.trashed);
      const keep = (r) => !gone.has(r.threadId);
      lastPreview = {
        ...lastPreview,
        trash: lastPreview.trash.filter(keep),
        needsCall: lastPreview.needsCall.filter(keep),
      };
      return { ok: true, ...result, costUsd: res.costUsd };
    })
  );

  registerCalendarIpc({ ipcMain, guarded, job, gcal, weather, pickClientFile });

  // GitHub telemetry through the `gh` CLI (src/missiongithub.js) - free.
  ipcMain.handle('mission:github', () =>
    guarded('github', async () => {
      try {
        return { ok: true, github: await github.fetch() };
      } catch (err) {
        return typedFailure('github', err, 'gh-failed');
      }
    })
  );

  // The renderer names an item id from the last fetch, never a URL.
  ipcMain.on('mission:github-open', openResolved((id) => github.urlFor(id)));

  // GitHub Trending, scraped from the public page (src/missiontrending.js) - free.
  // The renderer names a period ('daily' | 'weekly' | 'monthly'); main checks it.
  ipcMain.handle('mission:trending', (_event, period) =>
    guarded('trending', async () => {
      try {
        return { ok: true, trending: await trending.fetch(typeof period === 'string' ? period : undefined) };
      } catch (err) {
        return typedFailure('trending', err, 'trending-failed');
      }
    })
  );

  ipcMain.on('mission:trending-open', openResolved((id) => trending.urlFor(id)));

  // One lean Haiku job over the repo README: req {id, lang}. The id must come from
  // the last trending fetch - the renderer cannot name a repo of its own.
  ipcMain.handle('mission:trending-describe', (_event, req) =>
    guarded('trending-describe', async () => {
      const input = await trending.describeInput(req && req.id);
      if (!input) return { ok: false, reason: 'bad-input' };
      const lang = LANGS.includes(req && req.lang) ? req.lang : 'pl';
      const res = await job('describe', buildDescribePrompt(input, lang), { lean: true });
      if (!res.ok) return res;
      const description = parseDescription(res.answer);
      if (!description) return { ok: false, reason: 'bad-json', costUsd: res.costUsd };
      return { ok: true, description, costUsd: res.costUsd };
    })
  );

  // ---- Ledger: Claude spend per project (src/missionledgerservice.js) - free ----

  // req: {resetsAt} - epoch ms of the weekly reset from the usage poll. Only
  // that number crosses; the service re-checks it is plausible.
  ipcMain.handle('mission:ledger', (_event, req) =>
    guarded('ledger', async () => {
      const resetsAt = req && typeof req.resetsAt === 'number' && Number.isFinite(req.resetsAt) ? req.resetsAt : null;
      const report = await getLedger().report({ resetsAt });
      if (report && report.ok && Array.isArray(report.projects)) {
        knownProjects = new Map(report.projects.filter((p) => p.key !== 'other').map((p) => [p.key, p.name]));
      }
      return report;
    })
  );

  // {key, cls}: cls 'work' | 'fun' | 'other' | null. The store validates both.
  ipcMain.handle('mission:project-class', (_event, req) => {
    try {
      projects.setClass(req && req.key, req && req.cls !== undefined ? req.cls : null);
      return { ok: true };
    } catch (err) {
      console.error('[mission] project class rejected:', err && err.message);
      return { ok: false, reason: 'bad-input' };
    }
  });

  // {key, pinned}: the key must be a project of the last ledger report (the
  // renderer can only pin what it was shown); the name comes from that report.
  ipcMain.handle('mission:project-pin', (_event, req) => {
    const key = req && req.key;
    if (typeof key !== 'string' || !knownProjects.has(key) || typeof (req && req.pinned) !== 'boolean') {
      return { ok: false, reason: 'bad-input' };
    }
    try {
      projects.setPin(key, req.pinned, knownProjects.get(key));
      return { ok: true };
    } catch (err) {
      console.error('[mission] project pin rejected:', err && err.message);
      return { ok: false, reason: 'bad-input' };
    }
  });

  registerNewsIpc({ ipcMain, guarded, job, openResolved, news, store, cloudSnapshots, brief });

  // ---- Brief (src/missionbrief.js): weekly on its own, daily on click ----

  const briefView = (req) => {
    const s = briefStore.load();
    const pick = (kind) => {
      const keys = Object.keys(s[kind]).sort().reverse();
      const want = req && typeof req[kind] === 'string' ? req[kind] : null;
      return { keys, entry: s[kind][want && s[kind][want] ? want : keys[0]] || null };
    };
    return { ok: true, weekly: pick('weekly'), daily: pick('daily'), model: s.model, models: MISSION_MODELS, busy: BRIEF_KINDS.filter((k) => brief.isBusy(k)) };
  };
  const safeBriefView = (req) => {
    try {
      return briefView(req);
    } catch (err) {
      console.error('[mission] brief view failed:', err && err.message);
      return { ok: false, reason: 'generic' };
    }
  };

  // req: {weekly?, daily?} - history keys to show; anything else shows the newest.
  ipcMain.handle('mission:brief', (_event, req) => safeBriefView(req));

  // req: {kind: 'weekly' | 'daily', overwrite}. 'exists' until the renderer
  // confirms a Regenerate. One call per kind at a time (brief's own guard).
  ipcMain.handle('mission:brief-run', async (_event, req) => {
    const kind = req && BRIEF_KINDS.includes(req.kind) ? req.kind : null;
    if (!kind) return { ok: false, reason: 'bad-input' };
    const res = await brief.generate(kind, { overwrite: req.overwrite === true });
    return res.ok ? safeBriefView({}) : res;
  });

  ipcMain.handle('mission:brief-model', (_event, req) => {
    try {
      briefStore.setModel(req && req.model);
      return safeBriefView({});
    } catch {
      return { ok: false, reason: 'bad-input' };
    }
  });

  // The same ledger and GitHub reader for the Life dashboard's score
  // (src/lifeipc.js), so transcripts and commits are scanned by one cache.
  return {
    ledger: { report: (req) => getLedger().report(req), range: (req) => getLedger().range(req) },
    github,
    brief,
    // The notification hub (src/hubipc.js): how many threads of the last scan
    // still wait for Mati's call. Counts only - no sender or subject leaves.
    mailNeeds: () => (lastPreview && Array.isArray(lastPreview.needsCall) ? { needsCall: lastPreview.needsCall.length, at: lastPreviewAt } : null),
  };
}

module.exports = { registerMissionIpc, localIsoNow };
