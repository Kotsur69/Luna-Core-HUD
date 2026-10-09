// ============================================================================
// LunaCore - Mission Control News: one-click presets (pure, renderer)
// ----------------------------------------------------------------------------
// A preset is a ready set of sources and topics; applying it merges into the
// saved lists (no duplicates, existing items untouched) and the result goes
// through mission:news-save, where main validates everything again. Every
// subreddit and X account below was read live on 2026-10-09.
// ============================================================================

'use strict';

const reddit = (name) => ({ platform: 'reddit', target: name });
const x = (handle) => ({ platform: 'twitter', target: handle });

// X *search* answers 404 to twitter-cli 0.8.5 (2026-10-09), account timelines
// work - so the X part of each preset is official accounts, not search topics.
export const PRESETS = [
  {
    id: 'ai',
    sources: [
      ...['Anthropic', 'ClaudeAI', 'claudexplorers', 'LocalLLaMA', 'singularity'].map(reddit),
      ...['claudeai', 'AnthropicAI'].map(x),
    ],
    topics: [],
  },
  {
    id: 'hsr',
    sources: [reddit('HonkaiStarRail_leaks'), x('HonkaiStarRail')],
    topics: [],
  },
  {
    id: 'motorsport',
    sources: [...['formula1', 'simracing', 'trackdays'].map(reddit), ...['F1', 'FIAWEC'].map(x)],
    topics: [],
  },
  {
    id: 'dev',
    sources: [
      ...['programming', 'webdev', 'electronjs'].map(reddit),
      { platform: 'rss', target: 'https://news.ycombinator.com/rss', label: 'Hacker News' },
    ],
    topics: [{ query: 'trending', platforms: ['github'] }],
  },
];

const sourceKey = (s) => `${s.platform}:${String(s.target).toLowerCase()}`;
const topicKey = (t) => String(t.query).trim().toLowerCase();

/** news + preset -> a new news object; never mutates either. */
export function applyPreset(news, preset) {
  const have = new Set(news.sources.map(sourceKey));
  const sources = [...news.sources, ...preset.sources.filter((s) => !have.has(sourceKey(s))).map((s) => ({ ...s }))];
  const byQuery = new Map(news.topics.map((t) => [topicKey(t), t]));
  const merged = news.topics.map((t) => {
    const add = preset.topics.find((p) => topicKey(p) === topicKey(t));
    if (!add) return t;
    return { ...t, platforms: [...new Set([...t.platforms, ...add.platforms])] };
  });
  const fresh = preset.topics.filter((p) => !byQuery.has(topicKey(p))).map((p) => ({ ...p, platforms: [...p.platforms] }));
  return { ...news, sources, topics: [...merged, ...fresh] };
}
