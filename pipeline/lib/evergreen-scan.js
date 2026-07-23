// pipeline/lib/evergreen-scan.js — flags version-specific and
// time-sensitive language in a generated guide for human review, rather
// than mechanically stripping it. Per an explicit decision: auto-
// deleting anything matching a version-like pattern risks mangling a
// legitimate product name that happens to contain a number, so this
// surfaces candidates for a person to judge rather than acting on their
// behalf. Same "prompt plus mechanical safety net, but surfaced instead
// of auto-corrected" shape as commentary.js's approach to style rules,
// just applied to a judgment call instead of a mechanical one.
//
// Deliberately over-inclusive rather than under: a reviewer skimming a
// short flagged list costs seconds; a stale version claim slipping
// through because the scan was too conservative costs real, ongoing
// inaccuracy on a page meant to stay evergreen indefinitely.

// Known AI product/model names paired with a version-shaped number --
// this is the highest-value pattern, since exactly this kind of claim
// ("GPT-4", "Midjourney V6", "Claude Sonnet 5") is what goes stale
// fastest as new versions ship.
const PRODUCT_VERSION_RE = /\b(GPT|ChatGPT|Claude|Sonnet|Opus|Haiku|Gemini|Imagen|Llama|Grok|Midjourney|Flux|Ideogram|Stable Diffusion|SDXL|SD|DALL-E|DALLE|Sora|Runway|Gen|Veo|Kling|Suno|Udio|ElevenLabs)(?:\s+\w+)?[\s-]?v?\d+(\.\d+)*\b/gi;

// Bare version-shaped tokens not already caught above (e.g. "v6.1",
// "version 2", "V8.1") -- broader net for version mentions that don't
// happen to follow a recognized product name.
const BARE_VERSION_RE = /\b(?:[vV]\d+(\.\d+)*|version\s+\d+(\.\d+)*)\b/gi;

// Phrases that frame a claim as true right now, rather than durably --
// exactly the kind of language that reads fine today and wrong in six
// months.
const TEMPORAL_PHRASE_RE = /\b(as of (?:January|February|March|April|May|June|July|August|September|October|November|December)?\s*\d{0,4}|currently|right now|at the moment|these days|this month|this week|the latest version|newly released|just released|recently released|recently launched|now the default|now the standard)\b/gi;

// A bare four-digit year on its own -- deliberately over-inclusive
// (a guide's legitimate historical reference, e.g. "founded in 2019",
// would also get flagged), since distinguishing "harmless historical
// fact" from "current-state claim that will date the page" needs
// actual judgment a mechanical scan can't reliably make. Cheap for a
// reviewer to dismiss a false positive; expensive to miss a real one.
const YEAR_RE = /\b20\d{2}\b/g;

function findMatches(text, regex, category) {
  const matches = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  while ((m = re.exec(text))) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    matches.push({
      category,
      match: m[0],
      context: `...${text.slice(start, m.index)}[${m[0]}]${text.slice(m.index + m[0].length, end)}...`,
    });
  }
  return matches;
}

// Scans every text field in an article for version-specific or
// time-sensitive language. Returns a flat list of flagged items with
// enough surrounding context that a reviewer can judge each one without
// re-reading the whole guide. An empty return means nothing was found,
// not that the scan didn't run.
export function scanForVersionLanguage(article) {
  const fields = [
    ["introduction", article.introduction],
    ["quick_answer", article.quick_answer],
    ["conclusion", article.conclusion],
    ...(article.sections || []).map((s, i) => [`section ${i + 1} (${s.heading || "untitled"})`, s.body_markdown]),
    ["key_takeaways", (article.key_takeaways || []).join(" ")],
  ];

  const flagged = [];
  for (const [fieldName, text] of fields) {
    if (!text) continue;
    const productVersions = findMatches(text, PRODUCT_VERSION_RE, "product version");
    const bareVersions = findMatches(text, BARE_VERSION_RE, "version number");
    const temporal = findMatches(text, TEMPORAL_PHRASE_RE, "temporal phrase");
    const years = findMatches(text, YEAR_RE, "year mention");
    for (const item of [...productVersions, ...bareVersions, ...temporal, ...years]) {
      flagged.push({ ...item, field: fieldName });
    }
  }
  return flagged;
}
