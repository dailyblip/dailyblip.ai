// lib/text.js — dedupe helpers. No dependencies.
import crypto from "node:crypto";

export const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

// Normalize a URL enough that trackers don't defeat dedupe.
export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|fbclid|gclid|mc_)/i.test(p)) url.searchParams.delete(p);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

const STOP = new Set("a an the of to in on for with and or is are was were as at by from its it this that new says say said".split(" "));

export function titleTokens(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Cluster items whose titles overlap heavily (same event covered by
 * multiple outlets). Returns one representative per cluster — the
 * earliest-published item — with the others' sources noted.
 */
export function dedupeCluster(items, threshold = 0.6) {
  const kept = [];
  for (const item of items) {
    const tokens = titleTokens(item.title);
    const dupOf = kept.find((k) => jaccard(tokens, k._tokens) >= threshold);
    if (dupOf) {
      dupOf.also_covered_by = [...new Set([...(dupOf.also_covered_by || []), item.source])];
      if (new Date(item.published) < new Date(dupOf.published)) {
        // Keep the earlier item's timestamp — first detection wins.
        dupOf.published = item.published;
      }
    } else {
      kept.push({ ...item, _tokens: tokens });
    }
  }
  return kept.map(({ _tokens, ...rest }) => rest);
}
