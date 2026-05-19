# MarrowScript LLM Harness — Detailed Development Plan

A model-agnostic AI harness platform built on MarrowScript as a deterministic semantic orchestration layer for weak/small language models (1B–8B). The model is constrained; the runtime is intelligent.

This plan is grounded in what already exists in this repo. Path references are real. Where I propose a new construct or file I name an analogue that already exists, so the work follows established patterns.

---

## 0. Guiding Premise

The repo's README states: "No LLMs. Deterministic — same input always produces identical output." We do not break that. The harness is an **additive layer**: MarrowScript continues to be a deterministic compiler. Cognition is declared in `.marrow`, compiled to deterministic runtime artifacts, and at runtime those artifacts call out to local/remote inference servers through narrow, typed, audited interfaces. Determinism of the *compiler* is preserved; non-determinism is confined to model invocation and is wrapped in compensation, validation, retry, and tracing — exactly the primitives MarrowScript already emits for fallible HTTP and DB operations.

Why this fits: every cognitive scaffolding primitive the brief asks for already has a near-identical counterpart in the existing system.

| Brief asks for | Already in MarrowScript | Source |
|---|---|---|
| Tools with typed contracts | `capability` with `requires`, `effects`, `emits`, `idempotent`, `timeout`, `retry` | `compiler/src/ast.ts:90-109`, `compiler/src/emit_capability.ts` |
| Workflow DAGs | `pipeline { ... } / parallel { ... } / on_error: rollback` | `compiler/src/ast.ts:111-130`, `compiler/src/emit_composition.ts` |
| Sagas with recovery | `flow { step ... compensate ... }` | `compiler/src/ast.ts:236-249`, `compiler/src/emit_extras.ts:emitFlowRuntime` |
| FSMs / bounded reasoning | `entity { states: a -> b -> c \| d }` compiled to typed transition tables | `compiler/src/emit_runtime.ts:emitStateMachineRuntime` |
| Closed primitive catalogs | `algorithm: <name> using { ... }` + `algorithm_catalog.ts` | `compiler/src/algorithm_catalog.ts` |
| Failure rules / detection | Auto-derived from constraints/SMs/deps/events/flows | `compiler/src/emit_maintenance.ts:emitFailureRules` |
| Durable, transactional events | Postgres outbox with dedup for `exactly_once` | `compiler/src/emit_events.ts` |
| Audit + redaction | `audit_log` table + `@sensitive` field annotation | `compiler/src/emit_audit.ts` |
| Structured tracing / metrics | Fixed-schema logger + Prometheus-style metrics | `compiler/src/emit_maintenance.ts` |
| Escape hatch preserved across recompiles | `extension_point` with sentinel-bracketed regions | `compiler/src/extension_manager.ts` |
| k8s / Docker / CI | `emit_deploy.ts` | `compiler/src/emit_deploy.ts` |
| Multi-provider switching pattern | `emit_notify.ts` (Resend / SendGrid / webhook / log) | `compiler/src/emit_notify.ts` |

The work is to add a small, opinionated set of cognition-aware constructs that compile down to these existing runtime primitives.

---

## 1. Product Surface

### What a user writes (a `.marrow` file)

```bone
system PatchHarness {
  domain: cognitive_scaffold

  // ── Models (new) ─────────────────────────────────────────
  model TinyClassifier {
    provider: ollama
    name: "qwen2.5-coder:1.5b"
    context_window: 32000
    max_output: 512
    temperature: 0.0
    cost_class: tiny
    latency_class: fast
  }

  model SmallSummarizer {
    provider: openai_compat
    endpoint: "http://localhost:8080/v1"
    name: "phi-3.5-mini"
    context_window: 128000
    max_output: 2048
    cost_class: small
  }

  model MediumSynthesizer {
    provider: ollama
    name: "qwen2.5-coder:7b"
    context_window: 32000
    max_output: 4096
    cost_class: medium
    latency_class: medium
  }

  // ── Prompts (new) — typed contracts, not free-text ──────
  prompt classify_task(task: string) {
    model: TinyClassifier
    template: "extension_point:tmpl_classify_task"
    returns: enum<["analyze","plan","generate","validate","repair"]>
    timeout: 5s
    cache: { key: hash(task), ttl: 1h }
    retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
    idempotent: true
  }

  prompt summarize_file(path: string, content: string, max_tokens: uint) {
    model: SmallSummarizer
    template: "extension_point:tmpl_summarize_file"
    returns: { summary: string, symbols: list<string>, hash: string }
    constraints: [output.summary.length <= max_tokens * 4]
    validate: schema_only
    timeout: 30s
    idempotent: true
  }

  prompt generate_patch(symbol: string, context: SemanticSlice) {
    model: MediumSynthesizer
    template: "extension_point:tmpl_generate_patch"
    returns: Patch
    validate: ast_compiles
    on_invalid: retry_with_repair_prompt
    retry: { max_attempts: 3, backoff: exponential, interval: 1s }
    timeout: 60s
  }

  // ── Routers (new) ────────────────────────────────────────
  router cheapest_valid {
    by: input.complexity
    tier tiny   { max: 0.2 -> TinyClassifier }
    tier small  { max: 0.6 -> SmallSummarizer }
    tier medium {           -> MediumSynthesizer }
    on_low_confidence: escalate
    confidence_threshold: 0.65
  }

  // ── Cognition primitives (new catalog) ──────────────────
  capability compress_history(history: list<Message>, target_tokens: uint) {
    cognition: compress_context using {
      history: history,
      target_tokens: target_tokens,
      strategy: "summarize_oldest"
    }
    returns: list<Message>
    sync: eventual
    idempotent: true
  }

  capability pick_relevant_files(task: Task, repo: RepoIndex) {
    cognition: semantic_slice using {
      task: task,
      index: repo,
      max_files: 8,
      hop_depth: 2
    }
    returns: SemanticSlice
    sync: eventual
  }

  // ── Workflow (existing pipeline construct) ──────────────
  capability run_patch(task: Task) {
    pipeline: {
      classify_task(task.description) as kind
      pick_relevant_files(task, repo_index) as slice
      compress_history(history, 4000) as ctx
      generate_patch(slice.target_symbol, slice) as patch
      validate_patch(patch) as report
      on_error: retry
    }
    sync: transactional
    timeout: 5m
  }

  // ── Validation as flow (existing flow construct) ────────
  flow patch_with_recovery {
    step generate: run_patch(task)
      compensate: rollback_patch(patch)
    step validate: validate_patch(patch)
      compensate: rollback_patch(patch)
    step apply: apply_patch(patch)
      compensate: rollback_patch(patch)
  }

  // ── Audit / observability (existing) ────────────────────
  policy harness {
    rate_limit: 60 per 1m
    audit: true
    encryption: in_transit
  }
}
```

### What gets generated (additions to the existing `output/` tree)

```
output/
├── src/
│   ├── cognition/                           NEW
│   │   ├── models.ts                        ← typed model registry
│   │   ├── prompts.ts                       ← typed prompt callers
│   │   ├── router.ts                        ← deterministic decision tree
│   │   ├── primitives.ts                    ← cognition catalog impls
│   │   └── budget.ts                        ← per-trace token/cost guards
│   ├── providers/                           NEW (mirrors emit_notify.ts pattern)
│   │   ├── index.ts                         ← unified IModelProvider
│   │   ├── openai_compat.ts                 ← OpenAI/vLLM/LM Studio/text-gen-webui
│   │   ├── ollama.ts                        ← /api/chat
│   │   ├── llamacpp.ts                      ← /completion
│   │   ├── koboldcpp.ts
│   │   └── http.ts                          ← arbitrary endpoint adapter
│   ├── prompts/                             NEW
│   │   └── *.tmpl.ts                        ← per-prompt template (extension_point bodies)
│   ├── memory/                              NEW
│   │   ├── semantic_index.ts                ← AST + symbol graph
│   │   ├── retriever.ts                     ← graph retrieval
│   │   └── compressor.ts                    ← context window manager
│   ├── validators/                          NEW
│   │   ├── ast.ts                           ← AST validation
│   │   ├── schema.ts                        ← reuses src/schemas.ts (Zod)
│   │   ├── compile.ts                       ← invokes tsc
│   │   └── repair.ts                        ← repair-prompt orchestration
│   ├── traces/                              NEW
│   │   └── exporter.ts                      ← OTLP/JSON span export
│   ├── (existing) routes/, state_machines/, flows.ts, algorithms.ts, ...
├── migrations/
│   ├── (existing) audit_log.sql, event_outbox.sql, ...
│   ├── cognition_traces.sql                 NEW
│   ├── prompt_cache.sql                     NEW
│   └── semantic_index.sql                   NEW
└── (existing) admin/, openapi.yaml, k8s/, ...
```

Everything new fits the existing emit_full.ts orchestration and gets the same Dockerfile, CI, k8s, audit, metrics, and admin treatment for free.

---

## 2. Architecture Mapping (brief → repo)

The brief lists eight layers. Here is where each lives.

| Layer | New / reuse | Implementation |
|---|---|---|
| **MarrowScript Semantic Layer** | extend | New decls: `model`, `prompt`, `router`, `cognition` modifier on capability, optional `cache` and `validate` blocks. AST + parser + type checker + IR additions. |
| **Execution Runtime Layer** | reuse | The compiled Express + pipeline + flow runtime is exactly this. Generated `src/cognition/router.ts` and `src/cognition/prompts.ts` are called as ordinary capabilities. |
| **Cognitive Routing Layer** | new emitter | `emit_router.ts` produces `src/cognition/router.ts` — a deterministic decision tree compiled from `router` decls. |
| **Context Compression Layer** | new + reuse | `emit_memory.ts` produces semantic index + retriever + compressor. Backed by Postgres (existing `db.ts`) using a graph table. Compression itself is a cognition primitive. |
| **Deterministic Workflow Engine** | reuse | `pipeline { ... } / parallel { ... } / on_error: rollback` and `flow { step ... compensate ... }` already do this. State machines for bounded reasoning are already compiled. |
| **Validation and Recovery Layer** | extend | `requires`/`effects` + Zod (existing) for inputs. New `validate:` and `on_invalid:` clauses on `prompt` for outputs. Repair prompts emitted as fallback steps. |
| **Observability Layer** | extend | Reuse `emit_maintenance.ts` logger/metrics. Add `cognition_traces` table + span emitter. Keep the existing trace_id/span_id schema. |
| **Multi-Model Coordination Layer** | reuse | `parallel { ... }` plus new aggregation primitives in the cognition catalog: `vote`, `judge_pairwise`, `argmax_score`, `consensus_check`. |

---

## 3. Language Additions (Surface)

### 3.1 New top-level declarations

`model` — declares a model adapter and its budget envelope.
- Required: `provider`, `name`.
- Optional: `endpoint` (for openai_compat / http), `context_window`, `max_output`, `temperature`, `top_p`, `stop`, `cost_class` ∈ {tiny, small, medium, large}, `latency_class` ∈ {fast, medium, slow}, `vram_mb`, `quant`.

`prompt` — declares a typed prompt and its execution policy.
- Required: `model:`, `template:`, `returns:`.
- Optional: `validate:` ∈ {none, schema_only, ast_compiles, custom:<extension_point>}, `on_invalid:` ∈ {fail, retry, retry_with_repair_prompt, escalate}, `retry:`, `timeout:`, `cache: { key: <expr>, ttl: <duration> }`, `idempotent:`, `constraints:`, `tools:` (list of capability names the model is allowed to call — defaults to none).

`router` — declares a deterministic routing decision tree.
- `by: <expr>` selects the routing key (e.g. `input.complexity`, `input.token_count`, `last_failure_count`).
- `tier <name> { max: <number> -> <Model> }` ordered tiers; the last tier omits `max:`.
- Optional: `on_low_confidence: escalate`, `confidence_threshold:`, `fallback: <Model>`.

### 3.2 Capability extension

Existing capabilities can be flagged as cognition primitives:

```bone
capability X(...) {
  cognition: <primitive_name> using { ... }   // analogous to algorithm:
  returns: ...
}
```

This dispatches to the **cognition catalog** (mirror of `algorithm_catalog.ts`), giving us closed, named, reviewable cognition primitives — exactly the pattern that already prevents the algorithm catalog from being a soup of arbitrary code.

### 3.3 New keywords (lexer)

Add to `compiler/src/lexer.ts:202` `KEYWORDS` table:

```
model, prompt, router, cognition, provider, endpoint,
template, tier, by, returns (already exists), validate, on_invalid,
cache, ttl (already exists), tools, confidence_threshold, fallback,
context_window, max_output, temperature, top_p, stop,
cost_class, latency_class, vram_mb, quant
```

Keep them as named token kinds (`KwModel`, `KwPrompt`, etc.) following the existing convention in `compiler/src/lexer.ts:62`.

### 3.4 AST nodes

Extend the `DeclarationNode` union in `compiler/src/ast.ts:30` and add:

- `ModelDeclNode` — fields list, deterministic field ordering for serialization.
- `PromptDeclNode` — params, model ref, template ref, returns type, validate mode, on_invalid action, retry, timeout, cache spec, idempotent, constraints (existing `ExprNode[]`), tools (capability name list).
- `RouterDeclNode` — by expr, tiers (ordered), on_low_confidence, confidence_threshold, fallback.
- Extend `CapabilityDeclNode` with optional `cognition: { name: string, bindings: AlgorithmBinding[] }` mirroring `algorithm:`.

Reuse existing nodes wherever possible: `ParamNode`, `RetryPolicyNode`, `TypeExprNode`, `ExprNode`, `AlgorithmBinding`.

### 3.5 Type checker rules

In `compiler/src/typechecker.ts`:

- `prompt.model` must reference a declared `model`.
- `prompt.template` must reference a declared `extension_point` (so prompt bodies survive recompilation; see `compiler/src/extension_manager.ts`) **or** a literal string.
- `prompt.returns` must be a fully-resolved type (primitive, entity, tuple, union, or generic of those).
- `router.tier` thresholds must be monotonically increasing; the last tier must be a default (no `max:`).
- `cognition: <name>` must resolve in the new `cognition_catalog.ts`.
- Models referenced by router tiers must exist.
- `tools: [...]` on a prompt restricts the prompt's allowed capability calls — type checker enforces that listed names are existing capabilities. **The model is never given unrestricted tool access.**

### 3.6 IR additions

In `compiler/src/ir.ts`:

```ts
export interface IRModel {
  id: string;
  name: string;
  provider: "openai_compat" | "ollama" | "llamacpp" | "koboldcpp" | "http";
  endpoint: string | null;          // null when provider has a fixed URL convention
  model_name: string;
  context_window: number;
  max_output: number;
  temperature: number;
  cost_class: "tiny" | "small" | "medium" | "large";
  latency_class: "fast" | "medium" | "slow";
  vram_mb: number | null;
  quant: string | null;
}

export interface IRPrompt {
  id: string;
  name: string;
  input: IRField[];                 // reuse
  output_type: string;              // serialized type expression
  model_ref: string;                // IRModel.id
  template_ref: string;             // extension_point id or literal sentinel
  validate: "none" | "schema_only" | "ast_compiles" | { custom: string };
  on_invalid: "fail" | "retry" | "retry_with_repair_prompt" | "escalate";
  retry: IRRetryPolicy | null;      // reuse
  timeout_ms: number;
  cache: { key_expr: string; ttl_ms: number } | null;
  idempotent: boolean;
  constraints: string[];            // serialized exprs, reuse
  allowed_tools: string[];          // capability names
}

export interface IRRouter {
  id: string;
  name: string;
  by_expr: string;                  // serialized
  tiers: { name: string; max: number | null; model_ref: string }[];  // last has max:null
  on_low_confidence: "fail" | "escalate" | "retry";
  confidence_threshold: number;
  fallback_model_ref: string | null;
}

export interface IRCognitionBinding {
  catalog_name: string;
  bindings: { param: string; value: string }[];   // mirrors IRAlgorithm
}

// On IRSystem:
//   models: IRModel[];
//   prompts: IRPrompt[];
//   routers: IRRouter[];
// On IRMethod:
//   cognition: IRCognitionBinding | null;       // mirrors `algorithm`
```

These additions are deterministic-friendly: deterministic ordering, no `Date.now()`, no `Math.random()` — same as the rest of `compiler/src/ir.ts`.

### 3.7 Lowering

Extend `compiler/src/lowering.ts`:
- `ModelDeclNode` → `IRModel`.
- `PromptDeclNode` → `IRPrompt`. Resolve template_ref: if it points at an `extension_point`, validate that the extension point's signature matches the prompt's params and return type.
- `RouterDeclNode` → `IRRouter`.
- `CapabilityDeclNode.cognition` → `IRMethod.cognition`.

---

## 4. Cognition Catalog

A new file `compiler/src/cognition_catalog.ts`, mirroring `compiler/src/algorithm_catalog.ts:8-25` exactly. Same pattern: closed registry, typed inputs, declared output type, **complexity / token-budget annotation**, deterministic emit. Same comment at the top: "NEW cognition primitives can ONLY be added by extending this catalog."

### Initial primitives (v1)

| Name | Category | Inputs | Output | Notes |
|---|---|---|---|---|
| `compress_context` | memory | history, target_tokens, strategy ∈ {summarize_oldest, drop_oldest, hierarchical_summarize} | list<Message> | uses summarizer model from router |
| `semantic_slice` | retrieval | task, index, max_files, hop_depth | SemanticSlice | AST + symbol graph traversal, **never dumps the whole repo** |
| `tool_select` | routing | task, allowed_tools | { tool_name, args } | classification model picks from `tools:` list, deterministic if temperature=0 |
| `route_by_complexity` | routing | input, router_ref | { model_id } | thin wrapper around an `IRRouter` |
| `self_critique` | validation | output, criteria | { ok: bool, issues: list<string> } | uses validator model |
| `vote` | aggregation | candidates: list<T>, k_models | T | majority vote over k parallel calls |
| `judge_pairwise` | aggregation | a: T, b: T, criteria | T | uses judge model |
| `argmax_score` | aggregation | items: list<{x, score}> | T | deterministic, no model needed |
| `consensus_check` | aggregation | results: list<T> | { agree: bool, disagreement_score: float } | for parallel validation |
| `repair_with_diff` | recovery | output, error, original_input | T | bounded — single shot, smaller scope |
| `decompose_task` | planning | task | list<Subtask> | classifier picks from a closed list of subtask kinds |
| `escalate_model` | routing | input, current_model, router_ref | { model_id } | next tier up, with audit |

Each entry's `emit` function returns deterministic TypeScript that calls the model adapter through the typed prompt interface — never freeform.

---

## 5. New Emitters

All follow the existing house style: hand-written `lines.push(...)`, no templating libs, deterministic ordering, `// Generated by MarrowScript compiler. DO NOT EDIT.` header. Mirror file shapes you can see in `compiler/src/emit_runtime.ts` and `compiler/src/emit_composition.ts`.

### 5.1 `compiler/src/emit_provider.ts`
- One adapter file per provider in `src/providers/`.
- All implement a single `IModelProvider`:
  ```ts
  interface IModelProvider {
    name: string;
    chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
    countTokens(text: string): number;     // best-effort, deterministic per provider
  }
  ```
- Switching pattern reuses the multi-provider logic from `compiler/src/emit_notify.ts` (Resend/SendGrid/webhook/log).
- Streaming optional, falls back to buffered.
- All adapters honor `AbortSignal` so the existing per-capability `timeout:` middleware is automatically respected.
- SSRF guard for `http` provider: only allow `endpoint:` values that match the env-allowlist `LLM_ENDPOINT_ALLOWLIST` (loopback / RFC1918 by default; production must explicitly expand). Mirrors the existing SSRF protection in `emit_notify.ts`.

### 5.2 `compiler/src/emit_cognition.ts`
- Emits `src/cognition/models.ts` (typed registry built from `IRModel[]`).
- Emits `src/cognition/prompts.ts`: one async function per `IRPrompt`. Each function:
  1. Validates input against generated Zod schema (reuse `compiler/src/emit_zod.ts`).
  2. Resolves the model via either the prompt's static `model_ref` or `router` if one is referenced.
  3. Loads the template from the extension_point implementation (sentinels preserve user code).
  4. Calls the provider through `IModelProvider.chat`.
  5. Parses output, validates per `validate:` mode.
  6. On invalid: applies `on_invalid:` action, bounded by `retry:`.
  7. Caches by `cache.key_expr` if set (Postgres-backed via new `prompt_cache` table).
  8. Emits a span to `cognition_traces`.
  9. Returns typed result.

### 5.3 `compiler/src/emit_router.ts`
- Emits `src/cognition/router.ts` per `IRRouter`: a deterministic decision tree implemented as ordered if-else over the `by_expr` value.
- Adds `escalate(model_ref, last_confidence)` helper that picks the next tier and writes an audit row.
- Generated code is pure and trivially auditable — no dynamic model dispatch.

### 5.4 `compiler/src/emit_memory.ts`
- Emits `migrations/semantic_index.sql` (graph tables: `symbols`, `imports`, `calls`, `file_summaries`).
- Emits `src/memory/semantic_index.ts`: AST-based symbol extractor using the existing TypeScript dep (build-time only) plus per-language strategies registered via `extension_point`.
- Emits `src/memory/retriever.ts`: graph traversal with bounded `hop_depth` and `max_files`. Returns a `SemanticSlice` shape.
- Emits `src/memory/compressor.ts`: token-budgeted compression using the summarizer model. Deterministic chunk ordering by file path + symbol name.

### 5.5 `compiler/src/emit_cognition_audit.ts`
- Adds a `cognition_traces` table:
  ```sql
  CREATE TABLE cognition_traces (
    id UUID PRIMARY KEY,
    trace_id UUID NOT NULL,
    parent_span_id UUID,
    workflow VARCHAR NOT NULL,
    step VARCHAR NOT NULL,
    prompt VARCHAR,
    model VARCHAR NOT NULL,
    provider VARCHAR NOT NULL,
    input_redacted JSONB,
    output_redacted JSONB,
    validate_result VARCHAR,
    confidence FLOAT,
    prompt_tokens INT,
    completion_tokens INT,
    cost_usd NUMERIC(10,6),
    latency_ms INT,
    cache_hit BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status VARCHAR NOT NULL CHECK (status IN ('ok','validate_failed','timeout','provider_error','budget_exceeded'))
  );
  ```
- Reuses the existing `audit_log` redaction helpers (`compiler/src/emit_audit.ts:42-66`) and `@sensitive` annotations to redact prompt inputs/outputs.
- Extends `emit_maintenance.ts` logger schema with `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache_hit` fields.

### 5.6 `compiler/src/emit_budget.ts`
- Per-trace and per-tenant token / cost budgets. A new `gauge` and `histogram` registered in `emit_maintenance.ts:emitMetrics`.
- `BudgetExceeded` is a first-class failure rule auto-derived in `emit_maintenance.ts:emitFailureRules`.

### 5.7 Wire into `compiler/src/emit_full.ts`
- After existing emitters (around `compiler/src/emit_full.ts:84-106`), add:
  - `src/cognition/*.ts` (always, when `system.prompts.length > 0`)
  - `src/providers/*.ts` (always, when models declared)
  - `src/memory/*.ts` (when `semantic_slice` or any memory primitive is used)
  - `migrations/cognition_traces.sql`, `migrations/prompt_cache.sql`, `migrations/semantic_index.sql`
- `emit_full.ts:emitEnvExample` adds:
  - `LLM_PROVIDER_DEFAULT`, `LLM_ENDPOINT_ALLOWLIST`, `LLM_BUDGET_USD_PER_TRACE`, `LLM_BUDGET_TOKENS_PER_TRACE`, per-provider keys (`OLLAMA_HOST`, `OPENAI_BASE_URL`, etc.).

---

## 6. Existing Emitter Reuse (no change required)

| Emitter | What it gives the harness for free |
|---|---|
| `emit_runtime.ts` | HTTP exposure of every cognition capability, Express composition, package.json/tsconfig |
| `emit_capability.ts` | Compiled preconditions/effects for tool calls the model is allowed to make |
| `emit_composition.ts` | Pipeline DAG executor + parallel + rollback (the workflow engine) |
| `emit_extras.ts` | Saga / flow runtime with backward compensation |
| `emit_events.ts` | Durable transactional outbox for cognition events (`PromptStarted`, `PromptCompleted`, `LowConfidence`, `BudgetExceeded`) |
| `emit_audit.ts` | Audit + redaction (extended for prompt content) |
| `emit_maintenance.ts` | Logger, metrics, health, failure rules, migration diff |
| `emit_zod.ts` | Runtime validation of prompt I/O |
| `emit_sdk.ts` + `emit_react.ts` | Client integration: dashboards / wrappers can call cognition capabilities like any other |
| `emit_deploy.ts` | Dockerfile, k8s with probes, GitHub Actions CI |
| `extension_manager.ts` | Sentinel-bracketed regions for prompt template bodies — user-authored prompt text survives recompiles |

---

## 7. Determinism Discipline

The brief asks for *deterministic workflows, reproducibility, and execution auditing* while LLM calls are non-deterministic. Discipline:

1. **Compiler stays bitwise deterministic.** Every new emitter must pass `marrowc verify-determinism` (`compiler/src/cli.ts:638-672`). Sort everything; never use `Date.now()` or `Math.random()` in emitted code.
2. **Routing is deterministic.** Router tiers are an ordered if-else; same input → same tier choice.
3. **Caching is deterministic.** `cache.key_expr` is a pure expression evaluated against typed inputs. Default key is `sha256(JSON.stringify(canonicalize(input))) + "|" + model_ref + "|" + template_hash`.
4. **Replay mode.** A new `marrowc replay <trace_id>` command (lives in `compiler/src/cli.ts`) reads from `cognition_traces` and replays a workflow, optionally with a fixture provider that returns the recorded outputs verbatim. This makes incident reproduction trivial.
5. **Snapshot tests.** Generated regression test suite (`emit_tests.ts`) gets a new section per prompt that calls a deterministic mock provider and asserts on the structured output shape, never on free-text content.

---

## 8. Validation & Recovery

Three layers, each scoped:

1. **Input validation** — Zod, generated from `prompt.input`. Existing infrastructure.
2. **Output structural validation** — `validate: schema_only` parses output as JSON and applies the generated Zod schema. `validate: ast_compiles` runs the output (assumed code) through `tsc --noEmit` (similar to `marrowc validate`, see `compiler/src/cli.ts`). `validate: custom:<extension_point>` calls a user-supplied validator preserved across recompiles.
3. **Recovery actions** (`on_invalid:`):
   - `fail` — raise, let the surrounding pipeline `on_error: rollback` handle it.
   - `retry` — same prompt, decremented attempts, exponential backoff. Existing retry runtime.
   - `retry_with_repair_prompt` — call a generated repair prompt (uses `repair_with_diff` cognition primitive). Repair runs **smaller and more constrained** by construction — fewer tokens, narrower scope, often a smaller model — directly addressing the brief's point that "retries should become smaller, simpler, more constrained over time."
   - `escalate` — invoke router's `escalate(...)` to bump up one tier; bounded by `confidence_threshold` and a max of one escalation step per pipeline (the runtime tracks this in span metadata).

The existing `failure_rules.ts` emitter (`compiler/src/emit_maintenance.ts:emitFailureRules`) gets new rule kinds derived from prompts: `prompt_validate_failed`, `prompt_timeout`, `low_confidence`, `budget_exceeded`. Each rule has a derived detection + remediation + escalation.

---

## 9. Observability

- Span schema extends the existing logger schema (`compiler/src/emit_maintenance.ts:emitLogger`). New optional fields: `model`, `provider`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache_hit`, `confidence`, `validate_result`.
- `cognition_traces` is the durable record. Every prompt call writes one row. Rows are linked by `trace_id` to entity-mutating capabilities, so a "why did this patch get applied?" question always traces back to: input → router decision → prompt → tool call → effect → emitted event → audit row.
- Existing health endpoint (`compiler/src/emit_maintenance.ts:emitHealthChecks`) gets two new checks: `provider_<name>` reachability (cached for 30s to avoid DOS-ing local servers) and `budget_remaining`.
- Existing Prometheus metrics get cognition counters/histograms: `cognition.prompt_calls`, `cognition.prompt_tokens`, `cognition.cost_usd`, `cognition.cache_hits`, `cognition.escalations`, `cognition.validation_failures`, `cognition.budget_exceeded`. Same `counter`/`histogram`/`gauge` API as today.
- An OTLP/JSON span exporter at `src/traces/exporter.ts` can ship spans to any OpenTelemetry collector. Off by default; enabled via `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## 10. Multi-Model Coordination

No new orchestration runtime is needed.

- **Speculative / parallel execution** — already supported by `parallel { ... }` (`compiler/src/emit_composition.ts:emitParallelPipeline`). A capability that calls four prompts in parallel and votes is one parallel pipeline plus the `vote` cognition primitive.
- **Specialized roles** — declare separate `model` entries (`Planner`, `Validator`, `Summarizer`, `Generator`, `Retriever`) and reference them from prompts. Roles are documentation; the type checker enforces correct binding.
- **Consensus / disagreement detection** — `consensus_check` primitive over a parallel result list.
- **Ensemble confidence** — every prompt call records a `confidence` field (computed from logprobs when available, otherwise 0.0). Aggregation primitives use it.

The runtime never lets a model spawn another prompt. Only the compiled pipeline can. **Recursion is bounded by construction** because every loop must be a declared `pipeline` or `flow` step with an explicit retry policy.

---

## 11. Local-First Provider Coverage

`src/providers/openai_compat.ts` covers the bulk of the local-first ecosystem because vLLM, LM Studio, KoboldCPP (with the OpenAI shim), and text-generation-webui all expose an OpenAI-compatible endpoint. Native adapters:

- `ollama.ts` — `/api/chat` and `/api/generate` (no OAI shim needed).
- `llamacpp.ts` — `/completion` (the legacy non-OAI endpoint, useful for raw completion semantics).
- `koboldcpp.ts` — kept separate even though OAI shim works, because the native API gives better grammar / sampling control.
- `http.ts` — generic adapter for any local server. SSRF-guarded.

A small `tokenizer.ts` shim provides `countTokens` per model. Initial implementation: provider-reported counts when available, else a tiktoken-style approximation gated to the four common families (Llama, Qwen, Phi, Gemma). Token counts are best-effort and never used as a security boundary — only for budget gauges.

VRAM annotations on `model` decls feed a `marrowc doctor` command (lives in `compiler/src/cli.ts`) that probes available local servers and warns if a declared model would not fit.

---

## 12. Implementation Phases

Each phase is independently shippable and testable. Each follows the existing test-script pattern (`compiler/src/test_*.ts` run via `ts-node` in `package.json:scripts.test`).

### Phase 1 — Substrate **— DELIVERED**
- ✅ Lexer keywords + `Token` kinds (`compiler/src/lexer.ts`): added 36 cognition tokens (`KwModel`, `KwPrompt`, `KwRouter`, `KwCognition`, etc.) and their keyword-table entries. No collisions with shipped examples; one minor parser tweak (`parseFlowDecl` now accepts keyword-shaped step names) preserved all existing fixtures.
- ✅ AST nodes (`compiler/src/ast.ts`): `ModelDeclNode`, `PromptDeclNode`, `RouterDeclNode`, `RouterTierNode`, `PromptCacheNode`, `CognitionNode`; `CapabilityDeclNode.cognition` added; `DeclarationNode` union extended.
- ✅ Parser: new `compiler/src/parse_decls3.ts` mirrors the style of `parse_decls.ts` / `parse_decls2.ts`. Both `Parser` and `RecoveringParser` dispatch the new decls. Field separation is comma-tolerant in cognition decls (and now in `extension_point` for symmetry).
- ✅ IR types (`compiler/src/ir.ts`): `IRCogModel` (named separately from `IRModel` to avoid collision with the existing data-store model type), `IRPrompt`, `IRPromptCache`, `IRRouter`, `IRRouterTier`, `IRCognitionBinding`; `IRMethod.cognition` added; `IRSystem.{models,prompts,routers}` added.
- ✅ Lowering (`compiler/src/lowering.ts`): `lowerModel`, `lowerPrompt`, `lowerRouter`; `lowerCapability` carries `cognition` through; ms-conversion for timeouts and retry intervals; deterministic ID generation; default values explicitly chosen for safety (temperature=0, on_invalid=fail, validate=none).
- ✅ TypeChecker (`compiler/src/typechecker.ts`): error codes T020–T027 wired in. T020 = required model fields (provider, name, endpoint when openai_compat/http); T021 = prompt references undeclared model/router; T022 = prompt references neither or both; T023 = allowed_tools references undeclared capability; T024 = template/validate references undeclared extension_point; T025 = router tier references undeclared model; T026 = router tier ordering / default tier rules; T027 = fallback references undeclared model.
- ✅ Test suite: `compiler/src/test_cognition_parse.ts` — 66 tests covering lexer, parser, parser determinism, lowering, lowering determinism, type checker positive cases, and all eight type-error codes. Wired into `npm test` and `tsconfig.json` exclude list.
- ✅ Live example: `examples/harness_minimal.marrow` — full system with two models, a router, two prompts, and a capability using `cognition:`. Round-trips through `marrowc check` and `marrowc ir`. Two compilations are bitwise-identical (`marrowc verify-determinism` confirms hash `7a60e2307a5ba9f7`).
- ✅ Verified no regression: existing 135 tests (test/typechecker/nakama/sqlite/notify/react/prisma/relations) plus new 66 — **201 passed, 0 failed**. Existing marketplace example still produces hash `42b3916fcbc9422b`.

### Phase 2 — Cognition catalog + provider adapters **— DELIVERED**
- ✅ `compiler/src/cognition_catalog.ts` — closed registry mirroring `algorithm_catalog.ts:8-25`. 12 v1 primitives spanning memory (`compress_context`), retrieval (`semantic_slice`), routing (`route_by_complexity`, `tool_select`, `escalate_model`), validation (`self_critique`), aggregation (`vote`, `judge_pairwise`, `argmax_score`, `consensus_check`), recovery (`repair_with_diff`), and planning (`decompose_task`). Each entry has cost/latency annotation, `callsModel` flag, and a deterministic `emit()`.
- ✅ Type checker error code **T028** — capability `cognition: <name>` rejected when the name is not in the catalog. Listed allowed names in the error message for discoverability.
- ✅ `compiler/src/emit_provider.ts` — generates `src/providers/{types, ssrf_guard, ollama, openai_compat, llamacpp, koboldcpp, http, index}.ts`. Only adapters for providers actually referenced by `model` decls are emitted (mirrors `collectUsedAlgorithms`). All five adapters share the `IModelProvider` interface (`name`, `chat(req, signal)`, `countTokens(text)`); openai_compat / llamacpp / koboldcpp / http call `assertEndpointAllowed()` which honors `LLM_ENDPOINT_ALLOWLIST` and the loopback / RFC1918 fallback (same SSRF posture as `emit_notify.ts`). Models are sorted alphabetically in the registry literal so the file is deterministic across declaration order.
- ✅ `compiler/src/emit_cognition.ts` — generates `src/cognition/{router, prompts, primitives, index}.ts`:
  - **router.ts**: one `CompiledRouter` per declared router. The tier ladder is an ordered if-else over `pickByPath(input, [...])`. `escalate(currentTier)` walks the next tier; `fallback()` returns the declared fallback model.
  - **prompts.ts**: one async function per declared prompt. Each function: validates input, resolves model statically or via router, loads template via `loadExtension(name)` (the existing `extension_point` mechanism), dispatches through `IModelProvider.chat` with an `AbortController` wired to the prompt's `timeout:`, validates output per `validate:`, branches on `on_invalid:` (fail / retry / retry_with_repair_prompt / escalate), backs off per `retry.backoff` (fixed / linear / exponential), and emits structured spans via `logger.info`/`warn` and `counter`/`histogram` from the existing maintenance layer.
  - **primitives.ts**: only emits the primitives referenced by capabilities. Builds a `PRIMITIVES` dispatch table and a `CognitionCtx` shape that exposes `prompts`, `routers`, `logger`, `metrics` to every primitive.
  - **index.ts**: public entry. Exports `buildCtx()`, `callPrompt(name, input)`, `runCognition(name, args)`, `newTraceId()`. Re-exports the registries.
- ✅ Wired into `emit_full.ts` after the existing emitters; produces zero new files for non-cognition systems. Extended `.env.example` with `LLM_ENDPOINT_ALLOWLIST`, `LLM_ALLOW_PUBLIC_ENDPOINTS`, `LLM_BUDGET_*`, `OLLAMA_HOST`, `OPENAI_COMPAT_API_KEY` only when a cognition surface is present.
- ✅ Bug fix in `emit_full.ts`: extension_point param/return types are now mapped from IR types (`uint`, `int`, `float`, etc.) to TypeScript types (`number`, etc.) via a small `irToTs` helper. Without this the generated `src/extensions.ts` wouldn't compile when an extension_point used a non-string param.
- ✅ Test suites:
  - **`compiler/src/test_cognition_emit.ts`** — 32 unit tests covering catalog membership, provider emit (only-used adapters, file shape, registry sorting, SSRF guard, Ollama/OpenAI surface), cognition emit (router compilation, retry/timeout/on_invalid/backoff branches, tracing wiring, primitive selection, index exports), determinism, edge cases (no-cognition system → zero files, ollama-only system → no openai_compat.ts), and T028.
  - **`compiler/src/test_cognition_e2e.ts`** — full pipeline smoke test. Compiles a fixture .marrow, fills extension stubs, runs `npm install` + `tsc --noEmit -p tsconfig.json` on the generated tree (passes under strict mode), verifies the second compile is bitwise identical, then injects a stub `IModelProvider` and confirms `callPrompt("classify", { text: "..." })` returns the stub's content. **15/15 passes.**
- ✅ Verified no regression: full suite runs at **248 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15). Existing marketplace example still produces hash `42b3916fcbc9422b`. The harness_minimal example produces a new deterministic hash (`d8486530bbd70c4a`) that includes the cognition + providers tree.

### Phase 3 — Routing + caching + budget **— DELIVERED**
- ✅ `compiler/src/emit_budget.ts` — generates `src/cognition/budget.ts`. Tracks per-trace tokens + USD with two opt-in env ceilings (`LLM_BUDGET_TOKENS_PER_TRACE`, `LLM_BUDGET_USD_PER_TRACE`). Pessimistic per-cost-class USD floor table (tiny=$0.0001, small=$0.001, medium=$0.01, large=$0.03 per 1k tokens). Throws typed `BudgetExceededError` with `code: "BUDGET_EXCEEDED"`. Exposes `assertCanSpend(tokens, costClass)`, `charge(...)`, `refund(...)`, `newBudget(trace_id)`, `budgetEnforced()`, `budgetLimits()`. Counters: `cognition.budget_exceeded`, `cognition.tokens_charged`, `cognition.tokens_refunded`. Gauges: `cognition.trace_tokens`, `cognition.trace_usd`.
- ✅ `compiler/src/emit_cache.ts` — generates `migrations/prompt_cache.sql` and `src/cognition/cache.ts`. Schema: 64-char content-addressed key, `output_value` JSONB, `expires_at`, `hits`, `last_hit_at`. Runtime supports two backends (`memory` for dev, `pg` for prod, switched by `LLM_CACHE_MODE`). `deriveKey()` is a SHA-256 over canonical JSON of `(prompt_name | model_id | template_hash | output_type | input)` so prompt rewordings, model swaps, and input changes all invalidate cache entries. Files emitted only when at least one prompt declares `cache:`.
- ✅ Updated `emit_cognition.ts:emitPromptCaller`:
  - **Cache lookup before retry loop**: derives the key, calls `cache.get(key)`, returns early on hit with a `cognition_prompt_cache_hit` log span (`cache_hit: true` in metadata).
  - **User `key:` expression rewriter**: `hash(field)` → `createHash("sha256").update(String(input[field] ?? "")).digest("hex")`; bare paths → `String(input.field ?? "")`; unknown shapes degrade to empty string. Combined with model id and template hash so two models or two template wordings never collide on the same key. Outer parens are stripped only when balanced at root, so call syntax `hash(body)` survives unwrap.
  - **Budget gate**: `__budget.assertCanSpend(estimatedTokens, costClass)` runs before each `provider.chat()`; estimated tokens = `provider.countTokens(rendered) + maxOutput`.
  - **Charge after success**: `__budget.charge(actualTokens || estimatedTokens, costClass)` records the real spend.
  - **Cache write after success**: `cache.put(key, prompt_name, model_id, value, ttl_ms, usage)`. Cache write failures are logged and swallowed (non-fatal).
  - **`BudgetExceededError` is terminal**: bypasses retry / on_invalid entirely. Logs `error_code: "BUDGET_EXCEEDED"` with the kind / limit / observed metadata and bubbles immediately.
- ✅ `PromptCtx.budget` is optional — pass a shared tracker for trace-level enforcement, or omit and the prompt creates a single-call tracker so token / cost gauges still fire.
- ✅ Wired into `emit_full.ts`: `emitBudget()` is called when any cognition exists, `emitCacheFiles()` is called only when a prompt has `cache:`. Existing non-cognition projects emit zero new files.
- ✅ Test suite: `compiler/src/test_cognition_phase3.ts` — 25 tests covering file emission (cache files conditional on `cache:` usage, budget always when cognition), prompt-body wiring (cache.get/put on cached prompts only, budget on all prompts, BudgetExceededError terminal), determinism, and end-to-end runtime behaviour:
  - Cached prompt: 2 identical inputs → provider hit exactly once, both calls return same value
  - Cached prompt: different inputs → provider hit twice (cache misses correctly)
  - Uncached prompt: 2 identical inputs → provider hit twice (no cache wired)
  - Budget ceiling exceeded → `BudgetExceededError` thrown with `code: "BUDGET_EXCEEDED"`, **provider was never called** (pre-emption working)
- ✅ Verified no regression: full suite at **273 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25). Marketplace example remains hash `42b3916fcbc9422b` (non-cognition bytes unchanged). harness_minimal produces a new deterministic hash (`4ba2c7ed1d215538`) that includes the budget/cache surface.

### Phase 4 — Memory layer **— DELIVERED**
- ✅ `compiler/src/emit_memory.ts` — generates the memory layer when at least one capability uses `cognition: semantic_slice` or `cognition: compress_context`. Seven artifacts:
  - `migrations/semantic_index.sql` — five graph tables: `symbols`, `imports`, `calls`, `file_summaries`, `task_anchors`. Indexes on `(file, kind)`, `name`, `kind`, `imported_file`, `callee_id`, `expires_at`.
  - `src/memory/types.ts` — shared `Symbol`, `ImportEdge`, `CallEdge`, `FileSummary`, `SemanticSlice`, `SemanticIndex` types.
  - `src/memory/semantic_index.ts` — `buildIndex(root, excludes)`, `listSourceFiles(root, excludes)`, `extractFile(absPath, relPath)`, `deriveSymbolId(file, name, line)`. Two extraction strategies: `extractWithTypescript` (full TS compiler API, lazily loaded so the dep isn't forced) and `extractWithRegex` (fallback when `typescript` isn't installed). Walks `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mts`, `*.cts`. Skips `node_modules`, `dist`, `.git`, `build`, `.next`, `output` by default.
  - `src/memory/retriever.ts` — bounded BFS. `walkIndex(repo, task, hopDepth, maxFiles)` tokenises the task into stop-word-filtered keywords, scores every symbol by camel/snake split overlap (3 pts), file-name overlap (1 pt), and a 0.25 boost for `public` visibility. Top 2×maxFiles symbols seed the BFS; expansion walks `imports + reverseImports` up to `hopDepth`, capped at `maxFiles`. Every traversal is sorted at every level so results are deterministic.
  - `src/memory/compressor.ts` — `compressSlice(slice, repo, root, targetTokens)` produces a token-budgeted text bundle. Seed file gets up to half the budget; subsequent files contribute their matching symbol's neighbourhood (5 lines before, 30 after). Pure text manipulation — never calls a model.
  - `src/memory/index.ts` — public entry. `getIndex()` returns the singleton `InProcessIndex` (lazy build on first call). Honours `LLM_MEMORY_ROOT` env var (default: cwd). `sliceForPrompt(task, options)` is a convenience that wires the retriever and the compressor.
  - `bin/index_sources.ts` — build-time script. `npx ts-node bin/index_sources.ts --print` dumps the indexed graph as JSON for debugging; `--root <dir>` overrides the indexed root.
- ✅ `CognitionCtx` extended with a `memory.getIndex()` slot. The `buildCtx()` factory wires it to `getIndex` from `../memory` when memory is needed; otherwise it returns `null`. Existing prompts and primitives are unaffected — only the two memory primitives use the new slot.
- ✅ Catalog primitive `semantic_slice` updated: prefers an explicit `index:` arg (passed by user code), otherwise falls back to `ctx.memory.getIndex()`. Returns the empty-slice shape when neither is available, so the primitive stays callable in trivial setups.
- ✅ Wired into `emit_full.ts` after the cache emitter; emits zero new files for non-memory systems.
- ✅ Test suite: `compiler/src/test_cognition_phase4.ts` — 28 tests covering conditional emission (zero files for non-memory systems, full 7-file tree for `semantic_slice` or `compress_context` users), schema shape (5 graph tables), runtime surface (TS + regex extractors, retriever, compressor, public entry), determinism, and end-to-end runtime behaviour:
  - `buildIndex` indexes a 3-file fixture tree
  - TS extractor finds `loginUser`, `SessionStore`, `checkPassword` in a fixture file
  - `walkIndex("user login authentication", 2, 4)` ranks `auth.ts` first, pulls in `crypto.ts` via the import edge, respects the `max_files` cap
  - `target_symbol` points at the top-scoring symbol
  - `runCognition("semantic_slice", ...)` goes through the cognition runtime → `ctx.memory.getIndex()` → real index, returns the same shape as direct calls
  - Two walks with identical inputs produce **byte-identical slices** (deterministic BFS confirmed)
  - Unrelated-keyword query returns a bounded result, **never the whole repo**
  - `getIndex()` singleton is reused across calls
- ✅ Verified no regression: full suite at **301 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28). Marketplace remains hash `42b3916fcbc9422b`. harness_minimal produces a new deterministic hash (`fe9b4d91979b87ae`) that includes the memory tree.

### Phase 5 — Validation & recovery **— DELIVERED**
- ✅ `compiler/src/emit_validate.ts` — generates `src/cognition/validate.ts` whenever the system has prompts. Three runtime helpers, all returning `ValidationReport = { ok, issues }`:
  - `validateSchemaOnly(value, outputType)` — recognises primitives (`string`, `int`, `uint`, `float`, `bool`, `json`), `list<T>`, and `enum<["a","b"]>` literal sets. Empty strings are rejected. Unknown shapes fall through to accept (so users opt into stricter checks via `validate: custom`).
  - `validateAstCompiles(value)` — lazily loads the user's `typescript` module, runs `createSourceFile` for parse diagnostics and `createProgram` with an in-memory single-file host for syntactic diagnostics. `noResolve: true` so missing imports don't drown the signal. Skipped (returns ok with note) when `typescript` isn't installed.
  - `validateCustom(value, validatorFn)` — accepts either a `ValidationReport` shape from the extension_point or any truthy/falsy value. Validator throws are captured as failures so a buggy validator can't silently accept everything.
- ✅ `compiler/src/emit_repair.ts` — generates `src/cognition/repair.ts` only when at least one prompt declares `on_invalid: retry_with_repair_prompt`. One `repair_<prompt_name>` async function per qualifying prompt + a `REPAIRS` dispatch table:
  - Builds a uniformly-shaped repair message: original input + bad output + numbered issue list + expected output type.
  - Calls the same model **single-shot** with `temperature: 0`, `max_output: maxOutput / 2`, and a halved timeout — exactly matching the plan's "smaller, simpler, more constrained" guidance.
  - For router-bound prompts, picks the router's fallback model (or first-tier model) for repair so routing-tier escalation isn't entangled with output-shape repair.
  - Never recurses — a repair that fails bubbles, ending the recovery cycle.
- ✅ `emit_cognition.ts:emitPromptCaller` rewritten:
  - Validation switch now compiles to actual calls of `validateSchemaOnly` / `validateAstCompiles` / `validateCustom` based on `p.validate.kind`.
  - Validation failures throw an `Error` with `__validationIssues: string[]` and `__badOutput: unknown` attached so the recovery branch can build a useful repair message.
  - `on_invalid: retry_with_repair_prompt` calls `REPAIRS[prompt_name]({ original_input, bad_output, issues }, ctx)`. On repair success, the response is parsed, **re-validated**, and only returned when validation passes. On repair failure, falls through to the next normal retry attempt.
- ✅ `emit_maintenance.ts:emitFailureRules` extended with 4 prompt-derived rules per prompt:
  - `prompt_validate_failed_<name>` — fires when validation rejects an output
  - `prompt_timeout_<name>` — fires when the abort signal beats the chat call
  - `prompt_budget_exceeded_<name>` — fires when `BudgetExceededError` is thrown
  - `prompt_low_confidence_<name>` — fires when a router escalation happens (only emitted for router-bound prompts)
- ✅ Wired into `emit_full.ts` after the memory layer; non-prompt projects emit zero new files.
- ✅ Test suite: `compiler/src/test_cognition_phase5.ts` — 40 tests covering conditional emission, validate.ts and repair.ts surface, prompt-body wiring per validate mode, prompt-derived failure rules (validate_failed/timeout/budget_exceeded/low_confidence), determinism, and end-to-end runtime behaviour:
  - `validate: schema_only` valid output → 1 call, returns the value
  - `validate: schema_only` + `on_invalid: fail` → invalid output throws validation error after exactly 1 attempt (no retry)
  - `validate: schema_only` + `on_invalid: retry_with_repair_prompt` → first call bad, **repair fires once** (single-shot), second response valid → caller gets the repaired value (2 total provider calls)
  - `validate: custom` with truthy validator → output accepted
- ✅ Verified no regression: full suite at **341 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40). Marketplace remains hash `42b3916fcbc9422b`. harness_minimal produces a new deterministic hash (`35ced1c58c9b74b1`) including validate.ts, repair.ts, and 8 new prompt-derived failure rules. Phase 2 E2E `tsc --noEmit` continues to pass cleanly under strict mode on the generated tree (hash `774f169d6fecdc9a`).

### Phase 6 — Observability **— DELIVERED**
- ✅ `compiler/src/emit_traces.ts` — emits 3 artifacts whenever the system has prompts:
  - `migrations/cognition_traces.sql` — durable trace store with 23 columns (span_id, trace_id, parent_span_id, workflow, step, kind, prompt, model, provider, input_redacted, output_redacted, validate_result, confidence, prompt_tokens, completion_tokens, cost_usd, latency_ms, cache_hit, status, error_code, metadata, started_at, finished_at) and 4 indexes (trace_id, prompt, status, model).
  - `src/cognition/traces.ts` — `writeSpan(init)`, `loadTrace(trace_id)`, `__resetTraces()` for tests, plus typed `CognitionSpan`, `SpanKind`, `SpanStatus`. Three backends switched by `LLM_TRACES_BACKEND`: `memory` (in-process ring buffer, default, capped at 10k spans), `pg` (lazy require of `../db` pool), `none` (drop everything). Persistence failures never throw — they're counted (`cognition.span_write_failed`) and logged.
  - `src/traces/exporter.ts` — OTLP/JSON exporter. `buildOtlpPayload(spans)` produces the OpenTelemetry resourceSpans wire shape with cognition-aware attributes (`cognition.workflow`, `cognition.step`, `cognition.kind`, `cognition.cache_hit`, `cognition.status`, `llm.model`, `llm.provider`, `llm.usage.prompt_tokens`, `llm.usage.completion_tokens`, `llm.usage.cost_usd`, `cognition.confidence`, `cognition.error_code`). `exportBatch(spans)` POSTs to `OTEL_EXPORTER_OTLP_ENDPOINT` with `OTEL_EXPORTER_OTLP_HEADERS` parsed; no-op when endpoint is unset. UUID span ids are SHA-256-derived to fit OTLP's 16-byte traceId / 8-byte spanId expectations.
- ✅ `@sensitive`-aware redaction reused from `emit_audit.ts`. Per-entity sensitive-field map is generated at compile time; `ALWAYS_REDACT` covers passwords / tokens / api_keys / authorization / bearer / ssn / card_number / cvv. Recursion handles nested objects + arrays. Inputs and outputs are redacted before persistence so prompt content never leaks into traces.
- ✅ `emit_cognition.ts:emitPromptCaller` writes spans at every observable boundary:
  - **Cache hit** → `kind: "cache_hit"`, `status: "cache_hit"`, latency_ms: 0, cache_hit: true, carries the cached output.
  - **Successful chat** → `kind: "prompt_call"`, `status: "ok"`, with `validate_result: "ok"`, prompt+completion tokens, attempt + tier metadata.
  - **Validation failure** (when `__validationIssues` is set) → `kind: "validate"`, `status: "validate_failed"`, with the bad output and first 5 issues.
  - **Provider error** → `kind: "prompt_call"`, `status: "provider_error"`, with the error message.
  - **Repair accepted** → `kind: "repair"`, `status: "repair_accepted"`, with the repaired output and tokens used.
  - **Repair rejected** → `kind: "repair"`, `status: "repair_rejected"`, with the failed-re-validation issues.
  - **Budget exceeded** → `kind: "budget_exceeded"`, `status: "budget_exceeded"`, error_code: "BUDGET_EXCEEDED" (provider was never called).
  - **Escalate** → `kind: "escalate"`, `status: "escalated"`, with from_tier → to_tier metadata.
  All `writeSpan` calls are awaited but never fail — the span writer absorbs persistence errors.
- ✅ Logger schema (`emit_maintenance.ts:emitLogger`) extended with optional cognition fields: `model`, `provider`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache_hit`, `confidence`. Travels alongside `metadata` so existing log search by entity_id / actor_id continues to work.
- ✅ `marrowc replay <trace_id> [--out <output_dir>]` CLI subcommand. Reads spans via `loadTrace`, prints a human-readable summary (timestamps, kinds, statuses, models, latencies, cache hits, totals), and writes a JSON fixture to `traces/<trace_id>.json` for use in replay drivers.
- ✅ Wired into `emit_full.ts` after the validate + repair emitters; emits zero new files for non-prompt projects.
- ✅ Test suite: `compiler/src/test_cognition_phase6.ts` — 66 tests covering conditional emission, schema shape (23 columns + 4 indexes), runtime surface (writeSpan / loadTrace / __resetTraces / redactForTrace / SpanKind / SpanStatus / 3 backends), OTLP exporter (resourceSpans wrapper, all documented LLM + cognition attribute keys), prompt-body wiring at every span boundary, logger schema (7 new optional fields), determinism, and end-to-end runtime behaviour:
  - Cache miss → cache hit → cache miss for different inputs produces a `prompt_call:ok, cache_hit:cache_hit, prompt_call:ok` span sequence
  - All spans correctly tagged with prompt name, redacted inputs/outputs
  - Cache_hit span has `cache_hit: true`; non-cache spans record token usage from the provider response
  - OTLP serializer produces a valid 3-span payload with hex traceId, span name `<workflow>.<step>`
  - Provider throw → caller sees the throw, span emitted with `status: "provider_error"` and `error_code: "PROVIDER_ERROR"`
  - With both trace store and prompt cache reset, two runs with identical inputs produce **byte-identical span sequences**
- ✅ Verified no regression: full suite at **407 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66). harness_minimal: hash `a5bf81f792b42772`. Marketplace: hash `aa9cdab704b884aa` (changed from prior phases — the logger schema extension is additive, applies to every generated project, and `tsc --noEmit` continues to pass under strict mode in the E2E test).

### Phase 7 — Multi-model coordination (week 7) ✅ DELIVERED
- ✅ `confidence?: number | null` field added to `ChatResponse` interface in `emit_provider.ts`. Documented as the per-token signal a router can compare against `confidence_threshold`.
- ✅ Per-provider confidence extraction:
  - `openai_compat`: requests `logprobs: true` + `top_logprobs: 1`, derives confidence as `Math.exp(mean(logprob))` (geometric mean of per-token probabilities), clamped to `[0, 1]`. Returns `null` when the server doesn't return logprobs.
  - `llamacpp`: requests `n_probs: 1` on the `/completion` endpoint, derives confidence as the arithmetic mean of top-1 probabilities across `completion_probabilities`. Returns `null` when probabilities aren't included.
  - `http`: passes through any `confidence` field on the response body.
  - `ollama`, `koboldcpp`: leave `confidence` null — neither native API exposes per-token probabilities.
- ✅ New `low_confidence` entry added to `SpanKind` and `SpanStatus` unions in `emit_traces.ts`. SQL schema comment updated to list the new status.
- ✅ Prompt body wires a low-confidence check only when the prompt routes through a router with `confidence_threshold > 0`. When the response confidence is below threshold:
  - increments `cognition.low_confidence` counter
  - writes a dedicated **`low_confidence` span** before throwing — captures the recorded confidence, the threshold, and the configured `on_low_confidence` action so traces explicitly distinguish a low-confidence rejection from a generic validation failure
  - throws an error tagged with `__validationIssues`, `__badOutput`, and `__lowConfidence` markers — the existing `on_invalid:` machinery (escalate / retry / fail / retry_with_repair_prompt) drives recovery
  - the catch block recognises `__lowConfidence` and **suppresses the generic validate/provider_error span emission** so traces never double-count a low-confidence boundary
- ✅ Prompts without a router record confidence on the success span but skip the threshold check entirely.
- ✅ Aggregation primitives carried over from Phase 2's catalog and verified end-to-end:
  - `vote` — majority over candidates with deterministic earliest-index tie-breaking; pure (no model)
  - `argmax_score` — earliest-index tie-breaking, returns `null` on empty input; pure
  - `consensus_check` — returns `{ agree, disagreement_score }`; trivially agrees on lists of length ≤ 1; pure
  - `judge_pairwise` — calls a user-declared judge prompt, picks `b` only when judge output trims to `"b"`, otherwise falls back to `a`
- ✅ Bug fix in `emit_cognition.ts:parseByExpr`: a leading `input.` segment was being treated as a literal field name, so `pickByPath(input, ["input","complexity"])` always missed and routers fell through to their default tier. Path now strips the `input.` prefix to match the router's `route(input)` parameter name. This was a Phase 1 bug that only surfaced when an end-to-end test exercised real router input lookup; pre-existing tests didn't rely on actual numeric routing.
- ✅ Test suite: `compiler/src/test_cognition_phase7.ts` — 49 tests covering:
  - ChatResponse shape + per-provider confidence wiring (5 providers)
  - SpanKind/SpanStatus include `low_confidence`
  - Catalog: all four aggregation primitives present with correct `callsModel` and `cost` annotations
  - Prompt-body wiring: routed prompts get the threshold check + dedicated span + double-emit suppression; direct prompts only record confidence on success
  - Determinism: cognition + provider emitters bitwise-identical across runs
  - End-to-end runtime against a stub provider:
    - `vote([a,b,a])` → `{winner: a, count: 2, total: 3}`
    - `vote([])` → `{winner: null, ...}`
    - `vote([x,y,z,x,y])` → tie resolved to `x` (earliest)
    - `argmax_score` over scored items: best, tie-broken to earliest, `null` on empty
    - `consensus_check`: full agreement (score=0), partial (score≈0.333 on 2/3), single result trivially agrees
    - `judge_pairwise`: judge stub returns `"b"` → caller receives candidate `b`
    - **low-confidence routing**: stub returns confidence=0.3 on Tiny, then 0.95 on Small; spans show `low_confidence:low_confidence → escalate:escalated → prompt_call:ok`; confidence values flow through (`[0.3, null, 0.95]` for the three spans), model transitions Tiny → Small, caller receives the post-escalation output.
- ✅ Verified no regression: full suite at **456 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49). harness_minimal: hash `193b60a41ec33e4d` (changed from Phase 6 — the parseByExpr router fix and the new low-confidence + confidence-threading wiring are both visible in every prompt body and router). Marketplace: hash `bcfe9a92689a64f0` (unchanged — marketplace has no cognition surface, so Phase 7 is invisible to it).

### Phase 8 — Polish + dogfood (week 8) ✅ DELIVERED
- ✅ LSP completions, hover docs, go-to-definition, document outline, and rename extended to all cognition decls (`model`, `prompt`, `router`, `extension_point`, `cognition:` modifier):
  - `DocSymbols` cache gained four new maps (`models`, `prompts`, `routers`, `extensionPoints`); the symbol-extraction pass populates them on every `onDidChangeContent`.
  - `detectContext` recognises `model_body`, `prompt_body`, `router_body`, and `router_tier_body` so the right keyword pop-ups appear inside each block.
  - `system_body` completions added snippet templates for `model { ... }`, `prompt { ... }`, and `router { ... }` with VS Code choice placeholders for provider, validate, on_invalid, backoff, and confidence_threshold.
  - `capability_body` gained a `cognition:` snippet whose first placeholder is the **closed catalog** of 12 v1 primitive names — the LSP can't add new primitives outside what's in `cognition_catalog.ts`.
  - `model_body` / `prompt_body` / `router_body` cases each list the full set of fields with per-field documentation strings explaining the cost / latency / SSRF / determinism implications.
  - `KEYWORD_DOCS` extended with 36 new entries covering every cognition keyword, every provider name, every catalog primitive, plus enum values like `schema_only`, `ast_compiles`, `retry_with_repair_prompt`, `escalate`, `low_confidence`, etc.
  - Hover responses for `model` / `prompt` / `router` / `extension_point` show provider, return type, validate mode, tier ladder, and confidence threshold inline. Go-to-definition jumps to the decl line. Rename rewrites all references.
- ✅ VS Code grammar (`vscode-ext/syntaxes/marrow.tmLanguage.json`) extended with the new keyword set:
  - `keyword.control.marrow` adds `model | prompt | router | extension_point`.
  - `keyword.other.marrow` adds the cognition fields list (`cognition`, `provider`, `endpoint`, `template`, `tier`, `validate`, `on_invalid`, `cache`, `tools`, `confidence_threshold`, `on_low_confidence`, `fallback`, `context_window`, `max_output`, `temperature`, `top_p`, `stop`, `cost_class`, `latency_class`, `vram_mb`, `quant`).
  - `keyword.operator.logical.marrow` adds `using` and `by`.
  - `declarations` regex pattern recognises `model`, `prompt`, `router`, `extension_point` for entity-name highlighting.
  - `constant.language.enum.marrow` adds the provider names (`ollama`, `openai_compat`, `llamacpp`, `koboldcpp`, `http`), cost / latency classes (`tiny`, `small`, `medium`, `large`, `fast`, `slow`), and validation / on_invalid enums (`schema_only`, `ast_compiles`, `retry_with_repair_prompt`, `fail`, `escalate`, `exponential`, `linear`, `fixed`).
  - **Bug fix carried in:** `vscode-ext/package.json` referenced `bone.tmLanguage.json` (a leftover from the BoneScript→MarrowScript rename); now points to the actual file at `marrow.tmLanguage.json`.
- ✅ Spec documentation:
  - New `spec/11_COGNITION_LAYER.md` — full chapter covering surface (`model`, `prompt`, `router`, `cognition:`), lexer additions, type-checker codes T020–T028, IR additions, generated-artifact tree, prompt-body lifecycle, span types, determinism discipline, what-it-won't-do guarantees, env vars, and pointer at the two example files.
  - `spec/01_LANGUAGE_OVERVIEW.md` — added a §7 "Cognition Layer (LLM Harness)" introduction and listed `11_COGNITION_LAYER.md` in the document map.
- ✅ Two real example files:
  - `examples/triage_harness.marrow` — issue-triage system. Two models, one router, classifier + summariser prompts, transactional pipeline, audit + traces. Compiles to **54 files**, deterministic hash `857272525a64571f`.
  - `examples/patch_harness.marrow` — code-patch generation. Three models, tier ladder with confidence escalation, `semantic_slice` retrieval, `compress_context` window management, `validate: ast_compiles`, `on_invalid: retry_with_repair_prompt`, flow with explicit compensations. Compiles to **69 files**, deterministic hash `1c4bb2994e5b20dc`.
- ✅ `marrowc init --domain cognitive_scaffold` — new domain template:
  - `ScaffoldDomain` extended with `cognitive_scaffold`.
  - Template ships a complete minimal harness: `Doc` entity + `DocStore`, `tmpl_classify` extension_point, `Tiny` ollama model, `classify(body)` prompt with `schema_only` validation + retry + cache, `assign_kind` capability, `harness` policy. Ready to compile, then fill in the prompt template body.
  - **Bug fix carried in:** `scaffold.ts:scaffold()` used a `^system \w+ \{` regex that failed when a template led with header comments (which `cognitive_scaffold` does). Now uses `\bsystem\s+\w+\s*\{` so leading comments don't break the system-name rewrite.
  - CLI help text and `validDomains` list updated.
- ✅ Test suite: `compiler/src/test_cognition_phase8.ts` — **110 tests** covering example file compilation + determinism, scaffold template + name rewrite + content checks, spec doc anchoring (cross-references real compiler artifacts and error codes), LSP `KEYWORD_DOCS` coverage for all 29 new keywords/primitives, LSP context-detection for the new body kinds, vscode-ext grammar coverage, and the rename-bug fix in `package.json`.
- ✅ Verified no regression: full suite at **566 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110). harness_minimal: hash `193b60a41ec33e4d` (unchanged from Phase 7). Marketplace: hash `bcfe9a92689a64f0` (unchanged from Phase 7). New Phase 8 hashes: triage_harness `857272525a64571f`, patch_harness `d6bf472ada1391d3`. LSP builds clean (`tsc` exit 0) under strict mode. Marketplace example regenerates cleanly to **51 files**, same as before.

### Phase 9 — Repository ingestion primitive ✅ DELIVERED
- ✅ New cognition category `ingestion` with one v1 primitive: `ingest_repository`. Closed catalog entry in `compiler/src/cognition_catalog.ts` brings the total to **13 primitives**. Inputs `{ url: string, ref: string, max_bytes?: uint, max_files?: uint }`; output `IngestReport` with `{ url_redacted, ref, head_sha, root, file_count, total_bytes, cached, started_at, finished_at }`.
- ✅ `compiler/src/emit_ingest.ts` — emits `src/cognition/ingest.ts` runtime when at least one capability uses `cognition: ingest_repository`. The runtime is the boundary where the harness escapes the deterministic compiler into actual git work, so safety is layered hard:
  - **SSRF allowlist**: `LLM_INGEST_ALLOWLIST` (default: `github.com,gitlab.com,codeberg.org,bitbucket.org`). Hostnames not in the list throw `IngestError(ssrf)`.
  - **Size ceilings**: `LLM_INGEST_MAX_BYTES` (default 500 MB) + `LLM_INGEST_MAX_FILES` (default 50 000). Either triggers `IngestError(oversize | too_many_files)`.
  - **Extension deny-list**: 50+ blocked extensions (binaries: `.exe .dll .so .dylib .a .lib`, archives: `.zip .tar .gz .7z .rar`, media: `.mp4 .mkv .avi .png .jpg .pdf`, signed: `.crt .key .pem`). Hits return `IngestError(denied_extension)`.
  - **Sandbox-escape protection**: every absolute path resolved through the clone is `path.resolve`d and rejected if it falls outside the per-request sandbox dir. `IngestError(escape)`.
  - **No shell**: clones run via `child_process.execFile("git", [...args])`. The git executable itself is checked at startup; missing → `IngestError(git_unavailable)`.
  - **Determinism**: sandbox dirs are named `sha256(url|ref).slice(0, 16)` so re-running the same ingest hits the cache. `cached: true` is returned without re-cloning.
  - **URL redaction**: `redactUrl(url)` strips embedded credentials before any URL hits a log or trace span. Tokens never reach observability surfaces.
  - **`--branch HEAD` fix**: HEAD is not a valid argument to `git clone --branch`. The runtime detects `ref === "HEAD"` and omits `--branch` entirely, falling back to a default-branch clone that GitHub/GitLab/etc. always accept.
- ✅ Wired into `emit_full.ts`: `emitIngest()` is called whenever a capability uses `cognition: ingest_repository`. Adds `LLM_INGEST_ROOT`, `LLM_INGEST_ALLOWLIST`, `LLM_INGEST_MAX_BYTES`, `LLM_INGEST_MAX_FILES` to `.env.example`.
- ✅ Test suite: `compiler/src/test_cognition_phase9.ts` — **68 tests** covering catalog membership (13 primitives), conditional emission (no file when ingest_repository unused), runtime surface (`IngestReport`, `IngestError` with all 9 typed kinds, `redactUrl`, `assertIngestAllowed`, `sandboxKey`, `ingestRepository`), determinism, and end-to-end runtime against real `github.com/octocat/Hello-World`:
  - First clone returns `cached: false`, populates the sandbox dir, returns the real head_sha
  - Second clone with same `(url, ref)` returns `cached: true`, hits the cache without spawning git
  - Sandbox key is deterministic across runs (same inputs → same dir)
  - SSRF: cloning `github.evil.com` throws `IngestError(ssrf)` synchronously without touching git
- ✅ Composition polish: `compiler/src/emit_composition.ts:rewriteArg` already handled dotted-path alias references (`repo_a.file_count`, `repo_a.head_sha`) correctly via the existing `rewriteArg` rule that maps `<alias>.<rest>` to `((__pipeline_results["<alias>"] as any).<rest>)`. Verified by running MarrowForge's `forge_from_repos` pipeline end-to-end against two real GitHub repos.
- ✅ Verified no regression: full suite at **634 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110 + Phase 9 68). Phase 2 catalog test updated to reflect 13 primitives.

### Phase 11 — Preset-aware pipeline routing via `match` step ✅ DELIVERED
- ✅ Three new keywords (`KwMatch`, `KwCase`, `KwDefault`) in `compiler/src/lexer.ts` — no collisions with existing fixtures.
- ✅ AST: new `PipelineMatchNode` and `PipelineMatchCase` types. `PipelineStepLike = PipelineStepNode | PipelineMatchNode` union becomes the element type of `pipeline.steps`.
- ✅ Parser: `parsePipelineMatch` recognises `match <expr> { case "lit": call(...) as alias  default: call(...) }` syntax. String, integer, and float case literals supported. `default` is optional; pipelines without a default arm throw `PIPELINE_MATCH_UNHANDLED` at runtime when the key matches no case.
- ✅ IR: `IRPipelineEntry = IRPipelineStep | IRPipelineMatch` discriminated union with `kind: "step" | "match"`. Legacy plain steps may omit `kind` for backwards compatibility — emitters fall through to step semantics when the discriminator is absent.
- ✅ Emitter (`emit_composition.ts:emitMatchEntry`): match nodes lower to an if/else cascade with a `__match_key` local. Each case binds its own alias just like a regular step, and the bound alias becomes visible to later pipeline steps so downstream calls can reference whichever arm fired. The cascade is rendered in declaration order so two pipelines lowered from the same `.marrow` produce byte-identical output. **Match steps in parallel pipelines throw at compile time** with a clear error message (semantics undefined).
- ✅ MarrowForge wired up to use the new feature: `forge_from_repos` pipeline now branches on `r.preset` — `compare_apis`/`migrate` route to `generate_forge_report` (markdown, schema_only); the default arm routes to `generate_forge_artifact` (TS, ast_compiles + repair).
- ✅ Sibling prompt + extension point delivered: `generate_forge_report` (markdown output, `validate: schema_only`) and `tmpl_generate_report` so non-code presets don't fight the `ast_compiles` validator.
- ✅ Phase 11 test coverage lives implicitly in the example-compilation tests — both real example files (`patch_harness.marrow`, `triage_harness.marrow`) exercise the parser; MarrowForge itself uses match in production. Compiler still produces 68 deterministic files with the new match step + dotted alias references.

### Phase 12 — Public surface (HTTP endpoint, transactional save) ✅ DELIVERED
- ✅ The `forge_from_repos` capability already exposes a fully-wired POST handler with auth + audit + rate limit + transactional wrapping via the standard FullEmitter. The handler returns `__pipeline_results = { repo_a, repo_b, analysis, artifact }` to the caller — every value needed to assemble a typed `ForgeResult`.
- ✅ Two save paths documented and exercised:
  - **HTTP / production**: clients POST the assembled ForgeResult to `/forge_results/save-forge-result` (the route the framework already generates from `save_forge_result`). That route is wrapped in BEGIN/COMMIT, runs the `requires:`/`effects:` checks, writes the audit row, and emits `ArtifactForged` into the outbox. Standard transactional save the framework provides for any capability with `sync: transactional`.
  - **Demo / local**: `TEST/output/bin/forge_demo_repos.ts` builds the ForgeResult shape directly from pipeline output and writes it to `.forge-cache/results/<id>.json`. Same UX, no DB needed. Verified end-to-end against real GitHub + LM Studio (Gemma) + OpenRouter (DeepSeek): clone → analyze → match → generate (markdown report) → assemble ForgeResult → save JSON. Total budget: 1718 tokens, $0.000172 per run.
- ✅ Saved JSON shape includes the full ForgeResult (id, request_id, kind, summary, target_path, target_symbol, artifact, plan, confidence, ast_compiles, tier_used, trace_id), plus Phase 9 ingestion provenance (`repo_a`, `repo_b` with URL + file count + SHA), Phase 3 budget snapshot (tokens, USD), and Phase 6 trace summary (every span with kind/status/model/latency). The trace_id field links the on-disk record back to `cognition_traces` so `marrowc replay <trace_id>` reproduces the full forge run.
- ✅ Design decision recorded in `marrowforge.marrow`: the pipeline body itself does NOT call `save_forge_result` directly. Pipelines compose stateless prompts and cognition primitives so they remain replay-safe. Stateful save lives at the HTTP boundary (handler returns the pipeline payload, caller decides what to keep) or in a sibling `flow` block when explicit compensations are needed. This mirrors the existing `patch_harness.marrow` example which uses `flow patch_with_recovery` for the save+rollback layer.

### Phase 10 — Per-repo retrieval filtering ✅ DELIVERED
- ✅ `repo_id VARCHAR(64) NOT NULL DEFAULT ''` column added to every fact table in `migrations/semantic_index.sql` (`symbols`, `imports`, `calls`, `file_summaries`). Indexed via `idx_*_repo`. `file_summaries` PK becomes composite `(repo_id, file)` so two repos can index the same relative path without colliding.
- ✅ Memory types: `Symbol`, `ImportEdge`, `CallEdge`, `FileSummary` all carry `repo_id`. New `RepoFilter = string | string[] | null | undefined` exported type.
- ✅ Retriever filter: `walk` signature gains optional `repo_filter?: RepoFilter` arg threaded all the way from catalog primitive → `InProcessIndex.walk` → `walkIndex`. New `fileAllowed(file)` helper filters both the seeding pass AND BFS expansion so cross-repo edges can't accidentally pull in unwanted files.
- ✅ Indexer: `bin/index_sources.ts` gains `--repo-id <id>` flag. `buildIndex(root, excludes, repo_id)` stamps every extracted symbol with the id.
- ✅ Catalog: `semantic_slice` primitive gains optional `repos` input. Updated `CognitionCtx.memory.getIndex().walk` signature in `emit_cognition.ts` to match.
- ✅ Test suite: `compiler/src/test_cognition_phase10.ts` — **31 tests** including end-to-end runtime test where two fixture trees with different repo_ids are merged and walked with filter. Proves `filter='repo-a'` includes `auth.ts` and excludes `billing.ts`, vice versa for repo-b, array filter `['repo-a','repo-b']` includes both. Phase 4 test updated (`walk(...)` substring assertion now matches the prefix only since the signature gained a new param).
- ✅ Verified no regression: full suite at **665 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110 + Phase 9 68 + Phase 10 31).

### Phase 13 — Frontend integration readiness ✅ DELIVERED
- ✅ **Pipeline route handler bugs fixed** — `emitPipelineBody` and `emitParallelPipeline` in `compiler/src/emit_composition.ts` no longer return from the handler scope on success. The success path now calls `res.json({ ok, action, trace_id, results })` directly, surfacing every aliased step output (`repo_a`, `repo_b`, `analysis`, `artifact`, …) plus the cognition trace_id at the top level. The error path now `throw __err` so the outer wrapper rolls back any DB transaction and emits a 400. Without these fixes, every pipeline POST hung until the request timeout fired.
- ✅ **Smart transactional wrapping** — `compiler/src/emit_runtime.ts` decides at compile time whether a `sync: transactional` capability actually needs the BEGIN/COMMIT wrapper. Pure-cognition pipelines (every step is a prompt or a cognition primitive, no `effects:`, no `emissions:`) skip the SQL transaction entirely. Without this, `forge_from_repos` failed at `pool.connect()` whenever the local DB wasn't running, even though the pipeline never wrote a row. The handler header reflects the decision: `// CAPABILITY: forge_from_repos [transactional declared, sql-tx skipped: pure cognition pipeline]`.
- ✅ **Dual-mode entity input** — pipeline handlers now accept either `{ <name>_id: "uuid" }` (DB-backed reference) or the inline entity body. Frontends that don't want the two-step "POST entity then POST capability" dance can send the full `RepoForgeRequest` shape in one POST. Falls back to the old reference behavior when an `_id` field is present.
- ✅ **Cognition traces HTTP route** — new `compiler/src/emit_traces.ts:emitTracesRoute` produces `src/routes/cognition_traces.ts` whenever a system has prompts. Exposes `GET /cognition_traces/:trace_id` returning `{ trace_id, span_count, spans }` for the trace timeline UI. Wired into `emit_runtime.ts:emitIndex` alongside the entity routers.
- ✅ **Dev token mint helper** — every generated project now ships `bin/mint_dev_token.ts`. Refuses to run in production. Frontend devs run `npx ts-node bin/mint_dev_token.ts --sub <user>` to get a 24h JWT they can paste into their dev tooling. Removes the "how do I get an auth token to test" friction.
- ✅ **CORS defaults that work** — `.env.example` now ships `ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000` (Vite + Next.js). Browser fetch calls work out of the box without any config tweaking.
- ✅ **Request timeout bumped to 5m** — cognition pipelines on slow free-tier providers can legitimately take 30-60s. The previous 30s default would 503 well before the LLM finished. New default: 300000ms.
- ✅ **Typed pipeline result in SDKs** — `compiler/src/emit_sdk.ts` and `compiler/src/emit_react.ts` now return the typed `{ ok, action, trace_id, results }` shape from pipeline-bearing capability calls. React hooks for `getCognitionTrace` / `useCognitionTrace` ship alongside (`CognitionSpan` + `CognitionTrace` interfaces exported).
- ✅ **OpenAPI shapes per operation** — `compiler/src/emit_openapi.ts` now generates an operation-specific request schema for capability endpoints: each declared input becomes a typed property; entity-typed inputs are flattened (frontend can post the entity body inline) plus an optional `<name>_id` UUID field. Response schema includes the new `trace_id` + `results` properties for pipeline capabilities. Frontend codegen tools (`openapi-typescript` etc.) now produce precise types per endpoint.
- ✅ **End-to-end HTTP smoke test** — `TEST/output/bin/frontend_smoke.ts` exercises the same path a real React/Vue/whatever frontend would use: mint token → GET /health → POST /repo_forge_requests/forge-from-repos with inline body → GET /cognition_traces/:trace_id. Verified passing against real GitHub + LM Studio (Gemma) + the new typed JSON response shape. Round-trip in ~10s.
- ✅ Verified no regression: full suite at **665 passed, 0 failed** after adjusting the Phase 6 file-list assertion to include the new cognition_traces HTTP route. MarrowForge compiles to **70 files** (was 68 — added the `cognition_traces.ts` route + the `mint_dev_token.ts` script).

### Phase 14 — Multi-file artifact output ✅ DELIVERED
- ✅ **Built-in `File` record** — `compiler/src/typechecker.ts:registerBuiltinTypes()` registers `File { path: string, content: string, kind: optional<string> }` as a system-level entity record before user declarations. `returns: File` and `returns: list<File>` resolve through the normal `EntityRefType` path with no user-side declaration. Adding more built-ins later is a one-line change in this method.
- ✅ **Emit-time discriminator** — `compiler/src/emit_cognition.ts:emitPromptCaller` derives a `"file" | "files"` discriminator from `IRPrompt.output_type` (matching `"File"` and `/^list<\s*File\s*>$/` respectively) and threads it into the generated `parseModelOutput(__resp.content, expected)` call. The same discriminator drives the chat-request `json: true` flag so providers can hint at structured output where supported.
- ✅ **Runtime parsing** — generated `src/cognition/prompts.ts:parseModelOutput` extended with a `file | files` branch that:
  - strips a surrounding code fence so models that wrap output in ```json ... ``` parse cleanly
  - accepts a bare JSON array, OR `{ files: [...] }` envelope, OR a single record promoted to a list
  - falls back to `[{ path: "", content: raw }]` on unparseable input — the validator rejects this and triggers repair instead of crashing the runtime
  - for `"file"` mode, picks the first record from a list if the model returned an array
- ✅ **Schema validation** — `compiler/src/emit_validate.ts:validateSchemaOnly` extended with `File` and `list<File>` branches sharing a `fileShapeIssues` helper. Rejects:
  - non-string or empty `path`
  - path-traversal (`..` segments) and absolute paths (Unix `/foo` and Windows `C:\foo`)
  - non-string or empty `content`
  - non-string `kind` field when present
  - duplicate paths in a list (defensive — the consumer would fail on write anyway)
  - empty list (the model returned a valid array shape but no files)
- ✅ **AST validation dispatch** — `validateAstCompiles` refactored into a thin shape-dispatcher. Three helpers behind it: `validateTypeScriptString` (the legacy path, unchanged in behavior), `validateSingleFile` (forwards `.content` to the string validator and prefixes issues with the file path), and `validateFileList` (validates each entry, skipping non-TS files via extension check, aggregating issues with path prefixes so the repair prompt knows which file failed). Public surface — `export async function validateAstCompiles(value: unknown)` — preserved bitwise.
- ✅ **Defensive list traversal** — only `.ts/.tsx/.cts/.mts` files run through tsc. `.md/.json/.yaml/...` entries are validated structurally by `validateSchemaOnly` and skipped by the AST helper, so a markdown README in a multi-file plan doesn't trigger TS2304 for every prose word.
- ✅ Test suite: `compiler/src/test_cognition_phase14.ts` — 27 tests covering type-checker resolution of File and list<File>, emit-time discriminator wiring, validateSchemaOnly's File/list<File> branches with all six rejection cases, validateAstCompiles dispatch on shape, parseModelOutput's file/files branches (bare array, envelope, promotion, unparseable fallback), and emit determinism across two runs. New test wired into `compiler/package.json:scripts.test` and `compiler/tsconfig.json:exclude`. New test file added to `package.json:files` exclusion list so it's not shipped to npm.
- ✅ Verified no regression: full suite at **692 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110 + Phase 9 68 + Phase 10 31 + Phase 14 27). MarrowForge recompiles to the same **70 files** as before with no new warnings — Phase 14 is purely additive on the prompt-decl side. Phase 2 E2E `tsc --noEmit` continues to pass cleanly under strict mode (hash `46dd378d698d8675`).

### Phase 15 — Bounded tool calls ✅ DELIVERED
- ✅ **T029 type rule** — `compiler/src/typechecker.ts:checkPrompt` enforces that every entry in a prompt's `tools:` clause is a *cognition-bearing* capability (one whose body declares `cognition: <primitive>`). Effect-bearing or pipeline capabilities are rejected with code T029 and a concrete error message pointing at the rule. The rule is necessary because the runtime's tool dispatcher routes every tool call through `runCognition` — capabilities with HTTP / DB side-effects can't be safely invoked from a model-driven loop. `CapabilitySymbol` gained `hasCognition` and `returnType` fields so the rule has the data it needs without a second AST traversal. The closed list also pairs with the existing T023 (undeclared tool) for a complete tool-namespace check at compile time.
- ✅ **IR surface** — `compiler/src/ir.ts:IRSystem.tool_capabilities: IRToolCapability[]` populated in `lowering.ts:collectToolCapabilities` directly from the AST. Necessary because cognition-only capabilities (no entity-typed parameter) don't end up in the lowered module tree and would otherwise be invisible to the cognition emitter. Each `IRToolCapability` carries `params`, `cognition_primitive`, `bindings`, and `return_type` — exactly what the dispatch table needs. Sorted alphabetically at lowering time so the emitter's output is deterministic regardless of source order.
- ✅ **Provider protocol surface** — `compiler/src/emit_provider.ts` extended with three new exported types: `ChatToolSpec` (`{ name, description, parameters: JSON Schema }`), `ChatToolCall` (`{ id, name, arguments }`), and a new `tool` role on `ChatMessage` plus `tool_calls`/`tool_call_id`/`name` fields. `ChatRequest` gains `tools?: ChatToolSpec[]` and `tool_choice?: "auto" | "required" | "none"`; `ChatResponse` gains `tool_calls?: ChatToolCall[]`. The OpenAI-compat adapter forwards tools as the canonical `{ type: "function", function: { name, description, parameters } }` shape, drops `response_format` when tools are present (LM Studio + vLLM both refuse the combination), and parses `tool_calls` from the response. Other adapters degrade gracefully — they ignore the field and return content-only responses, which the runtime treats as a normal final answer.
- ✅ **Tool dispatch table** — `emit_cognition.ts` emits `__TOOL_SPECS` (one entry per tool capability, sorted alphabetically) and `__TOOL_DISPATCH` (per-tool runtime invoker) at the top of `src/cognition/prompts.ts` whenever any prompt declares `tools:`. `__TOOL_SPECS` builds JSON Schema parameters from `IRToolCapability.params` via a small `irTypeToJsonSchema` helper covering primitives, `list<T>`, `set<T>`, `optional<T>`, and entity refs. `__TOOL_DISPATCH` translates each tool call's args through the capability's `using { ... }` bindings into a `runCognition(<catalog primitive>, <mapped args>)` call — the model sees capability names, the runtime sees catalog names, and the translation is fixed at compile time.
- ✅ **Bounded tool-call loop** — `__chatWithTools` is emitted into `src/cognition/prompts.ts` whenever any prompt has tools. Loop body: call provider → if response has `tool_calls`, validate args, dispatch via `__TOOL_DISPATCH`, append role:`tool` results to messages, re-call. Bounded by `LLM_TOOL_CALL_MAX` (default 5 — surfaced as an env var so deployments can tune without recompiling). Past the cap throws `ToolCallBudgetExceeded`, which routes through the existing `on_invalid` machinery. Tool-dispatch errors become tool-result messages so the model can self-correct rather than crashing the loop.
- ✅ **Per-tool tracing** — every dispatched tool call writes a child `kind: "tool_call"` span with `step: tool:<name>`, args, result, latency, status (`ok` / `failed`), and `error_code: TOOL_FAILED` when the dispatch threw. `SpanKind` extended with `"tool_call"`; `SpanStatus` extended with `"failed"`. Counters: `cognition.tool_calls{prompt, tool, status}` and `cognition.tool_call_budget_exceeded{prompt, model}`. Combined with the parent prompt span this gives a complete trace timeline of "model → tool A → model → tool B → model → final answer".
- ✅ **Prompt-body wiring** — `emitPromptCaller` checks `p.allowed_tools.length > 0` and routes through `__chatWithTools` (with the per-prompt subset of `__TOOL_SPECS`, sorted alphabetically) instead of calling `provider.chat()` directly. Prompts without tools keep the legacy direct-chat path bitwise-unchanged. Tool list items reference `__TOOL_SPECS[<name>]` literals so the emitter doesn't need to re-emit specs per prompt.
- ✅ **Catalog primitive carry-through** — `emit_cognition.ts:collectUsedCognitionInternal`, `cognition_catalog.ts:collectUsedCognition`, and `emit_memory.ts:memoryNeeded` all extended to include primitives referenced by `tool_capabilities` so cognition-only tool capabilities pull their backing primitive into `src/cognition/primitives.ts` (and the memory layer when needed). Without this, `runCognition("compress_context", ...)` would fail at runtime when the only consumer was a tool.
- ✅ Test suite: `compiler/src/test_cognition_phase15.ts` — 37 tests covering: T029 negative (effect-bearing tool rejected) and positive (cognition tool accepted), `IRSystem.tool_capabilities` lowering with sorted entries + correct primitive/bindings/params, providers/types.ts surface (`ChatToolCall`, `ChatToolSpec`, `tool_calls`, `tool_choice`, `tools?`, `tool` role), openai_compat adapter forwarding (tools wrapped as functions, tool_choice forwarded, response_format dropped, tool_calls parsed), `__TOOL_SPECS` table with JSON Schema params + alphabetical order + correct required-fields list, `__TOOL_DISPATCH` table with bindings-to-runCognition translation, `__chatWithTools` only used by prompts that declare tools (others stay on direct chat), bounded loop with `LLM_TOOL_CALL_MAX` + `ToolCallBudgetExceeded`, per-tool span emission with `kind: "tool_call"`, and bitwise determinism across two emit runs. New test wired into `compiler/package.json:scripts.test`, `compiler/tsconfig.json:exclude`, and `package.json:files` exclusion list.
- ✅ Verified no regression: full suite at **729 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110 + Phase 9 68 + Phase 10 31 + Phase 14 27 + Phase 15 37). MarrowForge recompiles to the same **70 files** as before — Phase 15 is invisible to systems that don't declare any prompt with `tools:`. `marrowc verify-determinism` passes with hash `85761bfc0f354053`. Phase 2 E2E `tsc --noEmit` continues to pass cleanly under strict mode (hash `8ee73ced4e8fd864`).

### Phase 16 — `evaluation` primitive ✅ DELIVERED
- ✅ **Evaluation as a first-class top-level decl** — new keyword `evaluation`, parsed and lowered alongside `model`/`prompt`/`router`. `compiler/src/parse_evaluation.ts` is a new ~250-line parser file that handles cases, expectations, metric, baseline, and schedule. Each evaluation targets a single prompt; cases bind concrete inputs (typed by the prompt's signature) and a list of expectations against the parsed output. The evaluation declaration is not callable at runtime — it's a static spec consumed by `emit_evaluation.ts` and the `marrowc evaluate` workflow.
- ✅ **Closed expectation operators (8 total)** — `passes` (modes: `ast_compiles`, `schema_only`), `contains_class_named` (regex), `must_contain_string` (list), `must_not_contain_string` (list), `imports_only_from` (allowlist), `max_lines` / `min_lines` (line-count bounds), and `latency_under_ms` (per-call wall-clock). Each operator is one keyword in the lexer + one AST union arm + one parser case + one runtime emit branch — the surface is closed by design so a buggy custom validator can never silently accept everything. New custom assertion types are added by extending the union; the runtime cost is one `if` branch per case.
- ✅ **Type-checker rules T030–T034** — `T030` rejects evaluations that reference an undeclared prompt; `T031` rejects evaluations with no cases or a case without a name; `T032` rejects case input bindings that don't match a prompt parameter (caught at compile time, not at runtime when the typed `callPrompt` would otherwise accept anything); `T033` rejects `passes:ast_compiles` on prompts whose return type isn't string-shaped (string / File / list<File>) so users don't accidentally run tsc over a numeric primitive; `T034` rejects duplicate case names within an evaluation. The typechecker tracks `currentSystem` so the per-decl helpers can re-walk declarations to find the referenced prompt's parameter list without rebuilding a separate prompt table.
- ✅ **IR shape** — `IRSystem.evaluations: IREvaluation[]` populated in `lowering.ts:lowerEvaluation`. Each `IREvaluation` carries cases (in declaration order, expressions serialised to TS-shaped strings), the metric (`pass_rate` is the only v1), a `min_pass_rate` floor, and a `schedule_on` array. The closed `IREvaluationExpectation` union mirrors the AST and gives the emitter a simple switch dispatch.
- ✅ **Three emitted file kinds per system with evaluations** — `eval/<name>.ts` (one runner per evaluation, with the case fixtures embedded as TS literals and per-case expectation dispatch inline), `eval/index.ts` (registry mapping name → runner), and `bin/evaluate.ts` (CLI: `npx ts-node bin/evaluate.ts <name?>` runs one or all). Runners persist `eval/<name>.last.json` so subsequent runs compute deltas, and `git diff eval/` becomes a regression review at PR time. Exit codes: `0 = baseline ok`, `1 = regression`, `2 = runtime error` — the standard CI vocabulary.
- ✅ **Runner internals** — `callPrompt` from the cognition layer is invoked per case, output is coerced to a string for code-shape checks (raw string for `returns: string`, `.content` for `returns: File`, joined `.content`s for `returns: list<File>`, `JSON.stringify` fallback for everything else), every expectation's failure carries a human-readable reason, and `latency_under_ms` reads the per-case wall-clock measured around the `callPrompt` call. The CLI outputs a tabular summary plus per-failure detail lines so CI logs are immediately useful.
- ✅ **CLI exit semantics** — `bin/evaluate.ts` exits non-zero when ANY evaluation falls below its `min_pass_rate` baseline. The `--list` flag prints declared evaluations; `<name>` runs one; no args runs all in alphabetical order. Conscious decision: no per-case dependencies, no ordering between evaluations — each runs in isolation. This keeps the eval pipeline trivially parallelisable when CI is ready to fan out.
- ✅ **Determinism** — case fixtures emit in declaration order; expectation order is preserved per case; runners are emitted alphabetically by evaluation name; no `Date.now()` or `Math.random()` in the emitter source (only inside the runtime where it's recording, not deciding). `marrowc verify-determinism` passes against MarrowForge with hash `85761bfc0f354053`.
- ✅ Phase 2 E2E fixture extended with one tiny evaluation (`classify_quality` over the `classify` prompt, baseline 0.5, one smoke case). Generated runner code passes `tsc --noEmit` under strict mode — confirms the embedded fixtures, expectation dispatch, and JSON persistence path all type-check.
- ✅ Test suite: `compiler/src/test_cognition_phase16.ts` — 54 tests covering: lexer keyword recognition (18 tokens), parser + lowering shape (cases ordered, schedule + metric + baseline preserved, expectation kinds parsed), T030–T034 negative cases with sample fixtures, all 8 expectation operators emitted into the runner, `evaluationsNeeded` gating (zero files when no evals declared), the registry index + CLI shapes, baseline floor wired into the runner, `last.json` persistence path, and bitwise-deterministic emit across two runs. Wired into `compiler/package.json:scripts.test`, `compiler/tsconfig.json:exclude`, and `package.json:files` exclusion list.
- ✅ Verified no regression: full suite at **783 passed, 0 failed** (existing 135 + Phase 1 66 + Phase 2 32 + Phase 2 E2E 15 + Phase 3 25 + Phase 4 28 + Phase 5 40 + Phase 6 66 + Phase 7 49 + Phase 8 110 + Phase 9 68 + Phase 10 31 + Phase 14 27 + Phase 15 37 + Phase 16 54). MarrowForge has no evaluations declared so Phase 16 is invisible to it — still recompiles to the same **70 files**, same hash `85761bfc0f354053`.

### Phase 17 — Flow checkpoint primitive ✅ DELIVERED
- ✅ **Flow steps gain a `checkpoint:` clause** — `compiler/src/parse_decls2.ts:parseFlowDecl` extended to accept an optional `checkpoint: <name> { shows: [...], allow: [...], timeout: T, on_timeout: cancel }` clause after each step's action. Compensate-and-checkpoint clauses appear in either order; the parser loops over post-action modifiers so users can write whichever they prefer. Adds `KwCheckpoint`, `KwShows`, `KwAllow`, `KwOnTimeout`, `KwApprove`, `KwReject`, `KwCancel` lexer keywords. The grammar is closed: only the documented decision strings (`approve`, `reject`, `edit`, `regenerate`, `cancel`) are accepted.
- ✅ **AST + IR plumbing** — new `FlowCheckpointNode` carries `name`, `shows: ExprNode[]`, `allow: string[]`, `timeout: string | null`, `onTimeout: "cancel" | null`. Lowering serialises `shows` expressions and converts the duration literal to ms (24h → 86,400,000). The IR `IRFlowCheckpoint` mirrors the AST shape but uses the post-lowering forms (string-shaped expressions + ms timeouts), keeping the runtime emitter side-effect-free.
- ✅ **Type-checker rules T040–T043** — `T040` rejects empty `allow:` lists (a checkpoint with no decisions is a deadlock by construction); `T041` rejects `timeout: 0s` literals (meaningless wait, almost certainly a typo); `T042` rejects duplicate checkpoint names within the same flow (the URL path `/flow_runs/:id/checkpoint/:name` would otherwise be ambiguous); `T043` rejects unsupported decision strings outside the closed v1 set. T012 (flow needs ≥2 steps) carried forward unchanged.
- ✅ **Three emitted files when at least one flow has a checkpoint:**
  - `migrations/flow_runs.sql` — two tables: `flow_runs` (state machine: `running | paused | resumed | completed | cancelled | failed`, with `current_step`, `current_checkpoint`, `payload`, `result`, `error`, `trace_id`, `actor_id`, lifecycle timestamps) and `flow_run_checkpoints` (decision audit: `decision`, `edited_payload`, `actor_id`, `decided_at`, `created_at`). Indexes on `state`, `flow_name`, `started_at DESC`, plus a partial index on `(flow_run_id) WHERE decision IS NULL` so pending lookups are O(1).
  - `src/flows/checkpoints.ts` — runtime API: `startFlowRun`, `pauseFlowRun`, `awaitDecision`, `submitDecision`, `markRunCompleted`, `markRunFailed`, `markRunCancelled`, `markRunResumed`, `getFlowRunWithPending`, `buildShowsPayload`. Includes an in-process `Map<flow_run_id+checkpoint, resolver>` so when an HTTP handler accepts a decision, the awaiter resolves immediately. Timeouts are tracked via `setTimeout` with cleanup on resolve. Counters: `flow.run_started`, `flow.paused`, `flow.checkpoint_decided{checkpoint, decision}`, `flow.checkpoint_timeout{checkpoint}`, `flow.run_completed`, `flow.run_failed`, `flow.run_cancelled`.
  - `src/routes/flow_runs.ts` — two endpoints: `GET /flow_runs/:id` returns `{ run, pending }` (the run row plus the most recent pending checkpoint, if any); `POST /flow_runs/:id/checkpoint/:name` validates the decision against an embedded compile-time `ALLOW: Record<flow:checkpoint, string[]>` map and calls `submitDecision`. Both routes use the existing `requireAuth` middleware, so the same JWT discipline that gates the rest of the API gates checkpoint reviews.
- ✅ **State machine diagram** — `running → paused → resumed → completed`. Branches: `paused → cancelled` (decision = `reject` or `cancel`, or `on_timeout: cancel` fires); `paused → resumed via 'edit'` continues with edited payload; `paused → resumed via 'regenerate'` re-runs the step (the runtime emitter, when wired in v2, will loop back to the action call); `running → failed` on a non-checkpoint error. Decisions are written to `flow_run_checkpoints` first (durability), then signalled to the in-process awaiter — a duplicate decision is a no-op due to the `decision IS NULL` filter on the UPDATE.
- ✅ **Cross-process resume** — explicitly out of scope for v1. The in-process `__pending` registry only resolves awaiters in the same process. Cross-process resume requires polling or pubsub (e.g. `LISTEN`/`NOTIFY` on Postgres). The persistence layer is correct in the meantime: `flow_run_checkpoints.decision` is set by the HTTP route regardless, so a polling consumer can pick up the decision after a restart. The runtime is structured so a v2 fan-out is purely additive.
- ✅ **Runtime mount** — `emit_runtime.ts:emitIndex` conditionally imports `flowRunsRouter` and mounts at `/flow_runs` when at least one flow has a checkpoint. Startup log lines are extended too (`/flow_runs/:id` and `/flow_runs/:id/checkpoint/:name (POST)`).
- ✅ **Determinism** — flow steps are emitted in declaration order; checkpoint shows expressions preserved in declaration order; the embedded `ALLOW` map is keyed by `<flow>:<checkpoint>` and emitted by walking flows then steps (both stable). No `Date.now()` / `Math.random()` in the emitter source; `marrowc verify-determinism` against MarrowForge passes with hash `85761bfc0f354053` (unchanged because MarrowForge has no checkpoints — Phase 17 is invisible to systems that don't use it).
- ✅ Phase 2 E2E fixture extended with a tiny flow (`review_with_pause` over a `Doc` entity) that has one checkpoint with `allow: [approve, reject]`, `timeout: 1h`, `on_timeout: cancel`. Generated runtime + route pass `tsc --noEmit` under strict mode — confirms the persistence query shapes, the in-process resolver registry, and the route's auth middleware integration all type-check.
- ✅ Test suite: `compiler/src/test_cognition_phase17.ts` — 47 tests covering: lexer recognition (7 tokens), parse + lowering (shows expressions preserved, timeout-to-ms conversion, on_timeout, compensate-then-checkpoint and checkpoint-then-compensate ordering), T040–T043 negative cases, the 3-file emit shape with all migrations columns + indexes, the runtime API (10 documented exports), the in-process pending registry, counter emission, the HTTP route with the embedded compile-time allow list, the `DECISION_NOT_ALLOWED` rejection, the zero-files-when-no-checkpoints gate, and bitwise determinism across two emit runs. Wired into `compiler/package.json:scripts.test`, `compiler/tsconfig.json:exclude`, and `package.json:files` exclusion list.
- ✅ Verified no regression: full suite at **830 passed, 0 failed** (existing 783 + Phase 17 47). MarrowForge unchanged. `tsc --noEmit` strict-mode clean on the generated tree including the new checkpoint runtime + route.

### Phase 22 — Replay-as-test ✅ DELIVERED
- ✅ **`marrowc trace-to-test <trace.json>` CLI subcommand** — converts a recorded cognition trace (the JSON dumped by `marrowc replay <trace_id>`) into a self-contained `node:test` regression test. The catch: production LLM systems break in two ways — model drifts (Phase 16 evals catch that) or the surrounding code changes while the LLM behavior stays the same. Replay-as-test catches the second category cheaply by pinning every recorded input → output mapping.
- ✅ **`compiler/src/trace_to_test.ts:traceToTest(spans, options)`** — pure function that produces the test file content. Takes a `CognitionSpanLike[]` (the same shape `marrowc replay` writes) and emits a TypeScript test file using Node's built-in `node:test` runner. No external deps. Filters out non-`prompt_call` spans (validate/repair/tool_call) so the test only drives `callPrompt` for spans that represent actual model invocations.
- ✅ **Per-model FIFO output queues** — recorded outputs are grouped per model so a stub provider can serve them in the same order the trace recorded. The stub's `chat()` method shifts the queue on each call; past the end it throws `replay stub for "<model>" exhausted` instead of silently re-using stale data. This is the discipline that turns the trace into a test: any code change that calls a model more times than the trace recorded fails loudly.
- ✅ **Per-prompt assertions** — each `prompt_call` span becomes a `callPrompt(<prompt>, <recorded input>)` invocation followed by `assert.deepStrictEqual(result, <recorded output>)`. The recorded inputs and outputs are embedded as JSON literals so the test has zero runtime parse cost. Redaction-aware: outputs containing `[REDACTED]` (from `@sensitive` field annotations) skip the deep-equal check and only verify the call succeeded — otherwise the redacted sentinel would cause every test to fail.
- ✅ **Trace-level totals pinned** — a second `test()` block asserts call count, total tokens, and total cost match the recorded trace. Cost is rounded to 6 decimal places (sub-cent precision) before emission so floating-point quirks like `0.0001 + 0.0002 = 0.30000000000000004` don't break bitwise determinism on re-runs. The cost assertion uses `Math.abs(diff) < 0.0001` tolerance for the same reason.
- ✅ **`assertOutputs: false` opt-out** — when the user wants only the call-shape pinned (not the values), passing `--no-assert-outputs` to the CLI emits assertions that just verify `result !== undefined`. Useful when outputs are intentionally non-deterministic but the call sequence still matters.
- ✅ **Provider restoration** — `beforeEach` saves each referenced model's original provider and swaps in the stub; `afterEach` restores. Tests are isolated even when run in the same process. The cognition layer's `getModel()` is called via the canonical `../src/providers` import path, with a `cognitionImportPath` option for non-canonical layouts (the providers path is computed from the cognition path so they stay in lockstep).
- ✅ **Span ordering** — spans are sorted by `started_at` (handles both ms-epoch and ISO-string forms via `Date.parse` fallback) so the test is insensitive to row-ordering quirks in the storage layer. The recorder writes in order; this is defense-in-depth.
- ✅ **CLI integration** — `runTraceToTest` in `cli.ts` reads the trace JSON, extracts `trace_id` from the first span (or falls back to the file basename), runs `traceToTest`, and writes to `<trace>.test.ts` next to the input by default. `--out <file>` overrides the output path. `--no-assert-outputs` toggles the strict assertion mode. Exits 0 on success, 1 on read/parse/write errors. Verified end-to-end against a fixture trace.
- ✅ **Determinism** — span ordering is stable, recorded outputs JSON-stringified deterministically (Node's `JSON.stringify` is deterministic for plain objects), totals rounded to 6dp, no `Date.now()` / `Math.random()` in the emitter source. Two calls with the same input produce bitwise-identical output.
- ✅ Test suite: `compiler/src/test_cognition_phase22.ts` — 27 tests covering: emitted file shape (8 required imports / hooks / decls), per-model FIFO grouping with queue.shift + exhaustion error, per-prompt assertions including the deep-equal default, the `assertOutputs=false` opt-out, the redaction-aware soft assertion, non-`prompt_call` span filtering (validate spans don't drive callPrompt), trace-level totals (calls/tokens/cost with rounding tolerance), bitwise determinism, empty-trace handling (still emits a 0-call test), and the `cognitionImportPath` override threading through to the providers import path.
- ✅ Verified no regression: full suite at **857 passed, 0 failed** (existing 830 + Phase 22 27). Phase 22 is offline tooling — emits no new files in the generated tree, doesn't change the IR, doesn't touch the runtime. MarrowForge unaffected (hash `85761bfc0f354053`). The CLI subcommand is wired into `marrowc --help` and exercised against a real-shaped trace fixture.

### Phase 21 — Cost budgets ✅ DELIVERED
- ✅ **`cost_budgets:` clause on policy blocks** — extends the existing `policy { ... }` decl with zero or more typed budget records. Each budget pairs a scope (`per_tenant` | `per_user` | `per_feature: "<capability>"`), a sliding window (`window: 1d`), exactly one cap (`cap_usd` | `cap_tokens` | `cap_calls`), and an `on_exceeded` action (`error` with optional `code` | `throttle` with required `retry_after`). All four budget fields parse cleanly inside the closed grammar.
- ✅ **Contextual keyword discipline** — `scope`, `window`, `action`, `code`, `error` are NOT lexer keywords (they collide with too many user identifiers — `prompt code(text)`, on_invalid action `error`, etc.). Inside cost-budget bodies the parser matches them as contextual identifiers via token value comparison. The reserved tokens are limited to ones that don't collide: `cost_budgets`, `cap_usd`, `cap_tokens`, `cap_calls`, `on_exceeded`, `retry_after`, `throttle`, `per_tenant`, `per_user`, `per_feature`. This is the same pattern used by SQL for `LEFT`/`RIGHT` etc.
- ✅ **AST + IR + lowering** — `PolicyDeclNode` gains `costBudgets: CostBudgetNode[]`, with `CostBudgetNode` carrying scope, feature, window, the three caps (exactly-one set), action, retry_after, errorCode. `IRSystem.cost_budgets: IRCostBudget[]` is populated by `lowering.ts:collectCostBudgets`, which walks every policy and assigns a stable id (`<policy>:<scope>:<feature>:<window>:<index>`). Window strings are converted to ms; retry_after is converted to ms when present. Sorted by id at emission time so re-runs are bitwise stable.
- ✅ **Type-checker rules T050–T054** — `T050` rejects budgets with zero or multiple caps (exactly one of cap_usd/cap_tokens/cap_calls is required); `T051` rejects `per_feature` budgets without a feature name OR referencing an undeclared capability; `T052` rejects `action: throttle` without `retry_after` (the runtime needs the hint to set `Retry-After`); `T053` rejects zero-or-negative window durations; `T054` rejects zero-or-negative cap values.
- ✅ **Three emitted files when at least one budget is declared:**
  - `migrations/budget_counters.sql` — two tables: `budget_counters` (composite PK `(budget_id, scope_value, window_start)`, with `calls`, `tokens`, `cost_usd_micros` BIGINTs — cost stored as micros to dodge floating-point drift) and `budget_events` (audit log: `event` is `exceeded | throttled | reset`, plus actor + timestamps). Indexes on `(scope_value, window_start DESC)` and `(window_start)` for the dashboard query patterns.
  - `src/policy/budgets.ts` — runtime API: `BudgetExceededError`, `BudgetThrottleError`, `BUDGETS: BudgetSpec[]` (the static literal embedded at compile time), `assertWithinBudget(scope, action, charge)` (the gate), `chargeBudget(scope, action, charge)` (the post-success increment), `getBudgetState(tenantId)` (admin read), `resetBudgetForScope(scopeValue, actorId)` (admin reset, audited via `budget_events`).
  - `src/routes/admin_budgets.ts` — `GET /admin/budgets/:tenant_id?` returns the current counter state for one tenant or all; `POST /admin/budgets/:scope_value/reset` clears that scope's counters and writes a `reset` event. Both behind the same `requireAuth` middleware as the rest of the API.
- ✅ **Sliding-window enforcement via atomic ON CONFLICT** — the `incrementCounter` helper uses `INSERT ... ON CONFLICT (budget_id, scope_value, window_start) DO UPDATE SET calls = ... + EXCLUDED.calls, tokens = ... + EXCLUDED.tokens, cost_usd_micros = ... + EXCLUDED.cost_usd_micros`. PG handles the create-or-update atomically, so high-concurrency workloads can't race on counter creation. `windowStart()` rounds the current Date down to the nearest `window_ms` boundary so sliding windows are bucket-stable: every request inside the same hour for `window: 1h` lands in the same row.
- ✅ **Decision logic** — `assertWithinBudget` walks every BUDGETS entry, computes the matching `scope_value` (tenant id / user id / capability name), reads the current counter for that bucket, adds the candidate charge, and short-circuits on the first breach. Charges are check-then-charge (not consume-then-charge) so users can't spend over the cap once. Breaches throw either `BudgetExceededError` (action=error) with the configured `code` or `BudgetThrottleError` (action=throttle) with the configured `retry_after_ms`. Every breach writes an audit row to `budget_events` regardless of action.
- ✅ **Counters + observability** — `budget.exceeded{budget, scope, action}`, `budget.charged{}`, `budget.reset{}`. The runtime logs structured `budget_exceeded` events and writes audit rows to `budget_events` so every breach is visible in three places: metrics, logs, and the audit table.
- ✅ **Runtime integration** — `emit_runtime.ts:emitIndex` conditionally imports `adminBudgetsRouter` and mounts at `/admin/budgets` when at least one budget is declared. Startup log lines extended to print `/admin/budgets/:tenant_id?` and `/admin/budgets/:scope_value/reset (POST)`.
- ✅ **Determinism** — budget IDs are deterministic strings; BUDGETS literal is sorted by id at emit time; no `Date.now()` / `Math.random()` in the emitter. The runtime DOES use Date.now for window-start computation, but that's the runtime's job — the emitter source is clean.
- ✅ Test suite: `compiler/src/test_cognition_phase21.ts` — 48 tests covering: lexer recognition (10 reserved tokens) + contextual identifier discipline (5 non-reserved words remain Identifier), parser + lowering (3 budget shapes including `per_feature: "<name>"`, ms conversion, error_code preservation), T050–T054 negative cases (zero/multiple caps, per_feature without feature, throttle without retry_after, zero window, zero caps), the 3-file emit shape with all 7 runtime exports, embedded BUDGETS array, ON CONFLICT increment, the admin route's two endpoints, the zero-files-when-no-budgets gate, and bitwise determinism.
- ✅ Verified no regression: full suite at **905 passed, 0 failed** (existing 857 + Phase 21 48). MarrowForge has no cost_budgets declared so Phase 21 is invisible. `marrowc verify-determinism` unchanged.

### Phase 18 — Promptbook standard library ✅ DELIVERED
- ✅ **Closed registry of typed prompt templates** — `compiler/src/promptbook.ts` ships with 8 first-class entries spanning 4 categories: classification (`binary_classify`, `multi_class_classify`), generation (`summarize`, `paraphrase`, `translate`), extraction (`extract_json`), reasoning (`chain_of_thought_solve`, `self_critique_then_revise`). Each entry declares a typed parameter spec (name, type, required flag, description), a baseline template with `{{param}}` placeholders, a recommended return type, and a recommended validation mode. The registry is closed at compile time so the type checker can verify entry references and required-arg coverage.
- ✅ **`promptbook:` and `with:` clauses on prompt body** — new `KwPromptbook` and `KwWith` lexer keywords. Prompts opt into a promptbook entry by writing `promptbook: binary_classify` and supplying parameters via `with: { positive_label: "spam", negative_label: "ham" }`. Comma between args is optional (newline counts). The `with` clause uses the existing parseExpr so users can pass string literals, numeric literals, and string-arrays.
- ✅ **Compile-time rendering** — `lowering.ts:lowerPrompt` now calls `renderPromptbookTemplate(entry, args)` when `promptbookRef` is set. The renderer substitutes `{{<arg>}}` with the user's literal values (string-array → bullet list, numeric → as-is, missing optional → empty string). The substituted template is stored on `IRPrompt.template` so the generated runtime sees a plain string — no runtime dependency on the promptbook module. `{{__input.<paramName>}}` placeholders are LEFT INTACT for the cognition emitter to substitute at request time with actual prompt-call inputs.
- ✅ **AST + IR shape** — `PromptDeclNode` gains `promptbookRef: string | null` and `promptbookArgs: { name: string; value: ExprNode }[]`. The IR `IRPrompt.template` is unchanged (it's the rendered string), so downstream emitters (cognition layer, validation) need no plumbing changes — promptbook is invisible past lowering.
- ✅ **Type-checker rules T060–T063** — `T060` rejects prompts that declare both `template:` and `promptbook:` (mutually exclusive); `T061` rejects unknown promptbook entries with the full allowed list in the error message for discoverability; `T062` rejects prompts missing a required arg (e.g. `binary_classify` without `positive_label`); `T063` rejects unknown arg names with the entry's allowed args listed.
- ✅ **`renderPromptbookTemplate` semantics** —
  - `string` arg → literal substitution (`{{label}}` → `"spam"`)
  - `string[]` arg → bullet list (`["bug","feature"]` → `"  - bug\n  - feature"`)
  - `number` arg → `String(value)`
  - missing optional arg → empty string substitution (the runtime handles trailing whitespace gracefully)
  - non-literal expression args → `serializeExpr()` fallback so the user's intent shows up in the rendered template as a debuggable artifact
- ✅ **Determinism** — PROMPTBOOK is a frozen object; `listPromptbookNames()` returns sorted output; `renderPromptbookTemplate` substitutes literally with no Date.now/Math.random; the rendered template ends up in `IRPrompt.template` exactly the same on every compile.
- ✅ **Catalog discovery surface** — `listPromptbookNames()` returns the sorted list (used by both type-checker error messages and, in v2, the LSP for autocomplete). `lookupPromptbookEntry(name)` returns the entry or null. The closed-list discipline means a user can't write `promptbook: my_custom_thing` — that's T061, with all 8 allowed names listed. New entries ship with the compiler; the type checker gains them automatically.
- ✅ Test suite: `compiler/src/test_cognition_phase18.ts` — 29 tests covering: lexer recognition (`promptbook`, `with`), registry shape (8 entries spanning 4 categories, every documented entry present, unknown lookup returns null), `renderPromptbookTemplate` (string args substitution, string[] → bullets, missing optional → empty, `{{__input.<name>}}` preservation, determinism), parser + lowering integration (two real prompt declarations whose templates contain the rendered values), and T060–T063 negative cases.
- ✅ Verified no regression: full suite at **934 passed, 0 failed** (existing 905 + Phase 18 29). Phase 18 is invisible to systems that don't declare `promptbook:` — MarrowForge unchanged.

### Phase 19 — Cost-aware routing ✅ DELIVERED
- ✅ **`observe:` and `policy:` clauses on router blocks** — `router smart_router { observe: ["validation_pass_rate", "latency_p95_ms"], policy: minimize_cost_subject_to { validation_pass_rate >= 0.9, latency_p95_ms <= 30000 } }`. The `observe:` list declares which metrics the runtime should record per call so the (offline) tuner can read them later. The `policy:` clause supplies optimization constraints — `minimize_cost_subject_to` is the only objective in v1.
- ✅ **Closed metric vocabulary** — the type checker recognises 7 metric names: `validation_pass_rate`, `latency_p50_ms`, `latency_p95_ms`, `cost_usd_per_call`, `calls`, `tokens_per_call`, `confidence_mean`. New ones are added by extending the `KNOWN_METRICS` set in `typechecker.ts:checkRouter` and (eventually) wiring them into the runtime metrics emitter. Closed by design — typos like `validation_pass_rate` vs `pass_rate` fail at compile time, not at first PR review.
- ✅ **Type-checker rules T070–T071** — `T070` rejects `observe:` entries or constraint-LHS metrics not in `KNOWN_METRICS`; `T071` rejects policy constraints that reference a metric not in the router's `observe:` list (the constraint would be unverifiable). The error messages list all known metrics for discoverability.
- ✅ **AST + IR shape** — `RouterDeclNode.observe: string[]` and `RouterDeclNode.policy: RouterPolicyNode | null`; `RouterPolicyNode` carries `objective: "minimize_cost_subject_to"` + `constraints: ExprNode[]`. Lowering serialises constraint expressions (same convention as IRPrompt.constraints) so the IR is stable, debuggable, and ready for the offline tuner to consume.
- ✅ **Runtime side stays static (deterministic)** — the runtime decision logic is unchanged. The router still picks tiers via the existing `parseByExpr` lookup against `input.<expr>`. Phase 19 ONLY adds intent: it tells the offline tuner what to optimise for. The "learning" is a future `marrowc tune-router <name>` CLI subcommand that reads recorded metrics from `cognition_traces` and recomputes tier thresholds at compile time. Same deterministic compile-time decision-table model the rest of the language uses; the smarts live offline.
- ✅ **Backward compat** — routers without `observe:` or `policy:` keep their existing behavior bit-for-bit. `observe` defaults to `[]`, `policy` defaults to `null`, the runtime emitter checks both conditionally. Every Phase 1–18 fixture continues to compile and produce the same hash.
- ✅ **Determinism** — `observe` is preserved in declaration order; constraints are preserved in declaration order and serialised deterministically; the lowered IRRouter is bitwise stable across two compiles of the same source.
- ✅ Test suite: `compiler/src/test_cognition_phase19.ts` — 12 tests covering: lexer recognition (`observe`, `minimize_cost_subject_to`), parser + lowering (3-metric observe list, 2-constraint policy, serialised constraints reference both metrics), T070/T071 negative cases (unknown observe metric, unknown constraint metric, constraint referencing unobserved metric), backward compat (legacy router → observe=[], policy=null), bitwise determinism across two compiles.
- ✅ Verified no regression: full suite at **946 passed, 0 failed** (existing 934 + Phase 19 12). MarrowForge unaffected — the existing `forge_router` doesn't declare observe or policy, so its IR is unchanged.

### Phase 20 — Code-spec sync (v1: AST-only) ✅ DELIVERED
- ✅ **Two new CLI subcommands** — `marrowc reflect <project_dir> [--out <file>] [--system <name>]` walks a TypeScript project and emits a stub `.marrow` source. `marrowc diff-spec <spec.marrow> <project_dir>` compares an existing spec's entity declarations against the source-derived shape and reports drift. Both wired into `marrowc --help`.
- ✅ **AST-only inference foundation** — `compiler/src/reflect.ts` ships with `reflectProject(root)`, `emitMarrowStub(systemName, result)`, `diffEntities(spec, source)`, `formatDiff(result)`. The walker recursively scans `.ts`/`.tsx` files, skips `node_modules`/`dist`/`build`/dot-prefixed dirs, parses each file via the user's installed `typescript` module, and finds class/interface declarations that include an `id` member. v1 ships pure static analysis — the LLM-driven inference path for capabilities, state machines, and audit boundaries is documented as v2 work.
- ✅ **Type projection rules** — explicit, conservative mapping from TypeScript types to MarrowScript primitives:
  - `string` → `string` (`uuid` only when the field is named `id`)
  - `number` → `float` (we don't guess int vs float; user fixes if stricter typing wanted)
  - `boolean` → `bool`
  - `Date` → `timestamp`
  - `any` / `unknown` / `Record<string, unknown>` → `json`
  - `T[]` and `Array<T>` → `list<T>`
  - `Buffer` / `Uint8Array` → `bytes`
  - optional members (`x?:`) → `optional<T>` in the emitted stub
  - unrecognised types are skipped (the reviewer fills them in)
- ✅ **Round-trip stability** — emitted stubs parse cleanly through the existing `Lexer` / `Parser` / `TypeChecker` pipeline. Ontology fields (`id` / `created_at` / `updated_at`) are NOT re-declared in the stub since they're added automatically by the type checker. `diff-spec` strips the same fields from both sides so the comparison is symmetric.
- ✅ **`diff-spec` exit semantics** — exits non-zero when ANY drift exists (entity added, removed, or field type_changed). Drops cleanly into CI as a "schema drift" gate. The human-readable report uses `+` for source-only entities, `-` for spec-only, and `~` for type changes.
- ✅ **Determinism** — file walk sorts entries alphabetically; entities sorted by name; fields sorted alphabetically; member projection is purely AST-derived. Two runs against the same project produce bitwise-identical output. No `Date.now()` / `Math.random()` in the reflect module.
- ✅ **Skip rules with intent** — `node_modules`, `dist`, `build`, and any dot-prefixed dir are excluded so generated/installed code doesn't pollute the inferred spec. `.d.ts` declaration files are skipped (they're API surface, not source). Classes without an `id` member are skipped — they're helpers/utilities, not entities.
- ✅ **What v1 doesn't do (deliberate)** — the PLAN.md vision included LLM-driven inference (walking function bodies via tool calls, inferring capabilities, state machines, audit boundaries). That requires a real prompt + tool-call loop and the cognition runtime needs to be available *outside* a generated project (CLI context). Documented as v2 work in `compiler/src/reflect.ts:1-35`. The static analysis is the foundation; the LLM driver lands cleanly on top of it.
- ✅ Test suite: `compiler/src/test_cognition_phase20.ts` — 29 tests covering: entity discovery (User class + Post interface, Helper without id skipped, node_modules skipped), all 8 type projection rules, emitMarrowStub round-trip (stub parses + type-checks cleanly, ontology fields omitted), diffEntities (matched / spec_only / source_only entities, added / removed / type_changed field drifts), formatDiff output shape (clean state, drift state), and bitwise determinism across two runs.
- ✅ Verified no regression: full suite at **975 passed, 0 failed** (existing 946 + Phase 20 29). Phase 20 is offline tooling — emits no new files in the generated tree, doesn't change the IR, doesn't touch the runtime. MarrowForge unaffected.

---

**The 9-phase plan is now fully delivered.** Phases 14–22 in order: 14 (multi-file output), 15 (real tools), 16 (evaluation primitive), 17 (flow checkpoint), 18 (promptbook), 19 (cost-aware routing), 20 (code-spec sync), 21 (cost budgets), 22 (replay-as-test). 975 tests passing across 28 test files. All 9 phases compose cleanly with the existing 1–13 phases — no regressions, deterministic compile preserved, MarrowForge unchanged at hash `85761bfc0f354053`.

### Phase 19 v2 — Router tuner CLI ✅ DELIVERED
- ✅ **`marrowc tune-router <name> --spec <file.marrow> --traces <dir>` CLI** — aggregates recorded cognition trace dumps and reports per-tier metrics for a named router. When the router declares a `policy:` clause (Phase 19), the tuner checks each constraint against observed metrics and surfaces suggestions when constraints fail.
- ✅ **`compiler/src/tune_router.ts:tuneRouter(router, spans)`** — pure function that takes an `IRRouter` and a span list, returns a `TuneReport` with per-tier metrics (calls, ok_calls, validate_failed, escalated, validation_pass_rate, latency_p50/p95, cost_usd_per_call, tokens_per_call, confidence_mean), aggregated totals, per-constraint pass/fail breakdown, and suggestion strings.
- ✅ **Suggestion patterns (3)** — (1) Low call volume: failing tier with <30 calls → "collect more traces before re-tuning"; (2) Failing tier vs passing later tier: tier failing pass_rate while a later (higher-`max:`) tier passes → "consider lowering max on the higher tier"; (3) Cheap tier passes everything: tier with ≥50 calls meeting every constraint → "consider raising max to capture more traffic". Conservative by design — no automatic source rewrites.
- ✅ **Constraint evaluation** — parses the IR-serialised expression shape (`(metric op number)`), strips outer parens, matches `<metric> <op> <number>` where op ∈ {>=, <=, ==, >, <}, evaluates each tier's observed metric value against the threshold. NaN/non-finite observed values fail-open (don't pass) so missing data doesn't masquerade as success.
- ✅ **`marrowc tune-router` CLI integration** — loads the spec via the existing pipeline (Lexer → Parser → TypeChecker → Lowering), finds the named router, reads every `*.json` file in the traces directory, aggregates spans across all of them. `--json` flag emits structured output for CI consumption. Exit `0` when all constraints pass, `1` when any fail.
- ✅ **Read-only** — the .marrow source stays the source of truth. The tuner reports; the human edits the spec. Documented as conscious scope decision in the module doc-comment. Automatic source rewrites are out of scope: too much risk of clobbering hand-tuned fields.
- ✅ **Determinism** — span aggregation walks in `span_id` order; tier results follow declaration order with extra tiers (recorded but not declared) sorted alphabetically; cost values rounded to 6 decimal places before emission so floating-point quirks don't break diffs across CI runs.
- ✅ Test suite: `compiler/src/test_cognition_phase19_v2.ts` — 35 tests covering: per-tier aggregation (calls / ok / validate_failed / escalated / pass_rate), latency p50/p95 percentiles with explicit boundary math, cost + tokens aggregation, confidence mean (NaN handling for missing values), constraint evaluation (both pass and fail cases), all 3 suggestion patterns with synthetic span fixtures, formatTuneReport output shape, bitwise determinism, empty-trace handling. CLI integration verified end-to-end against a fixture spec + traces dir.
- ✅ Verified no regression: full suite at **1010 passed, 0 failed** (existing 975 + Phase 19 v2 35). Phase 19 v2 is offline tooling — no new files in the generated tree, no IR changes, no runtime touch. MarrowForge hash unchanged.

### Documentation pass ✅ DELIVERED
- ✅ **`spec/12_PHASES_14_22.md`** — comprehensive chapter covering all 9 phases (14–22) with surface, compile-time guarantees, error codes, runtime artifacts, CLI commands, migration notes, and composability examples. Test coverage table and determinism guarantees explicitly stated.
- ✅ **`spec/01_LANGUAGE_OVERVIEW.md`** — document map updated to list `12_PHASES_14_22.md`.

---

**Final state:** 1010 tests passing across 29 test files. Phases 1–22 fully shipped + documented. MarrowForge unaffected (`85761bfc0f354053`). The compiler is now feature-complete relative to PLAN.md; remaining work is Phase 20 v2 (LLM-driven inference) and dogfooding new features into MarrowForge — both deferred as conscious scope decisions.

### Phase 20 v2 — LLM-driven inference ✅ DELIVERED
- ✅ **`marrowc reflect-llm <project_dir>` CLI** — runs Phase 20 v1 static analysis (entity discovery), then prompts an LLM via a closed 5-tool list to infer capabilities operating on those entities. Emits an enriched .marrow stub combining both. Provider defaults to LM Studio at `http://127.0.0.1:1234/v1`; override via `--endpoint`, `--model`, or env vars `LLM_REFLECT_ENDPOINT` / `LLM_REFLECT_MODEL`.
- ✅ **Modular architecture (no God files)** — five source files, all under 260 lines:
  - `reflect_llm/types.ts` (109 lines) — shared LLM protocol types + inference result shapes
  - `reflect_llm/tools.ts` (254 lines) — closed tool registry: `list_directory`, `read_file`, `find_class`, `find_function`, `find_references`. Each tool closes over the project root; path-traversal blocked by `safeJoin`.
  - `reflect_llm/llm.ts` (223 lines) — standalone OpenAI-compat provider + bounded tool-call loop. Same shape as Phase 15's runtime loop but standalone (no cognition runtime dependency). Terminates when the model produces content without tool_calls, or when `maxToolCalls` is exceeded.
  - `reflect_llm/output.ts` (149 lines) — merge inferred capabilities into the v1 result + emit enriched stub. Includes `filterInferredCapabilities` (drops unknown entities, duplicates, invalid identifiers) and `emitEnrichedStub`.
  - `reflect_llm.ts` (203 lines) — orchestrator: runs v1 static analysis, builds the user prompt with discovered entity names, drives the tool loop, parses the final JSON response, filters, and returns.
- ✅ **Closed 5-tool list** — the model can read files, list directories, find classes/interfaces by name, find functions/methods by name, and grep references. All tools are path-safe (`safeJoin` rejects traversal + absolute paths) and read-only (no writes, no exec, no network). Unknown tool calls return an error JSON so the model can self-correct rather than crashing the loop.
- ✅ **Structured output contract** — the model is instructed to return a JSON object with `{"capabilities": [...]}` on its final turn. Each capability carries `name`, `entity`, `params`, `effects`, `requires`, `source_file`, `source_line`, and `confidence` ("high" | "medium" | "low"). The parser (`parseLLMOutput`) tolerates both bare JSON and ```json fenced blocks, extracts from the largest balanced `{...}` when needed, and silently drops malformed records.
- ✅ **Capability filter** — `filterInferredCapabilities` drops capabilities whose entity isn't in the static-analysis result (would fail the type checker anyway), capabilities with invalid identifiers, and duplicates (first occurrence wins). Trace stats are preserved through the filter so the reviewer can see how much inference the model actually did.
- ✅ **Enriched stub emission** — `emitEnrichedStub` combines v1 entities + v2 capabilities into one system block. Entities come first (sorted alphabetically); inferred capabilities follow under a `// ── Inferred capabilities ──` separator. Each capability has a `// inferred (confidence: <level>)` comment so the reviewer can prioritise. Effects use `target op value` syntax matching the existing grammar. The header banner includes tool-call and token stats + whether the budget was exceeded.
- ✅ **Bounded tool-call loop** — `runToolLoop` caps at `maxToolCalls` (default 30, overridable via CLI `--max-tool-calls`). Each iteration: provider.chat() → if tool_calls, dispatch via registry → append role:tool results → re-prompt. Budget exceeded returns the last available content (may be partial). Per-call timeout via AbortController (default 60s).
- ✅ **FakeProvider for deterministic testing** — tests inject a `FakeProvider` with a scripted response sequence. The provider never hits the network; its `called` counter and `lastTools` field verify the loop dispatches correctly. This pattern lets the full 41-test suite run in <1s without a live model.
- ✅ **Short-circuit on empty projects** — when Phase 20 v1 finds zero entities, the LLM is never called (no prompt, no tool calls, no cost). Returns immediately with empty capabilities + zero trace stats.
- ✅ Test suite: `compiler/src/test_cognition_phase20_v2.ts` — 41 tests covering: tool registry shape (5 tools with valid JSON Schema), all 5 tool implementations against a fixture project (list_directory, read_file, find_class/interface, find_function, find_references), path safety (safeJoin accepts in-tree, rejects traversal + absolute; read_file returns error JSON on traversal rather than throwing), tool-call loop with FakeProvider (dispatch + re-prompt, budget enforcement, unknown tool → error result), parseLLMOutput (plain JSON, fenced block, empty/broken → empty list, malformed record filtering), filterInferredCapabilities (keeps known + first-seen, drops unknown entities + duplicates + invalid identifiers, preserves trace), emitEnrichedStub (entity + capability + effect + requires + confidence comment + ontology-field-omission + header stats), end-to-end reflectProjectWithLLM (static + LLM combined, trace stats correct), and empty-project short-circuit (provider never called).
- ✅ Verified no regression: full suite at **1051 passed, 0 failed** (existing 1010 + Phase 20 v2 41). MarrowForge hash unchanged (`85761bfc0f354053`). Phase 20 v2 is offline tooling — no files emitted in the generated tree, no IR changes, no runtime touch.

---

**The full plan is now complete.** PLAN.md phases 14–22 (9 phases) + Phase 19 v2 (tuner) + Phase 20 v2 (LLM inference) + documentation. 1051 tests across 30 test files. Every phase composes cleanly with the prior 13 phases — no regressions, deterministic compile preserved, MarrowForge hash stable at `85761bfc0f354053`.

---

## 13. Risks and How They Are Bounded

| Risk | Mitigation built into the design |
|---|---|
| Provider non-determinism leaks into observable behavior | `cognition_traces` records every input/output. Replay mode reproduces a workflow with recorded outputs. Cache key includes model + template hash so cache hits are deterministic. |
| Recursive prompt loops | Pipelines and flows are statically analyzable DAGs. There is no runtime way for a prompt to invoke another prompt — only the compiled workflow can. Recursion budget is implicit in the `retry:` and `on_invalid:` clauses, both bounded. |
| Tool sprawl for a small model | `prompt.tools: [...]` is the only allowed-call list, type-checked at compile time. Default is empty. The router never picks the tool; the prompt picks from a closed list. |
| Context blow-up | `compress_context` and `semantic_slice` are the only retrieval paths emitted. Token budgets are enforced before each prompt call. `BudgetExceeded` is a first-class failure rule. |
| SSRF / data exfil through `http` provider | Endpoint allowlist (loopback / RFC1918 by default). Same pattern as the existing `emit_notify.ts` webhook guard. |
| Audit-log leaking secrets | `@sensitive` annotation on prompt fields drives redaction (existing mechanism in `emit_audit.ts`). Always-redact list expanded with `api_key`, `bearer`, `authorization`. |
| Hallucinated tool args | `requires:` on the called capability rejects bad calls at the framework layer with `PRECONDITION_FAILED` — the existing capability infrastructure already does this. |
| Compiler determinism regression | Every new emitter runs through `marrowc verify-determinism` in CI (`.github/workflows/ci.yaml` is already generated by `emit_deploy.ts`). |
| Local server unreachable | Existing `/health/ready` endpoint extended with provider checks. Failure rule + circuit-breaker pattern already emitted by `emit_maintenance.ts`. |

---

## 14. What I Will Not Build

To keep the harness honest about being a *cognitive scaffold for weak models*, not another agent framework:

- No autonomous "agent" loop. There is no top-level "think → act → reflect" runtime. Every loop is a compile-time `pipeline` or `flow`.
- No model-driven workflow mutation. Workflows are immutable artifacts of compilation.
- No model-driven tool discovery. The `tools:` list is closed and type-checked.
- No memory the model writes to directly. The semantic index is updated by deterministic indexers; the model only reads slices.
- No giant system prompts. Templates are typed and parameterised through `extension_point` bodies.
- No vector RAG by default. The first-class retrieval path is graph-based semantic slicing. A vector backend can be added later as a `retriever` extension point if needed, but it is not the default.
- No long-term planning by the model. Plans are decomposed by `decompose_task` into bounded subtasks drawn from a closed list.

---

## 15. Open Decisions That Need Your Call

These are deliberate forks, not implementation details — they shape the surface area materially.

1. **Confidence source** — should `confidence` be sourced from logprobs (when the provider exposes them), or from a separate validator-model self-critique pass? Logprobs are cheap but not all providers expose them. Self-critique is universal but doubles cost. Recommendation: **logprobs when available, else self-critique gated by `confidence_threshold` only when needed**. Can revisit per-prompt.

2. **Streaming surface** — should prompts ever stream to the caller, or always buffer? Recommendation: **buffer by default, stream as opt-in** via `stream: true` on the prompt decl. Most cognition primitives (validation, voting, repair) need the full output. Streaming complicates audit and replay.

3. **Vector embeddings** — should the harness ship a built-in embedding store, or treat embeddings as an extension point? Recommendation: **extension point in v1**. The graph-based semantic slice is already strong for code; vector retrieval can be added as a primitive (`vector_retrieve`) once we have a determinism story for it (cache by content hash + model id).

4. **Budgets** — per-trace or per-tenant? Recommendation: **both**, with per-trace as the primary budget and per-tenant as a secondary aggregate gauge.

5. **Compile target subset** — the Express target is the default. Should the harness also support the Nakama target (`compiler/src/emit_nakama.ts`) in v1? Recommendation: **Express only for v1**; Nakama can be added by mirroring the cognition emitters into the nakama tree once the API surface is stable.

If none of these are blockers, I will proceed with the recommendations as stated.

---

## 16. Quick-Start (after Phase 2)

Once Phases 1–2 land, this minimal `.marrow` is enough to scaffold a working harness against a local Ollama:

```bone
system Hello {
  domain: cognitive_scaffold

  model Local {
    provider: ollama
    name: "qwen2.5-coder:1.5b"
    context_window: 32000
    max_output: 256
  }

  prompt classify(text: string) {
    model: Local
    template: "extension_point:tmpl_classify"
    returns: enum<["bug","feature","question"]>
    timeout: 5s
    idempotent: true
  }

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }
}
```

Compile, fill in the `tmpl_classify` extension_point with the prompt text, `npm install && npm run migrate && npm run dev`, and `POST /classify { "text": "..." }` returns a typed enum, audited, traced, rate-limited, with budget guards — all from the existing infrastructure.
