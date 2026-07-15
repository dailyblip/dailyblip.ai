// pipeline/brief.js — runs twice daily (AM + PM editions). Publish-gated:
// if the model output fails validation, the previous edition's brief
// stays live untouched.
//
// Edition is passed as the first CLI arg: `node pipeline/brief.js am` or
// `node pipeline/brief.js pm`. Defaults to "am" if omitted (keeps this
// runnable exactly as before for anyone testing locally).
import { askJSON } from "./lib/claude.js";
import { loadFeed, saveFeed, loadOverrides, saveOverrides } from "./lib/store.js";
import { validateBrief } from "./lib/sanitize.js";

const edition = (process.argv[2] || "am").toLowerCase() === "pm" ? "pm" : "am";

const BRIEF_SYSTEM = `You are the editor of "The Daily Blip" — a 60-second ${edition === "am" ? "morning" : "evening"} brief for AI content creators (image, video, music, writing). From the candidate stories, choose the SIX with the highest practical impact on creative work.

Selection rules:
- Deadlines, price changes, and sunsets outrank launches; launches outrank rankings; rankings outrank commentary.
- Never pick two stories about the same event.
- Spread across mediums when impact is comparable — don't run six video stories.
- You are given the previous edition's brief (this runs twice daily now, AM and PM). Do NOT repeat a story from it unless it materially developed since (new deadline, new number, reversal) — and if it did, the item must lead with what changed.
- At most ONE spotlight (maker) story, and only if it's genuinely remarkable.
- PINNED STORIES: any candidate marked "pinned":true in the input MUST be included in your six, no exceptions — it was manually pinned by the editor as a story worth tracking across multiple editions. Write its sentence fresh, reflecting whatever is newest/most developed about it right now; do not treat it as a forbidden repeat even if it resembles a previous edition's item.
- COMMENTARY: at most one candidate will ever be marked "commentary":true (an opinion piece from the dailyblip editors, not news). It is never mandatory — include it only if it's genuinely a good fit for that day's six, competing on merit like everything else. The candidate list is already capped so you can never see more than one; don't try to include it twice or "make room" for it artificially.
- HARDWARE/INFRASTRUCTURE EXCEPTION: a story about chips, datacenters, or compute infrastructure (e.g. a new AI chip entering production) is normally out of scope for a creator brief — but it's allowed, MAJOR ONES ONLY (a household-name company, a genuinely large deal/capacity number), if and only if you can write a concrete, specific bridge to what it means for someone generating images/video/music/text. "This could eventually mean cheaper inference" is too vague to qualify — you need something closer to "if this lowers Meta's own inference costs, expect it to show up as cheaper or faster limits on Meta AI's image tools within the next year or two." If you can't write a genuine, specific bridge sentence, don't include the story at all. Mark these items hardware:true.

For each pick write:
- story: the story id, exactly as given.
- html: ONE sentence, max 28 words, plain language, with exactly one <b>...</b> around the key phrase. No other tags. Include the concrete number/date if there is one. Write it as advice-adjacent news ("migrate now", "check your stack") when a reader action exists. Original wording only. For hardware-exception items, the sentence must include the creator-impact bridge, not just the hardware fact.
- secs: honest seconds to read it, 8–12.
- impact: integer 1–10, your honest rating of how much this actually matters to a working creator's day-to-day. Be stingy — most days nothing scores above 8. This score decides the display order (highest first) and how visually prominent the item is on the site, so it needs to be a real judgment, not a formality. Reserve 9–10 for something a creator would stop scrolling for.
- hardware: boolean, true only for stories that used the hardware/infrastructure exception above. false for everything else.

Return JSON: {"items":[{"story":"...","html":"...","secs":n,"impact":n,"hardware":bool}, ...6 items]}. JSON only. Do not include a "title" field — the title is generated in code.`;

// A story counts as "journalism-tier" if it's explicitly tagged that way,
// or — for older stories saved before the tier field existed — if it has
// no community_score (the tell-tale sign of a Reddit-sourced item).
// Commentary pieces (tier: "commentary", commentary: true, written by
// pipeline/commentary.js) are also eligible — they compete for a brief
// slot on merit like anything else, just capped at 1 per edition below.
function isEligibleForBrief(s) {
  if (s.commentary) return true;
  if (s.tier) return s.tier === "journalism";
  return s.community_score === undefined;
}

async function main() {
  const feed = loadFeed();
  const overrides = loadOverrides();
  // Twice-daily editions are ~11-13h apart (asymmetric: 5am-4pm is 11h,
  // 4pm-5am is 13h) — a 15h window keeps each edition focused on what's
  // new since the last one, with buffer on the longer overnight gap.
  const windowMs = 15 * 3600 * 1000;
  const eligible = feed.stories.filter(isEligibleForBrief);
  const excludedCount = feed.stories.length - eligible.length;

  const activePins = (overrides.pinned_brief || []).filter((p) => p.editions_remaining > 0);
  const activePinIds = new Set(activePins.map((p) => p.id));

  let candidates = eligible
    .filter((s) => Date.now() - new Date(s.ts) < windowMs)
    .map(({ id, cat, badge, spotlight, title, dek, ts, commentary }) => ({ id, cat, badge, spotlight, title, dek, ts, commentary }));

  if (candidates.length < 6) {
    console.warn(`brief: only ${candidates.length} fresh journalism-tier stories — widening to 48h.`);
    candidates = eligible.map(({ id, cat, badge, spotlight, title, dek, ts, commentary }) => ({ id, cat, badge, spotlight, title, dek, ts, commentary }));
  }
  if (candidates.length < 4) {
    console.warn(`brief: too few journalism-tier stories to write a ${edition.toUpperCase()} brief; keeping the previous edition's.`);
    return;
  }

  // Commentary is capped at 1 CANDIDATE, not just 1 selection — enforced
  // here, before the model ever sees the list, so it's structurally
  // impossible for two commentary pieces to appear in one brief. If more
  // than one is somehow still within the freshness window, keep only the
  // most recent.
  const commentaryCandidates = candidates.filter((c) => c.commentary);
  if (commentaryCandidates.length > 1) {
    const newest = commentaryCandidates.sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
    candidates = candidates.filter((c) => !c.commentary || c.id === newest.id);
    console.log(`brief: ${commentaryCandidates.length} commentary candidates found, kept only the most recent.`);
  }

  // Pinned stories are force-included as candidates regardless of the
  // time window or journalism-tier filter above — a human explicitly
  // chose to track this one, so it bypasses the normal eligibility gate
  // entirely. Add any that aren't already in the candidate list.
  const candidateIds = new Set(candidates.map((c) => c.id));
  let pinnedAdded = 0;
  for (const id of activePinIds) {
    if (candidateIds.has(id)) continue;
    const s = feed.stories.find((x) => x.id === id);
    if (s) {
      candidates.push({ id: s.id, cat: s.cat, badge: s.badge, spotlight: s.spotlight, title: s.title, dek: s.dek, ts: s.ts, commentary: s.commentary });
      pinnedAdded++;
    }
  }
  // Flag pinned candidates in the payload so the model knows which ones
  // are mandatory (see the PINNED STORIES rule in BRIEF_SYSTEM).
  candidates = candidates.map((c) => (activePinIds.has(c.id) ? { ...c, pinned: true } : c));

  console.log(`brief [${edition}]: ${candidates.length} eligible candidates (excluded ${excludedCount} community-sourced stories; ${pinnedAdded} pinned stories force-added; ${activePinIds.size} active pins total).`);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles",
  });

  const result = await askJSON({
    role: "write",
    system: BRIEF_SYSTEM,
    prompt: JSON.stringify({
      date: today,
      edition,
      previous_edition_brief: feed.brief?.items?.map((i) => i.html) || [],
      candidates,
    }),
    maxTokens: 2000,
  });

  // Title is built in code, not by the model — guarantees consistent,
  // correctly-labeled AM/PM framing regardless of what the model returns.
  result.title = edition === "am"
    ? `${today} — six things creators need to know`
    : `${today} — six things that changed today`;

  // Publish gate: validates structure, sanitizes HTML to <b> only, dedupes.
  const gated = validateBrief(result, new Set(feed.stories.map((s) => s.id)));

  // tracking:true and commentary:true are both set here in code, never
  // trusted from the model — both are deterministic facts already known
  // from the candidate data, not judgment calls.
  const publishedIds = new Set(gated.items.map((i) => i.story));
  const commentaryIds = new Set(candidates.filter((c) => c.commentary).map((c) => c.id));
  for (const item of gated.items) {
    if (activePinIds.has(item.story)) item.tracking = true;
    if (commentaryIds.has(item.story)) item.commentary = true;
  }
  overrides.pinned_brief = (overrides.pinned_brief || [])
    .map((p) => (publishedIds.has(p.id) ? { ...p, editions_remaining: p.editions_remaining - 1 } : p))
    .filter((p) => p.editions_remaining > 0);
  saveOverrides(overrides);

  feed.issue = (feed.issue || 0) + 1;
  feed.brief = { ...gated, date: new Date().toISOString(), edition };
  saveFeed(feed);
  console.log(`brief [${edition}]: issue ${feed.issue} written with ${gated.items.length} items (${gated.items.filter(i=>i.tracking).length} tracking, ${gated.items.filter(i=>i.hardware).length} hardware).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
