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
      // Same deal for commentary — set programmatically by brief.js from
      // known candidate data, never trusted from the model's own output.
      commentary: !!it.commentary,
    }));
  if (items.length < 4) throw new Error(`brief gate: only ${items.length} valid items`);
  if (new Set(items.map((i) => i.story)).size !== items.length) throw new Error("brief gate: duplicate stories");
  if (!brief.title || brief.title.length > 120) throw new Error("brief gate: bad title");
  // Deterministic ranking: sort by the model's own impact score rather than
  // trusting whatever order it happened to return. Ties keep original order.
  const sorted = items.slice(0, 6).sort((a, b) => b.impact - a.impact);
  return { ...brief, title: String(brief.title), items: sorted };
}

// --- Guide article markdown -------------------------------------------
// Guide sections are edited as raw markdown in admin.html (a plain
// textarea, not a WYSIWYG editor — see the guides feature notes). This
// converts that markdown to HTML at PUBLISH time only, never earlier —
// the draft stored in data/guides.json stays as source markdown so
// re-editing and re-rendering never lose fidelity to what was typed.
//
// This is NOT a general-purpose markdown parser. It supports only the
// narrow subset guide prompts are instructed to produce: paragraphs,
// ## / ### headings, **bold**, *italic*, [text](url) links, and "- "
// bullet lists. Escaping happens FIRST, on the raw input, before any
// markdown pattern is applied — so even if a source's title or a
// model's output contains literal HTML, it can never re-enter the
// output as a tag. The markdown patterns below only ever wrap already-
// escaped text in known-safe tags; they never re-introduce raw HTML.
function escHtml(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    // Link targets are re-escaped for the href attribute specifically —
    // escHtml already ran on the whole line, so text is safe, but a URL
    // containing a literal quote could otherwise break out of the
    // attribute. rel=noopener since these can point to external sources.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
      const safeUrl = /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : "#";
      return `<a href="${safeUrl}" rel="noopener">${text}</a>`;
    });
}

export function renderSafeMarkdown(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) { out.push(`<ul>${listBuf.join("")}</ul>`); listBuf = []; }
  };
  for (const rawLine of lines) {
    const line = escHtml(rawLine.trim());
    if (!line) { flushList(); continue; }
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const li = line.match(/^-\s+(.*)/);
    if (h3) { flushList(); out.push(`<h3>${inlineMd(h3[1])}</h3>`); }
    else if (h2) { flushList(); out.push(`<h2>${inlineMd(h2[1])}</h2>`); }
    else if (li) { listBuf.push(`<li>${inlineMd(li[1])}</li>`); }
    else { flushList(); out.push(`<p>${inlineMd(line)}</p>`); }
  }
  flushList();
  return out.join("\n");
}
