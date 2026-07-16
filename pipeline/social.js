// pipeline/social.js — generates today's Instagram-ready image + caption
// for EVERY item in the day's 6-point brief (not just the #1 impact
// story), so you get 6 post options to choose from each morning. Runs
// BEFORE the "Commit" step in daily.yml (deliberately) so the generated
// files get swept into the same commit as everything else — the separate
// social-notify.js step runs AFTER commit+push, so by the time it
// references each image's live URL, that URL has actually had a chance
// to go live. Splitting generate/notify across the commit boundary avoids
// shipping a GitHub Issue with broken image links, the same class of
// "referenced something before it existed" problem we spent a while
// chasing with the sitemap CDN this week.
//
// SETUP REQUIRED (one-time):
//   1. Add OPENAI_API_KEY as a GitHub repo secret.
//   2. OpenAI's GPT Image models require "Organization Verification" in
//      your OpenAI developer console (platform.openai.com -> org settings)
//      before the API will actually work — if this fails with an auth or
//      permission-looking error, that's almost certainly why, not a bug
//      in this script.
//   3. Costs real money per image (small — a few cents at current
//      pricing — but non-zero, and now 6x per day since every brief item
//      gets its own image, not just the top story).
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

// Headline font: Anton, a free (SIL Open Font License) Google Font
// explicitly designed as a bold, condensed display/headline face — the
// closest reliable free equivalent to Impact, which is a proprietary
// Microsoft font not available on Linux runners at all. Rather than
// declare font-family:"Impact" and hope fontconfig substitutes something
// reasonable on the actual GitHub Actions runner (untested, unreliable),
// the real font file is fetched once and embedded directly into the SVG
// as base64 — guarantees pixel-identical rendering everywhere, with zero
// dependency on whatever happens to be installed on the runner.
const ANTON_FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf";
const FONT_CACHE_PATH = "/tmp/dailyblip-anton-font.ttf";
let cachedFontBase64 = null;

async function getHeadlineFontBase64() {
  if (cachedFontBase64) return cachedFontBase64;
  try {
    if (fs.existsSync(FONT_CACHE_PATH)) {
      cachedFontBase64 = fs.readFileSync(FONT_CACHE_PATH).toString("base64");
      return cachedFontBase64;
    }
    const res = await fetch(ANTON_FONT_URL);
    if (!res.ok) throw new Error(`font fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(FONT_CACHE_PATH, buf);
    cachedFontBase64 = buf.toString("base64");
    return cachedFontBase64;
  } catch (e) {
    console.warn(`social: couldn't fetch the Anton headline font, falling back to system sans-serif: ${e.message}`);
    return null; // graceful fallback — headline still renders, just in the generic bold sans instead
  }
}

// Brand palette — matches the rest of the site exactly.
const TEXT = "#E9F4F1";
const AMBER = "#FFB454";
const RED = "#FF7A6B"; // breaking-story accent, same logic as the card template
const DARKTXT = "#20160a";

// Blip — dailyblip's mascot. This exact description is locked and reused
// verbatim in every image prompt, since consistency across 6 separate
// image-generation calls a day depends entirely on repeating the same
// physical description every time (the model has no memory of "the
// character" between calls). Wording matches the version that was
// test-rendered and held up consistently across multiple poses/angles
// before being wired into the real pipeline — don't rephrase casually.
const BLIP_CHAR = `A small, cute, non-humanoid companion-robot mascot called "Blip," roughly the size of a house cat. Body is a smooth rounded capsule/pill shape, dark navy-teal (#0C242B) with a thin glowing aqua (#63D8C6) outline. No legs — it hovers, with a soft aqua glow beneath it suggesting it's floating just above the ground. A single circular glowing amber eye (#FFB454) is centered on its face — no other facial features, no mouth, no additional eyes. A thin aqua antenna curves up from the top of its head, ending in a small glowing aqua dot. It has two small stubby rounded arms, same dark navy-teal material as the body. Not gendered, not humanoid, no human anatomy, no clothing.`;

// Returns one {story, briefItem} pair per brief item, in the brief's own
// (already curated/ranked) order — not re-sorted by impact, since "6
// options to post" should mirror the actual brief a reader would see.
function pickAllBriefStories(feed) {
  const items = feed.brief?.items || [];
  const picks = [];
  for (const item of items) {
    const story = feed.stories.find((s) => s.id === item.story);
    if (story) picks.push({ story, briefItem: item });
  }
  return picks;
}

// Your art-direction brief, filled in per-story. Blip (the mascot) is now
// the consistent subject across every image — the story-specific part is
// the ACTION, which is written per-headline by writeContent() below and
// passed in here, not hardcoded per category. A fixed category->prop map
// (camera for "video", headphones for "music") would repeat itself fast;
// letting the model write a specific action tied to the actual headline
// keeps 6-a-day genuinely varied while Blip's physical design stays locked.
function buildImagePrompt(story, blipAction) {
  return `Generate a striking editorial image for an Instagram news post based on the article and summary below, featuring the mascot character described below as the main subject.

ARTICLE: ${story.url}
POST TEXT: ${story.title}

MASCOT CHARACTER (must appear exactly as described, as the main subject of the image):
${BLIP_CHAR}

MASCOT'S ACTION IN THIS IMAGE (story-specific, must be depicted clearly):
${blipAction}

ART DIRECTION:
- Format: vertical 4:5 Instagram image, 1080 x 1350 composition
- Style: premium technology editorial, contemporary digital collage, dramatic advertising photography, and energetic social-media design
- Make the composition vivid, unexpected, and highly scroll-stopping
- Use strong depth, dramatic lighting, crisp detail, controlled motion, layered interfaces, and a clear focal point on Blip
- The image should feel culturally current and creator-focused, not corporate, sterile, or like generic AI stock art
- Use saturated accent colors, luminous highlights, deep contrast, and dynamic movement while maintaining a polished professional finish
- Background/environment should reflect the article's subject (recognizable devices, interfaces, or visual metaphors relevant to the story), but Blip stays the clear focal point, not a small element in a busy scene
- Do not depict any human figures, faces, or hands — Blip is the only character in the scene
- Do not attempt to render any company or product logos
- Do not place headlines, captions, labels, random letters, watermarks, or other readable text inside the image
- Leave purposeful negative space in the upper third and lower portion so headline text and publication branding can be added afterward
- Keep Blip and other focal elements away from the extreme edges

The final result should resemble an original cover image for a sharp, design-forward technology and creator-culture publication, with Blip as its recurring mascot.`;
}

async function generateBackgroundImage(story, blipAction) {
  const prompt = buildImagePrompt(story, blipAction);
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
  // If the headline genuinely needs more lines than the cap allows, mark
  // the last visible line as truncated rather than silently dropping the
  // remaining words with zero indication — same fix already applied to
  // the chart labels earlier.
  if (lines.length > maxLines) {
    const shown = lines.slice(0, maxLines);
    shown[maxLines - 1] = shown[maxLines - 1].replace(/.{0,3}$/, "") + "\u2026";
    return shown;
  }
  return lines;
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
  const pad = 56;
  const antonBase64 = await getHeadlineFontBase64();
  // Embedded directly as a data URI so rendering is identical regardless
  // of what's installed on the runner — if the fetch failed, this is
  // empty and the CSS font stack below falls back to a generic bold
  // sans-serif instead (still readable, just not the Anton look).
  const fontFace = antonBase64
    ? `@font-face { font-family: "AntonHeadline"; src: url(data:font/ttf;base64,${antonBase64}) format("truetype"); }`
    : "";
  // Reserved lower strip sized to fit up to 6 lines of headline at the
  // verified-safe settings below, plus the source line and padding.
  const bottomZoneH = 680;

  // 16 chars/line at 70px bold ALL-CAPS — this was EMPIRICALLY tested by
  // rendering real text against the actual canvas width with visual
  // boundary guides, not estimated from a character-width formula. A
  // first attempt at 84px/19-chars was tried and PROVEN WRONG this way —
  // real rendered lines overflowed straight off the right edge of the
  // canvas, cut off mid-word. 70px/16-chars was then verified the same
  // way and confirmed to fit with real margin. ALL CAPS is deliberate:
  // standard convention for scroll-stopping social news cards. Allowing
  // up to 6 lines (not 4) was necessary for real headline lengths to fit
  // at this bigger size without truncating — tested against 4 real
  // headlines from this project, all now fit in full. NOTE: this
  // character count was verified against the fallback system sans-serif,
  // not the real Anton font (couldn't fetch it in the build sandbox to
  // test against directly) — Anton is condensed, so real headlines
  // should fit AT LEAST this well or better, never worse, but worth a
  // visual sanity check on the first real run either way.
  const headlineLines = wrapText(story.title.toUpperCase(), 16, 6);
  const lineHeight = 78;
  const headlineY = CANVAS_H - bottomZoneH + 90;

  const headlineTspans = headlineLines
    .map((line, i) => `<tspan x="${pad}" y="${headlineY + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");

  const categoryLabel = story.badge === "breaking" ? "BREAKING" : story.badge === "hot" ? "TRENDING" : story.cat.toUpperCase();
  const sourceY = headlineY + headlineLines.length * lineHeight + 44;
  const tagW = 210, tagH = 50;

  const svg = `
  <svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        ${fontFace}
        .wm { font: 700 40px sans-serif; fill: ${TEXT}; }
        .wmAI { font: 700 40px sans-serif; fill: ${accent}; }
        .tag { font: 700 24px sans-serif; }
        .headline { font: 800 70px "AntonHeadline", sans-serif; fill: ${TEXT}; }
        .src { font: 700 32px sans-serif; fill: ${TEXT}; }
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
    <text x="${pad}" y="${pad + 38}"><tspan class="wm">d</tspan><tspan class="wmAI">ai</tspan><tspan class="wm">lyblip</tspan></text>
    <circle cx="${pad + 248}" cy="${pad + 26}" r="8" fill="${accent}"/>

    <!-- category/badge pill, upper-third reserved zone -->
    <rect x="${CANVAS_W - pad - tagW}" y="${pad - 6}" width="${tagW}" height="${tagH}" rx="22" fill="${accent}"/>
    <text x="${CANVAS_W - pad - tagW / 2}" y="${pad + 26}" text-anchor="middle" class="tag" fill="${DARKTXT}">${esc(categoryLabel)}</text>

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

const CONTENT_SYSTEM = `You write two things for dailyblip, a ruthlessly-curated, zero-slop AI-creator news brand, based on one news story: an Instagram caption, and an action description for the brand's mascot, Blip.

BLIP: a small, non-humanoid, capsule-shaped hover-robot with one glowing amber eye and an aqua antenna. Blip appears in every social image as the recurring mascot, performing an action tied to that day's specific story — not a generic pose.

Write "blip_action" as a single vivid sentence (roughly 15-30 words) describing what Blip is physically doing or holding in the image, tied to the SPECIFIC details of this headline — not a generic category prop. Ground it in a concrete detail from the headline/dek (an object, an action, a transformation) rather than an abstract concept. Blip cannot hold, wear, or gesture toward anything that would require rendering readable text, letters, or logos. No other characters, humans, or hands — only Blip.

Examples of the right specificity: for a story about a new open-weight multimodal model, "Blip holds up a glowing, multi-faceted crystal that shifts between text, image, and soundwave patterns as it turns." For a story about a 3D tool adding Gaussian splat support, "Blip reaches out and gently pokes a floating cloud of glowing particles that snap into a 3D shape." Avoid generic fallbacks like "Blip stands next to a laptop" unless the story genuinely has nothing more specific to draw on.

Then write "caption", an Instagram caption. Voice: punchy and energetic — hype in ENERGY and PACING, never in exaggeration or clickbait. No "THIS CHANGES EVERYTHING" breathlessness, no fake urgency, no emoji spam (0-2 tasteful emoji max). Confident, sharp, a little fun — still credible, this is a serious publication with personality, not a hype account.

Caption structure, in this order:
1. 2-3 lines that actually explain the specific story — what happened, grounded in the real headline/dek given to you, not generic hype about AI in general. A reader should understand the actual news from the caption alone, even without opening the image.
2. One explicit, direct line telling people where to go for more: something like "Full story + today's 6-item brief: link in bio" or "Get the full brief every morning: link in bio" — vary the wording naturally, but ALWAYS include a direct, unambiguous instruction to use the bio link. This is not optional and not "mention if it feels natural" — every caption ends with this.
3. A blank line, then 4-6 relevant hashtags (mix of broad AI/creator tags and specific ones tied to the story — no spam tags, no more than 6 total).

Return JSON: {"blip_action": "...", "caption": "..."}. JSON only.`;

async function writeContent(story) {
  const result = await askJSON({
    role: "write",
    system: CONTENT_SYSTEM,
    prompt: JSON.stringify({ headline: story.title, dek: story.dek, source: story.src, category: story.cat, badge: story.badge }),
    maxTokens: 500,
  });
  return {
    blipAction: result.blip_action || "Blip hovers curiously, amber eye glowing, in a softly lit editorial scene.",
    caption: result.caption || "",
  };
}

async function main() {
  if (!OPENAI_KEY) {
    console.log("social: OPENAI_API_KEY not set — skipping (optional feature).");
    return;
  }
  const feed = loadFeed();
  const picks = pickAllBriefStories(feed);
  if (!picks.length) {
    console.log("social: no brief items to pick from — skipping.");
    return;
  }
  console.log(`social: generating ${picks.length} post option(s) from today's brief.`);

  const dir = "docs/social";
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  // Sequential on purpose, not Promise.all — each call is a real charge
  // against OPENAI_API_KEY, and OpenAI's image endpoint rate-limits per
  // org, so firing 6 at once risks 429s more than 6 in a row costs in
  // wall-clock time (a couple extra minutes on a job that runs once a
  // day is a non-issue).
  for (let i = 0; i < picks.length; i++) {
    const { story, briefItem } = picks[i];
    const n = i + 1;
    try {
      console.log(`social: [${n}/${picks.length}] "${story.title.slice(0, 60)}" (impact ${briefItem.impact})`);
      const { blipAction, caption } = await writeContent(story);
      const bg = await generateBackgroundImage(story, blipAction);
      const finalImage = await overlayBrand(bg, story);

      const imageFile = `${today}-${n}.png`;
      fs.writeFileSync(path.join(dir, imageFile), finalImage);

      results.push({
        index: n,
        image: imageFile,
        caption,
        story: { title: story.title, dek: story.dek, src: story.src, url: story.url },
      });
    } catch (e) {
      // One story failing (flaky image gen, transient API error) shouldn't
      // cost you the other 5 options — log it and move on, same
      // graceful-degradation spirit as the missing-API-key skip above.
      console.warn(`social: [${n}/${picks.length}] failed, skipping this one: ${e.message}`);
    }
  }

  if (!results.length) {
    console.log("social: every story failed to generate — nothing written.");
    return;
  }

  // Save everything social-notify.js needs, so that step doesn't have to
  // regenerate or re-derive anything — just read this and post it.
  fs.writeFileSync(
    path.join(dir, `${today}.json`),
    JSON.stringify({ date: today, posts: results }, null, 2) + "\n"
  );
  console.log(`social: wrote ${results.length}/${picks.length} post option(s) to ${dir}/${today}.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
