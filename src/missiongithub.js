// ============================================================================
// LunaCore - Mission Control: GitHub telemetry (main process)
// ----------------------------------------------------------------------------
// One GraphQL query through the GitHub CLI (`gh api graphql`): the daily
// contribution counts for the last WEEKS weeks, plus the open PRs, review
// requests and assigned issues of the signed-in user. Free - no model call -
// and no token of ours: `gh` owns the credential (its own keyring entry), so
// LunaCore never stores or sees it.
//
// Trust boundary: the query and every argument are constants or dates built
// here; execFile runs without a shell, so nothing from the renderer reaches the
// command line. The response is untrusted data and is normalised field by
// field - URLs must be https://github.com/<owner>/<repo>/(pull|issues)/<n>,
// strings are capped. URLs never go to the renderer: it gets an opaque item
// id, and mission:github-open resolves that id against the last fetch (the
// intent-not-address rule of libraries:open in main.js).
// ============================================================================

'use strict';

const { execFile } = require('child_process');

/** Weeks of contribution history: enough for a 4-week average plus a heatmap. */
const WEEKS = 12;
const ITEMS_PER_LIST = 10;
const TIMEOUT_MS = 20000;
const MAX_TITLE = 200;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Owner: letters, digits, hyphens. Repo: GitHub's charset, but never '.' or '..'.
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/(?!\.\.?\/)[\w.-]+\/(pull|issues)\/\d+$/;

const QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
  prs: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: ${ITEMS_PER_LIST}) {
    issueCount
    nodes { ... on PullRequest { title url isDraft updatedAt repository { nameWithOwner } } }
  }
  reviews: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: ${ITEMS_PER_LIST}) {
    issueCount
    nodes { ... on PullRequest { title url updatedAt repository { nameWithOwner } } }
  }
  issues: search(query: "is:issue is:open assignee:@me archived:false", type: ISSUE, first: ${ITEMS_PER_LIST}) {
    issueCount
    nodes { ... on Issue { title url updatedAt repository { nameWithOwner } } }
  }
}`;

const LISTS = ['prs', 'reviews', 'issues'];

class GithubError extends Error {
  /** @param {'gh-missing'|'gh-auth'|'gh-timeout'|'gh-failed'} reason */
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

/** Monday 00:00 local time, `weeksBack` weeks before the week holding `now`. */
function historyStart(now, weeksBack = WEEKS - 1) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday - weeksBack * 7);
  return d;
}

const str = (v, max = MAX_TITLE) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One search result node -> an item (url included), or null if anything is off. */
function normalizeItem(node, kind, index) {
  if (!node || typeof node.url !== 'string' || !GITHUB_URL_RE.test(node.url)) return null;
  return {
    id: `${kind}:${index}`,
    title: str(node.title) || '(no title)',
    repo: str(node.repository && node.repository.nameWithOwner, 100),
    draft: node.isDraft === true,
    updatedAt: str(node.updatedAt, 40),
    url: node.url,
  };
}

/**
 * The raw GraphQL response -> {login, days, lists}. Throws gh-failed on a
 * shape that is not a GitHub answer at all; tolerates missing optional parts.
 */
function normalizeGithub(raw) {
  const data = raw && raw.data;
  const viewer = data && data.viewer;
  if (!viewer || typeof viewer.login !== 'string') throw new GithubError('gh-failed', 'no viewer in response');
  const weeks = viewer.contributionsCollection?.contributionCalendar?.weeks;
  const days = [];
  for (const week of Array.isArray(weeks) ? weeks : []) {
    for (const day of Array.isArray(week && week.contributionDays) ? week.contributionDays : []) {
      const count = day && day.contributionCount;
      if (day && DAY_RE.test(day.date) && Number.isInteger(count) && count >= 0) {
        days.push({ date: day.date, count });
      }
    }
  }
  const lists = {};
  for (const kind of LISTS) {
    const search = data[kind] || {};
    const nodes = Array.isArray(search.nodes) ? search.nodes : [];
    lists[kind] = {
      count: Number.isInteger(search.issueCount) && search.issueCount >= 0 ? search.issueCount : 0,
      items: nodes.map((n, i) => normalizeItem(n, kind, i)).filter(Boolean),
    };
  }
  return { login: str(viewer.login, 60), days, lists };
}

/** Maps a failed `gh` run to a reason the UI can explain. */
function classifyFailure(err, stderr) {
  if (err && err.code === 'ENOENT') return 'gh-missing';
  if (err && err.killed) return 'gh-timeout';
  if (/gh auth login|not logged in|authentication|HTTP 401/i.test(String(stderr))) return 'gh-auth';
  return 'gh-failed';
}

/** Runs `gh` with fixed arguments; resolves stdout or rejects a GithubError. */
function runGhDefault(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new GithubError(classifyFailure(err, stderr), String(stderr || err.message).slice(0, 300)));
        else resolve(stdout);
      }
    );
  });
}

/**
 * @param {{runGh?:(args:string[])=>Promise<string>, now?:()=>Date}} [deps]
 *   Both injectable so tests run without `gh` or a clock.
 * @returns {{fetch:()=>Promise<object>, urlFor:(id:string)=>string|null}}
 */
function createGithub({ runGh = runGhDefault, now = () => new Date() } = {}) {
  // id -> url from the most recent successful fetch; nothing else is openable.
  let urls = new Map();

  async function fetch() {
    const at = now();
    const stdout = await runGh([
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-f',
      `from=${historyStart(at).toISOString()}`,
      '-f',
      `to=${at.toISOString()}`,
    ]);
    let raw;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new GithubError('gh-failed', 'gh returned non-JSON output');
    }
    const { login, days, lists } = normalizeGithub(raw);
    urls = new Map(LISTS.flatMap((kind) => lists[kind].items.map((it) => [it.id, it.url])));
    // The renderer gets everything but the URLs.
    const stripped = Object.fromEntries(
      LISTS.map((kind) => [
        kind,
        { count: lists[kind].count, items: lists[kind].items.map(({ url, ...rest }) => rest) },
      ])
    );
    return { login, days, lists: stripped };
  }

  return { fetch, urlFor: (id) => (typeof id === 'string' && urls.get(id)) || null };
}

module.exports = { createGithub, normalizeGithub, historyStart, classifyFailure, GithubError, WEEKS };
