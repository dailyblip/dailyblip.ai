// pipeline/lib/topic-hubs.js — generates one crawlable hub page per
// broad topic (not every minor tag), each with a short original intro
// and links to every published guide carrying that tag. Deliberately
// built to handle a tag with zero guides under it right now (Coding,
// ahead of a planned "vibe coding" guide push) without that becoming a
// thin, empty page Google indexes today: an unpopulated hub still gets
// written to disk (so the URL works and is genuinely ready the moment
// a guide is tagged into it), but carries a noindex meta tag and is
// excluded from the sitemap and the library page's topic links until
// it has at least one real guide. Both of those exclusions just check
// guide count at render/build time, so nothing needs to be manually
// flipped on later -- publishing the first guide in a topic is enough.
import fs from "node:fs";
import path from "node:path";

// "Getting Started" is deliberately excluded -- it's a skill-level tag
// that cuts across every topic below, not a subject of its own, so a
// hub for it wouldn't be a coherent "browse this topic" page the way
// these are.
export const HUB_TAGS = [
  "Image Generation", "Video", "AI Music", "Voice", "Writing",
  "Coding", "Tools & Workflow", "Tool Comparison", "Rights & Licensing",
];

const HUB_INTROS = {
  "Image Generation": "Prompting, editing, and getting consistent results out of tools like Midjourney and ChatGPT's image model. Structure, parameters, and the specific choices that separate a usable image from a lucky one.",
  "Video": "Turning a script, a shot list, or a rough idea into finished video with AI tools \u2014 camera direction, pacing, and the workflow choices that keep a generated clip from looking like a generated clip.",
  "AI Music": "Getting an AI music tool like Suno to actually sound like what's in your head \u2014 prompt structure, song arrangement, lyric writing, and using these tools as a collaborator rather than asking them to write the whole thing blind.",
  "Voice": "AI voice and speech tools \u2014 getting natural-sounding narration, voiceover, and spoken delivery out of a model instead of something that reads like a script being read.",
  "Writing": "Using AI as an actual writing partner \u2014 brainstorming, tightening a draft, and getting past the specific ways AI-assisted writing tends to sound generic if you let it.",
  "Coding": "Building with AI-assisted coding tools \u2014 from quick prototypes to real, working software. Guides here focus on getting usable code out of a model, not just impressive-looking demos.",
  "Tools & Workflow": "Putting several AI tools together into an actual working process \u2014 stacking, sequencing, and the practical workflow decisions that matter more than any single tool's feature list.",
  "Tool Comparison": "Direct comparisons between AI tools that do similar jobs \u2014 what each one is actually better at, not just a feature checklist.",
  "Rights & Licensing": "The practical rights and licensing questions that come up once AI-generated work is something you're actually publishing or selling, not just experimenting with.",
};

function slugifyTag(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function esc(t) { return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function renderHubPage({ tag, guides, siteUrl }) {
  const slug = slugifyTag(tag);
  const populated = guides.length > 0;
  const intro = HUB_INTROS[tag] || `Guides tagged ${tag}.`;
  const cardsHtml = guides.map((g) => `
      <a class="guide-card" href="../${esc(g.slug)}.html">
        <div class="guide-thumb">${g.hero_image ? `<img src="${esc(g.hero_image)}" alt="" loading="lazy" onerror="this.parentElement.textContent='no image'">` : "no image"}</div>
        <div class="guide-body">
          <div class="guide-title">${esc(g.title)}</div>
          <div class="guide-dek">${esc(g.dek)}</div>
        </div>
      </a>`).join("");
  const bodyHtml = populated
    ? `<div class="guide-grid">${cardsHtml}</div>`
    : `<div class="empty-state">Guides for this topic are coming soon.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(tag)} Guides \u2014 dailyblip</title>
<meta name="description" content="${esc(intro)}">
<link rel="canonical" href="${siteUrl}/guides/topics/${slug}.html">
${populated ? "" : '<meta name="robots" content="noindex, follow">\n'}<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Spline+Sans:wght@300..700&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#071A1F; --ink-2:#0C242B; --ink-3:#123039;
  --line:rgba(158,216,210,.13); --line-strong:rgba(158,216,210,.28);
  --text:#E9F4F1; --dim:#9AB7B2; --faint:#5E7D79;
  --amber:#FFB454; --amber-deep:#E58E2B; --aqua:#63D8C6;
  --display:"Bricolage Grotesque",sans-serif; --body:"Spline Sans",sans-serif; --mono:"Spline Sans Mono",monospace;
  --radius:10px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--ink);color:var(--text);font-family:var(--body);font-size:15.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
header{max-width:1180px;margin:0 auto;padding:30px 24px 0}
.masthead{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px}
.wordmark{font-family:var(--display);font-weight:750;font-size:clamp(28px,4.5vw,42px);letter-spacing:-.02em}
.wordmark .ai-hl{color:var(--amber)}
.back-link{font-family:var(--mono);font-size:12px;color:var(--faint)}
.back-link:hover{color:var(--amber)}
.tagline{margin-top:6px;color:var(--dim);font-size:14.5px;margin-bottom:22px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.wrap{max-width:1180px;margin:0 auto;padding:26px 24px 80px}
h1{font-family:var(--display);font-weight:750;font-size:clamp(26px,5vw,36px);letter-spacing:-.02em;margin-bottom:12px}
.intro{color:var(--dim);font-size:15.5px;line-height:1.6;max-width:640px;margin-bottom:32px}
.guide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.guide-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--ink-2);transition:border-color .15s ease,transform .15s ease;display:flex;flex-direction:column}
.guide-card:hover{border-color:var(--line-strong);transform:translateY(-2px)}
.guide-thumb{aspect-ratio:16/10;background:linear-gradient(135deg,var(--ink-2),var(--ink-3));display:flex;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);font-size:11px;overflow:hidden}
.guide-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.guide-body{padding:16px 18px;display:flex;flex-direction:column;gap:8px;flex:1}
.guide-title{font-family:var(--display);font-weight:650;font-size:16.5px;line-height:1.3}
.guide-dek{color:var(--dim);font-size:13px;line-height:1.5}
.empty-state{border:1px dashed var(--line-strong);border-radius:10px;padding:40px;text-align:center;color:var(--faint);font-family:var(--mono);font-size:13px}
footer{border-top:1px solid var(--line);margin-top:40px;padding:26px 24px 40px}
.foot-in{max-width:1180px;margin:0 auto;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-family:var(--mono);font-size:12px;color:var(--faint)}
.foot-in a:hover{color:var(--amber)}
.foot-links{display:flex;gap:18px}
</style>
</head>
<body>
<header>
  <div class="masthead">
    <div class="wordmark">d<span class="ai-hl">ai</span>lyblip</div>
    <a href="../../" class="back-link">\u2190 back to dailyblip</a>
  </div>
  <p class="tagline">A ruthlessly curated AI-creator brief \u2014 only the signal, none of the slop.</p>
</header>
<div class="wrap">
  <h1>${esc(tag)}</h1>
  <p class="intro">${esc(intro)}</p>
  ${bodyHtml}
</div>
<footer>
  <div class="foot-in">
    <div>dailyblip // the AI brief for people who make things</div>
    <div class="foot-links"><a href="../">all guides</a><a href="../../showcase.html">showcase</a><a href="../../standards.html">standards</a><a href="../../archive/">archive</a></div>
  </div>
</footer>
</body>
</html>
`;
}

export function rebuildTopicHubs(guidesDir, manifest, siteUrl) {
  const site = siteUrl || "https://dailyblip.ai";
  const hubsDir = path.join(guidesDir, "topics");
  fs.mkdirSync(hubsDir, { recursive: true });

  const populatedSlugs = [];
  for (const tag of HUB_TAGS) {
    const guides = (manifest || [])
      .filter((g) => (g.tags || []).includes(tag))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    const slug = slugifyTag(tag);
    fs.writeFileSync(path.join(hubsDir, `${slug}.html`), renderHubPage({ tag, guides, siteUrl: site }));
    if (guides.length > 0) populatedSlugs.push({ tag, slug });
  }
  return populatedSlugs; // only the populated ones -- for the sitemap and library page to link to
}
