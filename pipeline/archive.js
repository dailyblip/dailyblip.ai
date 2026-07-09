// pipeline/archive.js — runs daily after brief.js. The compounding layer:
// writes an immutable snapshot of each day (JSON + HTML permalink), rebuilds
// the archive index, and surfaces "one year ago today" back into the feed.
import fs from "node:fs";
import path from "node:path";
import { loadFeed, saveFeed, PATHS } from "./lib/store.js";
import { sanitizeInlineB } from "./lib/sanitize.js";

const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dayKey = (d = new Date()) =>
  d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD

const PAGE_CSS = `
  body{background:#071A1F;color:#E9F4F1;font-family:"Spline Sans",-apple-system,sans-serif;
    max-width:760px;margin:0 auto;padding:40px 24px;line-height:1.55}
  a{color:#FFB454;text-decoration:none} a:hover{text-decoration:underline}
  h1{font-size:26px;letter-spacing:-.02em} h2{font-size:15px;letter-spacing:.14em;
    text-transform:uppercase;color:#5E7D79;margin:34px 0 12px;font-weight:500}
  .item{padding:12px 0;border-top:1px solid rgba(158,216,210,.13)}
  .item b{color:#FFB454} .meta{font-size:12px;color:#5E7D79;font-family:monospace;margin-top:4px}
  .story{margin:14px 0} .story h3{font-size:16px;margin-bottom:3px}
  .story p{color:#9AB7B2;font-size:14px} .spot{color:#63D8C6;font-size:11px;letter-spacing:.1em}
  .back{font-family:monospace;font-size:12px;color:#5E7D79}`;

function renderDayPage(snap) {
  const briefItems = (snap.brief?.items || [])
    .map((it, i) => `<div class="item"><span style="color:#E58E2B">${i + 1}.</span> ${sanitizeInlineB(it.html)}</div>`)
    .join("");
  const stories = (snap.stories || [])
    .map((s) => `<div class="story">${s.spotlight ? '<div class="spot">✦ CREATOR SPOTLIGHT</div>' : ""}
      <h3><a href="${esc(s.url || "#")}" rel="noopener">${esc(s.title)}</a></h3>
      <p>${esc(s.dek)}</p><div class="meta">${esc(s.cat)} · via ${esc(s.src)}</div></div>`)
    .join("");
  const tool = snap.tooldrop
    ? `<h2>Tool drop</h2><div class="story"><h3>${esc(snap.tooldrop.name)}</h3><p>${esc(snap.tooldrop.blurb)}</p></div>`
    : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Daily Blip — ${esc(snap.date)}</title><style>${PAGE_CSS}</style></head><body>
<p class="back"><a href="./">← archive</a> · <a href="../">dailyblip</a></p>
<h1>${esc(snap.brief?.title || `The Daily Blip — ${snap.date}`)}</h1>
<p class="meta">Issue ${esc(snap.issue)} · ${esc(snap.date)}</p>
<h2>The brief</h2>${briefItems || "<p>No brief this day.</p>"}
${tool}
<h2>The feed that day</h2>${stories}
</body></html>`;
}

function rebuildIndex(dir) {
  const days = fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort()
    .reverse();
  const rows = days.map((d) => {
    let title = "";
    try { title = JSON.parse(fs.readFileSync(path.join(dir, d + ".json"), "utf8")).brief?.title || ""; } catch {}
    return `<div class="item"><a href="${d}.html">${d}</a> <span style="color:#9AB7B2">${esc(title)}</span></div>`;
  }).join("");
  fs.writeFileSync(path.join(dir, "index.html"),
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dailyblip — archive</title><style>${PAGE_CSS}</style></head><body>
<p class="back"><a href="../">← dailyblip</a></p>
<h1>The Blip archive</h1><p class="meta">${days.length} issues and counting</p>${rows}
</body></html>`);
}

async function main() {
  const feed = loadFeed();
  const dir = PATHS.archiveDir;
  fs.mkdirSync(dir, { recursive: true });

  const today = dayKey();
  const dayMs = 26 * 3600 * 1000;
  const snap = {
    date: today,
    issue: feed.issue,
    brief: feed.brief,
    tooldrop: feed.tooldrop,
    stories: feed.stories.filter((s) => Date.now() - new Date(s.ts) < dayMs),
    stats: feed.stats,
  };

  // Immutable: never overwrite a past day; today's file may be rewritten
  // (reruns of the workflow just refresh today's snapshot).
  fs.writeFileSync(path.join(dir, `${today}.json`), JSON.stringify(snap, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, `${today}.html`), renderDayPage(snap));
  rebuildIndex(dir);

  // "One year ago today" — starts lighting up automatically in year two.
  const lastYear = new Date();
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  const yaKey = dayKey(lastYear);
  const yaFile = path.join(dir, `${yaKey}.json`);
  if (fs.existsSync(yaFile)) {
    try {
      const ya = JSON.parse(fs.readFileSync(yaFile, "utf8"));
      const topStory = (ya.stories || []).find((s) => s.top) || (ya.stories || [])[0];
      feed.yearago = {
        date: yaKey,
        title: topStory?.title || ya.brief?.title || "",
        href: `archive/${yaKey}.html`,
      };
    } catch { delete feed.yearago; }
  } else {
    delete feed.yearago;
  }

  saveFeed(feed);
  console.log(`archive: wrote ${today}, index rebuilt${feed.yearago ? ", year-ago panel set" : ""}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
