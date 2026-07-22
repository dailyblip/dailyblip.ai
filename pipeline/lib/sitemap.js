// pipeline/lib/sitemap.js — builds sitemap.xml by scanning the actual
// files on disk (archive day pages, guide pages) rather than trusting
// any single data source's record-keeping. Originally lived inline in
// archive.js, which meant it only ever regenerated on the twice-daily
// pipeline run — a guide registered through admin.html mid-day wouldn't
// show up in the sitemap until the next run, up to ~12 hours later.
// Extracted here so rebuild-guide-library.js (which already fires
// automatically on every admin manifest edit) can call the exact same
// logic immediately, without duplicating it and risking drift between
// two copies.
import fs from "node:fs";
import path from "node:path";

export function buildSitemap({ archiveDir, guidesDir, siteUrl, populatedHubs }) {
  const site = siteUrl || process.env.SITE_URL || "https://dailyblip.ai";
  const days = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    : [];
  const guides = fs.existsSync(guidesDir)
    ? fs.readdirSync(guidesDir).filter((f) => f.endsWith(".html") && f !== "index.html")
    : [];
  const urls = [
    `${site}/`, `${site}/showcase.html`, `${site}/standards.html`, `${site}/archive/`, `${site}/guides/`,
    ...days.map((d) => `${site}/archive/${d}`),
    ...guides.map((g) => `${site}/guides/${g}`),
    // Only ever included once populated -- an empty hub already carries
    // its own noindex tag, but leaving it out of the sitemap too is a
    // second, belt-and-suspenders guard against a thin page getting
    // found and judged before it has real content. Caller computes this
    // list via topic-hubs.js's rebuildTopicHubs() and passes it straight
    // in, rather than this function triggering hub generation itself as
    // a hidden side effect.
    ...(populatedHubs || []).map((h) => `${site}/guides/topics/${h.slug}.html`),
  ].map((u) => `  <url><loc>${u}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function writeSitemap({ archiveDir, guidesDir, siteUrl, outDir, populatedHubs }) {
  const xml = buildSitemap({ archiveDir, guidesDir, siteUrl, populatedHubs });
  fs.writeFileSync(path.join(outDir, "sitemap.xml"), xml);
}
