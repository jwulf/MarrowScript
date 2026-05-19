/**
 * MarrowScript LLM-Driven Reflection — state machine inference (Phase 20 v2.5)
 *
 * A second inference pass that asks the model to find entity state machines
 * (lifecycle transitions) in the project. Runs AFTER the capability pass
 * so it can reference discovered capabilities as transition triggers.
 *
 * The model walks code looking for:
 *   - Enum-like status/state fields on entities
 *   - Switch/if statements that guard transitions
 *   - Method names that imply lifecycle (create → activate → close → archive)
 *   - Field assignments like `order.status = "shipped"`
 *
 * Output: `InferredStateMachine[]` — each carrying entity name, states,
 * transitions (from → to with optional trigger), and a confidence rating.
 *
 * Architecture: reuses the same tool-call loop + registry from v2; only
 * the system prompt + response parser differ. Under 200 lines.
 */

import { runToolLoop } from "./llm";
import { buildToolRegistry } from "./tools";
import type { LLMProvider, ToolRegistry } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InferredTransition {
  from: string;
  to: string;
  /** Optional: the capability name that triggers this transition. */
  trigger: string | null;
}

export interface InferredStateMachine {
  entity: string;
  /** The field that holds the state (e.g. "status", "state"). */
  field: string;
  /** Unique state names in lifecycle order (initial first). */
  states: string[];
  transitions: InferredTransition[];
  source_file: string;
  confidence: "high" | "medium" | "low";
}

export interface StateMachineInferenceResult {
  state_machines: InferredStateMachine[];
  trace: {
    tool_calls: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    budget_exceeded: boolean;
  };
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SM_SYSTEM_PROMPT = `You are a code analysis assistant. Your job is to find entity state machines (lifecycle transitions) in a TypeScript project.

Use the provided tools to read code. Look for:
  - Enum-like status/state fields on entities (string union types, enum declarations)
  - Switch/if blocks that guard or trigger state changes
  - Field assignments like \`entity.status = "shipped"\`
  - Method/function names that imply lifecycle steps (create, activate, ship, close, archive)

For each state machine you find, report:
  - entity: the entity name (must be from the provided list)
  - field: the field that holds the state (e.g. "status")
  - states: unique state values in lifecycle order (initial state first)
  - transitions: list of {from, to, trigger} — trigger is the capability/function name that causes the transition (null if unclear)
  - source_file: the relative path where the state field is declared
  - confidence: "high" if explicit (enum + switch), "medium" if implied (string literals), "low" if guessing

Output ONLY a single JSON object:
{
  "state_machines": [
    {"entity": "...", "field": "...", "states": [...], "transitions": [...], "source_file": "...", "confidence": "..."}
  ]
}

Better to return fewer high-confidence state machines than many guesses.`;

function buildSMUserPrompt(entities: string[], capabilities: string[]): string {
  const entityList = entities.map(e => `  - ${e}`).join("\n");
  const capList = capabilities.length > 0
    ? `\n\nCapabilities already discovered:\n${capabilities.map(c => `  - ${c}`).join("\n")}`
    : "";
  return `Find state machines (entity lifecycles) in the project.\n\nEntities:\n${entityList}${capList}\n\nUse list_directory + read_file + find_references to locate status/state fields and their transitions. End with the JSON object.`;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

export function parseSMOutput(content: string): InferredStateMachine[] {
  if (!content) return [];
  const fenceMatch = content.match(/```json\s*([\s\S]*?)```/);
  let candidate = fenceMatch ? fenceMatch[1] : null;
  if (!candidate) {
    const lastBrace = content.lastIndexOf("}");
    const firstBrace = content.indexOf("{");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = content.slice(firstBrace, lastBrace + 1);
    }
  }
  if (!candidate) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as { state_machines?: unknown };
  if (!Array.isArray(obj.state_machines)) return [];
  const out: InferredStateMachine[] = [];
  for (const raw of obj.state_machines) {
    const sm = projectSM(raw);
    if (sm) out.push(sm);
  }
  return out;
}

function projectSM(raw: unknown): InferredStateMachine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entity = String(r.entity ?? "");
  const field = String(r.field ?? "");
  const sourceFile = String(r.source_file ?? "");
  const confidence = String(r.confidence ?? "low");
  if (!entity || !field || !sourceFile) return null;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return null;
  if (!Array.isArray(r.states) || r.states.length < 2) return null;
  const states = (r.states as unknown[]).filter(s => typeof s === "string") as string[];
  if (states.length < 2) return null;
  const transitions: InferredTransition[] = [];
  if (Array.isArray(r.transitions)) {
    for (const t of r.transitions) {
      if (!t || typeof t !== "object") continue;
      const tt = t as Record<string, unknown>;
      const from = String(tt.from ?? "");
      const to = String(tt.to ?? "");
      if (!from || !to) continue;
      if (!states.includes(from) || !states.includes(to)) continue;
      transitions.push({ from, to, trigger: typeof tt.trigger === "string" ? tt.trigger : null });
    }
  }
  return {
    entity,
    field,
    states,
    transitions,
    source_file: sourceFile,
    confidence: confidence as "high" | "medium" | "low",
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface SMInferenceOptions {
  root: string;
  provider: LLMProvider;
  model: string;
  entities: string[];
  /** Capability names from the v2 pass — helps the model identify triggers. */
  capabilities: string[];
  maxToolCalls?: number;
  timeoutMs?: number;
}

/**
 * Run the state-machine inference pass. Same tool-call loop as v2, different
 * prompt + parser. Returns empty when no entities or no state machines found.
 */
export async function inferStateMachines(opts: SMInferenceOptions): Promise<StateMachineInferenceResult> {
  if (opts.entities.length === 0) {
    return { state_machines: [], trace: { tool_calls: 0, total_prompt_tokens: 0, total_completion_tokens: 0, budget_exceeded: false } };
  }
  const tools = buildToolRegistry(opts.root);
  const loop = await runToolLoop({
    provider: opts.provider,
    model: opts.model,
    systemPrompt: SM_SYSTEM_PROMPT,
    userPrompt: buildSMUserPrompt(opts.entities, opts.capabilities),
    tools,
    maxToolCalls: opts.maxToolCalls ?? 20,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  const stateMachines = parseSMOutput(loop.content);
  // Filter: only keep SMs whose entity is in the provided list.
  const validEntities = new Set(opts.entities);
  const kept = stateMachines.filter(sm => validEntities.has(sm.entity));
  return {
    state_machines: kept,
    trace: {
      tool_calls: loop.tool_calls,
      total_prompt_tokens: loop.prompt_tokens,
      total_completion_tokens: loop.completion_tokens,
      budget_exceeded: loop.budget_exceeded,
    },
  };
}
