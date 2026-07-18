// pipeline/guide-publish.js — the ONLY step that writes a guide's real,
// public HTML page. Deliberately separate from guide.js and fast/non-AI:
// this is what runs the instant admin.html's Publish button is clicked
// (via its own workflow_dispatch, see guide-publish.yml), so approval
// really does gate publishing rather than publishing happening as a
// side effect of generation finishing. Nothing in guide.js ever writes
// to docs/guides/<slug>.html — only this script does.
//
// Re-validates before writing anything, even though admin.html's Approve
// button should already have blocked unresolved high-severity issues —
// this script doesn't trust that the browser-side gate was actually
// enforced (a stale tab, a manually-crafted dispatch, etc.), so it
// checks again server-side. See validatePrePublish() below.
import { loadGuides, saveGuides } from "./lib/store.js";
import { renderSafeMarkdown } from "./lib/sanitize.js";
import fs from "node:fs";
import path from "node:path";

const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";
// Optional \u2014 not a secret, safe to expose in public HTML (this is
// Brandfetch's public "client ID" model, not an authenticated API key).
// Get one free at brandfetch.com/developers. Logos degrade gracefully
// to text-only tool cards if this isn't set, same pattern as
// OPENAI_API_KEY/BUTTONDOWN_API_KEY being optional elsewhere.
const BRANDFETCH_CLIENT_ID = process.env.BRANDFETCH_CLIENT_ID || "";
const GUIDES_DIR = "docs/guides";

function getJob(jobId) {
  const guides = loadGuides();
  const job = guides.find((g) => g.id === jobId);
  if (!job) throw new Error(`guide-publish.js: no job found with id ${jobId}`);
  return { guides, job };
}

// Section 11 of the original spec, checked here rather than only trusted
// from the browser: single H1 (true by construction, the template only
// ever emits one), unique slug, meta description present, hero image
// present if any images exist, every image has alt text, no obvious
// placeholder text left in, no unresolved high-severity fact-check
// issues, and status must actually be "approved."
function validatePrePublish(job) {
  const problems = [];
  const a = job.article;
  if (job.status !== "approved") problems.push(`job status is "${job.status}", not "approved"`);
  if (!a?.slug || !/^[a-z0-9-]+$/.test(a.slug)) problems.push("missing or invalid slug");
  else if (fs.existsSync(path.join(GUIDES_DIR, `${a.slug}.html`))) problems.push(`slug "${a.slug}" already published — rename before republishing`);
  if (!a?.meta_description) problems.push("missing meta description");
  // Scoped to SELECTED images only (job.images may hold up to 6
  // candidates now, most of which were never checked for inclusion) \u2014
  // an unselected candidate missing alt text, or not being the hero,
  // should never block a publish that doesn't actually use it.
  const selectedImages = (job.images || []).filter((img) => img.approved);
  if (selectedImages.length && !selectedImages.some((img) => img.placement === "hero")) problems.push("no hero-placement image among the SELECTED images");
  const missingAlt = selectedImages.filter((img) => !img.alt_text);
  if (missingAlt.length) problems.push(`${missingAlt.length} selected image(s) missing alt text`);
  const placeholderRe = /\[x\]|\[TODO\]|\[insert|lorem ipsum/i;
  const allText = [a?.introduction, a?.conclusion, ...(a?.sections || []).map((s) => s.body_markdown)].join(" ");
  if (placeholderRe.test(allText)) problems.push("article still contains placeholder text (e.g. \"[x]\")");
  const unresolvedHigh = (job.fact_check?.issues || []).filter((i) => i.severity === "high");
  // The ONLY check an explicit override can skip \u2014 everything else
  // above (slug, meta description, hero image, alt text, placeholder
  // text) stays a hard requirement regardless. admin.html only sets
  // published_despite_warnings after a person has explicitly seen the
  // warnings and checked an acknowledgment box, so this isn't a silent
  // bypass \u2014 but it's still worth a clear log line, since publishing
  // known-unverified claims is exactly the failure mode this whole
  // stage exists to prevent.
  if (unresolvedHigh.length && !job.published_despite_warnings) {
    problems.push(`${unresolvedHigh.length} unresolved high-severity fact-check issue(s)`);
  } else if (unresolvedHigh.length && job.published_despite_warnings) {
    console.warn(`guide-publish: publishing "${a?.slug}" with ${unresolvedHigh.length} unresolved high-severity issue(s) \u2014 explicitly overridden via admin.html.`);
  }
  return problems;
}

const PAGE_CSS = `
:root{
  --ink:#071A1F; --ink-2:#0C242B; --line:rgba(158,216,210,.13); --line-strong:rgba(158,216,210,.28);
  --text:#E9F4F1; --dim:#9AB7B2; --faint:#5E7D79; --amber:#FFB454; --amber-deep:#E58E2B; --aqua:#63D8C6;
  --display:"Bricolage Grotesque",sans-serif; --body:"Spline Sans",sans-serif; --mono:"Spline Sans Mono",monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--ink);color:var(--text);font-family:var(--body);font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--amber);text-decoration:none} a:hover{text-decoration:underline}
.wrap{max-width:720px;margin:0 auto;padding:36px 24px 90px}
.back{font-family:var(--mono);font-size:12px;color:var(--faint);margin-bottom:26px}
.back a{color:var(--faint)} .back a:hover{color:var(--amber)}
.guide-tag{
  display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--amber);
  border:1px solid rgba(255,180,84,.4);border-radius:20px;padding:5px 14px;margin-bottom:20px;
}
h1{font-family:var(--display);font-weight:750;font-size:clamp(28px,5vw,40px);letter-spacing:-.02em;line-height:1.14;margin-bottom:16px}
.dek{color:var(--dim);font-size:18px;line-height:1.55;margin-bottom:22px}
.meta-row{font-family:var(--mono);font-size:12px;color:var(--faint);margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.quick-answer{border:1px solid var(--line-strong);border-radius:10px;padding:18px 20px;margin-bottom:30px;background:rgba(255,180,84,.05)}
.quick-answer .label{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;color:var(--amber-deep);margin-bottom:6px}
article p{color:var(--dim);margin-bottom:18px}
article h2{font-family:var(--display);font-weight:650;font-size:24px;letter-spacing:-.01em;color:var(--text);margin:36px 0 14px}
article h3{font-family:var(--display);font-weight:600;font-size:19px;color:var(--text);margin:26px 0 10px}
article ul{margin:0 0 18px 20px;color:var(--dim)}
article li{margin-bottom:6px}
article b{color:var(--text)} article a{border-bottom:1px solid rgba(255,180,84,.3)} article a:hover{border-bottom-color:var(--amber)}
.section-block{margin:38px 0}
.img-block{margin:26px 0;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.img-block img{display:block;width:100%;height:auto}
.img-caption{font-family:var(--mono);font-size:11.5px;color:var(--faint);padding:8px 2px}
.tool-card{border:1px solid var(--line);border-radius:12px;padding:24px 26px;margin:20px 0;background:rgba(158,216,210,.02)}
.tool-card .name{font-weight:700;font-size:19px;margin-bottom:8px;display:flex;align-items:center;gap:11px}
.tool-logo{width:28px;height:28px;object-fit:contain;border-radius:6px;flex-shrink:0}
.tool-card .desc{color:var(--dim);font-size:15.5px;line-height:1.6;margin-bottom:12px}
.tool-card .sw{font-size:14px;color:var(--faint);line-height:1.7;margin-bottom:6px}
.takeaways{border:1px solid var(--line-strong);border-radius:10px;padding:20px 22px;margin:32px 0}
.takeaways .label{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;color:var(--aqua);margin-bottom:10px}
.takeaways ul{margin:0 0 0 18px;color:var(--dim)}
.methodology{margin-top:40px;padding:16px 18px;border:1px dashed var(--line-strong);border-radius:10px;font-size:13.5px;color:var(--faint);line-height:1.6}
.sources{margin-top:36px;padding-top:24px;border-top:1px solid var(--line)}
.sources h2{margin-top:0}
.sources li{font-size:13.5px;color:var(--dim);padding:8px 0;border-bottom:1px solid var(--line);list-style:none}
.sources .pub{color:var(--faint);font-family:var(--mono);font-size:11px}
.foot-note{margin-top:32px;padding-top:24px;border-top:1px solid var(--line);font-family:var(--mono);font-size:12px;color:var(--faint);line-height:1.6}
.item{padding:12px 0;border-top:1px solid var(--line)}
.top-nudge{font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-bottom:22px}
.top-nudge a{color:var(--amber-deep)}
.subscribe-block{border:1px solid var(--line-strong);border-radius:12px;padding:26px 24px;margin:36px 0;text-align:center}
.subscribe-block h3{font-family:var(--display);font-size:19px;margin-bottom:8px}
.subscribe-block p{color:var(--dim);font-size:14px;margin-bottom:16px}
.sub-form{display:flex;gap:8px;max-width:380px;margin:0 auto;flex-wrap:wrap;justify-content:center}
.sub-form input{flex:1;min-width:200px;background:var(--ink);border:1px solid var(--line-strong);border-radius:8px;padding:11px 13px;color:var(--text);font-family:var(--body);font-size:14px;outline:none}
.sub-form input:focus{border-color:var(--amber-deep)}
.sub-form button{background:var(--amber);color:#20160a;border:none;border-radius:8px;padding:11px 18px;font-weight:700;font-size:14px;cursor:pointer;font-family:var(--body)}
.sub-form button:hover{filter:brightness(1.08)}
.sub-ok{display:none;color:var(--aqua);font-size:13.5px;margin-top:10px}
`;

function esc(t) { return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Extracts a bare domain from a tool's URL for the logo lookup. Returns
// null on anything malformed rather than throwing \u2014 a bad/missing URL
// should just mean "no logo," never a failed publish.
function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function renderToolCard(tool) {
  const strengths = (tool.strengths || []).map(esc).join(" \u00b7 ");
  const limitations = (tool.limitations || []).map(esc).join(" \u00b7 ");
  const domain = tool.url ? domainFromUrl(tool.url) : null;
  // onerror hides the broken-image icon rather than showing one \u2014
  // Brandfetch not having a given brand (a very new or niche tool) is
  // expected sometimes, not an error worth surfacing to readers.
  const logoHtml = (domain && BRANDFETCH_CLIENT_ID)
    ? `<img class="tool-logo" src="https://cdn.brandfetch.io/${esc(domain)}?c=${esc(BRANDFETCH_CLIENT_ID)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  return `<div class="tool-card">
    <div class="name">${logoHtml}${esc(tool.name)}${tool.url ? ` <a href="${esc(tool.url)}" rel="noopener">\u2192</a>` : ""}</div>
    <div class="desc">${esc(tool.description)}</div>
    ${strengths ? `<div class="sw">Strengths: ${strengths}</div>` : ""}
    ${limitations ? `<div class="sw">Limitations: ${limitations}</div>` : ""}
  </div>`;
}

function renderPage(job) {
  const a = job.article;
  // Only images explicitly selected via admin.html's checkboxes ever
  // reach the published page \u2014 job.images may hold up to 6 generated
  // candidates, most of which were never meant to be included.
  const images = (job.images || []).filter((img) => img.approved);
  const imageFor = (placement) => images.find((img) => img.placement === placement);

  const heroImg = imageFor("hero");
  const heroHtml = heroImg ? `<div class="img-block"><img src="/guides/${esc(heroImg.file)}" alt="${esc(heroImg.alt_text)}" loading="lazy">${heroImg.caption ? `<div class="img-caption">${esc(heroImg.caption)}</div>` : ""}</div>` : "";

  const sectionsHtml = (a.sections || []).map((s) => {
    const img = imageFor(s.id);
    const imgHtml = img ? `<div class="img-block"><img src="/guides/${esc(img.file)}" alt="${esc(img.alt_text)}" loading="lazy">${img.caption ? `<div class="img-caption">${esc(img.caption)}</div>` : ""}</div>` : "";
    const tools = (s.tools || []).map(renderToolCard).join("");
    return `<div class="section-block">
      <h2>${esc(s.heading)}</h2>
      ${renderSafeMarkdown(s.body_markdown)}
      ${imgHtml}
      ${tools}
    </div>`;
  }).join("\n");

  const takeaways = (a.key_takeaways || []).length
    ? `<div class="takeaways"><div class="label">KEY TAKEAWAYS</div><ul>${(a.key_takeaways || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`
    : "";

  const sourcesHtml = (job.sources || []).length
    ? `<div class="sources"><h2>Sources</h2><ul>${(job.sources || []).map((s) =>
        `<li>${esc(s.title)} \u2014 ${esc(s.publisher)}<br><span class="pub">${esc(s.source_type)}${s.is_primary ? " \u00b7 primary source" : ""}${s.url ? ` \u00b7 <a href="${esc(s.url)}" rel="noopener">source</a>` : ""}</span></li>`
      ).join("")}</ul></div>`
    : "";

  // Hidden audit trail, visible in page source only \u2014 not shown to
  // readers, but means an override is never invisible even in the
  // published artifact itself, not just buried in data/guides.json.
  const overrideComment = job.published_despite_warnings
    ? `<!-- Published with ${(job.overridden_warnings || []).length} unresolved high-severity fact-check warning(s), explicitly overridden via admin.html on ${esc(job.approved_at || "")}. See data/guides.json job id ${esc(job.id)} for details. -->\n`
    : "";

  return `${overrideComment}<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(a.title)} \u2014 dailyblip</title>
<meta name="description" content="${esc(a.meta_description)}">
<link rel="canonical" href="${SITE_URL}/guides/${esc(a.slug)}.html">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Spline+Sans:wght@300..700&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style></head><body>
<div class="wrap">
  <div class="back"><a href="/">\u2190 dailyblip</a> \u00b7 <a href="./">guides</a></div>
  <div class="top-nudge">Get guides like this by email \u2192 <a href="#subscribe">subscribe below</a></div>
  <div class="guide-tag">Guide</div>
  <h1>${esc(a.title)}</h1>
  <p class="dek">${esc(a.dek)}</p>
  <div class="meta-row">Last reviewed ${esc(a.last_reviewed_date)}</div>
  ${a.quick_answer ? `<div class="quick-answer"><div class="label">QUICK ANSWER</div>${renderSafeMarkdown(a.quick_answer)}</div>` : ""}
  ${heroHtml}
  <article>
    ${renderSafeMarkdown(a.introduction)}
    ${sectionsHtml}
    ${renderSafeMarkdown(a.conclusion)}
  </article>
  ${takeaways}
  <div class="subscribe-block" id="subscribe">
    <h3>Enjoyed this? Get the next one.</h3>
    <p>One email, 6am daily. What changed in your creative stack, nothing else.</p>
    <form class="sub-form" id="subForm" data-buttondown="">
      <input type="email" id="subEmail" name="email" placeholder="you@work.com" aria-label="Email address" required>
      <button type="submit">Subscribe</button>
    </form>
    <div class="sub-ok" id="subOk">\u2713 You're on the list.</div>
  </div>
  ${sourcesHtml}
  <div class="methodology"><b style="color:var(--text)">Methodology:</b> ${esc(a.methodology_disclosure)}</div>
  <div class="foot-note">Last reviewed ${esc(a.last_reviewed_date)}. Have a correction? <a href="mailto:hello@dailyblip.ai">Tell us</a>.</div>
</div>
<script>
const $ = s => document.querySelector(s);
$("#subForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#subEmail").value;
  if (!email || !email.includes("@")) return;
  const user = $("#subForm").dataset.buttondown;
  if (user) {
    try {
      await fetch(\`https://buttondown.com/api/emails/embed-subscribe/\${user}\`, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }),
      });
    } catch {}
  }
  $("#subForm").style.display = "none";
  $("#subOk").style.display = "block";
});
</script>
</body></html>`;
}

function rebuildGuidesIndex(dir, guides) {
  const published = guides.filter((g) => g.status === "published").slice().reverse();
  const rows = published.map((g) =>
    `<div class="item"><a href="${esc(g.article.slug)}.html">${esc(g.article.title)}</a> <span style="color:#9AB7B2">${esc(g.article.last_reviewed_date)}</span></div>`
  ).join("");
  fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dailyblip \u2014 guides</title>
<style>${PAGE_CSS}</style></head><body>
<div class="wrap">
  <div class="back"><a href="../">\u2190 dailyblip</a></div>
  <h1>Guides</h1>
  <p class="dek">Practical, evergreen guides for AI-assisted creators.</p>
  ${rows || "<p>Nothing published yet.</p>"}
</div>
</body></html>`);
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) { console.error("usage: node pipeline/guide-publish.js <jobId>"); process.exit(1); }

  fs.mkdirSync(GUIDES_DIR, { recursive: true });
  const { guides, job } = getJob(jobId);

  const problems = validatePrePublish(job);
  if (problems.length) {
    job.status = "failed";
    job.error = { stage: "publish", message: `Pre-publish validation failed: ${problems.join("; ")}`, at: new Date().toISOString() };
    saveGuides(guides.map((g) => (g.id === jobId ? job : g)));
    throw new Error(job.error.message);
  }

  fs.writeFileSync(path.join(GUIDES_DIR, `${job.article.slug}.html`), renderPage(job));

  job.status = "published";
  job.stage = "Published";
  job.published_at = new Date().toISOString();
  job.published_url = `${SITE_URL}/guides/${job.article.slug}.html`;
  const updated = guides.map((g) => (g.id === jobId ? job : g));
  saveGuides(updated);
  rebuildGuidesIndex(GUIDES_DIR, updated);

  console.log(`guide-publish: published ${job.article.slug} \u2014 ${job.published_url}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
