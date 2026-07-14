// lib/sanitize.js — publish gates for model-generated content.
// The brief's html field is the only model output rendered as HTML anywhere
// on the site, and it is only ever allowed to contain <b> tags. Everything
// else — including anything a hostile RSS item tried to inject — is escaped.

export function sanitizeInlineB(html) {
  const escaped = String(html ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/&lt;(\/?)b&gt;/gi, "<$1b>");
}

/** Validate a brief before it ships. Throws if it isn't publishable. */
export function validateBrief(brief, validStoryIds) {
  if (!brief || !Array.isArray(brief.items)) throw new Error("brief gate: missing items");
  const items = brief.items
    .filter((it) => it && validStoryIds.has(it.story) && it.html)
    .map((it) => ({
      story: it.story,
      html: sanitizeInlineB(it.html),
      secs: Math.min(15, Math.max(5, Number(it.secs) || 10)),
      // Impact score drives both the deterministic sort order and the
      // visual size hierarchy on the site — clamped to a sane 1–10 range,
      // defaulting to 5 (mid) if the model omits it rather than crashing.
      impact: Math.min(10, Math.max(1, Number(it.impact) || 5)),
      // Hardware/infra stories get an explicit flag so the site can show
      // a distinct badge — readers shouldn't expect a tool launch and
      // find a GPU story with no warning.
      hardware: !!it.hardware,
      // tracking is set by brief.js AFTER this function runs (it's a
      // deterministic fact from overrides.json, not something the model
      // reports) — preserved here so it survives the reconstruction if
      // it's already present, but brief.js is the actual source of truth.
      tracking: !!it.tracking,
    }));
  if (items.length < 4) throw new Error(`brief gate: only ${items.length} valid items`);
  if (new Set(items.map((i) => i.story)).size !== items.length) throw new Error("brief gate: duplicate stories");
  if (!brief.title || brief.title.length > 120) throw new Error("brief gate: bad title");
  // Deterministic ranking: sort by the model's own impact score rather than
  // trusting whatever order it happened to return. Ties keep original order.
  const sorted = items.slice(0, 6).sort((a, b) => b.impact - a.impact);
  return { ...brief, title: String(brief.title), items: sorted };
}
