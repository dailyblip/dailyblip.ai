// lib/reddit.js — OAuth2-based Reddit fetcher.
//
// WHY THIS EXISTS: Reddit now aggressively blocks unauthenticated requests
// (the old reddit.com/*.json trick) from datacenter/cloud IP ranges — which
// is exactly what GitHub Actions runners are. This isn't a URL problem or a
// header problem; it's a deliberate anti-bot policy, confirmed across
// multiple independent 2026 sources. The only reliable fix is to use
// Reddit's real, free, officially-supported OAuth path instead.
//
// SETUP REQUIRED (one-time, ~2 minutes):
//   1. Go to https://www.reddit.com/prefs/apps
//   2. Click "create app" / "create another app"
//   3. Name: anything (e.g. "dailyblip"). Type: SELECT "script".
//      Redirect URI: http://localhost (required field, unused for our flow).
//   4. After creating, you'll see:
//      - a client ID (the string under the app name, ~14 chars)
//      - a client secret (labeled "secret")
//   5. Add both as GitHub repo secrets:
//      REDDIT_CLIENT_ID = the client ID
//      REDDIT_CLIENT_SECRET = the secret
//
// GRACEFUL DEGRADATION: if these secrets aren't set, Reddit sources are
// skipped (not crashed) with a clear log message, same pattern as
// BUTTONDOWN_API_KEY being optional. The rest of the pipeline runs fine
// without Reddit; you just lose the Reddit-sourced portion of the
// Creator Spotlight until this is configured.

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;

  // Reuse a cached token within its lifetime (Reddit tokens last ~1 hour;
  // a single ingest run takes seconds, but caching avoids a redundant call
  // if fetchRedditWithScores is called multiple times in one run).
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "dailyblip/1.0 (by /u/dailyblip)",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`reddit: OAuth token request failed (${res.status}) — check REDDIT_CLIENT_ID/SECRET.`);
    return null;
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh a minute early
  return cachedToken;
}

/** Extract a subreddit name from either a full reddit URL or a bare name. */
function subredditFromSource(urlOrName) {
  const m = String(urlOrName).match(/reddit\.com\/r\/([^/]+)/i);
  return m ? m[1] : urlOrName.replace(/^\/?r\//i, "");
}

export async function fetchRedditWithScores(urlOrSubreddit) {
  const token = await getAccessToken();
  if (!token) {
    // No credentials configured — skip cleanly rather than attempt the
    // unauthenticated path, which is now unreliable from this environment.
    throw new Error("reddit: no OAuth credentials configured (set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)");
  }

  const subreddit = subredditFromSource(urlOrSubreddit);
  const res = await fetch(`https://oauth.reddit.com/r/${subreddit}/top?t=day&limit=25&raw_json=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "dailyblip/1.0 (by /u/dailyblip)",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`reddit oauth ${res.status}`);
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

// Community-validation gates. Unchanged from before — these are intentionally
// strict, the whole point of the anti-slop layer is that user-generated
// content must earn its way in with actual community proof.
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
