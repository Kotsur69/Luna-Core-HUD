// ============================================================================
// LunaCore - the host's first signed actions (main, host mode)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H1, "First fixed actions". Handlers for
// src/hostcommands.js, which runs one only after src/hostauth.js verified the
// grant and the command signature. What a handler returns is written to
// host_commands.result.
//
//   news.scan      every saved News source and topic, the same lean Haiku
//                  briefing as Mission Control -> the `news` snapshot
//   git.fetchAll   `git fetch` in every git-station repo, then the `repos`
//                  snapshot again
//   repo.clone     {url}: the hostrepos.js URL rules with any owner (it's Face
//                  ID signed), into <repos root>/<repo>; an existing folder or
//                  a bad URL is refused; a clone becomes a synced project
//                  entry with its remote
//
// The payload is untrusted even when signed: only `url` is read, and only
// through parseRemote(). Results carry statuses and counts, never paths.
// ============================================================================

'use strict';

const { parseRemote } = require('./hostrepos');
const { buildNewsPrompt, parseNewsSummary, newsSnapshot } = require('./missionnews');

const NEWS_TIMEOUT_MS = 180000;
const LANGS = ['pl', 'en'];

const MAX_URL = 300;

/**
 * A pasted "https://github.com/Owner/Repo(.git)" -> the lowercase normalised
 * form parseRemote() accepts (GitHub names are case-insensitive). Anything
 * that isn't https github.com stays as it is and is refused there.
 */
function cloneUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL || !/^https:\/\/github\.com\//i.test(raw)) return raw;
  return raw.toLowerCase().replace(/\.git$/, '');
}

/** Every saved source and topic: the phone's "scan" means the full briefing. */
const fullSelection = (saved) => ({
  sourceIds: (saved && Array.isArray(saved.sources) ? saved.sources : []).map((s) => s.id),
  topicIds: (saved && Array.isArray(saved.topics) ? saved.topics : []).map((t) => t.id),
});

/**
 * @param {{
 *   news: {fetchSections: Function},          missionnews.createNews()
 *   loadNews: () => object,                   missionnewsstore.loadNews
 *   runJob: Function,                         missionrunner.runJob
 *   model: () => string, env: () => object, lang?: () => string,
 *   snapshots: () => ({put: Function}|null),  the cloud's snapshots
 *   repoDirs: () => string[],                 the git station's repos
 *   fetchDir: (dir: string) => Promise<{ok: boolean}>,
 *   refreshRepos: () => Promise<unknown>,     re-reads and puts `repos`
 *   cloneRepo: (url: string) => Promise<{status: string, dir: string|null}>,  hostrepos clone
 *   folderExists: (url: string) => boolean,   the clone target is taken
 *   addProject: (entry: {path: string, remote: string}) => unknown,
 *   onProjectsChanged?: () => void,           sync the new entry soon
 *   now?: () => number,
 * }} deps
 */
function createHostActions(deps) {
  const now = deps.now || Date.now;

  async function newsScan() {
    const saved = deps.loadNews();
    const sections = await deps.news.fetchSections(saved, fullSelection(saved));
    if (!sections.some((s) => s.entries.length)) return { status: 'empty', items: 0 };
    const lang = LANGS.includes(deps.lang && deps.lang()) ? deps.lang() : 'pl';
    const res = await deps.runJob({ prompt: buildNewsPrompt(sections, lang), model: deps.model(), env: deps.env(), timeoutMs: NEWS_TIMEOUT_MS, lean: true });
    if (!res.ok) throw new Error(`news job: ${res.reason}`);
    const { briefing, summaries } = parseNewsSummary(res.answer, sections);
    const snap = newsSnapshot({ briefing, sections, summaries, at: now(), lang });
    const s = deps.snapshots();
    if (!s) throw new Error('cloud unavailable');
    await s.put('news', snap);
    return { status: 'done', items: briefing.length, costUsd: res.costUsd ?? null };
  }

  async function gitFetchAll() {
    const dirs = deps.repoDirs();
    const results = await Promise.all(dirs.map((dir) => deps.fetchDir(dir).then((r) => Boolean(r && r.ok), () => false)));
    await deps.refreshRepos();
    return { fetched: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
  }

  async function repoClone(payload) {
    const r = parseRemote(cloneUrl(payload && payload.url));
    if (!r) return { status: 'refused: invalid url' };
    if (deps.folderExists(r.url)) return { status: 'refused: folder exists' };
    const res = await deps.cloneRepo(r.url);
    if (res.status !== 'cloned' || !res.dir) return { status: res.status === 'skipped: folder exists' ? 'refused: folder exists' : res.status };
    deps.addProject({ path: res.dir, remote: r.url });
    if (deps.onProjectsChanged) deps.onProjectsChanged();
    return { status: 'cloned', name: r.name };
  }

  return { 'news.scan': newsScan, 'git.fetchAll': gitFetchAll, 'repo.clone': repoClone };
}

module.exports = { createHostActions, fullSelection, cloneUrl };
