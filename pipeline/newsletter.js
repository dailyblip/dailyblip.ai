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

function renderEmail(feed) {
  const items = feed.brief.items
    .map(
      (it, i) => `
      <tr>
        <td style="vertical-align:top;padding:13px 14px 13px 0;width:26px;">
          <div style="width:24px;height:24px;border-radius:50%;background:${AMBER};color:${INK};
            font-weight:700;font-size:12px;text-align:center;line-height:24px;font-family:'SF Mono',Consolas,monospace;">${i + 1}</div>
        </td>
        <td style="padding:13px 0;border-top:1px solid ${LINE};font-size:15px;line-height:1.55;color:${TEXT};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
          ${it.html} <span style="color:${FAINT};font-size:11.5px;font-family:'SF Mono',Consolas,monospace;">· ${it.secs}s</span>
        </td>
      </tr>`
    )
    .join("");

  const tool = feed.tooldrop
    ? `<table role="presentation" width="100%" style="margin-top:26px;border-collapse:collapse;">
        <tr><td style="padding:18px 20px;border:1px solid rgba(99,216,198,.35);border-radius:10px;background:rgba(99,216,198,.06);">
          <div style="font-size:10.5px;letter-spacing:.14em;color:${AQUA};font-weight:700;font-family:'SF Mono',Consolas,monospace;">✦ TOOL DROP OF THE DAY</div>
          <div style="font-weight:700;font-size:16px;margin:8px 0 5px;color:${TEXT};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${feed.tooldrop.name}</div>
          <div style="font-size:13.5px;color:${DIM};line-height:1.5;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${feed.tooldrop.blurb}</div>
          <div style="font-size:11.5px;color:${FAINT};margin-top:8px;font-family:'SF Mono',Consolas,monospace;">${feed.tooldrop.meta} · <a href="${feed.tooldrop.url}" style="color:${AMBER_DEEP};text-decoration:none;">try it →</a></div>
        </td></tr>
      </table>`
    : "";

  const issue = feed.issue ? `Issue ${String(feed.issue).padStart(4, "0")}` : "";

  return `
<div style="background:#f4f7f7;padding:28px 12px;">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;border-collapse:collapse;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE};">

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
  <tr><td style="padding:20px 28px 26px;border-top:1px solid ${LINE};">
    <p style="margin:0;font-size:12.5px;color:${FAINT};font-family:'SF Mono',Consolas,monospace;line-height:1.7;">
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
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
      // Buttondown requires this header the first time any API key sends
      // a live email (status: about_to_send), as a safety confirmation
      // against accidental sends. Harmless to include on every request —
      // it's only "consumed" once per key, so leaving it here permanently
      // means this job never breaks again if the key ever gets rotated.
      "X-Buttondown-Live-Dangerously": "true",
    },
    body: JSON.stringify({
      subject: `🟠 The Daily Blip · ${feed.brief.title.split("—")[0].trim()}`,
      body: renderEmail(feed),
      status: "about_to_send",
    }),
  });
  if (!res.ok) throw new Error(`newsletter: Buttondown API ${res.status} — ${await res.text()}`);
  console.log("newsletter: sent.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
