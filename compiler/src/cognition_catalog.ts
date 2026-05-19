/**
 * MarrowScript Cognition Catalog (LLM Harness, Phase 2)
 *
 * Mirrors compiler/src/algorithm_catalog.ts. A closed registry of named
 * cognition primitives. Each entry has:
 *   - inputs: typed parameters the user must bind via `using { ... }`
 *   - output: declared output type
 *   - description: human-readable explanation
 *   - cost / latency annotation: rough envelope for the runtime budget gauges
 *   - emit: deterministic implementation that calls into the runtime via the
 *     typed prompt registry (see compiler/src/emit_cognition.ts)
 *
 * NEW cognition primitives can ONLY be added by extending this catalog. The
 * compiler never invents implementations — it picks from this list. This
 * keeps the runtime auditable and prevents primitive sprawl.
 *
 * Determinism: the emit function returns deterministic TypeScript. No
 * Date.now(), no Math.random(). Same bindings always produce identical
 * output.
 */

export interface CognitionSpec {
  name: string;
  category: "memory" | "retrieval" | "routing" | "validation" | "aggregation" | "recovery" | "planning" | "ingestion";
  description: string;
  /**
   * Declared inputs. The user must bind every required input in `using {...}`.
   * Type strings here are documentation, not enforced at compile time (the
   * type checker resolves binding values, but their TS-level type is opaque).
   */
  inputs: { name: string; type: string; description: string; required: boolean }[];
  /** Declared output type. */
  output: { type: string; description: string };
  /** Rough annotation for budget / routing decisions. */
  cost: "free" | "tiny" | "small" | "medium" | "large";
  /** Whether this primitive calls a model at all. Pure primitives do not. */
  callsModel: boolean;
  /**
   * Emit a self-contained TypeScript function body that implements the
   * primitive. The function signature is wired by the cognition emitter:
   *   async function <camelName>(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown>
   * `ctx` exposes the prompt registry, model registry, logger, and metrics.
   */
  emit: () => string;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const CATALOG: Record<string, CognitionSpec> = {
  // ─── Ingestion ─────────────────────────────────────────────────────────────

  ingest_repository: {
    name: "ingest_repository",
    category: "ingestion",
    description:
      "Clone a Git repository into a sandboxed local cache and run safety checks before any downstream cognition primitive (indexer / compressor / generator) touches the tree. Bounded by size + file-count ceilings, deny-list aware, deterministic by (url, ref). The cloned tree is read-only — no scripts from the repo are ever executed. Used as the first step of any forge pipeline that takes GitHub URLs as input.",
    inputs: [
      { name: "url", type: "string", description: "Git URL (https://). Must match LLM_INGEST_ALLOWLIST.", required: true },
      { name: "ref", type: "string", description: "Branch / tag / commit-ish. Default: HEAD.", required: false },
      { name: "max_bytes", type: "number", description: "Override the per-clone byte ceiling (LLM_INGEST_MAX_BYTES).", required: false },
      { name: "max_files", type: "number", description: "Override the per-clone file-count ceiling (LLM_INGEST_MAX_FILES).", required: false },
      { name: "timeout_ms", type: "number", description: "Override the per-clone timeout (LLM_INGEST_TIMEOUT_MS).", required: false },
    ],
    output: {
      type: "{ local_path: string; head_sha: string; file_count: number; total_bytes: number; url_redacted: string; ref: string; ingested_at: number; indexer_root: string }",
      description: "An IngestReport. local_path is read-only and lives under LLM_INGEST_ROOT. Pass indexer_root straight to the semantic indexer.",
    },
    cost: "free",
    callsModel: false,
    emit: () => `
async function ingest_repository(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  // The actual implementation lives in src/cognition/ingest.ts so it can be
  // unit-tested and audited outside the catalog spec template. We just wire
  // the typed binding values into the runtime call here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ingestRepository } = require("./ingest") as typeof import("./ingest");
  const url = String(args.url || "");
  if (!url) throw new Error("ingest_repository: missing required input 'url'");
  const opts: Record<string, unknown> = {};
  if (args.ref !== undefined) opts.ref = String(args.ref);
  if (typeof args.max_bytes === "number") opts.max_bytes = args.max_bytes;
  if (typeof args.max_files === "number") opts.max_files = args.max_files;
  if (typeof args.timeout_ms === "number") opts.timeout_ms = args.timeout_ms;
  ctx.metrics.counter("cognition.ingest_repository", { ref: String(args.ref || "HEAD") });
  return await ingestRepository(url, opts);
}
`.trim() + "\n",
  },

  // ─── Memory ────────────────────────────────────────────────────────────────

  compress_context: {
    name: "compress_context",
    category: "memory",
    description:
      "Reduce a conversation history or document body to fit a target token budget. Default strategy is `summarize_oldest`: keep the most recent messages verbatim and summarise the older ones in a single pass.",
    inputs: [
      { name: "history", type: "string | string[]", description: "messages or document body", required: true },
      { name: "target_tokens", type: "number", description: "rough output budget", required: true },
      { name: "strategy", type: "'summarize_oldest' | 'drop_oldest' | 'hierarchical_summarize'", description: "compression strategy", required: false },
    ],
    output: { type: "string[]", description: "compressed messages, oldest first" },
    cost: "small",
    callsModel: true,
    emit: () => `
async function compress_context(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const history = args.history;
  const target = Number(args.target_tokens) || 2000;
  const strategy = (args.strategy as string) || "summarize_oldest";
  const messages: string[] = Array.isArray(history)
    ? history.map(m => String(m))
    : typeof history === "string"
      ? history.split(/\\n{2,}/g)
      : [String(history)];

  // Approximate token count (4 chars per token). Best-effort, not a security
  // boundary — just a rough budget signal.
  const tokensOf = (s: string) => Math.ceil(s.length / 4);
  const total = messages.reduce((acc, m) => acc + tokensOf(m), 0);
  if (total <= target) return messages;

  if (strategy === "drop_oldest") {
    const result: string[] = [];
    let acc = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = tokensOf(messages[i]);
      if (acc + t > target) break;
      result.unshift(messages[i]);
      acc += t;
    }
    ctx.metrics.counter("cognition.compress.dropped", { strategy });
    return result;
  }

  // summarize_oldest (default) and hierarchical_summarize:
  // split into older / newer halves, summarise the older half in one pass,
  // and combine. The summariser is whichever model the harness's default
  // summariser prompt resolves to (set by the user in their .marrow file).
  const split = Math.floor(messages.length / 2);
  const older = messages.slice(0, split).join("\\n\\n");
  const newer = messages.slice(split);
  const summarizerPrompt = ctx.prompts.findSummarizer();
  if (!summarizerPrompt) {
    // No summariser registered — fall back to drop_oldest to stay within budget.
    ctx.logger.warn("cognition_compress_no_summarizer", { event: "compress_context", status: "rejected" });
    return newer;
  }
  const summary = await summarizerPrompt({ body: older, max_tokens: Math.floor(target / 4) }, ctx);
  ctx.metrics.counter("cognition.compress.summarised", { strategy });
  return [String(summary), ...newer];
}
`.trim() + "\n",
  },

  // ─── Retrieval ────────────────────────────────────────────────────────────

  semantic_slice: {
    name: "semantic_slice",
    category: "retrieval",
    description:
      "Bounded graph-based retrieval: walk the symbol/dependency graph from a task description outward to `hop_depth`, capped at `max_files`. Never dumps the whole repo. The graph itself is built by the memory layer (Phase 4); Phase 2 ships a trivial in-memory index for tests. Phase 10: optional `repos` filter restricts retrieval to one or more repo_ids — used by `forge_from_repos` to ask 'which files in repo A are relevant?' without dragging in repo B.",
    inputs: [
      { name: "task", type: "string", description: "task description", required: true },
      { name: "index", type: "object", description: "semantic index handle", required: true },
      { name: "max_files", type: "number", description: "upper bound on returned files", required: false },
      { name: "hop_depth", type: "number", description: "graph walk depth", required: false },
      { name: "repos", type: "string | string[]", description: "Phase 10 — limit retrieval to specific repo_ids. Omit to search all.", required: false },
    ],
    output: { type: "{ files: string[], symbols: string[], target_symbol: string }", description: "slice ready for prompt injection" },
    cost: "tiny",
    callsModel: false,
    emit: () => `
async function semantic_slice(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const task = String(args.task || "");
  const maxFiles = Number(args.max_files) || 8;
  const hopDepth = Number(args.hop_depth) || 2;
  // Phase 10: optional repo filter — single string or array. Threaded through
  // the index's walk() so the BFS never crosses repo_id boundaries.
  const repoFilter = args.repos === undefined
    ? undefined
    : (typeof args.repos === "string" ? args.repos : (Array.isArray(args.repos) ? args.repos as string[] : undefined));
  // Either the user passes an index handle, or we fall back to the memory layer's singleton.
  const passed = (args.index as { walk?: (task: string, hops: number, cap: number, repos?: string | string[]) => { files: string[]; symbols: string[]; target_symbol?: string } }) || {};
  const useIndex = (typeof passed.walk === "function" ? passed : ctx.memory.getIndex()) as { walk?: (task: string, hops: number, cap: number, repos?: string | string[]) => { files: string[]; symbols: string[]; target_symbol?: string } } | null;

  if (useIndex && typeof useIndex.walk === "function") {
    const r = useIndex.walk(task, hopDepth, maxFiles, repoFilter);
    ctx.metrics.counter("cognition.semantic_slice", { source: "index", filtered: repoFilter ? "yes" : "no" });
    return { files: r.files, symbols: r.symbols, target_symbol: r.target_symbol ?? r.symbols[0] ?? "" };
  }

  // No index — return the empty slice. Phase 4 emits the memory layer when
  // a capability uses semantic_slice, so this branch is mostly defensive.
  ctx.metrics.counter("cognition.semantic_slice", { source: "stub" });
  return { files: [], symbols: [], target_symbol: "" };
}
`.trim() + "\n",
  },

  // ─── Routing ───────────────────────────────────────────────────────────────

  route_by_complexity: {
    name: "route_by_complexity",
    category: "routing",
    description:
      "Thin wrapper around a declared `router` decl. Resolves the routing input to a model id by walking the tier ladder.",
    inputs: [
      { name: "input", type: "object", description: "routing input — must expose the field referenced by router.by", required: true },
      { name: "router_name", type: "string", description: "declared router name", required: true },
    ],
    output: { type: "{ model_id: string, tier: string }", description: "selected tier" },
    cost: "free",
    callsModel: false,
    emit: () => `
async function route_by_complexity(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const routerName = String(args.router_name || "");
  const router = ctx.routers.get(routerName);
  if (!router) {
    throw new Error(\`Unknown router: \${routerName}\`);
  }
  const choice = router.route(args.input);
  ctx.metrics.counter("cognition.route", { router: routerName, tier: choice.tier });
  return choice;
}
`.trim() + "\n",
  },

  tool_select: {
    name: "tool_select",
    category: "routing",
    description:
      "Constrained tool selection: a small classifier picks from a closed list of allowed tools. Never lets the model invent a tool name. Returns null if the model picks something not on the list.",
    inputs: [
      { name: "task", type: "string", description: "task description", required: true },
      { name: "allowed_tools", type: "string[]", description: "closed list of tool names", required: true },
      { name: "classifier_prompt", type: "string", description: "name of the classifier prompt", required: true },
    ],
    output: { type: "{ tool_name: string | null }", description: "the chosen tool, or null if invalid" },
    cost: "small",
    callsModel: true,
    emit: () => `
async function tool_select(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const task = String(args.task || "");
  const allowed = Array.isArray(args.allowed_tools) ? (args.allowed_tools as string[]) : [];
  const promptName = String(args.classifier_prompt || "");
  const prompt = ctx.prompts.get(promptName);
  if (!prompt) {
    throw new Error(\`tool_select: classifier prompt not registered: \${promptName}\`);
  }
  const raw = await prompt({ task, allowed_tools: allowed }, ctx);
  const choice = typeof raw === "string" ? raw.trim() : "";
  if (!allowed.includes(choice)) {
    ctx.metrics.counter("cognition.tool_select.rejected", { prompt: promptName });
    ctx.logger.warn("tool_select_invalid_choice", { event: promptName, status: "rejected", metadata: { choice: choice.slice(0, 64) } });
    return { tool_name: null };
  }
  ctx.metrics.counter("cognition.tool_select.accepted", { prompt: promptName, tool: choice });
  return { tool_name: choice };
}
`.trim() + "\n",
  },

  // ─── Validation ────────────────────────────────────────────────────────────

  self_critique: {
    name: "self_critique",
    category: "validation",
    description:
      "Run a small validator model over a prior output and a list of declared criteria. Returns a structured report. Use as a `validate: custom:<extension_point>` body or in a recovery pipeline.",
    inputs: [
      { name: "output", type: "unknown", description: "the value to critique", required: true },
      { name: "criteria", type: "string[]", description: "criteria to check", required: true },
      { name: "validator_prompt", type: "string", description: "name of the validator prompt", required: true },
    ],
    output: { type: "{ ok: boolean, issues: string[] }", description: "structured critique" },
    cost: "small",
    callsModel: true,
    emit: () => `
async function self_critique(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const output = args.output;
  const criteria = Array.isArray(args.criteria) ? (args.criteria as string[]) : [];
  const promptName = String(args.validator_prompt || "");
  const prompt = ctx.prompts.get(promptName);
  if (!prompt) throw new Error(\`self_critique: validator prompt not registered: \${promptName}\`);
  const raw = await prompt({ output, criteria }, ctx);
  // Parse leniently — model may emit JSON or a list.
  let issues: string[] = [];
  let okFlag = true;
  if (raw && typeof raw === "object") {
    const r = raw as { ok?: boolean; issues?: unknown };
    if (Array.isArray(r.issues)) issues = r.issues.map(i => String(i));
    if (typeof r.ok === "boolean") okFlag = r.ok;
    else okFlag = issues.length === 0;
  } else if (typeof raw === "string") {
    issues = raw.split(/\\n+/).map(l => l.replace(/^[-*\\d.]+\\s*/, "").trim()).filter(Boolean);
    okFlag = issues.length === 0;
  }
  ctx.metrics.counter("cognition.self_critique", { ok: String(okFlag) });
  return { ok: okFlag, issues };
}
`.trim() + "\n",
  },

  // ─── Aggregation ──────────────────────────────────────────────────────────

  vote: {
    name: "vote",
    category: "aggregation",
    description:
      "Majority vote over a list of candidate outputs. Equality is by deep-equal on JSON-stringified values; ties resolve to the first occurrence (deterministic).",
    inputs: [
      { name: "candidates", type: "T[]", description: "list of outputs to aggregate", required: true },
    ],
    output: { type: "{ winner: T, count: number, total: number }", description: "majority winner" },
    cost: "free",
    callsModel: false,
    emit: () => `
async function vote(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const list = Array.isArray(args.candidates) ? args.candidates : [];
  if (list.length === 0) return { winner: null, count: 0, total: 0 };
  const counts = new Map<string, { value: unknown; count: number; firstIdx: number }>();
  for (let i = 0; i < list.length; i++) {
    const key = JSON.stringify(list[i]);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { value: list[i], count: 1, firstIdx: i });
  }
  let best: { value: unknown; count: number; firstIdx: number } | null = null;
  for (const entry of counts.values()) {
    if (!best) { best = entry; continue; }
    if (entry.count > best.count) best = entry;
    else if (entry.count === best.count && entry.firstIdx < best.firstIdx) best = entry;
  }
  ctx.metrics.counter("cognition.vote", { total: String(list.length) });
  return { winner: best!.value, count: best!.count, total: list.length };
}
`.trim() + "\n",
  },

  judge_pairwise: {
    name: "judge_pairwise",
    category: "aggregation",
    description:
      "Pick the better of two candidates by asking a judge model. Falls back to candidate `a` on ambiguous output.",
    inputs: [
      { name: "a", type: "unknown", description: "first candidate", required: true },
      { name: "b", type: "unknown", description: "second candidate", required: true },
      { name: "criteria", type: "string", description: "criteria for the judge", required: true },
      { name: "judge_prompt", type: "string", description: "name of the judge prompt", required: true },
    ],
    output: { type: "{ winner: 'a' | 'b', value: unknown }", description: "selected candidate" },
    cost: "medium",
    callsModel: true,
    emit: () => `
async function judge_pairwise(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const a = args.a;
  const b = args.b;
  const promptName = String(args.judge_prompt || "");
  const criteria = String(args.criteria || "");
  const prompt = ctx.prompts.get(promptName);
  if (!prompt) throw new Error(\`judge_pairwise: judge prompt not registered: \${promptName}\`);
  const raw = await prompt({ a, b, criteria }, ctx);
  const choice = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (choice === "b") {
    ctx.metrics.counter("cognition.judge_pairwise", { winner: "b" });
    return { winner: "b", value: b };
  }
  ctx.metrics.counter("cognition.judge_pairwise", { winner: "a" });
  return { winner: "a", value: a };
}
`.trim() + "\n",
  },

  argmax_score: {
    name: "argmax_score",
    category: "aggregation",
    description:
      "Pure deterministic primitive: pick the item with the highest score. Ties resolve to the earliest index.",
    inputs: [
      { name: "items", type: "{ value: T, score: number }[]", description: "scored items", required: true },
    ],
    output: { type: "T | null", description: "highest-scoring value or null when empty" },
    cost: "free",
    callsModel: false,
    emit: () => `
async function argmax_score(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const items = Array.isArray(args.items) ? args.items : [];
  if (items.length === 0) return null;
  let bestIdx = 0;
  let bestScore = Number((items[0] as { score?: number }).score ?? -Infinity);
  for (let i = 1; i < items.length; i++) {
    const s = Number((items[i] as { score?: number }).score ?? -Infinity);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  ctx.metrics.counter("cognition.argmax_score", { count: String(items.length) });
  return (items[bestIdx] as { value?: unknown }).value ?? items[bestIdx];
}
`.trim() + "\n",
  },

  consensus_check: {
    name: "consensus_check",
    category: "aggregation",
    description:
      "Detect agreement across N parallel results. Returns whether they all match (deep-equal) and a 0..1 disagreement score.",
    inputs: [
      { name: "results", type: "T[]", description: "parallel results", required: true },
    ],
    output: { type: "{ agree: boolean, disagreement_score: number }", description: "consensus report" },
    cost: "free",
    callsModel: false,
    emit: () => `
async function consensus_check(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const list = Array.isArray(args.results) ? args.results : [];
  if (list.length <= 1) return { agree: true, disagreement_score: 0 };
  const counts = new Map<string, number>();
  for (const r of list) counts.set(JSON.stringify(r), (counts.get(JSON.stringify(r)) || 0) + 1);
  const top = Math.max(...counts.values());
  const score = 1 - top / list.length;
  ctx.metrics.counter("cognition.consensus_check", { agree: String(score === 0) });
  return { agree: score === 0, disagreement_score: Number(score.toFixed(4)) };
}
`.trim() + "\n",
  },

  // ─── Recovery ──────────────────────────────────────────────────────────────

  repair_with_diff: {
    name: "repair_with_diff",
    category: "recovery",
    description:
      "Bounded repair: ask a smaller model to fix a single observed problem. Single-shot — never recurses. Use as the body of an `on_invalid: retry_with_repair_prompt` recovery step.",
    inputs: [
      { name: "output", type: "unknown", description: "the previous failing output", required: true },
      { name: "error", type: "string", description: "what went wrong", required: true },
      { name: "original_input", type: "unknown", description: "the original prompt input", required: true },
      { name: "repair_prompt", type: "string", description: "name of the repair prompt", required: true },
    ],
    output: { type: "unknown", description: "repaired output" },
    cost: "small",
    callsModel: true,
    emit: () => `
async function repair_with_diff(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const promptName = String(args.repair_prompt || "");
  const prompt = ctx.prompts.get(promptName);
  if (!prompt) throw new Error(\`repair_with_diff: repair prompt not registered: \${promptName}\`);
  ctx.metrics.counter("cognition.repair", { prompt: promptName });
  return await prompt({
    output: args.output,
    error: String(args.error || ""),
    original_input: args.original_input,
  }, ctx);
}
`.trim() + "\n",
  },

  // ─── Planning ──────────────────────────────────────────────────────────────

  decompose_task: {
    name: "decompose_task",
    category: "planning",
    description:
      "Decompose a task into a list of subtasks drawn from a closed list of allowed kinds. Never invents kinds. Subtasks the planner picks outside the allowed list are silently dropped.",
    inputs: [
      { name: "task", type: "string", description: "task description", required: true },
      { name: "allowed_kinds", type: "string[]", description: "closed list of subtask kinds", required: true },
      { name: "planner_prompt", type: "string", description: "name of the planner prompt", required: true },
    ],
    output: { type: "{ kind: string, description: string }[]", description: "filtered subtask list" },
    cost: "medium",
    callsModel: true,
    emit: () => `
async function decompose_task(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const promptName = String(args.planner_prompt || "");
  const allowed = Array.isArray(args.allowed_kinds) ? (args.allowed_kinds as string[]) : [];
  const prompt = ctx.prompts.get(promptName);
  if (!prompt) throw new Error(\`decompose_task: planner prompt not registered: \${promptName}\`);
  const raw = await prompt({ task: String(args.task || ""), allowed_kinds: allowed }, ctx);
  const list = Array.isArray(raw) ? raw : [];
  const result: { kind: string; description: string }[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object") {
      const e = entry as { kind?: unknown; description?: unknown };
      const kind = typeof e.kind === "string" ? e.kind : "";
      const desc = typeof e.description === "string" ? e.description : "";
      if (allowed.includes(kind)) result.push({ kind, description: desc });
    }
  }
  ctx.metrics.counter("cognition.decompose_task", { kept: String(result.length), total: String(list.length) });
  return result;
}
`.trim() + "\n",
  },

  escalate_model: {
    name: "escalate_model",
    category: "routing",
    description:
      "Move up one tier in a router. Bounded: throws if the current tier is already the top, and writes an audit row recording the escalation reason.",
    inputs: [
      { name: "router_name", type: "string", description: "declared router name", required: true },
      { name: "current_tier", type: "string", description: "the tier we just failed at", required: true },
      { name: "reason", type: "string", description: "audit reason", required: true },
    ],
    output: { type: "{ model_id: string, tier: string }", description: "next tier up" },
    cost: "free",
    callsModel: false,
    emit: () => `
async function escalate_model(args: Record<string, unknown>, ctx: CognitionCtx): Promise<unknown> {
  const routerName = String(args.router_name || "");
  const currentTier = String(args.current_tier || "");
  const router = ctx.routers.get(routerName);
  if (!router) throw new Error(\`Unknown router: \${routerName}\`);
  const next = router.escalate(currentTier);
  if (!next) {
    ctx.metrics.counter("cognition.escalate.exhausted", { router: routerName });
    throw new Error(\`No tier above \${currentTier} in router \${routerName}\`);
  }
  ctx.metrics.counter("cognition.escalate", { router: routerName, from: currentTier, to: next.tier });
  ctx.logger.info("cognition_escalate", { event: "escalate", status: "success", metadata: { router: routerName, from: currentTier, to: next.tier, reason: String(args.reason || "") } });
  return next;
}
`.trim() + "\n",
  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function lookupCognition(name: string): CognitionSpec | null {
  return CATALOG[name] || null;
}

export function listCognitionPrimitives(): string[] {
  return Object.keys(CATALOG).sort();
}

export function listCognitionByCategory(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(CATALOG)) {
    if (!result[spec.category]) result[spec.category] = [];
    result[spec.category].push(name);
  }
  for (const cat in result) result[cat].sort();
  return result;
}

/**
 * Collect cognition catalog names referenced by capabilities in this system.
 * Mirrors `collectUsedAlgorithms` in emit_composition.ts.
 */
import * as IR from "./ir";
export function collectUsedCognition(system: IR.IRSystem): Set<string> {
  const used = new Set<string>();
  for (const mod of system.modules) {
    for (const iface of mod.interfaces) {
      for (const method of iface.methods) {
        if (method.cognition) used.add(method.cognition.catalog_name);
      }
    }
  }
  // Phase 15: tool capabilities also pull their primitives into use.
  for (const t of system.tool_capabilities) {
    used.add(t.cognition_primitive);
  }
  return used;
}
