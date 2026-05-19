/**
 * A1111LMSAdapter — Drop-in TypeScript adapter that wraps AUTOMATIC1111's
 * Stable Diffusion Web UI HTTP API while routing prompts through an
 * LM Studio (or any OpenAI-compatible) chat endpoint for prompt enhancement.
 *
 * Why this exists:
 *   AUTOMATIC1111 produces better images when given detailed, specific
 *   prompts — but humans usually type short, vague ones. LM Studio is
 *   already running locally on most ML rigs. This module sits between the
 *   user's typed prompt and A1111, sending the prompt to a local LLM for
 *   enhancement first, then forwarding the enhanced prompt to A1111.
 *
 * Drop-in compatible: the txt2img / img2img methods accept the same shape
 * A1111's HTTP API expects, so existing code that POSTs to /sdapi/v1/txt2img
 * can be replaced with `await adapter.txt2img(req)`.
 *
 * What's NOT here:
 *   - No image generation logic. A1111 does that. We're just orchestrating.
 *   - No model loading. LM Studio handles that.
 *   - No batching across multiple A1111 instances. Use a load balancer
 *     in front of A1111 if you need that.
 */

// ─── A1111 wire types ──────────────────────────────────────────────────────
//
// Mirror of the documented AUTOMATIC1111 API request / response shapes.
// Index signatures left open ([key: string]: unknown) because A1111
// accepts a lot of optional fields we don't bother typing — extensions,
// scripts, sampler-specific knobs. Users can pass anything through.

export interface A1111Txt2ImgRequest {
  prompt: string;
  negative_prompt?: string;
  steps?: number;
  width?: number;
  height?: number;
  batch_size?: number;
  cfg_scale?: number;
  seed?: number;
  sampler_name?: string;
  [key: string]: unknown;
}

export interface A1111Txt2ImgResponse {
  /** base64-encoded PNGs, no data URI prefix */
  images: string[];
  parameters: Record<string, unknown>;
  /** JSON-encoded string with generation metadata */
  info: string;
}

export interface A1111Img2ImgRequest {
  prompt: string;
  negative_prompt?: string;
  /** base64-encoded input images, no data URI prefix */
  init_images: string[];
  denoising_strength?: number;
  steps?: number;
  width?: number;
  height?: number;
  cfg_scale?: number;
  seed?: number;
  sampler_name?: string;
  resize_mode?: number;
  [key: string]: unknown;
}

export interface A1111Img2ImgResponse {
  images: string[];
  parameters: Record<string, unknown>;
  info: string;
}

// ─── LM Studio wire types ──────────────────────────────────────────────────
//
// LM Studio exposes an OpenAI-compatible /v1/chat/completions endpoint, so
// these shapes match the OpenAI Chat Completions API. They also work
// against any other OpenAI-compatible server (Ollama with OpenAI shim,
// vLLM, Together AI, OpenAI itself).

export interface LMStudioChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LMStudioChatRequest {
  model?: string;
  messages: LMStudioChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface LMStudioChatChoice {
  index: number;
  message: LMStudioChatMessage;
  finish_reason: string;
}

export interface LMStudioChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LMStudioChatChoice[];
  usage?: Record<string, number>;
}

// ─── Adapter config + extension points ─────────────────────────────────────

export interface A1111LMSAdapterConfig {
  /** Base URL for A1111 API (e.g. 'http://127.0.0.1:7860'). Trailing slashes stripped. */
  a1111BaseUrl: string;
  /** Base URL for LM Studio API (e.g. 'http://127.0.0.1:1234'). Trailing slashes stripped. */
  lmStudioBaseUrl: string;
  /** Model id LM Studio should use. Optional — most LM Studio installs auto-pick. */
  lmStudioModel?: string;
  /** Temperature for the prompt-enhancement LLM call. Default 0.7. */
  enhancementTemperature?: number;
  /** Max tokens for the prompt-enhancement LLM call. Default 300. */
  enhancementMaxTokens?: number;
  /** Custom system prompt for the prompt-enhancement step. */
  enhancementSystemPrompt?: string;
  /** Per-call timeout in ms. Default: 60000 for LM Studio, 600000 (10m) for A1111. */
  lmStudioTimeoutMs?: number;
  a1111TimeoutMs?: number;
  /** Optional bearer token forwarded as `Authorization: Bearer <token>` on
   *  every request. LM Studio doesn't require it; OpenRouter / OpenAI do. */
  authToken?: string;
  /**
   * Retry policy for 5xx and network errors. Defaults: 2 retries, 500ms base
   * exponential backoff (so attempts at 0ms, 500ms, 1500ms). Set retries=0
   * to disable.
   */
  retries?: number;
  retryBaseMs?: number;
  /**
   * Optional logger. Receives structured events; useful for tracing into
   * your own observability stack. Default: silent.
   */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface EnhanceOptions {
  /** Skip the LM Studio enhancement step entirely. Useful for prompts that
   *  are already curated, or when the user wants raw A1111 behaviour. */
  bypass?: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a prompt engineer for Stable Diffusion. " +
  "Given a user prompt, refine and expand it into a detailed, " +
  "high-quality prompt that produces better images. " +
  "Output only the refined prompt, no additional explanation.";

const DEFAULT_LM_TIMEOUT_MS = 60_000;
const DEFAULT_A1111_TIMEOUT_MS = 600_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 300;

// ─── Errors ────────────────────────────────────────────────────────────────
//
// Subclassed Errors so callers can pattern-match (`err instanceof
// LMStudioError`) instead of parsing strings. All carry a HTTP status
// (or 0 when the failure was network-level).

export class AdapterError extends Error {
  readonly status: number;
  readonly body?: string;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    this.body = body;
  }
}

export class LMStudioError extends AdapterError {
  constructor(message: string, status: number, body?: string) {
    super(message, status, body);
    this.name = "LMStudioError";
  }
}

export class A1111Error extends AdapterError {
  constructor(message: string, status: number, body?: string) {
    super(message, status, body);
    this.name = "A1111Error";
  }
}

export class TimeoutError extends AdapterError {
  constructor(target: string, timeoutMs: number) {
    super(target + " request timed out after " + timeoutMs + "ms", 0);
    this.name = "TimeoutError";
  }
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export class A1111LMSAdapter {
  private readonly a1111BaseUrl: string;
  private readonly lmStudioBaseUrl: string;
  private readonly lmStudioModel: string | undefined;
  private readonly enhancementTemperature: number;
  private readonly enhancementMaxTokens: number;
  private readonly enhancementSystemPrompt: string;
  private readonly lmStudioTimeoutMs: number;
  private readonly a1111TimeoutMs: number;
  private readonly authToken: string | undefined;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;

  constructor(config: A1111LMSAdapterConfig) {
    if (!config.a1111BaseUrl) throw new Error("a1111BaseUrl is required");
    if (!config.lmStudioBaseUrl) throw new Error("lmStudioBaseUrl is required");
    this.a1111BaseUrl = config.a1111BaseUrl.replace(/\/+$/, "");
    this.lmStudioBaseUrl = config.lmStudioBaseUrl.replace(/\/+$/, "");
    this.lmStudioModel = config.lmStudioModel;
    this.enhancementTemperature = config.enhancementTemperature ?? DEFAULT_TEMPERATURE;
    this.enhancementMaxTokens = config.enhancementMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.enhancementSystemPrompt = config.enhancementSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.lmStudioTimeoutMs = config.lmStudioTimeoutMs ?? DEFAULT_LM_TIMEOUT_MS;
    this.a1111TimeoutMs = config.a1111TimeoutMs ?? DEFAULT_A1111_TIMEOUT_MS;
    this.authToken = config.authToken;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.log = config.log ?? (() => { /* silent by default */ });
  }

  /**
   * Enhance a user-supplied prompt by routing it through LM Studio's chat
   * completion endpoint with a Stable-Diffusion-targeted system prompt.
   * Public so callers can preview the enhanced prompt without committing to
   * a generation.
   */
  async enhancePrompt(prompt: string, opts?: EnhanceOptions): Promise<string> {
    if (opts?.bypass) {
      this.log("enhance.bypass", { prompt_chars: prompt.length });
      return prompt;
    }
    const requestBody: LMStudioChatRequest = {
      messages: [
        { role: "system", content: this.enhancementSystemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: this.enhancementTemperature,
      max_tokens: this.enhancementMaxTokens,
    };
    if (this.lmStudioModel) requestBody.model = this.lmStudioModel;
    const url = this.lmStudioBaseUrl + "/v1/chat/completions";
    const start = Date.now();
    const data = await this.requestWithRetry<LMStudioChatResponse>(
      url,
      requestBody,
      this.lmStudioTimeoutMs,
      "lmstudio",
    );
    if (!data.choices || data.choices.length === 0) {
      throw new LMStudioError("LM Studio returned no choices", 200, JSON.stringify(data).slice(0, 256));
    }
    const enhanced = data.choices[0].message.content.trim();
    this.log("enhance.ok", {
      original_chars: prompt.length,
      enhanced_chars: enhanced.length,
      latency_ms: Date.now() - start,
    });
    return enhanced;
  }

  /**
   * Txt2img — enhance the prompt, then call A1111's /sdapi/v1/txt2img.
   * Set `opts.bypass: true` to send the user's prompt verbatim.
   */
  async txt2img(req: A1111Txt2ImgRequest, opts?: EnhanceOptions): Promise<A1111Txt2ImgResponse> {
    const enhancedPrompt = await this.enhancePrompt(req.prompt, opts);
    const modifiedReq = { ...req, prompt: enhancedPrompt };
    const url = this.a1111BaseUrl + "/sdapi/v1/txt2img";
    const start = Date.now();
    const data = await this.requestWithRetry<A1111Txt2ImgResponse>(
      url,
      modifiedReq,
      this.a1111TimeoutMs,
      "a1111",
    );
    this.log("txt2img.ok", {
      images: data.images?.length ?? 0,
      latency_ms: Date.now() - start,
    });
    return data;
  }

  /**
   * Img2img — enhance the prompt, then call A1111's /sdapi/v1/img2img.
   * Same bypass option as txt2img.
   */
  async img2img(req: A1111Img2ImgRequest, opts?: EnhanceOptions): Promise<A1111Img2ImgResponse> {
    const enhancedPrompt = await this.enhancePrompt(req.prompt, opts);
    const modifiedReq = { ...req, prompt: enhancedPrompt };
    const url = this.a1111BaseUrl + "/sdapi/v1/img2img";
    const start = Date.now();
    const data = await this.requestWithRetry<A1111Img2ImgResponse>(
      url,
      modifiedReq,
      this.a1111TimeoutMs,
      "a1111",
    );
    this.log("img2img.ok", {
      images: data.images?.length ?? 0,
      latency_ms: Date.now() - start,
    });
    return data;
  }

  // ─── HTTP plumbing ───────────────────────────────────────────────────────
  //
  // All outgoing requests go through this single function so timeout +
  // retry behaviour is uniform. Retries fire on:
  //   - network errors (fetch threw before sending response)
  //   - 5xx responses
  //   - 408, 429 (request timeout / rate limited)
  // 4xx other than the above bubble immediately — they're caller bugs.

  private async requestWithRetry<T>(
    url: string,
    body: unknown,
    timeoutMs: number,
    target: "lmstudio" | "a1111",
  ): Promise<T> {
    let lastErr: unknown = null;
    const totalAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const result = await this.requestOnce<T>(url, body, timeoutMs, target);
        return result;
      } catch (err) {
        lastErr = err;
        const retryable = this.isRetryable(err);
        const willRetry = retryable && attempt < totalAttempts;
        const status = err instanceof AdapterError ? err.status : 0;
        this.log("request.failed", {
          target,
          url,
          attempt,
          status,
          retryable,
          will_retry: willRetry,
          message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
        if (!willRetry) throw err;
        const backoff = this.retryBaseMs * Math.pow(2, attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
    // Unreachable (we either return or throw inside the loop), but TypeScript
    // wants an explicit terminator.
    throw lastErr instanceof Error ? lastErr : new Error("Unknown request failure");
  }

  private async requestOnce<T>(
    url: string,
    body: unknown,
    timeoutMs: number,
    target: "lmstudio" | "a1111",
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers.Authorization = "Bearer " + this.authToken;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError(target, timeoutMs);
      }
      const ErrCtor = target === "lmstudio" ? LMStudioError : A1111Error;
      throw new ErrCtor(
        target + " network error: " + (err instanceof Error ? err.message : String(err)),
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const errorText = await response.text();
      const ErrCtor = target === "lmstudio" ? LMStudioError : A1111Error;
      throw new ErrCtor(
        target + " request failed with status " + response.status,
        response.status,
        errorText,
      );
    }
    return (await response.json()) as T;
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof TimeoutError) return true;
    if (err instanceof AdapterError) {
      // 0 = network error, 5xx = server error, 408/429 = transient overload.
      if (err.status === 0) return true;
      if (err.status >= 500) return true;
      if (err.status === 408 || err.status === 429) return true;
      return false;
    }
    return false;
  }
}
