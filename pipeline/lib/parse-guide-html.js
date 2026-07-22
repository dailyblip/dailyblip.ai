// pipeline/lib/parse-guide-html.js — reconstructs a structured article
// object from an already-rendered guide page's HTML. Needed specifically
// for backfilled guides (the Suno/ChatGPT/Midjourney batches, the
// reference guide), whose job records in data/guides.json only ever
// stored minimal metadata (title, slug, dek, tags, hero image) -- their
// full section content exists nowhere in structured form except the
// rendered HTML itself. Pipeline-generated guides don't need this at
// all; their full article data is already sitting in data/guides.json.
//
// Deliberately conservative: returns null (rather than a best-effort
// guess) if anything essential is missing, so the retrofit script can
// skip a guide it isn't confident about instead of silently mangling
// already-live content.

function unescapeHtml(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Reverses inlineMd() from sanitize.js: <b>x</b> -> **x**, <i>x</i> -> *x*,
// <a href="url">x</a> -> [x](url) -- run BEFORE unescaping the rest of
// the text, mirroring the order inlineMd applies them in.
function htmlInlineToMarkdown(html) {
  return html
    .replace(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g, (_, url, text) => `[${text}](${url})`)
    .replace(/<b>(.*?)<\/b>/g, "**$1**")
    .replace(/<i>(.*?)<\/i>/g, "*$1*");
}

// Reverses renderSafeMarkdown() from sanitize.js: a rendered block of
// <h2>/<h3>/<ul><li>/<p> tags back into the ## / ### / - / plain-text
// markdown that would have produced it.
function htmlBlockToMarkdown(html) {
  if (!html) return "";
  const blocks = [];
  const re = /<h3>(.*?)<\/h3>|<h2>(.*?)<\/h2>|<ul>(.*?)<\/ul>|<p>(.*?)<\/p>/gs;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) blocks.push(`### ${unescapeHtml(htmlInlineToMarkdown(m[1]))}`);
    else if (m[2] !== undefined) blocks.push(`## ${unescapeHtml(htmlInlineToMarkdown(m[2]))}`);
    else if (m[3] !== undefined) {
      // List items join with a SINGLE newline (one list = one block),
      // while blocks themselves (this list vs. the next paragraph) still
      // separate with a blank line below.
      const items = [...m[3].matchAll(/<li>(.*?)<\/li>/gs)].map((li) => `- ${unescapeHtml(htmlInlineToMarkdown(li[1]))}`);
      blocks.push(items.join("\n"));
    } else if (m[4] !== undefined) blocks.push(unescapeHtml(htmlInlineToMarkdown(m[4])));
  }
  return blocks.join("\n\n");
}

function extractTag(html, tag, className) {
  const re = className
    ? new RegExp(`<${tag}[^>]*class="${className}"[^>]*>(.*?)<\\/${tag}>`, "s")
    : new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`, "s");
  const m = html.match(re);
  return m ? unescapeHtml(m[1].trim()) : null;
}

function extractPrompts(sectionHtml) {
  const block = sectionHtml.match(/<div class="prompts-block">(.*?)<\/div>\s*(?:<\/div>)?$/s);
  if (!block) return null;
  const cards = [...block[1].matchAll(/<div class="prompt-label">(.*?)<\/div>[\s\S]*?<code class="prompt-text">(.*?)<\/code>/g)];
  if (!cards.length) return null;
  return cards.map((c) => ({ label: unescapeHtml(c[1]), prompt: unescapeHtml(c[2]) }));
}

function extractTable(sectionHtml) {
  const wrap = sectionHtml.match(/<div class="ref-table-wrap">([\s\S]*?)<\/div>/);
  if (!wrap) return null;
  const headers = [...wrap[1].matchAll(/<th>(.*?)<\/th>/g)].map((h) => unescapeHtml(h[1]));
  const rows = [...wrap[1].matchAll(/<tr>(.*?)<\/tr>/gs)]
    .slice(1) // first <tr> is the header row, already captured above
    .map((r) => [...r[1].matchAll(/<td>(.*?)<\/td>/g)].map((c) => unescapeHtml(c[1])));
  if (!headers.length || !rows.length) return null;
  return { headers, rows };
}

export function parseGuideHtml(html, slug) {
  const problems = [];

  const title = extractTag(html, "h1");
  if (!title) problems.push("no <h1> found");
  const dek = extractTag(html, "p", "dek");
  if (!dek) problems.push("no .dek found");
  const lastReviewedMatch = html.match(/<div class="meta-row">Last reviewed (.*?)<\/div>/);
  const last_reviewed_date = lastReviewedMatch ? unescapeHtml(lastReviewedMatch[1]) : null;
  const metaDescMatch = html.match(/<meta name="description" content="([^"]*)">/);
  const meta_description = metaDescMatch ? unescapeHtml(metaDescMatch[1]) : dek;

  const tagsMatch = html.match(/<div class="page-tags">(.*?)<\/div>/s);
  const tags = tagsMatch ? [...tagsMatch[1].matchAll(/<span class="page-tag-chip">(.*?)<\/span>/g)].map((t) => unescapeHtml(t[1])) : [];

  const quickAnswerMatch = html.match(/<div class="quick-answer"><div class="label">QUICK ANSWER<\/div>(.*?)<\/div>/s);
  const quick_answer = quickAnswerMatch ? htmlBlockToMarkdown(quickAnswerMatch[1]).trim() : "";

  // Hero image: the one <img> inside a .img-block that sits BEFORE
  // <article>, not one of the per-section images inside it.
  const beforeArticle = html.split("<article>")[0] || "";
  const heroImgMatch = beforeArticle.match(/<div class="img-block"><img src="\/guides\/([^"]*)" alt="([^"]*)"/);
  const heroImage = heroImgMatch ? { file: heroImgMatch[1], alt_text: unescapeHtml(heroImgMatch[2]) } : null;

  const articleMatch = html.match(/<article>([\s\S]*?)<\/article>/);
  if (!articleMatch) { problems.push("no <article> block found"); return { article: null, problems }; }
  const articleInner = articleMatch[1];

  // Split the article body on section-block boundaries. Everything
  // before the first one is the introduction; everything after the
  // last one is the conclusion; each piece in between is one section.
  const sectionSplit = articleInner.split(/<div class="section-block">/);
  const introduction = htmlBlockToMarkdown(sectionSplit[0]).trim();
  if (!introduction) problems.push("no introduction text extracted");

  const sections = [];
  for (let i = 1; i < sectionSplit.length; i++) {
    // Each piece (after the first) starts right after its own opening
    // <div class="section-block">, and ends at ITS OWN matching closing
    // </div> -- found by tracking nesting depth, since section bodies
    // can themselves contain nested <div>s (images, prompt blocks,
    // tables) that would otherwise confuse a naive first-</div> match.
    const piece = sectionSplit[i];
    let depth = 1, pos = 0, end = -1;
    const tagRe = /<div[^>]*>|<\/div>/g;
    let tm;
    while ((tm = tagRe.exec(piece))) {
      if (tm[0].startsWith("</")) { depth--; if (depth === 0) { end = tm.index; break; } }
      else depth++;
    }
    const body = end === -1 ? piece : piece.slice(0, end);
    const headingMatch = body.match(/<h2>(.*?)<\/h2>/);
    if (!headingMatch) { problems.push(`section ${i} has no <h2> heading`); continue; }
    const heading = unescapeHtml(headingMatch[1]);
    // Body markdown is everything in this section EXCEPT the heading,
    // any nested image block, prompts block, or table -- those get
    // extracted separately into their own structured fields below.
    let bodyForMarkdown = body.replace(/<h2>.*?<\/h2>/s, "");
    bodyForMarkdown = bodyForMarkdown.replace(/<div class="img-block">.*?<\/div>/gs, "");
    bodyForMarkdown = bodyForMarkdown.replace(/<div class="prompts-block">[\s\S]*/s, ""); // prompts block, if present, always trails the rest
    bodyForMarkdown = bodyForMarkdown.replace(/<div class="ref-table-wrap">[\s\S]*?<\/div>/, "");
    const body_markdown = htmlBlockToMarkdown(bodyForMarkdown).trim();
    const prompts = extractPrompts(body);
    const table = extractTable(body);
    const sectionObj = { id: `s${i}`, heading, body_markdown };
    if (prompts) sectionObj.prompts = prompts;
    if (table) sectionObj.table = table;
    sections.push(sectionObj);
    // The remainder of sectionSplit[i] after this section's closing div
    // (if this is the LAST section) is the conclusion -- handled below,
    // outside this loop, using the last piece specifically.
    if (i === sectionSplit.length - 1 && end !== -1) {
      sectionSplit[i] = piece.slice(end);
    } else if (i === sectionSplit.length - 1) {
      sectionSplit[i] = "";
    }
  }
  if (!sections.length) problems.push("no sections extracted");

  const conclusionRaw = sectionSplit.length > 1 ? sectionSplit[sectionSplit.length - 1] : "";
  const conclusion = htmlBlockToMarkdown(conclusionRaw).trim();
  if (!conclusion) problems.push("no conclusion text extracted");

  // Article-level prompts (a.prompts) sit AFTER </article>, not inside
  // any section -- distinct from per-section prompts already handled above.
  const afterArticle = html.split("</article>")[1] || "";
  const articlePromptsBlock = afterArticle.match(/^([\s\S]*?)(?:<div class="takeaways">|<div class="related-guides">|<div class="subscribe-block")/);
  const articlePrompts = articlePromptsBlock ? extractPrompts(articlePromptsBlock[1]) : null;

  const takeawaysMatch = html.match(/<div class="takeaways"><div class="label">KEY TAKEAWAYS<\/div><ul>(.*?)<\/ul><\/div>/s);
  const key_takeaways = takeawaysMatch ? [...takeawaysMatch[1].matchAll(/<li>(.*?)<\/li>/g)].map((t) => unescapeHtml(t[1])) : [];
  if (!key_takeaways.length) problems.push("no key takeaways extracted");

  const article = {
    title, slug, dek, meta_description, quick_answer,
    tags, last_reviewed_date,
    introduction, sections, conclusion, key_takeaways,
  };
  if (articlePrompts) article.prompts = articlePrompts;

  return { article, heroImage, problems };
}
