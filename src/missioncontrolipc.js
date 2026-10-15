// ============================================================================
// LunaCore - Mission Control IPC (main process)
// ----------------------------------------------------------------------------
// Wires the mission:* channels to the mail and calendar jobs, and the agenda
// to the Google Calendar API client (src/gcal.js - no model call), the
// GitHub telemetry to the gh CLI (src/missiongithub.js), and News to the
// vendored Agent-Reach bridge plus a Haiku summary (src/missionnews.js). Lives outside
// main.js on purpose (main.js is far past the file-size guideline); main.js
// only calls registerMissionIpc() once.
//
// State held here, and why:
//   - lastPreview: the validated mail preview. mission:mail-apply only trashes
//     ids found in it (see missionmail.js approvedTrashIds) - the renderer can
//     tick and untick, but it cannot introduce a thread id of its own.
//   - busy: one job per kind at a time. A double-click must not start two
//     overlapping inbox scans, each costing a full model call.
//   - seenEvents: the calendar events main itself read from Google. Event
//     weather is worked out from these, never from events the renderer sends.
// ============================================================================

'use strict';

const { runJob, MISSION_MODELS, DEFAULT_MISSION_MODEL } = require('./missionrunner');
const { loadMissionConfig } = require('./missionconfig');
const mail = require('./missionmail');
const cal = require('./missioncal');
const { createGcal } = require('./gcal');
const { createWeather } = require('./missionweather');
const { createGithub } = require('./missiongithub');
const { createTrending, buildDescribePrompt, parseDescription } = require('./missiontrending');
const { createNews, buildNewsPrompt, parseNewsSummary, publicSections } = require('./missionnews');
const newsStore = require('./missionnewsstore');
const projectStore = require('./missionprojects');

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
  // Pinned projects' folder aliases catch sessions from repos no longer on this PC.
  const { resolve } = createRepoKeys({ aliases: () => projectStore.pinnedAliases(projectStore.loadProjects().pinned) });
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

/** Native folder dialog; the path never comes from the renderer. */
async function defaultPickDir() {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = { title: 'Shared ledger folder', properties: ['openDirectory', 'createDirectory'] };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/** Native file dialog for the Google Desktop-app client JSON. */
async function defaultPickClientFile() {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    title: 'Google OAuth client (Desktop app) JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/** Minimum gap between two links opened from the renderer. */
const OPEN_GAP_MS = 500;

const TIMEOUTS = { preview: 300000, apply: 180000, parse: 60000, news: 180000, describe: 90000 };
const LANGS = ['pl', 'en'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 1000;
/** Min gap between two event edits or creates (a person saves one card at a time). */
const UPDATE_GAP_MS = 1000;
/** At most this many new events per window (a person adds a few at a time). */
const MAX_CREATES_PER_WINDOW = 30;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;
/** Min gap between two quick searches (X / Reddit ride the user's main accounts). */
const QUICK_SEARCH_GAP_MS = 10000;

/** Local ISO 8601 with the zone offset, e.g. 2026-10-08T14:03:00+02:00. */
function localIsoNow(date = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The opaque calendar keys gcal.listCalendars() hands out. */
const CAL_KEY_RE = /^[0-9a-f]{16}$/;

/** A GcalError keeps its reason; anything else is logged and made generic. */
function gcalFailure(err) {
  if (err && typeof err.reason === 'string') {
    console.error('[mission] google calendar:', err.reason, err.message);
    return { ok: false, reason: err.reason };
  }
  console.error('[mission] google calendar failed:', err && err.message);
  return { ok: false, reason: 'gcal-failed' };
}

/** A typed error (GithubError, NewsError) keeps its reason; anything else gets `fallback`. */
function typedFailure(label, err, fallback) {
  const reason = err && typeof err.reason === 'string' ? err.reason : fallback;
  console.error(`[mission] ${label}:`, reason, err && err.message);
  return { ok: false, reason };
}

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
  pickDir = defaultPickDir,
  pickClientFile = defaultPickClientFile,
}) {
  // Built on first use: requiring it is cheap, but tests never need the real one.
  let ledger = ledgerService;
  const getLedger = () => ledger || (ledger = defaultLedgerService(cloudSnapshots));
  let lastPreview = null;
  const busy = new Set();
  const seenEvents = new Map();
  /** Keeps the newest copy of each listed event; the oldest fall out first. */
  const rememberEvents = (events) => {
    for (const ev of events) {
      if (!ev || !ev.id) continue;
      seenEvents.delete(ev.id);
      seenEvents.set(ev.id, ev);
    }
    while (seenEvents.size > MAX_SEEN_EVENTS) seenEvents.delete(seenEvents.keys().next().value);
  };
  let lastOpenAt = 0;
  let lastQuickAt = 0;
  let lastUpdateAt = 0;
  let lastCreateAt = 0;
  let createTimes = [];

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

  // No argument: the next `days` days from now (the week list). `{month}`:
  // that whole calendar month (the month grid). Read from the Calendar API.
  ipcMain.handle('mission:cal-agenda', (_event, req) =>
    guarded('agenda', async () => {
      const { calendar } = loadMissionConfig();
      let from;
      let to;
      if (req && req.month !== undefined) {
        const bounds = cal.monthBounds(req.month);
        if (!bounds) return { ok: false, reason: 'bad-range' };
        ({ start: from, end: to } = bounds);
      } else {
        from = new Date();
        to = new Date(from.getTime() + calendar.days * DAY_MS);
      }
      try {
        const { events } = await gcal.listEvents({
          fromIso: localIsoNow(from),
          toIso: localIsoNow(to),
          categories: calendar.categories,
        });
        rememberEvents(events);
        return { ok: true, events };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Click-to-edit: title, times and location of one event main listed earlier.
  // The draft is validated like a quick-add draft; gcal decides which calendar.
  ipcMain.handle('mission:cal-update', (_event, req) =>
    guarded('update', async () => {
      const id = req && typeof req.id === 'string' && EVENT_ID_RE.test(req.id) ? req.id : null;
      if (!id) return { ok: false, reason: 'bad-draft' };
      const { calendar } = loadMissionConfig();
      const checked = cal.normalizeDraft(req.draft, calendar.categories);
      if (!checked.ok) return checked;
      // A person saves one card at a time; a renderer looping over every
      // editable event is throttled to a crawl. Only well-formed saves count.
      const nowMs = Date.now();
      if (nowMs - lastUpdateAt < UPDATE_GAP_MS) return { ok: false, reason: 'rate-limited' };
      lastUpdateAt = nowMs;
      try {
        const { event } = await gcal.updateEvent(id, checked.draft, calendar.categories);
        rememberEvents([event]);
        return { ok: true, event };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Weather for the listed events that have a place (Open-Meteo, free).
  // Not under `busy`: an idempotent read, and a dropped second call would be
  // the one that already sees a just-saved event.
  ipcMain.handle('mission:cal-weather', async () => {
    try {
      const { calendar } = loadMissionConfig();
      return { ok: true, weather: await weather.forEvents([...seenEvents.values()], calendar.weather) };
    } catch (err) {
      console.error('[mission] weather failed:', err && err.message);
      return { ok: false, reason: 'generic' };
    }
  });

  // Opens the browser for Google consent and waits (up to 3 min) for the
  // loopback redirect. One at a time: a second click while waiting is `busy`.
  // The Google "Desktop app" client JSON: picked in a native dialog here, so
  // the renderer never names a path; gcal.importClient validates and copies it.
  ipcMain.handle('mission:gcal-import-client', () =>
    guarded('gcal-import', async () => {
      const file = await pickClientFile();
      if (!file) return { ok: false, reason: 'cancelled' };
      try {
        gcal.importClient(file);
        return { ok: true, gcal: gcal.status() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  ipcMain.handle('mission:gcal-connect', () =>
    guarded('gcal-connect', async () => {
      try {
        await gcal.connect();
        return { ok: true, gcal: gcal.status() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

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
    guarded('ledger', () => {
      const resetsAt = req && typeof req.resetsAt === 'number' && Number.isFinite(req.resetsAt) ? req.resetsAt : null;
      return getLedger().report({ resetsAt });
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

  // The folder comes from a native dialog in main; any renderer argument is ignored.
  ipcMain.handle('mission:ledger-pick-dir', () =>
    guarded('ledger-dir', async () => {
      const dir = await pickDir();
      if (!dir) return { ok: false, reason: 'cancelled' };
      return { ok: true, sharedDir: projects.setSharedDir(dir).sharedDir };
    })
  );

  ipcMain.handle('mission:ledger-clear-dir', () =>
    guarded('ledger-dir', async () => ({ ok: true, sharedDir: projects.setSharedDir(null).sharedDir }))
  );

  // ---- News: Agent-Reach fetch (src/missionnews.js) + one lean Haiku job ----

  ipcMain.handle('mission:news-config', () => store.loadNews());

  ipcMain.handle('mission:news-save', (_event, raw) => {
    try {
      return { ok: true, news: store.saveNews(raw) };
    } catch (err) {
      console.error('[mission] news save failed:', err && err.message);
      return { ok: false, reason: 'generic' };
    }
  });

  ipcMain.handle('mission:news-status', () => guarded('news-status', async () => ({ ok: true, status: await news.status() })));

  // Creates the dedicated venv and installs Agent-Reach's dependencies (~1 min).
  ipcMain.handle('mission:news-setup', () =>
    guarded('news-setup', async () => {
      try {
        return { ok: true, status: await news.setup() };
      } catch (err) {
        return typedFailure('news setup', err, 'news-setup-failed');
      }
    })
  );

  // Adds twitter-cli + rdt-cli to the News venv (pinned, base pins as constraints).
  ipcMain.handle('mission:news-setup-social', () =>
    guarded('news-setup-social', async () => {
      try {
        return { ok: true, status: await news.setupSocial() };
      } catch (err) {
        return typedFailure('news setup social', err, 'news-setup-failed');
      }
    })
  );

  // 'x' | 'reddit': opens the bridge's own console where the user pastes the
  // login. The cookies never come through here - only this word does.
  ipcMain.handle('mission:news-configure', (_event, which) => {
    try {
      news.configure(typeof which === 'string' ? which : '');
      return { ok: true };
    } catch (err) {
      return typedFailure('news configure', err, 'bad-input');
    }
  });

  // req: {sourceIds[], topicIds[], adhoc?: {query, platform}, lang}. Ids are
  // looked up in the saved store; a quick search is re-validated like a saved
  // topic. The renderer cannot introduce a URL or a platform of its own.
  ipcMain.handle('mission:news-scan', (_event, req) =>
    guarded('news-scan', async () => {
      const raw = req && req.adhoc;
      const topic = raw && typeof raw === 'object' ? newsStore.normalizeTopic({ query: raw.query, platforms: [raw.platform] }) : null;
      const adhoc = topic ? { query: topic.query, platforms: topic.platforms } : null;
      if (adhoc) {
        // The logins are Mati's main accounts: no burst of quick searches.
        if (Date.now() - lastQuickAt < QUICK_SEARCH_GAP_MS) return { ok: false, reason: 'rate-limited' };
        lastQuickAt = Date.now();
      }
      const selection = { sourceIds: req && req.sourceIds, topicIds: req && req.topicIds, adhoc };
      let sections;
      try {
        sections = await news.fetchSections(store.loadNews(), selection);
      } catch (err) {
        return typedFailure('news fetch', err, 'news-fetch-failed');
      }
      // Nothing came back: no point paying for a summary of nothing.
      if (!sections.some((s) => s.entries.length)) {
        return { ok: true, briefing: [], sections: publicSections(sections), costUsd: null };
      }
      const lang = LANGS.includes(req && req.lang) ? req.lang : 'pl';
      const res = await job('news', buildNewsPrompt(sections, lang), { lean: true });
      if (!res.ok) return { ...res, sections: publicSections(sections) };
      const { briefing, summaries } = parseNewsSummary(res.answer, sections);
      return { ok: true, briefing, sections: publicSections(sections, summaries), costUsd: res.costUsd };
    })
  );

  ipcMain.on('mission:news-open', openResolved((key) => news.urlFor(key)));

  ipcMain.handle('mission:cal-parse', (_event, text) =>
    guarded('parse', async () => {
      if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
      const { calendar } = loadMissionConfig();
      const prompt = cal.buildParsePrompt({
        text,
        nowIso: localIsoNow(),
        timeZone: timeZone(),
        categories: calendar.categories,
      });
      const res = await job('parse', prompt, { lean: true });
      if (!res.ok) return res;
      const parsed = cal.normalizeDraft(res.answer, calendar.categories);
      return parsed.ok ? { ...parsed, costUsd: res.costUsd } : parsed;
    })
  );

  // The calendars a new event can go to, as opaque keys (a calendar id is an
  // email address; the renderer never sees one).
  ipcMain.handle('mission:cal-calendars', () =>
    guarded('calendars', async () => {
      try {
        return { ok: true, calendars: await gcal.listCalendars() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Creates the confirmed draft in the chosen calendar through the Calendar
  // API - no model. {draft, calendar}: the draft is re-validated (it has been
  // through the renderer since PARSE), the key must be one gcal handed out.
  ipcMain.handle('mission:cal-create', (_event, req) =>
    guarded('create', async () => {
      const key = req && typeof req.calendar === 'string' && CAL_KEY_RE.test(req.calendar) ? req.calendar : null;
      if (!key) return { ok: false, reason: 'bad-draft' };
      const { calendar } = loadMissionConfig();
      const checked = cal.normalizeDraft(req.draft, calendar.categories);
      if (!checked.ok) return checked;
      // Same throttle as edits: a renderer looping creates cannot flood the calendar.
      const nowMs = Date.now();
      if (nowMs - lastCreateAt < UPDATE_GAP_MS) return { ok: false, reason: 'rate-limited' };
      // And a ceiling per window: one a second would still be 3600 an hour.
      createTimes = createTimes.filter((at) => nowMs - at < CREATE_WINDOW_MS);
      if (createTimes.length >= MAX_CREATES_PER_WINDOW) return { ok: false, reason: 'rate-limited' };
      createTimes.push(nowMs);
      lastCreateAt = nowMs;
      try {
        const { event } = await gcal.createEvent(key, checked.draft, calendar.categories);
        rememberEvents([event]);
        return { ok: true, event };
      } catch (err) {
        // A network error can land after Google stored the event: say so
        // rather than invite a retry that duplicates it.
        if (err && err.reason === 'gcal-network') return { ok: false, reason: 'maybe-created' };
        return gcalFailure(err);
      }
    })
  );
}

module.exports = { registerMissionIpc, localIsoNow };
