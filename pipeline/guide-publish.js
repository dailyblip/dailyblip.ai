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
  // Alt text is only a hard requirement for AI-generated images, which
  // should always have real alt text written by the model \u2014 a missing
  // one there signals an actual pipeline problem worth blocking on.
  // Uploaded photos have alt text as an explicitly OPTIONAL field (per
  // admin.html's upload form), so they're excluded here rather than
  // silently reversing that decision by blocking on it anyway.
  const missingAlt = selectedImages.filter((img) => img.role !== "upload" && !img.alt_text);
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
.meta-row{font-family:var(--mono);font-size:12px;color:var(--faint);margin-bottom:14px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.page-tags{display:flex;gap:6px;flex-wrap:wrap;margin:-8px 0 24px}
.page-tag-chip{font-family:var(--mono);font-size:10.5px;color:var(--aqua);border:1px solid rgba(99,216,198,.35);border-radius:12px;padding:3px 10px}
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
.ref-table-wrap{overflow-x:auto;margin:22px 0;border:1px solid var(--line-strong);border-radius:10px}
.ref-table{width:100%;border-collapse:collapse;font-size:13px}
.ref-table th{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--amber);text-align:left;padding:10px 14px;background:rgba(255,180,84,.06);border-bottom:1px solid var(--line-strong);white-space:nowrap}
.ref-table td{padding:10px 14px;color:var(--dim);border-bottom:1px solid var(--line);vertical-align:top}
.ref-table tr:last-child td{border-bottom:none}
.ref-table td:first-child{font-family:var(--mono);color:var(--aqua);white-space:nowrap;font-weight:600}
.prompts-block{border:1px solid rgba(99,216,198,.35);border-radius:10px;padding:18px 20px;margin:22px 0;background:rgba(99,216,198,.04)}
.prompts-label{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;color:var(--aqua);margin-bottom:12px}
.prompt-card{margin-bottom:14px}
.prompt-card:last-child{margin-bottom:0}
.prompt-label{font-size:13px;color:var(--dim);margin-bottom:6px}
.prompt-row{display:flex;gap:8px;align-items:flex-start}
.prompt-text{flex:1;display:block;font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--text);background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.prompt-copy{flex:0 0 auto;font-family:var(--mono);font-size:11px;color:var(--aqua);border:1px solid rgba(99,216,198,.4);border-radius:6px;padding:6px 12px;background:none;cursor:pointer;transition:all .15s ease;align-self:flex-start}
.prompt-copy:hover{border-color:var(--aqua);background:rgba(99,216,198,.08)}
.prompt-copy.copied{color:var(--amber);border-color:var(--amber-deep)}
.sources{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.sources summary{cursor:pointer;font-family:var(--display);font-weight:650;font-size:16px;color:var(--text);list-style:revert}
.sources ul{margin-top:12px}
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

function renderTableBlock(table) {
  if (!table || !table.headers || !table.rows || !table.rows.length) return "";
  return `<div class="ref-table-wrap">
    <table class="ref-table">
      <thead><tr>${table.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function renderPromptsBlock(prompts) {
  if (!prompts || !prompts.length) return "";
  return `<div class="prompts-block">
    <div class="prompts-label">PROMPTS TO TRY</div>
    ${prompts.map((p) => `
      <div class="prompt-card">
        <div class="prompt-label">${esc(p.label)}</div>
        <div class="prompt-row">
          <code class="prompt-text">${esc(p.prompt)}</code>
          <button class="prompt-copy" onclick="copyPrompt(this)" data-prompt="${esc(p.prompt)}" type="button">Copy</button>
        </div>
      </div>`).join("")}
  </div>`;
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

// Falls back to the caption, then a generic default, if alt text was
// left blank \u2014 mainly matters for uploads (an explicitly optional
// field), so the published page never ships a literally empty alt=""
// even when someone didn't fill it in.
function altTextOrFallback(img) {
  return img.alt_text || img.caption || "Image related to this guide";
}

function renderPage(job) {
  const a = job.article;
  // Only images explicitly selected via admin.html's checkboxes ever
  // reach the published page \u2014 job.images may hold up to 6 generated
  // candidates, most of which were never meant to be included.
  const images = (job.images || []).filter((img) => img.approved);
  const imageFor = (placement) => images.find((img) => img.placement === placement);

  const heroImg = imageFor("hero");
  const heroHtml = heroImg ? `<div class="img-block"><img src="/guides/${esc(heroImg.file)}" alt="${esc(altTextOrFallback(heroImg))}" loading="lazy">${heroImg.caption ? `<div class="img-caption">${esc(heroImg.caption)}</div>` : ""}</div>` : "";

  const sectionsHtml = (a.sections || []).map((s) => {
    const img = imageFor(s.id);
    const imgHtml = img ? `<div class="img-block"><img src="/guides/${esc(img.file)}" alt="${esc(altTextOrFallback(img))}" loading="lazy">${img.caption ? `<div class="img-caption">${esc(img.caption)}</div>` : ""}</div>` : "";
    const tools = (s.tools || []).map(renderToolCard).join("");
    const prompts = renderPromptsBlock(s.prompts);
    const table = renderTableBlock(s.table);
    return `<div class="section-block">
      <h2>${esc(s.heading)}</h2>
      ${renderSafeMarkdown(s.body_markdown)}
      ${table}
      ${imgHtml}
      ${tools}
      ${prompts}
    </div>`;
  }).join("\n");

  // Article-level prompts (a.prompts), distinct from per-section prompts
  // above -- for when a few "try this" examples belong to the article
  // as a whole rather than to one specific section. Rendered after every
  // section but before key takeaways.
  const articlePrompts = renderPromptsBlock(a.prompts);

  const takeaways = (a.key_takeaways || []).length
    ? `<div class="takeaways"><div class="label">KEY TAKEAWAYS</div><ul>${(a.key_takeaways || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`
    : "";

  const sourcesHtml = (job.sources || []).length
    ? `<details class="sources"><summary>Sources (${job.sources.length})</summary><ul>${(job.sources || []).map((s) =>
        `<li>${esc(s.title)} \u2014 ${esc(s.publisher)}<br><span class="pub">${esc(s.source_type)}${s.is_primary ? " \u00b7 primary source" : ""}${s.url ? ` \u00b7 <a href="${esc(s.url)}" rel="noopener">source</a>` : ""}</span></li>`
      ).join("")}</ul></details>`
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
  ${(a.tags || []).length ? `<div class="page-tags">${a.tags.map((t) => `<span class="page-tag-chip">${esc(t)}</span>`).join("")}</div>` : ""}
  ${a.quick_answer ? `<div class="quick-answer"><div class="label">QUICK ANSWER</div>${renderSafeMarkdown(a.quick_answer)}</div>` : ""}
  ${heroHtml}
  <article>
    ${renderSafeMarkdown(a.introduction)}
    ${sectionsHtml}
    ${renderSafeMarkdown(a.conclusion)}
  </article>
  ${articlePrompts}
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

  <div class="foot-note">Last reviewed ${esc(a.last_reviewed_date)}. Have a correction? <a href="mailto:hello@dailyblip.ai">Tell us</a>.</div>
</div>
<script>
const $ = s => document.querySelector(s);
function copyPrompt(btn){
  const text = btn.dataset.prompt;
  const showCopied = () => {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1800);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(showCopied).catch(() => { btn.textContent = "Copy failed \u2014 select manually"; });
  } else {
    // Fallback for contexts without the Clipboard API (older browsers,
    // non-HTTPS) -- selects the text so the person can copy it manually
    // with their own keyboard shortcut instead of failing silently.
    const range = document.createRange();
    const codeEl = btn.previousElementSibling;
    if (codeEl) {
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    btn.textContent = "Selected \u2014 press Ctrl/Cmd+C";
  }
}
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

// Single shared source of truth for "what guides exist," read by BOTH
// the homepage's guides teaser and this library page itself \u2014 avoids
// maintaining the guide list in two places that could drift apart.
// hero_image is stored root-relative (/guides/<file>) rather than a
// bare filename: this is the exact same lesson already learned once
// from a real production bug (a bare filename only resolves correctly
// if the page displaying it happens to live in the same directory as
// the image, which broke when admin.html \u2014 at the site root \u2014 tried
// to show the same images). Storing it root-relative here means it
// resolves correctly from both docs/index.html (site root) and
// docs/guides/index.html (one level down) without needing to special-
// case either caller.
function buildGuidesManifest(guides) {
  return guides
    .filter((g) => g.status === "published" && g.article)
    .map((g) => {
      const heroImg = (g.images || []).find((img) => img.approved && img.placement === "hero");
      return {
        title: g.article.title,
        slug: g.article.slug,
        dek: g.article.dek,
        hero_image: heroImg ? `/guides/${heroImg.file}` : null,
        published_at: g.published_at || g.article.last_reviewed_date,
        tags: g.article.tags || [],
        pinned: !!g.pinned,
      };
    })
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
}

function writeGuidesManifest(manifest) {
  fs.mkdirSync("docs/data", { recursive: true });
  fs.writeFileSync("docs/data/guides-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

// The real, full library page \u2014 search, tag filtering, sort \u2014 fetching
// the shared manifest at load time rather than having its data baked in
// at rebuild time, so it never goes stale between publishes and matches
// the exact same fetch pattern docs/index.html already uses for
// data/feed.json.
function rebuildGuidesIndex(dir) {
  fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dailyblip \u2014 guide library</title>
<meta name="description" content="Every quick-start guide dailyblip has published, searchable and filterable by topic.">
<link rel="canonical" href="${SITE_URL}/guides/">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Spline+Sans:wght@300..700&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#071A1F; --ink-2:#0C242B; --ink-3:#123039;
  --line:rgba(158,216,210,.13); --line-strong:rgba(158,216,210,.28);
  --text:#E9F4F1; --dim:#9AB7B2; --faint:#5E7D79;
  --amber:#FFB454; --amber-deep:#E58E2B; --aqua:#63D8C6; --red:#FF7A6B;
  --display:"Bricolage Grotesque",sans-serif; --body:"Spline Sans",sans-serif; --mono:"Spline Sans Mono",monospace;
  --radius:10px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--ink);color:var(--text);font-family:var(--body);font-size:15.5px;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{font-family:inherit;color:inherit;background:none;border:none;cursor:pointer}
header{position:relative;z-index:2;max-width:1180px;margin:0 auto;padding:30px 24px 0}
.masthead{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px}
.wordmark{font-family:var(--display);font-weight:750;font-size:clamp(28px,4.5vw,42px);letter-spacing:-.02em;display:flex;align-items:center;gap:2px}
.wordmark .blip-dot{width:.34em;height:.34em;border-radius:50%;background:var(--amber);display:inline-block;margin-left:.18em;
  box-shadow:0 0 0 0 rgba(255,180,84,.6);animation:ping 2.4s ease-out infinite}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(255,180,84,.55)}70%{box-shadow:0 0 0 14px rgba(255,180,84,0)}100%{box-shadow:0 0 0 0 rgba(255,180,84,0)}}
.wordmark .ai-hl{color:var(--amber)}
.back-link{font-family:var(--mono);font-size:12px;color:var(--faint)}
.back-link:hover{color:var(--amber)}
.tagline{margin-top:6px;color:var(--dim);font-size:14.5px;margin-bottom:22px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:26px 24px 80px}
h1{font-family:var(--display);font-weight:750;font-size:clamp(26px,5vw,36px);letter-spacing:-.02em;margin-bottom:8px}
.sub{color:var(--dim);font-size:15px;margin-bottom:26px;max-width:560px}
.controls{display:flex;gap:12px;margin-bottom:22px;flex-wrap:wrap}
.search-box{flex:1;min-width:220px;position:relative;display:flex;align-items:center;gap:8px;
  border:1px solid var(--line);border-radius:8px;padding:0 12px;background:var(--ink-2)}
.search-box input{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:var(--mono);font-size:13px;padding:11px 0}
.search-box input::placeholder{color:var(--faint)}
.search-box svg{opacity:.5;flex-shrink:0}
.sort-select{background:var(--ink-2);border:1px solid var(--line-strong);border-radius:8px;color:var(--text);font-family:var(--mono);font-size:12.5px;padding:0 12px;cursor:pointer}
.tags-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:26px}
.tag-pill{font-family:var(--mono);font-size:11.5px;letter-spacing:.02em;color:var(--dim);
  border:1px solid var(--line-strong);border-radius:20px;padding:7px 14px;cursor:pointer;transition:all .15s ease;background:none}
.tag-pill:hover{border-color:var(--aqua);color:var(--aqua)}
.tag-pill.active{background:rgba(255,180,84,.12);border-color:var(--amber);color:var(--amber)}
.result-count{font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-bottom:16px}
.guide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.guide-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--ink-2);
  transition:border-color .15s ease,transform .15s ease;cursor:pointer;display:flex;flex-direction:column}
.guide-card:hover{border-color:var(--line-strong);transform:translateY(-2px)}
.guide-thumb{aspect-ratio:16/10;background:linear-gradient(135deg,var(--ink-2),var(--ink-3));display:flex;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);font-size:11px;overflow:hidden}
.guide-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.guide-body{padding:16px 18px;display:flex;flex-direction:column;gap:8px;flex:1}
.guide-title{font-family:var(--display);font-weight:650;font-size:16.5px;line-height:1.3}
.guide-dek{color:var(--dim);font-size:13px;line-height:1.5;flex:1}
.guide-meta-row{display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:8px;gap:8px}
.guide-date{font-family:var(--mono);font-size:10.5px;color:var(--faint);white-space:nowrap;flex-shrink:0}
.guide-tags{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.guide-tag-chip{font-family:var(--mono);font-size:9.5px;color:var(--aqua);border:1px solid rgba(99,216,198,.35);border-radius:10px;padding:2px 8px}
.empty-state{text-align:center;padding:60px 20px;color:var(--faint);font-family:var(--mono);font-size:13px}
footer{position:relative;z-index:1;border-top:1px solid var(--line);margin-top:40px;padding:26px 24px 40px}
.foot-in{max-width:1180px;margin:0 auto;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-family:var(--mono);font-size:12px;color:var(--faint)}
.foot-in a:hover{color:var(--amber)}
.foot-links{display:flex;gap:18px}
.blip-sprite{position:fixed;right:18px;bottom:18px;z-index:40}
.blip-sprite-btn{display:block;width:72px;height:88px;padding:0;animation:blipFloat 4.2s ease-in-out infinite;transition:transform .2s ease}
.blip-sprite-btn:hover{animation-play-state:paused;transform:translateY(-4px) scale(1.05)}
.blip-sprite-btn svg{display:block;filter:drop-shadow(0 8px 18px rgba(0,0,0,.4))}
.blip-body,.blip-arm{fill:var(--ink-2);stroke:var(--aqua);stroke-width:1.5}
.blip-antenna{fill:none;stroke:var(--aqua);stroke-width:2.5;stroke-linecap:round}
.blip-antenna-tip{fill:var(--aqua)}
.blip-glow{fill:var(--aqua);opacity:.18}
.blip-eye{fill:var(--amber);stroke:var(--ink-2);stroke-width:1.5;transform-origin:70px 75px;animation:blipBlink 6.5s ease-in-out infinite}
.blip-eye-highlight{fill:var(--text)}
@keyframes blipFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
@keyframes blipBlink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}97%{transform:scaleY(1)}}
@media(prefers-reduced-motion:reduce){.wordmark .blip-dot,.blip-sprite-btn,.blip-eye{animation:none}}
</style>
</head>
<body>
<header>
  <div class="masthead">
    <div class="wordmark">d<span class="ai-hl">ai</span>lyblip<span class="blip-dot" aria-hidden="true"></span></div>
    <a href="../" class="back-link">\u2190 back to dailyblip</a>
  </div>
  <p class="tagline">A ruthlessly curated AI-creator brief \u2014 only the signal, none of the slop.</p>
</header>
<div class="wrap">
  <h1>The Guide Library</h1>
  <p class="sub">Every quick-start guide dailyblip has published, in one place. Search by name, or filter by what you're actually trying to do.</p>
  <div class="controls">
    <div class="search-box">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" id="searchInput" placeholder="Search guides\u2026">
    </div>
    <select class="sort-select" id="sortSelect">
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="az">A \u2192 Z</option>
    </select>
  </div>
  <div class="tags-row" id="tagsRow"></div>
  <div class="result-count" id="resultCount"></div>
  <div class="guide-grid" id="guideGrid"></div>
  <div class="empty-state" id="emptyState" style="display:none">No guides match that search or filter.</div>
</div>
<footer>
  <div class="foot-in">
    <div>dailyblip // the AI brief for people who make things</div>
    <div class="foot-links"><a href="../showcase.html">showcase</a><a href="../standards.html">standards</a><a href="../commentary/">commentary</a><a href="../archive/">archive</a><a href="../feed.xml">rss</a></div>
  </div>
</footer>
<div class="blip-sprite">
  <button class="blip-sprite-btn" id="blipMain" type="button" aria-label="Back to top">
    <svg viewBox="0 0 140 170" width="72" height="88" aria-hidden="true">
      <ellipse class="blip-glow" cx="70" cy="150" rx="34" ry="6"/>
      <path class="blip-antenna" d="M70 40 Q84 18 90 8"/>
      <circle class="blip-antenna-tip" cx="90" cy="8" r="4"/>
      <rect class="blip-body" x="35" y="40" width="70" height="90" rx="35"/>
      <ellipse class="blip-arm" cx="24" cy="95" rx="9" ry="15"/>
      <ellipse class="blip-arm" cx="116" cy="95" rx="9" ry="15"/>
      <circle class="blip-eye" cx="70" cy="75" r="13"/>
      <circle class="blip-eye-highlight" cx="66" cy="71" r="3"/>
    </svg>
  </button>
</div>
<script>
const $ = s => document.querySelector(s);
function esc(t){ const d=document.createElement("div"); d.textContent=t??""; return d.innerHTML; }
let GUIDES = [], activeTag = "All", searchTerm = "", sortMode = "newest";

function renderTags(){
  const allTags = ["All", ...new Set(GUIDES.flatMap(g => g.tags || []))];
  $("#tagsRow").innerHTML = allTags.map(tag =>
    \`<button class="tag-pill \${tag === activeTag ? "active" : ""}" data-tag="\${esc(tag)}">\${esc(tag)}</button>\`
  ).join("");
  document.querySelectorAll(".tag-pill").forEach(btn =>
    btn.addEventListener("click", () => { activeTag = btn.dataset.tag; renderTags(); renderGrid(); })
  );
}

function renderGrid(){
  let results = GUIDES.filter(g => {
    const matchesTag = activeTag === "All" || (g.tags || []).includes(activeTag);
    const matchesSearch = !searchTerm || ((g.title||"") + (g.dek||"")).toLowerCase().includes(searchTerm.toLowerCase());
    return matchesTag && matchesSearch;
  });
  if (sortMode === "newest") results.sort((a,b) => new Date(b.published_at) - new Date(a.published_at));
  if (sortMode === "oldest") results.sort((a,b) => new Date(a.published_at) - new Date(b.published_at));
  if (sortMode === "az") results.sort((a,b) => (a.title||"").localeCompare(b.title||""));

  $("#resultCount").textContent = \`\${results.length} guide\${results.length === 1 ? "" : "s"}\${activeTag !== "All" ? \` tagged "\${esc(activeTag)}"\` : ""}\`;
  $("#emptyState").style.display = results.length ? "none" : "block";
  $("#guideGrid").innerHTML = results.map(g => \`
    <a class="guide-card" href="\${esc(g.slug)}.html">
      <div class="guide-thumb">\${g.hero_image ? \`<img src="\${esc(g.hero_image)}" alt="" loading="lazy" onerror="this.parentElement.textContent='no image'">\` : "no image"}</div>
      <div class="guide-body">
        <div class="guide-title">\${esc(g.title)}</div>
        <div class="guide-dek">\${esc(g.dek)}</div>
        <div class="guide-meta-row">
          <div class="guide-date">\${g.published_at ? new Date(g.published_at).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : ""}</div>
          <div class="guide-tags">\${(g.tags||[]).slice(0,2).map(t => \`<span class="guide-tag-chip">\${esc(t)}</span>\`).join("")}</div>
        </div>
      </div>
    </a>\`).join("");
}

$("#searchInput").addEventListener("input", e => { searchTerm = e.target.value; renderGrid(); });
$("#sortSelect").addEventListener("change", e => { sortMode = e.target.value; renderGrid(); });
$("#blipMain").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

(async function boot(){
  try {
    const res = await fetch("../data/guides-manifest.json", { cache: "no-store" });
    if (res.ok) GUIDES = await res.json();
  } catch { /* no manifest yet (first guide never published) -- empty state handles it */ }
  renderTags();
  renderGrid();
})();
</script>
</body>
</html>
`);
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
  writeGuidesManifest(buildGuidesManifest(updated));
  rebuildGuidesIndex(GUIDES_DIR);

  console.log(`guide-publish: published ${job.article.slug} \u2014 ${job.published_url}`);
}

// Exported so pipeline/rebuild-guide-library.js can reuse the exact same
// manifest/page-template logic rather than duplicating this large
// template in a second place, which would mean fixing bugs in it twice
// forever.
export { buildGuidesManifest, writeGuidesManifest, rebuildGuidesIndex };

// Only runs main() when this file is invoked directly as a CLI script
// (node pipeline/guide-publish.js <jobId>), not when imported by
// another script for its exports \u2014 without this check, importing this
// file would ALSO immediately run main(), which expects a job id
// argument that wouldn't exist in that context and would fail.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
