// pipeline/rebuild-guide-library.js — regenerates docs/data/guides-
// manifest.json and docs/guides/index.html from whatever's currently in
// data/guides.json, without publishing anything new. For when the
// library page's template changes (a CSS fix, say) and needs to reach
// already-published guides, which only happens when something actually
// rebuilds the page — publishing a new guide would do it as a side
// effect, but this exists so that isn't required just to pick up a
// template fix.
//
// Reuses the exact same manifest/rendering functions guide-publish.js
// uses for a real publish, imported rather than duplicated, so there's
// only one copy of that logic to ever fix.
import { loadGuides } from "./lib/store.js";
import { buildGuidesManifest, writeGuidesManifest, rebuildGuidesIndex } from "./guide-publish.js";
import { writeSitemap } from "./lib/sitemap.js";
import fs from "node:fs";

const GUIDES_DIR = "docs/guides";
const ARCHIVE_DIR = "docs/archive";
fs.mkdirSync(GUIDES_DIR, { recursive: true });

const guides = loadGuides();
const manifest = buildGuidesManifest(guides);
writeGuidesManifest(manifest);
rebuildGuidesIndex(GUIDES_DIR, manifest);
// Same fix as the library page itself: a guide registered through
// admin.html shouldn't have to wait for the next daily.yml run (up to
// ~12 hours) just to show up in the sitemap, when this script is
// already firing automatically at exactly the right moment.
writeSitemap({ archiveDir: ARCHIVE_DIR, guidesDir: GUIDES_DIR, siteUrl: process.env.SITE_URL, outDir: "docs" });

console.log(`rebuild-guide-library: rebuilt manifest (${manifest.length} published guide(s)), ${GUIDES_DIR}/index.html, and sitemap.xml`);
