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
import path from "node:path";

const OVERRIDES_PATH = path.join(path.dirname(PATHS.seen), "overrides.json");
const loadOverrides = () => readJSON(OVERRIDES_PATH, { blocked_ids: [], blocked_terms: [], pinned_spotlight: [] });

const LOOKBACK_HOURS = 48;
const MAX_STORIES = 60;
const MAX_NEW_PER_RUN = 25;
const MAX_SPOTLIGHT = 3;

const CATEGORIES = ["image", "video", "music", "writing", "tools", "rights", "industry"];

const CLASSIFY_SYSTEM = `You are the wire editor for dailyblip, an AI-news site for CONTENT CREATORS — people who make images, video, music, and writing with AI. You receive raw RSS items, each with an article excerpt fetched from the source page, and decide what runs.

For each item return:
- keep (boolean): true only if a working creator would care. Keep: model/tool launches and updates, pricing changes, creative-workflow techniques, copyright/licensing developments, platform policy affecting creators' content, major industry news that ripples into creative tools, and maker stories (see spotlight). Drop: enterprise B2B minutiae, funding rounds with no product, academic papers with no usable tool, listicle/SEO filler, sponsored content, ads.
- spotlight (boolean): true if the story is primarily about a PERSON or small team CREATING something interesting with AI — a filmmaker's AI short, an indie artist's AI-visual album, a game or comic or art project, a novel workflow someone built. Company/product/policy news is never spotlight. Be picky: spotlight is a showcase, not a category.
- category: one of ${JSON.stringify(CATEGORIES)}. "rights" = copyright, licensing, crawler/scraping policy. "tools" = workflow suites, plugins, platforms. Spotlight stories still get the category of their medium.
- badge: "breaking" (major, <6h old), "hot" (big story), or "new" (default).
- headline: the title, cleaned — sentence-cased claims, no clickbait, no trailing site names, max 90 chars.
- dek: 1–2 sentences (max 45 words) IN YOUR OWN WORDS. Ground every claim ONLY in the provided title/snippet/excerpt — if the excerpt doesn't support a detail, leave it out. Concrete over hype. Never copy source wording.
- read_min: estimated read time of the source, 2–6.

Return a JSON array, same order as input: {"keep":bool,"spotlight":bool,"category":"...","badge":"...","headline":"...","dek":"...","read_min":n}. JSON only.`;

async function fetchAllFeeds(feeds) {
  const parser = new Parser({ timeout: 15000, headers: { "user-agent": "dailyblip-ingest/1.0" } });
  const perFeed = {};
  const results = await Promise.allSettled(
    feeds.filter((f) => !f.disabled).map(async (f) => {
      const parsed = await parser.parseURL(f.url);
      const items = (parsed.items || []).map((item) => ({
        title: (item.title || "").trim(),
        url: item.link || item.guid || "",
        snippet: (item.contentSnippet || item.summary || "").slice(0, 400),
        published: item.isoDate || item.pubDate || new Date().toISOString(),
        source: f.name,
        hint: f.hint,
      }));
      perFeed[f.name] = { ok: true, count: items.length };
      return items;
    })
  );
  const active = feeds.filter((f) => !f.disabled);
  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      perFeed[active[i].name] = { ok: false, count: 0 };
      console.warn(`feed failed: ${active[i].name} — ${r.reason?.message || r.reason}`);
    }
  });
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
  let items = raw.filter((it) => {
    if (!it.title || !it.url) return false;
    if (new Date(it.published).getTime() < cutoff) return false;
    const id = "s_" + hash(canonicalUrl(it.url));
    if (blockedIds.has(id)) return false;
    const titleLower = it.title.toLowerCase();
    if (blockedTerms.some((t) => titleLower.includes(t))) return false;
    return !seen[hash(canonicalUrl(it.url))];
  });

  // 2. Cluster near-duplicate coverage of the same event.
  items = dedupeCluster(items).slice(0, MAX_NEW_PER_RUN);
  for (const it of items) seen[hash(canonicalUrl(it.url))] = new Date().toISOString();

  const scanned = items.length;
  if (!items.length) {
    console.log("ingest: nothing new.");
    feed.stats = { ...feed.stats, scanned_last_run: 0, sources_live: feeds.filter((f) => !f.disabled).length };
    saveFeed(feed); saveSeen(seen);
    return;
  }

  // 3. Ground each item in real article text before summarizing.
  const excerpts = await Promise.all(
     items.map((it) => Promise.race([
       fetchExcerpt(it.url),
       new Promise((r) => setTimeout(() => r(""), 10000))
     ]))
   );

  // 4. One batched Claude call classifies + writes deks for the whole run.
  const payload = items.map((it, i) => ({
    i, title: it.title, snippet: it.snippet, article_excerpt: excerpts[i],
    source: it.source, category_hint: it.hint,
  }));
  const verdicts = await askJSON({
    role: "classify",
    system: CLASSIFY_SYSTEM,
    prompt: JSON.stringify(payload),
    maxTokens: 8000,
  });

  // 5. Merge keepers into the feed.
  const kept = [];
  verdicts.forEach((v, i) => {
    const src = items[i];
    if (!v?.keep || !src) return;
    kept.push({
      id: "s_" + hash(canonicalUrl(src.url)),
      cat: CATEGORIES.includes(v.category) ? v.category : (src.hint || "industry"),
      badge: ["breaking", "hot", "new"].includes(v.badge) ? v.badge : "new",
      spotlight: !!v.spotlight,
      title: v.headline || src.title,
      dek: v.dek || "",
      src: src.source,
      url: src.url,
      ts: src.published,
      read: `${Math.min(6, Math.max(2, v.read_min || 3))} min`,
      also: src.also_covered_by || [],
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
  const adminPinnedTop = feed.stories.find((s) => s.top && (s.locked || s.manual));
  if (!adminPinnedTop) {
    feed.stories.forEach((s) => delete s.top);
    const top = feed.stories.find((s) => s.badge === "breaking") || feed.stories.find((s) => s.badge === "hot");
    if (top) top.top = true;
  }

  // Keep spotlight rail bounded to the freshest picks.
  let spotCount = 0;
  for (const s of feed.stories) {
    if (s.spotlight && ++spotCount > MAX_SPOTLIGHT) s.spotlight = false;
  }

  feed.stats = {
    ...feed.stats,
    scanned_last_run: scanned,
    published_today: feed.stories.filter((s) => Date.now() - new Date(s.ts) < 24 * 3600 * 1000).length,
    sources_live: feeds.filter((f) => !f.disabled).length,
  };

  saveFeed(feed); saveSeen(seen);
  console.log(`ingest: scanned ${scanned}, kept ${kept.length} (${kept.filter(k=>k.spotlight).length} spotlight), feed now ${feed.stories.length} stories.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
