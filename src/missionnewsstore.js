// ============================================================================
// LunaCore - Mission Control News: the saved sources and topics
// ----------------------------------------------------------------------------
// config/mission-news.local.json (gitignored by the *.local.json rule):
//   sources: [{id, platform, target, label}]   a feed the user clicks
//   topics:  [{id, query, platforms[]}]         keywords searched per platform
//
// Same contract as the other config loaders: safe read, validate at the
// boundary, a broken file yields empty lists rather than a crash. Everything
// here ends up as JSON on the bridge's stdin and as text in a model prompt,
// so every string is capped and every list is count-capped. The bridge
// (helpers/agent-reach/lunacore_fetch.py) re-validates every target with
// Agent-Reach's own URL guards before fetching.
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');

const FILE_NAME = 'mission-news.local.json';

/** Platforms a saved source can point at (twitter = an X account, reddit = a subreddit). */
const SOURCE_PLATFORMS = ['youtube', 'rss', 'web', 'github', 'twitter', 'reddit'];
/** Platforms a topic can be searched on (X / Reddit ride the user's own login). */
const TOPIC_PLATFORMS = ['youtube', 'github', 'bilibili', 'hackernews', 'twitter', 'reddit'];

const MAX_SOURCES = 50;
const MAX_TOPICS = 30;
const MAX_TARGET = 500;
const MAX_LABEL = 80;
const MAX_QUERY = 120;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const YT_HOST_RE = /^(www\.|m\.)?youtube\.com$/i;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const X_URL_RE = /^https:\/\/(www\.|mobile\.)?(x|twitter)\.com\/([^/?#]+)/i;
const REDDIT_URL_RE = /^https:\/\/(www\.|old\.|new\.)?reddit\.com\/r\/([^/?#]+)/i;

/** "@handle", "handle" or an x.com / twitter.com profile URL -> "handle", or ''. */
function xHandle(value) {
  const m = X_URL_RE.exec(value);
  const handle = (m ? m[3] : value).replace(/^@/, '');
  return HANDLE_RE.test(handle) ? handle : '';
}

/** "r/Name", "Name" or a reddit.com/r/Name URL -> "Name", or ''. */
function subreddit(value) {
  const m = REDDIT_URL_RE.exec(value);
  const name = (m ? m[2] : value).replace(/^\/?r\//i, '');
  return SUBREDDIT_RE.test(name) ? name : '';
}

/** Default label for a source without one. */
function sourceLabel(platform, target) {
  if (platform === 'twitter') return `@${target}`;
  if (platform === 'reddit') return `r/${target}`;
  return target;
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
// typeof first: RegExp.test(undefined) tests the string "undefined", which matches.
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

/** A http(s) URL string, or '' - the bridge applies the full public-host guard. */
function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Normalises a source target for its platform; '' when it does not fit. */
function sourceTarget(platform, raw) {
  const value = text(raw, MAX_TARGET);
  if (platform === 'twitter') return xHandle(value);
  if (platform === 'reddit') return subreddit(value);
  if (platform === 'github') {
    const repo = value.replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '');
    return REPO_RE.test(repo) ? repo : '';
  }
  const url = httpUrl(value);
  if (!url) return '';
  if (platform === 'youtube' && !YT_HOST_RE.test(new URL(url).hostname)) return '';
  return url;
}

/** One raw source -> a valid source, or null. */
function normalizeSource(raw) {
  if (!raw || !SOURCE_PLATFORMS.includes(raw.platform)) return null;
  const target = sourceTarget(raw.platform, raw.target);
  if (!target) return null;
  return {
    id: validId(raw.id) ? raw.id : newId('s'),
    platform: raw.platform,
    target,
    label: text(raw.label, MAX_LABEL) || sourceLabel(raw.platform, target),
  };
}

/** One raw topic -> a valid topic, or null. */
function normalizeTopic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // A leading "-" would read as a flag to the CLIs behind some platforms.
  const query = text(raw.query, MAX_QUERY).replace(/^-+\s*/, '');
  if (!query) return null;
  const platforms = Array.isArray(raw.platforms) ? raw.platforms.filter((p) => TOPIC_PLATFORMS.includes(p)) : [];
  if (platforms.length === 0) return null;
  return { id: validId(raw.id) ? raw.id : newId('t'), query, platforms: [...new Set(platforms)] };
}

/** Drops invalid rows, duplicate ids and anything past the caps. */
function normalizeNews(raw) {
  const unique = (list) => {
    const seen = new Set();
    return list.filter((row) => row && !seen.has(row.id) && seen.add(row.id));
  };
  const sources = Array.isArray(raw && raw.sources) ? raw.sources : [];
  const topics = Array.isArray(raw && raw.topics) ? raw.topics : [];
  return {
    sources: unique(sources.map(normalizeSource)).slice(0, MAX_SOURCES),
    topics: unique(topics.map(normalizeTopic)).slice(0, MAX_TOPICS),
  };
}

function loadNews(file = paths.local(FILE_NAME)) {
  try {
    return normalizeNews(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { sources: [], topics: [] };
  }
}

/** Validates and writes; returns what was saved so the renderer shows that. */
function saveNews(raw, file = paths.local(FILE_NAME)) {
  const next = normalizeNews(raw);
  if (file === paths.local(FILE_NAME)) paths.ensureUserDir();
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

module.exports = {
  loadNews,
  saveNews,
  normalizeNews,
  normalizeTopic,
  sourceTarget,
  SOURCE_PLATFORMS,
  TOPIC_PLATFORMS,
};
