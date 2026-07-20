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
import fs from "node:fs";

const GUIDES_DIR = "docs/guides";
fs.mkdirSync(GUIDES_DIR, { recursive: true });

const guides = loadGuides();
const manifest = buildGuidesManifest(guides);
writeGuidesManifest(manifest);
rebuildGuidesIndex(GUIDES_DIR);

console.log(`rebuild-guide-library: rebuilt manifest (${manifest.length} published guide(s)) and ${GUIDES_DIR}/index.html`);
