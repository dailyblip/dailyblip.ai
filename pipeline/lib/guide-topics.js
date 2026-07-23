// pipeline/lib/guide-topics.js — the topic queue for the weekly guide
// agent (pipeline/guide-agent.js).
//
// SEED_TOPICS below is the starting list, hand-written the same way
// commentary.js's TOPICS array is. But unlike commentary, this queue is
// meant to keep growing indefinitely rather than just cycling the same
// fixed list forever: when the number of remaining, publishable topics
// gets low, refillTopicsIfNeeded() asks Claude for a fresh batch, given
// the FULL history of every topic ever used (title + angle, not just
// titles, so the model has real context on what's actually been
// covered conceptually) -- then runs each candidate through a cheap,
// mechanical similarity check before accepting it. This is deliberately
// NOT a semantic/embedding-based check (a real "is this conceptually
// the same idea" judgment would need one); it's a blunter, word-overlap
// safety net against near-duplicate titles and angles. Given topic
// selection here has no human approval step (a deliberate choice --
// final guide drafts still get reviewed before publishing), this
// mechanical check is the only thing standing between the queue and
// slow repetition, so it errs toward rejecting borderline cases rather
// than letting them through.
//
// Auto-generated topics are always standalone (series: null) -- a
// multi-part series is a bigger content commitment than a single guide,
// and committing to one autonomously, with no human weighing in on the
// premise at all, seems like the wrong default. Series stay hand-added
// to SEED_TOPICS for now.
import { askJSON } from "./claude.js";

export const SEED_TOPICS = [
  { id: "browser-game-1", series: "building-a-browser-game-with-ai", series_part: 1, series_total: 5, series_title: "Building a Browser Game With AI",
    title: "Building a Browser Game With AI: Part 1 -- Concept and Design",
    angle: "planning a small browser game before touching any generation tool -- core loop, a one-page design doc, scope discipline for a solo/small project",
    needs_image_comparison: false },
  { id: "browser-game-2", series: "building-a-browser-game-with-ai", series_part: 2, series_total: 5, series_title: "Building a Browser Game With AI",
    title: "Building a Browser Game With AI: Part 2 -- Sprite and Character Asset Generation",
    angle: "turning a design doc into real character and sprite art, keeping a consistent style across many generated assets",
    needs_image_comparison: true },
  { id: "browser-game-3", series: "building-a-browser-game-with-ai", series_part: 3, series_total: 5, series_title: "Building a Browser Game With AI",
    title: "Building a Browser Game With AI: Part 3 -- Environment and Background Art",
    angle: "generating backgrounds, tilesets, and environment art that actually matches the character style from part 2",
    needs_image_comparison: true },
  { id: "browser-game-4", series: "building-a-browser-game-with-ai", series_part: 4, series_total: 5, series_title: "Building a Browser Game With AI",
    title: "Building a Browser Game With AI: Part 4 -- Bringing It Together",
    angle: "engine choice for a small browser game and the practical integration work of getting generated assets into it",
    needs_image_comparison: false },
  { id: "browser-game-5", series: "building-a-browser-game-with-ai", series_part: 5, series_total: 5, series_title: "Building a Browser Game With AI",
    title: "Building a Browser Game With AI: Part 5 -- Playtesting, Polish, and What to Fix First",
    angle: "what actually matters once a first playable build exists -- prioritizing polish, common first-build mistakes",
    needs_image_comparison: false },

  { id: "image-model-comparison", series: null, series_part: null, series_total: null, series_title: null,
    title: "ChatGPT Image vs Flux vs Ideogram: Which AI Image Generator Should You Actually Use",
    angle: "a direct, same-prompt comparison across officially-API-available image models, honest about where each one wins",
    needs_image_comparison: true },
  { id: "video-prompts", series: null, series_part: null, series_total: null, series_title: null,
    title: "How to Write AI Video Prompts That Actually Get You What You Meant",
    angle: "prompt structure specific to video generation -- camera direction, motion, pacing -- not just reusing image-prompt habits",
    needs_image_comparison: false },
  { id: "video-character-consistency", series: null, series_part: null, series_total: null, series_title: null,
    title: "Keeping Characters Consistent Across AI-Generated Video",
    angle: "the specific techniques for holding a character's appearance steady across multiple video generations or shots",
    needs_image_comparison: false },
  { id: "one-idea-ten-posts", series: null, series_part: null, series_total: null, series_title: null,
    title: "Turning One Idea Into Ten Social Posts With AI",
    angle: "a repeatable workflow for multiplying a single piece of content across formats without it feeling recycled",
    needs_image_comparison: false },

  { id: "content-month-1", series: "building-a-month-of-content-with-ai", series_part: 1, series_total: 2, series_title: "Building a Month of Content With AI",
    title: "Building a Month of Content With AI: Part 1 -- Planning and Batching",
    angle: "planning and batching a full month of content in one sitting, the actual planning artifacts worth keeping",
    needs_image_comparison: false },
  { id: "content-month-2", series: "building-a-month-of-content-with-ai", series_part: 2, series_total: 2, series_title: "Building a Month of Content With AI",
    title: "Building a Month of Content With AI: Part 2 -- The Production Workflow",
    angle: "turning a month's plan into finished, published content -- the actual week-to-week production rhythm",
    needs_image_comparison: false },

  { id: "faceless-youtube", series: null, series_part: null, series_total: null, series_title: null,
    title: "The Best AI Workflow for Faceless YouTube Channels",
    angle: "a realistic, end-to-end workflow for a faceless channel -- scripting, voice, visuals, and what actually takes the most time",
    needs_image_comparison: false },
];

// Words too common to carry any real topical signal -- excluded before
// comparing two topics so "AI" or "how to" matching doesn't inflate
// the similarity score of two genuinely different topics.
const STOP_WORDS = new Set(["the", "with", "and", "for", "your", "you", "how", "what", "ai", "guide", "guides", "using", "use", "actually", "a", "an", "to", "of", "in", "on", "is", "are", "it", "this", "that", "into", "vs", "versus", "or", "best"]);

function significantWords(text) {
  return new Set(
    String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

// Plain word-overlap (Jaccard) similarity -- deliberately simple and
// mechanical rather than semantic, per the module comment above.
function similarity(wordsA, wordsB) {
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.28;

export function isTooSimilar(candidate, existingTopics) {
  const candidateWords = significantWords(`${candidate.title} ${candidate.angle}`);
  return existingTopics.some((t) => {
    const existingWords = significantWords(`${t.title} ${t.angle}`);
    return similarity(candidateWords, existingWords) >= SIMILARITY_THRESHOLD;
  });
}

const TOPIC_GEN_SYSTEM = `You propose new guide topics for dailyblip, a site covering practical AI tools and workflows for creators (image generation, video, writing, workflows, tool comparisons). You will be given the full list of topics already covered -- titles and their underlying angle -- and must propose genuinely new ones, not a differently-worded version of something already on the list.

Favor: specific, practical, search-friendly topics a creator would actually type into Google. Tool comparisons, concrete workflows, troubleshooting-style guides.
Avoid: vague inspirational topics, anything that only makes sense as a variation of an existing angle, topics tied to a specific product version or date (this site is deliberately evergreen).

Return JSON: {"topics": [{"title": "...", "angle": "one sentence describing what the guide actually argues or teaches"}]}
JSON only, no commentary.`;

export async function generateNewTopics(existingTopics, count = 8) {
  const history = existingTopics.map((t) => ({ title: t.title, angle: t.angle }));
  const result = await askJSON({
    role: "write",
    system: TOPIC_GEN_SYSTEM,
    prompt: JSON.stringify({ already_covered: history, how_many_needed: count }),
    maxTokens: 2000,
  });
  return Array.isArray(result?.topics) ? result.topics : [];
}

function slugifyId(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

// Mutates log.topics in place, appending newly-generated, de-duped
// topics when the number of currently-eligible (unused, series-order-
// respecting) topics runs low. Safe to call every run -- it's a no-op
// whenever there's still a healthy backlog.
export async function refillTopicsIfNeeded(log, { minRemaining = 3, batchSize = 8 } = {}) {
  if (!Array.isArray(log.topics) || !log.topics.length) log.topics = SEED_TOPICS.slice();
  const usedIds = new Set(log.used_topic_ids || []);
  const remaining = log.topics.filter((t) => isEligible(t, usedIds, log.topics));
  if (remaining.length > minRemaining) return { generated: 0, rejected: 0 };

  let generated = [];
  try {
    generated = await generateNewTopics(log.topics, batchSize);
  } catch (e) {
    console.warn(`guide-topics: topic generation failed, continuing on the existing queue: ${e.message}`);
    return { generated: 0, rejected: 0 };
  }

  let accepted = 0, rejected = 0;
  for (const candidate of generated) {
    if (!candidate?.title || !candidate?.angle) continue;
    if (isTooSimilar(candidate, log.topics)) { rejected++; continue; }
    log.topics.push({
      id: slugifyId(candidate.title), series: null, series_part: null, series_total: null, series_title: null,
      title: candidate.title, angle: candidate.angle, needs_image_comparison: false,
    });
    accepted++;
  }
  console.log(`guide-topics: generated ${generated.length} candidate(s), accepted ${accepted}, rejected ${rejected} as too similar to existing coverage.`);
  return { generated: accepted, rejected };
}

function isEligible(topic, usedIds, allTopics) {
  if (usedIds.has(topic.id)) return false;
  if (topic.series && topic.series_part > 1) {
    const priorPart = allTopics.find((t) => t.series === topic.series && t.series_part === topic.series_part - 1);
    if (priorPart && !usedIds.has(priorPart.id)) return false; // prior part not published yet
  }
  return true;
}

export function pickNextTopic(log) {
  if (!Array.isArray(log.topics) || !log.topics.length) log.topics = SEED_TOPICS.slice();
  const usedIds = new Set(log.used_topic_ids || []);
  const eligible = log.topics.find((t) => isEligible(t, usedIds, log.topics));
  if (eligible) return eligible;
  // Nothing eligible -- refillTopicsIfNeeded() should normally prevent
  // this from ever actually happening (it's meant to top up the queue
  // well before it's exhausted), but if that call ever failed (API
  // error, etc.) this is the fallback: reset tracking and start a
  // second pass through the existing list rather than getting stuck.
  log.used_topic_ids = [];
  return log.topics[0];
}
