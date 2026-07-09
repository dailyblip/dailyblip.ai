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

function parseLoose(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  // Tolerate prose around the JSON (search-enabled responses often add some).
  const start = Math.min(...["{", "["].map((c) => { const i = clean.indexOf(c); return i === -1 ? Infinity : i; }));
  if (start === Infinity) throw new Error("no JSON found");
  const end = Math.max(clean.lastIndexOf("}"), clean.lastIndexOf("]"));
  return JSON.parse(clean.slice(start, end + 1));
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

/** Ask for JSON with the web search tool available (curator uses this to find feeds). */
export async function askWithSearch({ role = "write", system, prompt, maxTokens = 4000, maxSearches = 4 }) {
  const res = await createResilient(role, {
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  });
  return parseLoose(textOf(res));
}
