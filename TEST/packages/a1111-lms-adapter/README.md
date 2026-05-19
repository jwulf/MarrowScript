# a1111-lms-adapter

TypeScript adapter that wraps **AUTOMATIC1111's Stable Diffusion Web UI** HTTP API while routing prompts through **LM Studio** (or any OpenAI-compatible chat endpoint) for prompt enhancement first.

A short, vague user prompt becomes a detailed Stable-Diffusion-friendly one, then gets sent to A1111. Drop-in compatible with the txt2img / img2img request shapes.

```ts
import { A1111LMSAdapter } from "a1111-lms-adapter";

const adapter = new A1111LMSAdapter({
  a1111BaseUrl: "http://127.0.0.1:7860",
  lmStudioBaseUrl: "http://127.0.0.1:1234",
});

const result = await adapter.txt2img({
  prompt: "a cat",                      // becomes "a regal tabby cat sitting…"
  steps: 25,
  width: 768,
  height: 768,
});

// result.images[0] is a base64-encoded PNG
```

## Why

A1111 produces dramatically better images when given detailed, specific prompts. Most humans type short, vague ones. LM Studio is already running on most ML rigs. This module sits between the two and uses the LLM you already have to upgrade the prompt.

It's intentionally small. No image processing, no model loading, no batching — just an HTTP shim that does one thing well.

## Install

```bash
npm install a1111-lms-adapter
```

Requires Node 18+ for the built-in `fetch`.

## Quick start

Two services need to be running:

1. **AUTOMATIC1111** with the `--api` flag (default `http://127.0.0.1:7860`)
2. **LM Studio** server with a model loaded (default `http://127.0.0.1:1234`)

Then:

```ts
import { A1111LMSAdapter } from "a1111-lms-adapter";

const adapter = new A1111LMSAdapter({
  a1111BaseUrl: "http://127.0.0.1:7860",
  lmStudioBaseUrl: "http://127.0.0.1:1234",
});

// Generate an image — prompt is enhanced via LM Studio before reaching A1111.
const txt = await adapter.txt2img({
  prompt: "a portrait of a fox",
  steps: 25,
  width: 768,
  height: 768,
});

// Restyle an existing image.
const img = await adapter.img2img({
  prompt: "in watercolour, soft brushstrokes",
  init_images: [base64InputImage],
  denoising_strength: 0.55,
});

// Preview the enhancement without committing to a generation.
const enhanced = await adapter.enhancePrompt("a cat");
```

## Configuration

```ts
new A1111LMSAdapter({
  // ── Required ──────────────────────────────────────────────────────────
  a1111BaseUrl: "http://127.0.0.1:7860",
  lmStudioBaseUrl: "http://127.0.0.1:1234",

  // ── Optional ──────────────────────────────────────────────────────────

  /** Force a specific model id. Most LM Studio installs auto-select. */
  lmStudioModel: "qwen2.5-coder-7b",

  /** Tuning knobs for the enhancement call. */
  enhancementTemperature: 0.7,    // default 0.7
  enhancementMaxTokens:    300,   // default 300

  /** Override the system prompt used during enhancement. */
  enhancementSystemPrompt: "Rewrite the user's prompt as a detailed Stable Diffusion prompt.",

  /** Per-call timeouts. A1111 can take a while; LM Studio less so. */
  lmStudioTimeoutMs: 60_000,      // default 60s
  a1111TimeoutMs:    600_000,     // default 10m

  /** Bearer token forwarded on every request. LM Studio doesn't need one;
   *  OpenRouter / OpenAI do. */
  authToken: process.env.OPENROUTER_API_KEY,

  /** Retry policy. Retries fire on 5xx, 408, 429, network errors. */
  retries: 2,                      // default 2
  retryBaseMs: 500,                // default 500 (exponential backoff)

  /** Hook into your observability stack. */
  log: (event, fields) => myLogger.info(event, fields),
});
```

## Bypassing enhancement

When the user has crafted a prompt themselves and doesn't want LM Studio touching it, pass `{ bypass: true }`:

```ts
await adapter.txt2img({ prompt: "exact prompt I want" }, { bypass: true });
```

## Errors

All HTTP failures throw subclasses of `AdapterError` so you can pattern-match:

```ts
import { A1111Error, LMStudioError, TimeoutError } from "a1111-lms-adapter";

try {
  await adapter.txt2img({ prompt: "x" });
} catch (err) {
  if (err instanceof TimeoutError) /* retry, reduce steps, etc. */;
  if (err instanceof LMStudioError) /* check LM Studio is up */;
  if (err instanceof A1111Error) /* check A1111 is up */;
  throw err;
}
```

Each error carries `.status` (HTTP status, or 0 for network errors) and `.body` (the response body when one was returned).

## Pointing at OpenRouter / OpenAI / vLLM

The LM Studio side speaks the OpenAI Chat Completions wire format, so any OpenAI-compatible endpoint works:

```ts
new A1111LMSAdapter({
  a1111BaseUrl: "http://127.0.0.1:7860",
  lmStudioBaseUrl: "https://openrouter.ai/api",
  lmStudioModel: "deepseek/deepseek-chat-v3.1:free",
  authToken: process.env.OPENROUTER_API_KEY,
});
```

## Examples

Two example scripts live in `examples/`:

```bash
# Generate an image
npx tsx examples/txt2img.ts "a moody portrait of a fox"

# Restyle an existing image
npx tsx examples/img2img.ts ./photo.png "in the style of Studio Ghibli"
```

## Testing

```bash
npm install
npm test
```

The test suite spins up two fake HTTP servers (one for A1111, one for LM Studio) and exercises every code path: enhancement, bypass, error mapping, retries, timeouts, auth header forwarding. No real models or GPUs needed.

## License

MIT.
