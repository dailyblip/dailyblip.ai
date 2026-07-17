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
- Write for AI-assisted creators: artists, musicians, filmmakers, designers, writers, developers, independent creators.
- Assume readers are interested in AI but skeptical of hype.
- Get to useful information quickly. Concise paragraphs. Clear H2/H3 headings.
- Include practical steps, examples, workflows, or evaluation criteria.
- Explain strengths, limitations, and tradeoffs honestly.
- No generic motivational filler, no passive-income promises, no marketing language, no unsupported superlatives.
- Never use an em dash (\u2014). Use a period, comma, or parentheses instead.
- Never claim dailyblip tested a product unless real test data was explicitly supplied (it never is, in this pipeline).
- Never call a tool "best" without stating the specific use case that makes it best for that case.
- Clearly identify subjective editorial judgment as judgment, not fact.
- Provide real original value: comparisons, concrete examples, workflows, evaluation criteria, tradeoffs \u2014 not a paraphrase of product pages or press releases.`;

// ---- Stage: brief --------------------------------------------------------
const BRIEF_SYSTEM = `You are the editorial lead for dailyblip, planning a guide before a researcher and writer produce it. ${EDITORIAL_RULES}

Turn the submitted idea into a detailed editorial brief. Return JSON:
{
  "target_reader": "specific description of who this is for",
  "reader_outcome": "what the reader should be able to DO after reading this",
  "structure_plan": ["section heading 1", "section heading 2", ...],
  "claims_to_verify": ["specific factual claims the research step must confirm with real sources, e.g. pricing, capabilities, policies"],
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
    // Scaled by target_length (see LENGTH_CONFIG below) \u2014 previously
    // flat at 8000/10 searches regardless of length, so a Quick guide
    // was paying for Deep-dive-sized research it never needed. The
    // 10-source cap in RESEARCH_SYSTEM above still applies at every
    // tier as the hard ceiling on output size.
    maxTokens: cfg.researchTokens,
    maxSearches: cfg.researchSearches,
  });
  job.sources = (result.sources || []).map((s) => ({ ...s, accessed_date: new Date().toISOString().slice(0, 10) }));
  job.unverifiable_claims = result.unverifiable_claims || [];
}

// ---- Stage: draft -------------------------------------------------------
// Cost scales with target_length \u2014 research and draft budgets were
// previously FLAT regardless of length, meaning every "Quick" (800-1200
// word) guide paid for the same 8000-token draft ceiling and 10-search
// research budget as a "Deep dive" (2500-3500 word) guide, even though
// it needs a fraction of both. These numbers include real headroom
// above the target word count (not a tight fit), since running out of
// room mid-generation is a worse failure than a slightly generous
// ceiling.
const LENGTH_CONFIG = {
  Quick: { words: "800 to 1200 words total", researchTokens: 4000, researchSearches: 5, draftTokens: 3500 },
  Standard: { words: "1500 to 2200 words total", researchTokens: 6000, researchSearches: 8, draftTokens: 5500 },
  "Deep dive": { words: "2500 to 3500 words total", researchTokens: 8000, researchSearches: 10, draftTokens: 8000 },
};

const DRAFT_SYSTEM = `You write the full draft of a dailyblip guide. ${EDITORIAL_RULES}

Write body_markdown as real markdown: ## for section-level subheadings within a section (rare, only if genuinely needed), **bold**, *italic*, [text](url) links, "- " bullet lists. No raw HTML.

Every claim beyond common knowledge must trace to a source in the provided source list \u2014 if a claim isn't supported, soften it into an editorial observation or drop it. Do not use any claim listed in unverifiable_claims as if verified.

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
    maxTokens: cfg.draftTokens,
  });
  assertArticleShape(job.article, "draft");
  job.article.last_reviewed_date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ---- Stage: factcheck (+ auto-revise on medium/high issues) -----------
const FACTCHECK_SYSTEM = `You are the fact-checking and editorial-review pass for a dailyblip guide, run separately from drafting on purpose \u2014 review this critically, don't rubber-stamp it.

Inspect: product capabilities, availability, pricing, free-plan claims, commercial-use terms, copyright statements, platform policies, monetization requirements, release dates, unsupported conclusions, misleading claims, broken/invented-looking links, any statement implying dailyblip tested something, repetitive/generic writing, undisclosed affiliate language.

Return AT MOST 12 issues total, prioritizing the most severe and clearest problems \u2014 if you find more than 12 genuine issues, that's a sign the section needs a broader rewrite, not a reason to list every one individually. Keep "original_text" to a short identifying fragment (10-15 words), not the full passage \u2014 just enough for a human to locate it. Do NOT write a suggested fix here \u2014 that's a separate step's job; yours is only to identify and describe the problem.

Return JSON: {"issues": [{"severity":"low|medium|high","section_id":"matches a section id, or \\"intro\\"/\\"conclusion\\"","original_text":"short identifying fragment, 10-15 words","issue":"what's wrong, 1-2 sentences","supporting_source_url":"" }]}
Your response must begin with { immediately \u2014 no preamble, no "Let me review this article," no explanation before or after the JSON. JSON only. Empty issues array if genuinely clean.`;

const REVISE_SYSTEM = `You are fixing specific flagged issues in a dailyblip guide, changing as little else as possible. ${EDITORIAL_RULES}

You'll receive the full article for context, plus a list of specific issues to fix. Return ONLY the corrected content for whatever needs to change \u2014 do NOT reproduce the entire article. This keeps your response small and focused, and avoids accidentally altering parts of the article nobody flagged.

Return JSON: {
  "introduction": "corrected text, ONLY include this field if the introduction itself was flagged",
  "conclusion": "corrected text, ONLY include this field if the conclusion itself was flagged",
  "section_fixes": [{"id":"the flagged section's id, matching the article you were given","body_markdown":"the corrected body_markdown for just this section"}]
}
Only include entries for sections/fields that actually had a flagged issue \u2014 omit everything else entirely. JSON only.`;

// Merges targeted fixes into the EXISTING article object rather than
// replacing it \u2014 this is what makes "revise returned garbage" no
// longer able to destroy a good draft: there's no wholesale
// replacement for a bad response to corrupt. Unmatched/malformed
// entries are just skipped rather than thrown on, since a partially-
// applied revision (some real fixes landed, one weird entry ignored)
// is a much better outcome than failing the whole job over one bad
// fix entry.
function applyRevisionFixes(article, fixes) {
  if (typeof fixes?.introduction === "string" && fixes.introduction.trim()) article.introduction = fixes.introduction;
  if (typeof fixes?.conclusion === "string" && fixes.conclusion.trim()) article.conclusion = fixes.conclusion;
  for (const fix of fixes?.section_fixes || []) {
    const sec = (article.sections || []).find((s) => s.id === fix?.id);
    if (sec && typeof fix.body_markdown === "string" && fix.body_markdown.trim()) sec.body_markdown = fix.body_markdown;
  }
}

async function stageFactcheck(job) {
  const result = await askJSON({
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
    // Was 3000, then 6000 \u2014 still truncated in production on a real
    // article even at 6000. Rather than keep raising this indefinitely,
    // FACTCHECK_SYSTEM above now also bounds the actual output size
    // directly: capped at 12 issues, short identifying fragments
    // instead of full quotes, and no recommended_replacement field
    // (confirmed unused downstream \u2014 the separate revise step
    // re-derives its own fix and never reads it). This higher ceiling
    // is headroom on top of that, not a substitute for it.
    maxTokens: 8000,
  });
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
    job.fact_check.revised = true;
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
    // Scaled by how many images were actually requested (2 or 3), not a
    // flat budget sized for the worst case every time.
    maxTokens: slots.length >= 3 ? 4000 : 2800,
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
