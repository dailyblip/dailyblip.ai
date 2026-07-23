// pipeline/guide-agent.js — the weekly, mostly-autonomous guide
// generation agent. Ties together the topic queue (lib/guide-topics.js),
// the existing on-demand guide pipeline (guide.js, driven via its CLI,
// unchanged), the multi-model image comparison (lib/image-comparison.js),
// series linking metadata, and the evergreen language scan
// (lib/evergreen-scan.js).
//
// Deliberately reuses guide.js's stage functions via its existing CLI
// rather than importing/refactoring them directly -- guide.js already
// owns job persistence (getJob/saveJob) and is a proven, working
// pipeline; shelling out to it stage by stage means this agent adds
// zero risk of subtly changing behavior that's already correct.
//
// Ends with the job at status "ready_for_review", same as a normal
// on-demand guide -- this NEVER auto-publishes. That's an explicit,
// deliberate choice: guides make concrete technical claims that can be
// wrong or go stale, unlike commentary's opinion pieces, so a human
// still approves every guide before it goes live, agent-generated or not.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { loadGuides, saveGuides } from "./lib/store.js";
import { pickNextTopic, refillTopicsIfNeeded } from "./lib/guide-topics.js";
import { generateComparisonSet } from "./lib/image-comparison.js";
import { scanForVersionLanguage } from "./lib/evergreen-scan.js";
import { askJSON } from "./lib/claude.js";

const AGENT_LOG_PATH = "data/guide-agent-log.json";
const STAGES = ["brief", "research", "draft", "factcheck", "recheck", "images", "format"];

function loadAgentLog() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_LOG_PATH, "utf8"));
  } catch {
    return { used_topic_ids: [], topics: [] }; // first-ever run, pickNextTopic seeds from SEED_TOPICS
  }
}

function saveAgentLog(log) {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(AGENT_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

function newJobId() {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Derives one concrete, triable image prompt from the article's actual
// content (mirroring how guide.js's own stageImages grounds prompts in
// real article content, not a generic reading of the topic) -- the
// whole point of the comparison is showing a REAL example a reader
// could reproduce, not an arbitrary illustration.
const COMPARISON_PROMPT_SYSTEM = `Given a guide's title, dek, and section content, write ONE specific, concrete image-generation prompt that this guide's readers could actually copy and try themselves. It should represent a real, characteristic example of what the guide is teaching -- not a generic illustration of the general topic. Keep it to 1-2 sentences, phrased as an actual image-generation prompt (not a description of one).

Return JSON: {"prompt": "..."}
JSON only.`;

async function deriveComparisonPrompt(article) {
  const sectionPreviews = (article.sections || []).map((s) => ({ heading: s.heading, preview: (s.body_markdown || "").slice(0, 400) }));
  const result = await askJSON({
    role: "write",
    system: COMPARISON_PROMPT_SYSTEM,
    prompt: JSON.stringify({ title: article.title, dek: article.dek, sections: sectionPreviews }),
    maxTokens: 300,
  });
  return result?.prompt || article.title;
}

async function main() {
  const log = loadAgentLog();
  const refillResult = await refillTopicsIfNeeded(log);
  if (refillResult.generated) console.log(`guide-agent: topic queue refilled with ${refillResult.generated} new topic(s).`);

  const topic = pickNextTopic(log);
  console.log(`guide-agent: this week's topic -- "${topic.title}"`);

  const jobId = newJobId();
  const guides = loadGuides();
  guides.push({
    id: jobId,
    status: "queued",
    stage: "Queued",
    created_at: new Date().toISOString(),
    submitted: {
      idea: topic.title,
      article_type: "Practical guide",
      target_length: "Deep dive",
      editorial_notes: topic.angle,
      image_count: topic.needs_image_comparison ? 2 : 3, // fewer normal candidates when the comparison set is doing separate visual work
    },
  });
  saveGuides(guides);

  // Run the existing, proven pipeline stage by stage via its own CLI --
  // see module comment for why this reuses guide.js as-is rather than
  // importing its internals.
  for (const stage of STAGES) {
    console.log(`guide-agent: running stage "${stage}"...`);
    execSync(`node pipeline/guide.js ${stage} ${jobId}`, { stdio: "inherit" });
  }

  // Re-load the job now that all stages have written their results.
  const finishedGuides = loadGuides();
  const job = finishedGuides.find((g) => g.id === jobId);
  if (!job) throw new Error(`guide-agent: job ${jobId} vanished after pipeline stages -- this should never happen.`);

  // Multi-model image comparison -- appended AFTER stageImages() has
  // already run and populated job.images, since that stage resets
  // job.images to an empty array at its own start; anything added
  // before that point would be silently wiped out.
  if (topic.needs_image_comparison) {
    const comparisonPrompt = await deriveComparisonPrompt(job.article);
    console.log(`guide-agent: generating comparison images for prompt: "${comparisonPrompt}"`);
    const results = await generateComparisonSet(comparisonPrompt);
    const dir = "docs/guides";
    fs.mkdirSync(dir, { recursive: true });
    job.images = job.images || [];
    for (const r of results) {
      if (r.buffer) {
        const filename = `${jobId}-cmp-${r.model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`;
        fs.writeFileSync(`${dir}/${filename}`, r.buffer);
        job.images.push({
          id: `cmp-${r.model}`, file: filename, prompt: comparisonPrompt, placement: "comparison",
          alt_text: `${r.model} output for the prompt: ${comparisonPrompt}`, caption: r.model,
          generated_at: new Date().toISOString(), approved: false, role: "comparison", model: r.model,
        });
      } else {
        // Still recorded, not just logged to a console nobody reviewing
        // in admin.html will ever see -- a reviewer should be able to
        // tell "this model failed, here's why" apart from "this model
        // was never attempted," rather than a comparison silently
        // showing up with fewer entries than expected and no indication
        // whether that's by design or a hidden failure.
        console.warn(`guide-agent: comparison image for ${r.model} failed, continuing without it: ${r.error}`);
        job.images.push({
          id: `cmp-${r.model}`, file: null, prompt: comparisonPrompt, placement: "comparison",
          alt_text: "", caption: r.model, approved: false, role: "comparison", model: r.model,
          generation_failed: true, error: r.error,
        });
      }
    }
    // Midjourney placeholder -- no official API exists, so this is a
    // deliberate manual-upload slot rather than a failed generation.
    // file stays null and needs_upload marks it distinctly from a
    // genuine generation failure, so admin.html can show the right
    // message for each case rather than treating both as "broken."
    job.images.push({
      id: "cmp-midjourney", file: null, prompt: comparisonPrompt, placement: "comparison",
      alt_text: "", caption: "Midjourney", approved: false, role: "comparison", model: "Midjourney",
      needs_upload: true,
    });
  }

  // Evergreen scan -- runs on the fully-formatted article (after
  // stageFormat's own em-dash stripping and validation), attached to
  // the job for admin.html to surface during review. Flags only;
  // nothing here is auto-edited.
  job.evergreen_flags = scanForVersionLanguage(job.article);
  if (job.evergreen_flags.length) {
    console.log(`guide-agent: ${job.evergreen_flags.length} version/temporal-language flag(s) for review.`);
  }

  // Series metadata, if this topic is part of one.
  if (topic.series) {
    job.article.series = topic.series;
    job.article.series_part = topic.series_part;
    job.article.series_total = topic.series_total;
    job.article.series_title = topic.series_title;
  }

  const finalGuides = loadGuides().map((g) => (g.id === jobId ? job : g));
  saveGuides(finalGuides);

  // Mark the topic used only now, after everything succeeded -- if
  // anything above threw, the topic stays unused and will simply be
  // picked again next run rather than being silently lost.
  log.used_topic_ids = log.used_topic_ids || [];
  log.used_topic_ids.push(topic.id);
  saveAgentLog(log);

  console.log(`guide-agent: job ${jobId} ready for review -- "${topic.title}".`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
