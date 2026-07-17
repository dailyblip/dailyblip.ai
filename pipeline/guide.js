// pipeline/guide.js — on-demand evergreen guide generator, triggered from
// admin.html's Guides tab via workflow_dispatch (see guide.yml), never on
// a schedule. Runs as one CLI invocation PER STAGE:
//
//   node pipeline/guide.js brief     <jobId>
//   node pipeline/guide.js research  <jobId>
//   node pipeline/guide.js draft     <jobId>
//   node pipeline/guide.js factcheck <jobId>
//   node pipeline/guide.js images    <jobId>
//   node pipeline/guide.js format    <jobId>
//
// This is deliberate, not an arbitrary split: guide.yml commits+pushes
// data/guides.json after EACH stage, which is what lets admin.html's
// polling loop show real progress (queued -> researching -> drafting ->
// ...). A single long-running script with no external commit points
// would leave admin.html staring at "queued" for the entire multi-
// minute run with no way to know it's actually working.
//
// Same editorial-rules-as-hard-requirements pattern as commentary.js:
// prompted for AND mechanically checked afterward wherever a prompt
// alone can't be fully trusted (see validateArticle below).
import { loadGuides, saveGuides } from "./lib/store.js";
import { askJSON, askWithSearch } from "./lib/claude.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

// What each stage sets job.stage TO once it finishes — i.e. "what's
// starting now that this stage is done." Doubles as the single source
// of truth for stage labels (see the CLI entry point below for why
// there's no separate start-of-stage label).
const NEXT_STAGE = {
  brief: "Researching",
  research: "Drafting",
  draft: "Fact-checking",
  factcheck: "Generating images",
  images: "Formatting",
  format: "Ready for review",
  // main()'s generic handler always does job.stage = NEXT_STAGE[stageName]
  // after a stage runs \u2014 without this entry, that would overwrite
  // stageRecheck's own "Ready for review" assignment with undefined.
  recheck: "Ready for review",
};

function getJob(jobId) {
  const guides = loadGuides();
  const job = guides.find((g) => g.id === jobId);
  if (!job) throw new Error(`guide.js: no job found with id ${jobId}`);
  return { guides, job };
}
function saveJob(guides, job) {
  job.updated_at = new Date().toISOString();
  const i = guides.findIndex((g) => g.id === job.id);
  guides[i] = job;
  saveGuides(guides);
}
function fail(guides, job, stage, err) {
  job.status = "failed";
  job.stage = "Failed";
  job.error = { stage, message: err.message, at: new Date().toISOString() };
  saveJob(guides, job);
  console.error(`guide.js: job ${job.id} failed at "${stage}": ${err.message}`);
  process.exit(1);
}

const ARTICLE_TYPES = {
  "Practical guide": "a step-by-step practical how-to",
  "Top tools list": "a curated, evaluated list of tools for a specific purpose",
  "Tool comparison": "a head-to-head comparison between specific named tools",
  "Creator workflow": "an end-to-end workflow a creator can follow, tool-agnostic where possible",
  "Monetization guide": "a guide to actually earning money with a skill or tool, grounded and non-hypey",
  "Beginner explainer": "an accessible explainer assuming zero prior knowledge of the topic",
  "Rights and platform guide": "a guide to legal/platform-policy questions — commercial use, ownership, ToS",
};

// ---- Editorial rules, shared across every stage's system prompt --------
const EDITORIAL_RULES = `dailyblip editorial rules, apply to everything you write:

WHO THESE ARE FOR: assume the reader is curious or just getting started, not a power user. They may have never touched this kind of AI tool before. The goal of every guide is "give someone enough to take their first confident step," not "cover the topic comprehensively." If you're deciding whether to include something, ask: does a total beginner need this to get started today? If not, leave it out.

- Write for AI-assisted creators: artists, musicians, filmmakers, designers, writers, developers, independent creators \u2014 specifically ones who are new to this particular tool or topic, not veterans of it.
- Assume readers are interested in AI but skeptical of hype.
- Keep it SHORT. A starter article, not a manual. Get to useful information quickly, concise paragraphs, clear headings.
- Skip credits, exact pricing figures, exact quotas, version numbers, and other specifics a beginner doesn't need on day one \u2014 "there's a free tier to try it" beats any exact number, every time. If a reader needs precise current numbers, that's what the tool's own site is for; don't try to be that reference here. (Exception: "Rights and platform guide" articles specifically \u2014 legal/commercial terms need real precision, not simplification, since readers may make business decisions off them. Don't lighten accuracy there just for brevity.)
- One clear starting point beats an exhaustive comparison. Don't build out full strengths/limitations breakdowns for every tool mentioned \u2014 mention what's genuinely useful to know and move on.
- No generic motivational filler, no passive-income promises, no marketing language, no unsupported superlatives.
- Never use an em dash (\u2014). Use a period, comma, or parentheses instead.
- Never claim dailyblip tested a product unless real test data was explicitly supplied (it never is, in this pipeline).
- Never call a tool "best" without stating the specific use case that makes it best for that case.
- Clearly identify subjective editorial judgment as judgment, not fact.
- Everything you DO state must still be accurate \u2014 "light and simple" means less depth and fewer specifics, never less truthful. A shorter true claim beats a longer precise-sounding one that overstates the source.

CALIBRATE CERTAINTY TO THE SOURCE, every time \u2014 this is the single most
common reason drafts get flagged and delayed at fact-check, so get it
right here instead of relying on a later pass to catch it. Three
categories need extra care, since sources are most likely to be
outdated, single-sourced, or conflicting here:
- Pricing/plan details: if a source describes a quota in one unit (GPU-minutes, credits, compute-hours), never restate it in a different unit (image counts, generations) as if they're equivalent \u2014 state it exactly as the source frames it, and note explicitly if the practical yield varies. Better still, per the beginner-focused rule above: usually just skip the exact number entirely.
- Deprecation/discontinuation/availability: "announced for deprecation on [date]" and "is deprecated" are NOT the same claim \u2014 write the one your source actually supports, never upgrade an announcement into a completed fact.
- Commercial/legal usage rights: if a source explicitly states a finding (e.g. "free tier is not licensed for commercial use"), state that finding directly and attribute it to the source \u2014 do not soften it into "appears to" or "based on editorial review" when the source itself was not hedging. Conversely, if your own understanding is inferred rather than a direct citation, say so plainly \u2014 readers may make real business decisions off this.
In all three cases: an independent review or single blog post is not the same as official documentation, and your sentence should make clear which one is backing the claim.`;

// ---- Stage: brief --------------------------------------------------------
const BRIEF_SYSTEM = `You are the editorial lead for dailyblip, planning a guide before a researcher and writer produce it. ${EDITORIAL_RULES}

Turn the submitted idea into a detailed editorial brief. Remember: this is a simple starter article for beginners, not a comprehensive guide \u2014 plan 3-4 sections maximum, each answering one clear question a newcomer actually has. Don't plan out a structure that would require deep technical coverage to fill.

Return JSON:
{
  "target_reader": "specific description of who this is for \u2014 default to someone new to this tool/topic unless the submitted idea clearly implies otherwise",
  "reader_outcome": "what the reader should be able to DO after reading this \u2014 usually \"feel oriented enough to try it,\" not \"master it\"",
  "structure_plan": ["section heading 1", "section heading 2", "... (3-4 total)"],
  "claims_to_verify": ["specific factual claims the research step must confirm \u2014 favor capabilities and availability over precise pricing/quota figures, since the draft will mostly avoid stating exact numbers anyway"],
  "research_plan": "what kinds of sources to prioritize for this specific topic"
}
JSON only.`;

async function stageBrief(job) {
  const s = job.submitted;
  job.brief = await askJSON({
    role: "write",
    system: BRIEF_SYSTEM,
    prompt: JSON.stringify({
      idea: s.idea,
      article_type: s.article_type,
      article_type_meaning: ARTICLE_TYPES[s.article_type] || s.article_type,
      target_audience: s.target_audience,
      target_length: s.target_length,
      editorial_notes: s.editorial_notes,
      points_to_include: s.points_to_include,
      keywords: s.keywords,
    }),
    maxTokens: 1500,
  });
}

// ---- Stage: research -------------------------------------------------
const RESEARCH_SYSTEM = `You are a research assistant for a dailyblip guide. Find and verify real, current, cited sources for the claims and topic below. Prioritize, in order: official product documentation, official company announcements, platform policy pages, government/legal sources, reputable independent reporting, independent reviews, and (only when clearly labeled as subjective) recurring user feedback.

Never invent: URLs, prices, capabilities, policies, dates, quotes, statistics, or user feedback. If something can't be verified, say so explicitly rather than guessing \u2014 the writer will work around missing information rather than the research step inventing it.

For each source, distinguish: verified product fact, company claim, independent observation, editorial judgment, or recurring user feedback \u2014 label each clearly.

Return AT MOST 10 sources total, even for topics covering several tools/products \u2014 prioritize the most important, authoritative source per claim over exhaustive coverage. A comparison across many tools should mean fewer sources per tool, not more sources overall. This is a hard cap, not a suggestion \u2014 the response must fit comfortably within budget.

Return JSON: {
  "sources": [{"title":"","publisher":"","url":"","source_type":"official docs|company announcement|platform policy|legal|independent reporting|independent review|user feedback","is_primary":true,"claims_supported":["..."],"claim_type":"verified fact|company claim|independent observation|editorial judgment|user feedback"}],
  "unverifiable_claims": ["claims from the brief that could not be confirmed \u2014 the writer must soften or drop these"]
}
JSON only.`;

async function stageResearch(job) {
  job.sources = [];
  const cfg = LENGTH_CONFIG[job.submitted.target_length] || LENGTH_CONFIG.Standard;
  const result = await askWithSearch({
    role: "write",
    system: RESEARCH_SYSTEM,
    prompt: JSON.stringify({ topic: job.submitted.idea, claims_to_verify: job.brief?.claims_to_verify || [] }),
    // maxSearches genuinely scales with length (fewer searches = fewer
    // $0.01 fees + less search-result context). maxTokens is a flat,
    // generous ceiling regardless of tier \u2014 see LENGTH_CONFIG's comment
    // for why scaling this down provided no real savings and caused
    // real truncation failures.
    maxTokens: 8000,
    maxSearches: cfg.researchSearches,
  });
  job.sources = (result.sources || []).map((s) => ({ ...s, accessed_date: new Date().toISOString().slice(0, 10) }));
  job.unverifiable_claims = result.unverifiable_claims || [];
}

// ---- Stage: draft -------------------------------------------------------
// researchSearches genuinely affects cost \u2014 fewer searches means
// fewer $0.01 search fees AND less search-result content entering
// context. Token CEILINGS below are deliberately uniform and generous
// across every tier, not scaled down: max_tokens is a limit, not a
// charge \u2014 you're billed for tokens actually generated, not however
// high the ceiling is set, so a shorter guide naturally costs less
// without needing a tighter ceiling. Scaling the ceiling down (an
// earlier version of this file did) saved nothing in the success case
// and caused real truncation failures in production once a response
// ran even slightly longer than the tight estimate \u2014 a failed run
// wastes 100% of every earlier stage's cost, which is a far worse
// outcome than an unused few thousand tokens of ceiling headroom.
const LENGTH_CONFIG = {
  Quick: { words: "500 to 800 words total", researchSearches: 4 },
  Standard: { words: "800 to 1200 words total", researchSearches: 6 },
  "Deep dive": { words: "1200 to 1800 words total", researchSearches: 8 },
};

const DRAFT_SYSTEM = `You write the full draft of a dailyblip guide. ${EDITORIAL_RULES}

WHAT THIS IS: a simple starter article for someone who is new to this tool or topic, or just curious about it \u2014 not a comprehensive guide, not a technical manual, not a reference doc. Think "friendly explainer that gets someone oriented and excited to try it," not "everything you could possibly need to know." If you find yourself writing something a total beginner would skim past or not understand, cut it.

TONE: Fun, breezy, approachable. Write like a knowledgeable friend giving someone the fast, exciting version of "here's how to get started," not like a spec sheet. Short, punchy sentences. Energy and momentum over completeness.

STRUCTURE: Aim for 3-4 sections, not more \u2014 this is a quick read, not an exhaustive breakdown. Each section should answer one clear question a beginner actually has ("what is this," "how do I start," "what should I try first"), not attempt full coverage of a subtopic.

DEPTH: Skip pricing tiers, version numbers, quotas, and legal nuance entirely unless the article type specifically requires precision (see EDITORIAL_RULES' rights/legal exception). "Has a free tier worth trying" beats any exact number. Point readers to the tool's own site for current specifics rather than trying to be that reference yourself.

Write body_markdown as real markdown: **bold**, *italic*, [text](url) links, "- " bullet lists. No raw HTML, and avoid ## subheadings within a section entirely for a piece this short \u2014 if a section needs its own subheadings, it should probably be two sections instead.

Every claim beyond common knowledge must trace to a source in the provided source list \u2014 if a claim isn't supported, soften it into an editorial observation or drop it entirely rather than forcing in a technical detail the guide doesn't need. Do not use any claim listed in unverifiable_claims as if verified.

Tool cards (the "tools" array within a section) should be rare, not a per-section default \u2014 include one only when a specific named tool genuinely earns its own callout, and keep strengths/limitations to the single most useful point each. Most sections don't need a tool card at all; mention tools in the prose instead when that reads more naturally.

Return JSON matching this schema exactly:
{
  "title": "", "alternative_titles": ["",""], "slug": "kebab-case-slug",
  "dek": "", "meta_description": "", "quick_answer": "1-2 sentence direct answer if the topic has one, else empty string",
  "introduction": "markdown, 1-2 short paragraphs",
  "sections": [{"id":"s1","heading":"","body_markdown":"","tools":[{"name":"","url":"","description":"","strengths":["..."],"limitations":["..."]}]}],
  "key_takeaways": ["3-5 short bullet points"],
  "conclusion": "markdown",
  "methodology_disclosure": "one paragraph describing how this guide was researched/synthesized, per dailyblip's disclosure requirement"
}
JSON only.`;

// Thrown immediately if a draft/revise response is syntactically valid
// JSON but structurally empty or wrong-shaped (missing title, no
// sections). Without this, a malformed-but-parseable response — the
// model returned SOME valid JSON, just not matching the expected
// schema — silently flows through factcheck and images, spending real
// API cost operating on garbage, and only surfaces as a confusing
// "ready for review" with an essentially empty article once format's
// validation finally catches it, stages later. This fails loud, at the
// actual point of corruption, with a message that says exactly what's
// missing instead of a downstream mystery.
function assertArticleShape(article, stageName) {
  const problems = [];
  if (!article?.title) problems.push("no title");
  if (!Array.isArray(article?.sections) || article.sections.length === 0) problems.push("no sections");
  if (problems.length) {
    throw new Error(`${stageName}: response parsed as valid JSON but is structurally empty (${problems.join(", ")}) \u2014 the model likely returned a wrong-shaped or near-empty object that askJSON's parser accepted without checking its shape. Check stop_reason in the logs above this error.`);
  }
}

async function stageDraft(job) {
  const s = job.submitted;
  const cfg = LENGTH_CONFIG[s.target_length] || LENGTH_CONFIG.Standard;
  job.article = await askJSON({
    role: "write",
    system: DRAFT_SYSTEM,
    prompt: JSON.stringify({
      idea: s.idea,
      article_type: s.article_type,
      target_audience: s.target_audience,
      length_target: cfg.words,
      editorial_notes: s.editorial_notes,
      points_to_include: s.points_to_include,
      brief: job.brief,
      sources: job.sources,
      unverifiable_claims: job.unverifiable_claims,
    }),
    // Flat, generous ceiling regardless of length tier \u2014 the prompt's
    // length_target already tells the model how long to actually write;
    // the ceiling only needs to be high enough to never be the limiting
    // factor. This is the exact call that failed in production when it
    // was scaled down for shorter tiers.
    maxTokens: 8000,
  });
  assertArticleShape(job.article, "draft");
  job.article.last_reviewed_date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ---- Stage: factcheck (+ auto-revise on medium/high issues) -----------
const FACTCHECK_SYSTEM = `You are the fact-checking and editorial-review pass for a dailyblip guide, run separately from drafting on purpose \u2014 review this critically, don't rubber-stamp it.

Inspect: product capabilities, availability, pricing, free-plan claims, commercial-use terms, copyright statements, platform policies, monetization requirements, release dates, unsupported conclusions, misleading claims, broken/invented-looking links, any statement implying dailyblip tested something, repetitive/generic writing, undisclosed affiliate language.

HARD LIMIT: never return more than 8 issues, no matter how many you find. If you identify more than 8 real problems, stop after documenting the 8 most severe and clearest ones \u2014 do not list the rest, do not summarize additional issues in a 9th entry, do not exceed 8 array entries under any circumstances. This is not a target to aim for; it is a limit you must not cross. Keep "original_text" to a short identifying fragment (10-15 words), never the full passage \u2014 just enough for a human to locate it. Keep "issue" to one short sentence. Do NOT write a suggested fix here \u2014 that's a separate step's job; yours is only to identify and describe the problem, as briefly as possible.

Return JSON: {"issues": [{"severity":"low|medium|high","section_id":"the id of the field that actually needs fixing: a section id, \\"intro\\", \\"conclusion\\", \\"quick_answer\\", \\"dek\\", \\"meta_description\\", or \\"key_takeaways\\". If the same bad claim appears in more than one place (e.g. both quick_answer and a section), report it once per place it needs fixing, labeled correctly for each \u2014 do not label a quick_answer problem as a section id just because the claim also appears in that section.","original_text":"short identifying fragment, 10-15 words","issue":"what's wrong, 1-2 sentences","supporting_source_url":"" }]}
Your response must begin with { immediately \u2014 no preamble, no "Let me review this article," no explanation before or after the JSON. JSON only. Empty issues array if genuinely clean.`;

const REVISE_SYSTEM = `You are fixing specific flagged issues in a dailyblip guide, changing as little else as possible. ${EDITORIAL_RULES}

You'll receive the full article for context, plus a list of specific issues to fix. Return ONLY the corrected content for whatever needs to change \u2014 do NOT reproduce the entire article. This keeps your response small and focused, and avoids accidentally altering parts of the article nobody flagged.

Return JSON: {
  "dek": "corrected text, ONLY if the dek itself was flagged",
  "meta_description": "corrected text, ONLY if flagged",
  "quick_answer": "corrected text, ONLY if flagged",
  "introduction": "corrected text, ONLY if the introduction itself was flagged",
  "conclusion": "corrected text, ONLY if the conclusion itself was flagged",
  "key_takeaways": ["corrected FULL array, ONLY include this field if at least one takeaway was flagged \u2014 return the complete corrected list, not just the changed item"],
  "section_fixes": [{"id":"the flagged section's id, matching the article you were given","body_markdown":"the corrected body_markdown for just this section"}]
}
Only include entries for fields that actually had a flagged issue \u2014 omit everything else entirely. JSON only.`;

// Merges targeted fixes into the EXISTING article object rather than
// replacing it \u2014 this is what makes "revise returned garbage" no
// longer able to destroy a good draft: there's no wholesale
// replacement for a bad response to corrupt. Unmatched/malformed
// entries are just skipped rather than thrown on, since a partially-
// applied revision (some real fixes landed, one weird entry ignored)
// is a much better outcome than failing the whole job over one bad
// fix entry.
function applyRevisionFixes(article, fixes) {
  if (typeof fixes?.dek === "string" && fixes.dek.trim()) article.dek = fixes.dek;
  if (typeof fixes?.meta_description === "string" && fixes.meta_description.trim()) article.meta_description = fixes.meta_description;
  if (typeof fixes?.quick_answer === "string" && fixes.quick_answer.trim()) article.quick_answer = fixes.quick_answer;
  if (typeof fixes?.introduction === "string" && fixes.introduction.trim()) article.introduction = fixes.introduction;
  if (typeof fixes?.conclusion === "string" && fixes.conclusion.trim()) article.conclusion = fixes.conclusion;
  // Full-array replacement, not a merge \u2014 the model is asked to return
  // the complete corrected list when any takeaway needed fixing, since
  // there's no clean way to identify "the 3rd bullet" for a partial
  // patch the way section ids work for section_fixes.
  if (Array.isArray(fixes?.key_takeaways) && fixes.key_takeaways.length) article.key_takeaways = fixes.key_takeaways;
  for (const fix of fixes?.section_fixes || []) {
    const sec = (article.sections || []).find((s) => s.id === fix?.id);
    if (sec && typeof fix.body_markdown === "string" && fix.body_markdown.trim()) sec.body_markdown = fix.body_markdown;
  }
}

async function detectIssues(job) {
  return askJSON({
    // Reverted from "classify" (Haiku) back to "write" (Sonnet) after
    // two consecutive real truncation failures immediately following
    // the switch \u2014 both cut off at only ~3000-4000 estimated tokens of
    // actual content, well under the 8000 ceiling, which suggests Haiku
    // was spending real budget on something other than the JSON payload
    // (most likely explanatory preamble) despite the same "JSON only"
    // instruction Sonnet reliably followed here. The 3x cost savings
    // isn't worth it if the stage can't reliably finish \u2014 a failed run
    // wastes the cost of every earlier stage too, so "cheaper but
    // unreliable" is a false economy. See the stricter no-prose
    // instruction in FACTCHECK_SYSTEM below too, as defense-in-depth
    // regardless of which model runs this.
    role: "write",
    system: FACTCHECK_SYSTEM,
    prompt: JSON.stringify({ article: job.article, sources: job.sources }),
    // Was 8000, still truncated in production even with the earlier
    // 12-issue cap \u2014 turns out that cap wasn't actually being respected
    // (the response was ~5x the expected size for 12 short-fragment
    // issues, suggesting the model was reporting far more than
    // instructed). FACTCHECK_SYSTEM's cap is now a genuinely enforced
    // hard limit (8 issues, explicit stop instruction) rather than a
    // soft target \u2014 this higher ceiling is real headroom on top of
    // that actually-working constraint, not a substitute for it.
    maxTokens: 10000,
  });
}

async function stageFactcheck(job) {
  const result = await detectIssues(job);
  job.fact_check = { issues: result.issues || [], checked_at: new Date().toISOString() };

  const needsRevision = job.fact_check.issues.some((i) => i.severity === "medium" || i.severity === "high");
  if (needsRevision) {
    // maxTokens is much smaller than the old whole-article-replacement
    // approach on purpose \u2014 this only asks for the flagged pieces, not
    // a full reproduction of the article, so it needs far less room and
    // is far less likely to truncate in the first place.
    const fixes = await askJSON({
      role: "write",
      system: REVISE_SYSTEM,
      prompt: JSON.stringify({ article: job.article, issues: job.fact_check.issues }),
      maxTokens: 3000,
    });
    applyRevisionFixes(job.article, fixes);

    // Re-check against the now-fixed content. Without this, job.warnings
    // always reflected the PRE-revision issues list forever \u2014 the text
    // could be genuinely corrected and the Approve button would still
    // stay disabled indefinitely, since nothing had re-verified whether
    // the fix actually worked. This is exactly the "edits look right but
    // warnings still block publish" failure mode, and previously the
    // only way to clear it was manually clicking Re-run fact check as a
    // separate step \u2014 now it happens automatically, as part of the same
    // real cost this stage was already going to pay for revision.
    const recheck = await detectIssues(job);
    job.fact_check = { issues: recheck.issues || [], checked_at: new Date().toISOString(), revised: true };
  }

  const unresolvedHigh = job.fact_check.issues.filter((i) => i.severity === "high");
  job.warnings = unresolvedHigh.map((i) => `${i.section_id}: ${i.issue}`);
  // High-severity issues block approval, but don't fail the whole job \u2014
  // a human reviewing with the warning visible is the intended path, per
  // "no unresolved high-severity issues may be approved," not "the
  // pipeline crashes." See admin.html's Approve button for the actual gate.
}

// ---- Standalone re-check (admin-triggered, not part of the main
// pipeline chain) ------------------------------------------------------
// Wraps stageFactcheck for the "I edited a flagged section by hand, now
// clear the block" flow. Unlike the mid-pipeline factcheck stage (which
// hands off to images/format next), this is a dead end on its own \u2014
// nothing downstream is going to set status back to ready_for_review
// for it, so it does that itself.
async function stageRecheck(job) {
  await stageFactcheck(job);
  job.status = "ready_for_review";
  job.stage = "Ready for review";
}

// ---- Stage: images --------------------------------------------------
function buildImagePrompts(article, imageCount) {
  const mix3 = ["wide hero image, 16:9", "workflow or explanatory section image, 4:3", "creator-focused practical-use image, 4:3"];
  const mix2 = ["wide hero image, 16:9", "workflow or creator-focused section image, 4:3"];
  return (imageCount === 3 ? mix3 : mix2).map((slot, i) => ({ id: `img${i + 1}`, slot }));
}

const IMAGE_BRIEF_SYSTEM = `Write image generation prompts for a dailyblip guide's images, one per required slot. ${EDITORIAL_RULES.split("\n")[0]}

For EACH slot, ground the prompt in this specific article's real content (its actual sections, tools, and examples) \u2014 never a generic prompt that could apply to any article on this topic.

Visual direction (apply to every prompt): premium, contemporary, editorial, creator-focused, visually distinct from generic corporate stock photography, legible at thumbnail size. Avoid: random robots, glowing AI brains, excessive holograms, meaningless interface elements, detailed generated text, watermarks, celebrity likenesses, copyrighted characters, unapproved company logos, fabricated product screenshots, near-duplicate compositions across the set. Leave negative space where HTML text may be placed. Never embed the article headline as text in the image.

Return JSON: {"images": [{"id":"img1","prompt":"the full image generation prompt","alt_text":"","caption":"","placement":"which section this illustrates, by section id or \\"hero\\""}]}
JSON only, one entry per slot given.`;

async function stageImages(job) {
  const slots = buildImagePrompts(job.article, job.submitted.image_count);
  // Image briefs need enough of each section to know what to depict,
  // not the full verbatim text \u2014 sending complete body_markdown here
  // was pure input-token waste with no benefit to prompt quality.
  const sectionPreviews = (job.article.sections || []).map((s) => ({
    id: s.id, heading: s.heading, preview: (s.body_markdown || "").slice(0, 300),
  }));
  const briefResult = await askJSON({
    role: "write",
    system: IMAGE_BRIEF_SYSTEM,
    prompt: JSON.stringify({ slots, article_title: job.article.title, sections: sectionPreviews }),
    // Flat ceiling regardless of image count \u2014 same correction as
    // research/draft above: the ceiling itself costs nothing unless
    // actually hit, so there's no real saving from scaling it down by
    // image count. The section-preview trimming above IS a genuine
    // saving (real input tokens sent, not an unused limit).
    maxTokens: 4000,
  });
  const briefs = briefResult.images || [];

  job.images = [];
  if (!OPENAI_KEY) {
    console.log("guide.js: OPENAI_API_KEY not set \u2014 formatting will proceed with zero images.");
    return;
  }
  const dir = "docs/guides";
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < briefs.length; i++) {
    const b = briefs[i];
    const slot = slots[i] || {};
    try {
      const size = /16:9/.test(slot.slot || "") ? "1536x1024" : "1024x1024";
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1", prompt: b.prompt, size, quality: "medium" }),
      });
      if (!res.ok) throw new Error(`OpenAI image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) throw new Error("OpenAI image API returned no image data");
      const buf = await sharp(Buffer.from(b64, "base64")).jpeg({ quality: 88 }).toBuffer();
      const filename = `${job.id}-${b.id || `img${i + 1}`}.jpg`;
      fs.writeFileSync(path.join(dir, filename), buf);
      job.images.push({
        id: b.id || `img${i + 1}`, file: filename, prompt: b.prompt, placement: b.placement,
        alt_text: b.alt_text, caption: b.caption, approved: false, generated_at: new Date().toISOString(),
      });
    } catch (e) {
      // One image failing shouldn't lose the others \u2014 same
      // graceful-degradation pattern as social.js.
      console.warn(`guide.js: image "${b.id}" failed, continuing without it: ${e.message}`);
    }
  }
}

// ---- Stage: format (assemble + pre-review validation) -----------------
function validateArticle(article) {
  const problems = [];
  if (!article.title) problems.push("missing title");
  if (!article.sections || article.sections.length === 0) problems.push("no sections");
  if (!article.methodology_disclosure) problems.push("missing methodology disclosure");
  if (!article.slug || !/^[a-z0-9-]+$/.test(article.slug)) problems.push("missing or invalid slug");
  return problems;
}

async function stageFormat(job) {
  const problems = validateArticle(job.article);
  if (problems.length) {
    job.warnings = [...(job.warnings || []), ...problems.map((p) => `format: ${p}`)];
  }
  job.status = "ready_for_review";
}

// ---- CLI entry -----------------------------------------------------------
const STAGE_FNS = { brief: stageBrief, research: stageResearch, draft: stageDraft, factcheck: stageFactcheck, images: stageImages, format: stageFormat, recheck: stageRecheck };

async function main() {
  const [, , stageName, jobId] = process.argv;
  if (!STAGE_FNS[stageName] || !jobId) {
    console.error("usage: node pipeline/guide.js <brief|research|draft|factcheck|images|format|recheck> <jobId>");
    process.exit(1);
  }
  const { guides, job } = getJob(jobId);
  // NOTE on visibility: the label admin.html polls and shows as "currently
  // running" is whatever the PREVIOUS stage set as its NEXT_STAGE value at
  // ITS end (committed by guide.yml right before this stage starts) — the
  // brief stage sets NEXT_STAGE.brief = "Researching" right as it hands
  // off to the research stage, for example. Writing a stage label here
  // too would be a no-op for visibility: git only commits BETWEEN CLI
  // invocations, never inside one, so an extra write at the top of this
  // function would just get silently overwritten by the end-of-function
  // write below before guide.yml ever gets a chance to commit it.

  try {
    await STAGE_FNS[stageName](job);
  } catch (e) {
    return fail(guides, job, stageName, e);
  }
  job.stage = NEXT_STAGE[stageName];
  saveJob(guides, job);
  console.log(`guide.js: job ${jobId} finished stage "${stageName}", now "${job.stage}".`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
