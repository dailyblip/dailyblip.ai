// pipeline/rebuild-homepage.js — bakes real, crawlable content into
// docs/index.html: the day's actual H1, brief items, top stories, and
// featured guides. See pipeline/lib/homepage.js for what this
// deliberately does and doesn't touch.
//
// Run after daily.yml updates feed.json (so the homepage reflects the
// latest brief without waiting on a separate manual step), and
// available as its own on-demand rebuild via admin.html, for the same
// reason rebuild-guide-library.js exists: picking up a template change
// without needing a fresh daily run first.
import fs from "node:fs";
import { loadFeed } from "./lib/store.js";
import { bakeHomepage } from "./lib/homepage.js";

const INDEX_PATH = "docs/index.html";
const MANIFEST_PATH = "docs/data/guides-manifest.json";

function loadGuidesManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return []; // no manifest yet -- guides feature section just won't get baked in, not a crash
  }
}

function main() {
  const feed = loadFeed();
  if (!feed || !Array.isArray(feed.stories)) {
    console.log("rebuild-homepage: no feed.json data available yet, nothing to bake in.");
    return;
  }
  const guidesManifest = loadGuidesManifest();
  const currentHtml = fs.readFileSync(INDEX_PATH, "utf8");

  const { html: bakedHtml, notes } = bakeHomepage(currentHtml, feed, guidesManifest);
  fs.writeFileSync(INDEX_PATH, bakedHtml);

  console.log(`rebuild-homepage: baked in ${feed.stories.length} stories, ${feed.brief?.items?.length || 0} brief items, ${guidesManifest.length} guide(s) available for the featured section.`);
  if (notes.length) {
    console.log("Notes:");
    for (const n of notes) console.log(`  - ${n}`);
  }
}

main();
