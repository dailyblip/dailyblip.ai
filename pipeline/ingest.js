// pipeline/ingest.js — runs every ~20 minutes via GitHub Actions.
// RSS in → dedupe → ground in article text → Claude classifies, summarizes,
// and flags Creator Spotlight stories → docs/data/feed.json out.
// Also records per-source health so the weekly curator can heal the source list.
import Parser from "rss-parser";
import { askJSON } from "./lib/claude.js";
import {
  loadFeed, saveFeed, loadSeen, saveSeen,
  loadSources, loadHealth, saveHealth, loadOverrides, saveOverrides, readJSON, PATHS,
} from "./lib/store.js";
import { hash, canonicalUrl, dedupeCluster } from "./lib/text.js";
import { fetchRedditWithScores, passesRedditGate, fetchTopComments } from "./lib/reddit.js";
import path from "node:path";
import fsMod from "node:fs";

const LOOKBACK_HOURS = 48;
const MAX_STORIES = 60;
const MAX_NEW_PER_RUN = 25;
const MAX_SPOTLIGHT = 3;

const CATEGORIES = ["image", "video", "music", "writing", "tools", "rights", "industry"];

/** Fallback subreddit-name extractor if a post's own `subreddit` field is
 *  ever missing (Reddit almost always includes it, but this keeps the
 *  comment-fetch step from crashing on unexpected API shapes). */
function subredditFromUrl(url) {
  const m = String(url).match(/reddit\.com\/r\/([^/]+)/i);
  return m ? m[1] : "";
}

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
- keep (boolean): true only if this clears the bar. THE BASELINE REQUIREMENT, for every source, no exceptions: the story must have genuine, explicit AI content, or an explicit direct tie to AI-generated material. It's not enough that a creator might theoretically use the thing being covered — the AI has to actually be in the story.
    ACCEPT: a tool ships an actual AI feature (a new AI upscaler, an AI-assisted edit tool, a generative capability); a technique or plugin specifically for processing/compositing/editing AI-generated content; AI model/technique releases and updates; AI pricing, sunsets, deadlines; copyright/policy developments about AI training or AI-generated work; industry news about AI companies/compute/infrastructure (see the hardware exception below for how strict this one is); genuine AI-made-or-assisted maker stories (see spotlight rules).
    REJECT, even if well-written, popular, or otherwise high-quality: general creative-software news with zero AI angle (a new sculpting brush, a general editing/compositing tool with no AI capability, a free non-AI alternative to an existing app) — reject these EVEN THOUGH a creator working with AI-generated footage might plausibly use the tool someday. "Might be useful to an AI creator's workflow" is not enough; the story itself has to be about AI. Also reject: enterprise B2B minutiae, funding rounds with no shipped product, academic papers with no usable tool, listicle/SEO filler, sponsored content, ads, tutorials from content mills, generic "AI is changing everything" think-pieces.
    When genuinely unsure whether AI is central or incidental, reject. This applies identically to every source — general-audience art/photography/culture publications (PetaPixel, 80 Level, Hyperallergic, This Is Colossal, Creative Boom) publish mostly non-AI content and need this rule applied especially carefully, but the rule itself is the same for TechCrunch, The Verge, or anyone else.

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

For Reddit sources, you are given community score, comment count, AND a sample of the actual top comments on the post. Use all three together, but the comment sample is the most important signal:
  - High score + comments that show genuine, specific enthusiasm from people who clearly work in the medium ("the temporal consistency here is wild", "what's your workflow for the hands") → strong spotlight candidate.
  - High score + comments that are generic reactions with no substance ("lol", "based", unrelated jokes) → the post went viral for reasons unrelated to craft; do not spotlight on vote count alone.
  - High score + comments pointing out flaws, calling it slop, noting AI artifacts, or comparing it unfavorably → REJECT regardless of score. The crowd upvoted it (maybe for novelty or humor) but the actual discussion says it's not good work.
  - No comment sample provided, or sample is empty → judge on title/snippet alone, same as any other source; don't penalize for a missing sample.
A 5,000-upvote post can still be slop, and gets rejected on its merits if the comments say so.

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
    // Strip a leading UTF-8 byte-order-mark if present — a common cause of
    // "Non-whitespace before first tag" errors. Invisible in most editors,
    // but strict XML parsers correctly reject it before the declaration.
    xml = xml.replace(/^\uFEFF/, "");
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
        // Second, qualitative gate: pull the actual top comments for each
        // post that already cleared the numeric bar. High upvotes alone
        // can't distinguish "genuinely impressive" from "popular because
        // it's funny/nostalgic while top comments point out it's mediocre
        // AI slop" — only reading real comment sentiment can. Only fetched
        // for posts that already passed the numeric gate, so this stays
        // cheap (typically 0-3 extra requests per subreddit per run).
        const withComments = await Promise.all(
          gated.map(async (p) => ({
            ...p,
            top_comments: await fetchTopComments(p.subreddit || subredditFromUrl(f.url), p.id),
          }))
        );
        perFeed[f.name] = { ok: true, count: withComments.length, raw, filtered: raw - withComments.length };
        return withComments.map((p) => ({
          title: p.title,
          url: p.external_url || p.url,
          snippet: p.snippet,
          published: p.published,
          source: f.name,
          hint: f.hint,
          tier: f.tier || "community",
          community_score: p.score,
          community_comments: p.num_comments,
          community_comment_sample: p.top_comments,
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

  // Repost guard: two different Reddit posts (different IDs, different
  // titles, different usernames) can point at the exact same underlying
  // media — someone reposting another creator's video/image, sometimes
  // with a new caption. Title-based dedupeCluster below wouldn't catch
  // this (it only merges near-identical TITLES; a repost with a reworded
  // title sails right past it). The reliable signal is the media URL
  // itself. This catches duplicates WITHIN a single run — cross-run
  // reposts of an already-seen exact URL are separately caught by the
  // persistent seen[] check further down, since reddit items' `url`
  // field is already the external media link when Reddit reports one.
  //
  // Honest limitation: if a repost is re-uploaded to a NEW host (e.g. a
  // fresh v.redd.it copy instead of the same link), the URL differs and
  // this can't catch it — that would need perceptual/audio fingerprinting,
  // out of scope here. This handles the common, cheap case: identical
  // link reposted with a new title/user.
  const byMediaUrl = new Map();
  const deduped = [];
  for (const it of fresh) {
    const mediaKey = canonicalUrl(it.url);
    const existing = byMediaUrl.get(mediaKey);
    if (!existing) {
      byMediaUrl.set(mediaKey, it);
      deduped.push(it);
    } else {
      // Keep whichever copy has more community validation (for Reddit
      // items) or arrived first (for everything else); log the discard
      // so reposts are auditable, not silently vanishing.
      const keepNew = (it.community_score || 0) > (existing.community_score || 0);
      console.log(`repost detected: "${(keepNew ? existing : it).title.slice(0,60)}" — kept ${keepNew ? it.source : existing.source}, discarded duplicate from ${keepNew ? existing.source : it.source} (same media URL)`);
      if (keepNew) {
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = it;
        byMediaUrl.set(mediaKey, it);
      }
    }
  }

  let items = deduped.filter((it) => {
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
    // Restamp pin state even on a quiet run — an admin may have just
    // confirmed/expired a pin between runs, and this keeps the story
    // objects in feed.json accurate without waiting for new content.
    const activePinIdsQuiet = new Set(
      (overrides.pinned_brief || []).filter((p) => p.editions_remaining > 0).map((p) => p.id)
    );
    for (const s of feed.stories) {
      if (activePinIdsQuiet.has(s.id)) s.pinned_brief = true;
      else delete s.pinned_brief;
    }
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
      ...(it.community_comment_sample?.length && { top_comment_sample: it.community_comment_sample }),
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
    if (!v || !src) { console.log(`classify: [NO VERDICT] ${src?.source || "?"} — "${(src?.title || "").slice(0,70)}"`); return; }
    const quality = Math.min(10, Math.max(1, Number(v.quality) || 5));
    if (!v.keep || quality < MIN_QUALITY) {
      sloppedOut++;
      console.log(`classify: [REJECTED q${quality}${!v.keep ? " keep=false" : ""}] ${src.source} — "${src.title.slice(0,70)}"`);
      return;
    }
    console.log(`classify: [KEPT q${quality}${v.spotlight ? " SPOTLIGHT" : ""}] ${src.source} — "${src.title.slice(0,70)}"`);
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
  console.log(`merge: ${kept.length} kept this run, feed.json now holds ${feed.stories.length} stories total (cap ${MAX_STORIES}).`);

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

  // --- Brief-pin bookkeeping -------------------------------------------
  // Two independent things happen here:
  //  1. Auto-SUGGEST (never auto-apply): any story now covered by 3+
  //     sources (1 representative + 2 or more in also_covered_by) gets
  //     queued as a pin_suggestion for the admin to confirm or dismiss.
  //  2. Stamp pinned_brief:true directly onto any story the admin has
  //     already confirmed-pinned, so the frontend (stale-trim exemption)
  //     has a single source of truth on the story object itself rather
  //     than needing to cross-reference overrides.json separately.
  const activePinIds = new Set(
    (overrides.pinned_brief || []).filter((p) => p.editions_remaining > 0).map((p) => p.id)
  );
  const dismissed = new Set(overrides.dismissed_pin_suggestions || []);
  const alreadySuggested = new Set((overrides.pin_suggestions || []).map((p) => p.id));
  const liveIds = new Set(feed.stories.map((s) => s.id));

  let newSuggestions = 0;
  for (const s of feed.stories) {
    if (activePinIds.has(s.id)) s.pinned_brief = true;
    else delete s.pinned_brief;

    const corroboration = 1 + (s.also?.length || 0);
    if (
      corroboration >= 3 &&
      !activePinIds.has(s.id) &&
      !dismissed.has(s.id) &&
      !alreadySuggested.has(s.id)
    ) {
      overrides.pin_suggestions = overrides.pin_suggestions || [];
      overrides.pin_suggestions.push({
        id: s.id,
        source_count: corroboration,
        sources: [s.src, ...(s.also || [])],
        detected_at: new Date().toISOString(),
      });
      newSuggestions++;
    }
  }
  // Prune suggestions/pins whose story has aged out of the feed entirely.
  overrides.pin_suggestions = (overrides.pin_suggestions || []).filter((p) => liveIds.has(p.id));
  overrides.pinned_brief = (overrides.pinned_brief || []).filter((p) => liveIds.has(p.id));
  saveOverrides(overrides);
  if (newSuggestions) console.log(`pin: ${newSuggestions} new suggestion(s) detected (3+ source corroboration), ${activePinIds.size} currently pinned.`);

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
