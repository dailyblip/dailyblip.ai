// pipeline/curator.js — runs weekly. The self-healing layer:
// 1. Reads source health and flags feeds that have gone quiet or keep failing.
// 2. Uses Claude WITH WEB SEARCH to find the feed's new URL or a replacement
//    source covering the same beat, verifies it actually parses, and edits
//    sources.json itself.
// 3. Link-checks past tool drops and marks dead ones in the graveyard.
import Parser from "rss-parser";
import { askWithSearch } from "./lib/claude.js";
import { loadSources, saveSources, loadHealth, loadFeatured, saveFeatured } from "./lib/store.js";

const QUIET_DAYS = 7;        // 0 items for this long = ailing
const FAIL_THRESHOLD = 5;    // this many consecutive fetch failures = ailing
const MAX_REPAIRS_PER_RUN = 3;
const MAX_GRAVEYARD_CHECKS = 20;

const CURATOR_SYSTEM = `You maintain the source list for dailyblip, an AI-news site for content creators (image, video, music, writing with AI). A feed has stopped producing items. Use web search to figure out what happened and fix it.

Decide ONE action:
- "replace_url": the same publication still exists but its RSS/Atom feed moved. Provide the new feed URL.
- "replace_feed": the publication is gone or no longer covers this beat. Provide ONE replacement — an active publication with an RSS/Atom feed covering the same territory for the same audience. Prefer original sources over aggregators.
- "remove": the beat is already well covered by the site's other sources and no good replacement exists.

Requirements: the url MUST be a direct RSS or Atom feed URL you found evidence for (a feed link on the site, a documented feed path), not a guess and not a homepage.

Return JSON: {"action":"replace_url"|"replace_feed"|"remove","name":"publication name","url":"https://...feed url...","reason":"one sentence"}. JSON only.`;

async function feedParses(url) {
  try {
    const parser = new Parser({ timeout: 15000, headers: { "user-agent": "dailyblip-curator/1.0" } });
    const parsed = await parser.parseURL(url);
    return (parsed.items || []).length > 0;
  } catch { return false; }
}

function ailingFeeds(sources, health) {
  const today = Date.now();
  return sources.feeds.filter((f) => {
    if (f.disabled) return false;
    const rec = health[f.name];
    if (!rec) return false; // never measured yet — leave alone
    if ((rec.consecutive_failures || 0) >= FAIL_THRESHOLD) return true;
    const recentDays = Object.entries(rec.days || {})
      .filter(([d]) => today - new Date(d).getTime() < QUIET_DAYS * 24 * 3600 * 1000);
    if (recentDays.length < QUIET_DAYS - 1) return false; // not enough data yet
    return recentDays.reduce((sum, [, n]) => sum + n, 0) === 0;
  });
}

async function repairSources() {
  const sources = loadSources();
  const health = loadHealth();
  const ailing = ailingFeeds(sources, health).slice(0, MAX_REPAIRS_PER_RUN);
  if (!ailing.length) return console.log("curator: all sources healthy.");

  for (const feed of ailing) {
    console.log(`curator: repairing "${feed.name}" (${feed.url})`);
    let verdict;
    try {
      const otherFeeds = sources.feeds.filter((f) => f !== feed && !f.disabled).map((f) => f.name);
      verdict = await askWithSearch({
        role: "write",
        system: CURATOR_SYSTEM,
        prompt: JSON.stringify({
          dead_feed: { name: feed.name, url: feed.url, beat_hint: feed.hint },
          sites_other_sources: otherFeeds,
        }),
        maxTokens: 2000,
      });
    } catch (e) {
      console.warn(`curator: search step failed for "${feed.name}" — ${e.message}`);
      continue;
    }

    if (verdict?.action === "remove") {
      feed.disabled = true;
      feed.disabled_reason = verdict.reason || "curator: no replacement found";
      feed.disabled_at = new Date().toISOString();
      console.log(`curator: disabled "${feed.name}" — ${feed.disabled_reason}`);
      continue;
    }

    if ((verdict?.action === "replace_url" || verdict?.action === "replace_feed") && verdict.url) {
      // Trust but verify: the new feed must actually parse with items.
      if (await feedParses(verdict.url)) {
        feed.name = verdict.action === "replace_feed" ? (verdict.name || feed.name) : feed.name;
        feed.url = verdict.url;
        feed.replaced_at = new Date().toISOString();
        feed.replaced_reason = verdict.reason || "";
        delete feed.disabled;
        console.log(`curator: "${feed.name}" now → ${verdict.url}`);
      } else {
        // Verification failed — disable rather than churn on a bad URL.
        feed.disabled = true;
        feed.disabled_reason = `curator: proposed replacement did not parse (${verdict.url})`;
        feed.disabled_at = new Date().toISOString();
        console.warn(`curator: replacement for "${feed.name}" failed verification; disabled.`);
      }
    }
  }
  saveSources(sources);
}

// The tool graveyard: check that past tool drops still resolve. Dead tools
// stay in history with a died date — over years this becomes unique data.
async function checkGraveyard() {
  const featured = loadFeatured();
  const toCheck = featured.filter((f) => f.alive !== false && f.url && f.url !== "#")
    .slice(-MAX_GRAVEYARD_CHECKS);
  let died = 0;
  for (const tool of toCheck) {
    try {
      const res = await fetch(tool.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: { "user-agent": "Mozilla/5.0 (dailyblip graveyard check)" },
      });
      if (res.ok) { tool.alive = true; delete tool.suspect; continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      // Two strikes: mark suspect first, dead on the second consecutive failure.
      if (tool.suspect) {
        tool.alive = false;
        tool.died = new Date().toISOString().slice(0, 10);
        delete tool.suspect;
        died++;
      } else {
        tool.suspect = true;
      }
    }
  }
  saveFeatured(featured);
  console.log(`curator: graveyard check done${died ? ` — ${died} tool(s) marked dead` : ""}.`);
}

async function main() {
  await repairSources();
  await checkGraveyard();
}

main().catch((e) => { console.error(e); process.exit(1); });
.then(() => process.exit(0))
