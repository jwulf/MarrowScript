/**
 * MarrowScript LLM-Driven Reflection — provider + tool-call loop (Phase 20 v2)
 *
 * Two responsibilities:
 *   - OpenAICompatProvider: a small standalone client that talks to any
 *     OpenAI-compatible endpoint (LM Studio, vLLM, Ollama's OAI shim,
 *     OpenAI itself). Mirrors the runtime provider's wire format so we can
 *     swap them later without changing payloads.
 *   - runToolLoop: the bounded function-calling loop that drives an
 *     inference task. Same shape as Phase 15's runtime loop but standalone
 *     (no cognition runtime / no traces) — the compiler context is offline.
 *
 * Determinism: this module is the boundary where non-determinism enters.
 * The model picks tools and responds with content. We bound the loop, log
 * tool calls, and let the caller decide what to do with the final text.
 */

import type {
  LLMChatMessage,
  LLMChatRequest,
  LLMChatResponse,
  LLMChatToolCall,
  LLMChatToolSpec,
  LLMProvider,
  ToolRegistry,
} from "./types";

// ─── OpenAI-compatible provider ─────────────────────────────────────────────

/**
 * Reads endpoint + model + apiKey from constructor args or env. The CLI
 * surface defaults to LM Studio (`http://127.0.0.1:1234/v1`) since that's
 * what most local setups run; users override with --endpoint / env.
 */
export class OpenAICompatProvider implements LLMProvider {
  private endpoint: string;
  private apiKey: string;

  constructor(endpoint?: string, apiKey?: string) {
    const ep = endpoint || process.env.LLM_REFLECT_ENDPOINT || "http://127.0.0.1:1234/v1";
    this.endpoint = ep.replace(/\/+$/, "");
    this.apiKey = apiKey || process.env.LLM_REFLECT_API_KEY || process.env.OPENAI_COMPAT_API_KEY || "";
  }

  async chat(req: LLMChatRequest, signal?: AbortSignal): Promise<LLMChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.0,
      max_tokens: req.max_output ?? 4096,
      stream: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (req.tool_choice) body.tool_choice = req.tool_choice;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`reflect-llm provider ${res.status}: ${text.slice(0, 256)}`);
    }
    const data = await res.json() as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = data.choices?.[0]?.message;
    const toolCalls: LLMChatToolCall[] | undefined = Array.isArray(msg?.tool_calls)
      ? msg!.tool_calls!
          .filter(tc => tc && tc.function && typeof tc.function.name === "string")
          .map((tc, i) => ({
            id: tc.id || `tool_${i}`,
            name: tc.function!.name as string,
            arguments: typeof tc.function!.arguments === "string" ? tc.function!.arguments : "{}",
          }))
      : undefined;
    return {
      content: msg?.content || "",
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens,
        completion_tokens: data.usage?.completion_tokens,
      },
    };
  }
}

// ─── Tool-call loop ─────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolRegistry;
  /** Cap on tool calls. Default 30. */
  maxToolCalls?: number;
  /** Per-call timeout (ms). Default 60_000. */
  timeoutMs?: number;
  /** Optional sink for per-call audit. Useful in tests. */
  onToolCall?: (call: { name: string; args: Record<string, unknown>; result: unknown }) => void;
}

export interface ToolLoopResult {
  /** Final assistant content when the model produced one. */
  content: string;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** True when the loop hit maxToolCalls before the model produced a final answer. */
  budget_exceeded: boolean;
}

/**
 * Run a bounded tool-call loop. Sends an initial user message; on each
 * response that includes tool_calls, dispatches every call through the
 * registry, appends results, and re-prompts. Returns when the model
 * produces a tool-call-free response or the budget is exhausted.
 *
 * Errors during tool dispatch are reported BACK to the model as tool
 * results so it can recover (retry with corrected args, pick a different
 * tool, etc.) rather than crashing the loop.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const max = opts.maxToolCalls ?? 30;
  const messages: LLMChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userPrompt },
  ];
  const specs: LLMChatToolSpec[] = Object.values(opts.tools).map(t => t.spec);

  let toolCallCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let iter = 0; iter <= max; iter++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    let resp: LLMChatResponse;
    try {
      resp = await opts.provider.chat(
        {
          model: opts.model,
          messages,
          temperature: 0.0,
          max_output: 4096,
          tools: specs,
          tool_choice: "auto",
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    promptTokens += resp.usage.prompt_tokens || 0;
    completionTokens += resp.usage.completion_tokens || 0;

    const calls = resp.tool_calls;
    if (!calls || calls.length === 0) {
      // Final answer.
      return {
        content: resp.content,
        tool_calls: toolCallCount,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        budget_exceeded: false,
      };
    }
    // Bound check.
    if (toolCallCount + calls.length > max) {
      return {
        content: resp.content || "",
        tool_calls: toolCallCount + calls.length,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        budget_exceeded: true,
      };
    }
    // Append the assistant's tool_calls turn so providers that need history
    // (OpenAI does) see the full conversation.
    messages.push({
      role: "assistant",
      content: resp.content || "",
      tool_calls: calls,
    });
    // Dispatch each call sequentially. Errors become tool results so the
    // model can adjust on the next turn.
    for (const tc of calls) {
      toolCallCount++;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments) as Record<string, unknown>; }
      catch { args = {}; }
      const tool = opts.tools[tc.name];
      let result: unknown;
      if (!tool) {
        result = { error: `unknown tool: ${tc.name}` };
      } else {
        try { result = await tool.fn(args); }
        catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          result = { error: m.slice(0, 256) };
        }
      }
      if (opts.onToolCall) opts.onToolCall({ name: tc.name, args, result });
      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: tc.id,
        name: tc.name,
      });
    }
  }
  // Loop bound exhausted without a tool-free response.
  return {
    content: "",
    tool_calls: toolCallCount,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    budget_exceeded: true,
  };
}
