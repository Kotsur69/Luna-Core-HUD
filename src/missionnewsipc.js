// ============================================================================
// LunaCore - Mission Control News IPC (main process)
// ----------------------------------------------------------------------------
// The mission:news-* channels, split out of missioncontrolipc.js: the
// vendored Agent-Reach bridge fetches (src/missionnews.js), one lean Haiku job
// summarises, and the briefing goes to the cloud for the phone and other PCs.
// ============================================================================

'use strict';

const { buildNewsPrompt, parseNewsSummary, publicSections, newsSnapshot } = require('./missionnews');
const newsStore = require('./missionnewsstore');
const { createNewsPeers } = require('./missionnewspeers');
const { LANGS, typedFailure } = require('./missionipcshared');

/** Min gap between two quick searches (X / Reddit ride the user's main accounts). */
const QUICK_SEARCH_GAP_MS = 10000;

/**
 * Registers the News channels.
 * @param {{ipcMain:object, guarded:Function, job:Function, openResolved:Function,
 *          news:object, store:object, cloudSnapshots:Function, brief:object}} ctx
 *   shared helpers and services from registerMissionIpc().
 */
function registerNewsIpc({ ipcMain, guarded, job, openResolved, news, store, cloudSnapshots, brief }) {
  // Other PCs' last briefings (`news` snapshots), keyed like a local scan.
  const newsPeers = createNewsPeers({ cloud: cloudSnapshots });
  let lastQuickAt = 0;

  /** The last briefing for the phone and other PCs; never waits, never throws -
   *  a broken snapshot must not discard a paid summary. */
  const putNewsSnapshot = (build) => {
    const log = (err) => console.error('[mission] news cloud snapshot failed:', err && err.message);
    try {
      const cloud = cloudSnapshots();
      if (!cloud) return;
      Promise.resolve()
        .then(() => cloud.put('news', build()))
        .catch(log);
    } catch (err) {
      log(err);
    }
  };

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
      // A quick search is a one-off: it must not replace the briefing the phone shows.
      if (!adhoc) {
        putNewsSnapshot(() => newsSnapshot({ briefing, sections, summaries, at: Date.now(), lang }));
        brief.rememberNews(briefing);
      }
      return { ok: true, briefing, sections: publicSections(sections, summaries), costUsd: res.costUsd };
    })
  );

  // Other PCs' last briefings as read-only reports: keys, never URLs.
  ipcMain.handle('mission:news-peers', () => guarded('news-peers', async () => ({ ok: true, reports: await newsPeers.list() })));

  ipcMain.on('mission:news-open', openResolved((key) => news.urlFor(key) || newsPeers.urlFor(key)));
}

module.exports = { registerNewsIpc };
