// lib/claude.js — Anthropic SDK wrapper built for unattended, multi-year operation.
// Docs: https://docs.claude.com/en/api/overview
//
// Durability features:
//  - Model fallback: if a pinned model is deprecated, query the Models API,
//    pick the newest model in the same tier, persist the choice, retry.
//  - askJSON: fence-stripping + one corrective retry on bad JSON.
//  - askWithSearch: JSON task with the web search tool enabled (used by the
//    curator to find replacement feeds).
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODELS_FILE = path.join(ROOT, "data", "models.json");

// Preferred starting models per role, plus the tier keyword used to find a
// successor if the model is ever retired. Haiku = cheap/high-volume,
// Sonnet = editorial writing.
const ROLE_DEFAULTS = {
  classify: { model: "claude-haiku-4-5-20251001", tier: "haiku" },
  write: { model: "claude-sonnet-4-6", tier: "sonnet" },
};

function readModelsConfig() {
  try { return JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")); } catch { return {}; }
}
function writeModelsConfig(cfg) {
  fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
  fs.writeFileSync(MODELS_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export function currentModel(role) {
  const cfg = readModelsConfig();
  return cfg[role]?.model || ROLE_DEFAULTS[role].model;
}

const isModelGone = (err) =>
  err?.status === 404 ||
  /model|not[_ ]found|deprecat/i.test(String(err?.error?.error?.type || err?.message || ""));

/** Query the Models API and pick the newest model whose id matches the tier keyword. */
async function findSuccessor(role) {
  const tier = ROLE_DEFAULTS[role].tier;
  const models = [];
  for await (const m of client.models.list()) models.push(m);
  const pick =
    models
      .filter((m) => m.id.toLowerCase().includes(tier))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ||
    models.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!pick) throw new Error(`model fallback: Models API returned nothing for tier "${tier}"`);
  const cfg = readModelsConfig();
  cfg[role] = { model: pick.id, switched_at: new Date().toISOString(), reason: "previous model unavailable" };
  writeModelsConfig(cfg);
  console.warn(`model fallback: role "${role}" now uses ${pick.id}`);
  return pick.id;
}

/** messages.create with automatic model-deprecation recovery. */
async function createResilient(role, params) {
  let model = currentModel(role);
  try {
    return await client.messages.create({ ...params, model });
  } catch (err) {
    if (!isModelGone(err)) throw err;
    model = await findSuccessor(role);
    return await client.messages.create({ ...params, model });
  }
}

const textOf = (res) =>
  res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** Finds the first complete, balanced JSON value in text by tracking
 *  brace/bracket depth (and respecting string literals, so a "}" inside a
 *  quoted string doesn't confuse the depth count). Stops the instant the
 *  outermost structure closes — unlike a naive "first bracket to last
 *  bracket" slice, this is immune to trailing prose that happens to
 *  contain its own stray brackets (very common in search-grounded
 *  responses that cite sources, e.g. "[1] Reuters" or a markdown list),
 *  which previously caused "Unexpected non-whitespace character after
 *  JSON" errors whenever a response had commentary after the real JSON. */
function extractJson(text) {
  let start = -1;
  for (const c of ["{", "["]) {
    const i = text.indexOf(c);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  if (start === -1) return null;
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0, inString = false, escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\") { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unterminated — let the caller's error handling deal with it
}

function parseLoose(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const extracted = extractJson(clean);
  if (!extracted) throw new Error("no JSON found");
  return JSON.parse(extracted);
}

/** Ask for JSON. One corrective retry on parse failure. */
export async function askJSON({ role = "write", system, prompt, maxTokens = 4000 }) {
  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await createResilient(role, { max_tokens: maxTokens, system, messages });
    const text = textOf(res);
    try { return parseLoose(text); } catch {
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: "That was not valid JSON. Reply with ONLY the corrected JSON. No prose, no fences." }
      );
    }
  }
  throw new Error(`askJSON: unparseable JSON for prompt starting: ${String(prompt).slice(0, 120)}`);
}

/** Ask for JSON with the web search tool available (curator uses this to
 *  find feeds; commentary.js and guide.js use this for grounded research).
 *  Same one-corrective-retry safety net as askJSON, added after guide.js
 *  hit a real "no JSON found" failure in production \u2014 askWithSearch
 *  previously had no retry at all, unlike askJSON, so a single malformed
 *  response (or one that ran out of token budget after several search
 *  rounds, before writing the closing JSON) would fail the whole job
 *  with no second chance. This was a latent gap affecting every existing
 *  caller of askWithSearch, not something specific to the new guide
 *  pipeline \u2014 fixed here once rather than worked around per-caller. */
export async function askWithSearch({ role = "write", system, prompt, maxTokens = 4000, maxSearches = 4 }) {
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];
  const messages = [{ role: "user", content: prompt }];
  console.warn(`askWithSearch: calling Claude with up to ${maxSearches} web searches available \u2014 this can take a while and prints nothing until it returns, that's expected, not stuck.`);
  let lastStopReason = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) console.warn(`askWithSearch: attempt ${attempt + 1} starting (previous response wasn't valid JSON) \u2014 this can take a while with search tool calls, not necessarily stuck.`);
    const res = await createResilient(role, { max_tokens: maxTokens, system, messages, tools });
    const text = textOf(res);
    lastStopReason = res.stop_reason;
    try { return parseLoose(text); } catch {
      // stop_reason tells us definitively whether this was truncation
      // (hit max_tokens mid-structure, likely fixable by raising the
      // budget or bounding the requested output size) versus the model
      // genuinely never producing JSON (a prompting problem instead) \u2014
      // without this, every failure looks identical and has to be
      // diagnosed by guesswork, which is exactly what happened here.
      console.warn(`askWithSearch: attempt ${attempt + 1} returned unparseable/empty content (${text.length} chars, stop_reason="${lastStopReason}"). ${lastStopReason === "max_tokens" ? "Response was TRUNCATED \u2014 raise maxTokens or shrink the requested output." : ""} ${attempt === 0 ? "Retrying once." : "No attempts left."}`);
      messages.push(
        { role: "assistant", content: text || "(no text in previous response)" },
        { role: "user", content: "That was not valid JSON (or was empty/truncated). Reply with ONLY the corrected, COMPLETE JSON now \u2014 shorten it if needed to fit, prioritizing the most important entries. No prose, no fences, no further searching needed." }
      );
    }
  }
  const hint = lastStopReason === "max_tokens" ? " (last response was TRUNCATED \u2014 raise maxTokens for this call, or shrink the requested output size)" : ` (last stop_reason: "${lastStopReason}")`;
  throw new Error(`askWithSearch: unparseable JSON for prompt starting: ${String(prompt).slice(0, 120)}${hint}`);
}
