// lib/reddit.js — pull upvotes + comments straight from Reddit's JSON API so
// we can gate showcase-style feeds on community validation. RSS strips the
// score; the JSON endpoint keeps it.
//
// Uses the same URL as the RSS feed but appends ".json" instead of ".rss".
// Public, no auth needed. Reddit rate-limits by IP — same caveat as RSS.

export async function fetchRedditWithScores(rssUrl) {
  const jsonUrl = rssUrl.replace(/\.rss(\?.*)?$/, ".json$1");
  const res = await fetch(jsonUrl, {
    signal: AbortSignal.timeout(12000),
    headers: { "user-agent": "dailyblip-ingest/1.0 (by /u/dailyblip)" },
  });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const data = await res.json();
  const posts = data?.data?.children || [];
  return posts.map(({ data: p }) => ({
    title: (p.title || "").trim(),
    url: `https://reddit.com${p.permalink}`,
    external_url: p.url_overridden_by_dest || `https://reddit.com${p.permalink}`,
    snippet: (p.selftext || "").slice(0, 400),
    published: new Date((p.created_utc || 0) * 1000).toISOString(),
    score: p.score || 0,
    num_comments: p.num_comments || 0,
    upvote_ratio: p.upvote_ratio ?? 1,
    over_18: !!p.over_18,
    stickied: !!p.stickied,
  }));
}

// Community-validation gates. These are intentionally strict — the whole
// point of the anti-slop layer is that user-generated content must earn
// its way in with actual community proof.
//
// showcase: raised to 1,000+ upvotes on 2026-07-11 — 500 was letting through
// merely-popular AI video that wasn't actually good, just good enough to
// scroll past and tap. 1K is a much harder bar to clear by accident.
export const REDDIT_TIERS = {
  showcase: { minScore: 1000, minComments: 30, minAgeHours: 24, minRatio: 0.88 },
  discussion: { minScore: 200, minComments: 15, minAgeHours: 12, minRatio: 0.80 },
  news: { minScore: 100, minComments: 5, minAgeHours: 6, minRatio: 0.75 },
};

export function passesRedditGate(post, tier = "showcase") {
  const gate = REDDIT_TIERS[tier] || REDDIT_TIERS.showcase;
  if (post.over_18 || post.stickied) return false;
  if (post.score < gate.minScore) return false;
  if (post.num_comments < gate.minComments) return false;
  if (post.upvote_ratio < gate.minRatio) return false;
  const ageHours = (Date.now() - new Date(post.published).getTime()) / 3.6e6;
  if (ageHours < gate.minAgeHours) return false;
  return true;
}
