/**
 * MarrowScript LLM-Driven Reflection — orchestrator (Phase 20 v2)
 *
 * Top-level entry that runs Phase 20 v1's static analysis to recover
 * entities, then prompts an LLM to walk the project via a closed tool list
 * and infer capabilities operating on those entities.
 *
 * The LLM-driven inference is the v2 deliverable — capabilities,
 * preconditions, effects, and confidence ratings. State machine inference
 * is documented v2.5 work; the JSON contract here intentionally leaves
 * room for it to land additively later.
 *
 * Determinism boundary: this module IS where non-determinism enters the
 * compiler. The model picks tools, returns text, the JSON parser projects
 * it into typed shapes. Every other compiler module stays deterministic.
 * The user's review-before-merge workflow (Phase 20 v1's promise) keeps
 * the .marrow source deterministic from there on.
 */

import * as path from "path";
import { reflectProject, type ReflectionResult } from "./reflect";
import { OpenAICompatProvider, runToolLoop } from "./reflect_llm/llm";
import { buildToolRegistry } from "./reflect_llm/tools";
import { emitEnrichedStub, filterInferredCapabilities } from "./reflect_llm/output";
import { inferStateMachines, type InferredStateMachine, type StateMachineInferenceResult } from "./reflect_llm/state_machines";
import type {
  InferredCapability,
  ReflectionLLMResult,
  ReflectLLMOptions,
} from "./reflect_llm/types";

// Re-exports so the CLI doesn't need to know the internal layout.
export type { InferredCapability, ReflectionLLMResult, ReflectLLMOptions } from "./reflect_llm/types";
export type { InferredStateMachine, StateMachineInferenceResult } from "./reflect_llm/state_machines";
export { OpenAICompatProvider } from "./reflect_llm/llm";
export { emitEnrichedStub } from "./reflect_llm/output";
export { parseSMOutput } from "./reflect_llm/state_machines";

// ─── Prompt template ────────────────────────────────────────────────────────

/**
 * The system prompt is deliberately strict. We want the model to:
 *   1. Use the provided tools to read code rather than hallucinate
 *   2. Output a specific JSON shape
 *   3. Mark its confidence honestly
 *
 * Output-format instruction matches the parser in parseLLMOutput below.
 */
const SYSTEM_PROMPT = `You are a code analysis assistant. Your job is to find capabilities (functions or methods that operate on the given entities) in a TypeScript project and report them as structured JSON.

Use the provided tools to read code. Do not guess. If you can't find evidence in the source, mark confidence as "low".

For each capability you find, report:
  - name: the function/method name
  - entity: the entity it operates on (must be one from the provided list)
  - params: list of {name, type} pairs
  - effects: list of {target: "<entity>.<field>", op: "assign"|"add"|"remove", value: "<expression>"} — best effort
  - requires: list of preconditions as strings (e.g. "name != \\"\\"")
  - source_file: the relative path
  - source_line: 1-based line number where the function/method declaration starts
  - confidence: "high" if the source is explicit, "medium" if you inferred from context, "low" if you're guessing

Output ONLY a single JSON object on the last line of your response with this shape:
{
  "capabilities": [
    {"name": "...", "entity": "...", "params": [...], "effects": [...], "requires": [...], "source_file": "...", "source_line": ..., "confidence": "..."}
  ]
}

Use the tools to verify each capability's signature before reporting it. Better to return fewer high-confidence capabilities than many guesses.`;

function buildUserPrompt(entities: string[]): string {
  const entityList = entities.map(e => `  - ${e}`).join("\n");
  return `Analyze the project. Entities found by static analysis:\n${entityList}\n\nReport every capability you can find that operates on one of these entities. Use list_directory to start, then read_file / find_function / find_class / find_references to drill in. End with the JSON object on its own line.`;
}

// ─── Result parser ──────────────────────────────────────────────────────────

/**
 * Pull the last JSON object out of the LLM's content. The model is
 * instructed to put it on the last line, but we forgive trailing
 * whitespace and prose. Fallback: extract from the largest fenced
 * block. Returns an empty list when nothing parses.
 */
export function parseLLMOutput(content: string): InferredCapability[] {
  if (!content) return [];
  // First pass: try the last fenced block tagged json.
  const fenceMatch = content.match(/```json\s*([\s\S]*?)```/);
  let candidate = fenceMatch ? fenceMatch[1] : null;
  if (!candidate) {
    // Second pass: grab the last balanced top-level object.
    const lastBrace = content.lastIndexOf("}");
    const firstBrace = content.indexOf("{");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = content.slice(firstBrace, lastBrace + 1);
    }
  }
  if (!candidate) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as { capabilities?: unknown };
  if (!Array.isArray(obj.capabilities)) return [];
  const out: InferredCapability[] = [];
  for (const raw of obj.capabilities) {
    const cap = projectInferredCapability(raw);
    if (cap) out.push(cap);
  }
  return out;
}

/** Validate one record from the parsed JSON; drop anything malformed. */
function projectInferredCapability(raw: unknown): InferredCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "");
  const entity = String(r.entity ?? "");
  const sourceFile = String(r.source_file ?? "");
  const sourceLine = Number(r.source_line ?? 0);
  const confidence = String(r.confidence ?? "low");
  if (!name || !entity || !sourceFile) return null;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return null;
  const params: { name: string; type: string }[] = [];
  if (Array.isArray(r.params)) {
    for (const p of r.params) {
      if (p && typeof p === "object") {
        const pp = p as Record<string, unknown>;
        if (typeof pp.name === "string" && typeof pp.type === "string") {
          params.push({ name: pp.name, type: pp.type });
        }
      }
    }
  }
  const effects: { target: string; op: "assign" | "add" | "remove"; value: string }[] = [];
  if (Array.isArray(r.effects)) {
    for (const e of r.effects) {
      if (e && typeof e === "object") {
        const ee = e as Record<string, unknown>;
        const op = String(ee.op ?? "");
        if (op !== "assign" && op !== "add" && op !== "remove") continue;
        if (typeof ee.target !== "string" || typeof ee.value !== "string") continue;
        effects.push({ target: ee.target, op, value: ee.value });
      }
    }
  }
  const requires: string[] = [];
  if (Array.isArray(r.requires)) {
    for (const x of r.requires) if (typeof x === "string") requires.push(x);
  }
  return {
    name,
    entity,
    params,
    effects,
    requires,
    source_file: sourceFile,
    source_line: Number.isFinite(sourceLine) ? Math.max(1, sourceLine) : 1,
    confidence: confidence as "high" | "medium" | "low",
  };
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Run LLM-driven inference against a project. Returns:
 *   - the static-analysis result (Phase 20 v1)
 *   - the LLM-inferred capabilities (Phase 20 v2)
 *
 * The caller decides what to do with them — `marrowc reflect-llm` writes a
 * stub to disk; library users can do something else.
 */
export async function reflectProjectWithLLM(
  options: ReflectLLMOptions,
): Promise<{ static_result: ReflectionResult; llm_result: ReflectionLLMResult; sm_result: StateMachineInferenceResult }> {
  const root = path.resolve(options.root);
  const provider = options.provider ?? new OpenAICompatProvider();
  const model = options.model ?? process.env.LLM_REFLECT_MODEL ?? "gpt-4o-mini";

  // Phase 20 v1 — static analysis.
  const staticResult = reflectProject(root);

  // No entities → nothing to infer capabilities for.
  if (staticResult.entities.length === 0) {
    return {
      static_result: staticResult,
      llm_result: {
        capabilities: [],
        trace: { tool_calls: 0, total_prompt_tokens: 0, total_completion_tokens: 0, budget_exceeded: false },
      },
      sm_result: {
        state_machines: [],
        trace: { tool_calls: 0, total_prompt_tokens: 0, total_completion_tokens: 0, budget_exceeded: false },
      },
    };
  }

  // Optionally narrow to a user-provided entity list.
  const entityNames = options.entities && options.entities.length > 0
    ? staticResult.entities.filter(e => options.entities!.includes(e.name)).map(e => e.name)
    : staticResult.entities.map(e => e.name);

  const tools = buildToolRegistry(root);
  const loop = await runToolLoop({
    provider,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(entityNames),
    tools,
    maxToolCalls: options.maxToolCalls ?? 30,
    timeoutMs: options.timeoutMs ?? 60_000,
  });

  const capabilities = parseLLMOutput(loop.content);
  const llm: ReflectionLLMResult = {
    capabilities,
    trace: {
      tool_calls: loop.tool_calls,
      total_prompt_tokens: loop.prompt_tokens,
      total_completion_tokens: loop.completion_tokens,
      budget_exceeded: loop.budget_exceeded,
    },
  };
  // Filter capabilities so the emitted stub is reviewer-friendly: drop
  // duplicates, unknown entities, malformed names. The trace stats stay
  // intact so the reviewer can see how much the model actually did.
  const filtered = filterInferredCapabilities(staticResult, llm);

  // Phase 20 v2.5: state machine inference. Runs after capabilities so the
  // SM prompt can reference discovered capability names as potential triggers.
  const smResult = await inferStateMachines({
    root,
    provider,
    model,
    entities: entityNames,
    capabilities: filtered.kept.capabilities.map(c => c.name),
    maxToolCalls: Math.min(options.maxToolCalls ?? 20, 20),
    timeoutMs: options.timeoutMs ?? 60_000,
  });

  return { static_result: staticResult, llm_result: filtered.kept, sm_result: smResult };
}
