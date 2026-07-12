// pipeline/ingest.js — runs every ~20 minutes via GitHub Actions.
// RSS in → dedupe → ground in article text → Claude classifies, summarizes,
// and flags Creator Spotlight stories → docs/data/feed.json out.
// Also records per-source health so the weekly curator can heal the source list.
import Parser from "rss-parser";
import { askJSON } from "./lib/claude.js";
import {
  loadFeed, saveFeed, loadSeen, saveSeen,
  loadSources, loadHealth, saveHealth, readJSON, PATHS,
} from "./lib/store.js";
import { hash, canonicalUrl, dedupeCluster } from "./lib/text.js";
import { fetchRedditWithScores, passesRedditGate } from "./lib/reddit.js";
import path from "node:path";
import fsMod from "node:fs";

const OVERRIDES_PATH = path.join(path.dirname(PATHS.seen), "overrides.json");
const loadOverrides = () => readJSON(OVERRIDES_PATH, { blocked_ids: [], blocked_terms: [], pinned_spotlight: [] });

const LOOKBACK_HOURS = 48;
const MAX_STORIES = 60;
const MAX_NEW_PER_RUN = 25;
const MAX_SPOTLIGHT = 3;

const CATEGORIES = ["image", "video", "music", "writing", "tools", "rights", "industry"];

// Signal heat: how alive a story is right now. Recomputed every run so the
// ranking shifts through the day — the reason to reload the page.
function heatScore(s) {
  const quality = (s.quality ?? 5) * 10;
  const corroboration = (s.also?.length || 0) * 12;
  const hoursOld = Math.max(0, (Date.now() - new Date(s.ts)) / 3.6e6);
  const freshness = Math.max(0, 24 - hoursOld);                // 0–24
  const community = s.community_score ? Math.log10(1 + s.community_score) * 8 : 0;
  const badgeBoost = s.badge === "breaking" ? 15 : s.badge === "hot" ? 8 : 0;
  return Math.round(quality + corroboration + freshness + community + badgeBoost);
}

const CLASSIFY_SYSTEM = `You are the wire editor for dailyblip, an AI-news site for CONTENT CREATORS — image, video, music, writing. You have ZERO TOLERANCE for AI slop. Being ruthless here is the entire point.

For each item return:
- keep (boolean): true only if this clears the bar. Keep: real model/tool launches and updates, pricing changes, sunsets and deadlines, workflow techniques a working creator would use, copyright/licensing developments, platform policy affecting creators, industry news that ripples into creative tools, and genuine maker stories (see spotlight rules). DROP hard: enterprise B2B minutiae, funding rounds with no shipped product, academic papers with no usable tool, listicle/SEO filler, sponsored content, ads, tutorials from content mills, generic "AI is changing everything" think-pieces.

- spotlight (boolean): true ONLY if this is a person or small team who MADE something praise-worthy with AI. Judge like a working professional creator:
    REJECT — generic "AI aesthetic" with no distinctive point of view; visible artifacts (bad hands, warped text, morphing objects/faces); recycled prompt tropes ("cinematic, hyperrealistic, 8K, trending on artstation"); NSFW, waifu-bait, anime/game character portraits with no unique execution; "workflow" posts that are really product ads; explainer videos with an AI voiceover; anything a working creator would be embarrassed to put on a reel.
    ACCEPT — deliberate artistic choices, a specific point of view, evidence of technical control (character consistency, cohesive style, deliberate composition), work that would earn a nod from a professional in that medium.
  Product/policy news is never spotlight. When in doubt, REJECT.

- quality (integer 1–10): honest editorial rating.
    1–3 = slop or fluff, should have been dropped (keep=false).
    4–5 = tolerable industry news, worth including but not featured.
    6–7 = solid, meaningful signal for creators.
    8–9 = must-read, moves the needle.
    10 = era-defining.
  Be stingy — most items are 4–6. Only spotlight-worthy work or genuinely major releases score 8+.

- category: one of ${JSON.stringify(CATEGORIES)}. "rights" = copyright, licensing, crawler policy. "tools" = suites, plugins, platforms. Spotlight stories still get their medium's category.
- badge: "breaking" (major, <6h old), "hot" (big story), "new" (default).
- headline: title cleaned — sentence-cased claims, no clickbait, no site names, max 90 chars.
- dek: 1–2 sentences (max 45 words) IN YOUR OWN WORDS. Ground every claim ONLY in the title/snippet/excerpt provided — if the excerpt doesn't support a detail, leave it out. Concrete over hype. Never copy source wording.
- read_min: source read time estimate, 2–6.

For Reddit sources, you are told community score and comment count. Treat those as validation but not as a pass — a 5,000-upvote post can still be slop and gets rejected on its merits.

Return a JSON array in the same order as input: {"keep":bool,"spotlight":bool,"quality":n,"category":"...","badge":"...","headline":"...","dek":"...","read_min":n}. JSON only.`;

async function fetchAllFeeds(feeds) {
  // A realistic browser User-Agent avoids basic Cloudflare/WAF bot filters
  // that block generic script-y agent strings — this alone fixed a 403 we
  // were seeing on at least one journalism-tier source.
  const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const parser = new Parser({ timeout: 15000, headers: { "user-agent": BROWSER_UA } });

  // Some feeds ship genuinely malformed XML (a stray "&" that isn't part of
  // a valid entity, e.g. "R&D" instead of "R&amp;D"). rss-parser's strict
  // XML parser chokes on this with "Invalid character in entity name" and
  // fails the whole feed. Fetch raw text ourselves first and repair any
  // bare ampersands before handing it to the parser — cheap, safe, and
  // fixes an entire class of "feed failed" errors that aren't actually
  // dead feeds, just slightly invalid ones.
  async function fetchAndParseRss(parser, url) {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": BROWSER_UA },
    });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    let xml = await res.text();
    // Escape any "&" not already part of a recognized entity.
    xml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
    return parser.parseString(xml);
  }
  const perFeed = {};
  const active = feeds.filter((f) => !f.disabled);

  const results = await Promise.allSettled(
    active.map(async (f) => {
      // Reddit sources go through OAuth (see lib/reddit.js) so we have
      // upvote + comment counts to gate on, and so requests actually work
      // from GitHub's datacenter IPs. If REDDIT_CLIENT_ID/SECRET aren't
      // configured, this throws and is caught below like any other feed
      // failure — Reddit sources just sit out until it's set up.
      if (f.reddit_tier) {
        const posts = await fetchRedditWithScores(f.url);
        const raw = posts.length;
        const gated = posts.filter((p) => passesRedditGate(p, f.reddit_tier));
        perFeed[f.name] = { ok: true, count: gated.length, raw, filtered: raw - gated.length };
        return gated.map((p) => ({
          title: p.title,
          url: p.external_url || p.url,
          snippet: p.snippet,
          published: p.published,
          source: f.name,
          hint: f.hint,
          tier: f.tier || "community",
          community_score: p.score,
          community_comments: p.num_comments,
        }));
      }

      const parsed = await fetchAndParseRss(parser, f.url);
      const items = (parsed.items || []).map((item) => ({
        title: (item.title || "").trim(),
        url: item.link || item.guid || "",
        snippet: (item.contentSnippet || item.summary || "").slice(0, 400),
        published: item.isoDate || item.pubDate || new Date().toISOString(),
        source: f.name,
        hint: f.hint,
        tier: f.tier || "journalism",
      }));
      perFeed[f.name] = { ok: true, count: items.length };
      return items;
    })
  );

  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      perFeed[active[i].name] = { ok: false, count: 0 };
      console.warn(`feed failed: ${active[i].name} — ${r.reason?.message || r.reason}`);
    }
  });
  // Diagnostic: one line per healthy feed so a "scanned 0" run is explainable
  // from the log alone (did sources return nothing, or did filters eat it?).
  for (const [name, info] of Object.entries(perFeed)) {
    if (info.ok) console.log(`feed ok: ${name} — ${info.count} items`);
  }
  return { items, perFeed };
}

function recordHealth(perFeed) {
  const health = loadHealth();
  const today = new Date().toISOString().slice(0, 10);
  for (const [name, { ok, count }] of Object.entries(perFeed)) {
    const rec = (health[name] ||= { days: {}, consecutive_failures: 0 });
    rec.days[today] = (rec.days[today] || 0) + count;
    rec.consecutive_failures = ok ? 0 : (rec.consecutive_failures || 0) + 1;
  }
  saveHealth(health);
}

/** Ground the classifier: fetch each article and pull og:description + first paragraphs. */
async function fetchExcerpt(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0 (dailyblip; +https://dailyblip.ai)" },
    });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 200000);
    const og = html.match(/property=["']og:description["'][^>]*content=["']([^"']{20,500})["']/i)?.[1]
      || html.match(/content=["']([^"']{20,500})["'][^>]*property=["']og:description["']/i)?.[1] || "";
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 60)
      .slice(0, 3)
      .join(" ");
    return (og + " " + paras).trim().slice(0, 1200);
  } catch { return ""; }
}

async function main() {
  const { feeds } = loadSources();
  const seen = loadSeen();
  const feed = loadFeed();
  const overrides = loadOverrides();
  const blockedIds = new Set(overrides.blocked_ids || []);
  const blockedTerms = (overrides.blocked_terms || []).map((t) => t.toLowerCase()).filter(Boolean);
  const pinnedSpot = new Set(overrides.pinned_spotlight || []);

  // 1. Pull everything; record source health; drop stale/seen/empty/blocked.
  const { items: raw, perFeed } = await fetchAllFeeds(feeds);
  recordHealth(perFeed);

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const rawCount = raw.length;
  const fresh = raw.filter((it) => it.title && it.url && new Date(it.published).getTime() >= cutoff);

  // Per-source freshness breakdown — the aggregate "X within 48h" number
  // can hide a source-specific bug (e.g. a date-parsing failure making a
  // frequently-updated feed look falsely old). This shows, per source:
  // how many items it returned vs. how many of those are actually fresh,
  // plus the single newest timestamp seen from that source so a broken
  // date parse (e.g. epoch 0, or a wildly future/past date) is obvious.
  const bySource = {};
  for (const it of raw) {
    const s = (bySource[it.source] ||= { total: 0, freshCount: 0, newest: null });
    s.total++;
    const t = new Date(it.published).getTime();
    if (t >= cutoff) s.freshCount++;
    if (!s.newest || t > new Date(s.newest).getTime()) s.newest = it.published;
  }
  for (const [name, s] of Object.entries(bySource)) {
    console.log(`freshness: ${name} — ${s.freshCount}/${s.total} within ${LOOKBACK_HOURS}h, newest item: ${s.newest}`);
  }

  let items = fresh.filter((it) => {
    const id = "s_" + hash(canonicalUrl(it.url));
    if (blockedIds.has(id)) return false;
    const titleLower = it.title.toLowerCase();
    if (blockedTerms.some((t) => titleLower.includes(t))) return false;
    return !seen[hash(canonicalUrl(it.url))];
  });
  // Diagnostic funnel: shows exactly where items die. "already-seen" is
  // normal and healthy — each 20-min run only processes the delta since
  // the previous run; everything older was ingested (or slop-rejected)
  // in earlier runs and is remembered in data/seen.json.
  console.log(`funnel: ${rawCount} fetched → ${fresh.length} within ${LOOKBACK_HOURS}h → ${items.length} new (not yet seen)`);

  // 2. Cluster near-duplicate coverage of the same event.
  items = dedupeCluster(items).slice(0, MAX_NEW_PER_RUN);
  for (const it of items) seen[hash(canonicalUrl(it.url))] = new Date().toISOString();

  const scanned = items.length;
  if (!items.length) {
    console.log("ingest: nothing new — recomputing heat anyway.");
    const prevRank = new Map(
      [...feed.stories].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0)).map((s, i) => [s.id, i])
    );
    for (const s of feed.stories) s.heat = heatScore(s);
    const newOrder = [...feed.stories].sort((a, b) => b.heat - a.heat);
    newOrder.forEach((s, i) => {
      const was = prevRank.get(s.id);
      s.move = was === undefined ? "new" : was - i;
    });
    feed.stories.sort((a, b) => {
      if (!!b.top - !!a.top !== 0) return (!!b.top) - (!!a.top);
      return new Date(b.ts) - new Date(a.ts);
    });
    feed.stats = { ...feed.stats, scanned_last_run: 0, sources_live: feeds.filter((f) => !f.disabled).length };
    saveFeed(feed); saveSeen(seen);
    writeRss(feed);
    return;
  }

  // 3. Ground each item in real article text before summarizing.
  const excerpts = await Promise.all(items.map((it) => fetchExcerpt(it.url)));

  // 4. One batched Claude call classifies + writes deks for the whole run.
  const payload = items.map((it, i) => ({
    i, title: it.title, snippet: it.snippet, article_excerpt: excerpts[i],
    source: it.source, category_hint: it.hint,
    ...(it.community_score !== undefined && {
      community_score: it.community_score,
      community_comments: it.community_comments,
    }),
  }));
  const verdicts = await askJSON({
    role: "classify",
    system: CLASSIFY_SYSTEM,
    prompt: JSON.stringify(payload),
    maxTokens: 8000,
  });

  // 5. Merge keepers into the feed. Hard quality floor: nothing under 4 ships.
  const MIN_QUALITY = 4;
  const SPOTLIGHT_MIN_QUALITY = 7;
  const kept = [];
  let sloppedOut = 0;
  verdicts.forEach((v, i) => {
    const src = items[i];
    if (!v || !src) return;
    const quality = Math.min(10, Math.max(1, Number(v.quality) || 5));
    if (!v.keep || quality < MIN_QUALITY) { sloppedOut++; return; }
    kept.push({
      id: "s_" + hash(canonicalUrl(src.url)),
      cat: CATEGORIES.includes(v.category) ? v.category : (src.hint || "industry"),
      badge: ["breaking", "hot", "new"].includes(v.badge) ? v.badge : "new",
      // Spotlight requires BOTH the model saying yes AND the quality bar.
      spotlight: !!v.spotlight && quality >= SPOTLIGHT_MIN_QUALITY,
      quality,
      tier: src.tier || "journalism",
      title: v.headline || src.title,
      dek: v.dek || "",
      src: src.source,
      url: src.url,
      ts: src.published,
      read: `${Math.min(6, Math.max(2, v.read_min || 3))} min`,
      also: src.also_covered_by || [],
      ...(src.community_score !== undefined && { community_score: src.community_score }),
    });
  });

  const byId = new Map(feed.stories.map((s) => [s.id, s]));
  for (const s of kept) {
    const existing = byId.get(s.id);
    // Respect admin edits: locked or manual stories don't get overwritten by ingest,
    // but they DO stay in the feed.
    if (existing?.locked || existing?.manual) continue;
    byId.set(s.id, s);
  }
  // Sweep out anything the admin blocked after it was already in the feed.
  for (const id of blockedIds) byId.delete(id);

  feed.stories = [...byId.values()]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, MAX_STORIES);

  // Force pinned spotlights on regardless of the classifier's opinion.
  for (const s of feed.stories) if (pinnedSpot.has(s.id)) s.spotlight = true;

  // Corroboration drives heat mechanically: 2+ outlets on one event = at least hot.
  for (const s of feed.stories) {
    if ((s.also?.length || 0) >= 2 && s.badge === "new") s.badge = "hot";
  }

  // "top" flag: only auto-assign if the admin hasn't pinned one.
  // Top slot has a real quality floor — no mediocre stories at the top.
  const adminPinnedTop = feed.stories.find((s) => s.top && (s.locked || s.manual));
  if (!adminPinnedTop) {
    feed.stories.forEach((s) => delete s.top);
    const top = feed.stories.find((s) => s.badge === "breaking" && (s.quality ?? 5) >= 7)
      || feed.stories.find((s) => s.badge === "hot" && (s.quality ?? 5) >= 7)
      || feed.stories.find((s) => (s.quality ?? 5) >= 8);
    if (top) top.top = true;
  }

  // Keep spotlight rail bounded to the freshest picks.
  let spotCount = 0;
  for (const s of feed.stories) {
    if (s.spotlight && ++spotCount > MAX_SPOTLIGHT) s.spotlight = false;
  }

  // Signal heat: score every story, remember old ranks, record movement.
  const prevRank = new Map(
    [...feed.stories].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0)).map((s, i) => [s.id, i])
  );
  for (const s of feed.stories) s.heat = heatScore(s);
  const newOrder = [...feed.stories].sort((a, b) => b.heat - a.heat);
  newOrder.forEach((s, i) => {
    const was = prevRank.get(s.id);
    s.move = was === undefined ? "new" : was - i; // positive = climbed
  });

  // Final story order: top signal always leads, then strictly chronological.
  // Heat is still computed above (drives the ▲/▼ movement arrows shown in
  // the UI) but no longer decides sort position — top + recency only.
  // Every consumer of feed.json (site, RSS, archive) sees this same order.
  feed.stories.sort((a, b) => {
    if (!!b.top - !!a.top !== 0) return (!!b.top) - (!!a.top);
    return new Date(b.ts) - new Date(a.ts);
  });

  feed.stats = {
    ...feed.stats,
    scanned_last_run: scanned,
    slopped_last_run: sloppedOut,
    published_today: feed.stories.filter((s) => Date.now() - new Date(s.ts) < 24 * 3600 * 1000).length,
    sources_live: feeds.filter((f) => !f.disabled).length,
  };

  saveFeed(feed); saveSeen(seen);
  writeRss(feed);
  console.log(`ingest: scanned ${scanned}, slop-rejected ${sloppedOut}, kept ${kept.length} (${kept.filter(k=>k.spotlight).length} spotlight), feed now ${feed.stories.length} stories.`);
}

// RSS output — distribution surface for readers, newsletter tools, and bots.
function writeRss(feed) {
  const xmlEsc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const site = process.env.SITE_URL || "https://dailyblip.ai";
  const items = feed.stories.slice(0, 20).map((s) => `
    <item>
      <title>${xmlEsc(s.title)}</title>
      <link>${xmlEsc(s.url && s.url !== "#" ? s.url : site)}</link>
      <guid isPermaLink="false">${xmlEsc(s.id)}</guid>
      <description>${xmlEsc(s.dek)}</description>
      <category>${xmlEsc(s.cat)}</category>
      <pubDate>${new Date(s.ts).toUTCString()}</pubDate>
    </item>`).join("");
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>dailyblip — AI creator signal, zero slop</title>
    <link>${site}</link>
    <description>A ruthlessly curated AI-creator brief. Only the signal.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>
`;
  fsMod.writeFileSync(path.join(path.dirname(PATHS.feed), "..", "feed.xml"), rss);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
