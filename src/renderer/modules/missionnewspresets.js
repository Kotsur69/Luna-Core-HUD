// ============================================================================
// LunaCore - Mission Control News: one-click presets (pure, renderer)
// ----------------------------------------------------------------------------
// A preset is a ready set of sources and topics; applying it merges into the
// saved lists (no duplicates, existing items untouched) and the result goes
// through mission:news-save, where main validates everything again. Subreddit
// names: see the roadmap (W5) for which were checked live against Reddit.
// ============================================================================

'use strict';

const reddit = (name) => ({ platform: 'reddit', target: name });

export const PRESETS = [
  {
    id: 'ai',
    sources: ['Anthropic', 'ClaudeAI', 'claudexplorers', 'LocalLLaMA', 'singularity'].map(reddit),
    topics: [
      { query: 'Claude Code', platforms: ['twitter'] },
      { query: 'Anthropic', platforms: ['twitter'] },
    ],
  },
  {
    id: 'hsr',
    sources: [reddit('HonkaiStarRail_leaks')],
    topics: [{ query: 'HSR leaks', platforms: ['twitter'] }],
  },
  {
    id: 'motorsport',
    sources: ['formula1', 'simracing', 'trackdays'].map(reddit),
    topics: [
      { query: 'F1', platforms: ['twitter'] },
      { query: 'WEC', platforms: ['twitter'] },
    ],
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
