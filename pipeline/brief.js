// pipeline/brief.js — runs once daily. Publish-gated: if the model output
// fails validation, yesterday's brief stays live untouched.
import { askJSON } from "./lib/claude.js";
import { loadFeed, saveFeed } from "./lib/store.js";
import { validateBrief } from "./lib/sanitize.js";

const BRIEF_SYSTEM = `You are the editor of "The Daily Blip" — a 60-second morning brief for AI content creators (image, video, music, writing). From the candidate stories, choose the SIX with the highest practical impact on creative work, ranked most important first.

Selection rules:
- Deadlines, price changes, and sunsets outrank launches; launches outrank rankings; rankings outrank commentary.
- Never pick two stories about the same event.
- Spread across mediums when impact is comparable — don't run six video stories.
- You are given yesterday's brief. Do NOT repeat a story from it unless it materially developed since (new deadline, new number, reversal) — and if it did, the item must lead with what changed.
- At most ONE spotlight (maker) story, and only if it's genuinely remarkable.

For each pick write:
- story: the story id, exactly as given.
- html: ONE sentence, max 28 words, plain language, with exactly one <b>...</b> around the key phrase. No other tags. Include the concrete number/date if there is one. Write it as advice-adjacent news ("migrate now", "check your stack") when a reader action exists. Original wording only.
- secs: honest seconds to read it, 8–12.

Also write:
- title: 'DAYNAME, MONTH D — six things creators need to know' using the date given.

Return JSON: {"title":"...","items":[{"story":"...","html":"...","secs":n}, ...6 items]}. JSON only.`;

async function main() {
  const feed = loadFeed();
  const dayMs = 26 * 3600 * 1000;
  let candidates = feed.stories
    .filter((s) => Date.now() - new Date(s.ts) < dayMs)
    .map(({ id, cat, badge, spotlight, title, dek, ts }) => ({ id, cat, badge, spotlight, title, dek, ts }));

  if (candidates.length < 6) {
    console.warn(`brief: only ${candidates.length} fresh stories — widening to 48h.`);
    candidates = feed.stories.map(({ id, cat, badge, spotlight, title, dek, ts }) => ({ id, cat, badge, spotlight, title, dek, ts }));
  }
  if (candidates.length < 4) {
    console.warn("brief: too few stories to write a brief; keeping yesterday's.");
    return;
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles",
  });

  const result = await askJSON({
    role: "write",
    system: BRIEF_SYSTEM,
    prompt: JSON.stringify({
      date: today,
      yesterdays_brief: feed.brief?.items?.map((i) => i.html) || [],
      candidates,
    }),
    maxTokens: 2000,
  });

  // Publish gate: validates structure, sanitizes HTML to <b> only, dedupes.
  const gated = validateBrief(result, new Set(feed.stories.map((s) => s.id)));

  feed.issue = (feed.issue || 0) + 1;
  feed.brief = { ...gated, date: new Date().toISOString() };
  saveFeed(feed);
  console.log(`brief: issue ${feed.issue} written with ${gated.items.length} items.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
.then(() => process.exit(0))
