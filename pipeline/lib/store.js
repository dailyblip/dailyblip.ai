// lib/store.js — all file IO for the pipeline lives here.
// If you ever outgrow flat JSON (archives, accounts), swap this file for a
// database client; nothing else in the pipeline needs to change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PATHS = {
  feed: path.join(ROOT, "docs", "data", "feed.json"),
  seen: path.join(ROOT, "data", "seen.json"),
  featured: path.join(ROOT, "data", "featured.json"),
  health: path.join(ROOT, "data", "health.json"),
  sources: path.join(ROOT, "pipeline", "sources.json"),
  archiveDir: path.join(ROOT, "docs", "archive"),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
export { readJSON, writeJSON };

export const loadFeed = () =>
  readJSON(PATHS.feed, {
    generated_at: null, issue: 1, brief: null, stories: [],
    models: [], sources: [], topics: [], tooldrop: null, stats: {},
  });
export const saveFeed = (feed) => {
  feed.generated_at = new Date().toISOString();
  writeJSON(PATHS.feed, feed);
};

// seen.json: { "<hash>": "<iso first seen>" } — pruned to 14 days.
export const loadSeen = () => readJSON(PATHS.seen, {});
export const saveSeen = (seen) => {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(seen)) if (new Date(v).getTime() < cutoff) delete seen[k];
  writeJSON(PATHS.seen, seen);
};

// featured.json: [{ name, url, date, alive?, died? }] — tool drop history + graveyard.
export const loadFeatured = () => readJSON(PATHS.featured, []);
export const saveFeatured = (list) => writeJSON(PATHS.featured, list);

// health.json: { "<feed name>": { days: {"YYYY-MM-DD": n}, consecutive_failures: n } }
// The curator reads this to decide which sources are dying.
export const loadHealth = () => readJSON(PATHS.health, {});
export const saveHealth = (health) => {
  const cutoff = Date.now() - 21 * 24 * 3600 * 1000;
  for (const rec of Object.values(health)) {
    for (const day of Object.keys(rec.days || {})) {
      if (new Date(day).getTime() < cutoff) delete rec.days[day];
    }
  }
  writeJSON(PATHS.health, health);
};

export const loadSources = () => readJSON(PATHS.sources, { feeds: [], tool_feeds: [] });
export const saveSources = (s) => writeJSON(PATHS.sources, s);
