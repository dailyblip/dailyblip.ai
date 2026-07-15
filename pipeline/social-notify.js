// pipeline/social-notify.js — runs AFTER the "Commit" step in daily.yml,
// on purpose: it reads today's already-saved image+caption (written by
// social.js) and creates a GitHub Issue referencing the image's live URL.
// Running this after commit+push means that URL has actually had a chance
// to go live by the time anyone opens the issue/email, rather than linking
// to something that doesn't exist yet.
//
// Uses the built-in GITHUB_TOKEN and GITHUB_REPOSITORY that GitHub Actions
// provides automatically — no new secret needed for this part, only for
// social.js's OPENAI_API_KEY. Requires `permissions: issues: write` in the
// workflow YAML.
import fs from "node:fs";
import path from "node:path";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo"
const SITE_URL = process.env.SITE_URL || "https://dailyblip.ai";

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join("docs/social", `${today}.json`);

  if (!fs.existsSync(jsonPath)) {
    console.log(`social-notify: no ${jsonPath} found — social.js likely skipped today (no OPENAI_API_KEY, or no brief yet). Nothing to notify.`);
    return;
  }
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.log("social-notify: GITHUB_TOKEN/GITHUB_REPOSITORY not available — skipping issue creation.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const imageUrl = `${SITE_URL}/social/${data.image}`;
  const [owner, repo] = GITHUB_REPOSITORY.split("/");

  const title = `\uD83D\uDCF8 Today's Instagram post — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
  const body = `### Image
![today's post](${imageUrl})

**[Open the image](${imageUrl})** — on mobile, long-press to save; on desktop, right-click → Save Image.

### Caption — copy everything in the box below
\`\`\`
${data.caption}
\`\`\`

### Source story
**${data.story.title}**
via ${data.story.src} · [read the original](${data.story.url})

---
*Generated automatically. Nothing posts without you — download the image, copy the caption, post whenever you're ready.*`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) throw new Error(`GitHub issue creation failed ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const issue = await res.json();
  console.log(`social-notify: created issue #${issue.number} — ${issue.html_url}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
