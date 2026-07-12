/* stack.js — Personal Stack: the client-side personalization layer.
 *
 * What this does:
 * - Presents a one-time picker of the ~40 tools an AI creator might use
 * - Stores selections in localStorage (no accounts, no backend)
 * - Matches each incoming story against the picked tools and:
 *     • Surfaces a "For your stack" rail at the top of the feed
 *     • Flags story cards with "affects your stack" when they hit
 *     • Optionally bumps stack-relevant stories in the main sort order
 * - Provides an "Edit stack" gear that reopens the picker anytime
 *
 * How story ↔ tool matching works:
 * Each tool has a set of `aliases` (canonical name + common variants like
 * "MJ" for Midjourney or "Gen-4.5" for Runway Gen-4.5). A story matches
 * when any alias appears in the title, dek, or explicit tags. We prefer
 * word-boundary matches so "Sora" doesn't hit "sonar".
 *
 * The catalog is intentionally curator-quality — the tools an actual working
 * creator would recognize, grouped in a way that mirrors real workflow. Add
 * or remove tools by editing TOOLS below and redeploying.
 */

const STACK_STORAGE_KEY = "dailyblip.stack.v1";
const STACK_META_KEY = "dailyblip.stack.meta.v1"; // remembers if the picker was ever shown

// ---------- CATALOG ---------------------------------------------------------
// Curator's picks for the launch. ~40 tools across 6 groups.
// `id`      = stable internal key (never rename).
// `name`    = display name.
// `aliases` = strings we look for in story title + dek to match.
//             Include the canonical name plus common shorthand and version numbers.
// `emoji`   = small visual anchor (kept tasteful — one per row).
const TOOLS = [
  // ---- IMAGE ------------------------------------------------------------
  { id: "midjourney",      group: "image", name: "Midjourney",       emoji: "🎨",
    aliases: ["midjourney", "mj v", "mj-v", " mj ", "v8.1", "v8", "v7"] },
  { id: "sd",              group: "image", name: "Stable Diffusion", emoji: "🖼️",
    aliases: ["stable diffusion", "sdxl", "sd3", "sd 3", "flux"] },
  { id: "flux",            group: "image", name: "Flux",             emoji: "⚡",
    aliases: ["flux", "flux.1", "black forest"] },
  { id: "gpt_image",       group: "image", name: "GPT Image / DALL-E", emoji: "🖌️",
    aliases: ["gpt image", "gpt-image", "dall-e", "dalle"] },
  { id: "nano_banana",     group: "image", name: "Nano Banana",      emoji: "🍌",
    aliases: ["nano banana"] },
  { id: "imagen",          group: "image", name: "Google Imagen",    emoji: "🔷",
    aliases: ["imagen", "imagen 3", "imagen 4"] },
  { id: "firefly",         group: "image", name: "Adobe Firefly",    emoji: "🔥",
    aliases: ["firefly", "adobe firefly"] },
  { id: "ideogram",        group: "image", name: "Ideogram",         emoji: "✒️",
    aliases: ["ideogram"] },
  { id: "seedream",        group: "image", name: "Seedream",         emoji: "🌱",
    aliases: ["seedream"] },

  // ---- VIDEO ------------------------------------------------------------
  { id: "runway",          group: "video", name: "Runway",           emoji: "🎬",
    aliases: ["runway", "gen-4", "gen-4.5", "gen-3", "runwayml"] },
  { id: "veo",             group: "video", name: "Google Veo",       emoji: "🎞️",
    aliases: ["veo", "veo 3", "veo 3.1", "google veo"] },
  { id: "sora",            group: "video", name: "OpenAI Sora",      emoji: "🌀",
    aliases: ["sora", "openai sora"] },
  { id: "kling",           group: "video", name: "Kling",            emoji: "🥋",
    aliases: ["kling", "kling o3", "kling 3"] },
  { id: "pika",            group: "video", name: "Pika",             emoji: "✨",
    aliases: ["pika", "pika labs"] },
  { id: "seedance",        group: "video", name: "Seedance",         emoji: "💃",
    aliases: ["seedance"] },
  { id: "hedra",           group: "video", name: "Hedra",            emoji: "🗣️",
    aliases: ["hedra"] },
  { id: "wan",             group: "video", name: "Wan (open)",       emoji: "🧩",
    aliases: ["wan", "wan 2"] },
  { id: "grok_video",      group: "video", name: "Grok Imagine",     emoji: "𝕏",
    aliases: ["grok imagine", "grok video"] },

  // ---- MUSIC & AUDIO ----------------------------------------------------
  { id: "suno",            group: "music", name: "Suno",             emoji: "🎵",
    aliases: ["suno"] },
  { id: "udio",            group: "music", name: "Udio",             emoji: "🎧",
    aliases: ["udio"] },
  { id: "elevenlabs",      group: "music", name: "ElevenLabs",       emoji: "🔊",
    aliases: ["elevenlabs", "eleven labs", "eleven v"] },
  { id: "seedmusic",       group: "music", name: "Seedmusic",        emoji: "🌀",
    aliases: ["seedmusic"] },
  { id: "freebeat",        group: "music", name: "Freebeat",         emoji: "🥁",
    aliases: ["freebeat"] },

  // ---- WRITING & LLMs ---------------------------------------------------
  { id: "claude",          group: "writing", name: "Claude",         emoji: "🧠",
    aliases: ["claude", "sonnet", "opus", "haiku", "fable", "anthropic"] },
  { id: "chatgpt",         group: "writing", name: "ChatGPT / GPT",  emoji: "💬",
    aliases: ["chatgpt", "gpt-4", "gpt-5", "gpt5", "openai"] },
  { id: "gemini",          group: "writing", name: "Gemini",         emoji: "✳️",
    aliases: ["gemini", "google gemini"] },
  { id: "grok",            group: "writing", name: "Grok",           emoji: "𝕏",
    aliases: ["grok", "xai"] },
  { id: "deepseek",        group: "writing", name: "DeepSeek",       emoji: "🔍",
    aliases: ["deepseek"] },
  { id: "cursor",          group: "writing", name: "Cursor",         emoji: "⌨️",
    aliases: ["cursor"] },

  // ---- WORKFLOW SUITES --------------------------------------------------
  { id: "capcut",          group: "tools", name: "CapCut",           emoji: "✂️",
    aliases: ["capcut"] },
  { id: "kaiber",          group: "tools", name: "Kaiber",           emoji: "🌈",
    aliases: ["kaiber"] },
  { id: "artlist",         group: "tools", name: "Artlist",          emoji: "📚",
    aliases: ["artlist"] },
  { id: "krea",            group: "tools", name: "Krea",             emoji: "🎛️",
    aliases: ["krea"] },
  { id: "leonardo",        group: "tools", name: "Leonardo",         emoji: "🦁",
    aliases: ["leonardo"] },
  { id: "higgsfield",      group: "tools", name: "Higgsfield",       emoji: "🎯",
    aliases: ["higgsfield"] },
  { id: "neural_frames",   group: "tools", name: "Neural Frames",    emoji: "🖼️",
    aliases: ["neural frames"] },
  { id: "comfyui",         group: "tools", name: "ComfyUI",          emoji: "🪢",
    aliases: ["comfyui", "comfy ui", "comfy-ui"] },

  // ---- PLATFORMS & DISTRIBUTION -----------------------------------------
  { id: "youtube",         group: "platform", name: "YouTube",       emoji: "▶️",
    aliases: ["youtube"] },
  { id: "tiktok",          group: "platform", name: "TikTok",        emoji: "🎶",
    aliases: ["tiktok"] },
  { id: "instagram",       group: "platform", name: "Instagram",     emoji: "📸",
    aliases: ["instagram", "reels"] },
  { id: "x",               group: "platform", name: "X / Twitter",   emoji: "𝕏",
    aliases: [" x ", "twitter", "x.com"] },
];

const GROUP_LABELS = {
  image:    "Image",
  video:    "Video",
  music:    "Music & Audio",
  writing:  "Writing & LLMs",
  tools:    "Workflow suites",
  platform: "Platforms",
};

// ---------- STORAGE ---------------------------------------------------------
function loadStack() {
  try {
    const raw = localStorage.getItem(STACK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveStack(ids) {
  try { localStorage.setItem(STACK_STORAGE_KEY, JSON.stringify(ids)); } catch {}
}
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(STACK_META_KEY) || "{}"); }
  catch { return {}; }
}
function saveMeta(m) {
  try { localStorage.setItem(STACK_META_KEY, JSON.stringify(m)); } catch {}
}

// ---------- MATCHING --------------------------------------------------------
/** Return true if `text` contains `alias` on word-ish boundaries.
 *  Case-insensitive. Handles multi-word aliases naturally. */
function textHits(text, alias) {
  if (!text || !alias) return false;
  const hay = " " + text.toLowerCase() + " ";
  const needle = alias.toLowerCase();
  // Multi-word aliases (contain a space) just do substring — safe enough.
  if (needle.includes(" ")) return hay.includes(needle);
  // Single-word: require non-alpha on both sides so "sora" != "sonar".
  const idx = hay.indexOf(needle);
  if (idx === -1) return false;
  const before = hay[idx - 1];
  const after = hay[idx + needle.length];
  const isAlnum = (c) => c && /[a-z0-9]/.test(c);
  return !isAlnum(before) && !isAlnum(after);
}

/** Given a story and the user's picked tool IDs, return the set of tool IDs
 *  the story hits. Empty set = not stack-relevant. */
function storyMatchesStack(story, stackIds) {
  if (!stackIds.length) return new Set();
  const text = (story.title || "") + " " + (story.dek || "");
  const hits = new Set();
  for (const tool of TOOLS) {
    if (!stackIds.includes(tool.id)) continue;
    for (const alias of tool.aliases) {
      if (textHits(text, alias)) { hits.add(tool.id); break; }
    }
  }
  return hits;
}

// ---------- UI --------------------------------------------------------------
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(t) { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; }

/** Inject the picker modal + gear-in-header styles. Called once on boot. */
function injectStackStyles() {
  if (document.getElementById("stackStyles")) return;
  const style = document.createElement("style");
  style.id = "stackStyles";
  style.textContent = `
    .stack-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);
      display:none;align-items:center;justify-content:center;z-index:120;padding:22px}
    .stack-modal-bg.open{display:flex}
    .stack-modal{background:var(--ink-2);border:1px solid var(--line-strong);
      border-radius:14px;max-width:720px;width:100%;max-height:88vh;
      display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .stack-head{padding:22px 26px 16px;border-bottom:1px solid var(--line)}
    .stack-head h2{font-family:var(--display);font-weight:700;font-size:24px;
      letter-spacing:-.015em;margin-bottom:6px}
    .stack-head h2 .amber{color:var(--amber)}
    .stack-head p{color:var(--dim);font-size:13.5px;line-height:1.5}
    .stack-body{padding:14px 26px;overflow-y:auto;flex:1}
    .stack-group{margin-top:14px}
    .stack-group h4{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;
      text-transform:uppercase;color:var(--faint);margin-bottom:9px;
      display:flex;align-items:center;gap:8px}
    .stack-group h4::after{content:"";flex:1;height:1px;background:var(--line)}
    .stack-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:7px}
    .stack-tile{display:flex;align-items:center;gap:8px;padding:9px 11px;
      border:1px solid var(--line);border-radius:8px;background:var(--ink);
      cursor:pointer;transition:all .12s ease;font-size:13.5px;
      user-select:none;-webkit-tap-highlight-color:transparent}
    .stack-tile:hover{border-color:var(--line-strong);transform:translateY(-1px)}
    .stack-tile.on{background:rgba(255,180,84,.14);border-color:var(--amber);color:var(--text)}
    .stack-tile.on::after{content:"✓";margin-left:auto;color:var(--amber);font-weight:700}
    .stack-tile .em{font-size:16px;line-height:1}
    .stack-foot{padding:16px 26px;border-top:1px solid var(--line);
      display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between}
    .stack-count{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
    .stack-count b{color:var(--amber)}
    .stack-actions{display:flex;gap:8px}
    .stack-btn{padding:9px 16px;border-radius:7px;font-size:13px;font-weight:500;
      font-family:var(--body);border:1px solid var(--line-strong);color:var(--dim);
      background:transparent;cursor:pointer;transition:all .12s}
    .stack-btn:hover{border-color:var(--text);color:var(--text)}
    .stack-btn.primary{background:var(--amber);color:#20160a;border-color:var(--amber);font-weight:600}
    .stack-btn.primary:hover{filter:brightness(1.08)}
    .stack-btn.ghost{border-color:transparent;color:var(--faint)}

    /* Header gear */
    .stack-gear{background:none;border:1px solid var(--line);border-radius:6px;
      padding:5px 9px;font-family:var(--mono);font-size:11px;color:var(--dim);
      cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:6px}
    .stack-gear:hover{border-color:var(--amber);color:var(--amber)}
    .stack-gear .n{color:var(--amber);font-weight:600}

    /* For-your-stack rail */
    .for-you{margin-top:26px}
    .fy-head{font-family:var(--mono);font-size:11px;letter-spacing:.16em;
      text-transform:uppercase;color:var(--amber);margin-bottom:12px;
      display:flex;align-items:center;gap:10px}
    .fy-head::before{content:"◆"}
    .fy-head::after{content:"";flex:1;height:1px;
      background:linear-gradient(90deg,rgba(255,180,84,.4),transparent)}
    .fy-head .fy-tools{color:var(--dim);text-transform:none;letter-spacing:.02em;
      font-weight:normal;margin-left:auto;padding-left:14px}
    .fy-empty{border:1px dashed var(--line);border-radius:8px;padding:20px;
      text-align:center;color:var(--faint);font-family:var(--mono);font-size:12px}

    /* "affects your stack" flag on story cards */
    .stack-flag{color:var(--amber);font-size:10.5px;letter-spacing:.08em;
      font-family:var(--mono);text-transform:uppercase}
    .stack-flag::before{content:"◆ "}

    @media(max-width:560px){
      .stack-modal{max-height:92vh;border-radius:12px}
      .stack-head{padding:18px 20px 14px}
      .stack-body{padding:12px 20px}
      .stack-foot{padding:14px 20px}
      .stack-grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}
    }
  `;
  document.head.appendChild(style);
}

/** Build (or rebuild) the picker modal. Idempotent. */
function ensureStackModal() {
  if (document.getElementById("stackModal")) return document.getElementById("stackModal");
  const modal = el(`
    <div class="stack-modal-bg" id="stackModal" role="dialog" aria-labelledby="stackTitle" aria-modal="true">
      <div class="stack-modal">
        <div class="stack-head">
          <h2 id="stackTitle">What's in your <span class="amber">creative stack</span>?</h2>
          <p>Pick the tools you actually use. We'll surface what changes for them — pricing shifts, feature drops, sunsets — and push the noise down. Nothing leaves your device.</p>
        </div>
        <div class="stack-body" id="stackBody"></div>
        <div class="stack-foot">
          <div class="stack-count" id="stackCount"></div>
          <div class="stack-actions">
            <button class="stack-btn ghost" id="stackSkip">Skip for now</button>
            <button class="stack-btn primary" id="stackSave">Personalize my feed</button>
          </div>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(modal);

  const body = modal.querySelector("#stackBody");
  const groups = [...new Set(TOOLS.map(t => t.group))];
  for (const g of groups) {
    const groupTools = TOOLS.filter(t => t.group === g);
    const groupEl = el(`
      <div class="stack-group">
        <h4>${GROUP_LABELS[g] || g}</h4>
        <div class="stack-grid" data-group="${g}"></div>
      </div>
    `);
    const grid = groupEl.querySelector(".stack-grid");
    for (const t of groupTools) {
      const tile = el(`
        <div class="stack-tile" data-tool="${t.id}" role="button" tabindex="0" aria-pressed="false">
          <span class="em" aria-hidden="true">${t.emoji}</span>${esc(t.name)}
        </div>
      `);
      tile.addEventListener("click", () => toggleTile(tile));
      tile.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTile(tile); }
      });
      grid.appendChild(tile);
    }
    body.appendChild(groupEl);
  }

  modal.querySelector("#stackSkip").addEventListener("click", () => {
    saveMeta({ ...loadMeta(), shown: true, skipped_at: new Date().toISOString() });
    closeStackModal();
  });
  modal.querySelector("#stackSave").addEventListener("click", () => {
    const chosen = [...modal.querySelectorAll(".stack-tile.on")].map(t => t.dataset.tool);
    saveStack(chosen);
    saveMeta({ ...loadMeta(), shown: true, saved_at: new Date().toISOString() });
    closeStackModal();
    // Trigger a re-render of the feed by dispatching a custom event.
    window.dispatchEvent(new CustomEvent("stackchange", { detail: { stack: chosen } }));
  });

  modal.addEventListener("click", e => {
    if (e.target === modal) closeStackModalIfSaved();
  });

  return modal;
}

function toggleTile(tile) {
  tile.classList.toggle("on");
  tile.setAttribute("aria-pressed", tile.classList.contains("on"));
  updateStackCount();
}
function updateStackCount() {
  const n = document.querySelectorAll("#stackModal .stack-tile.on").length;
  const el = document.getElementById("stackCount");
  if (el) el.innerHTML = n ? `<b>${n}</b> tool${n===1?"":"s"} picked` : "no tools picked yet";
}

function openStackModal() {
  const modal = ensureStackModal();
  // Sync current selections into the tiles.
  const current = new Set(loadStack());
  for (const tile of modal.querySelectorAll(".stack-tile")) {
    tile.classList.toggle("on", current.has(tile.dataset.tool));
    tile.setAttribute("aria-pressed", current.has(tile.dataset.tool));
  }
  updateStackCount();
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeStackModal() {
  const modal = document.getElementById("stackModal");
  if (modal) modal.classList.remove("open");
  document.body.style.overflow = "";
}
/** Backdrop click: only close if the user has an established stack (or skipped) —
 *  first-time visitors shouldn't accidentally dismiss the modal by tapping outside. */
function closeStackModalIfSaved() {
  if (loadMeta().shown) closeStackModal();
}

/** Called from the main script to build the header gear + wire it up. */
function mountStackGear(container) {
  if (!container || document.getElementById("stackGear")) return;
  const gear = el(`
    <button class="stack-gear" id="stackGear" title="Edit your stack">
      <span aria-hidden="true">⚙</span>
      <span>my stack</span>
      <span class="n" id="stackGearN"></span>
    </button>
  `);
  gear.addEventListener("click", openStackModal);
  container.appendChild(gear);
  refreshStackGear();
}
function refreshStackGear() {
  const n = loadStack().length;
  const nEl = document.getElementById("stackGearN");
  if (nEl) nEl.textContent = n ? `· ${n}` : "";
}

// ---------- BOOT ------------------------------------------------------------
/** Auto-open the picker on very first visit. Anything after uses the gear. */
function maybeShowFirstRun() {
  const meta = loadMeta();
  if (meta.shown) return;
  // Slight delay so the site renders visibly first — otherwise it feels
  // like a captcha wall. Small trust move.
  setTimeout(() => {
    if (!loadMeta().shown) openStackModal();
  }, 1500);
}

// Expose the public API on window so the main script (in index.html) can use it.
window.dailyblipStack = {
  TOOLS,
  loadStack,
  saveStack,
  storyMatchesStack,
  openStackModal,
  mountStackGear,
  refreshStackGear,
  injectStackStyles,
  maybeShowFirstRun,
  toolById: (id) => TOOLS.find(t => t.id === id),
};
