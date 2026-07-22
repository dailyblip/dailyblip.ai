// pipeline/retrofit-guides.js — regenerates every published guide through
// the current renderPage() template, so already-live guides pick up
// whatever's been added since they were first published (currently:
// article-level prompts support, related-guide links, and any future
// template changes) without waiting for someone to manually edit each
// file's HTML by hand.
//
// Two very different situations per guide, handled differently:
//   - Pipeline-generated guides: their full article data (every section,
//     takeaway, everything) is still sitting in data/guides.json. These
//     re-render cleanly from that stored data.
//   - Backfilled guides (registered through admin.html's "Add a
//     backfilled guide" form): their job records only ever stored
//     minimal metadata -- title, slug, dek, tags, hero image. Their full
//     section content exists nowhere in structured form except the
//     already-rendered HTML itself. For these, parse-guide-html.js
//     reconstructs the article object by parsing that HTML back apart.
//
// Safety-first: never overwrites a file the parser isn't confident
// about. A guide gets skipped (original file left untouched) if parsing
// reports any problems, or if the re-rendered word count differs
// drastically from the original -- a strong signal something was lost
// in translation. Every guide's outcome (rebuilt / skipped / failed,
// and why) goes into a report so nothing here is a silent black box.
import fs from "node:fs";
import path from "node:path";
import { loadGuides } from "./lib/store.js";
import { buildGuidesManifest, writeGuidesManifest, rebuildGuidesIndex, renderPage } from "./guide-publish.js";
import { writeSitemap } from "./lib/sitemap.js";
import { rebuildTopicHubs } from "./lib/topic-hubs.js";
import { parseGuideHtml } from "./lib/parse-guide-html.js";

const GUIDES_DIR = "docs/guides";
const ARCHIVE_DIR = "docs/archive";
const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

function wordCount(s) {
  return String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function hasFullArticleData(job) {
  return Array.isArray(job.article?.sections) && job.article.sections.length > 0
    && typeof job.article.introduction === "string" && job.article.introduction.length > 0;
}

function main() {
  const guides = loadGuides();
  const published = guides.filter((g) => g.status === "published" && g.article?.slug);
  const manifest = buildGuidesManifest(guides); // used for related-guide computation, same as a real publish

  const report = { rebuilt: [], skipped: [], failed: [] };

  for (const job of published) {
    const slug = job.article.slug;
    const filePath = path.join(GUIDES_DIR, `${slug}.html`);
    if (!fs.existsSync(filePath)) {
      report.failed.push({ slug, reason: "no existing HTML file found at expected path" });
      continue;
    }
    const originalHtml = fs.readFileSync(filePath, "utf8");
    const originalWords = wordCount(originalHtml.replace(/<[^>]+>/g, " "));

    let renderJob;
    let source;

    if (hasFullArticleData(job)) {
      // Pipeline-generated: full data already in hand, nothing to parse.
      renderJob = job;
      source = "stored data";
    } else {
      // Backfilled: reconstruct from the already-rendered HTML.
      const { article: parsed, heroImage, problems } = parseGuideHtml(originalHtml, slug);
      if (!parsed || problems.length) {
        report.skipped.push({ slug, reason: `parse had ${problems.length} problem(s): ${problems.join("; ")}` });
        continue;
      }
      renderJob = {
        article: parsed,
        images: heroImage ? [{ id: "hero", placement: "hero", file: heroImage.file, approved: true, alt_text: heroImage.alt_text }] : [],
        sources: job.sources || [],
      };
      source = "reconstructed from HTML";
    }

    let newHtml;
    try {
      newHtml = renderPage(renderJob, manifest);
    } catch (e) {
      report.failed.push({ slug, reason: `renderPage threw: ${e.message}` });
      continue;
    }

    const newWords = wordCount(newHtml.replace(/<[^>]+>/g, " "));
    // A guide whose rebuilt word count differs by more than 25% from the
    // original is treated as suspicious rather than trusted blindly --
    // that's a much bigger swing than the new sections (related-guides,
    // etc.) would account for on their own, and more likely means
    // something was lost in parsing.
    const wordDelta = originalWords > 0 ? Math.abs(newWords - originalWords) / originalWords : 1;
    if (wordDelta > 0.25) {
      report.skipped.push({ slug, reason: `word count changed by ${(wordDelta * 100).toFixed(0)}% (${originalWords} -> ${newWords}) -- too large a swing to trust automatically` });
      continue;
    }

    fs.writeFileSync(filePath, newHtml);
    report.rebuilt.push({ slug, source, originalWords, newWords });
  }

  // Refresh the library, sitemap, and topic hubs once, after all
  // individual guides are done -- same as a real publish would. Wrapped
  // separately from the per-guide loop: if any of this throws, the
  // report below still needs to get written regardless, since it's the
  // primary way to diagnose what happened. Without this, a failure here
  // would silently skip the report entirely, which is exactly what
  // produced a confusing downstream "file not found" error from the
  // workflow's own commit step instead of a clear one from this script.
  let libraryRebuildError = null;
  try {
    writeGuidesManifest(manifest);
    const populatedHubs = rebuildTopicHubs(GUIDES_DIR, manifest, SITE_URL);
    rebuildGuidesIndex(GUIDES_DIR, manifest, populatedHubs);
    writeSitemap({ archiveDir: ARCHIVE_DIR, guidesDir: GUIDES_DIR, siteUrl: SITE_URL, outDir: "docs", populatedHubs });
  } catch (e) {
    libraryRebuildError = e.message;
  }

  const reportPath = "data/retrofit-report.json";
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ ran_at: new Date().toISOString(), library_rebuild_error: libraryRebuildError, ...report }, null, 2) + "\n");

  console.log(`\nretrofit-guides: ${report.rebuilt.length} rebuilt, ${report.skipped.length} skipped, ${report.failed.length} failed.`);
  if (libraryRebuildError) console.log(`\n\u26a0 Library/sitemap/hub rebuild failed AFTER guides were processed: ${libraryRebuildError}`);
  console.log(`Full report written to ${reportPath}.\n`);
  if (report.rebuilt.length) {
    console.log("Rebuilt:");
    for (const r of report.rebuilt) console.log(`  ${r.slug} (${r.source}, ${r.originalWords} -> ${r.newWords} words)`);
  }
  if (report.skipped.length) {
    console.log("\nSkipped (original file left untouched):");
    for (const r of report.skipped) console.log(`  ${r.slug}: ${r.reason}`);
  }
  if (report.failed.length) {
    console.log("\nFailed:");
    for (const r of report.failed) console.log(`  ${r.slug}: ${r.reason}`);
  }
}

main();
