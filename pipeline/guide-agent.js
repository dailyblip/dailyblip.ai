// pipeline/guide-agent.js — the weekly, mostly-autonomous guide
// generation agent. Split into two CLI commands, "start" and "finish",
// rather than one long-running script -- this matters for the same
// reason guide.yml commits after every individual stage rather than
// once at the end: if a stage partway through fails (a flaky API call,
// a rate limit), everything committed so far survives, and a retry
// resumes from there instead of re-running (and re-paying for) stages
// that already succeeded. A single all-in-one script would lose that
// resilience entirely -- a failure on, say, the factcheck stage would
// silently discard the brief/research/draft work already paid for.
//
// The actual pipeline stages themselves (brief/research/draft/
// factcheck/recheck/images/format) are NOT run from here at all -- the
// workflow calls guide.js directly for each one, exactly like guide.yml
// already does for on-demand guides, with its own commit-and-conflict-
// resolve step between each. This file only handles what's genuinely
// new: picking the topic and creating the job ("start"), and the
// post-pipeline work of image comparison, the evergreen scan, and
// series metadata ("finish").
//
// Ends every job at status "ready_for_review", same as a normal
// on-demand guide -- this NEVER auto-publishes. Deliberate: guides make
// concrete technical claims that can be wrong or go stale, unlike
// commentary's opinion pieces, so a human still approves every guide
// before it goes live, agent-generated or not.
import fs from "node:fs";
import { loadGuides, saveGuides } from "./lib/store.js";
import { pickNextTopic, refillTopicsIfNeeded } from "./lib/guide-topics.js";
import { generateComparisonSet } from "./lib/image-comparison.js";
import { scanForVersionLanguage } from "./lib/evergreen-scan.js";
import { askJSON } from "./lib/claude.js";

const AGENT_LOG_PATH = "data/guide-agent-log.json";

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

// Writes a value the calling GitHub Actions workflow can read in later
// steps (e.g. "echo jobId=... >> $GITHUB_OUTPUT" isn't available from
// inside a script directly -- this appends to the file GITHUB_OUTPUT
// itself points at, which is the actual underlying mechanism). Falls
// back to a plain console line when run outside Actions (local testing).
function setActionOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`[output] ${name}=${value}`);
  }
}

async function cmdStart() {
  const log = loadAgentLog();
  const refillResult = await refillTopicsIfNeeded(log);
  if (refillResult.generated) console.log(`guide-agent: topic queue refilled with ${refillResult.generated} new topic(s).`);
  saveAgentLog(log); // persist any newly-generated topics immediately, independent of whether this job later succeeds

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
    // Carried alongside the job, read back by "finish" below -- every
    // stage function in guide.js only ever sets its own specific field
    // (job.article, job.brief, etc.) on the job it's handed, never
    // replaces the object wholesale, so this survives untouched through
    // all seven stages without needing any separate state-passing
    // mechanism between workflow steps beyond the jobId itself.
    agent_topic: {
      id: topic.id, needs_image_comparison: topic.needs_image_comparison,
      series: topic.series, series_part: topic.series_part,
      series_total: topic.series_total, series_title: topic.series_title,
    },
  });
  saveGuides(guides);

  setActionOutput("jobId", jobId);
  console.log(`guide-agent: created job ${jobId}, ready for the pipeline stages to run.`);
}

// Derives one concrete, triable image prompt from the article's actual
// content (mirroring how guide.js's own stageImages grounds prompts in
// real article content, not a generic reading of the topic) -- the
// whole point of the comparison is showing a REAL example a reader
// could reproduce, not an arbitrary illustration.
//
// This deliberately ports the same genericness test guide.js's own
// IMAGE_BRIEF_SYSTEM already uses for hero/section images, rather than
// a thinner, independently-written version of "be specific" -- the
// original version of this prompt only said that, without the concrete
// test to check against, without ever seeing key_takeaways or
// quick_answer (an article's most concrete, specific content, more so
// than section headings), and without any brand-style guidance at all.
// That gap is the most likely explanation for comparison images reading
// as generic even when the individual models executed the prompt fine.
const COMPARISON_PROMPT_SYSTEM = `Given a guide's title, dek, key takeaways, quick answer, and section content, write ONE specific, concrete image-generation prompt that this guide's readers could actually copy and try themselves. It should represent a real, characteristic example of what the guide is teaching, grounded in the article's actual content -- never something that could apply to any other article on this general topic.

Concrete test: if you could swap in a different article on a similar general subject and this prompt would still make sense unchanged, it's too generic -- rewrite it to reference something this SPECIFIC article actually says (a specific tool, technique, or step it actually names). The key takeaways and quick answer are the most concrete, specific things this article says -- lean on them rather than a generic reading of the section headings alone.

Ground the image in dailyblip's actual brand colors: deep ink/navy (#071A1F, #0C242B) as the dominant background, warm amber (#FFB454) as the main accent, aqua/teal (#63D8C6) as a secondary accent -- not a generic tech-blog palette.

Avoid: generic futuristic aesthetics, glowing AI brains, holograms, random floating interfaces, people staring at screens unless essential to the concept, watermarks, any text or labels in the image.

Keep the prompt itself to 1-2 sentences, phrased as an actual image-generation prompt (not a description of one).

Return JSON: {"prompt": "..."}
JSON only.`;

async function deriveComparisonPrompt(article) {
  const sectionPreviews = (article.sections || []).map((s) => ({ heading: s.heading, preview: (s.body_markdown || "").slice(0, 400) }));
  const result = await askJSON({
    role: "write",
    system: COMPARISON_PROMPT_SYSTEM,
    prompt: JSON.stringify({
      title: article.title, dek: article.dek, sections: sectionPreviews,
      key_takeaways: article.key_takeaways || [], quick_answer: article.quick_answer || "",
    }),
    maxTokens: 300,
  });
  return result?.prompt || article.title;
}

async function cmdFinish(jobId) {
  if (!jobId) throw new Error("usage: node pipeline/guide-agent.js finish <jobId>");
  const guides = loadGuides();
  const job = guides.find((g) => g.id === jobId);
  if (!job) throw new Error(`guide-agent: job ${jobId} not found -- did the pipeline stages actually run first?`);
  const topic = job.agent_topic;
  if (!topic) throw new Error(`guide-agent: job ${jobId} has no agent_topic -- was this actually created by "start"?`);

  // Multi-model image comparison -- appended AFTER stageImages() has
  // already run and populated job.images, since that stage resets
  // job.images to an empty array at its own start; anything added
  // before that point would be silently wiped out. By the time "finish"
  // runs (after all 7 pipeline stages, each its own workflow step),
  // that's already long done.
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

  saveGuides(guides.map((g) => (g.id === jobId ? job : g)));

  // Mark the topic used only now, after everything in "finish" has
  // succeeded -- if this throws partway through, the topic stays
  // unmarked and a retry of "finish" (not a whole new job) is the
  // right recovery, so it's deliberately not marked used any earlier
  // than this.
  const log = loadAgentLog();
  log.used_topic_ids = log.used_topic_ids || [];
  if (!log.used_topic_ids.includes(topic.id)) log.used_topic_ids.push(topic.id);
  saveAgentLog(log);

  console.log(`guide-agent: job ${jobId} ready for review.`);
}

async function main() {
  const [, , command, arg] = process.argv;
  if (command === "start") return cmdStart();
  if (command === "finish") return cmdFinish(arg);
  console.error('usage: node pipeline/guide-agent.js <start|finish> [jobId]');
  process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
