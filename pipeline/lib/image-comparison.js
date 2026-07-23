// pipeline/lib/image-comparison.js — generates the same prompt across
// three officially-API-available image models (OpenAI, Flux, Ideogram)
// for comparison-style guides. Midjourney is deliberately NOT included
// here: it has no official API, only unofficial, ToS-violating
// wrappers -- see the human-upload slot this leaves for it instead in
// pipeline/guide-agent.js.
//
// Each model has a genuinely different call shape (confirmed directly
// against each vendor's docs, not assumed):
//   - OpenAI: synchronous, single request, base64 image in the response.
//   - Flux: ASYNC. Submit a request, get back a polling_url, poll it
//     repeatedly until status flips to "Ready", then download the
//     result immediately -- the URL expires in 10 minutes.
//   - Ideogram: synchronous, single request, image URL in the response.
//
// generateComparisonSet() runs all three in parallel via
// Promise.allSettled so one model failing (bad key, rate limit, content
// policy rejection) never blocks the other two from succeeding --
// matching the same per-image graceful-degradation pattern already
// used for illustrative images in commentary.js.
import sharp from "sharp";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BFL_KEY = process.env.BFL_API_KEY;
const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY;

async function toJpegBuffer(imageBuffer) {
  return sharp(imageBuffer).resize(1024, 1024, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
}

// --- OpenAI -----------------------------------------------------------
async function generateOpenAIImage(prompt) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "medium" }),
  });
  if (!res.ok) throw new Error(`OpenAI image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no image data");
  return toJpegBuffer(Buffer.from(b64, "base64"));
}

// --- Flux (Black Forest Labs) ------------------------------------------
// Confirmed against docs.bfl.ai / api.bfl.ai directly: x-key header
// (not Authorization: Bearer), async submit-then-poll pattern, result
// URL expires 10 minutes after the job completes.
const FLUX_POLL_INTERVAL_MS = 2000;
const FLUX_MAX_POLLS = 30; // ~1 minute ceiling before giving up

async function generateFluxImage(prompt) {
  if (!BFL_KEY) throw new Error("BFL_API_KEY not set");
  const submitRes = await fetch("https://api.bfl.ai/v1/flux-2-pro", {
    method: "POST",
    headers: { "x-key": BFL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
  });
  if (!submitRes.ok) throw new Error(`Flux submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 300)}`);
  const { polling_url } = await submitRes.json();
  if (!polling_url) throw new Error("Flux API did not return a polling_url");

  for (let i = 0; i < FLUX_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, FLUX_POLL_INTERVAL_MS));
    const pollRes = await fetch(polling_url, { headers: { "x-key": BFL_KEY } });
    if (!pollRes.ok) throw new Error(`Flux poll ${pollRes.status}: ${(await pollRes.text()).slice(0, 300)}`);
    const pollData = await pollRes.json();
    if (pollData.status === "Ready") {
      const imageUrl = pollData.result?.sample;
      if (!imageUrl) throw new Error("Flux reported Ready but returned no image URL");
      // Download immediately -- this URL expires in 10 minutes.
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Flux image download ${imgRes.status}`);
      return toJpegBuffer(Buffer.from(await imgRes.arrayBuffer()));
    }
    if (pollData.status === "Error") throw new Error(`Flux generation failed: ${JSON.stringify(pollData).slice(0, 300)}`);
    // else "Pending" -- keep polling
  }
  throw new Error(`Flux generation did not complete within ${FLUX_MAX_POLLS * FLUX_POLL_INTERVAL_MS / 1000}s`);
}

// --- Ideogram -----------------------------------------------------------
// Confirmed directly against ideogram.ai/api-learn/: Api-Key header
// (not Authorization: Bearer), text_prompt field, synchronous response
// with the image URL at data[0].url.
async function generateIdeogramImage(prompt) {
  if (!IDEOGRAM_KEY) throw new Error("IDEOGRAM_API_KEY not set");
  const res = await fetch("https://api.ideogram.ai/v1/ideogram-v4/generate", {
    method: "POST",
    headers: { "Api-Key": IDEOGRAM_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text_prompt: prompt }),
  });
  if (!res.ok) throw new Error(`Ideogram API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) throw new Error("Ideogram API returned no image URL");
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Ideogram image download ${imgRes.status}`);
  return toJpegBuffer(Buffer.from(await imgRes.arrayBuffer()));
}

// --- Orchestration -------------------------------------------------------
const MODELS = [
  { name: "OpenAI (GPT Image)", generate: generateOpenAIImage },
  { name: "Flux (Black Forest Labs)", generate: generateFluxImage },
  { name: "Ideogram", generate: generateIdeogramImage },
];

// Returns one entry per model, always -- a failed model shows up with
// error set and buffer null rather than being silently dropped, so a
// human reviewing the guide can see exactly which model(s) failed and
// why, rather than just noticing an image is missing with no context.
export async function generateComparisonSet(prompt) {
  const settled = await Promise.allSettled(MODELS.map((m) => m.generate(prompt)));
  return settled.map((result, i) => ({
    model: MODELS[i].name,
    buffer: result.status === "fulfilled" ? result.value : null,
    error: result.status === "rejected" ? result.reason.message : null,
  }));
}
