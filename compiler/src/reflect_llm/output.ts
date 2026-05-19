/**
 * MarrowScript LLM-Driven Reflection — output merging (Phase 20 v2)
 *
 * Takes the Phase 20 v1 entity stub (AST-only) and merges in the LLM-
 * inferred capabilities. The output is a richer .marrow source that
 * includes capability declarations alongside the entity declarations the
 * static analyzer found.
 *
 * The merge is conservative:
 *   - Only entities the static analyzer found are emitted as `entity {...}`.
 *   - Inferred capabilities are emitted as `capability { ... }` blocks.
 *   - Each capability gets a `// inferred (confidence: <high|medium|low>)`
 *     comment so the reviewer can prioritise.
 *   - Effects use serialised `target = expr` syntax to match the existing
 *     grammar.
 *   - The header banner makes it explicit the file is a draft.
 */

import type { ReflectedEntity, ReflectionResult } from "../reflect";
import type { InferredCapability, ReflectionLLMResult } from "./types";
import type { InferredStateMachine, StateMachineInferenceResult } from "./state_machines";

/**
 * Emit an enriched .marrow stub combining static-analysis entities with
 * LLM-inferred capabilities. The system block contains every entity (sorted
 * alphabetically by name) followed by every capability (sorted by entity
 * then by name) so the file diffs cleanly across runs.
 *
 * Determinism: capabilities sorted by (entity, name); within a capability,
 * params and effects keep declaration order (the LLM picked them).
 */
export function emitEnrichedStub(
  systemName: string,
  staticResult: ReflectionResult,
  llm: ReflectionLLMResult,
  sm?: StateMachineInferenceResult,
): string {
  const lines: string[] = [];
  lines.push("// Inferred from TypeScript source by `marrowc reflect-llm`. Review before merging.");
  lines.push("// Static analysis recovered entities; the LLM proposed capabilities.");
  lines.push("// Confidence ratings on each capability come from the model's self-rating.");
  lines.push(`// Tool calls: ${llm.trace.tool_calls}, tokens: ${llm.trace.total_prompt_tokens + llm.trace.total_completion_tokens}${llm.trace.budget_exceeded ? " (budget exceeded — partial result)" : ""}`);
  lines.push("");
  lines.push(`system ${systemName} {`);

  // Sort entities alphabetically for stable output.
  const entitiesByName = new Map(staticResult.entities.map(e => [e.name, e]));
  const sortedEntityNames = [...entitiesByName.keys()].sort();
  // Build lookup of inferred state machines by entity name.
  const smByEntity = new Map<string, InferredStateMachine>();
  if (sm && sm.state_machines) {
    for (const s of sm.state_machines) {
      if (!smByEntity.has(s.entity)) smByEntity.set(s.entity, s);
    }
  }
  for (const name of sortedEntityNames) {
    const e = entitiesByName.get(name)!;
    emitEntityBlock(lines, e, smByEntity.get(name));
    lines.push("");
  }

  // Capabilities sorted by entity, then by name. Inferred ones come at the
  // bottom of the system body so they're easy to scan in review.
  const sortedCaps = [...llm.capabilities].sort((a, b) =>
    a.entity.localeCompare(b.entity) || a.name.localeCompare(b.name),
  );
  if (sortedCaps.length > 0) {
    lines.push("  // ── Inferred capabilities ──────────────────────────────────────────");
    lines.push("");
    for (const cap of sortedCaps) {
      emitCapabilityBlock(lines, cap);
      lines.push("");
    }
  }

  if (sortedEntityNames.length === 0 && sortedCaps.length === 0) {
    lines.push("  // No entities or capabilities recovered.");
  }
  lines.push("}");
  return lines.join("\n");
}

function emitEntityBlock(lines: string[], e: ReflectedEntity, stateMachine?: InferredStateMachine): void {
  lines.push(`  // From: ${e.source_file}`);
  lines.push(`  entity ${e.name} {`);
  lines.push("    owns: [");
  // Skip ontology fields — type checker adds them automatically.
  const keep = e.fields.filter(f => f.name !== "id" && f.name !== "created_at" && f.name !== "updated_at");
  for (let i = 0; i < keep.length; i++) {
    const f = keep[i];
    const type = f.optional ? `optional<${f.type}>` : f.type;
    const trailing = i < keep.length - 1 ? "," : "";
    lines.push(`      ${f.name}: ${type}${trailing}`);
  }
  lines.push("    ]");
  // Phase 20 v2.5: emit inferred state machine if available.
  if (stateMachine && stateMachine.states.length >= 2) {
    lines.push(`    // inferred state machine on field '${stateMachine.field}' (confidence: ${stateMachine.confidence})`);
    // Build MarrowScript state graph syntax: s1 -> s2 -> s3 | s4
    // For now, emit a linear chain with branch using `|` for alternatives.
    const transitions = stateMachine.transitions;
    const stateList = stateMachine.states;
    // Group by from-state.
    const grouped = new Map<string, string[]>();
    for (const t of transitions) {
      if (!grouped.has(t.from)) grouped.set(t.from, []);
      grouped.get(t.from)!.push(t.to);
    }
    // Build the graph string. Emit each state, with -> for sequential and | for branches.
    const parts: string[] = [];
    for (const st of stateList) {
      const targets = grouped.get(st);
      if (!targets || targets.length === 0) {
        parts.push(st);
      } else if (targets.length === 1) {
        parts.push(`${st} -> ${targets[0]}`);
      } else {
        // Branch: s -> a | b
        parts.push(`${st} -> ${targets.join(" | ")}`);
      }
    }
    // Deduplicate: if a state already appeared as a target, don't re-emit it.
    // Simple approach: use the raw state graph string the MarrowScript parser expects.
    // MarrowScript syntax: states: initial -> next -> final | alternate
    // We'll emit the full transition map as-is for the reviewer to clean up.
    lines.push(`    states: ${stateList.join(" -> ")}`);
  }
  lines.push("  }");
}

function emitCapabilityBlock(lines: string[], cap: InferredCapability): void {
  lines.push(`  // From: ${cap.source_file}:${cap.source_line}`);
  lines.push(`  // inferred (confidence: ${cap.confidence})`);
  // Build the parameter list. v2 emits inferred parameters as-is; the
  // type checker will reject any that don't resolve, which surfaces the
  // problem to the reviewer.
  const paramList = cap.params.map(p => `${p.name}: ${p.type}`).join(", ");
  lines.push(`  capability ${cap.name}(${paramList}) {`);
  if (cap.requires.length > 0) {
    lines.push("    requires: [");
    for (let i = 0; i < cap.requires.length; i++) {
      const trailing = i < cap.requires.length - 1 ? "," : "";
      lines.push(`      ${cap.requires[i]}${trailing}`);
    }
    lines.push("    ]");
  }
  if (cap.effects.length > 0) {
    lines.push("    effects: [");
    for (let i = 0; i < cap.effects.length; i++) {
      const eff = cap.effects[i];
      const opStr = eff.op === "assign" ? "=" : eff.op === "add" ? "+=" : "-=";
      const trailing = i < cap.effects.length - 1 ? "," : "";
      lines.push(`      ${eff.target} ${opStr} ${eff.value}${trailing}`);
    }
    lines.push("    ]");
  }
  lines.push("    sync: eventual");
  lines.push("    idempotent: false");
  lines.push("  }");
}

// ─── Validation: keep merge results sane before returning to the user ──────

/**
 * Filter LLM-inferred capabilities to drop ones that won't survive the
 * type checker. Conservative: we keep capabilities whose entity exists
 * in the static-analysis result (the type checker would reject the rest
 * with T002 / T006 anyway). Returns a FILTERED ReflectionLLMResult plus
 * a list of dropped names for the reviewer.
 */
export function filterInferredCapabilities(
  staticResult: ReflectionResult,
  llm: ReflectionLLMResult,
): { kept: ReflectionLLMResult; dropped: { capability: string; reason: string }[] } {
  const knownEntities = new Set(staticResult.entities.map(e => e.name));
  const kept: InferredCapability[] = [];
  const dropped: { capability: string; reason: string }[] = [];
  for (const cap of llm.capabilities) {
    if (!knownEntities.has(cap.entity)) {
      dropped.push({ capability: cap.name, reason: `unknown entity '${cap.entity}'` });
      continue;
    }
    if (cap.name.length === 0 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cap.name)) {
      dropped.push({ capability: cap.name, reason: "invalid identifier" });
      continue;
    }
    // De-duplicate by name. The model occasionally proposes the same
    // capability twice with slightly different signatures — keep the first.
    if (kept.some(k => k.name === cap.name)) {
      dropped.push({ capability: cap.name, reason: "duplicate name" });
      continue;
    }
    kept.push(cap);
  }
  return {
    kept: { capabilities: kept, trace: llm.trace },
    dropped,
  };
}
