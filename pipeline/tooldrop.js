// pipeline/tooldrop.js — runs once daily. Picks the Tool Drop of the Day.
// Candidates come from dedicated tool feeds + launch-flavored feed stories.
// History check prevents repeats; URL check prevents featuring vaporware.
import Parser from "rss-parser";
import { askJSON } from "./lib/claude.js";
import { loadFeed, saveFeed, loadFeatured, saveFeatured, loadSources } from "./lib/store.js";

const PICK_SYSTEM = `You choose the "Tool Drop of the Day" for dailyblip, a site for AI content creators. From the candidates, pick ONE tool.

Rubric, in order:
1. Genuinely new or meaningfully updated (not a rebrand or minor patch).
2. Usable today — reject anything that reads like a waitlist or "coming soon".
3. Serves creators (image/video/music/writing), not developers or enterprises.
4. Prefer independent/underexposed tools over giants everyone already knows.

Write, in the site's voice (concrete, no hype words like "revolutionary"):
- name: the tool's name.
- blurb: max 30 words on what it actually does and who it's for. Original wording.
- meta: a lowercase strip like "image · video — free tier" (mediums it covers, then pricing reality: "free tier" / "credits-based" / "paid, trial available" — only claim what the candidate data supports).
- url: the tool's url, copied exactly from the candidate.

Return JSON: {"pick_index": n, "name":"...", "blurb":"...", "meta":"...", "url":"..."}. If NO candidate passes the rubric, return {"pick_index": -1}. JSON only.`;

const WAITLIST_RE = /join the waitlist|request access|coming soon|be the first to know|notify me/i;

async function gatherCandidates() {
  const { tool_feeds } = loadSources();
  const parser = new Parser({ timeout: 15000, headers: { "user-agent": "dailyblip-tooldrop/1.0" } });
  const out = [];

  const results = await Promise.allSettled(tool_feeds.map((f) => parser.parseURL(f.url)));
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return console.warn(`tool feed failed: ${tool_feeds[i].name}`);
    for (const item of (r.value.items || []).slice(0, 15)) {
      out.push({
        name: (item.title || "").trim(),
        url: item.link || "",
        snippet: (item.contentSnippet || "").slice(0, 300),
        via: tool_feeds[i].name,
      });
    }
  });

  // Launch-flavored stories from the main feed count too.
  const feed = loadFeed();
  for (const s of feed.stories) {
    if (/launch|releases|ships|introduc|unveil|now available|rolls out/i.test(s.title)) {
      out.push({ name: s.title, url: s.url, snippet: s.dek, via: s.src });
    }
  }
  return out;
}

async function verifyUsable(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": "Mozilla/5.0 (dailyblip verification bot)" },
    });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 60000);
    return !WAITLIST_RE.test(html);
  } catch {
    return false;
  }
}

async function main() {
  const feed = loadFeed();
  // Respect a manual pin from the admin UI — leave it alone.
  if (feed.tooldrop?.pinned) return console.log("tooldrop: manual pin present; keeping it.");

  const featured = loadFeatured();
  const featuredKeys = new Set(featured.map((f) => (f.name || "").toLowerCase()));

  let candidates = (await gatherCandidates())
    .filter((c) => c.name && c.url)
    .filter((c) => !featuredKeys.has(c.name.toLowerCase()))
    .slice(0, 30);

  if (!candidates.length) return console.log("tooldrop: no candidates today; keeping current drop.");

  // Give the model up to 3 chances: if its pick fails URL verification,
  // remove it from the pool and ask again.
  for (let round = 0; round < 3 && candidates.length; round++) {
    const result = await askJSON({
      model: MODELS.write,
      system: PICK_SYSTEM,
      prompt: JSON.stringify(candidates.map((c, i) => ({ i, ...c }))),
      maxTokens: 1000,
    });

    if (result.pick_index === -1) return console.log("tooldrop: model rejected all candidates; keeping current drop.");
    const picked = candidates[result.pick_index];
    if (!picked) return console.log("tooldrop: invalid pick index; keeping current drop.");

    if (await verifyUsable(picked.url)) {
      feed.tooldrop = {
        name: result.name || picked.name,
        blurb: result.blurb,
        meta: result.meta,
        url: picked.url, // trust the verified candidate URL, not the model
        date: new Date().toISOString(),
      };
      saveFeed(feed);
      featured.push({ name: feed.tooldrop.name, url: picked.url, date: feed.tooldrop.date });
      saveFeatured(featured);
      return console.log(`tooldrop: featured "${feed.tooldrop.name}".`);
    }
    console.warn(`tooldrop: "${picked.name}" failed URL verification; retrying without it.`);
    candidates = candidates.filter((c) => c !== picked);
  }
  console.log("tooldrop: no candidate survived verification; keeping current drop.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
