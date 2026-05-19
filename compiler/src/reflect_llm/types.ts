/**
 * MarrowScript LLM-Driven Reflection — shared types (Phase 20 v2)
 *
 * The cognition layer in the GENERATED project has its own provider types.
 * Reflection runs in the COMPILER context (offline tooling), so we ship a
 * small parallel set of types here. The shapes mirror the runtime ones
 * intentionally — easier to swap in the runtime provider later if we want
 * to share code, and the JSON-on-the-wire format stays identical.
 */

// ─── LLM provider (standalone) ──────────────────────────────────────────────

export interface LLMChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LLMChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMChatToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string from the model. The runtime parses + validates. */
  arguments: string;
}

export interface LLMChatToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface LLMChatRequest {
  model: string;
  messages: LLMChatMessage[];
  temperature?: number;
  max_output?: number;
  tools?: LLMChatToolSpec[];
  tool_choice?: "auto" | "required" | "none";
}

export interface LLMChatResponse {
  content: string;
  tool_calls?: LLMChatToolCall[];
  usage: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LLMProvider {
  chat(req: LLMChatRequest, signal?: AbortSignal): Promise<LLMChatResponse>;
}

// ─── Inference results ──────────────────────────────────────────────────────

/**
 * One capability inferred from source. v2 captures the contract — name,
 * entity it operates on, parameter list, best-effort effects + preconditions,
 * source location, and a confidence rating the user can use to decide
 * which to merge.
 */
export interface InferredCapability {
  name: string;
  /** Entity name this capability operates on. */
  entity: string;
  /** Parameter list as the LLM observed them (best effort). */
  params: { name: string; type: string }[];
  /**
   * Effect tuples — `target` is a field path, `op` is assign/add/remove,
   * `value` is a serialised expression. Best-effort: the LLM may report
   * effects it can't pin down precisely; we surface them anyway.
   */
  effects: { target: string; op: "assign" | "add" | "remove"; value: string }[];
  /** Preconditions extracted from guard clauses (e.g. `if (x === null) throw`). */
  requires: string[];
  /** Source location where the capability was found. */
  source_file: string;
  source_line: number;
  /**
   * Self-rated by the LLM. "high" means the source was clear and explicit
   * (e.g. a function with typed signature + obvious effect); "low" means
   * the model is guessing. Reviewers can filter on this.
   */
  confidence: "high" | "medium" | "low";
}

export interface ReflectionLLMResult {
  capabilities: InferredCapability[];
  /** Tool-call stats for audit / debug. */
  trace: {
    tool_calls: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    /** True when the loop hit the configured cap before the model returned a final answer. */
    budget_exceeded: boolean;
  };
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

/** A tool implementation. Returns a JSON-serialisable result. */
export type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

/** Closed registry of tools. Keys are the names the model invokes. */
export type ToolRegistry = Record<string, { spec: LLMChatToolSpec; fn: ToolFn }>;

// ─── CLI / library options ──────────────────────────────────────────────────

export interface ReflectLLMOptions {
  /** Project root to walk. Required. */
  root: string;
  /** Override the default provider. Tests inject a fake here. */
  provider?: LLMProvider;
  /** Override the model name (default: env LLM_REFLECT_MODEL). */
  model?: string;
  /** Cap on tool calls per inference run. Default 30. */
  maxToolCalls?: number;
  /** Per-call timeout (ms). Default 60000. */
  timeoutMs?: number;
  /**
   * Optional list of entity names to focus on. When omitted, runs against
   * every entity discovered by Phase 20 v1's reflectProject.
   */
  entities?: string[];
}
