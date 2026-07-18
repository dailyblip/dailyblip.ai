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

VOICE: Direct, informed, slightly opinionated \u2014 a sharp human technology writer, not a content template. The reader is intelligent, internet-literate, and skeptical of AI-generated filler. Use contractions. Vary sentence and paragraph length; an occasional one-sentence paragraph is fine, but don't overuse them. Prioritize useful observations over motivational language. Don't sound like a corporate blog, an SEO agency, product documentation, or generic "friendly expert" writing.

NEVER USE these phrases or their close equivalents: "in today's rapidly evolving landscape," "whether you're a beginner or a seasoned professional," "the good news is," "here's where things get interesting," "that's the point," "it's worth noting," "at the end of the day," "game changer," "powerful tool," "unlock," "dive into," "delve," "seamlessly," "robust." If you notice yourself reaching for a similar stock phrase, replace it with something specific to this article instead.

- Write for AI-assisted creators: artists, musicians, filmmakers, designers, writers, developers, independent creators \u2014 specifically ones who are new to this particular tool or topic, not veterans of it.
- Keep it SHORT. A starter article, not a manual. Get to useful information quickly, concise paragraphs, clear descriptive headings (never generic ones like "Getting Started" or "Final Thoughts").
- Lead with the most useful information, not a sweeping introduction. Don't open every section with a broad introductory claim, and don't close every section with a miniature summary \u2014 that pattern reads as templated even when each individual sentence is fine.
- Don't repeat the article's main premise across the introduction, conclusion, AND key takeaways. Say it once, in whichever spot it lands best.
- Skip credits, exact pricing figures, exact quotas, version numbers, and other specifics a beginner doesn't need on day one \u2014 "there's a free tier to try it" beats any exact number, every time. If a reader needs precise current numbers, that's what the tool's own site is for; don't try to be that reference here. (Exception: "Rights and platform guide" articles specifically \u2014 legal/commercial terms need real precision, not simplification, since readers may make business decisions off them. Don't lighten accuracy there just for brevity.)
- When you do cover licensing/commercial-use caveats, put them all in ONE clearly-titled section (e.g. "Before you publish or monetize anything") rather than repeating a warning in multiple places.
- One clear starting point beats an exhaustive comparison. Don't build out full strengths/limitations breakdowns for every tool mentioned \u2014 mention what's genuinely useful to know and move on. When you do compare tools, make an actual judgment: say which reader should use which one and why, don't just list neutral facts side by side.
- Rhetorical questions only when one genuinely improves the sentence, not as a section-opening habit. Use "it's not X, it's Y" contrast constructions at most once in the whole article. Don't stack three adjectives or three examples just because it sounds rhythmic. Don't call something "surprisingly good," "impressive," or "easy" without saying exactly why.
- No generic motivational filler, no passive-income promises, no marketing language, no unsupported superlatives.
- Never use an em dash (\u2014). Use a period, comma, or parentheses instead.
- Never claim dailyblip tested a product unless real test data was explicitly supplied (it never is, in this pipeline). Say so once, briefly, near the end \u2014 don't apologize for it repeatedly through the piece.
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
- Commercial/legal usage rights: if a source explicitly states a finding (e.g. "free tier is not licensed for commercial use"), state that finding directly and attribute it to the source \u2014 do not soften it into "appears to" or "based on editorial review" when the source itself was not hedging. Conversely, if your own understanding is inferred rather than a direct citation, say so plainly \u2014 readers may make real business decisions off this. If sources conflict on a fact, state the conflict once, clearly, rather than hedging every sentence around it.
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

TONE: Direct and a little opinionated, per EDITORIAL_RULES' VOICE section above \u2014 not breezy filler, and not a spec sheet either. Short, punchy sentences where they help; longer ones where an idea genuinely needs the room. Energy and momentum over completeness.

STRUCTURE: 3-4 sections, not more \u2014 this is a quick read. Between them, cover whichever of these actually apply to this topic, combined into that smaller number of sections rather than each getting its own: a direct recommendation of where to start, a practical step or two, a specific example, the most important limitation or common mistake, and (only if relevant) one licensing/commercial-use note consolidated in its own section per EDITORIAL_RULES. Don't force all of these in if the topic doesn't call for them \u2014 a natural 3-section piece beats a padded 4-section one.

Introduction: no more than 100 words, and skip the sweeping windup \u2014 lead with the most useful thing a reader needs to know.

DEPTH: Skip pricing tiers, version numbers, quotas, and legal nuance entirely unless the article type specifically requires precision (see EDITORIAL_RULES' rights/legal exception). "Has a free tier worth trying" beats any exact number. Point readers to the tool's own site for current specifics rather than trying to be that reference yourself.

Write body_markdown as real markdown: **bold**, *italic*, [text](url) links, "- " bullet lists. No raw HTML, and avoid ## subheadings within a section entirely for a piece this short \u2014 if a section needs its own subheadings, it should probably be two sections instead.

Every claim beyond common knowledge must trace to a source in the provided source list \u2014 if a claim isn't supported, soften it into an editorial observation or drop it entirely rather than forcing in a technical detail the guide doesn't need. Do not use any claim listed in unverifiable_claims as if verified.

Tool cards (the "tools" array within a section): how often to use these depends on the article type. For "Top tools list" or "Tool comparison" specifically, a card PER TOOL being presented is the expected default \u2014 that's the actual structure those article types exist for, so most or all of the tools you mention in those guides should get their own card with name, url, description, and the single most useful strength/limitation each. For every OTHER article type (Practical guide, Beginner explainer, Creator workflow, Monetization guide, Rights and platform guide), tool cards should be rare \u2014 include one only when a specific named tool genuinely earns its own callout, and mention tools in the prose instead when that reads more naturally.

SELF-EDIT PASS \u2014 before returning your answer, review your own draft against this checklist and revise anything that fails it:
1. Delete any sentence generic enough to appear in an article about any AI tool.
2. Cut repeated ideas \u2014 especially the same premise appearing in the intro, conclusion, and takeaways.
3. Replace vague praise ("impressive," "easy," "surprisingly good") with the specific reason behind it, or cut it.
4. Check for repetitive sentence openings or transitions across paragraphs.
5. Confirm no experience, test, or result was invented anywhere.
6. Read it back mentally \u2014 if any line sounds like presentation copy or a banned phrase from EDITORIAL_RULES, rewrite it.
7. Trim about 10% of the word count if you can do it without losing anything a reader actually needs.

Return JSON matching this schema exactly:
{
  "title": "", "alternative_titles": ["",""], "slug": "kebab-case-slug",
  "dek": "", "meta_description": "", "quick_answer": "1-2 sentence direct answer if the topic has one, else empty string",
  "introduction": "markdown, no more than 100 words",
  "sections": [{"id":"s1","heading":"descriptive, never generic like \\"Getting Started\\" or \\"Final Thoughts\\"","body_markdown":"","tools":[{"name":"","url":"","description":"","strengths":["..."],"limitations":["..."]}]}],
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
// Only fixes count + aspect ratio per slot \u2014 which specific editorial
// role (hero/explainer/comparison/workflow/list-support) each slot gets
// is now the model's call, based on what this specific article actually
// needs, not a fixed position-based template applied regardless of
// content. See IMAGE_BRIEF_SYSTEM's variety requirements below.
function buildImagePrompts(article, imageCount) {
  // No longer pins aspect ratio to position \u2014 the model chooses per
  // image below, since a wide multi-element flow/comparison diagram
  // needs landscape room regardless of which slot it lands in, and
  // forcing it into a square previously caused real clipped-content
  // failures (text labels cut off at the frame edges on a 3-step
  // workflow diagram squeezed into 1:1).
  return Array.from({ length: imageCount }, (_, i) => ({ id: `img${i + 1}` }));
}

const IMAGE_BRIEF_SYSTEM = `You create image briefs for a dailyblip guide, one per required slot. ${EDITORIAL_RULES.split("\n")[0]}

Do not write generic blog-art prompts. Each image must have a clear editorial function (hero, explainer, comparison, workflow, or ranked-list support) and feel custom-made for this specific article, not like generic AI stock photography.

For EACH image, ground it in this article's real content (its actual sections, tools, examples) \u2014 never something that could apply to any article on this general topic.

VARIETY, across the full set of images for this article: don't make them all the same type. At least one image should help explain a process or workflow if the article describes one. If this is a comparison or ranked-list article, at least one image should visually organize the choices (not just illustrate one of them). The first slot is the hero; treat the remaining slots as genuinely different editorial jobs from each other and from the hero, not three variations on one idea.

ASPECT RATIO: choose per image, based on its actual content \u2014 don't default to square out of habit. A wide left-to-right flow (workflow steps, before/after, a row of compared items) needs landscape room; a single focused subject can suit square; a tall stacked list can suit portrait. Squeezing a genuinely horizontal composition into a square frame is exactly what causes text and elements to get clipped at the edges \u2014 pick the shape the content actually needs. Must be one of: "16:9" (landscape), "1:1" (square), or "9:16" (portrait).

MARGINS: every element and every text label needs real breathing room from the frame edge \u2014 nothing should touch or extend past the border, especially the outermost elements in a left-to-right or top-to-bottom sequence. If a composition has items at both ends (like a flow diagram's first and last step), explicitly build in margin around those end labels rather than letting the layout run edge-to-edge.

STYLE: editorial illustration, diagrammatic visuals, annotated product-style layouts, or conceptual composition \u2014 not stock photography, not vague "AI imagery." Clean, high-contrast, modern, web-editorial. Should look designed, not merely generated. Should be able to stand alone on social media as well as inside the article.

AVOID across every image: random floating interfaces, generic futuristic aesthetics, people staring at screens unless essential to the concept, random robots, glowing AI brains, holograms, watermarks, celebrity likenesses, copyrighted characters, unapproved company logos, fabricated product screenshots, near-duplicate compositions across the set. Any text inside the image should be minimal, used only when it strengthens clarity \u2014 never the article headline. Leave negative space where HTML text may be placed afterward, and keep that negative space clear of any element that would otherwise get clipped by it.

Return JSON: {"images": [{
  "id": "img1",
  "role": "hero | explainer | comparison | workflow | list-support",
  "aspect_ratio": "16:9 | 1:1 | 9:16",
  "concept": "the core visual idea in one sentence",
  "purpose": "what this image should teach or communicate to the reader",
  "composition": "how it's laid out \u2014 framing, focal point, arrangement, with explicit margin around edge elements",
  "key_elements": "the specific objects/elements that should appear",
  "style": "visual style, restated for this specific image",
  "color_mood": "color palette and mood",
  "avoid": "anything specifically worth avoiding for THIS image, beyond the general list above",
  "prompt": "the exact, complete image-generation prompt, incorporating all of the above into one usable prompt, including an explicit instruction that all elements and text stay within a safe margin and nothing is cropped at the frame edge",
  "alt_text": "",
  "caption": "",
  "placement": "which section this illustrates, by section id, or \\"hero\\""
}]}
One entry per requested image. JSON only.`;

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
    prompt: JSON.stringify({ slots, article_type: job.submitted.article_type, article_title: job.article.title, sections: sectionPreviews }),
    // Raised from 4000 \u2014 the richer 9-field-per-image brief (role,
    // concept, purpose, composition, key_elements, style, color_mood,
    // avoid, prompt) needs more room than the old 4-field version this
    // was originally sized for. Ceiling costs nothing unless hit.
    maxTokens: 6000,
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
    try {
      // Driven by the model's own per-image aspect_ratio choice now,
      // not slot position \u2014 gpt-image-1 only accepts these three sizes.
      const size = b.aspect_ratio === "16:9" ? "1536x1024" : b.aspect_ratio === "9:16" ? "1024x1536" : "1024x1024";
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
        // Kept for admin review context (what this image is FOR, not
        // just what its raw prompt says) even though the published page
        // itself only needs alt_text/caption/placement.
        role: b.role, concept: b.concept, purpose: b.purpose, aspect_ratio: b.aspect_ratio,
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
