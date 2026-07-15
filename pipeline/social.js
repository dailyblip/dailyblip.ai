// pipeline/social.js — generates today's Instagram-ready image + caption
// from the brief's #1 impact story. Runs BEFORE the "Commit" step in
// daily.yml (deliberately) so the generated file gets swept into the same
// commit as everything else — the separate social-notify.js step runs
// AFTER commit+push, so by the time it references the image's live URL,
// that URL has actually had a chance to go live. Splitting generate/notify
// across the commit boundary avoids shipping a GitHub Issue with a broken
// image link, the same class of "referenced something before it existed"
// problem we spent a while chasing with the sitemap CDN this week.
//
// SETUP REQUIRED (one-time):
//   1. Add OPENAI_API_KEY as a GitHub repo secret.
//   2. OpenAI's GPT Image models require "Organization Verification" in
//      your OpenAI developer console (platform.openai.com -> org settings)
//      before the API will actually work — if this fails with an auth or
//      permission-looking error, that's almost certainly why, not a bug
//      in this script.
//   3. Costs real money per image (small — a few cents at current
//      pricing — but non-zero, and ongoing since this runs daily).
//
// GRACEFUL DEGRADATION: if OPENAI_API_KEY isn't set, this skips cleanly
// (same pattern as BUTTONDOWN_API_KEY being optional) rather than failing
// the whole workflow.
import { loadFeed } from "./lib/store.js";
import { askJSON } from "./lib/claude.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Brand palette — matches the rest of the site exactly.
const TEXT = "#E9F4F1";
const AMBER = "#FFB454";
const RED = "#FF7A6B"; // breaking-story accent, same logic as the card template
const DARKTXT = "#20160a";

function pickTopStory(feed) {
  const items = feed.brief?.items || [];
  if (!items.length) return null;
  const top = [...items].sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0))[0];
  const story = feed.stories.find((s) => s.id === top.story);
  return story ? { story, briefItem: top } : null;
}

// Abstract, moody backgrounds — deliberately NOT asking the model to render
// any text. Image models are unreliable at legible embedded text; real text
// gets drawn afterward with real fonts via the SVG overlay instead.
const MOOD_BY_CATEGORY = {
  image: "flowing abstract light trails suggesting digital image generation, soft painterly gradients",
  video: "abstract motion-blur light streaks suggesting film and video editing, cinematic depth",
  music: "abstract soundwave and particle visualization, rhythmic flowing shapes",
  writing: "abstract flowing typographic ribbons and soft paper-like textures, literary mood",
  tools: "abstract geometric interface fragments, soft glowing panels suggesting software tools",
  rights: "abstract scales-of-justice inspired geometric shapes, formal and serious mood",
  industry: "abstract circuitry and network node patterns suggesting technology infrastructure",
};

async function generateBackgroundImage(story) {
  const mood = MOOD_BY_CATEGORY[story.cat] || MOOD_BY_CATEGORY.industry;
  const prompt = `A moody, abstract digital background, dark teal-navy (#071A1F) base tone with warm amber (#FFB454) and soft aqua (#63D8C6) glowing light accents. ${mood}. Cinematic, atmospheric, high-end tech-editorial style. NO text, NO letters, NO words, NO logos, NO readable typography anywhere in the image. NO human faces. Abstract and atmospheric only, safe for a professional news brand.`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "medium" }),
  });
  if (!res.ok) throw new Error(`OpenAI image API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no image data");
  return Buffer.from(b64, "base64");
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = (cur + " " + w).trim();
    if (test.length <= maxCharsPerLine) cur = test;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4); // never let a headline overflow the card
}

function esc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Overlays the same "split-screen amber block" template already tested and
// approved for the site's card design — badge-aware accent color (red for
// breaking, amber otherwise), same as that template.
async function overlayBrand(bgBuffer, story) {
  const size = 1024;
  const splitY = Math.round(size * 0.70);
  const accent = story.badge === "breaking" ? RED : AMBER;
  const pad = 70;

  const headlineLines = wrapText(story.title, 26);
  const lineHeight = 58;
  const textBlockHeight = headlineLines.length * lineHeight;
  const textStartY = Math.round((splitY - pad * 1.9 - textBlockHeight) / 2 + pad * 1.7);
  const headlineTspans = headlineLines
    .map((line, i) => `<tspan x="${pad}" y="${textStartY + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");

  const categoryLabel = story.badge === "breaking" ? "BREAKING" : story.badge === "hot" ? "TRENDING" : story.cat.toUpperCase();

  const svg = `
  <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        .wm { font: 700 32px sans-serif; fill: ${TEXT}; }
        .wmAI { font: 700 32px sans-serif; fill: ${accent}; }
        .tag { font: 700 20px sans-serif; }
        .headline { font: 700 44px sans-serif; fill: ${TEXT}; }
        .src { font: 700 30px sans-serif; fill: ${DARKTXT}; }
        .sub { font: 700 20px sans-serif; fill: rgba(32,22,10,.75); }
      </style>
    </defs>
    <rect x="0" y="${splitY}" width="${size}" height="${size - splitY}" fill="${accent}"/>
    <text x="${pad}" y="${pad + 30}"><tspan class="wm">d</tspan><tspan class="wmAI">ai</tspan><tspan class="wm">lyblip</tspan></text>
    <circle cx="${pad + 210}" cy="${pad + 20}" r="7" fill="${accent}"/>
    <rect x="${size - pad - 180}" y="${pad - 6}" width="180" height="42" rx="18" fill="${accent}"/>
    <text x="${size - pad - 160}" y="${pad + 22}" class="tag" fill="${DARKTXT}">${esc(categoryLabel)}</text>
    <text class="headline">${headlineTspans}</text>
    <text x="${pad}" y="${splitY + (size - splitY) * 0.45}" class="src">via ${esc(story.src)}</text>
    <text x="${pad}" y="${splitY + (size - splitY) * 0.45 + 34}" class="sub">dailyblip.ai \u2192 today's signal</text>
  </svg>`;

  return sharp(bgBuffer).resize(size, size).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

const CAPTION_SYSTEM = `You write Instagram captions for dailyblip, a ruthlessly-curated, zero-slop AI-creator news brand. Voice: punchy and energetic — hype in ENERGY and PACING, never in exaggeration or clickbait. No "THIS CHANGES EVERYTHING" breathlessness, no fake urgency, no emoji spam (0-2 tasteful emoji max). Confident, sharp, a little fun — still credible, this is a serious publication with personality, not a hype account.

Structure: 2-4 short lines of caption text, then a blank line, then 4-6 relevant hashtags (mix of broad AI/creator tags and specific ones tied to the story — no spam tags, no more than 6 total).

Return JSON: {"caption": "..."}. JSON only.`;

async function writeCaption(story) {
  const result = await askJSON({
    role: "write",
    system: CAPTION_SYSTEM,
    prompt: JSON.stringify({ headline: story.title, dek: story.dek, source: story.src, category: story.cat, badge: story.badge }),
    maxTokens: 400,
  });
  return result.caption || "";
}

async function main() {
  if (!OPENAI_KEY) {
    console.log("social: OPENAI_API_KEY not set — skipping (optional feature).");
    return;
  }
  const feed = loadFeed();
  const picked = pickTopStory(feed);
  if (!picked) {
    console.log("social: no brief items to pick from — skipping.");
    return;
  }
  const { story, briefItem } = picked;
  console.log(`social: picked "${story.title.slice(0, 60)}" (impact ${briefItem.impact})`);

  const bg = await generateBackgroundImage(story);
  const finalImage = await overlayBrand(bg, story);
  const caption = await writeCaption(story);

  const dir = "docs/social";
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const imagePath = path.join(dir, `${today}.png`);
  fs.writeFileSync(imagePath, finalImage);

  // Save everything social-notify.js needs, so that step doesn't have to
  // regenerate or re-derive anything — just read this and post it.
  fs.writeFileSync(
    path.join(dir, `${today}.json`),
    JSON.stringify({ date: today, image: `${today}.png`, caption, story: { title: story.title, dek: story.dek, src: story.src, url: story.url } }, null, 2) + "\n"
  );
  console.log(`social: wrote ${imagePath} and ${today}.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
