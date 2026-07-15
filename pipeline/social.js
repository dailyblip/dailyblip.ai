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
const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

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

// Your art-direction brief, filled in per-story. Asks the model to attempt
// the company's logo itself, best-effort, with explicit permission to
// simply omit it if unsure — image models are inconsistent at exact
// trademarked graphics, so this trades perfect accuracy for simplicity.
// Still forbids other readable text in the generated image, for the same
// reason headlines are drawn separately with real fonts afterward.
function buildImagePrompt(story) {
  return `Generate a striking editorial image for an Instagram news post based on the article and summary below.
ARTICLE: ${story.url}
POST TEXT: ${story.title}

Create a visually bold, high-energy image that communicates the article's central idea immediately, even without accompanying text.

ART DIRECTION:
- Format: vertical 4:5 Instagram image, 1080 x 1350 composition
- Style: premium technology editorial, contemporary digital collage, dramatic advertising photography, and energetic social-media design
- Make the composition vivid, unexpected, and highly scroll-stopping
- Use strong depth, oversized visual elements, dramatic lighting, crisp detail, controlled motion, layered interfaces, and a clear focal point
- Favor one memorable visual metaphor over a collection of generic technology symbols
- The image should feel culturally current and creator-focused, not corporate, sterile, or like generic AI stock art
- Use saturated accent colors, luminous highlights, deep contrast, and dynamic movement while maintaining a polished professional finish
- Include human or creator-centered imagery when it improves the story
- Show recognizable products, devices, interfaces, creative tools, or company-related visual elements that are directly relevant to the article
- Incorporate the featured company's official logo naturally into the scene if you can render it accurately. Do not invent, approximate, misspell, or redesign a company logo — if you're not confident you can render it accurately, simply omit the logo entirely rather than guessing at it.
- Do not include the article publisher's logo
- Do not place headlines, captions, labels, random letters, watermarks, or other readable text inside the image
- Leave purposeful negative space in the upper third and lower portion so headline text and publication branding can be added afterward
- Keep important faces, logos, devices, and focal elements away from the extreme edges
- Avoid robots, glowing brains, circuit-board faces, floating AI letters, generic holograms, handshake imagery, and other overused AI cliches unless they are specifically essential to the article

Before generating, identify:
1. The article's main subject
2. The company or product involved
3. The most visually compelling action or transformation
4. Two or three concrete visual details from the article
5. A bold visual metaphor that communicates the story in under one second

Then create the image using those details. The final result should resemble an original cover image for a sharp, design-forward technology and creator-culture publication.`;
}

async function generateBackgroundImage(story) {
  const prompt = buildImagePrompt(story);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1536", quality: "medium" }),
  });
  if (!res.ok) throw new Error(`OpenAI image API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no image data");
  return Buffer.from(b64, "base64");
}

function wrapText(text, maxCharsPerLine, maxLines = 4) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = (cur + " " + w).trim();
    if (test.length <= maxCharsPerLine) cur = test;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function esc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 1080x1350 (4:5), matching the negative-space zones the image prompt
// itself asks for: wordmark/tag live in the reserved upper-third strip,
// headline + source live in the reserved lower strip — so the overlay
// actually complements the generated image's composition instead of
// fighting it.
const CANVAS_W = 1080, CANVAS_H = 1350;

async function overlayBrand(bgBuffer, story) {
  const accent = story.badge === "breaking" ? RED : AMBER;
  const pad = 64;
  const bottomZoneH = 340; // reserved lower strip, matches the image prompt's negative-space request

  const headlineLines = wrapText(story.title, 24, 4);
  const lineHeight = 46;
  const headlineY = CANVAS_H - bottomZoneH + 60;

  const headlineTspans = headlineLines
    .map((line, i) => `<tspan x="${pad}" y="${headlineY + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");

  const categoryLabel = story.badge === "breaking" ? "BREAKING" : story.badge === "hot" ? "TRENDING" : story.cat.toUpperCase();
  const sourceY = headlineY + headlineLines.length * lineHeight + 36;

  const svg = `
  <svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        .wm { font: 700 34px sans-serif; fill: ${TEXT}; }
        .wmAI { font: 700 34px sans-serif; fill: ${accent}; }
        .tag { font: 700 18px sans-serif; }
        .headline { font: 700 40px sans-serif; fill: ${TEXT}; }
        .src { font: 700 24px sans-serif; fill: ${TEXT}; }
      </style>
    </defs>
    <!-- gradient scrim behind the reserved lower strip, so light headline
         text stays legible over whatever the generated image put there -->
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#071A1F" stop-opacity="0"/>
        <stop offset="35%" stop-color="#071A1F" stop-opacity=".88"/>
        <stop offset="100%" stop-color="#071A1F" stop-opacity=".96"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${CANVAS_H - bottomZoneH - 80}" width="${CANVAS_W}" height="${bottomZoneH + 80}" fill="url(#scrim)"/>

    <!-- wordmark, upper-third reserved zone -->
    <text x="${pad}" y="${pad + 32}"><tspan class="wm">d</tspan><tspan class="wmAI">ai</tspan><tspan class="wm">lyblip</tspan></text>
    <circle cx="${pad + 218}" cy="${pad + 22}" r="7" fill="${accent}"/>

    <!-- category/badge pill, upper-third reserved zone -->
    <rect x="${CANVAS_W - pad - 170}" y="${pad - 4}" width="170" height="40" rx="18" fill="${accent}"/>
    <text x="${CANVAS_W - pad - 148}" y="${pad + 22}" class="tag" fill="${DARKTXT}">${esc(categoryLabel)}</text>

    <!-- headline + source, lower reserved zone -->
    <text class="headline">${headlineTspans}</text>
    <text x="${pad}" y="${sourceY}" class="src">via ${esc(story.src)}</text>
  </svg>`;

  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];

  // fit:"cover" crops-to-fill rather than stretching — matters here since
  // OpenAI's API only offers fixed sizes (1024x1536, a 2:3 ratio) and our
  // actual canvas is 1080x1350 (4:5) — a plain resize would visibly
  // distort the image; cover-crop keeps it looking correct.
  return sharp(bgBuffer).resize(CANVAS_W, CANVAS_H, { fit: "cover" }).composite(layers).png().toBuffer();
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
