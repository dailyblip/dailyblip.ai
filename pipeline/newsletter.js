// pipeline/newsletter.js — runs daily after brief.js + tooldrop.js.
// Sends the Daily Blip to subscribers via Buttondown (https://buttondown.com).
// Requires BUTTONDOWN_API_KEY. Skips gracefully if unset (useful pre-launch).
import { loadFeed } from "./lib/store.js";

const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

function renderEmail(feed) {
  const items = feed.brief.items
    .map(
      (it, i) => `
      <tr>
        <td style="vertical-align:top;padding:10px 12px 10px 0;color:#E58E2B;font-weight:700;">${i + 1}</td>
        <td style="padding:10px 0;border-top:1px solid #e3e3e3;font-size:15px;line-height:1.5;color:#222;">
          ${it.html} <span style="color:#999;font-size:12px;">· ${it.secs}s</span>
        </td>
      </tr>`
    )
    .join("");

  const tool = feed.tooldrop
    ? `<div style="margin-top:28px;padding:16px;border:1px solid #e3e3e3;border-radius:8px;">
         <div style="font-size:11px;letter-spacing:.12em;color:#999;">TOOL DROP OF THE DAY</div>
         <div style="font-weight:700;margin:6px 0 4px;">${feed.tooldrop.name}</div>
         <div style="font-size:14px;color:#444;">${feed.tooldrop.blurb}</div>
         <div style="font-size:12px;color:#999;margin-top:6px;">${feed.tooldrop.meta} · <a href="${feed.tooldrop.url}">try it</a></div>
       </div>`
    : "";

  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;">
    <h1 style="font-size:20px;">${feed.brief.title}</h1>
    <p style="color:#666;font-size:14px;">Your 60-second catch-up on AI for creators.</p>
    <table style="border-collapse:collapse;width:100%;">${items}</table>
    ${tool}
    <p style="margin-top:28px;font-size:13px;color:#999;">
      Full stories, the feed, and the creative stack radar → <a href="${SITE_URL}">${SITE_URL.replace("https://", "")}</a>
    </p>
  </div>`;
}

async function main() {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) return console.log("newsletter: BUTTONDOWN_API_KEY not set — skipping send.");

  const feed = loadFeed();
  if (!feed.brief?.items?.length) throw new Error("newsletter: no brief to send.");

  // Guard against double-sending if the workflow reruns: only send if the
  // brief was written in the last 6 hours.
  if (Date.now() - new Date(feed.brief.date).getTime() > 6 * 3600 * 1000) {
    return console.log("newsletter: brief is stale; not sending.");
  }

  const res = await fetch("https://api.buttondown.com/v1/emails", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: `The Daily Blip · ${feed.brief.title.split("—")[0].trim()}`,
      body: renderEmail(feed),
      status: "about_to_send",
    }),
  });
  if (!res.ok) throw new Error(`newsletter: Buttondown API ${res.status} — ${await res.text()}`);
  console.log("newsletter: sent.");
}

main().catch((e) => { console.error(e); process.exit(1); });
