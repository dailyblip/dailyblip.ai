// pipeline/newsletter.js — runs daily after brief.js + tooldrop.js.
// Sends the Daily Blip to subscribers via Buttondown (https://buttondown.com).
// Requires BUTTONDOWN_API_KEY. Skips gracefully if unset (useful pre-launch).
//
// Email design note: dark backgrounds are unreliable across email clients
// (Outlook desktop strips them, Gmail dark mode can invert unexpectedly), so
// this template uses a safe white body with the brand's ink/amber/aqua used
// as accents — same palette, email-safe layout. Buttondown automatically
// appends its own unsubscribe footer after this HTML; do not add one here.
import { loadFeed } from "./lib/store.js";

const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

// Brand palette (see docs/index.html :root for the source of truth)
const INK = "#071A1F";
const AMBER = "#FFB454";
const AMBER_DEEP = "#E58E2B";
const AQUA = "#63D8C6";
const TEXT = "#1a2b2f";
const DIM = "#5b6b6e";
const FAINT = "#93a0a2";
const LINE = "#e7ecec";

// Blip — dailyblip's mascot, same character used on the site and in the
// social image pipeline. Email clients don't reliably render inline SVG
// (Outlook desktop drops it entirely), so this is a real hosted PNG,
// rendered once from the exact same SVG markup as the site sprite for
// visual consistency, not a separate asset drawn from scratch. Host
// blip-mascot.png at this path relative to your site root and update
// this constant if you put it somewhere else.
const BLIP_IMG_URL = `${SITE_URL}/blip-mascot.png`;

// Preheader text has to be plain — it shows in the inbox preview line,
// where any stray HTML tags would render literally as visible text.
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "");
}

// Email passes through far more encoding-fragile hops than a browser
// ever does (Buttondown -> SMTP -> gateway -> client), and this template
// has no <head>/<meta charset> to hint at since it's a fragment Buttondown
// wraps, not a full document. If any hop along the way mis-detects the
// charset, UTF-8 multibyte characters (em dashes, curly quotes, the
// decorative symbols below) turn into mojibake. Converting every
// non-ASCII character to a numeric HTML entity sidesteps the whole class
// of problem — entities are pure ASCII, so they render correctly
// regardless of what charset anything downstream assumes. Uses spread
// (codepoint-aware) rather than a regex, so emoji outside the BMP
// (surrogate pairs) don't get mangled.
function safeText(str) {
  return [...String(str ?? "")].map((ch) => {
    const cp = ch.codePointAt(0);
    return cp > 127 ? `&#${cp};` : ch;
  }).join("");
}

function renderEmail(feed) {
  const items = feed.brief.items
    .map((it, i) => {
      const isTop = i === 0;
      // Small inline flags mirroring the site's hw/tracking/commentary
      // badges — this data was already on every brief item and the old
      // template just wasn't using it.
      const flags = [
        it.hardware ? `<span style="display:inline-block;font-size:9.5px;letter-spacing:.03em;color:${DIM};border:1px solid ${LINE};border-radius:4px;padding:1px 5px;margin-right:6px;font-family:'SF Mono',Consolas,monospace;">⚙ HW</span>` : "",
        it.tracking ? `<span style="display:inline-block;font-size:9.5px;letter-spacing:.03em;color:${AMBER_DEEP};border:1px solid ${AMBER};border-radius:4px;padding:1px 5px;margin-right:6px;font-family:'SF Mono',Consolas,monospace;">📌 TRACKING</span>` : "",
        it.commentary ? `<span style="display:inline-block;font-size:9.5px;letter-spacing:.03em;color:${AQUA};border:1px solid ${AQUA};border-radius:4px;padding:1px 5px;margin-right:6px;font-family:'SF Mono',Consolas,monospace;">◆ TAKE</span>` : "",
      ].join("");

      return `
      <tr>
        <td style="vertical-align:top;padding:${isTop ? "15px 14px 15px 12px" : "13px 14px 13px 0"};width:26px;${isTop ? `background:#FFF7EA;border-radius:8px 0 0 8px;` : ""}">
          <div style="width:${isTop ? 28 : 24}px;height:${isTop ? 28 : 24}px;border-radius:50%;background:${AMBER};color:${INK};
            font-weight:700;font-size:${isTop ? 13 : 12}px;text-align:center;line-height:${isTop ? 28 : 24}px;font-family:'SF Mono',Consolas,monospace;">${i + 1}</div>
        </td>
        <td style="padding:${isTop ? "15px 12px 15px 0" : "13px 0"};border-top:${isTop ? "none" : `1px solid ${LINE}`};font-size:${isTop ? 16.5 : 15}px;line-height:1.55;color:${TEXT};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;${isTop ? `background:#FFF7EA;border-radius:0 8px 8px 0;font-weight:${isTop ? 500 : 400};` : ""}">
          ${isTop ? `<div style="font-size:9.5px;letter-spacing:.14em;color:${AMBER_DEEP};font-weight:700;font-family:'SF Mono',Consolas,monospace;margin-bottom:4px;">TOP SIGNAL</div>` : ""}
          ${flags}${it.html} <span style="color:${FAINT};font-size:11.5px;font-family:'SF Mono',Consolas,monospace;">· ${it.secs}s</span>
        </td>
      </tr>`;
    })
    .join("");

  const tool = feed.tooldrop
    ? `<table role="presentation" width="100%" style="margin-top:26px;border-collapse:collapse;">
        <tr><td style="padding:18px 20px;border:1px solid rgba(99,216,198,.35);border-radius:10px;background:rgba(99,216,198,.06);">
          <div style="font-size:10.5px;letter-spacing:.14em;color:${AQUA};font-weight:700;font-family:'SF Mono',Consolas,monospace;">✦ TOOL DROP OF THE DAY</div>
          <div style="font-weight:700;font-size:16px;margin:8px 0 5px;color:${TEXT};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${feed.tooldrop.name}</div>
          <div style="font-size:13.5px;color:${DIM};line-height:1.5;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${feed.tooldrop.blurb}</div>
          <div style="font-size:11.5px;color:${FAINT};margin-top:8px;font-family:'SF Mono',Consolas,monospace;">${feed.tooldrop.meta}</div>
          <a href="${feed.tooldrop.url}" style="display:inline-block;margin-top:12px;background:${AMBER};color:${INK};font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">Try it →</a>
        </td></tr>
      </table>`
    : "";

  const issue = feed.issue ? `Issue ${String(feed.issue).padStart(4, "0")}` : "";

  // Most inboxes show this line in the preview pane before the email is
  // even opened. Without it, clients either show nothing or grab random
  // leading whitespace/HTML comments from the body, which reads as
  // broken before someone's even opened the email. The trailing
  // zero-width-space run pads out any extra preview-length clients try
  // to pull, so it doesn't spill into "Manage your subscription..." text.
  const preheaderText = feed.brief.items[0] ? stripHtml(feed.brief.items[0].html).slice(0, 120) : "Your 60-second AI creator brief.";
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f7f7;">
    ${preheaderText}${"&zwnj;&nbsp;".repeat(40)}
  </div>`;

  const html = `
${preheader}
<div style="background:#f4f7f7;padding:28px 12px;">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;border-collapse:collapse;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE};">

  <!-- top accent stripe -->
  <tr><td style="background:${AMBER};height:4px;line-height:4px;font-size:1px;">&nbsp;</td></tr>

  <!-- header bar -->
  <tr><td style="background:${INK};padding:22px 28px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:24px;letter-spacing:-.01em;color:#E9F4F1;">
      d<span style="color:${AMBER};">ai</span>lyblip<span style="color:${AMBER};">●</span>
    </div>
    <div style="font-family:'SF Mono',Consolas,monospace;font-size:10.5px;color:#9AB7B2;letter-spacing:.08em;margin-top:4px;">
      AI CREATOR SIGNAL · ZERO SLOP ${issue ? " · " + issue : ""}
    </div>
  </td></tr>

  <!-- brief -->
  <tr><td style="padding:26px 28px 22px;">
    <div style="font-family:'SF Mono',Consolas,monospace;font-size:10.5px;letter-spacing:.14em;color:${AMBER_DEEP};font-weight:700;">THE DAILY BLIP</div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:21px;letter-spacing:-.01em;color:${TEXT};margin:8px 0 4px;">${feed.brief.title}</h1>
    <p style="color:${DIM};font-size:13.5px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;margin:0 0 14px;">Your 60-second catch-up on AI for creators.</p>
    <table role="presentation" width="100%" style="border-collapse:collapse;">${items}</table>
    ${tool}
  </td></tr>

  <!-- footer -->
  <tr><td style="padding:22px 28px 26px;border-top:1px solid ${LINE};">
    <table role="presentation" width="100%" style="border-collapse:collapse;">
      <tr>
        <td style="width:44px;vertical-align:top;padding-right:12px;">
          <img src="${BLIP_IMG_URL}" width="44" height="59" alt="Blip, dailyblip's mascot" style="display:block;border:0;width:44px;height:59px;">
        </td>
        <td style="vertical-align:middle;">
          <p style="margin:0;font-size:12.5px;color:${DIM};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">That's the signal for today — Blip's back on scope at 6am tomorrow.</p>
        </td>
      </tr>
    </table>
    <p style="margin:16px 0 0;font-size:12.5px;color:${FAINT};font-family:'SF Mono',Consolas,monospace;line-height:1.7;">
      Full stories, the live feed, and your creative stack →
      <a href="${SITE_URL}" style="color:${AMBER_DEEP};text-decoration:none;font-weight:600;">${SITE_URL.replace("https://", "")}</a><br>
      <a href="${SITE_URL}/showcase.html" style="color:${FAINT};text-decoration:none;">showcase</a> ·
      <a href="${SITE_URL}/standards.html" style="color:${FAINT};text-decoration:none;">standards</a> ·
      <a href="${SITE_URL}/archive/" style="color:${FAINT};text-decoration:none;">archive</a>
    </p>
    <p style="margin:14px 0 0;font-size:11px;color:${FAINT};font-family:'SF Mono',Consolas,monospace;">
      Wrong tools in your stack, or want fewer emails? Manage your subscription with the link below.
    </p>
  </td></tr>

</table>
</div>`;

  return safeText(html);
}

// Retries only on 5xx (the OTHER service's problem, often transient —
// exactly what a Buttondown "Application Error" page is) and never on
// 4xx (a real problem with what we sent, which would just fail
// identically on every retry). Without this, a brief blip anywhere in
// Buttondown's own infrastructure kills that day's newsletter outright
// with no second chance.
async function sendWithRetry(url, options, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    const isTransient = res.status >= 500 && res.status < 600;
    if (!isTransient || attempt === maxAttempts) {
      throw new Error(`newsletter: Buttondown API ${res.status} \u2014 ${await res.text()}`);
    }
    const waitMs = 3000 * attempt;
    console.warn(`newsletter: Buttondown API ${res.status} (attempt ${attempt}/${maxAttempts}) \u2014 likely transient, retrying in ${waitMs}ms...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function main() {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) return console.log("newsletter: BUTTONDOWN_API_KEY not set — skipping send.");

  const feed = loadFeed();
  if (!feed.brief?.items?.length) throw new Error("newsletter: no brief to send.");

  if (Date.now() - new Date(feed.brief.date).getTime() > 6 * 3600 * 1000) {
    return console.log("newsletter: brief is stale; not sending.");
  }

  const res = await sendWithRetry("https://api.buttondown.com/v1/emails", {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
      "X-Buttondown-Live-Dangerously": "true",
    },
    body: JSON.stringify({
      subject: `🟠 The Daily Blip · ${feed.brief.title.split("—")[0].trim()}`,
      body: renderEmail(feed),
      status: "about_to_send",
    }),
  });
  console.log("newsletter: sent.");
  console.log("newsletter: sent.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
