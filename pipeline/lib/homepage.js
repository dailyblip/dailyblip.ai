// pipeline/lib/homepage.js — bakes real, crawlable content directly into
// docs/index.html at build time: the day's actual H1, the brief items,
// the top story cards, and featured guides. Everything else about the
// page (CSS, personalization, streak tracking, radar, search/filter,
// tool-of-the-day, the older-signals toggle) stays exactly as it is,
// untouched, and continues working exactly as before once the client
// JS runs -- this only replaces specific, targeted regions of the raw
// HTML, never regenerates the page from scratch.
//
// Deliberately conservative in scope: this does NOT try to bake in
// anything that's inherently per-visitor (personalization based on a
// reader's own localStorage-tracked "stack" of tools, streak counts,
// read/unread state) -- those were never going to be indexed by a
// search engine anyway, and stay exactly as client-side-only features.

function esc(t) { return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Mirrors sanB() in index.html's own client JS: escape everything, then
// un-escape specifically <b> tags back (brief item HTML only ever uses <b>).
function sanB(html) { return esc(html).replace(/&lt;(\/?)b&gt;/gi, "<$1b>"); }

function storyHrs(s) {
  if (s.ts) return Math.max(1, Math.round((Date.now() - new Date(s.ts).getTime()) / 3.6e6));
  return s.hrs || 1;
}
function ago(h) { return h < 24 ? `${h} hr ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`; }
function moveArrow(s) {
  if (s.move === "new") return `<span class="mv nw">\u2605 new</span>`;
  if (typeof s.move === "number" && s.move > 1) return `<span class="mv up">\u25b2${s.move}</span>`;
  if (typeof s.move === "number" && s.move < -1) return `<span class="mv dn">\u25bc${Math.abs(s.move)}</span>`;
  return "";
}
const TOP_SIGNAL_MAX_HOURS = 48;
function isEffectivelyTop(s) { return !!s.top && storyHrs(s) < TOP_SIGNAL_MAX_HOURS; }

const CATS = [
  { id: "all", label: "all" }, { id: "spotlight", label: "\u2726 spotlight" },
  { id: "image", label: "image" }, { id: "video", label: "video" }, { id: "music", label: "music & audio" },
  { id: "writing", label: "writing" }, { id: "tools", label: "tools & workflow" },
  { id: "rights", label: "rights & rulings" }, { id: "industry", label: "industry" },
];

// Server-rendered story card -- same markup as the client's storyCardHtml(),
// minus the one piece that's inherently per-visitor: "affects your stack"
// (computed against a reader's own localStorage picks, meaningless at build
// time). Company-logo lookup is intentionally omitted here too, since it
// needs the site's BRANDFETCH_CLIENT_ID which lives in the client script,
// not duplicated here -- the client re-render adds it in immediately after.
function storyCardHtmlSSR(s) {
  const cat = CATS.find((c) => c.id === s.cat) || { label: s.cat };
  const h3 = s.url && s.url !== "#"
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
    : esc(s.title);
  const also = s.also?.length ? ` \u00b7 also via ${esc(s.also.join(", "))}` : "";
  const commentaryFlag = s.commentary ? `<span class="commentary-flag" title="Opinion piece from the dailyblip editors, not a news item">Commentary</span>` : "";
  return `
  <article class="story${isEffectivelyTop(s) ? " top-story" : ""}" id="${esc(s.id)}" tabindex="0">
    ${isEffectivelyTop(s) ? '<div class="top-label">top signal</div>' : ""}
    <div class="story-meta">
      <span class="tag c-${esc(s.cat)}">${esc(cat.label)}</span>
      <span class="badge ${esc(s.badge)}">${esc(s.badge)}</span>
      ${moveArrow(s)}
      ${s.spotlight ? '<span class="spot-flag">\u2726 spotlight</span>' : ""}
      ${commentaryFlag}
      <span>${ago(storyHrs(s))}</span>
    </div>
    <h3>${h3}</h3>
    <p>${esc(s.dek)}</p>
    <div class="foot">via <b>${esc(s.src)}</b> \u00b7 ${esc(s.read)} read${also}</div>
  </article>`;
}

function briefItemHtmlSSR(b, i) {
  const tier = i === 0 ? " impact-hero" : (i === 1 || i === 2) ? " impact-high" : "";
  const hwFlag = b.hardware ? `<span class="hw-flag" title="Hardware/infrastructure story, not a creator tool">hardware</span>` : "";
  const trackingFlag = b.tracking ? `<span class="tracking-flag" title="Pinned by the editor \u2014 carried across editions">Tracking</span>` : "";
  const commentaryFlag = b.commentary ? `<span class="commentary-flag" title="Opinion piece from the dailyblip editors, not news">Commentary</span>` : "";
  return `
    <li class="brief-item${tier}" data-i="${i}" data-story="${esc(b.story)}" tabindex="0" role="button" aria-pressed="false">
      <span class="marker"><span class="num">${i + 1}</span></span>
      <p>${trackingFlag}${hwFlag}${commentaryFlag}${sanB(b.html)}</p>
      <span class="secs">${b.secs}s</span>
    </li>`;
}

function guideCardHtmlSSR(g) {
  return `
      <div class="guide-card">
        <div class="guide-card-thumb">${g.hero_image ? `<img src="${esc(g.hero_image)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'">` : ""}</div>
        <div class="guide-card-body">
          <h3><a href="guides/${esc(g.slug)}.html">${esc(g.title)}${g.pinned ? ' <span class="pin-badge" title="Pinned">\ud83d\udccc</span>' : ""}</a></h3>
          <p>${esc(g.dek)}</p>
          <div class="foot">
            <span>${g.published_at ? new Date(g.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span>
            ${g.tags && g.tags[0] ? `<span class="guide-tag-chip">${esc(g.tags[0])}</span>` : ""}
          </div>
        </div>
      </div>`;
}

// Replaces the content of a specific element (matched by its id) IN A
// STRING, not the DOM -- since this runs in Node against a raw HTML
// string, not a browser. Only ever replaces what's between the opening
// and closing tag of that exact element; everything outside it, and
// everything about the opening tag's own attributes, is left untouched.
function replaceElementContent(html, tagOpenRegex, closeTag, newInner) {
  const openMatch = html.match(tagOpenRegex);
  if (!openMatch) return { html, found: false };
  const startOfContent = openMatch.index + openMatch[0].length;
  const closeIdx = html.indexOf(closeTag, startOfContent);
  if (closeIdx === -1) return { html, found: false };
  const updated = html.slice(0, startOfContent) + newInner + html.slice(closeIdx);
  return { html: updated, found: true };
}

export function bakeHomepage(currentHtml, feed, guidesManifest) {
  let html = currentHtml;
  const notes = [];

  // 1. H1 -- the day's actual brief title, baked directly in.
  const briefTitle = feed.brief?.title || "";
  if (briefTitle) {
    const r = replaceElementContent(html, /<h1 id="briefTitle">/, "</h1>", esc(briefTitle));
    html = r.html;
    if (!r.found) notes.push("could not find <h1 id=\"briefTitle\"> to bake into");
  } else {
    notes.push("feed.brief.title is empty -- H1 left as-is");
  }

  // 2. Brief items -- the actual "six things" list, as real <li> elements.
  const items = feed.brief?.items || [];
  if (items.length) {
    const itemsHtml = items.map(briefItemHtmlSSR).join("");
    const r = replaceElementContent(html, /<ul class="brief-items" id="briefItems">/, "</ul>", itemsHtml);
    html = r.html;
    if (!r.found) notes.push("could not find #briefItems to bake into");
  }

  // 3. Top stories -- the same 8 that would show by default (visible=8
  // in the client script), as real <article> story cards.
  const stories = (feed.stories || []).slice().sort((a, b) => {
    const aTop = isEffectivelyTop(a), bTop = isEffectivelyTop(b);
    if (aTop !== bTop) return bTop - aTop;
    return new Date(b.ts) - new Date(a.ts);
  });
  if (stories.length) {
    const topStories = stories.slice(0, 8);
    const storiesHtml = topStories.map(storyCardHtmlSSR).join("");
    const r = replaceElementContent(html, /<div id="feedList">/, "</div>", storiesHtml);
    html = r.html;
    if (!r.found) notes.push("could not find #feedList to bake into");
  }

  // 4. Featured guides -- same 3-pinned-then-newest logic the client's
  // renderGuidesFeature() already uses, just computed here instead.
  if (Array.isArray(guidesManifest) && guidesManifest.length) {
    const sorted = guidesManifest.slice().sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    const pinned = sorted.filter((g) => g.pinned).slice(0, 3);
    const pinnedSlugs = new Set(pinned.map((g) => g.slug));
    const fillCount = Math.max(0, 3 - pinned.length);
    const featured = [...pinned, ...sorted.filter((g) => !pinnedSlugs.has(g.slug)).slice(0, fillCount)];
    const guidesHtml = featured.map(guideCardHtmlSSR).join("");
    const r = replaceElementContent(html, /<div class="guides-grid" id="guidesFeatureGrid">/, "</div>", guidesHtml);
    html = r.html;
    if (r.found) {
      // The wrapper section starts as style="display:none" so it's
      // hidden until the client JS confirms there's something to show --
      // now that real content is baked in, it should just be visible by
      // default, same as any other section, rather than waiting on JS.
      html = html.replace('<section class="guides-feature" id="guidesFeatureWrap" style="display:none"', '<section class="guides-feature" id="guidesFeatureWrap"');
    } else {
      notes.push("could not find #guidesFeatureGrid to bake into");
    }
  }

  // 5. Embed the real feed data directly, replacing the fallback sample
  // data the file ships with for local preview -- so FEED already holds
  // real data even before boot()'s own fetch resolves, same reasoning
  // as the library page embedding its manifest directly.
  const feedJson = JSON.stringify(feed).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const feedVarMatch = html.match(/let FEED = \{[\s\S]*?\n\};/);
  if (feedVarMatch) {
    html = html.replace(feedVarMatch[0], `let FEED = ${feedJson};`);
  } else {
    notes.push("could not find the `let FEED = {...}` block to replace with real data");
  }

  return { html, notes };
}
