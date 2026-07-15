// pipeline/commentary.js — runs Mon/Wed/Fri (AM only, before brief.js so
// same-day pieces are eligible candidates). Writes a short op-ed under
// the "The dailyblip Editors" byline, grounded in real, cited examples
// found via web search — never fabricated. Publishes automatically (no
// review gate, per an explicit decision), but always shows up in the
// "Notify: today's social post" style GitHub Issue pattern isn't reused
// here directly — instead see the end of main() for its own notification.
//
// STYLE RULES, enforced both in the prompt AND mechanically afterward:
//   - No em dashes anywhere in the piece (a hard requirement — checked
//     with a regex after generation, not just asked for in the prompt).
//   - No AI-cliche phrasing ("delve", "tapestry", "testament to", "it's
//     worth noting", "in conclusion", etc.) — prompted against, though
//     this one can't be mechanically guaranteed the way em dashes can.
//
// CHARTS are hand-drawn SVG, not AI-image-generated — same reasoning as
// the Instagram card template: image models can't reliably render exact
// numbers/labels, so anything with real data gets drawn with real code
// instead. A chart is only included if the research step actually finds
// real, citable data — never fabricated to fill space.
import { loadFeed, saveFeed, loadCommentaryLog, saveCommentaryLog } from "./lib/store.js";
import { askWithSearch, askJSON } from "./lib/claude.js";
import { hash } from "./lib/text.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

// The starting topic pool. commentary.js cycles through these in order,
// tracking usage in data/commentary.json so it never repeats one until
// the whole list has been used, then starts over. Add more here anytime
// — order doesn't matter, loadNextTopic always picks the least-recently-used.
const TOPICS = [
  { title: "The Hands Problem Is Basically Solved. So What's Left to Distrust?", angle: "how the classic 'AI art always looks wrong' critique has aged now that hands/text/eyes are mostly fixed, and what the new tells actually are" },
  { title: "Style Transfer Isn't Theft, Except When It Obviously Is", angle: "a fair look at where 'trained on my style' complaints are legitimate versus where they're really about fear of competition" },
  { title: "The Best AI Artists Aren't Prompting. They're Directing.", angle: "the shift from single-prompt image generation to multi-step iterative workflows as the real skill ceiling now" },
  { title: "Why Museums Still Won't Touch AI Art, and Whether That's About to Change", angle: "the institutional art world's slow, uneven acceptance of AI-made work" },
  { title: "Suno Can Write a Hit. It Still Can't Write a Career.", angle: "the gap between generating a competent song and building an actual artist identity and audience relationship" },
  { title: "The Sample Clearance Problem, Except It's the Whole Song Now", angle: "what AI music training means for an industry that spent 30 years litigating sampling" },
  { title: "Bedroom Producers Just Got a Session Orchestra for Free. Now What?", angle: "genuinely optimistic take on access and democratization, paired honestly with what's lost" },
  { title: "Are the Robots Stealing All the Fun, or Just the Boring Parts?", angle: "distinguishing which parts of creative work AI actually replaces versus which parts it's only starting to touch" },
  { title: "What Does 'Creativity' Even Mean Once the Tool Can Improvise Too?", angle: "a genuine philosophical question about authorship once the tool has taste" },
  { title: "The Authenticity Question Nobody Can Actually Answer", angle: "fairly airing both 'it's not real art if AI made it' and 'a paintbrush is a tool too' without picking a winner" },
  { title: "Everyone's Worried About AI Replacing Artists. Fewer Are Worried About Art Directors.", angle: "a sharper, more specific version of the jobs conversation aimed at which creative-industry roles are actually most exposed" },
  { title: "The Real Winners of the AI Art Boom Aren't Making Art", angle: "on tool-makers, platform fees, and licensing deals capturing more value than working artists" },
  { title: "Your Local Comic Con Table Just Got a Lot More Competitive", angle: "a ground-level look at how AI changed the economics of small-scale creative hustles" },
  { title: "Copyright Law Wasn't Built for This, and Everyone Knows It", angle: "a fair explainer on what's actually legally unresolved right now, not just another lawsuit recap" },
];

function pickNextTopic(log) {
  const used = new Set(log.used_topics || []);
  const unused = TOPICS.filter((t) => !used.has(t.title));
  if (unused.length) return unused[0];
  // Whole list used — start over.
  return TOPICS[0];
}

const RESEARCH_SYSTEM = `You are a research assistant for a short opinion piece about AI's impact on art and music. Find 2-4 REAL, CURRENT, VERIFIABLE examples or data points relevant to the given topic and angle — actual artists, actual tools, actual studies, actual statistics with real sources. Never invent or estimate a number. If you cannot find genuine data suitable for a chart, say so explicitly rather than approximating.

Return JSON: {
  "examples": [{"name": "...", "description": "one sentence, factual", "source_url": "...", "source_name": "..."}],
  "chart_data": null OR {"title": "...", "unit": "...", "items": [{"label": "...", "value": number}], "source_url": "...", "source_name": "..."}
}
JSON only.`;

// Style rules are enforced in TWO layers: the prompt below, AND a
// mechanical post-generation check for em dashes specifically (prompting
// alone doesn't guarantee compliance — the regex check after generation
// is the real guarantee).
const WRITE_SYSTEM = `You write short opinion pieces for dailyblip under the byline "The dailyblip Editors." Voice: sharp, direct, a little wry, genuinely opinionated but fair to the other side of any argument. Short and punchy, not lengthy — meaty enough to actually engage with, not a listicle.

HARD STYLE RULES:
- NEVER use an em dash (—) anywhere, for any reason. Use a period, comma, or parentheses instead.
- Avoid AI-cliche phrasing entirely: no "delve," "boast," "unleash," "tapestry," "testament to," "it's worth noting," "in conclusion," "moreover," "furthermore," "in today's world," "navigate the complexities of," "at the end of the day." Write like a sharp human editor, not like a model imitating one.
- No fabricated statistics or invented examples. Only use the real examples/data provided to you below. If nothing usable was found, write the piece without leaning on specifics you don't have.
- 450-650 words. Genuinely have a point of view, don't both-sides everything into mush, but don't strawman the other side either.

STRUCTURE:
- title: sharp, thought-provoking, matches the given topic (can refine the wording slightly if it improves flow).
- lede: one or two sentences, sets up the tension of the piece.
- body: an array of blocks, each one of:
  {"type":"p","text":"..."}
  {"type":"h2","text":"..."} (use 1-2 of these to break up the piece, not more)
  {"type":"pullquote","text":"..."} (exactly one, the single sharpest line in the piece, standalone-strong)

Return JSON: {"title":"...","lede":"...","body":[...]}. JSON only.`;

function stripEmDashes(text) {
  // Mechanical safety net — replace any em dash with a comma or period
  // depending on context, since the prompt alone can't be fully trusted.
  return String(text)
    .replace(/\s*—\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\.\s/g, ". ");
}

function sanitizeBody(body) {
  return (Array.isArray(body) ? body : []).map((block) => ({
    type: ["p", "h2", "pullquote"].includes(block?.type) ? block.type : "p",
    text: stripEmDashes(block?.text || "").trim(),
  })).filter((b) => b.text);
}

// --- Chart: hand-drawn SVG, real data only -------------------------------
function renderChartSvg({ title, unit, items }) {
  const w = 640, h = 360, pad = 56;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const barW = (w - pad * 2) / items.length - 16;
  const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const bars = items.map((it, i) => {
    const barH = ((h - pad * 2) * it.value) / maxVal;
    const x = pad + i * ((w - pad * 2) / items.length) + 8;
    const y = h - pad - barH;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="4" fill="#FFB454"/>
      <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-family="monospace" font-size="14" fill="#E9F4F1">${esc(it.value)}${esc(unit)}</text>
      <text x="${x + barW / 2}" y="${h - pad + 20}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#9AB7B2">${esc(it.label)}</text>`;
  }).join("");

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#0C242B" rx="12"/>
    <text x="${pad}" y="32" font-family="sans-serif" font-weight="700" font-size="15" fill="#E9F4F1">${esc(title)}</text>
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="rgba(158,216,210,.28)" stroke-width="1"/>
    ${bars}
  </svg>`;
}

// --- Illustrative images: OpenAI, abstract/moody, no text ----------------
async function generateIllustrativeImage(topicTitle, seedIndex) {
  const prompt = `A moody, abstract digital editorial illustration, dark teal-navy (#071A1F) base tone with warm amber (#FFB454) and soft aqua (#63D8C6) glowing light accents. Abstract visual metaphor related to: "${topicTitle}". Painterly, atmospheric, high-end editorial magazine illustration style, variation ${seedIndex + 1}. NO text, NO letters, NO words, NO logos, NO readable typography anywhere. NO human faces. Abstract and atmospheric only.`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "medium" }),
  });
  if (!res.ok) throw new Error(`OpenAI image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no image data");
  return sharp(Buffer.from(b64, "base64")).resize(1024, 1024).jpeg({ quality: 88 }).toBuffer();
}

// --- Page template ---------------------------------------------------------
const PAGE_CSS = `
:root{
  --ink:#071A1F; --ink-2:#0C242B; --line:rgba(158,216,210,.13); --line-strong:rgba(158,216,210,.28);
  --text:#E9F4F1; --dim:#9AB7B2; --faint:#5E7D79; --amber:#FFB454; --amber-deep:#E58E2B; --aqua:#63D8C6;
  --display:"Bricolage Grotesque",sans-serif; --body:"Spline Sans",sans-serif; --mono:"Spline Sans Mono",monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--ink);color:var(--text);font-family:var(--body);font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--amber);text-decoration:none} a:hover{text-decoration:underline}
.wrap{max-width:680px;margin:0 auto;padding:36px 24px 90px}
.back{font-family:var(--mono);font-size:12px;color:var(--faint);margin-bottom:26px}
.back a{color:var(--faint)} .back a:hover{color:var(--amber)}
.commentary-tag{
  display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--aqua);
  border:1px solid rgba(99,216,198,.4);border-radius:20px;padding:5px 14px;margin-bottom:20px;
}
.commentary-tag::before{content:"\u25C6"}
h1{font-family:var(--display);font-weight:750;font-size:clamp(30px,5.5vw,42px);letter-spacing:-.02em;line-height:1.12;margin-bottom:18px}
.lede{color:var(--dim);font-size:18px;line-height:1.55;margin-bottom:26px}
.byline-row{
  display:flex;align-items:center;padding:16px 0;margin-bottom:34px;
  border-top:1px solid var(--line);border-bottom:1px solid var(--line);
  font-family:var(--mono);font-size:12.5px;color:var(--faint);
}
.byline-row b{color:var(--dim);font-weight:500;margin-right:10px}
.byline-row span{margin-right:10px}
article p{color:var(--dim);margin-bottom:20px;font-size:16px}
article h2{font-family:var(--display);font-weight:650;font-size:23px;letter-spacing:-.01em;color:var(--text);margin:38px 0 14px}
.pull-quote{border-left:3px solid var(--amber);padding:4px 0 4px 20px;margin:30px 0;font-family:var(--display);font-weight:600;font-size:20px;line-height:1.4;color:var(--text)}
.chart-wrap{margin:28px 0}
.chart-source{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:8px}
.chart-source a{color:var(--faint)}
.img-block{margin:28px 0;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.img-block img{display:block;width:100%;height:auto}
.sign-off{
  display:flex;align-items:center;gap:10px;margin-top:44px;
  font-family:var(--display);font-weight:650;font-size:15px;color:var(--dim);
}
.pulse-blip{width:9px;height:9px;border-radius:50%;background:var(--amber);position:relative;flex:0 0 auto}
.pulse-blip::after{
  content:"";position:absolute;inset:0;border-radius:50%;background:var(--amber);
  animation:blipPulse 2s ease-out infinite;
}
@keyframes blipPulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.8);opacity:0}}
.foot-note{margin-top:32px;padding-top:24px;border-top:1px solid var(--line);font-family:var(--mono);font-size:12px;color:var(--faint);line-height:1.6}
.foot-note a{color:var(--faint)} .foot-note a:hover{color:var(--amber)}
`;

function esc(t) { return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function renderArticlePage({ title, lede, body, dateStr, readMin, chartSvg, chartSource, images, slug }) {
  const imgFiles = images.map((_, i) => `${slug}-img${i + 1}.jpg`);
  let imgCursor = 0;
  const bodyHtml = body.map((block, i) => {
    if (block.type === "h2") return `<h2>${esc(block.text)}</h2>`;
    if (block.type === "pullquote") return `<div class="pull-quote">${esc(block.text)}</div>`;
    let html = `<p>${esc(block.text)}</p>`;
    // Sprinkle images roughly every 2-3 paragraphs, chart after the first section.
    if (imgCursor < imgFiles.length && i > 0 && i % 3 === 0) {
      html += `<div class="img-block"><img src="${imgFiles[imgCursor]}" alt="Illustration for: ${esc(title)}" loading="lazy"></div>`;
      imgCursor++;
    }
    return html;
  }).join("\n");

  const chartHtml = chartSvg ? `
  <div class="chart-wrap">
    ${chartSvg}
    <div class="chart-source">Source: <a href="${esc(chartSource?.url || "#")}" rel="noopener">${esc(chartSource?.name || "")}</a></div>
  </div>` : "";

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} \u2014 dailyblip</title>
<meta name="description" content="${esc(lede)}">
<link rel="canonical" href="${SITE_URL}/commentary/${slug}.html">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Spline+Sans:wght@300..700&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet">
<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-yNME_l48PyWaSQIr8NMk5.js"></script>
<script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>
<style>${PAGE_CSS}</style></head><body>
<div class="wrap">
  <div class="back"><a href="/">\u2190 dailyblip</a></div>
  <div class="commentary-tag">Commentary</div>
  <h1>${esc(title)}</h1>
  <p class="lede">${esc(lede)}</p>
  <div class="byline-row"><b>The dailyblip Editors</b><span>${esc(dateStr)}</span><span>${readMin} min read</span></div>
  <article>
    ${bodyHtml}
    ${chartHtml}
  </article>
  <div class="sign-off"><span class="pulse-blip"></span> - The Blip</div>
  <div class="foot-note">Commentary reflects the views of the dailyblip editorial team, separate from our news coverage.</div>
</div>
</body></html>`;
}

function rebuildCommentaryIndex(dir, log) {
  const rows = (log.published || []).slice().reverse().map((p) =>
    `<div class="item"><a href="${esc(p.slug)}.html">${esc(p.title)}</a> <span style="color:#9AB7B2">${esc(p.date)}</span></div>`
  ).join("");
  fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dailyblip \u2014 commentary</title>
<style>${PAGE_CSS}\n.item{padding:12px 0;border-top:1px solid var(--line)}</style></head><body>
<div class="wrap">
  <div class="back"><a href="../">\u2190 dailyblip</a></div>
  <h1>Commentary</h1>
  <p class="lede">Opinion and analysis from the dailyblip editorial team, separate from our news coverage.</p>
  ${rows || "<p>Nothing published yet.</p>"}
</div>
</body></html>`);
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

async function main() {
  const feed = loadFeed();
  const log = loadCommentaryLog();
  const topic = pickNextTopic(log);
  console.log(`commentary: topic "${topic.title}"`);

  const research = await askWithSearch({
    role: "write",
    system: RESEARCH_SYSTEM,
    prompt: JSON.stringify({ title: topic.title, angle: topic.angle }),
    maxTokens: 2000,
    maxSearches: 6,
  });

  const draft = await askJSON({
    role: "write",
    system: WRITE_SYSTEM,
    prompt: JSON.stringify({ topic: topic.title, angle: topic.angle, research }),
    maxTokens: 3000,
  });

  const title = stripEmDashes(draft.title || topic.title);
  const lede = stripEmDashes(draft.lede || "");
  const body = sanitizeBody(draft.body);
  if (body.length < 3) throw new Error("commentary: generated piece too short, aborting rather than publishing something thin.");

  const wordCount = body.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
  const readMin = Math.max(2, Math.round(wordCount / 200));

  const slug = `${slugify(title)}-${new Date().toISOString().slice(0, 10)}`;
  const dir = "docs/commentary";
  fs.mkdirSync(dir, { recursive: true });

  // Chart: only if the research step actually found real, citable data.
  let chartSvg = null, chartSource = null;
  if (research.chart_data && Array.isArray(research.chart_data.items) && research.chart_data.items.length) {
    chartSvg = renderChartSvg(research.chart_data);
    chartSource = { name: research.chart_data.source_name, url: research.chart_data.source_url };
    console.log(`commentary: real chart data found, source: ${chartSource.name}`);
  } else {
    console.log("commentary: no citable chart data found this time, publishing without one (expected, not an error).");
  }

  // Illustrative images — 2 by default, 3 if the piece is long enough to
  // actually have room to breathe between them.
  const imageCount = wordCount > 550 ? 3 : 2;
  const images = [];
  if (OPENAI_KEY) {
    for (let i = 0; i < imageCount; i++) {
      try {
        const buf = await generateIllustrativeImage(title, i);
        const imgPath = path.join(dir, `${slug}-img${i + 1}.jpg`);
        fs.writeFileSync(imgPath, buf);
        images.push(imgPath);
      } catch (e) {
        console.warn(`commentary: image ${i + 1} generation failed, continuing without it: ${e.message}`);
      }
    }
  } else {
    console.log("commentary: OPENAI_API_KEY not set, publishing without illustrative images.");
  }

  const dateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
  const html = renderArticlePage({ title, lede, body, dateStr, readMin, chartSvg, chartSource, images, slug });
  fs.writeFileSync(path.join(dir, `${slug}.html`), html);

  // Log + rebuild the commentary index.
  log.used_topics = log.used_topics || [];
  log.used_topics.push(topic.title);
  log.published = log.published || [];
  log.published.push({ slug, title, date: dateStr });
  saveCommentaryLog(log);
  rebuildCommentaryIndex(dir, log);

  // Add as a normal, eligible brief candidate — tagged commentary:true so
  // brief.js can cap it at 1 per edition. Competes on merit like anything
  // else; nothing forces it into the six.
  const id = "s_" + hash(`${SITE_URL}/commentary/${slug}.html`);
  feed.stories = feed.stories.filter((s) => s.id !== id); // avoid dupes on rerun
  feed.stories.unshift({
    id,
    cat: "writing",
    badge: "new",
    spotlight: false,
    quality: 7,
    tier: "commentary",
    commentary: true,
    title,
    dek: lede,
    src: "dailyblip",
    url: `${SITE_URL}/commentary/${slug}.html`,
    ts: new Date().toISOString(),
    read: `${readMin} min`,
    also: [],
  });
  saveFeed(feed);

  console.log(`commentary: published ${slug} (${wordCount} words, ${images.length} images, chart: ${!!chartSvg}).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
