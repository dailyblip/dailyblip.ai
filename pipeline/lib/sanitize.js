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
    }));
  if (items.length < 4) throw new Error(`brief gate: only ${items.length} valid items`);
  if (new Set(items.map((i) => i.story)).size !== items.length) throw new Error("brief gate: duplicate stories");
  if (!brief.title || brief.title.length > 120) throw new Error("brief gate: bad title");
  return { ...brief, title: String(brief.title), items: items.slice(0, 6) };
}
